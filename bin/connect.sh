#!/usr/bin/env bash
# ============================================================================
# UTILITY SCRIPT
# ============================================================================
# This script provides interactive terminal access and has no API equivalent.
# It is NOT deprecated and remains the recommended way to access SSH.
#
# Usage: ./bin/connect.sh
# ============================================================================

set -e

# Find the running Minecraft instance
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MinecraftStack" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

if [ "$INSTANCE_ID" == "None" ]; then
  echo "Error: No running Minecraft server found."
  exit 1
fi

echo "Connecting to $INSTANCE_ID..."
echo "----------------------------------------------------------------"
echo "You are logging in as 'ssm-user' (Admin)."
echo "To go to the server directory:"
echo "  cd /opt/minecraft/server"
echo "----------------------------------------------------------------"
# Start a standard session (logs in as ssm-user with sudo privileges)
aws ssm start-session --target "$INSTANCE_ID"
