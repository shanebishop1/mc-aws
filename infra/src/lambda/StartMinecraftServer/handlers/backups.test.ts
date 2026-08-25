import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureInstanceRunningMock, executeSSMCommandMock, getParameterMock, putParameterMock } = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  getParameterMock: vi.fn(),
  putParameterMock: vi.fn(),
}));

vi.mock("../ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
}));

vi.mock("../ssm.js", () => ({
  executeSSMCommand: executeSSMCommandMock,
  getParameter: getParameterMock,
  putParameter: putParameterMock,
}));

import { buildListBackupsCommand, handleRefreshBackups } from "./backups.js";

describe("handleRefreshBackups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GDRIVE_REMOTE = "gdrive";
    process.env.GDRIVE_ROOT = "mc-backups";
    executeSSMCommandMock.mockResolvedValue("");
    putParameterMock.mockResolvedValue(undefined);
    getParameterMock.mockResolvedValue(null);
  });

  it("writes pending before work and ready on successful completion", async () => {
    getParameterMock.mockResolvedValue(JSON.stringify({ status: "ready", backups: [], cachedAt: 1 }));
    executeSSMCommandMock.mockResolvedValue(
      "[2026-01-01T00:00:00Z] Materialized Google Drive rclone configuration\nbackup.tar.gz|10|2026-01-01"
    );

    await handleRefreshBackups("i-abc123");

    expect(putParameterMock.mock.calls[0]?.[1]).toContain('"status":"pending"');
    expect(putParameterMock).toHaveBeenLastCalledWith(
      "/minecraft/backups-cache",
      expect.stringMatching(/"status":"ready".*"backup.tar.gz"/),
      "String"
    );
    expect(putParameterMock.mock.calls.at(-1)?.[1]).not.toContain("Materialized Google Drive");
  });

  it("preserves previous backups and records safe failed state", async () => {
    getParameterMock.mockResolvedValue(
      JSON.stringify({ status: "ready", backups: [{ name: "previous.tar.gz" }], cachedAt: 1 })
    );
    executeSSMCommandMock.mockRejectedValueOnce(new Error("provider 403 secret detail"));

    await expect(handleRefreshBackups("i-abc123")).rejects.toThrow("provider 403 secret detail");

    const failureCall = putParameterMock.mock.calls.at(-1);
    expect(failureCall).toBeDefined();
    expect(failureCall?.[1]).toContain('"status":"failed"');
    expect(failureCall?.[1]).toContain("previous.tar.gz");
    expect(failureCall?.[1]).not.toContain("provider 403");
  });

  it("materializes the root rclone config before listing backups", async () => {
    await handleRefreshBackups("i-abc123");

    const [, commands] = executeSSMCommandMock.mock.calls[0];
    const command = commands[0] as string;
    expect(command).toContain("/usr/local/bin/mc-rclone-config.sh");
    expect(command).toContain("mc-rclone-config.sh'\"'\"' >/dev/null");
    expect(command.indexOf("mc-rclone-config.sh")).toBeLessThan(command.indexOf(" lsf"));
  });

  it("keeps nested shell metacharacters and single quotes in the Drive path as data", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-backups-shell-quote-"));
    const markerPath = path.join(rootDir, "injected");
    const argsPath = path.join(rootDir, "rclone-args");
    const rclonePath = path.join(rootDir, "rclone");
    const remote = `drive'$(touch "${markerPath}")`;
    const driveRoot = `nested/it's; touch "${markerPath}"; \$(touch "${markerPath}")`;

    try {
      writeFileSync(
        rclonePath,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\0' "$@" > "$RCLONE_ARGS_PATH"\nprintf 'safe.tar.gz|10|2026-01-01\\n'\n`,
        "utf8"
      );
      chmodSync(rclonePath, 0o755);

      const command = buildListBackupsCommand(remote, driveRoot, "/usr/bin/true", "/tmp/rclone.conf", rclonePath);
      const result = spawnSync("bash", ["-c", command], {
        env: { ...process.env, RCLONE_ARGS_PATH: argsPath },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(markerPath)).toBe(false);
      expect(readFileSync(argsPath, "utf8").split("\0")).toContain(`${remote}:${driveRoot}/`);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
