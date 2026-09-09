#!/usr/bin/env bash
# Restore Minecraft server from Google Drive
# Usage: mc-restore.sh <latest|backup-archive>
# Replacement convergence: mc-restore.sh --replacement-convergence <backup-archive> --expected-generation <generation> --expected-backup-id <backup-id>
# Legacy: mc-restore.sh --legacy-unsigned <backup-archive> --confirm-legacy-unsigned <same-backup-archive>

set -euo pipefail
umask 077

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

export RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/setup/rclone/rclone.conf}"
RCLONE_CONFIG_HELPER="${MC_RCLONE_CONFIG_HELPER:-/usr/local/bin/mc-rclone-config.sh}"
PROFILE_INSTALLER="${MC_PROFILE_INSTALLER:-/usr/local/bin/mc-profile-install.sh}"
SETUP_ROOT="${MC_SETUP_ROOT:-/opt/setup}"

OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/run/mc-agent/maintenance-state.json}"
HIBERNATE_GUARD="${MC_HIBERNATE_GUARD:-/tmp/mc-hibernate-in-progress}"
BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
MAINTENANCE_BOOT_HOLD="${MC_MAINTENANCE_BOOT_HOLD:-/var/lib/mc-aws/maintenance-boot-hold.json}"
MAINTENANCE_BOOT_HELPER="${MC_MAINTENANCE_BOOT_HELPER:-/usr/local/bin/mc-maintenance-boot.py}"
TEMP_DIR=""
MAINTENANCE_LOCK_OWNED=0
MAINTENANCE_OWNER="${MC_MAINTENANCE_OWNER:-restore-$$-$(python3 -c 'import secrets; print(secrets.token_hex(8))')}"
PRESERVE_TEMP=0
MUTATION_STARTED=0
RESTORE_SUCCEEDED=0
RESTORE_COMMITTED=0
COMMIT_STARTED=0
ROLLBACK_ATTEMPTED=0
FAILURE_CONTEXT="unexpected restore failure"
HAD_PREVIOUS=0
PREVIOUS_LOCATION=""
FAILED_SERVER=""
RETAINED_BACKUP=""
RESTORE_JOURNAL="${MC_RESTORE_JOURNAL:-/var/lib/mc-aws/mc-restore-journal.json}"
MCSTATUS_BIN=""
LEGACY_UNSIGNED=0
REPLACEMENT_CONVERGENCE=0
REPLACEMENT_REQUESTED_GENERATION=""
REPLACEMENT_REQUESTED_BACKUP_ID=""
BACKUP_ID=""
BACKUP_GENERATION="0"
BACKUP_AUTH_KEY_ID=""
TRANSFER_AUTHORIZATION_ID=""
TRANSFER_SOURCE_INSTANCE_ID=""
SERVICES_MASKED=0
BOOT_HOLD_OWNED=0
RETAIN_INHERITED_BOOT_HOLD="${MC_RETAIN_BOOT_HOLD:-0}"
PARENT_MAINTENANCE_OPERATION="${MC_MAINTENANCE_PARENT_OPERATION:-}"
INHERITED_BOOT_HOLD_OPERATION=""
if [[ -n "$PARENT_MAINTENANCE_OPERATION" && "$PARENT_MAINTENANCE_OPERATION" != "host-replacement" ]]; then
  log "ERROR: Restore maintenance parent must be the exact host-replacement operation"
  exit 1
fi
MAINTENANCE_RELEASE_ALLOWED=0
SERVICE_STATES_JSON=""
PREVIOUS_WORLD_ROOT_GENERATION=""
ACTIVE_WORLD_ROOT_GENERATION=""
PREVIOUS_WORLD_ROOTS_JSON="null"
ACTIVE_WORLD_ROOTS_JSON="null"
REVIEWED_WORLD_ROOTS_JSON="null"
PREVIOUS_SERVER_DEVICE=""
PREVIOUS_SERVER_INODE=""
RESTORE_ATTEMPT="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
TRANSACTION_PREPARED=0
RECOVERED_COMMITTED_GENERATION=""
RECOVERED_COMMITTED_BACKUP_ID=""
BACKUP_AUTH_HELPER="${MC_BACKUP_AUTH_HELPER:-/usr/local/bin/mc-backup-auth.py}"
MC_HOST_OPERATION_HELPER="${MC_HOST_OPERATION_HELPER:-/usr/local/bin/mc-host-operation.py}"
EXECUTOR_JOURNAL="${MC_EXECUTOR_JOURNAL:-/var/lib/mc-agent-executor/executor-effect-journal.json}"
GATEWAY_RECONCILIATION_JOURNAL="${MC_GATEWAY_RECONCILIATION_JOURNAL:-/var/lib/mc-agent-gateway/executor-reconciliations.json}"
RESTORE_FLOOR_STATE="${MC_RESTORE_FLOOR_STATE:-/var/lib/mc-aws/restore-generation-floor.json}"
TRANSFER_AUTH_PARAMETER="${MC_BACKUP_TRANSFER_AUTH_PARAMETER:-/minecraft/backup-transfer-authorization}"
AGENT_DRAIN_MAX_ATTEMPTS="${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30}"
AGENT_DRAIN_INTERVAL="${MC_AGENT_DRAIN_INTERVAL:-1}"
RESTORE_ARCHIVE_MAX_BYTES="${MC_RESTORE_ARCHIVE_MAX_BYTES:-549755813888}"
RESTORE_MANIFEST_MAX_BYTES="${MC_RESTORE_MANIFEST_MAX_BYTES:-16384}"
RESTORE_FREE_RESERVE_BYTES="${MC_RESTORE_FREE_RESERVE_BYTES:-67108864}"
RESTORE_DOWNLOAD_TIMEOUT="${MC_RESTORE_DOWNLOAD_TIMEOUT:-900}"
# Unsigned input is deliberately much smaller than authenticated archives and
# is never configurable through the legacy command line override.
LEGACY_ARCHIVE_MAX_BYTES=67108864
WORLD_ROOTS_HELPER="${MC_WORLD_ROOTS_HELPER:-/usr/local/bin/mc-agent-world-roots.py}"
WORKSPACE_DAC_HELPER="${MC_WORKSPACE_DAC_HELPER:-/usr/local/bin/mc-agent-workspace-dac.py}"
QUIESCE_UNITS=(minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service)

reconcile_workspace_dac() {
  [[ -x "$WORKSPACE_DAC_HELPER" ]] || { log "ERROR: Workspace DAC helper is unavailable"; return 1; }
  "$WORKSPACE_DAC_HELPER" reconcile
}

acquire_or_adopt_boot_hold() {
  local existing owner operation
  if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
    existing="$(python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" inspect)" || return 1
    owner="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["owner"])' "$existing")"
    operation="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["operation"])' "$existing")"
    [[ "$owner" == "$MAINTENANCE_OWNER" && "$operation" == "${PARENT_MAINTENANCE_OPERATION:-restore}" ]] || return 1
    INHERITED_BOOT_HOLD_OPERATION="$operation"
  else
    if [[ -n "${RECOVERY_PHASE:-}" && "$RECOVERY_PHASE" != "prepared" ]]; then
      log "ERROR: Durable restore boot hold is missing for a mutated transaction"
      return 1
    fi
    python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
      create --owner "$MAINTENANCE_OWNER" --operation restore --attempt "$RESTORE_ATTEMPT" --phase prepared || return 1
  fi
  BOOT_HOLD_OWNED=1
}

update_boot_hold() {
  (( BOOT_HOLD_OWNED == 1 )) || return 1
  local phase="$1"
  [[ "$INHERITED_BOOT_HOLD_OPERATION" != "host-replacement" ]] || phase="recovery"
  python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
    phase --owner "$MAINTENANCE_OWNER" --phase "$phase"
}

clear_boot_hold() {
  (( BOOT_HOLD_OWNED == 1 )) || return 0
  if [[ "$RETAIN_INHERITED_BOOT_HOLD" == "1" ]]; then
    BOOT_HOLD_OWNED=0
    return 0
  fi
  python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" clear --owner "$MAINTENANCE_OWNER" || return 1
  BOOT_HOLD_OWNED=0
}

cleanup() {
  if [[ "$MAINTENANCE_LOCK_OWNED" == "1" && "$MAINTENANCE_RELEASE_ALLOWED" == "1" ]]; then
    python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" <<'PY' || true
import json, os, sys
from pathlib import Path
path, owner = Path(sys.argv[1]), sys.argv[2]
try:
    value = json.loads(path.read_text(encoding="ascii"))
    if value == {"owner": owner, "schemaVersion": 1}:
        path.unlink()
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
except FileNotFoundError:
    pass
PY
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    if [[ "$PRESERVE_TEMP" == "1" ]]; then
      log "CRITICAL: Preserving restore state for manual recovery: $TEMP_DIR"
    else
      rm -rf -- "$TEMP_DIR"
    fi
  fi
}

handle_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [[ "$MUTATION_STARTED" == "1" && "$RESTORE_COMMITTED" != "1" && "$RESTORE_SUCCEEDED" != "1" && "$ROLLBACK_ATTEMPTED" != "1" ]]; then
    if [[ "$COMMIT_STARTED" == "1" ]]; then
      PRESERVE_TEMP=1
      log "CRITICAL: Restore commit outcome is unresolved; preserving masks and journal for authenticated recovery"
    else
      if type -t recover_previous_state >/dev/null; then
        recover_previous_state "$FAILURE_CONTEXT" || exit_code=1
      else
        PRESERVE_TEMP=1
        MAINTENANCE_LOCK_OWNED=0
        log "CRITICAL: Early recovery failed; retaining durable journal and boot inhibition"
        exit_code=1
      fi
    fi
  fi
  if [[ "$MUTATION_STARTED" == "1" && "$RESTORE_SUCCEEDED" != "1" && ( "$COMMIT_STARTED" == "1" || "$RESTORE_COMMITTED" == "1" ) ]]; then
    MAINTENANCE_LOCK_OWNED=0
  fi
  if [[ "$MUTATION_STARTED" == "0" && "$TRANSACTION_PREPARED" == "1" ]]; then
    if clear_restore_journal && { [[ "$BOOT_HOLD_OWNED" == "0" ]] || clear_boot_hold; }; then
      MAINTENANCE_RELEASE_ALLOWED=1
    else
      exit_code=1
    fi
  fi
  cleanup
  exit "$exit_code"
}

# Hold the same crash-safe advisory lock used by backup and hibernate mode.
if ! command -v flock >/dev/null 2>&1; then
  log "ERROR: flock is required for lifecycle operation serialization"
  exit 1
fi
exec 9>"$OPERATION_LOCK"
if ! flock -n 9; then
  log "ERROR: Another backup, restore, or hibernate operation is in progress"
  exit 1
fi
trap handle_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

CURRENT_BOOT_ID="$(cat "$BOOT_ID_FILE" 2>/dev/null || true)"
if [[ -e "$HIBERNATE_GUARD" ]]; then
  IFS= read -r GUARD_BOOT_ID < "$HIBERNATE_GUARD" || true
  if [[ -z "$CURRENT_BOOT_ID" || "$GUARD_BOOT_ID" != "$CURRENT_BOOT_ID" ]]; then
    log "Removing stale hibernate guard from a previous boot"
    rm -f -- "$HIBERNATE_GUARD"
  fi
fi

if [[ -e "$HIBERNATE_GUARD" ]]; then
  log "ERROR: Hibernate is in progress; refusing to restore server state"
  exit 1
fi

# The root-owned local fence is shared with the gateway. A nested resume may
# retain its exact owner; an unrelated existing marker is a maintenance conflict.
if ! MAINTENANCE_ACQUISITION="$(python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" "$RESTORE_JOURNAL" "${MC_MAINTENANCE_OWNER:-}" "$PARENT_MAINTENANCE_OPERATION" <<'PY'
import json, os, sys
from pathlib import Path

