import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureInstanceRunningMock,
  getInstanceStateMock,
  executeSSMCommandMock,
  getParameterMock,
  putParameterMock,
  getCurrentLifecycleLockMock,
  acquireLifecycleLockMock,
  releaseLifecycleLockMock,
} = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  getInstanceStateMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  getParameterMock: vi.fn(),
  putParameterMock: vi.fn(),
  getCurrentLifecycleLockMock: vi.fn(),
  acquireLifecycleLockMock: vi.fn(),
  releaseLifecycleLockMock: vi.fn(),
}));

vi.mock("../ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
  getInstanceState: getInstanceStateMock,
}));

vi.mock("../ssm.js", () => ({
  executeSSMCommand: executeSSMCommandMock,
  getParameter: getParameterMock,
  putParameter: putParameterMock,
}));

vi.mock("../lifecycle-lock.js", () => ({
  LifecycleLockConflictError: class LifecycleLockConflictError extends Error {
    existingLock: unknown;
    constructor(existingLock: unknown) {
      super("Another lifecycle operation is already in progress");
      this.name = "LifecycleLockConflictError";
      this.existingLock = existingLock;
    }
  },
  getCurrentLifecycleLock: getCurrentLifecycleLockMock,
  acquireLifecycleLock: acquireLifecycleLockMock,
  releaseLifecycleLock: releaseLifecycleLockMock,
}));

import { buildListBackupsCommand, handleRefreshBackups } from "./backups.js";

const authenticatedList = JSON.stringify([
  {
    archiveName: "backup.tar.gz",
    archiveSha256: "a".repeat(64),
    archiveSize: 10,
    authenticationKeyId: "key-old",
    backupId: "b".repeat(32),
    createdAt: "2026-01-01T00:00:00Z",
    generation: 1,
    instanceId: "i-abc123456",
    operationKey: null,
    serverId: "stack-identity",
  },
]);

