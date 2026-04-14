#!/usr/bin/env bash
# Restore Minecraft server from Google Drive
# Usage: mc-restore.sh <latest|backup-archive>

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"

# Create operation lock to prevent concurrent backup/restore operations
OPERATION_LOCK="/tmp/mc-operation.lock"
if [[ -f "$OPERATION_LOCK" ]]; then
  LOCK_PID="$(cat "$OPERATION_LOCK" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "ERROR: Another operation is in progress"
    exit 1
  fi

  log "Found stale operation lock. Cleaning up..."
  rm -f "$OPERATION_LOCK"
fi
echo "$$" > "$OPERATION_LOCK"

# Create maintenance lock to prevent idle shutdown during restore
MAINTENANCE_LOCK="/tmp/mc-maintenance.lock"
touch "$MAINTENANCE_LOCK"
trap "rm -f $OPERATION_LOCK $MAINTENANCE_LOCK" EXIT

GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

BACKUP_REF="${1:-latest}"
if [[ "$BACKUP_REF" == "latest" ]]; then
  log "Latest backup requested, finding latest backup file..."
  # Get latest backup file from GDrive (supports .tar.gz and .gz)
  BACKUP_FILE=$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --sort time --reverse --files-only | grep -E "\.(tar\.gz|gz)$" | head -n 1)
  if [[ -z "$BACKUP_FILE" ]]; then
    log "ERROR: No backups found in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi
  log "Found latest backup: $BACKUP_FILE"
else
  # Named restore: use explicit archive filename. Back-compat: add .tar.gz when no extension is provided.
  if [[ "$BACKUP_REF" =~ \.(tar\.gz|gz)$ ]]; then
    BACKUP_FILE="$BACKUP_REF"
  else
    BACKUP_FILE="${BACKUP_REF}.tar.gz"
  fi
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