path, owner, journal_path, inherited_owner, parent_operation = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5]
encoded = json.dumps({"schemaVersion": 1, "owner": owner}, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"
try:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
except FileExistsError:
    try:
        value = json.loads(path.read_text(encoding="ascii"))
        simple = set(value) == {"schemaVersion", "owner"}
        reasserted_restore = (
            set(value) == {"schemaVersion", "operation", "owner", "phase"}
            and value.get("operation") == "restore"
            and value.get("phase") == "boot-inhibited"
        )
        inherited_parent = (
            bool(parent_operation)
            and value.get("operation") == parent_operation
            and set(value) == {"schemaVersion", "operation", "owner", "phase", "twoPhase", "mode"}
        )
        if not (simple or reasserted_restore or inherited_parent) or value["schemaVersion"] != 1 or not isinstance(value["owner"], str):
            raise ValueError("invalid maintenance owner")
        existing = value["owner"]
        if inherited_owner:
            if existing != inherited_owner:
                raise ValueError("owned by another maintenance operation")
            print(f"nested\t{existing}")
        else:
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
            if journal.get("version") != 3 or journal.get("maintenanceOwner") != existing:
                raise ValueError("owned by another maintenance operation")
            print(f"recovered\t{existing}")
    except (OSError, ValueError) as error:
        print(f"maintenance fence conflict: {error}", file=sys.stderr)
        raise SystemExit(1)
else:
    with os.fdopen(descriptor, "wb") as output:
        output.write(encoded); output.flush(); os.fsync(output.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
    print(f"created\t{owner}")
PY
)"; then
  log "ERROR: Another maintenance owner holds the global runtime fence"
  exit 1
fi
MAINTENANCE_MODE="${MAINTENANCE_ACQUISITION%%$'\t'*}"
MAINTENANCE_OWNER="${MAINTENANCE_ACQUISITION#*$'\t'}"
if [[ "$MAINTENANCE_MODE" != "nested" ]]; then
  MAINTENANCE_LOCK_OWNED=1
fi

SERVER_DIR="${MC_SERVER_DIR:-/opt/minecraft/server}"
SERVER_PARENT="$(dirname -- "$SERVER_DIR")"
SERVER_OWNER="${MC_SERVER_OWNER:-minecraft:minecraft}"
HEALTH_DELAY="${MC_RESTORE_HEALTH_DELAY:-3}"
MCSTATUS_BIN="${MC_STATUS_BIN:-/usr/local/bin/mcstatus}"
PROTOCOL_MAX_ATTEMPTS="${MC_RESTORE_PROTOCOL_MAX_ATTEMPTS:-12}"
PROTOCOL_POLL_INTERVAL="${MC_RESTORE_PROTOCOL_POLL_INTERVAL:-5}"
BACKUP_RETENTION="${MC_RESTORE_BACKUP_RETENTION:-2}"
STAGING_PARENT="${MC_RESTORE_STAGING_PARENT:-/opt}"
STAGING_PARENT_OVERRIDDEN=0
if [[ -n "${MC_RESTORE_STAGING_PARENT+x}" ]]; then
  STAGING_PARENT_OVERRIDDEN=1
fi

if [[ "$(basename -- "$SERVER_DIR")" != "server" || ! -d "$SERVER_PARENT" ]]; then
  log "ERROR: Server directory must be an existing parent with a server child: $SERVER_DIR"
  exit 1
fi
if [[ ! "$BACKUP_RETENTION" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_RESTORE_BACKUP_RETENTION must be a positive integer"
  exit 1
fi
if [[ "$RETAIN_INHERITED_BOOT_HOLD" != "0" && "$RETAIN_INHERITED_BOOT_HOLD" != "1" ]]; then
  log "ERROR: MC_RETAIN_BOOT_HOLD must be 0 or 1"
  exit 1
fi
if [[ ! "$PROTOCOL_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_RESTORE_PROTOCOL_MAX_ATTEMPTS must be a positive integer"
  exit 1
fi
if [[ ! "$AGENT_DRAIN_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_AGENT_DRAIN_MAX_ATTEMPTS must be a positive integer"
  exit 1
fi
if [[ ! "$RESTORE_ARCHIVE_MAX_BYTES" =~ ^[1-9][0-9]*$ ]] ||
   (( RESTORE_ARCHIVE_MAX_BYTES > 549755813888 )); then
  log "ERROR: MC_RESTORE_ARCHIVE_MAX_BYTES must be a positive value no larger than 512 GiB"
  exit 1
fi
if [[ ! "$RESTORE_MANIFEST_MAX_BYTES" =~ ^[1-9][0-9]*$ ]] || (( RESTORE_MANIFEST_MAX_BYTES > 16384 )); then
  log "ERROR: MC_RESTORE_MANIFEST_MAX_BYTES must be between 1 and 16384 bytes"
  exit 1
fi
if [[ ! "$RESTORE_FREE_RESERVE_BYTES" =~ ^[0-9]+$ ]]; then
  log "ERROR: MC_RESTORE_FREE_RESERVE_BYTES must be a non-negative integer"
  exit 1
fi
if [[ ! "$RESTORE_DOWNLOAD_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_RESTORE_DOWNLOAD_TIMEOUT must be a positive integer"
  exit 1
fi
if [[ ! -d "$(dirname -- "$RESTORE_JOURNAL")" ]]; then
  log "ERROR: Restore journal parent does not exist"
  exit 1
fi
if [[ ! -d "$(dirname -- "$RESTORE_FLOOR_STATE")" ]]; then
  log "ERROR: Restore floor state parent does not exist"
  exit 1
fi

if ! python3 - "$STAGING_PARENT" "$SERVER_PARENT" "$STAGING_PARENT_OVERRIDDEN" <<'PY'
import os
import stat
import sys

staging_parent, server_parent, overridden = sys.argv[1:]
try:
    staging_lstat = os.lstat(staging_parent)
    server_stat = os.stat(server_parent)
except OSError as error:
    print(f"Could not inspect restore filesystem: {error}", file=sys.stderr)
    sys.exit(1)

if not stat.S_ISDIR(staging_lstat.st_mode):
    print("Restore staging parent must be a real directory", file=sys.stderr)
    sys.exit(1)
if overridden != "1" and staging_lstat.st_uid != 0:
    print("Default restore staging parent must be owned by root", file=sys.stderr)
    sys.exit(1)
if staging_lstat.st_dev != server_stat.st_dev:
    print("Restore staging and server paths must be on the same filesystem", file=sys.stderr)
    sys.exit(1)
PY
then
  log "ERROR: Restore staging parent is not safe for atomic installation: $STAGING_PARENT"
  exit 1
fi

write_restore_journal() {
  local phase="$1"
  local retained="${2:-}"
  python3 - "$RESTORE_JOURNAL" "$phase" "$SERVER_DIR" "$TEMP_DIR" "$PREVIOUS_LOCATION" "$FAILED_SERVER" "$HAD_PREVIOUS" "$retained" "$BACKUP_ID" "$BACKUP_GENERATION" "$BACKUP_AUTH_KEY_ID" "$LEGACY_UNSIGNED" "$MAINTENANCE_OWNER" "$TRANSFER_AUTHORIZATION_ID" "$TRANSFER_SOURCE_INSTANCE_ID" "$CURRENT_BOOT_ID" "$RESTORE_ATTEMPT" "$SERVICE_STATES_JSON" "$PREVIOUS_WORLD_ROOT_GENERATION" "$ACTIVE_WORLD_ROOT_GENERATION" "$PREVIOUS_WORLD_ROOTS_JSON" "$ACTIVE_WORLD_ROOTS_JSON" "$REVIEWED_WORLD_ROOTS_JSON" "$PREVIOUS_SERVER_DEVICE" "$PREVIOUS_SERVER_INODE" <<'PY'
import json
import os
import sys

journal, phase, server, temp, previous, failed, had_previous, retained, backup_id, generation, key_id, legacy, maintenance_owner, transfer_id, transfer_source, boot_id, attempt, service_states, previous_roots, active_roots, previous_root_values, active_root_values, reviewed_root_values, server_device, server_inode = sys.argv[1:]
previous_root_values = json.loads(previous_root_values)
active_root_values = json.loads(active_root_values)
reviewed_root_values = json.loads(reviewed_root_values)
if not isinstance(previous_root_values, dict) or not isinstance(active_root_values, dict):
    raise ValueError("restore world-root journal state is incomplete")
if reviewed_root_values is not None and not isinstance(reviewed_root_values, dict):
    raise ValueError("reviewed restore world-root journal state is malformed")
payload = {
    "version": 3,
    "phase": phase,
    "serverDir": server,
    "tempDir": temp,
    "previousLocation": previous,
    "failedServer": failed,
    "hadPrevious": had_previous == "1",
    "retainedBackup": retained or None,
    "backupId": backup_id or None,
    "backupGeneration": int(generation),
    "authenticationKeyId": key_id or None,
    "legacyUnsigned": legacy == "1",
    "maintenanceOwner": maintenance_owner,
    "transferAuthorizationId": transfer_id or None,
    "transferSourceInstanceId": transfer_source or None,
    "bootId": boot_id,
    "attempt": attempt,
    "serviceStates": json.loads(service_states),
    "previousWorldRootGeneration": previous_roots,
    "activeWorldRootGeneration": active_roots or previous_roots,
    "previousWorldRoots": previous_root_values,
    "activeWorldRoots": active_root_values or previous_root_values,
    "reviewedWorldRoots": reviewed_root_values,
    "previousServerIdentity": ({"device": int(server_device), "inode": int(server_inode)} if server_device and server_inode else None),
}
temporary = f"{journal}.new"
with open(temporary, "w", encoding="utf-8") as output:
    json.dump(payload, output, separators=(",", ":"))
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, journal)
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  if [[ "${MC_RESTORE_CRASH_AFTER_PHASE:-}" == "$phase" ]]; then
    kill -KILL "$$"
  fi
}

normalize_world_roots_json() {
  python3 - "$1" <<'PY'
import json, sys
from pathlib import PurePosixPath

value = json.loads(sys.argv[1])
if set(value) != {"schemaVersion", "persistentWorldRoots"} or value["schemaVersion"] != 1:
    raise SystemExit("world-root metadata has an invalid schema")
roots = value["persistentWorldRoots"]
if not isinstance(roots, list) or not 1 <= len(roots) <= 64 or len(set(roots)) != len(roots):
    raise SystemExit("world-root metadata has an invalid allowlist")
for root in roots:
    if not isinstance(root, str) or not root or len(root) > 4096 or "\x00" in root or "\\" in root:
        raise SystemExit("world-root metadata has an invalid allowlist")
    path = PurePosixPath(root)
    if path.is_absolute() or root in (".", "..") or any(part in ("", ".", "..") for part in root.split("/")) or str(path) != root:
        raise SystemExit("world-root metadata has an invalid allowlist")
print(json.dumps({"schemaVersion": 1, "persistentWorldRoots": roots}, separators=(",", ":"), sort_keys=True))
PY
}

clear_restore_journal() {
  python3 - "$RESTORE_JOURNAL" <<'PY'
import os
import sys

journal = sys.argv[1]
try:
    os.unlink(journal)
except FileNotFoundError:
    pass
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

fsync_restore_directories() {
  python3 - "$SERVER_PARENT" "$STAGING_PARENT" "$TEMP_DIR" <<'PY'
import os
import sys

for candidate in dict.fromkeys(sys.argv[1:]):
    if not candidate or not os.path.isdir(candidate):
        continue
    descriptor = os.open(candidate, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

fsync_restored_server_tree() {
  python3 - "$SERVER_DIR" <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
if root.is_symlink() or not root.is_dir():
    raise SystemExit("restored server durability root is unsafe")
directories = []
for current, names, files in os.walk(root, topdown=True, followlinks=False):
    directory = Path(current)
    directories.append(directory)
    for name in names:
        candidate = directory / name
        metadata = candidate.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"restored server directory is unsafe: {candidate}")
    for name in files:
        candidate = directory / name
        metadata = candidate.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise SystemExit(f"restored server file is unsafe: {candidate}")
        descriptor = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
for directory in reversed(directories):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

remote_objects() {
  # The name is used only to locate the object.  Every subsequent read uses
  # the returned Drive object ID, never this mutable path.
  local listing
  if ! listing="$(rclone lsjson "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --files-only --no-mimetype --metadata)"; then
    return 1
  fi
  python3 - "$@" 3<<<"$listing" <<'PY'
import json
import os
import sys

requested = sys.argv[1:]
try:
    items = json.load(os.fdopen(3, encoding="utf-8"))
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit("remote listing is not valid JSON")
if not isinstance(items, list):
    raise SystemExit("remote listing is not an array")

for name in requested:
    matches = []
    for item in items:
        if not isinstance(item, dict):
            continue
        path = item.get("Path")
        item_name = item.get("Name")
        if path == name or item_name == name:
            matches.append(item)
    if len(matches) != 1:
        raise SystemExit(f"remote object {name!r} is missing or ambiguous")
    item = matches[0]
    object_id = item.get("ID")
    if not isinstance(object_id, str) or not object_id or any(char in object_id for char in "\t\r\n"):
        raise SystemExit(f"remote object {name!r} has no immutable object ID")

    size = item.get("Size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        size = ""
    hashes = item.get("Hashes") if isinstance(item.get("Hashes"), dict) else {}
    content_hash = ""
    for key in ("MD5", "md5", "SHA-256", "SHA256", "sha256"):
        candidate = hashes.get(key)
        if isinstance(candidate, str) and candidate and "\t" not in candidate:
            content_hash = candidate.lower()
            break
    metadata = item.get("Metadata") if isinstance(item.get("Metadata"), dict) else {}
    revision = item.get("Version") or item.get("Revision") or item.get("version") or item.get("revision")
    if revision is None:
        revision = metadata.get("version") or metadata.get("revision")
    if revision is None:
        revision = item.get("ModTime")
    if not isinstance(revision, str) or not revision or any(char in revision for char in "\t\r\n"):
        revision = ""
    print("\t".join((name, object_id, str(size), revision, content_hash)))
PY
}

check_restore_free_space() {
  local expected_bytes="$1"
  python3 - "$STAGING_PARENT" "$expected_bytes" "$RESTORE_FREE_RESERVE_BYTES" <<'PY'
import shutil
import sys

root, expected, reserve = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
available = shutil.disk_usage(root).free
required = expected + reserve
if available < required:
    raise SystemExit(f"insufficient free staging space: need {required} bytes, have {available}")
PY
}

download_drive_object() {
  local object_id="$1"
  local expected_bytes="$2"
  local hard_max="$3"
  local destination="$4"
  local content_hash="${5:-}"
  local label="${6:-Drive object}"
  local partial="${destination}.partial"
  local transfer_limit actual_hash actual_size wire reader_pid rclone_status reader_status

  if (( expected_bytes < 0 || expected_bytes > hard_max || expected_bytes > 9223372036854775806 )); then
    log "ERROR: ${label} expected size is outside its configured limit"
    return 1
  fi
  if (( expected_bytes == 0 )); then
    transfer_limit=$((hard_max + 1))
  else
    transfer_limit=$((expected_bytes + 1))
  fi
  if ! check_restore_free_space "$([[ "$expected_bytes" == "0" ]] && printf '%s' "$hard_max" || printf '%s' "$expected_bytes")"; then
    log "ERROR: ${label} cannot be staged without preserving the configured filesystem reserve"
    return 1
  fi

  rm -f -- "$partial" "$destination"
  # copyid writes to the named pipe, so rclone never gets an unbounded regular
  # destination.  The reader writes at most the authenticated byte count plus
  # one probe byte, then exits; there is no RLIMIT_FSIZE rounding or rclone
  # temporary-file overhead to reject a valid exact archive.
  wire="${partial}.pipe"
  mkfifo -- "$wire"
  python3 - "$wire" "$partial" "$expected_bytes" "$hard_max" <<'PY' &
import os
import sys

wire, destination, expected_raw, hard_max = sys.argv[1:]
expected = int(expected_raw)
limit = expected if expected else int(hard_max)
count = 0
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
try:
    descriptor = os.open(destination, flags, 0o600)
    with os.fdopen(descriptor, "wb", buffering=0) as output, open(wire, "rb", buffering=0) as incoming:
        while True:
            remaining = limit - count
            chunk = incoming.read(min(64 * 1024, remaining + 1))
            if not chunk:
                break
            if len(chunk) > remaining:
                output.write(chunk[:remaining])
                count += remaining
                raise ValueError("stream exceeded byte limit")
            output.write(chunk)
            count += len(chunk)
        output.flush()
        os.fsync(output.fileno())
    if count < 1 or (expected and count != expected) or count > int(hard_max):
        raise ValueError("stream byte count does not match its bound")
except (OSError, ValueError) as error:
    try:
        os.unlink(destination)
    except FileNotFoundError:
        pass
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
PY
  reader_pid=$!
  rclone_status=0
  timeout --kill-after=5s "${RESTORE_DOWNLOAD_TIMEOUT}s" rclone backend copyid "${GDRIVE_REMOTE}:" "$object_id" "$wire" \
    --max-transfer "${transfer_limit}b" --cutoff-mode HARD --timeout "${RESTORE_DOWNLOAD_TIMEOUT}s" || rclone_status=$?
  reader_status=0
  if (( rclone_status != 0 )); then
    kill "$reader_pid" 2>/dev/null || true
  fi
  wait "$reader_pid" || reader_status=$?
  rm -f -- "$wire"
  if (( rclone_status != 0 || reader_status != 0 )); then
    rm -f -- "$partial"
    log "ERROR: ${label} download exceeded its authenticated byte bound, timed out, or failed"
    return 1
  fi
  if [[ ! -f "$partial" || -L "$partial" ]]; then
    rm -f -- "$partial"
    log "ERROR: ${label} download did not produce a regular staging file"
    return 1
  fi
  actual_size="$(stat -c '%s' -- "$partial")"
  if { [[ "$expected_bytes" != "0" ]] && [[ "$actual_size" != "$expected_bytes" ]]; } || (( actual_size < 1 || actual_size > hard_max )); then
    rm -f -- "$partial"
    log "ERROR: ${label} Content-Length or streamed byte count does not match the authenticated manifest"
    return 1
  fi
  if [[ -n "$content_hash" ]]; then
    actual_hash="$(md5sum -- "$partial" | cut -d' ' -f1)"
    if [[ "$actual_hash" != "$content_hash" ]]; then
      rm -f -- "$partial"
      log "ERROR: ${label} immutable-object hash changed during download"
      return 1
    fi
  fi
  mv -- "$partial" "$destination"
}

same_remote_object() {
  [[ "$1" == "$2" ]]
}

verify_minecraft_protocol() {
  local attempt
  for ((attempt = 1; attempt <= PROTOCOL_MAX_ATTEMPTS; attempt++)); do
    if systemctl is-active --quiet minecraft && "$MCSTATUS_BIN" localhost status >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt < PROTOCOL_MAX_ATTEMPTS )); then
      sleep "$PROTOCOL_POLL_INTERVAL"
    fi
  done
  return 1
}

drain_and_quiesce_runtime() {
  local attempt
  if systemctl is-active --quiet mc-agent-gateway.service; then
    log "Draining the gateway behind the global maintenance fence..."
    systemctl kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service || {
      log "ERROR: Could not request a graceful gateway drain"
      return 1
    }
    for ((attempt = 1; attempt <= AGENT_DRAIN_MAX_ATTEMPTS; attempt++)); do
      if ! systemctl is-active --quiet mc-agent-gateway.service; then
        break
      fi
      if (( attempt == AGENT_DRAIN_MAX_ATTEMPTS )); then
        log "ERROR: Gateway did not drain before the maintenance deadline"
        return 1
      fi
      sleep "$AGENT_DRAIN_INTERVAL"
    done
  fi
  log "Masking all runtime activation paths before server mutation..."
  SERVICES_MASKED=1
  if ! systemctl mask --runtime "${QUIESCE_UNITS[@]}"; then
    log "ERROR: Failed to mask every runtime activation path"
    return 1
  fi
  if ! systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service; then
    log "ERROR: Failed to stop all gateway, socket, executor, and Minecraft services"
    return 1
  fi
  if [[ -x "$MC_HOST_OPERATION_HELPER" && -f "${MC_HOST_OPERATION_CONTRACT:-/etc/mc-agent/host-operation-contract.json}" ]]; then
    if ! "$MC_HOST_OPERATION_HELPER" executor-idle \
      --journal "$EXECUTOR_JOURNAL" \
      --credential "${MC_EXECUTOR_JOURNAL_CREDENTIAL:-/etc/mc-agent/executor-journal-hmac.key}" \
      --gateway-journal "$GATEWAY_RECONCILIATION_JOURNAL" \
      --handoff-state auto \
      --checkpoint-sequence "${MC_EXECUTOR_JOURNAL_CHECKPOINT:-0}" >/dev/null; then
      log "ERROR: Executor journal is not authoritatively idle after gateway drain"
      return 1
    fi
  elif [[
    -e "$EXECUTOR_JOURNAL" ||
    -e "${EXECUTOR_JOURNAL}.checkpoint.0" ||
    -e "${EXECUTOR_JOURNAL}.checkpoint.1" ||
    -e "${EXECUTOR_JOURNAL}.append.0" ||
    -e "${EXECUTOR_JOURNAL}.append.1" ||
    -e "${EXECUTOR_JOURNAL}.generation-floor" ||
    -e "$GATEWAY_RECONCILIATION_JOURNAL"
  ]]; then
    log "ERROR: Runtime journals exist but the host-operation verifier is unavailable"
    return 1
  fi
}

service_was_active() {
  python3 -c 'import json,sys; states=json.loads(sys.argv[1]); raise SystemExit(0 if next(x for x in states if x["unit"]==sys.argv[2])["active"] else 1)' \
    "$SERVICE_STATES_JSON" "$1"
}

restore_exact_service_states() {
  update_boot_hold "${1:-restoring-services}" || return 1
  "$MC_HOST_OPERATION_HELPER" service-state restore --state-json "$SERVICE_STATES_JSON" || return 1
  SERVICES_MASKED=0
  if service_was_active minecraft.service; then
    sleep "$HEALTH_DELAY" || return 1
    verify_minecraft_protocol || return 1
  fi
}

start_committed_services() {
  log "Restoring the exact pre-transaction service state for the committed generation..."
  restore_exact_service_states
}

secure_committed_failure() {
  SERVICES_MASKED=1
  systemctl mask --runtime "${QUIESCE_UNITS[@]}" || true
  systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || true
}

cleanup_recovered_staging() {
  python3 - "$RESTORE_JOURNAL" "$STAGING_PARENT" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

journal_path, staging_parent = map(Path, sys.argv[1:])
journal = json.loads(journal_path.read_text(encoding="utf-8"))
temp = Path(journal.get("tempDir", ""))
if journal.get("version") != 3 or journal.get("phase") not in ("rolled-back-terminal", "committed-terminal") or temp.parent != staging_parent:
    raise ValueError("recovered journal staging identity is invalid")
if temp.exists():
    shutil.rmtree(temp)
descriptor = os.open(staging_parent, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

recover_interrupted_swap() {
  [[ -f "$RESTORE_JOURNAL" ]] || return 0
  log "Recovering interrupted restore directory swap"
  MUTATION_STARTED=1
  local journal_json journal_field floor_identity floor_generation floor_backup_id recovery_result journal_boot_id
  journal_json="$(python3 - "$RESTORE_JOURNAL" <<'PY'
import json, os, stat, sys
path=sys.argv[1]
metadata=os.lstat(path)
if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_mode & 0o077:
    raise SystemExit("restore journal metadata is unsafe")
value=json.load(open(path, encoding="utf-8"))
required={"version","phase","serverDir","tempDir","previousLocation","failedServer","hadPrevious","retainedBackup","backupId","backupGeneration","authenticationKeyId","legacyUnsigned","maintenanceOwner","transferAuthorizationId","transferSourceInstanceId","bootId","attempt","serviceStates","previousWorldRootGeneration","activeWorldRootGeneration","previousWorldRoots","activeWorldRoots","reviewedWorldRoots","previousServerIdentity"}
if set(value) != required or value.get("version") != 3:
    raise SystemExit("restore journal schema is invalid")
print(json.dumps(value,separators=(",",":"),sort_keys=True))
PY
)" || { log "CRITICAL: Restore journal is invalid"; exit 1; }
  journal_field() { python3 -c 'import json,sys; value=json.loads(sys.argv[1])[sys.argv[2]]; print(json.dumps(value,separators=(",",":"),sort_keys=True) if isinstance(value,(dict,list)) else ("" if value is None else value))' "$journal_json" "$1"; }
  RECOVERY_PHASE="$(journal_field phase)"
  MAINTENANCE_OWNER="$(journal_field maintenanceOwner)"
  RESTORE_ATTEMPT="$(journal_field attempt)"
  SERVICE_STATES_JSON="$(journal_field serviceStates)"
  PREVIOUS_WORLD_ROOT_GENERATION="$(journal_field previousWorldRootGeneration)"
  ACTIVE_WORLD_ROOT_GENERATION="$(journal_field activeWorldRootGeneration)"
  PREVIOUS_WORLD_ROOTS_JSON="$(journal_field previousWorldRoots)"
  ACTIVE_WORLD_ROOTS_JSON="$(journal_field activeWorldRoots)"
  REVIEWED_WORLD_ROOTS_JSON="$(journal_field reviewedWorldRoots)"
  [[ -n "$REVIEWED_WORLD_ROOTS_JSON" ]] || REVIEWED_WORLD_ROOTS_JSON="null"
  TEMP_DIR="$(journal_field tempDir)"
  PREVIOUS_LOCATION="$(journal_field previousLocation)"
  FAILED_SERVER="$(journal_field failedServer)"
  RETAINED_BACKUP="$(journal_field retainedBackup)"
  BACKUP_ID="$(journal_field backupId)"
  BACKUP_GENERATION="$(journal_field backupGeneration)"
  BACKUP_AUTH_KEY_ID="$(journal_field authenticationKeyId)"
  TRANSFER_AUTHORIZATION_ID="$(journal_field transferAuthorizationId)"
  TRANSFER_SOURCE_INSTANCE_ID="$(journal_field transferSourceInstanceId)"
  [[ "$(journal_field legacyUnsigned)" == "True" ]] && LEGACY_UNSIGNED=1 || LEGACY_UNSIGNED=0
  [[ "$(journal_field hadPrevious)" == "True" ]] && HAD_PREVIOUS=1 || HAD_PREVIOUS=0
  PREVIOUS_SERVER_DEVICE="$(python3 -c 'import json,sys; value=json.loads(sys.argv[1])["previousServerIdentity"]; print("" if value is None else value["device"])' "$journal_json")"
  PREVIOUS_SERVER_INODE="$(python3 -c 'import json,sys; value=json.loads(sys.argv[1])["previousServerIdentity"]; print("" if value is None else value["inode"])' "$journal_json")"
  journal_boot_id="$(journal_field bootId)"
  if [[ -z "$journal_boot_id" ]]; then log "CRITICAL: Restore journal has no boot epoch"; exit 1; fi
  if [[ "$RECOVERY_PHASE" == "committed-terminal" || "$RECOVERY_PHASE" == "rolled-back-terminal" ]]; then
    if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
      acquire_or_adopt_boot_hold || exit 1
      if [[ "$RECOVERY_PHASE" == "committed-terminal" ]]; then
        start_committed_services || { log "CRITICAL: Committed terminal services could not be recovered"; exit 1; }
      else
        restore_exact_service_states rollback-restoring-services || {
          log "CRITICAL: Rolled-back terminal services could not be recovered"
          exit 1
        }
      fi
    fi
    if [[ "$("$WORLD_ROOTS_HELPER" inspect)" != "$ACTIVE_WORLD_ROOT_GENERATION" ]] ||
       [[ "$(normalize_world_roots_json "$($WORLD_ROOTS_HELPER inspect --output roots-json)")" != "$ACTIVE_WORLD_ROOTS_JSON" ]] ||
       ! "$MC_HOST_OPERATION_HELPER" service-state verify --state-json "$SERVICE_STATES_JSON" ||
       { service_was_active minecraft.service && ! verify_minecraft_protocol; }; then
      log "CRITICAL: Terminal restore evidence does not match the active world/service state"
      exit 1
    fi
    if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
      clear_boot_hold || exit 1
    fi
    if [[ "$RECOVERY_PHASE" == "committed-terminal" ]]; then
      RECOVERED_COMMITTED_GENERATION="$BACKUP_GENERATION"
      RECOVERED_COMMITTED_BACKUP_ID="$BACKUP_ID"
    fi
    cleanup_recovered_staging || exit 1
    clear_restore_journal
    MAINTENANCE_RELEASE_ALLOWED=1
    RESTORE_SUCCEEDED=1
    log "Interrupted terminal restore cleanup completed"
    return 0
  fi
  verify_recorded_world_root_state() {
    local observed_generation observed_roots expected_generation expected_roots
    case "$RECOVERY_PHASE" in
      roots-published|moving-previous|previous-moved|installing|installed|retention-planned|retained|commit-pending|committed|restoring-services|rollback-files-restored|rollback-roots-restored|rollback-restoring-services)
        expected_generation="$ACTIVE_WORLD_ROOT_GENERATION"
        expected_roots="$ACTIVE_WORLD_ROOTS_JSON"
        ;;
      rollback-started)
        observed_generation="$($WORLD_ROOTS_HELPER inspect)" || return 1
        observed_roots="$(normalize_world_roots_json "$($WORLD_ROOTS_HELPER inspect --output roots-json)")" || return 1
        [[ "$observed_generation" == "$ACTIVE_WORLD_ROOT_GENERATION" && "$observed_roots" == "$ACTIVE_WORLD_ROOTS_JSON" ]] ||
          [[ "$observed_generation" == "$PREVIOUS_WORLD_ROOT_GENERATION" && "$observed_roots" == "$PREVIOUS_WORLD_ROOTS_JSON" ]]
        return
        ;;
      roots-review-recorded)
        local recovery_staged_server="${TEMP_DIR}/extract/server"
        local recovery_roots_file="${recovery_staged_server}/.mc-aws-world-roots.json"
        local recovery_world_root_arguments=(
          reconcile
          --gateway-template "$SETUP_ROOT/runtime/mc-agent-gateway.json"
          --executor-template "$SETUP_ROOT/runtime/mc-agent-executor.json"
          --server-properties "$recovery_staged_server/server.properties"
        )
        if [[ -f "$recovery_roots_file" && ! -L "$recovery_roots_file" ]]; then
          recovery_world_root_arguments+=(--restored-roots-file "$recovery_roots_file")
        fi
        if [[ "$HAD_PREVIOUS" == "1" && -f "$SERVER_DIR/server.properties" ]]; then
          recovery_world_root_arguments+=(--previous-server-properties "$SERVER_DIR/server.properties")
        fi
        "$WORLD_ROOTS_HELPER" "${recovery_world_root_arguments[@]}" || return 1
        observed_generation="$($WORLD_ROOTS_HELPER inspect)" || return 1
        observed_roots="$(normalize_world_roots_json "$($WORLD_ROOTS_HELPER inspect --output roots-json)")" || return 1
        ACTIVE_WORLD_ROOT_GENERATION="$observed_generation"
        ACTIVE_WORLD_ROOTS_JSON="$observed_roots"
        write_restore_journal "roots-published"
        RECOVERY_PHASE="roots-published"
        return 0
        ;;
      *)
        expected_generation="$PREVIOUS_WORLD_ROOT_GENERATION"
        expected_roots="$PREVIOUS_WORLD_ROOTS_JSON"
        ;;
    esac
    observed_generation="$($WORLD_ROOTS_HELPER inspect)" || return 1
    observed_roots="$(normalize_world_roots_json "$($WORLD_ROOTS_HELPER inspect --output roots-json)")" || return 1
    [[ "$observed_generation" == "$expected_generation" && "$observed_roots" == "$expected_roots" ]]
  }
  # The pair is checked again after the recovery rename, while the recovery
  # journal still owns the maintenance hold.
  acquire_or_adopt_boot_hold || { log "CRITICAL: Durable restore hold could not be adopted"; exit 1; }
  if ! verify_recorded_world_root_state; then
    log "CRITICAL: Restore journal world-root generation is stale or does not match the active publication"
    exit 1
  fi
  if ! floor_identity="$("$BACKUP_AUTH_HELPER" floor-read --state-file "$RESTORE_FLOOR_STATE")"; then
    log "CRITICAL: Authenticated restore floor is unavailable during recovery"
    exit 1
  fi
  floor_generation="${floor_identity%%$'\t'*}"
  floor_backup_id="${floor_identity#*$'\t'}"
  SERVICES_MASKED=1
  if ! drain_and_quiesce_runtime; then
    log "CRITICAL: Could not quiesce the runtime for interrupted restore recovery"
    exit 1
  fi
  if ! recovery_result="$(python3 - "$RESTORE_JOURNAL" "$SERVER_DIR" "$SERVER_PARENT" "$STAGING_PARENT" "$floor_generation" "$floor_backup_id" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

journal_path, expected_server, expected_parent, staging_parent = map(Path, sys.argv[1:5])
floor_generation, floor_backup_id = int(sys.argv[5]), sys.argv[6]
try:
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    if journal.get("version") != 3 or Path(journal.get("serverDir", "")) != expected_server:
        raise ValueError("journal identity does not match the configured server")
    temp = Path(journal.get("tempDir", ""))
    previous = Path(journal.get("previousLocation", ""))
    retained_raw = journal.get("retainedBackup")
    retained = Path(retained_raw) if retained_raw else None
    if temp.parent != staging_parent or (previous.parent != temp and previous != retained):
        raise ValueError("journal paths are outside the restore filesystem")
    if retained is not None and retained.parent != expected_parent:
        raise ValueError("journal retained backup is outside the server parent")
    had_previous = journal.get("hadPrevious") is True
    generation = journal.get("backupGeneration")
    backup_id = journal.get("backupId")
    authenticated_commit = (
        journal.get("legacyUnsigned") is False
        and isinstance(generation, int)
        and generation > 0
        and generation == floor_generation
        and backup_id == floor_backup_id
    )
    legacy_commit = journal.get("legacyUnsigned") is True and journal.get("phase") == "committed"
    committed = authenticated_commit or legacy_commit
    if committed:
        if not expected_server.is_dir() or expected_server.is_symlink():
            raise ValueError("committed server generation is missing")
        journal["phase"] = "committed"
        outcome = "committed"
    else:
        rollback = previous if previous.exists() else retained if retained is not None and retained.exists() else None
        if had_previous and rollback is not None:
            if expected_server.exists() or expected_server.is_symlink():
                failed = temp / "crash-failed-server"
                if failed.exists() or failed.is_symlink():
                    shutil.rmtree(failed) if failed.is_dir() and not failed.is_symlink() else failed.unlink()
                os.rename(expected_server, failed)
            os.rename(rollback, expected_server)
        elif had_previous and not (expected_server.exists() or expected_server.is_symlink()):
            raise ValueError("both the active and previous server directories are missing")
        elif not had_previous and journal.get("phase") not in ("prepared", "runtime-quiesced"):
            if expected_server.exists() or expected_server.is_symlink():
                failed = temp / "crash-failed-server"
                os.rename(expected_server, failed)
        identity = journal.get("previousServerIdentity")
        if had_previous:
            actual = expected_server.stat()
            if not isinstance(identity, dict) or identity != {"device": actual.st_dev, "inode": actual.st_ino}:
                raise ValueError("rolled-back server identity does not match exact pre-state")
        # Do not claim the rollback checkpoint until the world-root symlink
        # has also been reactivated by the shell transaction below.
        journal["phase"] = "rollback-pair-pending"
        outcome = "rollback" if expected_server.exists() else "none"
    for directory_path in {expected_parent, staging_parent, temp}:
        if directory_path.is_dir():
            descriptor = os.open(directory_path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    temporary = journal_path.with_name(journal_path.name + ".new")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(journal, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, journal_path)
    print(outcome)
except (OSError, ValueError, json.JSONDecodeError, TypeError) as error:
    print(f"Interrupted restore recovery failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
)"; then
    log "CRITICAL: Interrupted restore journal could not be recovered"
    exit 1
  fi
  if [[ "$recovery_result" == "committed" ]]; then
    RESTORE_COMMITTED=1
    MUTATION_STARTED=1
    RECOVERED_COMMITTED_GENERATION="$BACKUP_GENERATION"
    RECOVERED_COMMITTED_BACKUP_ID="$BACKUP_ID"
    if ! start_committed_services; then
      secure_committed_failure
      log "CRITICAL: Committed restored generation did not become protocol-ready"
      exit 1
    fi
    write_restore_journal "committed-terminal" "$PREVIOUS_LOCATION"
  else
    if ! "$WORLD_ROOTS_HELPER" activate --generation "$PREVIOUS_WORLD_ROOT_GENERATION"; then
      log "CRITICAL: Previous world-root generation could not be restored"
      exit 1
    fi
    ACTIVE_WORLD_ROOT_GENERATION="$PREVIOUS_WORLD_ROOT_GENERATION"
    ACTIVE_WORLD_ROOTS_JSON="$PREVIOUS_WORLD_ROOTS_JSON"
    if [[ "$($WORLD_ROOTS_HELPER inspect)" != "$PREVIOUS_WORLD_ROOT_GENERATION" ]] ||
       [[ "$(normalize_world_roots_json "$($WORLD_ROOTS_HELPER inspect --output roots-json)")" != "$PREVIOUS_WORLD_ROOTS_JSON" ]]; then
      log "CRITICAL: Recovered world-root generation does not match the exact pre-restore record"
      exit 1
    fi
    write_restore_journal "rollback-files-restored" "$RETAINED_BACKUP"
    update_boot_hold rollback-files-restored || exit 1
    write_restore_journal "rollback-roots-restored" "$RETAINED_BACKUP"
    update_boot_hold rollback-restoring-services || exit 1
    if ! restore_exact_service_states rollback-restoring-services; then
      log "CRITICAL: Exact pre-restore service state could not be recovered"
      exit 1
    fi
    write_restore_journal "rolled-back-terminal" "$RETAINED_BACKUP"
  fi
  if ! cleanup_recovered_staging; then
    log "CRITICAL: Recovered restore staging tree could not be cleaned"
    exit 1
  fi
  clear_boot_hold || exit 1
  clear_restore_journal
  MAINTENANCE_RELEASE_ALLOWED=1
  RESTORE_SUCCEEDED=1
  log "Interrupted restore recovery completed"
}

recover_interrupted_swap
if (( $# == 6 )) && [[ "${1:-}" == "--replacement-convergence" &&
      ( "${3:-}" == "--expected-generation" || "${3:-}" == "--generation" ) &&
      ( "${5:-}" == "--expected-backup-id" || "${5:-}" == "--backup-id" ) &&
      "${2:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$ &&
      "${4:-}" == "$RECOVERED_COMMITTED_GENERATION" &&
      "${6:-}" == "$RECOVERED_COMMITTED_BACKUP_ID" && -n "$RECOVERED_COMMITTED_GENERATION" ]]; then
  log "SUCCESS: Replacement restore already converged by forward recovery at authenticated generation ${RECOVERED_COMMITTED_GENERATION}"
  exit 0
fi
RESTORE_COMMITTED=0
COMMIT_STARTED=0
MUTATION_STARTED=0
RESTORE_SUCCEEDED=0
MAINTENANCE_RELEASE_ALLOWED=0
TRANSACTION_PREPARED=0
RECOVERY_PHASE=""
RESTORE_ATTEMPT="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"

if [[ -z "$CURRENT_BOOT_ID" ]]; then
  log "ERROR: Current boot identity is unavailable"
  exit 1
fi
TEMP_DIR="${STAGING_PARENT}/.mc-restore-${RESTORE_ATTEMPT}"
DOWNLOAD_DIR="${TEMP_DIR}/download"
EXTRACT_DIR="${TEMP_DIR}/extract"
MANIFEST_SCAN_DIR="${TEMP_DIR}/manifest-scan"
STAGED_SERVER="${EXTRACT_DIR}/server"
FAILED_SERVER="${TEMP_DIR}/failed-server"
PREVIOUS_LOCATION="${TEMP_DIR}/previous-server"
if [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
  HAD_PREVIOUS=1
  read -r PREVIOUS_SERVER_DEVICE PREVIOUS_SERVER_INODE < <(stat -Lc '%d %i' -- "$SERVER_DIR") || {
    log "ERROR: Could not capture the exact current server identity"
    exit 1
  }
fi
if ! SERVICE_STATES_JSON="$("$MC_HOST_OPERATION_HELPER" service-state capture)"; then
  log "ERROR: Could not capture exact pre-restore service state"
  exit 1
fi
if ! PREVIOUS_WORLD_ROOT_GENERATION="$("$WORLD_ROOTS_HELPER" inspect)" || [[ ! "$PREVIOUS_WORLD_ROOT_GENERATION" =~ ^[a-f0-9]{64}$ ]]; then
  log "ERROR: Could not capture the exact pre-restore world-root generation"
  exit 1
fi
if ! PREVIOUS_WORLD_ROOTS_JSON="$(normalize_world_roots_json "$("$WORLD_ROOTS_HELPER" inspect --output roots-json)")"; then
  log "ERROR: Could not capture the exact pre-restore canonical world roots"
  exit 1
fi
ACTIVE_WORLD_ROOT_GENERATION="$PREVIOUS_WORLD_ROOT_GENERATION"
ACTIVE_WORLD_ROOTS_JSON="$PREVIOUS_WORLD_ROOTS_JSON"
write_restore_journal prepared
TRANSACTION_PREPARED=1
if ! acquire_or_adopt_boot_hold; then
  log "ERROR: Could not establish durable restore boot inhibition"
  exit 1
fi

# Recover local state before reading or materializing any Drive configuration.
GDRIVE_REMOTE_FILE="${MC_RCLONE_REMOTE_FILE:-/etc/minecraft/gdrive-remote}"
if [[ -z "${GDRIVE_REMOTE:-}" && -r "$GDRIVE_REMOTE_FILE" ]]; then
  IFS= read -r GDRIVE_REMOTE < "$GDRIVE_REMOTE_FILE" || true
fi
GDRIVE_ROOT_FILE="${MC_RCLONE_ROOT_FILE:-/etc/minecraft/gdrive-root}"
if [[ -z "${GDRIVE_ROOT:-}" && -r "$GDRIVE_ROOT_FILE" ]]; then
  IFS= read -r GDRIVE_ROOT < "$GDRIVE_ROOT_FILE" || true
fi
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
if ! "$RCLONE_CONFIG_HELPER"; then
  log "ERROR: Failed to materialize Google Drive configuration"
  exit 1
fi

if [[ "${1:-}" == "--legacy-unsigned" ]]; then
  if (( $# != 4 )) || [[ "${3:-}" != "--confirm-legacy-unsigned" ]] || [[ -z "${2:-}" ]] || [[ "${2:-}" != "${4:-}" ]]; then
    log "ERROR: Legacy unsigned restore requires the exact backup name twice using separate confirmation flags"
    exit 2
  fi
  LEGACY_UNSIGNED=1
  BACKUP_REF="$2"
  if [[ "$BACKUP_REF" == "latest" ]]; then
    log "ERROR: Legacy unsigned override never permits latest selection"
    exit 2
  fi
  log "SECURITY_AUDIT: operator explicitly confirmed legacy unsigned restore for exact named archive ${BACKUP_REF}"
elif [[ "${1:-}" == "--replacement-convergence" ]]; then
  if (( $# != 6 )) || [[ "${3:-}" != "--expected-generation" && "${3:-}" != "--generation" ]] ||
     [[ "${5:-}" != "--expected-backup-id" && "${5:-}" != "--backup-id" ]] ||
     [[ -z "${2:-}" ]] || [[ -z "${4:-}" ]] || [[ -z "${6:-}" ]]; then
    log "ERROR: Replacement convergence requires <backup-archive> --expected-generation <generation> --expected-backup-id <id>"
    exit 2
  fi
  REPLACEMENT_CONVERGENCE=1
  BACKUP_REF="$2"
  REPLACEMENT_REQUESTED_GENERATION="$4"
  REPLACEMENT_REQUESTED_BACKUP_ID="$6"
  if [[ ! "$REPLACEMENT_REQUESTED_GENERATION" =~ ^[1-9][0-9]*$ ]] ||
     [[ ! "$REPLACEMENT_REQUESTED_BACKUP_ID" =~ ^[a-f0-9]{32}$ ]]; then
    log "ERROR: Replacement convergence requires a positive generation and exact backup ID"
    exit 2
  fi
  if [[ "$BACKUP_REF" == "latest" ]]; then
    log "ERROR: Replacement convergence requires the exact named backup archive"
    exit 2
  fi
  if [[ ! "$BACKUP_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$ ]]; then
    log "ERROR: Replacement convergence requires a canonical .tar.gz archive name"
    exit 2
  fi
  log "Replacement convergence requested for ${BACKUP_REF}, generation ${REPLACEMENT_REQUESTED_GENERATION}, backup ${REPLACEMENT_REQUESTED_BACKUP_ID}"
elif (( $# > 1 )); then
  log "ERROR: Usage: mc-restore.sh <latest|backup-archive>"
  exit 2
else
  BACKUP_REF="${1:-latest}"
fi

RESTORE_FLOOR_GENERATION=0
RESTORE_FLOOR_BACKUP_ID=""
if [[ "$LEGACY_UNSIGNED" == "0" ]]; then
  if ! FLOOR_IDENTITY="$("$BACKUP_AUTH_HELPER" floor-read --state-file "$RESTORE_FLOOR_STATE")"; then
    log "ERROR: Authenticated restore floor is unavailable"
    exit 1
  fi
  RESTORE_FLOOR_GENERATION="${FLOOR_IDENTITY%%$'\t'*}"
  RESTORE_FLOOR_BACKUP_ID="${FLOOR_IDENTITY#*$'\t'}"
  if [[ "$REPLACEMENT_CONVERGENCE" == "1" ]]; then
    if [[ "$RESTORE_FLOOR_GENERATION" -gt "$REPLACEMENT_REQUESTED_GENERATION" ]] ||
       { [[ "$RESTORE_FLOOR_GENERATION" -eq "$REPLACEMENT_REQUESTED_GENERATION" ]] && [[ "$RESTORE_FLOOR_BACKUP_ID" != "$REPLACEMENT_REQUESTED_BACKUP_ID" ]]; }; then
      log "ERROR: Replacement convergence request is behind or conflicts with the authenticated restore floor"
      exit 1
    fi
    if [[ "$RESTORE_FLOOR_GENERATION" -eq "$REPLACEMENT_REQUESTED_GENERATION" ]] &&
       [[ "$RESTORE_FLOOR_BACKUP_ID" == "$REPLACEMENT_REQUESTED_BACKUP_ID" ]]; then
      log "SUCCESS: Replacement restore already converged at authenticated generation ${RESTORE_FLOOR_GENERATION}"
      exit 0
    fi
  fi
fi

# Remote metadata is captured before any archive bytes are written.  All
# staging remains on the filesystem used by the eventual atomic directory
# swap, and is removed by the EXIT trap on every failed download.
if ! mkdir -- "$TEMP_DIR"; then
  log "ERROR: Restore attempt staging identity already exists"
  exit 1
fi
mkdir -- "$DOWNLOAD_DIR" "$EXTRACT_DIR" "$MANIFEST_SCAN_DIR"
SELECTED_MANIFEST_ROW=""
SELECTED_MANIFEST_PATH=""

if [[ "$BACKUP_REF" == "latest" ]]; then
  log "Latest backup requested, selecting by authenticated monotonic generation..."
  if ! BACKUP_LIST="$(rclone lsjson "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --files-only --no-mimetype --metadata)"; then
    log "ERROR: Failed to list backups in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi

  if ! MANIFEST_NAMES="$(printf '%s' "$BACKUP_LIST" | python3 -c '
import json
import re
import sys

items = json.load(sys.stdin)
candidates = []
for item in items if isinstance(items, list) else []:
    name = item.get("Path") or item.get("Name")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz\.manifest\.json", name):
        continue
    candidates.append(name)
if not candidates or len(candidates) > 1000 or len(set(candidates)) != len(candidates):
    raise SystemExit(1)
print("\n".join(sorted(candidates)))
')"; then
    log "ERROR: No authenticated backup manifests found in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi
  if ! MANIFEST_ROWS="$(remote_objects $(printf '%s\n' "$MANIFEST_NAMES"))"; then
    log "ERROR: Latest candidates did not provide immutable Drive object IDs"
    exit 1
  fi
  CANDIDATE_IDENTITIES="${TEMP_DIR}/candidate-identities.tsv"
  : > "$CANDIDATE_IDENTITIES"
  while IFS=$'\t' read -r candidate_manifest manifest_id manifest_size manifest_revision manifest_hash; do
    [[ -n "$candidate_manifest" ]] || continue
    candidate_archive="${candidate_manifest%.manifest.json}"
    candidate_size="${manifest_size:-$RESTORE_MANIFEST_MAX_BYTES}"
    if (( candidate_size < 1 || candidate_size > RESTORE_MANIFEST_MAX_BYTES )); then
      log "ERROR: Candidate manifest exceeds the manifest hard maximum"
      exit 1
    fi
    candidate_path="${MANIFEST_SCAN_DIR}/${candidate_manifest}"
    if ! download_drive_object "$manifest_id" "$candidate_size" "$RESTORE_MANIFEST_MAX_BYTES" \
        "$candidate_path" "$manifest_hash" "authenticated manifest"; then
      log "ERROR: Could not download every candidate manifest for authenticated latest selection"
      exit 1
    fi
    if ! candidate_identity_json="$("$BACKUP_AUTH_HELPER" inspect \
        --manifest "$candidate_path" --archive-name "$candidate_archive" --output json)"; then
      log "ERROR: A latest candidate manifest failed authentication"
      exit 1
    fi
    if ! candidate_fields="$(python3 - "$candidate_identity_json" "$candidate_manifest" "$manifest_id" "$manifest_size" "$manifest_revision" "$manifest_hash" <<'PY'
import json
import sys

value = json.loads(sys.argv[1])
required = ("backupId", "createdAt", "authenticationKeyId", "generation", "archiveName", "archiveSha256", "archiveSize")
if any(key not in value for key in required):
    raise SystemExit("authenticated manifest output is incomplete")
if not isinstance(value["archiveSize"], int) or value["archiveSize"] < 1:
    raise SystemExit("authenticated archive size is invalid")
print("\t".join((
    str(value["backupId"]), str(value["createdAt"]), str(value["authenticationKeyId"]),
    str(value["generation"]), str(value["archiveName"]), str(value["archiveSha256"]),
    str(value["archiveSize"]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6],
)))
PY
)"; then
      log "ERROR: A latest candidate manifest did not produce a valid identity"
      exit 1
    fi
    printf '%s\n' "$candidate_fields" >> "$CANDIDATE_IDENTITIES"
  done <<< "$MANIFEST_ROWS"
  if ! SELECTED_IDENTITY="$(python3 - "$CANDIDATE_IDENTITIES" "$RESTORE_FLOOR_GENERATION" <<'PY'
import sys
from pathlib import Path

rows = []
for line in Path(sys.argv[1]).read_text(encoding="ascii").splitlines():
    fields = line.split("\t")
    if len(fields) != 12:
        raise SystemExit("invalid authenticated candidate output")
    backup_id, _created_at, key_id, generation, archive = fields[:5]
    rows.append((int(generation), backup_id, archive, key_id, fields))
if not rows:
    raise SystemExit("no authenticated candidates")
by_generation = {}
for row in rows:
    identity = (row[1], row[2])
    if row[0] in by_generation and by_generation[row[0]] != identity:
        raise SystemExit("conflicting authenticated backup generation")
    by_generation[row[0]] = identity
selected = max(rows)
if selected[0] <= int(sys.argv[2]):
    raise SystemExit("latest backup generation is a downgrade or replay")
print("\t".join(selected[4]))
PY
)"; then
    log "ERROR: Latest authenticated backup is not newer than the accepted restore floor"
    exit 1
  fi
  IFS=$'\t' read -r BACKUP_ID VERIFIED_CREATED_AT BACKUP_AUTH_KEY_ID BACKUP_GENERATION BACKUP_FILE VERIFIED_ARCHIVE_SHA256 VERIFIED_ARCHIVE_SIZE \
    _manifest_name _manifest_id _manifest_size _manifest_revision _manifest_hash <<< "$SELECTED_IDENTITY"
  SELECTED_MANIFEST_ROW="${_manifest_name}"$'\t'"${_manifest_id}"$'\t'"${_manifest_size}"$'\t'"${_manifest_revision}"$'\t'"${_manifest_hash}"
  SELECTED_MANIFEST_PATH="${MANIFEST_SCAN_DIR}/${_manifest_name}"
  log "Found latest authenticated generation ${BACKUP_GENERATION}: $BACKUP_FILE"
else
  # A stem resolves to one exact archive. Old .gz names are available only via
  # the separately confirmed legacy override because no v1 manifest signs them.
  if [[ "$BACKUP_REF" =~ \.(tar\.gz|gz)$ ]]; then
    BACKUP_FILE="$BACKUP_REF"
  else
    BACKUP_FILE="${BACKUP_REF}.tar.gz"
  fi
fi

# Match the archive-name contract enforced by the Lambda before constructing local or remote paths.
if [[ ! "$BACKUP_FILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(tar\.gz|gz)$ ]]; then
  log "ERROR: Invalid backup filename: $BACKUP_FILE"
  exit 1
fi
if [[ "$LEGACY_UNSIGNED" == "0" && ! "$BACKUP_FILE" =~ \.tar\.gz$ ]]; then
  log "ERROR: Authenticated restore requires an exact .tar.gz archive name"
  exit 1
fi

log "Starting restore from: $BACKUP_FILE"

# The default /opt parent is root-owned; the device check above guarantees atomic renames to SERVER_DIR.
ARCHIVE_PATH="${DOWNLOAD_DIR}/${BACKUP_FILE}"
MANIFEST_FILE="${BACKUP_FILE}.manifest.json"

if [[ "$LEGACY_UNSIGNED" == "0" ]]; then
  mapfile -t REMOTE_ROWS < <(remote_objects "$MANIFEST_FILE" "$BACKUP_FILE") || {
    log "ERROR: Authenticated restore requires one exact manifest and archive object"
    exit 1
  }
  if (( ${#REMOTE_ROWS[@]} != 2 )); then
    log "ERROR: Authenticated restore remote object listing is incomplete"
    exit 1
  fi
  IFS=$'\t' read -r manifest_name manifest_id manifest_size manifest_revision manifest_hash <<< "${REMOTE_ROWS[0]}"
  IFS=$'\t' read -r archive_name archive_id archive_listing_size archive_revision archive_hash <<< "${REMOTE_ROWS[1]}"
  if [[ "$manifest_name" != "$MANIFEST_FILE" || "$archive_name" != "$BACKUP_FILE" ]]; then
    log "ERROR: Authenticated restore remote object names changed"
    exit 1
  fi
  expected_manifest_row="${manifest_name}"$'\t'"${manifest_id}"$'\t'"${manifest_size}"$'\t'"${manifest_revision}"$'\t'"${manifest_hash}"
  if [[ -n "$SELECTED_MANIFEST_ROW" && "$expected_manifest_row" != "$SELECTED_MANIFEST_ROW" ]]; then
    log "ERROR: Manifest object ID, revision, or hash changed between selection and verification"
    exit 1
  fi
  if [[ -n "$SELECTED_MANIFEST_PATH" ]]; then
    MANIFEST_PATH="$SELECTED_MANIFEST_PATH"
  else
    MANIFEST_PATH="${DOWNLOAD_DIR}/${MANIFEST_FILE}"
    manifest_expected_size="${manifest_size:-$RESTORE_MANIFEST_MAX_BYTES}"
    download_drive_object "$manifest_id" "$manifest_expected_size" "$RESTORE_MANIFEST_MAX_BYTES" \
      "$MANIFEST_PATH" "$manifest_hash" "authenticated manifest" || exit 1
  fi
  if ! VERIFIED_JSON="$("$BACKUP_AUTH_HELPER" inspect --manifest "$MANIFEST_PATH" --archive-name "$BACKUP_FILE" --output json)"; then
    log "ERROR: Backup authentication failed before archive download"
    exit 1
  fi
  if ! VERIFIED_IDENTITY="$(printf '%s' "$VERIFIED_JSON" | python3 -c 'import json,sys; value=json.load(sys.stdin); print("\t".join((value["backupId"], value["createdAt"], value["authenticationKeyId"], str(value["generation"]), value["archiveName"], value["archiveSha256"], str(value["archiveSize"]), value["instanceId"])))')"; then
    log "ERROR: Authenticated backup metadata is malformed"
    exit 1
  fi
  IFS=$'\t' read -r VERIFIED_BACKUP_ID VERIFIED_CREATED_AT VERIFIED_KEY_ID VERIFIED_GENERATION VERIFIED_ARCHIVE VERIFIED_ARCHIVE_SHA256 VERIFIED_ARCHIVE_SIZE TRANSFER_SOURCE_INSTANCE_ID <<< "$VERIFIED_IDENTITY"
  if [[ "$VERIFIED_ARCHIVE" != "$BACKUP_FILE" || ! "$VERIFIED_GENERATION" =~ ^[1-9][0-9]*$ || "$VERIFIED_GENERATION" -le "$RESTORE_FLOOR_GENERATION" ]]; then
    log "ERROR: Backup generation is a downgrade or replay of the accepted restore floor"
    exit 1
  fi
  if [[ "$REPLACEMENT_CONVERGENCE" == "1" ]] &&
     [[ "$VERIFIED_GENERATION" != "$REPLACEMENT_REQUESTED_GENERATION" || "$VERIFIED_BACKUP_ID" != "$REPLACEMENT_REQUESTED_BACKUP_ID" ]]; then
    log "ERROR: Replacement convergence archive is not the exact requested generation and backup ID"
    exit 1
  fi
  if (( VERIFIED_ARCHIVE_SIZE > RESTORE_ARCHIVE_MAX_BYTES )); then
    log "ERROR: Authenticated archive exceeds the configured restore hard maximum"
    exit 1
  fi
  if [[ -n "$archive_listing_size" && "$archive_listing_size" != "$VERIFIED_ARCHIVE_SIZE" ]]; then
    log "ERROR: Drive Content-Length does not match the authenticated manifest"
    exit 1
  fi
  BACKUP_ID="$VERIFIED_BACKUP_ID"
  BACKUP_GENERATION="$VERIFIED_GENERATION"
  BACKUP_AUTH_KEY_ID="$VERIFIED_KEY_ID"
  EXPECTED_ARCHIVE_BYTES="$VERIFIED_ARCHIVE_SIZE"
  CURRENT_INSTANCE_ID="$(cat "${MC_BACKUP_INSTANCE_ID_FILE:-/var/lib/cloud/data/instance-id}" 2>/dev/null || true)"
  if [[ ! "$CURRENT_INSTANCE_ID" =~ ^i-[a-f0-9]{8,17}$ ]]; then
    log "ERROR: Current instance identity is unavailable"
    exit 1
  fi
  if [[ "$TRANSFER_SOURCE_INSTANCE_ID" != "$CURRENT_INSTANCE_ID" ]]; then
    log "Authenticated replacement restore requires its one-time source-to-target transfer authorization"
    TRANSFER_ARGUMENTS=(transfer-consume \
      --expected-operation-id "${MC_BACKUP_TRANSFER_EXPECTED_OPERATION_ID:-}" \
      --archive-name "$BACKUP_FILE" \
      --expected-backup-id "$BACKUP_ID" \
      --expected-generation "$BACKUP_GENERATION" \
      --expected-source-instance-id "$TRANSFER_SOURCE_INSTANCE_ID" \
      --expected-lock-id "${MC_BACKUP_TRANSFER_EXPECTED_LOCK_ID:-}" \
      --expected-fencing-token "${MC_BACKUP_TRANSFER_EXPECTED_FENCING_TOKEN:-0}" \
      --expected-lease-generation "${MC_BACKUP_TRANSFER_EXPECTED_LEASE_GENERATION:-0}" \
      --floor-state "$RESTORE_FLOOR_STATE" \
      --floor-parameter "${MC_RESTORE_FLOOR_PARAMETER:-/minecraft/restore-generation-floor}" \
      --floor-cloud-environment "MC_RESTORE_FLOOR_CLOUD_FILE")
    if ! TRANSFER_IDENTITY="$("$BACKUP_AUTH_HELPER" "${TRANSFER_ARGUMENTS[@]}")"; then
      log "ERROR: Replacement transfer authorization was absent, replayed, mismatched, or unauthenticated"
      exit 1
    fi
    IFS=$'\t' read -r TRANSFER_AUTHORIZATION_ID _ TRANSFER_TARGET_INSTANCE_ID _ _ TRANSFER_FLOOR_VERSION <<< "$TRANSFER_IDENTITY"
    [[ "$TRANSFER_TARGET_INSTANCE_ID" == "$CURRENT_INSTANCE_ID" ]] || {
      log "ERROR: Replacement transfer authorization target does not match this instance"
      exit 1
    }
  fi
else
  log "WARNING: Restoring unauthenticated legacy input; Paper and plugins from the archive will be excluded"
  mapfile -t REMOTE_ROWS < <(remote_objects "$BACKUP_FILE") || {
    log "ERROR: Legacy restore requires one exact archive object"
    exit 1
  }
  IFS=$'\t' read -r archive_name archive_id archive_listing_size archive_revision archive_hash <<< "${REMOTE_ROWS[0]}"
  if [[ -n "$archive_listing_size" ]] && (( archive_listing_size > LEGACY_ARCHIVE_MAX_BYTES )); then
    log "ERROR: Legacy archive exceeds its strict 64 MiB safety cap"
    exit 1
  fi
  EXPECTED_ARCHIVE_BYTES="${archive_listing_size:-0}"
fi

ARCHIVE_ROW="${archive_name}"$'\t'"${archive_id}"$'\t'"${archive_listing_size}"$'\t'"${archive_revision}"$'\t'"${archive_hash}"
log "Streaming the pinned immutable Drive object into atomic staging..."
if ! download_drive_object "$archive_id" "$EXPECTED_ARCHIVE_BYTES" \
    "$([[ "$LEGACY_UNSIGNED" == "1" ]] && printf '%s' "$LEGACY_ARCHIVE_MAX_BYTES" || printf '%s' "$RESTORE_ARCHIVE_MAX_BYTES")" \
    "$ARCHIVE_PATH" "$archive_hash" "backup archive"; then
  exit 1
fi

if [[ "$LEGACY_UNSIGNED" == "0" ]]; then
  mapfile -t FINAL_REMOTE_ROWS < <(remote_objects "$MANIFEST_FILE" "$BACKUP_FILE") || {
    rm -f -- "$ARCHIVE_PATH"
    log "ERROR: Could not revalidate the immutable Drive object pair"
    exit 1
  }
  if (( ${#FINAL_REMOTE_ROWS[@]} != 2 )) || [[ "${FINAL_REMOTE_ROWS[0]}" != "$expected_manifest_row" ]] || [[ "${FINAL_REMOTE_ROWS[1]}" != "$ARCHIVE_ROW" ]]; then
    rm -f -- "$ARCHIVE_PATH"
    log "ERROR: Manifest or archive object was replaced during restore"
    exit 1
  fi
  log "Authenticating exact archive bytes before extraction..."
  if ! "$BACKUP_AUTH_HELPER" verify --archive "$ARCHIVE_PATH" --manifest "$MANIFEST_PATH" \
      --archive-name "$BACKUP_FILE" --expected-backup-id "$BACKUP_ID" --expected-generation "$BACKUP_GENERATION" >/dev/null; then
    rm -f -- "$ARCHIVE_PATH"
    log "ERROR: Backup archive digest or size does not match its authenticated manifest"
    exit 1
  fi
fi

log "Validating and extracting backup into staging..."
if ! python3 - "$ARCHIVE_PATH" "$EXTRACT_DIR" "$LEGACY_UNSIGNED" <<'PY'
import os
import shutil
import sys
import tarfile
from pathlib import Path

archive_path = Path(sys.argv[1])
extract_root = Path(sys.argv[2])
legacy_unsigned = sys.argv[3] == "1"


def fail(message: str) -> None:
    raise ValueError(message)


try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        seen: set[tuple[str, ...]] = set()
        regular_file_count = 0
        regular_file_bytes = 0

        for member in members:
            name = member.name
            normalized = name[:-1] if name.endswith("/") else name
            if not normalized or normalized.startswith("/"):
                fail(f"unsafe archive path: {name!r}")

            parts = tuple(normalized.split("/"))
            if any(part in ("", ".", "..") for part in parts):
                fail(f"unsafe archive path: {name!r}")
            if parts[0] != "server":
                fail(f"archive entry is outside the server root: {name!r}")
            if not (member.isdir() or member.isfile()):
                fail(f"unsupported archive entry type: {name!r}")
            if member.isfile():
                regular_file_count += 1
                regular_file_bytes += member.size
            if parts == ("server",) and not member.isdir():
                fail("archive server root is not a directory")
            if parts in seen:
                fail(f"duplicate archive entry: {name!r}")
            seen.add(parts)

        if not members:
            fail("archive is empty")
        if regular_file_count == 0:
            fail("archive contains no server files")
        available_bytes = shutil.disk_usage(extract_root).free
        reserve_bytes = min(64 * 1024 * 1024, available_bytes // 10)
        if regular_file_bytes > available_bytes - reserve_bytes:
            fail("archive contents exceed available staging space")

        directory_modes: list[tuple[Path, int]] = []
        for member in members:
            normalized = member.name[:-1] if member.name.endswith("/") else member.name
            parts = tuple(normalized.split("/"))
            destination = extract_root.joinpath(*parts)

            if legacy_unsigned and (parts == ("server", "paper.jar") or parts[:2] == ("server", "plugins")):
                continue

            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                directory_modes.append((destination, member.mode & 0o777))
                continue

            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                fail(f"could not read archive entry: {member.name!r}")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(destination, flags, member.mode & 0o777)
            with source, os.fdopen(descriptor, "wb") as output:
                shutil.copyfileobj(source, output)
                os.fchmod(output.fileno(), member.mode & 0o777)

        for directory, mode in reversed(directory_modes):
            directory.chmod(mode)

    server_root = extract_root / "server"
    if not server_root.is_dir() or server_root.is_symlink():
        fail("archive does not contain a server directory root")
except (OSError, tarfile.TarError, ValueError) as error:
    print(f"Archive validation/extraction failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
then
  log "ERROR: Backup archive failed validation or extraction"
  exit 1
fi

copy_legacy_executables() {
  log "Copying current local Paper/plugins into legacy staging instead of accepting unauthenticated executables..."
  if ! python3 - "$SERVER_DIR" "$STAGED_SERVER" <<'PY'
import os
import shutil
import stat
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])

def copy_regular(source_path: Path, destination_path: Path) -> None:
    info = source_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError(f"trusted runtime input is not a regular file: {source_path.name}")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with source_path.open("rb") as incoming, destination_path.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    destination_path.chmod(info.st_mode & 0o777)

try:
    paper = source / "paper.jar"
    if not paper.exists():
        raise ValueError("current trusted paper.jar is unavailable")
    copy_regular(paper, destination / "paper.jar")
    plugins = source / "plugins"
    if plugins.exists():
        if not plugins.is_dir() or plugins.is_symlink():
            raise ValueError("current plugins path is unsafe")
        for current, directories, files in os.walk(plugins, followlinks=False):
            current_path = Path(current)
            relative = current_path.relative_to(source)
            for name in directories:
                candidate = current_path / name
                if candidate.is_symlink():
                    raise ValueError("current plugin tree contains a link")
                (destination / relative / name).mkdir(parents=True, exist_ok=True)
            for name in files:
                copy_regular(current_path / name, destination / relative / name)
except (OSError, ValueError) as error:
    print(f"Legacy executable exclusion failed: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    log "ERROR: Could not source trusted local Paper/plugins for legacy restore"
    return 1
  fi
}

log "Setting staged server permissions..."
if ! chown -R "$SERVER_OWNER" "$STAGED_SERVER"; then
  log "ERROR: Failed to set staged server permissions"
  exit 1
fi

recover_previous_state() {
  local context="$1"
  local recovery_failed=0
  local rollback_source="$PREVIOUS_LOCATION"

  ROLLBACK_ATTEMPTED=1
  log "Rolling back restore after ${context}..."
  if [[ "$RESTORE_COMMITTED" == "1" ]]; then
    log "CRITICAL: Refusing to roll back an irreversibly committed restore generation"
    return 1
  fi
  write_restore_journal "rollback-started" "$RETAINED_BACKUP"
  update_boot_hold rollback-started || return 1
          systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || \
    log "Warning: Failed to stop every service during rollback"

  if [[ "$HAD_PREVIOUS" == "1" ]]; then
    if [[ ! -e "$rollback_source" && ! -L "$rollback_source" && -n "$RETAINED_BACKUP" ]]; then
      rollback_source="$RETAINED_BACKUP"
    fi
    if [[ -e "$rollback_source" || -L "$rollback_source" ]]; then
      if [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
        if ! mv -- "$SERVER_DIR" "$FAILED_SERVER"; then
          log "CRITICAL: Could not move failed restore out of the server path"
          recovery_failed=1
        fi
      fi
      if [[ "$recovery_failed" == "0" ]] && ! mv -- "$rollback_source" "$SERVER_DIR"; then
        log "CRITICAL: Could not restore the previous server directory"
        recovery_failed=1
      fi
    elif [[ ! -e "$SERVER_DIR" && ! -L "$SERVER_DIR" ]]; then
      log "CRITICAL: Previous server directory is missing during rollback"
      recovery_failed=1
    fi
  elif [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
    if ! mv -- "$SERVER_DIR" "$FAILED_SERVER"; then
      log "CRITICAL: Could not remove failed restore from an initially empty server path"
      recovery_failed=1
    fi
  fi

  if [[ "$recovery_failed" == "1" ]]; then
    PRESERVE_TEMP=1
    return 1
  fi
  fsync_restore_directories
  if [[ "$HAD_PREVIOUS" == "1" ]] && ! python3 - "$SERVER_DIR" "$PREVIOUS_SERVER_DEVICE" "$PREVIOUS_SERVER_INODE" <<'PY'
import os, sys
value=os.stat(sys.argv[1])
raise SystemExit(0 if (value.st_dev, value.st_ino) == (int(sys.argv[2]), int(sys.argv[3])) else 1)
PY
  then
    log "CRITICAL: Rolled-back server identity does not match exact pre-state"
    return 1
  fi
  if ! "$WORLD_ROOTS_HELPER" activate --generation "$PREVIOUS_WORLD_ROOT_GENERATION"; then
    log "CRITICAL: Previous server restored, but its world-root generation could not be reactivated"
    return 1
  fi
  ACTIVE_WORLD_ROOT_GENERATION="$PREVIOUS_WORLD_ROOT_GENERATION"
  ACTIVE_WORLD_ROOTS_JSON="$PREVIOUS_WORLD_ROOTS_JSON"
  if [[ "$("$WORLD_ROOTS_HELPER" inspect)" != "$PREVIOUS_WORLD_ROOT_GENERATION" ]] ||
     [[ "$(normalize_world_roots_json "$("$WORLD_ROOTS_HELPER" inspect --output roots-json)")" != "$PREVIOUS_WORLD_ROOTS_JSON" ]]; then
    log "CRITICAL: Reactivated world-root generation does not match the exact pre-restore record"
    return 1
  fi
  # A single durable rollback checkpoint covers both halves of the precommit
  # state. Services remain stopped until this paired state is published.
  write_restore_journal "rollback-files-restored" "$RETAINED_BACKUP"
  update_boot_hold rollback-files-restored || return 1
  write_restore_journal "rollback-roots-restored" "$RETAINED_BACKUP"
  update_boot_hold rollback-roots-restored || return 1
  write_restore_journal "rollback-restoring-services" "$RETAINED_BACKUP"
  if ! restore_exact_service_states rollback-restoring-services; then
    log "CRITICAL: Previous server and world roots restored, but exact service state/readiness failed"
    PRESERVE_TEMP=1
    return 1
  fi
  write_restore_journal "rolled-back-terminal" "$RETAINED_BACKUP"
  clear_boot_hold || return 1
  clear_restore_journal
  MAINTENANCE_RELEASE_ALLOWED=1
  log "Previous server state restored"
}

validate_staged_server() {
  python3 - "$STAGED_SERVER" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("staged server root is not a directory")
    for current_root, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = os.path.join(current_root, name)
            entry_stat = os.lstat(path)
            if stat.S_ISDIR(entry_stat.st_mode):
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ValueError(f"unsupported staged entry type: {path}")
            if entry_stat.st_nlink != 1:
                raise ValueError(f"hard-linked staged file: {path}")
except (OSError, ValueError) as error:
    print(f"Staged server validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

prune_retained_backups() {
  local protected_backup="${1:-}"
  python3 - "$SERVER_PARENT" "$BACKUP_RETENTION" "$protected_backup" <<'PY'
import shutil
import sys
from pathlib import Path

parent = Path(sys.argv[1])
retention = int(sys.argv[2])
protected = Path(sys.argv[3]) if sys.argv[3] else None
backups = sorted(
    (entry for entry in parent.iterdir() if entry.name.startswith("server.backup-") and entry.is_dir() and not entry.is_symlink()),
    key=lambda entry: entry.name,
    reverse=True,
)
retained = []
if protected is not None and protected in backups:
    retained.append(protected)
retained.extend(entry for entry in backups if entry != protected)
for expired in retained[retention:]:
    shutil.rmtree(expired)
PY
}

# Nothing above this point interrupts the running server or changes its profile.
MUTATION_STARTED=1
FAILURE_CONTEXT="service stop or pre-install failure"
write_restore_journal "quiescing"
update_boot_hold quiescing || exit 1
if ! drain_and_quiesce_runtime; then
  log "ERROR: Failed to drain and quiesce the runtime; restore not installed"
  exit 1
fi
write_restore_journal "runtime-quiesced"
update_boot_hold runtime-quiesced || exit 1

if [[ "$LEGACY_UNSIGNED" == "1" ]]; then
  FAILURE_CONTEXT="legacy executable isolation failure"
  if ! copy_legacy_executables; then
    exit 1
  fi
  if ! chown -R "$SERVER_OWNER" "$STAGED_SERVER"; then
    log "ERROR: Failed to set staged server permissions after legacy executable isolation"
    exit 1
  fi
fi

FAILURE_CONTEXT="server-profile staging failure"
log "Staging and verifying the current server profile against the restored world..."
if ! "$PROFILE_INSTALLER" --restore-staging "$STAGED_SERVER"; then
  log "ERROR: Failed to stage the current server profile for restore"
  exit 1
fi
write_restore_journal "profile-staged"
update_boot_hold profile-staged || exit 1

FAILURE_CONTEXT="canonical world-root publication failure"
RESTORED_WORLD_ROOTS_FILE="${STAGED_SERVER}/.mc-aws-world-roots.json"
WORLD_ROOT_ARGUMENTS=(
  reconcile
  --gateway-template "$SETUP_ROOT/runtime/mc-agent-gateway.json"
  --executor-template "$SETUP_ROOT/runtime/mc-agent-executor.json"
  --server-properties "$STAGED_SERVER/server.properties"
)
if [[ -f "$RESTORED_WORLD_ROOTS_FILE" && ! -L "$RESTORED_WORLD_ROOTS_FILE" ]]; then
  if ! REVIEWED_WORLD_ROOTS_JSON="$(normalize_world_roots_json "$(<"$RESTORED_WORLD_ROOTS_FILE")")"; then
    log "ERROR: Restored reviewed world roots are malformed"
    exit 1
  fi
  WORLD_ROOT_ARGUMENTS+=(--restored-roots-file "$RESTORED_WORLD_ROOTS_FILE")
fi
write_restore_journal "roots-review-recorded"
update_boot_hold roots-review-recorded || exit 1
if [[ "$HAD_PREVIOUS" == "1" && -f "$SERVER_DIR/server.properties" ]]; then
  WORLD_ROOT_ARGUMENTS+=(--previous-server-properties "$SERVER_DIR/server.properties")
fi
if ! "$WORLD_ROOTS_HELPER" "${WORLD_ROOT_ARGUMENTS[@]}" ||
   ! ACTIVE_WORLD_ROOT_GENERATION="$("$WORLD_ROOTS_HELPER" inspect)"; then
  log "ERROR: Restored world roots failed canonical publication"
  exit 1
fi
if ! ACTIVE_WORLD_ROOTS_JSON="$(normalize_world_roots_json "$("$WORLD_ROOTS_HELPER" inspect --output roots-json)")"; then
  log "ERROR: Restored active world-root generation could not be verified"
  exit 1
fi
rm -f -- "$RESTORED_WORLD_ROOTS_FILE"
write_restore_journal "roots-published"
update_boot_hold roots-published || exit 1

FAILURE_CONTEXT="final staged-server validation failure"
if ! validate_staged_server; then
  log "ERROR: Staged server changed or failed validation before install"
  exit 1
fi

log "Installing staged server directory..."
if [[ "$HAD_PREVIOUS" == "1" ]]; then
  FAILURE_CONTEXT="current-server rename failure"
  write_restore_journal "moving-previous"
  update_boot_hold moving-previous || exit 1
  if ! mv -- "$SERVER_DIR" "$PREVIOUS_LOCATION"; then
    log "ERROR: Failed to move current server directory; restore not installed"
    exit 1
  fi
  fsync_restore_directories
  write_restore_journal "previous-moved"
  update_boot_hold previous-moved || exit 1
fi

FAILURE_CONTEXT="staged-server install failure"
write_restore_journal "installing"
update_boot_hold installing || exit 1
if ! mv -- "$STAGED_SERVER" "$SERVER_DIR"; then
  log "ERROR: Failed to install staged server directory"
  exit 1
fi
reconcile_workspace_dac || exit 1
fsync_restore_directories
write_restore_journal "installed"
update_boot_hold installed || exit 1

if [[ "$HAD_PREVIOUS" == "1" ]]; then
  RETAINED_BACKUP_BASE="${SERVER_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
  RETAINED_BACKUP="$RETAINED_BACKUP_BASE"
  suffix=0
  while [[ -e "$RETAINED_BACKUP" || -L "$RETAINED_BACKUP" ]]; do
    suffix=$((suffix + 1))
    RETAINED_BACKUP="${RETAINED_BACKUP_BASE}-${suffix}"
  done
  FAILURE_CONTEXT="successful-backup retention failure"
  write_restore_journal "retention-planned" "$RETAINED_BACKUP"
  update_boot_hold retention-planned || exit 1
  if ! mv -- "$PREVIOUS_LOCATION" "$RETAINED_BACKUP"; then
    log "ERROR: Failed to retain the previous successful server directory"
    exit 1
  fi
  fsync_restore_directories
  PREVIOUS_LOCATION="$RETAINED_BACKUP"
  write_restore_journal "retained" "$RETAINED_BACKUP"
  update_boot_hold retained || exit 1
fi

FAILURE_CONTEXT="retained-backup pruning failure"
if ! prune_retained_backups "$PREVIOUS_LOCATION"; then
  log "ERROR: Failed to prune retained server backups"
  exit 1
fi

FAILURE_CONTEXT="authenticated restore-floor commit failure"
# The generation floor is irreversible.  Flush every restored world/profile
# byte and every containing directory before advancing it, rather than relying
# on rename durability alone.
if ! fsync_restored_server_tree; then
  log "ERROR: Restored server files could not be made durable before commit"
  exit 1
fi
fsync_restore_directories
if [[ "$LEGACY_UNSIGNED" == "0" ]]; then
  COMMIT_STARTED=1
  write_restore_journal "commit-pending" "$PREVIOUS_LOCATION"
  update_boot_hold commit-pending || exit 1
  FLOOR_COMMIT_ARGUMENTS=(floor-commit \
    --state-file "$RESTORE_FLOOR_STATE" \
    --generation "$BACKUP_GENERATION" \
    --backup-id "$BACKUP_ID" \
    --updated-at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")
  if [[ -n "${TRANSFER_AUTHORIZATION_ID:-}" ]]; then
    FLOOR_COMMIT_ARGUMENTS+=(--transfer-id "$TRANSFER_AUTHORIZATION_ID")
  fi
  if ! "$BACKUP_AUTH_HELPER" "${FLOOR_COMMIT_ARGUMENTS[@]}" >/dev/null; then
    log "ERROR: Could not durably commit the authenticated restore generation"
    exit 1
  fi
  RESTORE_COMMITTED=1
fi
write_restore_journal "committed" "$PREVIOUS_LOCATION"
update_boot_hold committed || exit 1
if [[ "$LEGACY_UNSIGNED" == "1" ]]; then
  RESTORE_COMMITTED=1
fi

FAILURE_CONTEXT="committed restored-server readiness failure"
if ! start_committed_services; then
  secure_committed_failure
  log "CRITICAL: Committed restored generation could not become protocol-ready; recovery will retry without rollback"
  exit 1
fi

write_restore_journal "committed-terminal" "$PREVIOUS_LOCATION"
clear_boot_hold || exit 1
clear_restore_journal
RESTORE_SUCCEEDED=1
MAINTENANCE_RELEASE_ALLOWED=1
log "SUCCESS: Restored from ${BACKUP_FILE}"
