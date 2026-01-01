#!/usr/bin/env bash
set -euo pipefail

# One-time helper to get a Google Drive OAuth token via rclone and store it in AWS Secrets Manager.
# Usage: ./bin/setup-drive-token.sh
#
# Prereqs:
# - rclone installed locally (for the OAuth flow)
# - AWS CLI configured with credentials that can write Secrets Manager
# - .env loaded (for AWS account/region), or pass AWS env vars explicitly
#
# After running, add the printed secret ARN to .env as GDRIVE_TOKEN_SECRET_ARN.

SECRET_NAME_DEFAULT="/minecraft/rclone-drive-token"
SECRET_NAME="${GDRIVE_TOKEN_SECRET_NAME:-$SECRET_NAME_DEFAULT}"
REGION="${CDK_DEFAULT_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-1}}}"

command -v rclone >/dev/null 2>&1 || { echo "rclone is required. Install it (e.g., brew install rclone) and rerun."; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required. Install/configure it and rerun."; exit 1; }

echo "Starting rclone OAuth flow for Google Drive..."
# Grab the first line that looks like JSON from rclone output
TOKEN_JSON=$(rclone authorize "drive" 2>/dev/null | grep -m1 '{.*}')

# If we still don't have JSON, prompt to paste manually
if [[ -z "$TOKEN_JSON" || "$TOKEN_JSON" != \{* ]]; then
  echo "Couldn't detect a token JSON automatically. Paste the token JSON from rclone (single line):"
  read -r TOKEN_JSON
fi

if [[ -z "$TOKEN_JSON" || "$TOKEN_JSON" != \{* ]]; then
  echo "Failed to obtain token JSON (empty or not JSON)."
  exit 1
fi

echo "Storing token in Secrets Manager: $SECRET_NAME (region: $REGION)..."
aws secretsmanager create-secret \
  --name "$SECRET_NAME" \
  --secret-string "$TOKEN_JSON" \
  --region "$REGION" >/dev/null 2>&1 || \
aws secretsmanager put-secret-value \
  --secret-id "$SECRET_NAME" \
  --secret-string "$TOKEN_JSON" \
  --region "$REGION" >/dev/null

ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" --query ARN --output text)

echo ""
echo "Done. Add this to your .env:"
echo "GDRIVE_TOKEN_SECRET_ARN=\"$ARN\""
echo "GDRIVE_REMOTE=\"gdrive\"        # optional, default shown"
echo "GDRIVE_ROOT=\"mc-backups\"      # optional, default shown"

read -p "Write these values into .env now? [y/yes]: " save_env
if [[ "$save_env" =~ ^[Yy](es)?$ ]]; then
  if [[ -f .env ]]; then
    {
      echo ""
      echo "# Google Drive token (added by setup-drive-token.sh)";
      echo "GDRIVE_TOKEN_SECRET_ARN=\"$ARN\"";
      echo "GDRIVE_REMOTE=\"gdrive\"";
      echo "GDRIVE_ROOT=\"mc-backups\"";
    } >> .env
    echo "Appended to .env"
  else
    echo ".env not found; please add the values manually."
  fi
fi

# Configure rclone on the running EC2 instance (if one exists)
echo ""
echo "Checking for running Minecraft EC2 instance..."
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=MinecraftStack" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text 2>/dev/null || echo "None")

if [[ "$INSTANCE_ID" != "None" && -n "$INSTANCE_ID" ]]; then
  echo "Found running instance: $INSTANCE_ID"
  read -p "Configure rclone on the EC2 instance now? [y/yes]: " configure_ec2
  if [[ "$configure_ec2" =~ ^[Yy](es)?$ ]]; then
    echo "Configuring rclone on EC2..."
    COMMAND_ID=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" \
      --document-name "AWS-RunShellScript" \
      --parameters "commands=[
        \"GDRIVE_REMOTE=\\\"gdrive\\\"\",
        \"TOKEN_JSON=\$(aws secretsmanager get-secret-value --secret-id \\\"$ARN\\\" --query SecretString --output text)\",
        \"mkdir -p /opt/setup/rclone\",
        \"cat > /opt/setup/rclone/rclone.conf <<EOF\",
        \"[\\\${GDRIVE_REMOTE}]\",
        \"type = drive\",
        \"token = \\\${TOKEN_JSON}\",
        \"EOF\",
        \"chown -R minecraft:minecraft /opt/setup/rclone\",
        \"echo \\\"rclone configured successfully on EC2\\\"\"
      ]" \
      --query 'Command.CommandId' \
      --output text 2>/dev/null)
    
    if [[ -n "$COMMAND_ID" ]]; then
      echo "Waiting for configuration to complete..."
      sleep 3
      STATUS=$(aws ssm get-command-invocation \
        --command-id "$COMMAND_ID" \
        --instance-id "$INSTANCE_ID" \
        --query 'Status' \
        --output text 2>/dev/null || echo "Unknown")
      if [[ "$STATUS" == "Success" ]]; then
        echo "EC2 rclone configuration complete!"
      else
        echo "Command status: $STATUS (check AWS console if issues persist)"
      fi
    else
      echo "Failed to send command to EC2. You may need to configure manually or redeploy."
    fi
  fi
else
  echo "No running Minecraft instance found. rclone will be configured on next deploy/instance start."
fi
