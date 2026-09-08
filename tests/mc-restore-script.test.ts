import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/mc-restore.sh");
const backupAuthScript = path.resolve(process.cwd(), "infra/src/ec2/mc-backup-auth.py");
const hostOperationContract = path.resolve(process.cwd(), "infra/src/ec2/host-operation-contract.json");
const maintenanceBootScript = path.resolve(process.cwd(), "infra/src/ec2/mc-maintenance-boot.py");
const cleanupDirs: string[] = [];
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mc-restore-fixtures-"));
const archiveFixtures = new Map<ArchiveKind, string>();
const manifestFixtures = new Map<string, string>();

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

type ArchiveKind = "success" | "traversal" | "symlink" | "wrong-root";
type ArchiveSizeMode = "normal" | "sub-block";

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

const getArchiveFixture = (kind: ArchiveKind): string => {
  const cached = archiveFixtures.get(kind);
  if (cached) return cached;
  const archivePath = path.join(fixtureRoot, `${kind}.tar.gz`);
  createArchive(archivePath, kind);
  archiveFixtures.set(kind, archivePath);
  return archivePath;
};

interface Harness {
  rootDir: string;
  serverDir: string;
  maintenanceLock: string;
  maintenanceBootHold: string;
  operationLock: string;
  restoreJournal: string;
  systemctlLog: string;
  playerAccessPhases: string;
  restoreFloorState: string;
  restoreFloorCloud: string;
  worldGeneration: string;
  addArchive: (
    name: string,
    kind?: ArchiveKind,
    generation?: number,
    backupId?: string,
    sizeMode?: ArchiveSizeMode
  ) => void;
  run: (reference?: string | string[], extraEnv?: Record<string, string | undefined>) => SpawnSyncReturns<string>;
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
  const playerAccessPhases = path.join(stateDir, "player-access-phases.log");
  const startCount = path.join(stateDir, "start-count");
  const healthCount = path.join(stateDir, "health-count");
  const sleepCount = path.join(stateDir, "sleep-count");
  const keyringFile = path.join(stateDir, "backup-keyring.json");
  const fastAuthDir = path.join(stateDir, "fast-auth");
  const serverIdFile = path.join(stateDir, "backup-server-id");
  const instanceIdFile = path.join(stateDir, "instance-id");
  const restoreFloorState = path.join(stateDir, "restore-floor.json");
  const restoreFloorCloud = path.join(stateDir, "restore-floor-cloud");
  const gatewayActive = path.join(stateDir, "gateway-active");
  const runtimeMasked = path.join(stateDir, "runtime-masked");
  const executorKey = path.join(stateDir, "executor-journal-hmac.key");
  const executorJournal = path.join(stateDir, "executor-effect-journal.json");
  const gatewayJournal = path.join(stateDir, "executor-reconciliations.json");
  const worldGeneration = path.join(stateDir, "world-generation");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(fastAuthDir, { recursive: true });
  writeFileSync(path.join(serverDir, "world.txt"), "original-world\n", "utf8");
  writeFileSync(path.join(serverDir, "paper.jar"), "current-reviewed-paper\n", "utf8");
  mkdirSync(path.join(serverDir, "plugins"));
  writeFileSync(path.join(serverDir, "plugins", "current.jar"), "current-reviewed-plugin\n", "utf8");
  writeFileSync(systemctlLog, "", "utf8");
  writeFileSync(startCount, "0", "utf8");
  writeFileSync(healthCount, "0", "utf8");
  writeFileSync(sleepCount, "0", "utf8");
  writeFileSync(playerAccessPhases, "", "utf8");
  const bootIdFile = path.join(stateDir, "boot-id");
  writeFileSync(bootIdFile, "boot-test-1\n", "utf8");
  writeFileSync(
    keyringFile,
    JSON.stringify({
      schemaVersion: 1,
      currentKeyId: "restore-key",
      keys: [{ keyId: "restore-key", secretBase64: Buffer.alloc(32, 9).toString("base64"), status: "active" }],
    })
  );
  writeFileSync(serverIdFile, "arn:aws:cloudformation:us-west-1:111111111111:stack/Test/stable\n");
  writeFileSync(instanceIdFile, "i-1234567890abcdef0\n");
  writeFileSync(restoreFloorCloud, "UNINITIALIZED\n");
  writeFileSync(gatewayActive, "0\n");
  writeFileSync(runtimeMasked, "0\n");
  writeFileSync(executorKey, Buffer.alloc(32, 9), { mode: 0o400 });
  writeFileSync(gatewayJournal, JSON.stringify({ schemaVersion: 1, entries: [] }));
  writeFileSync(worldGeneration, `${"a".repeat(64)}\n`);

