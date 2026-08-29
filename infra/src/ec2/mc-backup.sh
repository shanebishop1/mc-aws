#!/usr/bin/env bash
# Backup Minecraft server to Google Drive
# Usage: mc-backup.sh [--hibernate|--recover-hibernate] [--require-active] [backup-name]
# If no name provided, use timestamp

set -euo pipefail

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

restart_minecraft_or_fail() {
  local context="$1"
  log "Restarting Minecraft server (${context})..."
  if ! systemctl start minecraft; then
    log "ERROR: Restart failed after ${context}"
    return 1
  fi

  log "Minecraft server restart succeeded (${context})"
}

BACKUP_MODE="ordinary"
REQUIRE_ACTIVE=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --hibernate)
      BACKUP_MODE="hibernate"
      ;;
    --recover-hibernate)
      BACKUP_MODE="recover-hibernate"
      ;;
    --require-active)
      REQUIRE_ACTIVE=1
      ;;
    *)
      log "ERROR: Unsupported backup option: $1"
      exit 2
      ;;
  esac
  shift
done

if (( $# > 1 )); then
  log "ERROR: Too many backup arguments"
  exit 2
fi

export RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/setup/rclone/rclone.conf}"
RCLONE_CONFIG_HELPER="${MC_RCLONE_CONFIG_HELPER:-/usr/local/bin/mc-rclone-config.sh}"

# Hold one atomic critical section shared by backup, restore, and hibernate recovery.
OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
if ! command -v flock >/dev/null 2>&1; then
  log "ERROR: flock is required for lifecycle operation serialization"
  exit 1
fi
exec 9>"$OPERATION_LOCK"
if ! flock -n 9; then
  log "ERROR: Another backup, restore, or hibernate operation is in progress"
  exit 1
fi

# Create maintenance lock to prevent idle shutdown during backup
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/tmp/mc-maintenance.lock}"
HIBERNATE_GUARD="${MC_HIBERNATE_GUARD:-/tmp/mc-hibernate-in-progress}"
BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
MAINTENANCE_LOCK_OWNED=0
MINECRAFT_STOPPED=0
BACKUP_UPLOADED=0
BACKUP_ARCHIVE=""
MINECRAFT_WAS_ACTIVE=0
BACKUP_JOURNAL=""

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [[ "$MINECRAFT_STOPPED" == "1" ]]; then
    if [[ "$BACKUP_MODE" == "hibernate" && "$BACKUP_UPLOADED" == "1" && "$exit_code" == "0" ]]; then
      log "Minecraft remains stopped for EC2 hibernation"
    elif restart_minecraft_or_fail "backup failure recovery"; then
      MINECRAFT_STOPPED=0
      rm -f -- "$HIBERNATE_GUARD"
    else
      log "CRITICAL: Minecraft remains stopped after backup failure"
      exit_code=1
    fi
  fi

  if [[ -n "$BACKUP_ARCHIVE" ]]; then
    rm -f -- "$BACKUP_ARCHIVE"
  fi
  if [[ "$MAINTENANCE_LOCK_OWNED" == "1" ]]; then
    rm -f -- "$MAINTENANCE_LOCK"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
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

if [[ "$BACKUP_MODE" == "recover-hibernate" ]]; then
  if [[ ! -e "$HIBERNATE_GUARD" ]]; then
    log "No hibernate guard present; recovery is not required"
    exit 0
  fi
  restart_minecraft_or_fail "hibernate failure recovery"
  rm -f -- "$HIBERNATE_GUARD"
  log "Hibernate failure recovery completed"
  exit 0
fi

if [[ -e "$HIBERNATE_GUARD" ]]; then
  log "ERROR: Hibernate is in progress; refusing to modify server state"
  exit 1
fi

if [[ ! -e "$MAINTENANCE_LOCK" ]]; then
  touch "$MAINTENANCE_LOCK"
  MAINTENANCE_LOCK_OWNED=1
fi

BACKUP_NAME="${1:-server-$(date +%Y%m%d-%H%M%S)}"
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
SERVER_DIR="${MC_SERVER_DIR:-/opt/minecraft/server}"
SERVER_PARENT="$(dirname -- "$SERVER_DIR")"
BACKUP_TEMP_DIR="${MC_BACKUP_TEMP_DIR:-/tmp}"
BACKUP_ARCHIVE="${BACKUP_TEMP_DIR}/${BACKUP_NAME}.tar.gz"
BACKUP_JOURNAL="${MC_BACKUP_JOURNAL:-/var/lib/mc-aws/mc-backup-journal.json}"
REMOTE_OPERATION_KEY="${MC_REMOTE_OPERATION_KEY:-}"

