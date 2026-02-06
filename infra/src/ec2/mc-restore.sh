#!/usr/bin/env bash
# Restore Minecraft server from Google Drive
# Usage: mc-restore.sh <backup-name>

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"

# Create maintenance lock to prevent idle shutdown during restore
MAINTENANCE_LOCK="/tmp/mc-maintenance.lock"
touch "$MAINTENANCE_LOCK"
trap "rm -f $MAINTENANCE_LOCK" EXIT

GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

BACKUP_NAME="${1:-}"
if [[ -z "$BACKUP_NAME" ]]; then
  log "Backup name not provided, finding latest backup..."
  # Get latest backup file from GDrive (supports .tar.gz and .gz)
  BACKUP_FILE=$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --sort time --reverse --files-only | grep -E "\.(tar\.gz|gz)$" | head -n 1)
  if [[ -z "$BACKUP_FILE" ]]; then
    log "ERROR: No backups found in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi
  log "Found latest backup: $BACKUP_FILE"
else
  # Use the backup name as-is (it includes the extension from the UI)
  BACKUP_FILE="$BACKUP_NAME"
fi

log "Starting restore from: $BACKUP_FILE"

# Stop server
log "Stopping Minecraft server..."
systemctl stop minecraft || log "Warning: Failed to stop minecraft service"

# Download from Google Drive
log "Downloading backup from Google Drive..."
rclone copy "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_FILE}" /tmp/ || {
  log "ERROR: Failed to download from Google Drive"
  systemctl start minecraft || log "Warning: Failed to restart minecraft service"
  exit 1
}

# Backup current server (just in case)
if [[ -d "$SERVER_DIR" ]]; then
  log "Backing up current server directory..."
  mv "$SERVER_DIR" "${SERVER_DIR}.backup-$(date +%Y%m%d-%H%M%S)" || log "Warning: Failed to backup current server"
fi

# Extract backup
log "Extracting backup..."
cd /opt/minecraft
tar -xzf "/tmp/${BACKUP_FILE}" || {
  log "ERROR: Failed to extract backup"
  rm -f "/tmp/${BACKUP_FILE}"
  systemctl start minecraft || log "Warning: Failed to restart minecraft service"
  exit 1
}

# Set permissions
log "Setting permissions..."
chown -R minecraft:minecraft "$SERVER_DIR" || log "Warning: Failed to set permissions"

# Cleanup
log "Cleaning up temporary files..."
rm -f "/tmp/${BACKUP_FILE}"

# Start server
log "Starting Minecraft server..."
if ! systemctl start minecraft; then
  log "ERROR: Failed to start minecraft service"
  exit 1
fi

sleep 3
if ! systemctl is-active --quiet minecraft; then
  log "ERROR: Minecraft service is not active after restore"
  systemctl status minecraft --no-pager -l || true
  exit 1
fi

log "SUCCESS: Restored from ${BACKUP_FILE}"
