#!/usr/bin/env bash
# ============================================================================
# PARTIAL DEPRECATION NOTICE
# ============================================================================
# This script is PARTIALLY DEPRECATED in favor of the API-first architecture.
#
# Drive backup mode is deprecated:
#   - Web UI: http://localhost:3000 (backup tab)
#   - CLI: pnpm server:backup (from frontend/ directory)
#   - API: POST /api/backup
#
# Local backup mode remains available for developer use:
#   - Downloads server data to ./backups/ via rsync
#   - No API equivalent exists for this use case
#
# This script remains functional but is no longer maintained as the primary
# interface for Google Drive operations.
# ============================================================================

set -euo pipefail

# Download server folder from EC2 to local backups, or push a backup to Google Drive.
# Usage: ./bin/backup-from-ec2.sh [--mode local|drive]
#
# Modes:
#   local (default): rsync /opt/minecraft/server -> ./backups/server-<timestamp>/
#   drive: tar on EC2 and rclone copy to Drive (no local download)

KEY_PATH="${MC_KEY_PATH:-$HOME/.ssh/mc-aws.pem}"
SSH_CMD=(ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no)
MODE="local"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-local}"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--mode local|drive]"
      exit 1
      ;;
  esac
done

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Error: SSH key not found: $KEY_PATH"
  exit 1
fi

# Prompt for mode if not provided
if [[ "$MODE" == "local" ]]; then
  echo ""
  echo "Choose download mode:"
  echo "  1) local (rsync to ./backups) [default]"
  echo "  2) google drive (tar on EC2 -> Google Drive)"
read -p "Mode [1/2]: " mode_choice
case "$mode_choice" in
  2) MODE="drive" ;;
  *) MODE="local" ;;
esac
fi

# Find running instance
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MinecraftStack" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

if [[ "$INSTANCE_ID" == "None" ]] || [[ -z "$INSTANCE_ID" ]]; then
  echo "Error: No running Minecraft server found."
  exit 1
fi

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text)

echo "Found server: $INSTANCE_ID at $PUBLIC_IP (mode: $MODE)"

# Locate server directory on remote
REMOTE_SERVER_DIR=$("${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "if [ -d /opt/minecraft/server ]; then echo /opt/minecraft/server; else echo ''; fi")
if [[ -z "$REMOTE_SERVER_DIR" ]]; then
  echo "Error: Remote server directory not found (expected /opt/minecraft/server)." >&2
  exit 1
fi
REMOTE_SERVER_PARENT=$(dirname "$REMOTE_SERVER_DIR")
REMOTE_SERVER_NAME=$(basename "$REMOTE_SERVER_DIR")
echo "Remote server directory: $REMOTE_SERVER_DIR"

if [[ "$MODE" == "local" ]]; then
  # Prepare local backup dir with timestamped name
  BACKUP_ROOT="./backups"
  mkdir -p "$BACKUP_ROOT"
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  LOCAL_DIR="$BACKUP_ROOT/server-$TIMESTAMP"
  COUNTER=2
  while [[ -d "$LOCAL_DIR" ]]; do
    LOCAL_DIR="$BACKUP_ROOT/server-$TIMESTAMP-$COUNTER"
    COUNTER=$((COUNTER + 1))
  done

  echo "Stopping minecraft.service on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl stop minecraft || true"

  echo "Downloading to $LOCAL_DIR..."
  mkdir -p "$LOCAL_DIR"

  rsync -av --progress \
    --exclude 'cache/' \
    --exclude 'logs/' \
    --rsync-path="sudo rsync" \
    -e "${SSH_CMD[*]}" \
    ec2-user@"$PUBLIC_IP":"${REMOTE_SERVER_DIR}/" \
    "$LOCAL_DIR/"

  echo "Starting minecraft.service on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl start minecraft || true"

  echo ""
  echo "Done! Server downloaded to: $LOCAL_DIR"
else
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  REMOTE_TAR="/home/ec2-user/server-${TIMESTAMP}.tar.gz"
  DRIVE_PATH="${GDRIVE_ROOT}/server-${TIMESTAMP}.tar.gz"

  echo "Stopping minecraft.service on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl stop minecraft || true"

  echo "Creating tarball on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" \
    "sudo tar -czf ${REMOTE_TAR} --exclude='cache' --exclude='logs' -C ${REMOTE_SERVER_PARENT} ${REMOTE_SERVER_NAME} && sudo chown ec2-user:ec2-user ${REMOTE_TAR}"

  echo "Uploading tarball to Drive from remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" \
    "RCLONE_CONFIG=/opt/setup/rclone/rclone.conf rclone copy ${REMOTE_TAR} ${GDRIVE_REMOTE}:${DRIVE_PATH} --progress"

  echo "Cleaning up remote tar..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "rm -f ${REMOTE_TAR}"

  echo "Starting minecraft.service on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl start minecraft || true"

  echo ""
  echo "Done! Server tar stored at: ${GDRIVE_REMOTE}:${DRIVE_PATH}"
fi
