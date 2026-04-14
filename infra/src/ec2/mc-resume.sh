#!/usr/bin/env bash
# Resume server after instance boot
# Usage: mc-resume.sh <fresh|latest|named> [backup-archive]
# Note: This runs on boot via user_data if "resume" flag is set

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"

# Create maintenance lock to prevent idle shutdown during resume
MAINTENANCE_LOCK="/tmp/mc-maintenance.lock"
touch "$MAINTENANCE_LOCK"
trap "rm -f $MAINTENANCE_LOCK" EXIT

RESTORE_MODE="${1:-fresh}"
BACKUP_NAME="${2:-}"

log "Starting resume process"

if [[ "$RESTORE_MODE" != "fresh" && "$RESTORE_MODE" != "latest" && "$RESTORE_MODE" != "named" ]]; then
  # Backward compatibility for legacy invocation: mc-resume.sh <backup-archive>
  BACKUP_NAME="$RESTORE_MODE"
  RESTORE_MODE="named"
fi

case "$RESTORE_MODE" in
  fresh)
    log "Fresh resume requested (no restore)"
    ;;
  latest)
    log "Latest-backup resume requested"
    ;;
  named)
    if [[ -z "$BACKUP_NAME" ]]; then
      log "ERROR: Backup archive name is required for named resume"
      exit 1
    fi
    log "Named-backup resume requested: $BACKUP_NAME"
    ;;
esac

if [[ "$RESTORE_MODE" == "latest" ]]; then
  log "Restoring latest backup..."
  /usr/local/bin/mc-restore.sh latest || {
    log "ERROR: Latest backup restore failed"
    exit 1
  }
fi

if [[ "$RESTORE_MODE" == "named" ]]; then
  log "Restoring named backup..."
  /usr/local/bin/mc-restore.sh "$BACKUP_NAME" || {
    log "ERROR: Named backup restore failed"
    exit 1
  }
fi

log "Starting Minecraft server service..."
if ! systemctl start minecraft; then
  log "ERROR: Failed to start minecraft service"
  exit 1
fi

sleep 3
if ! systemctl is-active --quiet minecraft; then
  log "ERROR: Minecraft service is not active after resume"
  systemctl status minecraft --no-pager -l || true
  exit 1
fi

log "SUCCESS: Resume completed (${RESTORE_MODE})"