describe("handleRefreshBackups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GDRIVE_REMOTE = "gdrive";
    process.env.GDRIVE_ROOT = "mc-backups";
    executeSSMCommandMock.mockResolvedValue("");
    putParameterMock.mockResolvedValue(undefined);
    getParameterMock.mockResolvedValue(null);
    getInstanceStateMock.mockResolvedValue("running");
    getCurrentLifecycleLockMock.mockResolvedValue(null);
    acquireLifecycleLockMock.mockResolvedValue({
      lockId: "refresh-lock",
      fencingToken: 7,
      action: "backup",
      ownerEmail: "backup-refresh@mc-aws.internal",
    });
    releaseLifecycleLockMock.mockResolvedValue(true);
  });

  it("writes pending before work and ready on successful completion", async () => {
    getParameterMock.mockResolvedValue(JSON.stringify({ status: "ready", backups: [], cachedAt: 1 }));
    executeSSMCommandMock.mockResolvedValue(authenticatedList);

    await handleRefreshBackups("i-abc123");

    expect(putParameterMock.mock.calls[0]?.[1]).toContain('"status":"pending"');
    expect(putParameterMock).toHaveBeenLastCalledWith(
      "/minecraft/backups-cache",
      expect.stringMatching(/"status":"ready".*"backup.tar.gz"/),
      "String"
    );
    expect(putParameterMock.mock.calls.at(-1)?.[1]).not.toContain("Materialized Google Drive");
    expect(acquireLifecycleLockMock).toHaveBeenCalledWith("backup", "backup-refresh@mc-aws.internal");
    expect(releaseLifecycleLockMock).toHaveBeenCalledWith(
      "refresh-lock",
      7,
      "backup",
      "backup-refresh@mc-aws.internal"
    );
  });

  it.each([
    ["zero generation", [{ ...JSON.parse(authenticatedList)[0], generation: 0 }]],
    ["tampered malformed digest", [{ ...JSON.parse(authenticatedList)[0], archiveSha256: "0".repeat(63) }]],
    ["legacy plain listing", "backup.tar.gz|10|2026-01-01"],
  ])("rejects %s as a cache success", async (_label, value) => {
    executeSSMCommandMock.mockResolvedValue(typeof value === "string" ? value : JSON.stringify(value));

    await expect(handleRefreshBackups("i-abc123456")).rejects.toThrow(/authenticated|manifest/i);
    expect(putParameterMock.mock.calls.at(-1)?.[1]).toContain('"status":"failed"');
  });

  it("does not turn an archive without a manifest into a cache entry", async () => {
    executeSSMCommandMock.mockResolvedValue("[]");
    await expect(handleRefreshBackups("i-abc123456")).resolves.toMatchObject({ backups: [] });
    expect(putParameterMock.mock.calls.at(-1)?.[1]).toContain('"backups":[]');
  });

  it("preserves previous backups and records safe failed state", async () => {
    getParameterMock.mockResolvedValue(
      JSON.stringify({
        status: "ready",
        backups: [
          {
            name: "previous.tar.gz",
            backupId: "c".repeat(32),
            digest: "d".repeat(64),
            generation: 1,
            createdAt: "2026-01-01T00:00:00Z",
            instanceId: "i-abc123456",
            serverId: "stack-identity",
            authenticationKeyId: "key-old",
            operationKey: null,
          },
        ],
        cachedAt: 1,
      })
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
    expect(command).toContain("mc-backup-auth.py");
    expect(command).toContain("maintenance-boot-hold.json");
    expect(command).toContain("maintenance-state.json");
    expect(command.indexOf("mc-rclone-config.sh")).toBeLessThan(command.indexOf("mc-backup-auth.py"));
  });

  it("does not start EC2 when no-start refresh observes a stopped instance", async () => {
    getInstanceStateMock.mockResolvedValueOnce("stopped");

    await expect(handleRefreshBackups("i-abc123", { requireAlreadyRunning: true })).rejects.toMatchObject({
      name: "BackupRefreshInstanceNotRunning",
    });
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
    expect(releaseLifecycleLockMock).toHaveBeenCalled();
  });

  it("refuses a refresh behind an active destroy lifecycle fence", async () => {
    getCurrentLifecycleLockMock.mockResolvedValue({ lockId: "destroy-lock", action: "destroy" });

    await expect(handleRefreshBackups("i-abc123")).rejects.toMatchObject({ name: "LifecycleLockConflictError" });
    expect(acquireLifecycleLockMock).not.toHaveBeenCalled();
    expect(getInstanceStateMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
  });

  it("keeps nested shell metacharacters and single quotes in the Drive path as data", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-backups-shell-quote-"));
    const markerPath = path.join(rootDir, "injected");
    const argsPath = path.join(rootDir, "rclone-args");
    const rclonePath = path.join(rootDir, "rclone");
    const authPath = path.join(rootDir, "mc-backup-auth.py");
    const remote = `drive'$(touch "${markerPath}")`;
    const driveRoot = `nested/it's; touch "${markerPath}"; \$(touch "${markerPath}")`;

    try {
      writeFileSync(
        rclonePath,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\0' "$@" > "$RCLONE_ARGS_PATH"\nprintf 'safe.tar.gz|10|2026-01-01\\n'\n`,
        "utf8"
      );
      chmodSync(rclonePath, 0o755);
      writeFileSync(
        authPath,
        "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" > \"$AUTH_ARGS_PATH\"\nprintf '[]\\n'\n",
        "utf8"
      );
      chmodSync(authPath, 0o755);

      const command = buildListBackupsCommand(
        remote,
        driveRoot,
        "/usr/bin/true",
        "/tmp/rclone.conf",
        rclonePath,
        authPath
      );
      const result = spawnSync("bash", ["-c", command], {
        env: { ...process.env, RCLONE_ARGS_PATH: argsPath, AUTH_ARGS_PATH: argsPath },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(markerPath)).toBe(false);
      expect(readFileSync(argsPath, "utf8").split("\0")).toContain(remote);
      expect(readFileSync(argsPath, "utf8").split("\0")).toContain(driveRoot);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