if [[ ! "$BACKUP_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  log "ERROR: Invalid backup name: $BACKUP_NAME"
  exit 1
fi
if [[ -n "$REMOTE_OPERATION_KEY" && ! "$REMOTE_OPERATION_KEY" =~ ^[a-f0-9]{64}$ ]]; then
  log "ERROR: Invalid remote operation key"
  exit 1
fi
if [[ "$(basename -- "$SERVER_DIR")" != "server" || ! -d "$SERVER_PARENT" || ! -d "$BACKUP_TEMP_DIR" ]]; then
  log "ERROR: Backup paths must use an existing parent with a server child and existing temp directory"
  exit 1
fi
if [[ ! -d "$(dirname -- "$BACKUP_JOURNAL")" ]]; then
  log "ERROR: Backup journal parent does not exist"
  exit 1
fi

write_backup_journal() {
  local phase="$1"
  python3 - "$BACKUP_JOURNAL" "$phase" "$BACKUP_NAME" "$BACKUP_MODE" "$REMOTE_OPERATION_KEY" <<'PY'
import json
import os
import sys

journal, phase, name, mode, operation_key = sys.argv[1:]
temporary = f"{journal}.new"
with open(temporary, "w", encoding="utf-8") as output:
    json.dump(
        {"version": 1, "phase": phase, "backupName": name, "mode": mode, "operationKey": operation_key or None},
        output,
        separators=(",", ":"),
    )
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, journal)
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

clear_backup_journal() {
  python3 - "$BACKUP_JOURNAL" <<'PY'
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

recover_backup_journal() {
  [[ -f "$BACKUP_JOURNAL" ]] || return 1
  local journal_identity
  if ! journal_identity="$(python3 - "$BACKUP_JOURNAL" <<'PY'
import json
import re
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))
    if value.get("version") != 1 or value.get("phase") not in ("uploading", "uploaded", "restart-complete"):
        raise ValueError("unsupported backup journal")
    name = value.get("backupName")
    mode = value.get("mode")
    operation_key = value.get("operationKey")
    if not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9._-]+", name) is None:
        raise ValueError("invalid backup journal name")
    if mode != "ordinary":
        raise ValueError("invalid backup journal mode")
    if operation_key is not None and (
        not isinstance(operation_key, str) or re.fullmatch(r"[a-f0-9]{64}", operation_key) is None
    ):
        raise ValueError("invalid backup journal operation key")
    print(
        f"{value['phase']}\t{name}\t{mode}\t{operation_key or ''}"
    )
except (OSError, ValueError, json.JSONDecodeError) as error:
    print(f"Backup journal recovery failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
)"; then
    log "CRITICAL: Backup journal could not be recovered"
    exit 1
  fi
  local journal_phase="${journal_identity%%$'\t'*}"
  local remaining_identity="${journal_identity#*$'\t'}"
  local journal_name="${remaining_identity%%$'\t'*}"
  remaining_identity="${remaining_identity#*$'\t'}"
  local journal_mode="${remaining_identity%%$'\t'*}"
  local journal_operation_key="${remaining_identity#*$'\t'}"
  if [[ "$journal_mode" != "$BACKUP_MODE" ]]; then
    log "ERROR: An uploaded backup is awaiting recovery under a different operation identity"
    exit 1
  fi
  if [[ -n "$journal_operation_key" ]]; then
    if [[ "$journal_operation_key" != "$REMOTE_OPERATION_KEY" ]]; then
      log "ERROR: An uploaded backup is awaiting recovery under a different operation identity"
      exit 1
    fi
    BACKUP_NAME="$journal_name"
    BACKUP_ARCHIVE="${BACKUP_TEMP_DIR}/${BACKUP_NAME}.tar.gz"
  elif [[ "$journal_name" != "$BACKUP_NAME" ]]; then
    log "ERROR: An uploaded backup is awaiting recovery under a different backup name"
    exit 1
  fi
  if [[ "$BACKUP_MODE" != "ordinary" ]]; then
    log "ERROR: Unexpected non-ordinary backup journal"
    exit 1
  fi

  case "$journal_phase" in
    uploading)
      log "Retrying the same remote target after an unresolved upload result"
      return 1
      ;;
    uploaded)
      if ! systemctl is-active --quiet minecraft.service; then
        restart_minecraft_or_fail "uploaded backup recovery"
      fi
      write_backup_journal "restart-complete"
      if [[ -z "$REMOTE_OPERATION_KEY" ]]; then
        clear_backup_journal
      fi
      log "SUCCESS: Backup ${BACKUP_NAME}.tar.gz was already uploaded; restart recovery completed"
      return 0
      ;;
    restart-complete)
      log "SUCCESS: Backup ${BACKUP_NAME}.tar.gz was already uploaded and restarted"
      return 0
      ;;
  esac
}

if recover_backup_journal; then
  exit 0
fi

