#!/usr/bin/env bash
set -e

echo "==========================================="
echo "  Minecraft Server Hibernation Script"
echo "==========================================="
echo ""
echo "This will:"
echo "  1. Stop the Minecraft EC2 instance"
echo "  2. Detach and delete the EBS volume"
echo ""
echo "WARNING: Make sure you have downloaded your world data first!"
echo "         Use ./bin/backup-from-ec2.sh to backup your world."
echo ""
read -p "Continue? [y/yes]: " confirm
if [[ ! "$confirm" =~ ^[Yy](es)?$ ]]; then
  echo "Aborted."
  exit 0
fi

# Find the Minecraft instance
echo ""
echo "Finding Minecraft instance..."
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MinecraftStack" "Name=instance-state-name,Values=running,stopped" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text)

if [ "$INSTANCE_ID" == "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "Error: No Minecraft instance found in MinecraftStack."
  exit 1
fi

echo "Found instance: $INSTANCE_ID"

# Get the current instance state
INSTANCE_STATE=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].State.Name" \
  --output text)

echo "Current state: $INSTANCE_STATE"

# Stop the instance if it's running
if [[ "$INSTANCE_STATE" == "running" ]]; then
  echo ""
  echo "Stopping instance..."
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID" > /dev/null
  echo "Waiting for instance to stop..."
  aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
  echo "Instance stopped."
elif [[ "$INSTANCE_STATE" != "stopped" ]]; then
  echo "Error: Instance is in state '$INSTANCE_STATE'. Must be 'running' or 'stopped'."
  exit 1
else
  echo "Instance already stopped."
fi

# Get the root volume ID
echo ""
echo "Finding EBS volume..."
VOLUME_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId" \
  --output text)

if [ -z "$VOLUME_ID" ] || [ "$VOLUME_ID" == "None" ]; then
  echo "Error: No EBS volume found attached to instance."
  exit 1
fi

echo "Found volume: $VOLUME_ID"

# Detach the volume
echo ""
echo "Detaching volume..."
aws ec2 detach-volume \
  --volume-id "$VOLUME_ID" > /dev/null

echo "Waiting for volume to detach..."
aws ec2 wait volume-available --volume-ids "$VOLUME_ID"
echo "Volume detached."

# Delete the volume
echo ""
echo "Deleting volume..."
aws ec2 delete-volume --volume-id "$VOLUME_ID"
echo "Volume deleted."

echo ""
echo "==========================================="
echo "  Hibernation Complete!"
echo "==========================================="
echo ""
echo "Your EC2 instance is now stopped with no EBS volume."
echo "You are no longer paying for Minecraft server storage on AWS."
echo ""
echo "To resume later, run: ./bin/resume.sh"
echo ""
