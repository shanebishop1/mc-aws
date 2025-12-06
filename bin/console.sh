#!/usr/bin/env bash
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
  --parameters command="sudo -u minecraft bash -c 'screen -xRR mc-server'"
