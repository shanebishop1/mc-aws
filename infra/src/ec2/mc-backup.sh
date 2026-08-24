#!/usr/bin/env bash
# Backup Minecraft server to Google Drive
# Usage: mc-backup.sh [backup-name]
# If no name provided, use timestamp

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

restart_minecraft_or_fail() {
  local context="$1"
  log "Restarting Minecraft server (${context})..."
  if ! systemctl start minecraft; then
    log "ERROR: Restart failed after ${context}"
    return 1
  fi

  log "Minecraft server restart succeeded (${context})"
}

export RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/setup/rclone/rclone.conf}"

# Create operation lock to prevent concurrent backup/restore operations
OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
if [ -f "$OPERATION_LOCK" ]; then
  LOCK_PID="$(cat "$OPERATION_LOCK" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "ERROR: Another operation is in progress"
    exit 1
  fi

  log "Found stale operation lock. Cleaning up..."
  rm -f "$OPERATION_LOCK"
fi
echo "$$" > "$OPERATION_LOCK"

# Create maintenance lock to prevent idle shutdown during backup
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/tmp/mc-maintenance.lock}"
touch "$MAINTENANCE_LOCK"
cleanup() {
  rm -f -- "$OPERATION_LOCK" "$MAINTENANCE_LOCK"
}
trap cleanup EXIT

BACKUP_NAME="${1:-server-$(date +%Y%m%d-%H%M%S)}"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="${MC_SERVER_DIR:-/opt/minecraft/server}"
SERVER_PARENT="$(dirname -- "$SERVER_DIR")"
BACKUP_TEMP_DIR="${MC_BACKUP_TEMP_DIR:-/tmp}"
BACKUP_ARCHIVE="${BACKUP_TEMP_DIR}/${BACKUP_NAME}.tar.gz"

if [[ ! "$BACKUP_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  log "ERROR: Invalid backup name: $BACKUP_NAME"
  exit 1
fi
if [[ "$(basename -- "$SERVER_DIR")" != "server" || ! -d "$SERVER_PARENT" || ! -d "$BACKUP_TEMP_DIR" ]]; then
  log "ERROR: Backup paths must use an existing parent with a server child and existing temp directory"
  exit 1
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

log "Validating server tree before downtime..."
if ! validate_server_tree; then
  log "ERROR: Server tree contains entries that cannot be safely restored"
  exit 1
fi

# Stop server gracefully
log "Stopping Minecraft server..."
if ! systemctl stop minecraft; then
  log "ERROR: Failed to stop minecraft service"
  systemctl start minecraft || log "CRITICAL: Failed to ensure minecraft service is running"
  exit 1
fi

# Close the validation/archive race while the service is stopped.
if ! validate_server_tree; then
  log "ERROR: Server tree changed to contain an unsupported entry before archiving"
  restart_minecraft_or_fail "validation failure recovery" || log "CRITICAL: minecraft service remains down"
  exit 1
fi

# Create tar archive
log "Creating tar archive..."
cd "$SERVER_PARENT"
tar -czf "$BACKUP_ARCHIVE" server/ || {
  log "ERROR: Failed to create tar archive"
  restart_minecraft_or_fail "tar failure recovery" || log "CRITICAL: minecraft service remains down"
  exit 1
}

if ! validate_backup_archive; then
  log "ERROR: Produced archive does not satisfy the restore contract"
  rm -f "$BACKUP_ARCHIVE"
  restart_minecraft_or_fail "archive validation failure recovery" || log "CRITICAL: minecraft service remains down"
  exit 1
fi

# Upload to Google Drive
log "Uploading to Google Drive..."
rclone copy "$BACKUP_ARCHIVE" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" || {
  log "ERROR: Failed to upload to Google Drive"
  rm -f "$BACKUP_ARCHIVE"
  restart_minecraft_or_fail "upload failure recovery" || log "CRITICAL: minecraft service remains down"
  exit 1
}

# Cleanup
log "Cleaning up temporary files..."
rm -f "$BACKUP_ARCHIVE"

# Restart server
if ! restart_minecraft_or_fail "post-backup"; then
  log "PARTIAL FAILURE: Backup ${BACKUP_NAME}.tar.gz uploaded, but minecraft restart failed"
  exit 1
fi

log "SUCCESS: Backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
