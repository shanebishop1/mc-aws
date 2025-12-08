#!/usr/bin/env bash
set -euo pipefail

#!/usr/bin/env bash
set -euo pipefail

# Upload local server folder to EC2 via tarball + resumable transfer
# Usage: ./bin/upload-server.sh [path-to-local-server-folder]
#
# Requires: SSH key pair configured (see README)

KEY_PATH="${MC_KEY_PATH:-$HOME/.ssh/mc-aws.pem}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -o TCPKeepAlive=yes -o IPQoS=throughput -o Compression=no"
SSH_CMD=(ssh -i "$KEY_PATH" $SSH_OPTS)

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
    echo "Usage: ./bin/upload-server.sh [path-to-server-folder]"
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

echo ""
echo "========================================"
echo "  ⚠️  WARNING: This will OVERWRITE the"
echo "     server on EC2 with local files!"
echo "========================================"
echo ""
echo "  Source:      $LOCAL_SERVER"
echo "  Destination: $INSTANCE_ID ($PUBLIC_IP) via tar + rsync"
echo ""
read -p "Continue? [y/N]: " confirm

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Create tarball
echo ""
echo "Creating tarball..."
TEMP_TAR=$(mktemp -t mc-upload-XXXXXX.tar.gz)
trap 'rm -f "$TEMP_TAR"' EXIT
tar --no-xattrs --no-mac-metadata -czf "$TEMP_TAR" \
  --exclude='cache' \
  --exclude='logs' \
  -C "$(dirname "$LOCAL_SERVER")" \
  "$(basename "$LOCAL_SERVER")"
LOCAL_SHA=$(shasum -a 256 "$TEMP_TAR" | awk '{print $1}')
echo "  Tarball: $TEMP_TAR ($(du -h "$TEMP_TAR" | cut -f1))"
echo "  SHA256:  $LOCAL_SHA"

echo ""
echo "Stopping Minecraft service on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl stop minecraft.service || true"

echo "Copying tarball to remote via rsync (resumable)..."
RSYNC_FILE_OPTS=(
  -av --progress
  --partial --append-verify
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
    echo "  ✗ Transfer failed after $MAX_TRIES attempts"
    exit 1
  fi
  TRY=$((TRY + 1))
  echo "  Retrying in 5s..."
  sleep 5
done

REMOTE_SHA=$("${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sha256sum /home/ec2-user/minecraft-upload.tar.gz | awk '{print \$1}'" || true)
if [[ -z "$REMOTE_SHA" ]] || [[ "$REMOTE_SHA" != "$LOCAL_SHA" ]]; then
  echo "Error: Remote tarball checksum mismatch."
  echo "Local:  $LOCAL_SHA"
  echo "Remote: ${REMOTE_SHA:-<none>}"
  exit 1
fi
echo "  ✓ Checksums match"

echo ""
echo "Replacing server on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" << 'EOF'
set -e
sudo rm -rf /opt/minecraft/server/*
mkdir -p /home/ec2-user/minecraft-upload-tmp
tar -xzf /home/ec2-user/minecraft-upload.tar.gz -C /home/ec2-user/minecraft-upload-tmp
# Determine extracted root: if exactly one top-level dir, use its contents; otherwise move all
cd /home/ec2-user/minecraft-upload-tmp
top_items=$(find . -mindepth 1 -maxdepth 1 -type d -printf '%f\n')
count=$(echo "$top_items" | wc -w)
if [[ "$count" -eq 1 ]]; then
  dir="$top_items"
  sudo mv "/home/ec2-user/minecraft-upload-tmp/$dir"/* /opt/minecraft/server/
else
  sudo mv /home/ec2-user/minecraft-upload-tmp/* /opt/minecraft/server/
fi
sudo chown -R minecraft:minecraft /opt/minecraft/server/
rm -rf /home/ec2-user/minecraft-upload.tar.gz /home/ec2-user/minecraft-upload-tmp
EOF

echo "Starting Minecraft service..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl start minecraft.service"

echo ""
echo "Done! Server uploaded via tarball/rsync and restarted."