  makeExecutable(
    path.join(binDir, "aws"),
    `#!/usr/bin/env bash
if [[ "$*" == *"backup-auth-keyring"* ]]; then /bin/cat "${keyringFile}"; else /bin/cat "${serverIdFile}"; fi
`
  );
  const fastAuthHelper = path.join(binDir, "mc-backup-auth-fast");
  makeExecutable(
    fastAuthHelper,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${1:-}"
shift || true
case "$command" in
  inspect)
    archive_name=""
    output="tsv"
    while (( $# )); do
      case "$1" in
        --archive-name) archive_name="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    identity="${fastAuthDir}/\${archive_name}.json"
    if [[ "$output" == "json" ]]; then /bin/cat "$identity"; else exit 1; fi
    ;;
  verify) exit 0 ;;
  floor-read)
    state_file=""
    while (( $# )); do
      if [[ "$1" == "--state-file" ]]; then state_file="$2"; shift 2; else shift; fi
    done
    if [[ -f "$state_file" ]]; then /bin/cat "$state_file"; else printf '0\\t\\n'; fi
    ;;
  floor-commit)
    state_file=""; generation=""; backup_id=""
    while (( $# )); do
      case "$1" in
        --state-file) state_file="$2"; shift 2 ;;
        --generation) generation="$2"; shift 2 ;;
        --backup-id) backup_id="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s\\t%s\\n' "$generation" "$backup_id" > "$state_file"
    printf '%s\\t%s\\n' "$generation" "$backup_id"
    ;;
  *) exit 1 ;;
esac
`
  );
  const hostOperationHelper = path.join(binDir, "mc-host-operation");
  makeExecutable(
    hostOperationHelper,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  executor-idle) exit 0 ;;
  service-state)
    case "\${2:-}" in
      capture)
        systemctl is-active --quiet minecraft.service || true
        if [[ "\${RESTORE_TEST_HEALTH_FAIL_ONCE:-0}" == "1" ]]; then printf '0\\n' > "${healthCount}"; fi
        minecraft_active=true
        [[ "\${RESTORE_TEST_MINECRAFT_INACTIVE:-0}" == "1" ]] && minecraft_active=false
        gateway_active=false
        [[ "\${RESTORE_TEST_GATEWAY_ACTIVE:-0}" == "1" ]] && gateway_active=true
         printf '[{"unit":"minecraft-dns.service","active":false,"enablement":"disabled"},{"unit":"minecraft.service","active":%s,"enablement":"disabled"},{"unit":"mc-agent-world-roots.service","active":false,"enablement":"disabled"},{"unit":"mc-agent-executor.socket","active":true,"enablement":"disabled"},{"unit":"mc-agent-executor.service","active":false,"enablement":"disabled"},{"unit":"mc-agent-gateway.service","active":%s,"enablement":"disabled"}]\\n' "$minecraft_active" "$gateway_active"
        ;;
      restore)
         systemctl unmask --runtime minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service
        systemctl stop minecraft-dns.service
        if [[ "\${RESTORE_TEST_MINECRAFT_INACTIVE:-0}" != "1" ]]; then systemctl start minecraft.service; fi
        systemctl start mc-agent-executor.socket
        systemctl stop mc-agent-executor.service
        if [[ "\${RESTORE_TEST_GATEWAY_ACTIVE:-0}" == "1" ]]; then systemctl start mc-agent-gateway.service; else systemctl stop mc-agent-gateway.service; fi
        ;;
      verify) exit 0 ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`
  );

  makeExecutable(path.join(binDir, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  const worldRootsHelper = path.join(binDir, "mc-agent-world-roots");
  makeExecutable(
    worldRootsHelper,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  inspect)
    if [[ "$*" == *"--output roots-json"* ]]; then
      printf '%s\n' '{"persistentWorldRoots":["world","world_nether","world_the_end"],"schemaVersion":1}'
    else
      /bin/cat "${worldGeneration}"
    fi
    ;;
  reconcile)
    printf '%s\n' '${"b".repeat(64)}' > "${worldGeneration}"
    ;;
  activate)
    while (( $# )); do
      if [[ "$1" == "--generation" ]]; then printf '%s\n' "$2" > "${worldGeneration}"; exit 0; fi
      shift
    done
    exit 2
    ;;
  verify) exit 0 ;;
  *) exit 2 ;;
