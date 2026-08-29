import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  operationLock: string;
  hibernateGuard: string;
  bootIdFile: string;
  backupJournal: string;
  runBackup: (args?: string[], extraEnv?: Record<string, string>) => SpawnSyncReturns<string>;
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
  const operationLock = path.join(stateDir, "operation.lock");
  const hibernateGuard = path.join(stateDir, "hibernate.guard");
  const bootIdFile = path.join(stateDir, "boot-id");
  const backupJournal = path.join(stateDir, "backup-journal.json");
  const restoreJournal = path.join(stateDir, "restore-journal.json");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "world.txt"), "producer-world\n", { mode: 0o640 });
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(rcloneLog, "", "utf8");
  writeFileSync(remoteFile, "persisted-drive\n", "utf8");
  writeFileSync(rootFile, "nested/backups\n", "utf8");
  writeFileSync(bootIdFile, "boot-test-1\n", "utf8");

  makeExecutable(
    path.join(binDir, "flock"),
    `#!/usr/bin/env bash
[[ "\${FLOCK_TEST_FAIL:-0}" != "1" ]]
`
  );

  makeExecutable(
    path.join(binDir, "rclone"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${rcloneLog}"
if [[ "\${1:-}" == "copyto" ]]; then
  destination_name="\${3##*/}"
  /bin/cp "\${2}" "${uploadDir}/\${destination_name}"
elif [[ "\${1:-}" == "copy" && "\${2}" == *:* ]]; then
  source_name="\${2##*/}"
  /bin/cp "${uploadDir}/\${source_name}" "\${3}/\${source_name}"
  exit 0
else
  exit 2
fi
if [[ "\${RCLONE_TEST_AMBIGUOUS_ONCE:-0}" == "1" && ! -e "${stateDir}/rclone-ambiguous-returned" ]]; then
  : > "${stateDir}/rclone-ambiguous-returned"
  exit 1
fi
`
  );

  makeExecutable(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${systemctlLog}"
if [[ "\${SYSTEMCTL_TEST_INACTIVE:-0}" == "1" && "\${1:-}" == "is-active" ]]; then
  exit 3
fi
if [[ "\${SYSTEMCTL_TEST_START_FAIL:-0}" == "1" && "\${1:-}" == "start" ]]; then
  exit 1
fi
exit 0
`
  );

  makeExecutable(path.join(binDir, "mcstatus"), "#!/usr/bin/env bash\nexit 0\n");

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
    MC_OPERATION_LOCK: operationLock,
    MC_MAINTENANCE_LOCK: path.join(stateDir, "maintenance.lock"),
    MC_HIBERNATE_GUARD: hibernateGuard,
    MC_BOOT_ID_FILE: bootIdFile,
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
    operationLock,
    hibernateGuard,
    bootIdFile,
    backupJournal,
    runBackup: (args = ["contract"], extraEnv = {}) =>
      spawnSync("bash", [backupScript, ...args], {
        env: {
          ...commonEnv,
          MC_BACKUP_TEMP_DIR: stateDir,
          MC_BACKUP_JOURNAL: backupJournal,
          ...extraEnv,
        },
        encoding: "utf8",
      }),
    runRestore: () =>
      spawnSync("bash", [restoreScript, "contract.tar.gz"], {
        env: {
          ...commonEnv,
          MC_PROFILE_INSTALLER: "/usr/bin/true",
          MC_RESTORE_HEALTH_DELAY: "0",
          MC_RESTORE_STAGING_PARENT: serverParent,
          MC_RESTORE_JOURNAL: restoreJournal,
          MC_STATUS_BIN: path.join(binDir, "mcstatus"),
          MC_RESTORE_PROTOCOL_MAX_ATTEMPTS: "1",
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

describe("backup and restore archive contract", { timeout: 20_000 }, () => {
  it("produces an archive that the safe restore consumer accepts", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const backupResult = harness.runBackup();
    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
    expect(readFileSync(harness.rcloneLog, "utf8")).toContain("persisted-drive:nested/backups/contract.tar.gz");

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

  it("keeps Minecraft stopped and blocks restore after a hibernate backup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--hibernate", "contract"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("stop minecraft\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).not.toContain("start minecraft\n");
    expect(existsSync(harness.hibernateGuard)).toBe(true);
    expect(harness.runRestore().status).not.toBe(0);
  });

  it("preserves an initially inactive Minecraft service without starting it", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["contract"], { SYSTEMCTL_TEST_INACTIVE: "1" });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(harness.systemctlLog, "utf8");
    expect(calls).toContain("is-active --quiet minecraft.service");
    expect(calls).not.toContain("stop minecraft");
    expect(calls).not.toContain("start minecraft");
  });

  it("skips require-active scheduled mode when Minecraft is inactive", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--require-active", "contract"], { SYSTEMCTL_TEST_INACTIVE: "1" });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("scheduled backup will not start it");
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });

  it("recovers an aborted hibernate and clears its guard under the shared lock", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    writeFileSync(harness.hibernateGuard, "boot-test-1\n", "utf8");

    const result = harness.runBackup(["--recover-hibernate"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).toBe("start minecraft\n");
    expect(existsSync(harness.hibernateGuard)).toBe(false);
  });

  it("removes a stale hibernate guard after reboot", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    writeFileSync(harness.hibernateGuard, "old-boot\n", "utf8");

    const result = harness.runBackup();

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(harness.hibernateGuard)).toBe(false);
  });

  it("fails closed when another host lifecycle operation owns the atomic lock", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const result = harness.runBackup(undefined, { FLOCK_TEST_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Another backup, restore, or hibernate operation is in progress");
    expect(readFileSync(harness.systemctlLog, "utf8")).toBe("");
  });

  it("does not repeat an uploaded backup when only the Minecraft restart failed", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const operationKey = "a".repeat(64);
    const failed = harness.runBackup(["contract"], {
      SYSTEMCTL_TEST_START_FAIL: "1",
      MC_REMOTE_OPERATION_KEY: operationKey,
    });
    expect(failed.status).not.toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
    expect(existsSync(harness.backupJournal)).toBe(true);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "uploaded",
      operationKey,
      backupName: "contract",
    });
    const uploadsAfterFailure = readFileSync(harness.rcloneLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("copyto "));
    expect(uploadsAfterFailure).toHaveLength(1);

    const recovered = harness.runBackup(["different-generated-name"], {
      MC_REMOTE_OPERATION_KEY: operationKey,
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("was already uploaded");
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "restart-complete",
      operationKey,
      backupName: "contract",
    });
    const allUploads = readFileSync(harness.rcloneLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("copyto "));
    expect(allUploads).toHaveLength(1);
  });

  it("retries an ambiguous rclone result against the same remote object", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const operationKey = "b".repeat(64);

    const ambiguous = harness.runBackup(["first-name"], {
      MC_REMOTE_OPERATION_KEY: operationKey,
      RCLONE_TEST_AMBIGUOUS_ONCE: "1",
    });
    expect(ambiguous.status).not.toBe(0);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "uploading",
      backupName: "first-name",
      operationKey,
    });

    const retried = harness.runBackup(["second-name"], {
      MC_REMOTE_OPERATION_KEY: operationKey,
      RCLONE_TEST_AMBIGUOUS_ONCE: "1",
    });
    expect(retried.status, retried.stderr).toBe(0);
    const targets = readFileSync(harness.rcloneLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ").at(-1));
    expect(targets).toEqual([
      "persisted-drive:nested/backups/first-name.tar.gz",
      "persisted-drive:nested/backups/first-name.tar.gz",
    ]);
    expect(readdirSync(path.dirname(harness.uploadedArchive))).toEqual(["first-name.tar.gz"]);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "restart-complete",
      backupName: "first-name",
      operationKey,
    });
  });

  it("fails closed without touching paths named by a malformed durable journal", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const operationKey = "e".repeat(64);
    writeFileSync(
      harness.backupJournal,
      JSON.stringify({
        version: 1,
        phase: "uploading",
        backupName: "../../outside",
        mode: "ordinary",
        operationKey,
      }),
      "utf8"
    );

    const result = harness.runBackup(["contract"], { MC_REMOTE_OPERATION_KEY: operationKey });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid backup journal name");
    expect(readFileSync(harness.rcloneLog, "utf8")).toBe("");
  });
});
