#!/usr/bin/env bash
set -euo pipefail

# Upload local server folder to EC2, with optional Google Drive intermediary.
# Usage: ./bin/upload-server.sh [--mode local|drive] [path-to-local-server-folder]
#
# Modes:
#   local (default): tar + rsync over SSH
#   drive: tar -> rclone upload to Drive -> rclone download on EC2 -> apply
#
# Requires: SSH key pair (MC_KEY_PATH or ~/.ssh/mc-aws.pem). For drive mode, a Drive
# token secret in AWS (GDRIVE_TOKEN_SECRET_ARN) and rclone installed locally.

# Source .env if it exists
if [[ -f "$(dirname "$0")/../.env" ]]; then
  set +o nounset
  source "$(dirname "$0")/../.env"
  set -o nounset
fi

KEY_PATH="${MC_KEY_PATH:-$HOME/.ssh/mc-aws.pem}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o TCPKeepAlive=yes -o IPQoS=throughput -o Compression=no"
SSH_CMD=(ssh -i "$KEY_PATH" $SSH_OPTS)
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
GDRIVE_TOKEN_SECRET_ARN="${GDRIVE_TOKEN_SECRET_ARN:-}"
MODE="local"

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-local}"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]}"

# Prompt for mode if not provided
if [[ "$MODE" == "local" && -z "${1-}" ]]; then
  echo ""
  echo "Choose upload mode:"
  echo "  1) local (tar + rsync over SSH) [default]"
  echo "  2) drive (tar -> Drive -> EC2 via rclone)"
read -p "Mode [1/2]: " mode_choice
case "$mode_choice" in
  2) MODE="drive" ;;
  *) MODE="local" ;;
esac
fi

# Function to find server folders under backups
find_server_folders() {
  local folders=()
  if [[ -d "./backups" ]]; then
    for dir in ./backups/server*/; do
      if [[ -d "$dir" ]]; then
        folders+=("${dir%/}")
      fi
    done
  fi
  echo "${folders[@]}"
}

