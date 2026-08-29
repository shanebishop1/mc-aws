import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/mc-restore.sh");
const cleanupDirs: string[] = [];

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

type ArchiveKind = "success" | "traversal" | "symlink" | "wrong-root";

const createArchive = (archivePath: string, kind: ArchiveKind): void => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import io, sys, tarfile
archive_path, kind = sys.argv[1:]
with tarfile.open(archive_path, "w:gz") as archive:
    if kind == "success":
        root = tarfile.TarInfo("server/")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        data = b"restored-world\\n"
        entry = tarfile.TarInfo("server/world.txt")
        entry.size = len(data)
        entry.mode = 0o640
        archive.addfile(entry, io.BytesIO(data))
    elif kind == "traversal":
        data = b"escape"
        entry = tarfile.TarInfo("server/../../escaped")
        entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))
    elif kind == "symlink":
        entry = tarfile.TarInfo("server/link")
        entry.type = tarfile.SYMTYPE
        entry.linkname = "/tmp/target"
        archive.addfile(entry)
    elif kind == "wrong-root":
        entry = tarfile.TarInfo("world/")
        entry.type = tarfile.DIRTYPE
        archive.addfile(entry)
`,
      archivePath,
      kind,
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Could not create test archive: ${result.stderr}`);
  }
};

interface Harness {
  rootDir: string;
  serverDir: string;
  maintenanceLock: string;
  operationLock: string;
  restoreJournal: string;
  systemctlLog: string;
  addArchive: (name: string, kind?: ArchiveKind) => void;
  run: (reference?: string, extraEnv?: Record<string, string | undefined>) => SpawnSyncReturns<string>;
}

const createHarness = (): Harness => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-restore-test-"));
  const binDir = path.join(rootDir, "bin");
  const archiveDir = path.join(rootDir, "archives");
  const stateDir = path.join(rootDir, "state");
  const serverParent = path.join(rootDir, "minecraft");
  const serverDir = path.join(serverParent, "server");
  const maintenanceLock = path.join(stateDir, "maintenance.lock");
  const operationLock = path.join(stateDir, "operation.lock");
  const systemctlLog = path.join(stateDir, "systemctl.log");
  const restoreJournal = path.join(stateDir, "restore-journal.json");
  const startCount = path.join(stateDir, "start-count");
  const healthCount = path.join(stateDir, "health-count");
  const sleepCount = path.join(stateDir, "sleep-count");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(serverDir, "world.txt"), "original-world\n", "utf8");
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(startCount, "0", "utf8");
  writeFileSync(healthCount, "0", "utf8");
  writeFileSync(sleepCount, "0", "utf8");
  const bootIdFile = path.join(stateDir, "boot-id");
  writeFileSync(bootIdFile, "boot-test-1\n", "utf8");

  makeExecutable(path.join(binDir, "flock"), "#!/usr/bin/env bash\nexit 0\n");

  makeExecutable(
    path.join(binDir, "rclone"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  lsf)
    printf '%s' "\${RCLONE_TEST_LIST:-}"
    ;;
  copy)
    [[ "\${RESTORE_TEST_RCLONE_FAIL:-0}" != "1" ]] || exit 1
    source_name="\${2##*/}"
    /bin/cp "${archiveDir}/\${source_name}" "\${3}/\${source_name}"
    ;;
  *)
    exit 2
    ;;
esac
`
  );

  makeExecutable(
    path.join(binDir, "mcstatus"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${RESTORE_TEST_PROTOCOL_FAIL:-0}" != "1" ]]
`
  );

  makeExecutable(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${systemctlLog}"
case "\${1:-}" in
  stop)
    [[ "\${RESTORE_TEST_STOP_FAIL:-0}" != "1" ]]
    ;;
  start)
    count=$(/bin/cat "${startCount}")
    count=$((count + 1))
    printf '%s\n' "$count" > "${startCount}"
    if [[ "\${RESTORE_TEST_START_FAIL_ONCE:-0}" == "1" && "$count" == "1" ]]; then
      exit 1
    fi
    ;;
  is-active)
    count=$(/bin/cat "${healthCount}")
    count=$((count + 1))
    printf '%s\n' "$count" > "${healthCount}"
    if [[ "\${RESTORE_TEST_SIGNAL_ON_HEALTH:-0}" == "1" && "$count" == "1" ]]; then
      kill -TERM "$PPID"
      exit 143
    fi
    if [[ "\${RESTORE_TEST_HEALTH_FAIL_ONCE:-0}" == "1" && "$count" == "1" ]]; then
      exit 1
    fi
    ;;
  status)
    exit 0
    ;;
