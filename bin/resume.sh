#!/usr/bin/env bash
set -e

echo "==========================================="
echo "  Minecraft Server Resume Script"
echo "==========================================="
echo ""
echo "This will:"
echo "  1. Create a new EBS volume (10GB GP3)"
echo "  2. Attach it to your EC2 instance"
echo "  3. Start the EC2 instance"
echo ""
echo "The instance will boot with a fresh filesystem."
echo "Use ./bin/upload-server.sh to restore your world data."
echo ""

# Find the Minecraft instance
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

# Get the availability zone
AZ=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].Placement.AvailabilityZone" \
  --output text)

echo "Instance is in availability zone: $AZ"

# Check if instance already has a volume attached
EXISTING_VOLUME=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId" \
  --output text)

if [ "$EXISTING_VOLUME" != "None" ] && [ -n "$EXISTING_VOLUME" ]; then
  echo ""
  echo "WARNING: Instance already has a volume attached: $EXISTING_VOLUME"
  read -p "Do you want to detach and delete it first? (yes/no): " delete_existing
  
  if [[ "$delete_existing" == "yes" ]]; then
    echo "Stopping instance first..."
    INSTANCE_STATE=$(aws ec2 describe-instances \
      --instance-ids "$INSTANCE_ID" \
      --query "Reservations[0].Instances[0].State.Name" \
      --output text)
    
    if [[ "$INSTANCE_STATE" == "running" ]]; then
      aws ec2 stop-instances --instance-ids "$INSTANCE_ID" > /dev/null
      echo "Waiting for instance to stop..."
      aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    fi
    
    echo "Detaching existing volume..."
    aws ec2 detach-volume --volume-id "$EXISTING_VOLUME" > /dev/null
    echo "Waiting for volume to detach..."
    aws ec2 wait volume-available --volume-ids "$EXISTING_VOLUME"
    
    echo "Deleting existing volume..."
    aws ec2 delete-volume --volume-id "$EXISTING_VOLUME"
    echo "Existing volume deleted."
  else
    echo "Keeping existing volume. Exiting."
    exit 0
  fi
fi

# Get the AMI to determine the snapshot for root volume
# For Amazon Linux 2023, we need to find the root snapshot
echo ""
echo "Looking up Amazon Linux 2023 ARM64 AMI..."
AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023*-arm64" "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text)

if [ -z "$AMI_ID" ] || [ "$AMI_ID" == "None" ]; then
  echo "Error: Could not find Amazon Linux 2023 ARM64 AMI."
  exit 1
fi

echo "Found AMI: $AMI_ID"

# Get the snapshot ID from the AMI
SNAPSHOT_ID=$(aws ec2 describe-images \
  --image-ids "$AMI_ID" \
  --query "Images[0].BlockDeviceMappings[0].Ebs.SnapshotId" \
  --output text)

if [ -z "$SNAPSHOT_ID" ] || [ "$SNAPSHOT_ID" == "None" ]; then
  echo "Error: Could not find snapshot for AMI."
  exit 1
fi

echo "Using snapshot: $SNAPSHOT_ID"

# Create a new volume from the snapshot
echo ""
echo "Creating new 10GB GP3 volume from snapshot..."
VOLUME_ID=$(aws ec2 create-volume \
  --availability-zone "$AZ" \
  --snapshot-id "$SNAPSHOT_ID" \
  --volume-type gp3 \
  --size 10 \
  --encrypted \
  --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=MinecraftServerVolume},{Key=Backup,Value=weekly}]" \
  --query "VolumeId" \
  --output text)

if [ -z "$VOLUME_ID" ] || [ "$VOLUME_ID" == "None" ]; then
  echo "Error: Failed to create volume."
  exit 1
fi

echo "Volume created: $VOLUME_ID"
echo "Waiting for volume to become available..."
aws ec2 wait volume-available --volume-ids "$VOLUME_ID"

# Attach the volume to the instance
echo ""
echo "Attaching volume to instance..."
aws ec2 attach-volume \
  --volume-id "$VOLUME_ID" \
  --instance-id "$INSTANCE_ID" \
  --device /dev/xvda > /dev/null

echo "Waiting for volume to attach..."
sleep 5  # Give it a moment to attach

# Wait for the attachment to complete
while true; do
  ATTACH_STATE=$(aws ec2 describe-volumes \
    --volume-ids "$VOLUME_ID" \
    --query "Volumes[0].Attachments[0].State" \
    --output text)
  
  if [[ "$ATTACH_STATE" == "attached" ]]; then
    break
  fi
  
  echo "Current state: $ATTACH_STATE. Waiting..."
  sleep 2
done

echo "Volume attached successfully."

# Start the instance
echo ""
echo "Starting EC2 instance..."
aws ec2 start-instances --instance-ids "$INSTANCE_ID" > /dev/null

echo "Waiting for instance to start..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# Get the public IP
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text)

echo ""
echo "==========================================="
echo "  Resume Complete!"
echo "==========================================="
echo ""
echo "Instance ID: $INSTANCE_ID"
echo "Volume ID:   $VOLUME_ID"
echo "Public IP:   $PUBLIC_IP"
echo ""
echo "The server is now running with a fresh EBS volume."
echo ""
echo "Next steps:"
echo "  1. Wait ~2 minutes for user_data script to complete setup"
echo "  2. Run: ./bin/upload-server.sh /path/to/your/local/server"
echo "  3. Connect to Minecraft!"
echo ""
echo "Note: The server will auto-configure on first boot."
echo ""