esac
`
  );

  makeExecutable(
    path.join(binDir, "rclone"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  lsjson)
    count_file="${stateDir}/rclone-lsjson-count"
    count=0
    [[ -f "$count_file" ]] && count=$(/bin/cat "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    python3 - "${archiveDir}" <<'PY'
import hashlib, json, os, sys
archive_dir = sys.argv[1]
listing_count = int(open("${stateDir}/rclone-lsjson-count", encoding="ascii").read())
raw = os.environ.get("RCLONE_TEST_LIST")
if raw:
    items = json.loads(raw)
else:
    items = [{"Path": name} for name in os.listdir(archive_dir)]
for item in items:
    name = item.get("Path") or item.get("Name")
    if not isinstance(name, str):
        continue
    item.setdefault("Name", name)
    item.setdefault("ID", ("test-id-swap-" if os.environ.get("RESTORE_TEST_OBJECT_SWAP") == "1" and listing_count >= 2 and name.endswith(".tar.gz") and not name.endswith(".manifest.json") else "test-id-") + name)
    source = os.path.join(archive_dir, name)
    if "Size" not in item and os.path.isfile(source):
        item["Size"] = os.path.getsize(source)
    if "Hashes" not in item and os.path.isfile(source):
        item["Hashes"] = {"MD5": hashlib.md5(open(source, "rb").read()).hexdigest()}
    if os.environ.get("RESTORE_TEST_LIE_SIZE") == "1" and name.endswith(".tar.gz") and not name.endswith(".manifest.json"):
        item["Size"] = 1
    if os.environ.get("RESTORE_TEST_NO_LENGTH") == "1" and name.endswith(".tar.gz") and not name.endswith(".manifest.json"):
        item.pop("Size", None)
    item.setdefault("ModTime", "test-revision-" + name)
print(json.dumps(items))
PY
    ;;
  backend)
    [[ "\${RESTORE_TEST_RCLONE_FAIL:-0}" != "1" ]] || exit 1
    [[ "\${2:-}" == "copyid" ]] || exit 2
    object_id="\${4:-}"
    source_name="\${object_id#test-id-swap-}"
    source_name="\${source_name#test-id-}"
    if [[ "\${RESTORE_TEST_OBJECT_SWAP:-0}" == "1" && "\${source_name}" == *.tar.gz && ! -f "${archiveDir}/\${source_name}" ]]; then
      exit 1
    fi
    if [[ "\${RESTORE_TEST_OVERFLOW_BY_ONE:-0}" == "1" && "\${source_name}" == *.tar.gz && "\${source_name}" != *.manifest.json ]]; then
      python3 - "${archiveDir}/\${source_name}" "\${5}" <<'PY'
import sys
source, destination = sys.argv[1:]
with open(source, "rb") as incoming, open(destination, "wb") as output:
    output.write(incoming.read())
    output.write(b"x")
PY
    elif [[ "\${RESTORE_TEST_HUGE_OBJECT:-0}" == "1" && "\${source_name}" == *.tar.gz && "\${source_name}" != *.manifest.json ]]; then
      python3 - "\${5}" <<'PY'
import sys
with open(sys.argv[1], "wb") as output:
    for _ in range(4096):
        output.write(b"x" * 4096)
PY
    else
      /bin/cp "${archiveDir}/\${source_name}" "\${5}"
    fi
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
  mask)
    printf '1\n' > "${runtimeMasked}"
    ;;
  unmask)
    printf '0\n' > "${runtimeMasked}"
    ;;
  kill)
    printf '1\n' > "${gatewayActive}"
    ;;
  stop)
    if [[ "\${RESTORE_TEST_STOP_FAIL:-0}" == "1" && ! -e "${stateDir}/stop-failed-once" ]]; then
      : > "${stateDir}/stop-failed-once"
      exit 1
    fi
    ;;
  start)
    if [[ "\${RESTORE_TEST_SERVICE_RESTORE_FAIL:-0}" == "1" ]]; then exit 1; fi
    if [[ "$(/bin/cat "${runtimeMasked}")" == "1" && "$*" == *"mc-agent-"* || "$(/bin/cat "${runtimeMasked}")" == "1" && "$*" == *"minecraft.service"* ]]; then
      exit 1
    fi
    if [[ "$*" == *"minecraft.service"* ]]; then
      python3 - "${restoreJournal}" >> "${playerAccessPhases}" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("phase", "invalid"))
except FileNotFoundError:
    print("journal-cleared")
PY
      count=$(/bin/cat "${startCount}")
      count=$((count + 1))
      printf '%s\n' "$count" > "${startCount}"
      if [[ "\${RESTORE_TEST_START_FAIL_ONCE:-0}" == "1" && "$count" == "1" ]]; then
        exit 1
      fi
    fi
    if [[ "$*" == *"mc-agent-gateway.service"* ]]; then printf '0\n' > "${gatewayActive}"; fi
    ;;
  is-active)
    if [[ "$*" == *"mc-agent-gateway.service"* ]]; then
      [[ "\${RESTORE_TEST_GATEWAY_ACTIVE:-0}" == "1" && "$(/bin/cat "${gatewayActive}")" == "0" ]]
      exit
    fi
    if [[ "$*" == *"mc-agent-executor.socket"* ]]; then
      exit 0
    fi
    if [[ "$*" == *"minecraft.service"* && "\${RESTORE_TEST_MINECRAFT_INACTIVE:-0}" == "1" ]]; then exit 3; fi
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
    maintenanceBootHold: path.join(stateDir, "maintenance-boot-hold.json"),
    operationLock,
    restoreJournal,
    systemctlLog,
    playerAccessPhases,
    restoreFloorState,
    restoreFloorCloud,
    worldGeneration,
    addArchive: (
      name,
      kind = "success",
      generation = 1,
      backupId = "c".repeat(32),
      sizeMode: ArchiveSizeMode = "normal"
    ) => {
      const archivePath = path.join(archiveDir, name);
      copyFileSync(getArchiveFixture(kind), archivePath);
      if (sizeMode === "sub-block") {
        const padded = spawnSync(
          "python3",
          [
            "-c",
            `import gzip, os, sys
