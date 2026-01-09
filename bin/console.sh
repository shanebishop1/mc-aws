#!/usr/bin/env bash
# ============================================================================
# UTILITY SCRIPT
# ============================================================================
# This script provides interactive terminal access and has no API equivalent.
# It is NOT deprecated and remains the recommended way to access the Minecraft
# server console via screen.
#
# Usage: ./bin/console.sh
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

echo "Connecting to Minecraft Console on $INSTANCE_ID..."
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartInteractiveCommand \
  --parameters '{"command":["sudo -u minecraft screen -xRR mc-server"]}'
