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

BACKUP_NAME="$1"
if [[ -z "$BACKUP_NAME" ]]; then
  log "ERROR: Backup name required"
  exit 1
fi

GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

log "Starting restore from: $BACKUP_NAME"

# Stop server
log "Stopping Minecraft server..."
systemctl stop minecraft || log "Warning: Failed to stop minecraft service"

# Download from Google Drive
log "Downloading backup from Google Drive..."
rclone copy "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_NAME}.tar.gz" /tmp/ || {
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
tar -xzf "/tmp/${BACKUP_NAME}.tar.gz" || {
  log "ERROR: Failed to extract backup"
  rm -f "/tmp/${BACKUP_NAME}.tar.gz"
  systemctl start minecraft || log "Warning: Failed to restart minecraft service"
  exit 1
}

# Set permissions
log "Setting permissions..."
chown -R minecraft:minecraft "$SERVER_DIR" || log "Warning: Failed to set permissions"

# Cleanup
log "Cleaning up temporary files..."
rm -f "/tmp/${BACKUP_NAME}.tar.gz"

# Start server
log "Starting Minecraft server..."
systemctl start minecraft || log "Warning: Failed to start minecraft service"

log "SUCCESS: Restored from ${BACKUP_NAME}.tar.gz"