archive_path = sys.argv[1]
for _ in range(8):
    if os.stat(archive_path).st_size % 512:
        break
    with open(archive_path, "ab") as output:
        output.write(gzip.compress(b""))
`,
            archivePath,
          ],
          { encoding: "utf8" }
        );
        if (padded.status !== 0) throw new Error(`Could not pad test archive: ${padded.stderr}`);
      }
      if (!name.endsWith(".tar.gz")) return;
      const backupName = name.slice(0, -".tar.gz".length);
      const manifestKey = `${kind}\0${name}\0${generation}\0${backupId}`;
      let cachedManifest = manifestFixtures.get(manifestKey);
      if (cachedManifest) {
        copyFileSync(cachedManifest, `${archivePath}.manifest.json`);
      } else {
        const signed = spawnSync(
          "python3",
          [
            backupAuthScript,
            "create",
            "--archive",
            archivePath,
            "--manifest",
            `${archivePath}.manifest.json`,
            "--archive-name",
            name,
            "--backup-name",
            backupName,
            "--backup-id",
            backupId,
            "--created-at",
            "2026-09-04T00:00:00Z",
            "--generation",
            String(generation),
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              MC_BACKUP_INSTANCE_ID_FILE: instanceIdFile,
            },
            encoding: "utf8",
          }
        );
        if (signed.status !== 0) throw new Error(`Could not sign test archive: ${signed.stderr}`);
        cachedManifest = path.join(fixtureRoot, `manifest-${manifestFixtures.size}.json`);
        copyFileSync(`${archivePath}.manifest.json`, cachedManifest);
        manifestFixtures.set(manifestKey, cachedManifest);
      }
      const manifest = JSON.parse(readFileSync(`${archivePath}.manifest.json`, "utf8")) as {
        archive: { name: string; sha256: string; size: number };
        authentication: { keyId: string };
        backup: { createdAt: string; id: string; generation: number; operationKey: string };
        source: { instanceId: string; serverId: string };
      };
      writeFileSync(
        path.join(fastAuthDir, `${name}.json`),
        JSON.stringify({
          archiveName: manifest.archive.name,
          archiveSha256: manifest.archive.sha256,
          archiveSize: manifest.archive.size,
          authenticationKeyId: manifest.authentication.keyId,
          backupId: manifest.backup.id,
          createdAt: manifest.backup.createdAt,
          generation: manifest.backup.generation,
          instanceId: manifest.source.instanceId,
          operationKey: manifest.backup.operationKey,
          serverId: manifest.source.serverId,
        })
      );
    },
    run: (reference = "backup", extraEnv = {}) =>
      spawnSync("bash", [scriptPath, ...(Array.isArray(reference) ? reference : [reference])], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MC_SERVER_DIR: serverDir,
          MC_OPERATION_LOCK: operationLock,
          MC_MAINTENANCE_LOCK: maintenanceLock,
          MC_MAINTENANCE_BOOT_HOLD: path.join(stateDir, "maintenance-boot-hold.json"),
          MC_MAINTENANCE_BOOT_HELPER: maintenanceBootScript,
          MC_HIBERNATE_GUARD: path.join(stateDir, "hibernate.guard"),
          MC_BOOT_ID_FILE: bootIdFile,
          MC_RCLONE_CONFIG_HELPER: "/usr/bin/true",
          MC_BACKUP_AUTH_HELPER: fastAuthHelper,
          MC_BACKUP_INSTANCE_ID_FILE: instanceIdFile,
          MC_PROFILE_INSTALLER: "/usr/bin/true",
          MC_RESTORE_HEALTH_DELAY: "0",
          MC_STATUS_BIN: path.join(binDir, "mcstatus"),
          MC_RESTORE_PROTOCOL_MAX_ATTEMPTS: "1",
          MC_RESTORE_PROTOCOL_POLL_INTERVAL: "0",
          MC_RESTORE_JOURNAL: restoreJournal,
          MC_RESTORE_FLOOR_STATE: restoreFloorState,
          MC_RESTORE_FLOOR_CLOUD_FILE: restoreFloorCloud,
          MC_BACKUP_MIGRATION_LOCK_FILE: path.join(stateDir, "backup-migration.lock"),
          MC_HOST_OPERATION_HELPER: hostOperationHelper,
          MC_HOST_OPERATION_CONTRACT: hostOperationContract,
          MC_EXECUTOR_JOURNAL_CREDENTIAL: executorKey,
          MC_EXECUTOR_JOURNAL: executorJournal,
          MC_GATEWAY_RECONCILIATION_JOURNAL: gatewayJournal,
          MC_RESTORE_STAGING_PARENT: serverParent,
          MC_RESTORE_DEBUG: process.env.MC_RESTORE_DEBUG,
          MC_WORLD_ROOTS_HELPER: worldRootsHelper,
          MC_SETUP_ROOT: rootDir,
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

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("mc-restore.sh", () => {
  const expectNoServiceMutation = (log: string) => {
    expect(log).not.toMatch(/^(?:mask|unmask|start|stop|kill|daemon-reload)(?: |$)/m);
  };

  it("reads the authenticated transfer target from the third transfer-consume field", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain(
      `IFS=$'\\t' read -r TRANSFER_AUTHORIZATION_ID _ TRANSFER_TARGET_INSTANCE_ID _ _ TRANSFER_FLOOR_VERSION <<< "$TRANSFER_IDENTITY"`
    );
  });

  it("fails closed for an orphaned schema-v3 sidecar when the host verifier is unavailable", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    const stateDir = path.join(harness.rootDir, "state");
    rmSync(path.join(stateDir, "executor-reconciliations.json"), { force: true });
    writeFileSync(path.join(stateDir, "executor-effect-journal.json.append.0"), "", { mode: 0o600 });

    const result = harness.run("backup", { MC_HOST_OPERATION_HELPER: path.join(harness.rootDir, "missing-helper") });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/exact pre-restore service state|verifier is unavailable/i);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
  });

  it("stages a stem-named archive, switches successfully, and preserves a caller maintenance lock", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    const maintenanceOwner = "caller-owned";
    writeFileSync(
      harness.maintenanceLock,
      `${JSON.stringify({ owner: maintenanceOwner, schemaVersion: 1 })}\n`,
      "utf8"
    );

    const result = harness.run("backup", { MC_MAINTENANCE_OWNER: maintenanceOwner });

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
    expect(readFileSync(harness.maintenanceLock, "utf8")).toContain(maintenanceOwner);
    expect(existsSync(harness.operationLock)).toBe(true);
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("is-active --quiet minecraft");
    expect(result.stdout).toContain("Staging and verifying the current server profile");
  }, 15_000);

  it("supports latest selection only through a completed authenticated manifest", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("newest.tar.gz");

    const result = harness.run("latest", {
      RCLONE_TEST_LIST: JSON.stringify([
        { Path: "notes.txt", ModTime: "2026-08-31T12:00:00Z" },
        { Path: "older.tar.gz", ModTime: "2026-08-29T12:00:00Z" },
        { Path: "newest.tar.gz", ModTime: "2026-08-31T12:00:00Z" },
        { Path: "newest.tar.gz.manifest.json", ModTime: "2026-08-31T12:00:01Z" },
      ]),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Found latest authenticated generation 1: newest.tar.gz");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
  });

  it("selects latest by authenticated generation rather than mutable Drive ModTime", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("older-clock.tar.gz", "success", 2, "2".repeat(32));
    harness.addArchive("newer-clock.tar.gz", "success", 1, "1".repeat(32));

    const result = harness.run("latest", {
      RCLONE_TEST_LIST: JSON.stringify([
        { Path: "older-clock.tar.gz.manifest.json", ModTime: "2026-01-01T00:00:00Z" },
        { Path: "newer-clock.tar.gz.manifest.json", ModTime: "2099-01-01T00:00:00Z" },
        { Path: "older-clock.tar.gz" },
        { Path: "newer-clock.tar.gz" },
      ]),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Found latest authenticated generation 2: older-clock.tar.gz");
  });

  it("does not select an incomplete archive without its manifest", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("incomplete.gz");

    const result = harness.run("latest", {
      RCLONE_TEST_LIST: JSON.stringify([{ Path: "incomplete.gz", ModTime: "2026-08-31T12:00:00Z" }]),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("No authenticated backup manifests found");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("bounds a chunked no-length object before it can fill staging", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("bounded.tar.gz");

    const result = harness.run("bounded.tar.gz", {
      RESTORE_TEST_HUGE_OBJECT: "1",
      RESTORE_TEST_NO_LENGTH: "1",
    });

    expect(result.status).not.toBe(0);
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
    expect(readdirSync(path.dirname(harness.serverDir)).filter((entry) => entry.startsWith(".mc-restore."))).toEqual(
      []
    );
  });

  it("accepts an exact authenticated archive whose size is below a 512-byte file-size unit", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("sub-block.tar.gz", "success", 1, "b".repeat(32), "sub-block");
    const archivePath = path.join(harness.rootDir, "archives", "sub-block.tar.gz");
    const manifest = JSON.parse(readFileSync(`${archivePath}.manifest.json`, "utf8")) as {
      archive: { size: number };
    };

    expect(statSync(archivePath).size).toBe(manifest.archive.size);
    expect(manifest.archive.size % 512).not.toBe(0);
    const result = harness.run("sub-block.tar.gz");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
  });

  it("accepts an exact authenticated archive at its manifest byte boundary", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("exact-boundary.tar.gz");
    const archivePath = path.join(harness.rootDir, "archives", "exact-boundary.tar.gz");
    const manifest = JSON.parse(readFileSync(`${archivePath}.manifest.json`, "utf8")) as {
      archive: { size: number };
    };

    expect(statSync(archivePath).size).toBe(manifest.archive.size);
    const result = harness.run("exact-boundary.tar.gz");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("rejects a chunked object at authenticated size plus one byte", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("overflow-by-one.tar.gz");

    const result = harness.run("overflow-by-one.tar.gz", {
      RESTORE_TEST_NO_LENGTH: "1",
      RESTORE_TEST_OVERFLOW_BY_ONE: "1",
    });

    expect(result.status).not.toBe(0);
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("rejects a lying remote Content-Length before streaming the archive", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("lying-length.tar.gz");

    const result = harness.run("lying-length.tar.gz", { RESTORE_TEST_LIE_SIZE: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Content-Length");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("preserves the configured free-space reserve before downloading", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("reserve.tar.gz");

    const result = harness.run("reserve.tar.gz", { MC_RESTORE_FREE_RESERVE_BYTES: "9999999999999999" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("filesystem reserve");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("rejects an archive object replacement detected after the immutable download", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("swapped.tar.gz");

    const result = harness.run("swapped.tar.gz", { RESTORE_TEST_OBJECT_SWAP: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("replaced during restore");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("fails closed for unsigned backups unless the operator repeats an exact legacy confirmation", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("legacy.gz");

    const denied = harness.run("legacy.gz");
    expect(denied.status).not.toBe(0);
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));

    const mismatched = harness.run(["--legacy-unsigned", "legacy.gz", "--confirm-legacy-unsigned", "different.gz"]);
    expect(mismatched.status).toBe(2);

    const restored = harness.run(["--legacy-unsigned", "legacy.gz", "--confirm-legacy-unsigned", "legacy.gz"]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("SECURITY_AUDIT");
    expect(readFileSync(path.join(harness.serverDir, "paper.jar"), "utf8")).toBe("current-reviewed-paper\n");
    expect(readFileSync(path.join(harness.serverDir, "plugins", "current.jar"), "utf8")).toBe(
      "current-reviewed-plugin\n"
    );
  });

  it.each([
    ["install", { RESTORE_TEST_INSTALL_FAIL: "1" }],
    ["profile application", { MC_PROFILE_INSTALLER: "/usr/bin/false" }],
  ])("restores and restarts the previous server after a %s failure", (_failure, environment) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", environment);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    const systemctlCalls = readFileSync(harness.systemctlLog, "utf8");
    expect(systemctlCalls).toMatch(/start minecraft/);
    expect(systemctlCalls).toContain("is-active --quiet minecraft");
    expect(existsSync(harness.operationLock)).toBe(true);
  });

  it("does not stop the server when staged ownership cannot be set", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_CHOWN_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
  });

  it("does not install the staged directory when stopping the service fails", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_STOP_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(readFileSync(harness.systemctlLog, "utf8")).toContain("start minecraft.service");
  });

  it.each([
    ["service start", { RESTORE_TEST_START_FAIL_ONCE: "1" }],
    ["protocol health", { RESTORE_TEST_PROTOCOL_FAIL: "1" }],
  ])("never rolls back a committed generation after a %s failure", (_description, environment) => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", environment);

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
    expect(JSON.parse(readFileSync(harness.restoreJournal, "utf8"))).toMatchObject({
      phase: "committed",
      backupGeneration: 1,
    });
    expect(readFileSync(harness.playerAccessPhases, "utf8").trim().split("\n")).toEqual(["committed"]);
  });

  it("masks every activation path until the transaction is committed and the gateway has drained", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_GATEWAY_ACTIVE: "1" });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(harness.systemctlLog, "utf8").trim().split("\n");
    expect(calls).toContain("kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service");
    const mask = calls.findIndex((line) => line.startsWith("mask --runtime "));
    const stop = calls.findIndex((line) =>
      line.startsWith("stop mc-agent-world-roots.service mc-agent-gateway.service")
    );
    const unmask = calls.findIndex((line) => line.startsWith("unmask --runtime "));
    const start = calls.findIndex((line) => line === "start minecraft.service");
    expect(mask).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(mask);
    expect(unmask).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(unmask);
    expect(readFileSync(harness.playerAccessPhases, "utf8")).toBe("committed\n");
  });

  it("prevents executor socket and Minecraft activation attempts during staged profile application", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    const attacker = path.join(harness.rootDir, "activation-attempt.sh");
    makeExecutable(
      attacker,
      `#!/usr/bin/env bash