esac
`
  );

  makeExecutable(
    path.join(binDir, "chown"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${RESTORE_TEST_CHOWN_FAIL:-0}" != "1" ]]
`
  );

  makeExecutable(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
set -euo pipefail
count=$(/bin/cat "${sleepCount}")
count=$((count + 1))
printf '%s\n' "$count" > "${sleepCount}"
if [[ "\${RESTORE_TEST_SLEEP_FAIL_ONCE:-0}" == "1" && "$count" == "1" ]]; then
  exit 1
fi
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "mv"),
    `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "\${args[0]:-}" == "--" ]]; then
  args=("\${args[@]:1}")
fi
source_path="\${args[0]:-}"
destination_path="\${args[1]:-}"
if [[ "\${RESTORE_TEST_INSTALL_FAIL:-0}" == "1" && "$source_path" == */extract/server && "$destination_path" == "${serverDir}" ]]; then
  exit 1
fi
/bin/mv -- "\${args[@]}"
if [[ "\${RESTORE_TEST_KILL_AFTER_PREVIOUS_MOVE:-0}" == "1" && "$source_path" == "${serverDir}" ]]; then
  kill -KILL "$PPID"
fi
`
  );

  return {
    rootDir,
    serverDir,
    maintenanceLock,
    operationLock,
    restoreJournal,
    systemctlLog,
    addArchive: (name, kind = "success") => createArchive(path.join(archiveDir, name), kind),
    run: (reference = "backup", extraEnv = {}) =>
      spawnSync("bash", [scriptPath, reference], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MC_SERVER_DIR: serverDir,
          MC_OPERATION_LOCK: operationLock,
          MC_MAINTENANCE_LOCK: maintenanceLock,
          MC_HIBERNATE_GUARD: path.join(stateDir, "hibernate.guard"),
          MC_BOOT_ID_FILE: bootIdFile,
          MC_RCLONE_CONFIG_HELPER: "/usr/bin/true",
          MC_PROFILE_INSTALLER: "/usr/bin/true",
          MC_RESTORE_HEALTH_DELAY: "0",
          MC_STATUS_BIN: path.join(binDir, "mcstatus"),
          MC_RESTORE_PROTOCOL_MAX_ATTEMPTS: "1",
          MC_RESTORE_PROTOCOL_POLL_INTERVAL: "0",
          MC_RESTORE_JOURNAL: restoreJournal,
          MC_RESTORE_STAGING_PARENT: serverParent,
          ...extraEnv,
          NODE_ENV: process.env.NODE_ENV ?? "test",
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

describe("mc-restore.sh", () => {
  it("stages a stem-named archive, switches successfully, and preserves a caller maintenance lock", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    writeFileSync(harness.maintenanceLock, "caller-owned\n", "utf8");

    const result = harness.run("backup");

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
    expect(statSync(path.join(harness.serverDir, "world.txt")).mode & 0o777).toBe(0o640);
    const retainedServer = readdirSync(path.dirname(harness.serverDir)).find((entry) =>
      entry.startsWith("server.backup-")
    );
    expect(retainedServer).toBeDefined();
    expect(readFileSync(path.join(path.dirname(harness.serverDir), retainedServer!, "world.txt"), "utf8")).toBe(
      "original-world\n"
    );
    expect(readFileSync(harness.maintenanceLock, "utf8")).toBe("caller-owned\n");
    expect(existsSync(harness.operationLock)).toBe(true);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("is-active --quiet minecraft");
    expect(result.stdout).toContain("Applying current server profile to restored world");
  }, 15_000);

  it("supports latest selection of a .gz archive", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("newest.gz");

    const result = harness.run("latest", { RCLONE_TEST_LIST: "notes.txt\nnewest.gz\nolder.tar.gz\n" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Found latest backup: newest.gz");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
  });

  it.each([
    ["install", { RESTORE_TEST_INSTALL_FAIL: "1" }],
    ["profile application", { MC_PROFILE_INSTALLER: "/usr/bin/false" }],
    ["start", { RESTORE_TEST_START_FAIL_ONCE: "1" }],
    ["health check", { RESTORE_TEST_HEALTH_FAIL_ONCE: "1" }],
  ])("restores and restarts the previous server after a %s failure", (_failure, environment) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", environment);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    const systemctlCalls = readFileSync(harness.systemctlLog, "utf8");
    expect(systemctlCalls).toMatch(/start minecraft/);
    expect(systemctlCalls.match(/is-active --quiet minecraft/g)).toHaveLength(_failure === "health check" ? 2 : 1);
    expect(existsSync(harness.operationLock)).toBe(true);
  });

  it("does not stop the server when staged ownership cannot be set", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_CHOWN_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).toBe("");
  });

  it("does not install the staged directory when stopping the service fails", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_STOP_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("start minecraft\n");
  });

  it.each([
    ["a termination signal", { RESTORE_TEST_SIGNAL_ON_HEALTH: "1" }],
    ["an unexpected command error", { RESTORE_TEST_SLEEP_FAIL_ONCE: "1" }],
  ])("rolls back and health-checks the previous server after %s", (_description, environment) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", environment);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    const calls = readFileSync(harness.systemctlLog, "utf8");
    expect(calls).toContain("start minecraft");
    expect(calls).toContain("is-active --quiet minecraft");
  });

  it("retains only the newest configured number of successful server backups", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    const serverParent = path.dirname(harness.serverDir);
    for (const suffix of ["20240101-000000", "20240102-000000", "20240103-000000"]) {
      const backup = path.join(serverParent, `server.backup-${suffix}`);
      mkdirSync(backup);
      writeFileSync(path.join(backup, "world.txt"), suffix, "utf8");
    }

    const result = harness.run("backup", { MC_RESTORE_BACKUP_RETENTION: "2" });

    expect(result.status, result.stderr).toBe(0);
    const retained = readdirSync(serverParent)
      .filter((entry) => entry.startsWith("server.backup-"))
      .sort();
    expect(retained).toHaveLength(2);
    expect(retained).toContain("server.backup-20240103-000000");
  });

  it("does not prune retained backups when the new server fails health checking", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    const serverParent = path.dirname(harness.serverDir);
    for (const suffix of ["20240101-000000", "20240102-000000", "20240103-000000"]) {
      mkdirSync(path.join(serverParent, `server.backup-${suffix}`));
    }

    const result = harness.run("backup", {
      MC_RESTORE_BACKUP_RETENTION: "2",
      RESTORE_TEST_HEALTH_FAIL_ONCE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(readdirSync(serverParent).filter((entry) => entry.startsWith("server.backup-"))).toHaveLength(3);
  });

  it("rolls back when the service is active but the Minecraft protocol is not ready", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_PROTOCOL_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(result.stdout).toContain("protocol readiness");
  });

  it("recovers a durable swap journal after SIGKILL before starting another restore", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const killed = harness.run("backup", { RESTORE_TEST_KILL_AFTER_PREVIOUS_MOVE: "1" });
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(harness.restoreJournal)).toBe(true);
    expect(existsSync(harness.serverDir)).toBe(false);

    const recovered = harness.run("backup", { RESTORE_TEST_RCLONE_FAIL: "1" });
    expect(recovered.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(existsSync(harness.restoreJournal)).toBe(false);
    expect(readdirSync(path.dirname(harness.serverDir)).filter((entry) => entry.startsWith(".mc-restore."))).toEqual(
      []
    );
    expect(recovered.stdout).toContain("Interrupted restore recovery completed");
  });

  it("recovers and cleans local journal state before Drive credential setup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const killed = harness.run("backup", { RESTORE_TEST_KILL_AFTER_PREVIOUS_MOVE: "1" });
    expect(killed.signal).toBe("SIGKILL");

    const recovered = harness.run("backup", { MC_RCLONE_CONFIG_HELPER: "/usr/bin/false" });
    expect(recovered.status).not.toBe(0);
    expect(recovered.stdout).toContain("Interrupted restore recovery completed");
    expect(recovered.stdout).toContain("Failed to materialize Google Drive configuration");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(existsSync(harness.restoreJournal)).toBe(false);
    expect(readdirSync(path.dirname(harness.serverDir)).filter((entry) => entry.startsWith(".mc-restore."))).toEqual(
      []
    );
  });

  it.each([
    ["path traversal", "traversal"],
    ["symlink", "symlink"],
    ["wrong root", "wrong-root"],
  ] as const)("rejects a staged archive containing %s entries before downtime", (_description, kind) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("unsafe.tar.gz", kind);

    const result = harness.run("unsafe.tar.gz");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Archive validation/extraction failed");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).toBe("");
    expect(existsSync(path.join(harness.rootDir, "escaped"))).toBe(false);
  });
});
