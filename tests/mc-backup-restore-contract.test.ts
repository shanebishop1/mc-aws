import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { canonicalJson } from "@/lib/agent/canonical-json";
import { afterEach, describe, expect, it } from "vitest";

const backupScript = path.resolve(process.cwd(), "infra/src/ec2/mc-backup.sh");
const restoreScript = path.resolve(process.cwd(), "infra/src/ec2/mc-restore.sh");
const backupAuthScript = path.resolve(process.cwd(), "infra/src/ec2/mc-backup-auth.py");
const hostOperationScript = path.resolve(process.cwd(), "infra/src/ec2/mc-host-operation.py");
const hostOperationContract = path.resolve(process.cwd(), "infra/src/ec2/host-operation-contract.json");
const maintenanceBootScript = path.resolve(process.cwd(), "infra/src/ec2/mc-maintenance-boot.py");
const cleanupDirs: string[] = [];

describe("mc-backup entrypoint syntax", () => {
  it("parses the entrypoint that owns every shipped backup mode", () => {
    const result = spawnSync("bash", ["-n", backupScript], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);

    const source = readFileSync(backupScript, "utf8");
    for (const mode of ["--hibernate", "--destroy", "--replacement", "--recover-hibernate", "--verify-terminal"]) {
      expect(source).toContain(mode);
    }
  });
});

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

interface Harness {
  rootDir: string;
  serverDir: string;
  uploadedArchive: string;
  uploadedManifest: string;
  systemctlLog: string;
  rcloneLog: string;
  operationLock: string;
  maintenanceLock: string;
  maintenanceBootHold: string;
  hibernateGuard: string;
  bootIdFile: string;
  backupJournal: string;
  gatewayJournal: string;
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
  const systemctlStateDir = path.join(stateDir, "systemctl-state");
  const rcloneLog = path.join(stateDir, "rclone.log");
  const remoteFile = path.join(stateDir, "gdrive-remote");
  const rootFile = path.join(stateDir, "gdrive-root");
  const rcloneConfig = path.join(stateDir, "rclone.conf");
  const uploadedArchive = path.join(uploadDir, "contract.tar.gz");
  const uploadedManifest = `${uploadedArchive}.manifest.json`;
  const operationLock = path.join(stateDir, "operation.lock");
  const hibernateGuard = path.join(stateDir, "hibernate.guard");
  const bootIdFile = path.join(stateDir, "boot-id");
  const backupJournal = path.join(stateDir, "backup-journal.json");
  const restoreJournal = path.join(stateDir, "restore-journal.json");
  const keyringFile = path.join(stateDir, "backup-keyring.json");
  const serverIdFile = path.join(stateDir, "backup-server-id");
  const instanceIdFile = path.join(stateDir, "instance-id");
  const generationState = path.join(stateDir, "backup-generation.json");
  const generationCloud = path.join(stateDir, "backup-generation-cloud");
  const backupMigrationLock = path.join(stateDir, "backup-migration.lock");
  const restoreFloorState = path.join(stateDir, "restore-floor.json");
  const restoreFloorCloud = path.join(stateDir, "restore-floor-cloud");
  const executorKey = path.join(stateDir, "executor-journal-hmac.key");
  const executorJournal = path.join(stateDir, "executor-effect-journal.json");
  const gatewayJournal = path.join(stateDir, "executor-reconciliations.json");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(systemctlStateDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "world.txt"), "producer-world\n", { mode: 0o640 });
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(rcloneLog, "", "utf8");
  writeFileSync(remoteFile, "persisted-drive\n", "utf8");
  writeFileSync(rootFile, "nested/backups\n", "utf8");
  writeFileSync(rcloneConfig, "[persisted-drive]\ntype = drive\n", "utf8");
  writeFileSync(bootIdFile, "boot-test-1\n", "utf8");
  writeFileSync(
    keyringFile,
    JSON.stringify({
      schemaVersion: 1,
      currentKeyId: "contract-key",
      keys: [{ keyId: "contract-key", secretBase64: Buffer.alloc(32, 7).toString("base64"), status: "active" }],
    })
  );
  writeFileSync(serverIdFile, "arn:aws:cloudformation:us-west-1:111111111111:stack/Test/stable\n");
  writeFileSync(instanceIdFile, "i-1234567890abcdef0\n");
  writeFileSync(generationCloud, "UNINITIALIZED\n");
  writeFileSync(restoreFloorCloud, "UNINITIALIZED\n");
  writeFileSync(executorKey, Buffer.alloc(32, 7), { mode: 0o400 });
  writeFileSync(gatewayJournal, JSON.stringify({ schemaVersion: 1, entries: [] }));

  makeExecutable(
    path.join(binDir, "aws"),
    `#!/usr/bin/env bash
if [[ "$*" == *"backup-auth-keyring"* ]]; then /bin/cat "${keyringFile}"; else /bin/cat "${serverIdFile}"; fi
`
  );
  makeExecutable(
    path.join(binDir, "mc-backup-auth"),
    `#!/usr/bin/env bash
exec python3 "${backupAuthScript}" "$@"
`
  );
  makeExecutable(
    path.join(binDir, "mc-host-operation"),
    `#!/usr/bin/env bash
exec python3 "${hostOperationScript}" --contract "${hostOperationContract}" "$@"
`
  );
  makeExecutable(path.join(binDir, "mc-agent-workspace-dac"), "#!/usr/bin/env bash\nexit 0\n");
  makeExecutable(
    path.join(binDir, "mc-agent-world-roots"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "inspect" && "$*" == *"--output roots-json"* ]]; then
  printf '%s\n' '{"persistentWorldRoots":["world","custom/nether","custom/end"],"schemaVersion":1}'