systemctl start mc-agent-executor.socket && exit 91
systemctl start mc-agent-executor.service && exit 92
systemctl start minecraft.service && exit 93
exit 0
`
    );

    const result = harness.run("backup", { MC_PROFILE_INSTALLER: attacker });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(harness.systemctlLog, "utf8");
    expect(calls).toContain("start mc-agent-executor.socket");
    expect(calls).toContain("start mc-agent-executor.service");
    expect(calls.match(/start minecraft.service/g)).toHaveLength(2);
    expect(readFileSync(harness.playerAccessPhases, "utf8")).toBe("committed\n");
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

  it("finishes retention before committing even when postcommit health checking fails", () => {
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
    expect(readdirSync(serverParent).filter((entry) => entry.startsWith("server.backup-"))).toHaveLength(2);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
  });

  it("rejects an unrelated maintenance owner before service or Drive access", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");
    writeFileSync(harness.maintenanceLock, '{"owner":"other","schemaVersion":1}\n');

    const result = harness.run("backup");

    expect(result.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(result.stdout).toContain("global runtime fence");
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
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
    expect(recovered.stdout, `${recovered.stdout}\n${recovered.stderr}`).toContain(
      "Interrupted restore recovery completed"
    );
  }, 15_000);

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
    "prepared",
    "quiescing",
    "runtime-quiesced",
    "profile-staged",
    "roots-review-recorded",
    "roots-published",
    "moving-previous",
    "previous-moved",
    "installing",
    "installed",
    "retention-planned",
    "retained",
    "commit-pending",
  ])(
    "rolls back a crash at the precommit %s phase",
    (phase) => {
      const harness = createHarness();
      cleanupDirs.push(harness.rootDir);
      harness.addArchive("backup.tar.gz");

      const killed = harness.run("backup", { MC_RESTORE_CRASH_AFTER_PHASE: phase });
      expect(killed.signal).toBe("SIGKILL");

      const recovered = harness.run("backup", { RESTORE_TEST_RCLONE_FAIL: "1" });
      expect(recovered.status).not.toBe(0);
      expect(recovered.stdout).toContain("Interrupted restore recovery completed");
      expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
      expect(existsSync(harness.restoreJournal)).toBe(false);
    },
    15_000
  );

  it("retains rollback evidence and boot inhibition until exact service restoration succeeds", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const failed = harness.run("backup", {
      RESTORE_TEST_INSTALL_FAIL: "1",
      RESTORE_TEST_SERVICE_RESTORE_FAIL: "1",
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(JSON.parse(readFileSync(harness.restoreJournal, "utf8"))).toMatchObject({
      phase: "rollback-restoring-services",
      previousWorldRootGeneration: "a".repeat(64),
      activeWorldRootGeneration: "a".repeat(64),
      previousWorldRoots: {
        schemaVersion: 1,
        persistentWorldRoots: ["world", "world_nether", "world_the_end"],
      },
      activeWorldRoots: {
        schemaVersion: 1,
        persistentWorldRoots: ["world", "world_nether", "world_the_end"],
      },
    });
    expect(existsSync(harness.maintenanceBootHold)).toBe(true);

    const recovered = harness.run("backup", { RESTORE_TEST_RCLONE_FAIL: "1" });
    expect(recovered.status).not.toBe(0);
    expect(recovered.stdout, `${recovered.stdout}\n${recovered.stderr}`).toContain(
      "Interrupted restore recovery completed"
    );
    expect(existsSync(harness.restoreJournal)).toBe(false);
    expect(existsSync(harness.maintenanceBootHold)).toBe(false);
  }, 20_000);

  it("preserves an inactive Minecraft pre-state after a committed restore", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const result = harness.run("backup", { RESTORE_TEST_MINECRAFT_INACTIVE: "1" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(harness.systemctlLog, "utf8")).not.toContain("start minecraft.service");
    expect(readFileSync(harness.playerAccessPhases, "utf8")).toBe("");
  });

  it("recovers a crash at committed without rolling the generation back", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("backup.tar.gz");

    const killed = harness.run("backup", { MC_RESTORE_CRASH_AFTER_PHASE: "committed" });
    expect(killed.signal).toBe("SIGKILL");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");

    const recovered = harness.run("backup", { RESTORE_TEST_RCLONE_FAIL: "1" });
    expect(recovered.status).not.toBe(0);
    expect(recovered.stdout).toContain("Interrupted restore recovery completed");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
    expect(existsSync(harness.restoreJournal)).toBe(false);
    expect(readFileSync(harness.playerAccessPhases, "utf8").trim().split("\n")).toEqual(["committed"]);
  }, 15_000);

  it("rolls back the published root generation with the precommit server after a reboot", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("reboot-roots.tar.gz");

    const killed = harness.run("reboot-roots.tar.gz", { MC_RESTORE_CRASH_AFTER_PHASE: "roots-published" });
    expect(killed.signal).toBe("SIGKILL");
    expect(readFileSync(harness.worldGeneration, "utf8").trim()).toBe("b".repeat(64));

    writeFileSync(path.join(harness.rootDir, "state", "boot-id"), "boot-test-2\n", "utf8");
    const recovered = harness.run("reboot-roots.tar.gz", { RESTORE_TEST_RCLONE_FAIL: "1" });

    expect(recovered.status).not.toBe(0);
    expect(readFileSync(harness.worldGeneration, "utf8").trim()).toBe("a".repeat(64));
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("original-world\n");
    expect(existsSync(harness.restoreJournal)).toBe(false);
  }, 15_000);

  it("rejects an old valid pair reuploaded with a newer mutable Drive time", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    harness.addArchive("accepted.tar.gz", "success", 2, "d".repeat(32));
    expect(harness.run("accepted.tar.gz").status).toBe(0);
    harness.addArchive("reuploaded-old.tar.gz", "success", 1, "e".repeat(32));

    const replay = harness.run("latest", {
      RCLONE_TEST_LIST: JSON.stringify([
        { Path: "reuploaded-old.tar.gz.manifest.json", ModTime: "2099-01-01T00:00:00Z" },
        { Path: "reuploaded-old.tar.gz" },
      ]),
    });

    expect(replay.status).not.toBe(0);
    expect(replay.stdout).toContain("not newer than the accepted restore floor");
    expect(readFileSync(path.join(harness.serverDir, "world.txt"), "utf8")).toBe("restored-world\n");
  }, 15_000);

  it("allows explicit replacement convergence at the exact committed floor without allowing named replay", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const backupId = "c".repeat(32);
    harness.addArchive("converged.tar.gz", "success", 1, backupId);
    const first = harness.run("converged.tar.gz");
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);

    const namedReplay = harness.run("converged.tar.gz");
    expect(namedReplay.status).not.toBe(0);
    const converged = harness.run(
      ["--replacement-convergence", "converged.tar.gz", "--expected-generation", "1", "--expected-backup-id", backupId],
      { RCLONE_TEST_LIST: "[]" }
    );
    expect(converged.status, `${converged.stdout}\n${converged.stderr}`).toBe(0);
    expect(converged.stdout).toContain("already converged");
  }, 15_000);

  it("recovers an exact replacement convergence request with or without a committed journal", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const backupId = "d".repeat(32);
    harness.addArchive("journal-converged.tar.gz", "success", 1, backupId);
    const killed = harness.run("journal-converged.tar.gz", { MC_RESTORE_CRASH_AFTER_PHASE: "committed" });
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(harness.restoreJournal)).toBe(true);

    const converged = harness.run([
      "--replacement-convergence",
      "journal-converged.tar.gz",
      "--expected-generation",
      "1",
      "--expected-backup-id",
      backupId,
    ]);
    expect(converged.status, `${converged.stdout}\n${converged.stderr}`).toBe(0);
    expect(converged.stdout).toContain("already converged");
    expect(existsSync(harness.restoreJournal)).toBe(false);
  }, 15_000);

  it("rejects replacement convergence for a same-generation ID conflict or a floor ahead of the request", () => {
    const harness = createHarness();
    cleanupDirs.push(harness.rootDir);
    const firstId = "e".repeat(32);
    const secondId = "f".repeat(32);
    harness.addArchive("floor-one.tar.gz", "success", 1, firstId);
    expect(harness.run("floor-one.tar.gz").status).toBe(0);

    const sameGenerationConflict = harness.run([
      "--replacement-convergence",
      "floor-one.tar.gz",
      "--expected-generation",
      "1",
      "--expected-backup-id",
      secondId,
    ]);
    expect(sameGenerationConflict.status).not.toBe(0);

    harness.addArchive("floor-two.tar.gz", "success", 2, secondId);
    expect(harness.run("floor-two.tar.gz").status).toBe(0);
    const aheadFloor = harness.run([
      "--replacement-convergence",
      "floor-one.tar.gz",
      "--expected-generation",
      "1",
      "--expected-backup-id",
      firstId,
    ]);
    expect(aheadFloor.status).not.toBe(0);
    expect(aheadFloor.stdout).toContain("behind or conflicts");
  }, 20_000);

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
    expectNoServiceMutation(readFileSync(harness.systemctlLog, "utf8"));
    expect(existsSync(path.join(harness.rootDir, "escaped"))).toBe(false);
  });
});
