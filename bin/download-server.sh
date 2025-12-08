#!/usr/bin/env bash
set -euo pipefail

# Download server folder from EC2 to local
# Usage: ./bin/download-server.sh
#
# Requires: SSH key pair configured (see README)

KEY_PATH="${MC_KEY_PATH:-$HOME/.ssh/mc-aws.pem}"

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

echo "Found server: $INSTANCE_ID at $PUBLIC_IP"

# SSH command used for both stop/start and rsync transport
SSH_CMD=(ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no)

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

# Stop minecraft to avoid copying mutating files
echo "Stopping minecraft.service on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl stop minecraft || true"

echo "Downloading to $LOCAL_DIR..."
mkdir -p "$LOCAL_DIR"

# Sync remote to local with sudo on remote to avoid permission skips
rsync -av --progress \
  --exclude 'cache/' \
  --exclude 'logs/' \
  --rsync-path="sudo rsync" \
  -e "${SSH_CMD[*]}" \
  ec2-user@"$PUBLIC_IP":/opt/minecraft/server/ \
  "$LOCAL_DIR/"

echo "Starting minecraft.service on remote..."
"${SSH_CMD[@]}" ec2-user@"$PUBLIC_IP" "sudo systemctl start minecraft || true"

echo ""
echo "Done! Server downloaded to: $LOCAL_DIR"
