#!/usr/bin/env bash
# Backup Minecraft server to Google Drive
# Usage: mc-backup.sh [backup-name]
# If no name provided, use timestamp

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"

# Create operation lock to prevent concurrent backup/restore operations
OPERATION_LOCK="/tmp/mc-operation.lock"
if [ -f "$OPERATION_LOCK" ]; then
  log "ERROR: Another operation is in progress"
  exit 1
fi
echo "$$" > "$OPERATION_LOCK"

# Create maintenance lock to prevent idle shutdown during backup
MAINTENANCE_LOCK="/tmp/mc-maintenance.lock"
touch "$MAINTENANCE_LOCK"
trap "rm -f $OPERATION_LOCK $MAINTENANCE_LOCK" EXIT

BACKUP_NAME="${1:-server-$(date +%Y%m%d-%H%M%S)}"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

log "Starting backup: $BACKUP_NAME"

# Stop server gracefully
log "Stopping Minecraft server..."
systemctl stop minecraft || log "Warning: Failed to stop minecraft service"

# Create tar archive
log "Creating tar archive..."
cd /opt/minecraft
tar -czf "/tmp/${BACKUP_NAME}.tar.gz" server/ || {
  log "ERROR: Failed to create tar archive"
  systemctl start minecraft || log "Warning: Failed to restart minecraft service"
  exit 1
}

# Upload to Google Drive
log "Uploading to Google Drive..."
rclone copy "/tmp/${BACKUP_NAME}.tar.gz" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" || {
  log "ERROR: Failed to upload to Google Drive"
  rm -f "/tmp/${BACKUP_NAME}.tar.gz"
  systemctl start minecraft || log "Warning: Failed to restart minecraft service"
  exit 1
}

# Cleanup
log "Cleaning up temporary files..."
rm -f "/tmp/${BACKUP_NAME}.tar.gz"

# Restart server
log "Restarting Minecraft server..."
systemctl start minecraft || log "Warning: Failed to restart minecraft service"

log "SUCCESS: Backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