elif [[ "\${1:-}" == "inspect" ]]; then
  printf '%s\n' '${"a".repeat(64)}'
else
  exit 0
fi
`
  );

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
if [[ "\${1:-}" == "lsf" ]]; then
  exit 0
elif [[ "\${1:-}" == "lsjson" ]]; then
  printf '['
  first=1
  for object in "${uploadDir}"/*; do
    [[ -f "$object" ]] || continue
    name="\${object##*/}"
    [[ "$first" == "1" ]] || printf ','
    first=0
    printf '{"Path":"%s","Name":"%s","ID":"id-%s","Size":%s}' \
      "$name" "$name" "$name" "$(stat -c '%s' "$object")"
  done
  printf ']\n'
elif [[ "\${1:-}" == "backend" && "\${2:-}" == "copyid" ]]; then
  object_id="\${4#id-}"
  /bin/cp "${uploadDir}/\${object_id}" "\${5}"
elif [[ "\${1:-}" == "copyto" ]]; then
  destination_name="\${3##*/}"
  /bin/cp "\${2}" "${uploadDir}/\${destination_name}"
elif [[ "\${1:-}" == "copy" && "\${2}" == *:* ]]; then
  source_name="\${2##*/}"
  /bin/cp "${uploadDir}/\${source_name}" "\${3}/\${source_name}"
  exit 0
elif [[ "\${1:-}" == "cat" && "\${2}" == *:* ]]; then
  source_name="\${2##*/}"
  /bin/cat "${uploadDir}/\${source_name}"
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
state_dir="\${SYSTEMCTL_TEST_STATE_DIR}"
unit_state() { printf '%s/%s' "$state_dir" "\${1//[^A-Za-z0-9_.-]/_}"; }
default_active() {
  case "$1" in
    minecraft.service) [[ "\${SYSTEMCTL_TEST_INACTIVE:-0}" != "1" ]] ;;
    mc-agent-gateway.service) [[ "\${BACKUP_TEST_GATEWAY_ACTIVE:-0}" == "1" ]] ;;
    *) return 1 ;;
  esac
}
if [[ "\${1:-}" == "is-active" ]]; then
  unit="\${3:-\${2:-}}"
  [[ "$unit" == *.service || "$unit" == *.socket ]] || unit="\${unit}.service"
  active=0
  if [[ -f "$(unit_state "$unit")" ]]; then
    [[ "$(<"$(unit_state "$unit")")" == "active" ]] && active=1
  elif default_active "$unit"; then
    active=1
  fi
  if [[ "\${SYSTEMCTL_TEST_RESTART_RACE:-0}" == "1" && "$unit" == "minecraft.service" && "\${SYSTEMCTL_TEST_RACE_ARMED:-0}" == "1" ]]; then
    active=1
  fi
  if (( active == 1 )); then
    [[ "\${2:-}" == "--quiet" ]] || printf 'active\n'
    exit 0
  fi
  [[ "\${2:-}" == "--quiet" ]] || printf 'inactive\n'
  exit 3
fi
if [[ "\${1:-}" == "is-enabled" ]]; then
  unit="\${2:-}"
  if [[ -f "$(unit_state "$unit").masked" ]]; then
    printf 'masked-runtime\n'
    exit 0
  fi
  exit 1
fi
if [[ "\${1:-}" == "mask" ]]; then
  [[ "\${SYSTEMCTL_TEST_MASK_FAIL:-0}" != "1" ]] || exit 1
  shift
  [[ "\${1:-}" == "--runtime" ]] && shift
  for unit in "$@"; do : > "$(unit_state "$unit").masked"; done
  exit 0
fi
if [[ "\${1:-}" == "unmask" ]]; then
  rm -f "$(unit_state "\${3:-\${2:-}}").masked"
  exit 0
fi
if [[ "\${1:-}" == "kill" ]]; then
  : > "$(unit_state "mc-agent-gateway.service")"
  printf 'inactive\n' > "$(unit_state "mc-agent-gateway.service")"
  exit 0
fi
if [[ "\${SYSTEMCTL_TEST_STOP_FAIL:-0}" == "1" && "\${1:-}" == "stop" ]]; then
  exit 1
fi
if [[ "\${1:-}" == "stop" ]]; then
  shift
  for unit in "$@"; do
    [[ "$unit" == --* ]] && continue
    if [[ "\${SYSTEMCTL_TEST_RESTART_RACE:-0}" == "1" && "$unit" == "minecraft.service" ]]; then
      printf 'active\n' > "$(unit_state "$unit")"
      export SYSTEMCTL_TEST_RACE_ARMED=1
    else
      printf 'inactive\n' > "$(unit_state "$unit")"
    fi
  done
  exit 0
fi
if [[ "\${SYSTEMCTL_TEST_START_FAIL:-0}" == "1" && "\${1:-}" == "start" ]]; then
  exit 1
fi
if [[ "\${1:-}" == "start" ]]; then
  printf 'active\n' > "$(unit_state "\${2:-}")"
  exit 0
fi
if [[ "\${1:-}" == "daemon-reload" ]]; then exit 0; fi
exit 0
`
  );

  makeExecutable(path.join(binDir, "mcstatus"), '#!/usr/bin/env bash\n[[ "${MCSTATUS_TEST_OPEN:-0}" == "1" ]]\n');

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
    SYSTEMCTL_TEST_STATE_DIR: systemctlStateDir,
    MC_OPERATION_LOCK: operationLock,
    MC_MAINTENANCE_LOCK: path.join(stateDir, "maintenance.lock"),
    MC_MAINTENANCE_BOOT_HOLD: path.join(stateDir, "maintenance-boot-hold.json"),
    MC_MAINTENANCE_BOOT_HELPER: maintenanceBootScript,
    MC_HIBERNATE_GUARD: hibernateGuard,
    MC_BOOT_ID_FILE: bootIdFile,
    MC_RCLONE_CONFIG_HELPER: "/usr/bin/true",
    RCLONE_CONFIG: rcloneConfig,
    MC_RCLONE_REMOTE_FILE: remoteFile,
    MC_RCLONE_ROOT_FILE: rootFile,
    MC_BACKUP_AUTH_HELPER: path.join(binDir, "mc-backup-auth"),
    MC_STATUS_BIN: path.join(binDir, "mcstatus"),
    MC_WORLD_ROOTS_HELPER: path.join(binDir, "mc-agent-world-roots"),
    MC_HOST_OPERATION_HELPER: path.join(binDir, "mc-host-operation"),
    MC_WORKSPACE_DAC_HELPER: path.join(binDir, "mc-agent-workspace-dac"),
    MC_HOST_OPERATION_CONTRACT: hostOperationContract,
    MC_BACKUP_INSTANCE_ID_FILE: instanceIdFile,
    MC_BACKUP_GENERATION_STATE: generationState,
    MC_BACKUP_GENERATION_CLOUD_FILE: generationCloud,
    MC_BACKUP_MIGRATION_LOCK_FILE: backupMigrationLock,
    MC_RESTORE_FLOOR_STATE: restoreFloorState,
    MC_RESTORE_FLOOR_CLOUD_FILE: restoreFloorCloud,
    MC_EXECUTOR_JOURNAL_CREDENTIAL: executorKey,
    MC_EXECUTOR_JOURNAL: executorJournal,
    MC_GATEWAY_RECONCILIATION_JOURNAL: gatewayJournal,
    MC_ROOT_VOLUME_ID: "vol-1234567890abcdef0",
    MC_ROOT_VOLUME_DEVICE: "/dev/xvda",
    GDRIVE_REMOTE: undefined,
    GDRIVE_ROOT: undefined,
    COPYFILE_DISABLE: "1",
  };

  return {
    rootDir,
    serverDir,
    uploadedArchive,
    uploadedManifest,
    systemctlLog,
    rcloneLog,
    operationLock,
    maintenanceLock: path.join(stateDir, "maintenance.lock"),
    maintenanceBootHold: path.join(stateDir, "maintenance-boot-hold.json"),
    hibernateGuard,
    bootIdFile,
    backupJournal,
    gatewayJournal,
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
          MCSTATUS_TEST_OPEN: "1",
          MC_WORLD_ROOTS_HELPER: path.join(binDir, "mc-agent-world-roots"),
          MC_SETUP_ROOT: rootDir,
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
  const expectNoServiceMutation = (log: string) => {
    expect(log).not.toMatch(/^(?:mask|unmask|start|stop|kill|daemon-reload)(?: |$)/m);
  };

  it("produces an archive that the safe restore consumer accepts", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const backupResult = harness.runBackup();
    expect(backupResult.status, backupResult.stderr).toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
    expect(existsSync(harness.uploadedManifest)).toBe(true);
    expect(spawnSync("tar", ["-tzf", harness.uploadedArchive], { encoding: "utf8" }).stdout.split("\n")).toContain(
      "server/.mc-aws-world-roots.json"
    );
    expect(existsSync(harness.backupJournal)).toBe(false);
    expect(readFileSync(harness.rcloneLog, "utf8")).toContain("persisted-drive:nested/backups/contract.tar.gz");

    writeFileSync(path.join(harness.serverDir, "world.txt"), "changed-after-backup\n", "utf8");
    const restoreResult = harness.runRestore();

    expect(restoreResult.status, `${restoreResult.stdout}\n${restoreResult.stderr}`).toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("producer-world\n");
    expect(existsSync(path.join(harness.serverDir, ".mc-aws-world-roots.json"))).toBe(false);
  });

  it("drains a nonempty production gateway reconciliation journal before backup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const invocation = {
      schemaVersion: 1,
      invocationId: "invocation-awaiting-backup",
      sessionId: "session-awaiting-backup",
      toolId: "filesystem.read",
      capability: "read-only",
      targetScope: { kind: "workspace", path: "." },
      arguments: { path: "server.properties", note: "café 雪 😀" },
      requestedAt: "2026-09-04T00:00:00.000Z",
    };
    writeFileSync(
      harness.gatewayJournal,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            schemaVersion: 1,
            key: "runtime-production:task-awaiting-backup:lease-awaiting-backup:4:invocation-awaiting-backup",
            runtimeId: "runtime-production",
            sessionId: "session-awaiting-backup",
            taskId: "task-awaiting-backup",
            leaseId: "lease-awaiting-backup",
            leaseGeneration: 4,
            invocationId: "invocation-awaiting-backup",
            invocationDigest: createHash("sha256").update(canonicalJson(invocation)).digest("hex"),
            state: "awaiting-backup",
            payload: {
              invocation,
              approvals: [],
              runtimeContext: {
                runtimeId: "runtime-production",
                taskId: "task-awaiting-backup",
                leaseId: "lease-awaiting-backup",
                leaseGeneration: 4,
              },
            },
            updatedAt: "2026-09-04T00:00:01.000Z",
          },
        ],
      }),
      { mode: 0o600 }
    );

    const result = harness.runBackup();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
  });

  it("fails closed for an orphaned schema-v3 sidecar before backup mutation or upload", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    writeFileSync(path.join(harness.rootDir, "state", "executor-effect-journal.json.append.0"), "", { mode: 0o600 });

    const result = harness.runBackup();

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/executor work did not drain|sidecar|manifest/i);
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });

  it("holds the shared fence while allowing only the current agent run to continue after backup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--require-active", "--agent-two-phase", "agent-effect"], {
      BACKUP_TEST_GATEWAY_ACTIVE: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(harness.systemctlLog, "utf8");
    expect(calls).toContain("kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service");
    expect(calls).toContain(
      "mask --runtime minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service"
    );
    expect(calls).toContain(
      "stop mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service"
    );
    expect(calls).not.toContain("stop mc-agent-gateway.service");
    expect(existsSync(harness.maintenanceLock)).toBe(false);
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
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });

  it("keeps Minecraft stopped and blocks restore after a hibernate backup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--hibernate", "contract"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain(
      "stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service\n"
    );
    expect(readFileSync(harness.systemctlLog, "utf8")).not.toContain("start minecraft\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain(
      "mask --runtime minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service\n"
    );
    expect(existsSync(harness.hibernateGuard)).toBe(true);
    expect(existsSync(harness.maintenanceLock)).toBe(true);
    expect(result.stdout).toContain('MC_BACKUP_QUIESCENCE_RESULT {"bootId":"boot-test-1"');
    expect(harness.runRestore().status).not.toBe(0);
  });

  it("fails hibernation when a required service stop fails", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--hibernate", "contract"], { SYSTEMCTL_TEST_STOP_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(existsSync(harness.uploadedArchive)).toBe(false);
    expect(existsSync(harness.uploadedManifest)).toBe(false);
  });

  it("fails closed when a service restart race breaks verified quiescence", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--hibernate", "contract"], { SYSTEMCTL_TEST_RESTART_RACE: "1" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/not inactive|quiescence/i);
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });

  it("fails closed when the Minecraft protocol remains open", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["--hibernate", "contract"], { MCSTATUS_TEST_OPEN: "1" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/protocol.*open/i);
    expect(existsSync(harness.uploadedArchive)).toBe(false);
  });

  it("preserves an initially inactive Minecraft service without starting it", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["contract"], { SYSTEMCTL_TEST_INACTIVE: "1" });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(harness.systemctlLog, "utf8");
    expect(calls).toContain("is-active --quiet minecraft.service");
    expect(calls).not.toContain("start minecraft");
  });

  it("restores the prior service state and releases the fence for a normal backup", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["contract"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("start minecraft.service\n");
    expect(existsSync(harness.maintenanceLock)).toBe(false);
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
    expect(harness.runBackup(["--hibernate", "contract"]).status).toBe(0);
    writeFileSync(harness.systemctlLog, "", "utf8");

    const result = harness.runBackup(["--recover-hibernate"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("start minecraft.service\n");
    expect(existsSync(harness.hibernateGuard)).toBe(false);
    expect(existsSync(harness.backupJournal)).toBe(false);
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
    expect(failed.status).toBe(75);
    expect(existsSync(harness.uploadedArchive)).toBe(true);
    expect(existsSync(harness.backupJournal)).toBe(true);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "restoring-services",
      operationKey,
      backupName: "contract",
    });
    const uploadsAfterFailure = readFileSync(harness.rcloneLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("copyto "));
    expect(uploadsAfterFailure).toHaveLength(2);

    const wrongOperation = harness.runBackup(["contract"], { MC_REMOTE_OPERATION_KEY: "c".repeat(64) });
    expect(wrongOperation.status).not.toBe(0);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "restoring-services",
      operationKey,
    });

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
    expect(allUploads).toHaveLength(2);
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
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    const targets = readFileSync(harness.rcloneLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ").at(-1));
    expect(targets).toEqual(
      expect.arrayContaining([
        "persisted-drive:nested/backups/first-name.tar.gz",
        "persisted-drive:nested/backups/first-name.tar.gz.manifest.json",
      ])
    );
    expect(readdirSync(path.dirname(harness.uploadedArchive)).sort()).toEqual([
      "first-name.tar.gz",
      "first-name.tar.gz.manifest.json",
    ]);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "restart-complete",
      backupName: "first-name",
      operationKey,
    });
  });

  it("retains an ordinary journal after upload ambiguity and resumes the same name", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const ambiguous = harness.runBackup(["ordinary-ambiguous"], { RCLONE_TEST_AMBIGUOUS_ONCE: "1" });
    expect(ambiguous.status).not.toBe(0);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      phase: "uploading",
      backupName: "ordinary-ambiguous",
      operationKey: null,
    });

    const recovered = harness.runBackup(["ordinary-ambiguous"], { RCLONE_TEST_AMBIGUOUS_ONCE: "1" });
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(existsSync(harness.backupJournal)).toBe(false);
  });

  it.each([
    "prepared",
    "quiescing",
    "quiesced",
    "uploading",
    "archive-uploaded",
    "publishing-manifest",
    "uploaded",
    "restoring-services",
    "restart-complete",
  ])(
    "recovers an ordinary backup crash at durable phase %s with exact service state",
    (phase) => {
      const harness = createHarness();
      cleanupDirs.push(harness.rootDir);
      const operationKey = "d".repeat(64);

      const killed = harness.runBackup(["phase-crash"], {
        MC_REMOTE_OPERATION_KEY: operationKey,
        MC_BACKUP_CRASH_AFTER_PHASE: phase,
      });
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(harness.backupJournal)).toBe(true);

      const recovered = harness.runBackup(["ignored-retry-name"], { MC_REMOTE_OPERATION_KEY: operationKey });
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
        phase: "restart-complete",
        operationKey,
        backupName: "phase-crash",
      });
      expect(existsSync(harness.maintenanceBootHold)).toBe(false);
    },
    20_000
  );

  it("invalidates terminal hibernate evidence after a boot change and preserves the volume transaction", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const operationKey = "f".repeat(64);
    const killed = harness.runBackup(["--hibernate", "stale-boot"], {
      MC_REMOTE_OPERATION_KEY: operationKey,
      MC_BACKUP_CRASH_AFTER_PHASE: "archive-uploaded",
    });
    expect(killed.signal).toBe("SIGKILL");
    writeFileSync(harness.bootIdFile, "boot-test-2\n", "utf8");
    const uploadsBeforeRetry = readFileSync(harness.rcloneLog, "utf8");

    const stale = harness.runBackup(["--hibernate", "stale-boot"], { MC_REMOTE_OPERATION_KEY: operationKey });
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toMatch(/previous boot|preserving the root volume/i);
    expect(readFileSync(harness.rcloneLog, "utf8")).toBe(uploadsBeforeRetry);
    expect(existsSync(harness.backupJournal)).toBe(true);
    expect(existsSync(harness.maintenanceBootHold)).toBe(true);
  });

  it("leaves no service mutation or journal write after a terminal destroy manifest publication", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const result = harness.runBackup(["--destroy", "terminal-destroy"], {
      MC_REMOTE_OPERATION_KEY: "9".repeat(64),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const journal = JSON.parse(readFileSync(harness.backupJournal, "utf8"));
    expect(journal).toMatchObject({ mode: "destroy", phase: "publishing-manifest" });
    expect(existsSync(harness.maintenanceBootHold)).toBe(true);
    const calls = readFileSync(harness.systemctlLog, "utf8").trim().split("\n");
    const finalQuiescenceRead = calls.findLastIndex((line) => line.startsWith("is-enabled "));
    expect(finalQuiescenceRead).toBe(calls.length - 1);
    expect(calls.slice(finalQuiescenceRead + 1)).toEqual([]);
  });

  it("binds replacement publication to its durable key and retains terminal quiescence", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const operationKey = "8".repeat(64);
    const result = harness.runBackup(["--replacement", "terminal-replacement"], {
      MC_REMOTE_OPERATION_KEY: operationKey,
      MC_ROOT_VOLUME_ID: "vol-1234567890abcdef0",
      MC_ROOT_VOLUME_DEVICE: "/dev/xvda",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('"mode":"terminal-replacement"');
    expect(result.stdout).toContain(`"operationKey":"${operationKey}"`);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({
      mode: "replacement",
      operationKey,
      phase: "publishing-manifest",
      volumeId: "vol-1234567890abcdef0",
    });
    const hold = JSON.parse(readFileSync(harness.maintenanceBootHold, "utf8"));
    expect(hold.operation).toBe("host-replacement");
    expect(hold.phase).toBe("publishing-manifest");
    expect(readFileSync(harness.systemctlLog, "utf8")).not.toContain("start minecraft.service");
  });

  it.each([
    ["destroy", ["--destroy", "failed-terminal-destroy"], "destroy"],
    ["replacement", ["--replacement", "failed-terminal-replacement"], "replacement"],
  ])("never reopens host writers after a terminal %s upload failure", (_label, args, mode) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const result = harness.runBackup(args, {
      MC_REMOTE_OPERATION_KEY: "7".repeat(64),
      RCLONE_TEST_AMBIGUOUS_ONCE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(harness.backupJournal, "utf8"))).toMatchObject({ phase: "uploading", mode });
    expect(existsSync(harness.maintenanceBootHold)).toBe(true);
    const calls = readFileSync(harness.systemctlLog, "utf8").trim().split("\n");
    expect(calls.some((line) => line.startsWith("start ") || line.startsWith("unmask "))).toBe(false);
  });

  it("fails closed without touching paths named by a malformed durable journal", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const operationKey = "e".repeat(64);
    writeFileSync(
      harness.backupJournal,
      JSON.stringify({
        version: 3,
        phase: "uploading",
        backupName: "../../outside",
        mode: "ordinary",
        operationKey,
        backupId: "f".repeat(32),
        createdAt: "2026-09-04T12:00:00Z",
        generation: 1,
      }),
      "utf8"
    );

    const result = harness.runBackup(["contract"], { MC_REMOTE_OPERATION_KEY: operationKey });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/backup journal.*invalid/i);
    expect(readFileSync(harness.rcloneLog, "utf8")).toBe("");
  });

  it("rejects the legacy remote operation environment name instead of changing journal identity", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);

    const result = harness.runBackup(["contract"], { REMOTE_OPERATION_KEY: "a".repeat(64) });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("REMOTE_OPERATION_KEY is unsupported");
    expect(readFileSync(harness.rcloneLog, "utf8")).toBe("");
  });
});
