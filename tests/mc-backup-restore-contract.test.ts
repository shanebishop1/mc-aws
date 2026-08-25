import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backupScript = path.resolve(process.cwd(), "infra/src/ec2/mc-backup.sh");
const restoreScript = path.resolve(process.cwd(), "infra/src/ec2/mc-restore.sh");
const cleanupDirs: string[] = [];

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

interface Harness {
  rootDir: string;
  serverDir: string;
  uploadedArchive: string;
  systemctlLog: string;
  rcloneLog: string;
  runBackup: () => SpawnSyncReturns<string>;
  runRestore: () => SpawnSyncReturns<string>;
}

const createHarness = (): Harness => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-backup-contract-test-"));
  const binDir = path.join(rootDir, "bin");
  const stateDir = path.join(rootDir, "state");
  const uploadDir = path.join(rootDir, "uploaded");
  const serverParent = path.join(rootDir, "minecraft");
  const serverDir = path.join(serverParent, "server");
  const systemctlLog = path.join(stateDir, "systemctl.log");
  const rcloneLog = path.join(stateDir, "rclone.log");
  const remoteFile = path.join(stateDir, "gdrive-remote");
  const rootFile = path.join(stateDir, "gdrive-root");
  const uploadedArchive = path.join(uploadDir, "contract.tar.gz");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "world.txt"), "producer-world\n", { mode: 0o640 });
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(rcloneLog, "", "utf8");
  writeFileSync(remoteFile, "persisted-drive\n", "utf8");
  writeFileSync(rootFile, "nested/backups\n", "utf8");

  makeExecutable(
    path.join(binDir, "rclone"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${rcloneLog}"
if [[ "\${1:-}" != "copy" ]]; then
  exit 2
fi
if [[ "\${2}" == *:* ]]; then
  source_name="\${2##*/}"
  /bin/cp "${uploadDir}/\${source_name}" "\${3}/\${source_name}"
else
  /bin/cp "\${2}" "${uploadDir}/"
fi
`
  );

  makeExecutable(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${systemctlLog}"
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "chown"),
    `#!/usr/bin/env bash
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
exit 0
`
  );

  const commonEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    MC_SERVER_DIR: serverDir,
    MC_OPERATION_LOCK: path.join(stateDir, "operation.lock"),
    MC_MAINTENANCE_LOCK: path.join(stateDir, "maintenance.lock"),
    MC_RCLONE_CONFIG_HELPER: "/usr/bin/true",
    MC_RCLONE_REMOTE_FILE: remoteFile,
    MC_RCLONE_ROOT_FILE: rootFile,
    GDRIVE_REMOTE: undefined,
    GDRIVE_ROOT: undefined,
    COPYFILE_DISABLE: "1",
  };

  return {
    rootDir,
    serverDir,
    uploadedArchive,
    systemctlLog,
    rcloneLog,
    runBackup: () =>
      spawnSync("bash", [backupScript, "contract"], {
        env: {
          ...commonEnv,
          MC_BACKUP_TEMP_DIR: stateDir,
        },
        encoding: "utf8",
      }),
    runRestore: () =>
      spawnSync("bash", [restoreScript, "contract.tar.gz"], {
        env: {
          ...commonEnv,
          MC_RESTORE_HEALTH_DELAY: "0",
          MC_RESTORE_STAGING_PARENT: serverParent,
        },
        encoding: "utf8",
      }),
  };
};

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("backup and restore archive contract", () => {
  it("produces an archive that the safe restore consumer accepts", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const backupResult = harness.runBackup();
    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
    expect(readFileSync(harness.rcloneLog, "utf8")).toContain("persisted-drive:nested/backups/");

    writeFileSync(path.join(harness.serverDir, "world.txt"), "changed-after-backup\n", "utf8");
    const restoreResult = harness.runRestore();

    expect(restoreResult.status, restoreResult.stderr).toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("producer-world\n");
  });

  it.each(["symlink", "hardlink"] as const)("rejects a %s before stopping or uploading", (entryType) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const worldPath = path.join(harness.serverDir, "world.txt");
    const unsafePath = path.join(harness.serverDir, `unsafe-${entryType}`);
    if (entryType === "symlink") {
      symlinkSync(worldPath, unsafePath);
    } else {
      linkSync(worldPath, unsafePath);
    }

    const result = harness.runBackup();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Server tree validation failed");
    expect(readFileSync(harness.systemctlLog, "utf8")).toBe("");
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });
});
