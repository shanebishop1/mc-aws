#!/usr/bin/env bash
# Hibernate server: backup to Drive
# EC2 stop/detach/delete volume operations are handled by Lambda
# Usage: mc-hibernate.sh [backup-name]

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"

BACKUP_NAME="${1:-hibernate-$(date +%Y%m%d-%H%M%S)}"

log "Starting hibernation with backup: $BACKUP_NAME"

# Run backup first
log "Running backup..."
/usr/local/bin/mc-backup.sh "$BACKUP_NAME" || {
  log "ERROR: Backup failed"
  exit 1
}

log "SUCCESS: Hibernation backup ${BACKUP_NAME}.tar.gz completed. Lambda will handle EC2 stop and volume cleanup."