# Resolve local server path
USER_ARG="${1-}"
if [[ -z "${USER_ARG}" ]]; then
  IFS=' ' read -ra SERVER_FOLDERS <<< "$(find_server_folders)"

  if [[ ${#SERVER_FOLDERS[@]} -eq 0 ]]; then
    echo "Error: No server folders found."
    echo "Expected ./backups/server-*/"
    echo ""
    echo "Usage: ./bin/upload-server.sh [--mode local|drive] [path-to-server-folder]"
    exit 1
  elif [[ ${#SERVER_FOLDERS[@]} -eq 1 ]]; then
    LOCAL_SERVER="${SERVER_FOLDERS[0]}"
  else
    echo "Multiple server folders found:"
    echo ""
    for i in "${!SERVER_FOLDERS[@]}"; do
      echo "  $((i+1))) ${SERVER_FOLDERS[$i]}"
    done
    echo ""
read -p "Which one to upload? [1-${#SERVER_FOLDERS[@]}]: " choice

    if [[ ! "$choice" =~ ^[0-9]+$ ]] || [[ "$choice" -lt 1 ]] || [[ "$choice" -gt ${#SERVER_FOLDERS[@]} ]]; then
      echo "Invalid choice."
      exit 1
    fi
    LOCAL_SERVER="${SERVER_FOLDERS[$((choice-1))]}"
  fi
else
  LOCAL_SERVER="$USER_ARG"
fi

if [[ ! -d "$LOCAL_SERVER" ]]; then
  echo "Error: Local server folder not found: $LOCAL_SERVER"
  exit 1
fi

if [[ ! -f "$KEY_PATH" ]]; then
  echo "Error: SSH key not found: $KEY_PATH"
  echo ""
  echo "To set up SSH access:"
  echo "  1. Create a key pair in AWS Console: EC2 -> Key Pairs -> Create"
  echo "  2. Save the .pem file to ~/.ssh/mc-aws.pem"
  echo "  3. Add KEY_PAIR_NAME=\"your-key-name\" to .env"
  echo "  4. Run: npm run deploy"
  echo ""
  echo "Or set MC_KEY_PATH to your existing key location."
  exit 1
fi

# Ensure rclone config when using Drive
TMP_RCLONE_CONF=""
cleanup_rclone_conf() {
  if [[ -n "$TMP_RCLONE_CONF" && -f "$TMP_RCLONE_CONF" ]]; then
    rm -f "$TMP_RCLONE_CONF"
  fi
}

setup_rclone_conf() {
  if [[ "$MODE" != "drive" ]]; then
    return
  fi
  if [[ -n "${RCLONE_CONFIG:-}" ]]; then
    return
  fi
  if [[ -z "$GDRIVE_TOKEN_SECRET_ARN" ]]; then
    echo "Error: GDRIVE_TOKEN_SECRET_ARN is required for --mode drive."
    exit 1
  fi
  TOKEN_JSON=$(aws secretsmanager get-secret-value --secret-id "$GDRIVE_TOKEN_SECRET_ARN" --query SecretString --output text 2>/dev/null || echo "")
  if [[ -z "$TOKEN_JSON" ]]; then
    echo "Error: Unable to fetch Drive token from $GDRIVE_TOKEN_SECRET_ARN"
    exit 1
  fi
  TMP_RCLONE_CONF=$(mktemp)
  cat > "$TMP_RCLONE_CONF" <<EOF
[${GDRIVE_REMOTE}]
type = drive
token = ${TOKEN_JSON}
EOF
  export RCLONE_CONFIG="$TMP_RCLONE_CONF"
  trap 'cleanup_rclone_conf' EXIT
}

# Find running instance
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MinecraftStack" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

if [[ "$INSTANCE_ID" == "None" ]] || [[ -z "$INSTANCE_ID" ]]; then
  echo "Error: No running Minecraft server found."
  echo "Start the server first, then run this script."
  exit 1
fi

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text)

# Idle-check helpers (no-op until PUBLIC_IP is set)
disable_idle_check() {
  echo ""
  echo "Disabling idle-check (prevents auto-shutdown during transfer)..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" \
    "sudo mv /etc/cron.d/minecraft-idle /etc/cron.d/minecraft-idle.disabled 2>/dev/null || true; sudo rm -f /tmp/mc-idle.marker"
}

reenable_idle_check() {
  echo ""
  echo "Re-enabling idle-check..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" \
    "sudo mv /etc/cron.d/minecraft-idle.disabled /etc/cron.d/minecraft-idle 2>/dev/null || true; sudo rm -f /tmp/mc-idle.marker" \
    2>/dev/null || true
}

# Ensure idle-check gets re-enabled even on error
trap 'reenable_idle_check' EXIT

echo ""
echo "========================================"
echo "  ⚠️  WARNING: This will OVERWRITE the"
echo "     server on EC2 with local files!"
echo "========================================"
echo ""
echo "  Source:      $LOCAL_SERVER"
echo "  Destination: $INSTANCE_ID ($PUBLIC_IP) via ${MODE}"
if [[ "$MODE" == "drive" ]]; then
  echo "  Drive remote: ${GDRIVE_REMOTE:-gdrive}"
fi
echo ""
read -p "Continue? [y/yes]: " confirm

if [[ ! "$confirm" =~ ^[Yy](es)?$ ]]; then
  echo "Aborted."
  exit 0
fi

# Create tarball
echo ""
echo "Creating tarball..."
TEMP_TAR=$(mktemp -t mc-upload-XXXXXX.tar.gz)
trap 'rm -f "$TEMP_TAR"; cleanup_rclone_conf' EXIT
tar --no-xattrs --no-mac-metadata -czf "$TEMP_TAR" \
  --exclude='cache' \
  --exclude='logs' \
  -C "$(dirname "$LOCAL_SERVER")" \
  "$(basename "$LOCAL_SERVER")"
LOCAL_SHA=$(shasum -a 256 "$TEMP_TAR" | awk '{print $1}')
echo "  Tarball: $TEMP_TAR ($(du -h "$TEMP_TAR" | cut -f1))"
echo "  SHA256:  $LOCAL_SHA"

disable_idle_check

echo ""
echo "Stopping Minecraft service on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl stop minecraft.service || true"

if [[ "$MODE" == "drive" ]]; then
  setup_rclone_conf
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  DRIVE_PATH="${GDRIVE_ROOT}/server-${TIMESTAMP}.tar.gz"
  echo "Uploading tarball to Drive: ${GDRIVE_REMOTE}:${DRIVE_PATH}"
  rclone copy "$TEMP_TAR" "${GDRIVE_REMOTE}:${DRIVE_PATH}" --progress
  echo "  ✓ Uploaded to Drive"

  echo "Downloading tarball from Drive on remote..."
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" \
    "RCLONE_CONFIG=/opt/setup/rclone/rclone.conf rclone copy ${GDRIVE_REMOTE}:${DRIVE_PATH} /home/ec2-user/ --progress"
  REMOTE_TAR="/home/ec2-user/server-${TIMESTAMP}.tar.gz"
  REMOTE_SHA=$("${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sha256sum ${REMOTE_TAR} | awk '{print \$1}'" || true)
else
  echo "Copying tarball to remote via rsync (resumable)..."
  # Ensure old tar is cleared before transfer to avoid append/corruption
  "${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "rm -f /home/ec2-user/minecraft-upload.tar.gz"
  RSYNC_FILE_OPTS=(
    -av --progress
    --partial --inplace
    --timeout=300
    -e "${SSH_CMD[*]}"
    "$TEMP_TAR"
    ec2-user@"$PUBLIC_IP":/home/ec2-user/minecraft-upload.tar.gz
  )

  MAX_TRIES=8
  TRY=1
  while true; do
    echo "  Attempt $TRY/$MAX_TRIES..."
    if rsync "${RSYNC_FILE_OPTS[@]}"; then
      echo "  ✓ Transfer completed"
      break
    fi
    if [[ "$TRY" -ge "$MAX_TRIES" ]]; then
      echo "  ✗ Rsync failed after $MAX_TRIES attempts"
      exit 1
    fi
    TRY=$((TRY + 1))
    echo "  Retrying in 5s..."
    sleep 5
  done

  REMOTE_TAR="/home/ec2-user/minecraft-upload.tar.gz"
  REMOTE_SHA=$("${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sha256sum ${REMOTE_TAR} | awk '{print \$1}'" || true)
fi

if [[ -z "$REMOTE_SHA" ]] || [[ "$REMOTE_SHA" != "$LOCAL_SHA" ]]; then
  echo "Error: Remote tarball checksum mismatch."
  echo "Local:  $LOCAL_SHA"
  echo "Remote: ${REMOTE_SHA:-<none>}"
  exit 1
fi
echo "  ✓ Checksums match"

echo ""
echo "Replacing server on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" << EOF
set -e
sudo find /opt/minecraft/server -mindepth 1 -maxdepth 1 -exec rm -rf {} +
mkdir -p /home/ec2-user/minecraft-upload-tmp
tar -xzf ${REMOTE_TAR} -C /home/ec2-user/minecraft-upload-tmp
cd /home/ec2-user/minecraft-upload-tmp
shopt -s dotglob nullglob
dirs=(*/)
if [[ \${#dirs[@]} -eq 1 && -d "\${dirs[0]}" ]]; then
  sudo mv "\${dirs[0]}"* /opt/minecraft/server/
else
  sudo mv ./* /opt/minecraft/server/
fi
sudo chown -R minecraft:minecraft /opt/minecraft/server/
rm -rf ${REMOTE_TAR} /home/ec2-user/minecraft-upload-tmp
EOF

echo "Starting Minecraft service..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl start minecraft.service"

echo ""
echo "Done! Server uploaded via ${MODE} and restarted."