validate_server_tree() {
  python3 - "$SERVER_DIR" <<'PY'
import os
import stat
import sys

root = sys.argv[1]


def validate_directory(directory: str) -> None:
    with os.scandir(directory) as entries:
        for entry in entries:
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(entry_stat.st_mode):
                validate_directory(entry.path)
            elif not stat.S_ISREG(entry_stat.st_mode):
                raise ValueError(f"unsupported server entry type: {entry.path}")
            elif entry_stat.st_nlink != 1:
                raise ValueError(f"hard-linked server file: {entry.path}")


try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("server root is not a directory")
    validate_directory(root)
except (OSError, ValueError) as error:
    print(f"Server tree validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

validate_backup_archive() {
  python3 - "$BACKUP_ARCHIVE" <<'PY'
import sys
import tarfile

archive_path = sys.argv[1]
try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        seen = set()
        regular_file_count = 0
        for member in members:
            name = member.name
            normalized = name[:-1] if name.endswith("/") else name
            parts = tuple(normalized.split("/"))
            if not normalized or normalized.startswith("/") or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"unsafe archive path: {name!r}")
            if parts[0] != "server":
                raise ValueError(f"archive entry is outside the server root: {name!r}")
            if not (member.isdir() or member.isfile()):
                raise ValueError(f"unsupported archive entry type: {name!r}")
            if member.isfile():
                regular_file_count += 1
            if parts == ("server",) and not member.isdir():
                raise ValueError("archive server root is not a directory")
            if parts in seen:
                raise ValueError(f"duplicate archive entry: {name!r}")
            seen.add(parts)
        if not members:
            raise ValueError("archive is empty")
        if regular_file_count == 0:
            raise ValueError("archive contains no server files")
except (OSError, tarfile.TarError, ValueError) as error:
    print(f"Produced archive validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

log "Starting backup: $BACKUP_NAME"

if ! "$RCLONE_CONFIG_HELPER"; then
  log "ERROR: Failed to materialize Google Drive configuration"
  exit 1
fi

log "Validating server tree before downtime..."
if ! validate_server_tree; then
  log "ERROR: Server tree contains entries that cannot be safely restored"
  exit 1
fi

if systemctl is-active --quiet minecraft.service; then
  MINECRAFT_WAS_ACTIVE=1
elif [[ "$REQUIRE_ACTIVE" == "1" ]]; then
  log "SKIP: Minecraft service is not active; scheduled backup will not start it"
  exit 3
else
  log "Minecraft service was already inactive; backup will preserve that state"
fi

# Stop server gracefully only when this invocation observed it active.
if [[ "$MINECRAFT_WAS_ACTIVE" == "1" ]]; then
  log "Stopping Minecraft server..."
  if ! systemctl stop minecraft; then
    log "ERROR: Failed to stop minecraft service"
    exit 1
  fi
  MINECRAFT_STOPPED=1
fi
if [[ "$BACKUP_MODE" == "hibernate" && "$MINECRAFT_WAS_ACTIVE" == "1" ]]; then
  printf '%s\n' "$CURRENT_BOOT_ID" > "$HIBERNATE_GUARD"
fi

# Close the validation/archive race while the service is stopped.
if ! validate_server_tree; then
  log "ERROR: Server tree changed to contain an unsupported entry before archiving"
  exit 1
fi

# Create tar archive
log "Creating tar archive..."
cd "$SERVER_PARENT"
tar -czf "$BACKUP_ARCHIVE" server/ || {
  log "ERROR: Failed to create tar archive"
  exit 1
}

if ! validate_backup_archive; then
  log "ERROR: Produced archive does not satisfy the restore contract"
  rm -f "$BACKUP_ARCHIVE"
  exit 1
fi

# Upload to Google Drive
log "Uploading to Google Drive..."
if [[ "$BACKUP_MODE" == "ordinary" ]]; then
  # Persist the selected object name before starting rclone. A retry after an
  # ambiguous rclone result therefore overwrites this exact object with copyto
  # instead of creating an archive under a newly generated timestamp.
  write_backup_journal "uploading"
fi
rclone copyto "$BACKUP_ARCHIVE" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_NAME}.tar.gz" || {
  log "ERROR: Failed to upload to Google Drive"
  rm -f "$BACKUP_ARCHIVE"
  if [[ "$BACKUP_MODE" == "ordinary" && -z "$REMOTE_OPERATION_KEY" ]]; then
    clear_backup_journal
  fi
  exit 1
}
if [[ "$BACKUP_MODE" == "ordinary" ]]; then
  write_backup_journal "uploaded"
fi
BACKUP_UPLOADED=1

# Cleanup
log "Cleaning up temporary files..."
rm -f "$BACKUP_ARCHIVE"

# Ordinary backups restart immediately. Hibernate mode deliberately keeps the
# service stopped and leaves a guard that blocks direct backup/restore races.
if [[ "$BACKUP_MODE" == "ordinary" && "$MINECRAFT_WAS_ACTIVE" == "1" ]]; then
  if ! restart_minecraft_or_fail "post-backup"; then
    log "PARTIAL FAILURE: Backup ${BACKUP_NAME}.tar.gz uploaded, but minecraft restart failed"
    exit 1
  fi
  MINECRAFT_STOPPED=0
fi

if [[ "$BACKUP_MODE" == "ordinary" ]]; then
  write_backup_journal "restart-complete"
fi

# Commands run under the durable SSM wrapper retain this final journal until
# the wrapper has committed its own output and done marker. The wrapper then
# acknowledges only the journal carrying its exact operation key.
if [[ -f "$BACKUP_JOURNAL" && -z "$REMOTE_OPERATION_KEY" ]]; then
  clear_backup_journal
fi

log "SUCCESS: Backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
