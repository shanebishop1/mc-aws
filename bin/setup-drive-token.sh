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

read -p "Write these values into .env now? [y/N]: " save_env
if [[ "$save_env" =~ ^[Yy]$ ]]; then
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
