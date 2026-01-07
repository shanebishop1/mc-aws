#!/usr/bin/env bash
# Resume server: create new EBS, start EC2, restore from Drive
# Usage: mc-resume.sh [backup-name]
# Note: This runs on boot via user_data if "resume" flag is set

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

BACKUP_NAME="${1:-}"

log "Starting resume process"

# If no backup specified, find the latest
if [[ -z "$BACKUP_NAME" ]]; then
  log "No backup specified, finding latest..."
  GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
  GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
  
  # List backups and get latest
  BACKUP_NAME=$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" \
    | grep '.tar.gz$' \
    | sort -r \
    | head -1 \
    | sed 's/.tar.gz$//' || true)
fi

if [[ -z "$BACKUP_NAME" ]]; then
  log "ERROR: No backups found in Google Drive"
  exit 1
fi

log "Using backup: $BACKUP_NAME"

# Restore from backup
log "Restoring from backup..."
/usr/local/bin/mc-restore.sh "$BACKUP_NAME" || {
  log "ERROR: Restore failed"
  exit 1
}

log "SUCCESS: Resumed from ${BACKUP_NAME}.tar.gz"
