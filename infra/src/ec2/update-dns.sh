#!/usr/bin/env bash
# Update Cloudflare DNS to point to this EC2 instance's public IP
# Runs on EC2 startup and sends email notification via SES when DNS is updated

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

# Get instance metadata from IMDSv2
log "Getting instance metadata..."
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/public-ipv4")
AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/placement/region")
log "Public IP: $PUBLIC_IP"
log "AWS Region: $AWS_REGION"

# Fetch Cloudflare credentials and email config from SSM
log "Fetching Cloudflare credentials from SSM..."
ZONE_ID=$(aws ssm get-parameter --name /minecraft/cloudflare-zone-id --query 'Parameter.Value' --output text --region "$AWS_REGION")
DOMAIN=$(aws ssm get-parameter --name /minecraft/cloudflare-domain --query 'Parameter.Value' --output text --region "$AWS_REGION")
API_TOKEN=$(aws ssm get-parameter --name /minecraft/cloudflare-api-token --with-decryption --query 'Parameter.Value' --output text --region "$AWS_REGION")
VERIFIED_SENDER=$(aws ssm get-parameter --name /minecraft/verified-sender --query 'Parameter.Value' --output text --region "$AWS_REGION")
NOTIFICATION_EMAIL=$(aws ssm get-parameter --name /minecraft/notification-email --query 'Parameter.Value' --output text --region "$AWS_REGION")

# Get sender email if available (set by Lambda when startup is triggered)
TRIGGERED_BY=$(aws ssm get-parameter --name /minecraft/startup-triggered-by --query 'Parameter.Value' --output text --region "$AWS_REGION" 2>/dev/null || echo "")

# Validate required parameters
if [[ -z "$ZONE_ID" || -z "$DOMAIN" || -z "$API_TOKEN" ]]; then
  log "ERROR: Missing required SSM parameters"
  exit 1
fi

# Get current DNS record from Cloudflare
log "Checking current DNS record for $DOMAIN..."
DNS_RESPONSE=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${DOMAIN}" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json")

# Check if API call succeeded
if ! echo "$DNS_RESPONSE" | jq -e '.success' >/dev/null 2>&1; then
  log "ERROR: Failed to query Cloudflare API"
  echo "$DNS_RESPONSE" | jq -r '.errors[]?.message' 2>/dev/null || true
  exit 1
fi

# Extract record ID and current IP
RECORD_ID=$(echo "$DNS_RESPONSE" | jq -r '.result[0].id // empty')
CURRENT_IP=$(echo "$DNS_RESPONSE" | jq -r '.result[0].content // empty')

if [[ -z "$RECORD_ID" ]]; then
  log "ERROR: No DNS record found for domain $DOMAIN"
  exit 1
fi

log "Current DNS IP: $CURRENT_IP"

# Check if update is needed
if [[ "$CURRENT_IP" == "$PUBLIC_IP" ]]; then
  log "DNS already points to correct IP ($PUBLIC_IP)"
  exit 0
fi

# Update DNS record
log "Updating DNS record from $CURRENT_IP to $PUBLIC_IP..."
UPDATE_RESPONSE=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"content\": \"${PUBLIC_IP}\"}")

# Check if update succeeded
if ! echo "$UPDATE_RESPONSE" | jq -e '.success' >/dev/null 2>&1; then
  log "ERROR: Failed to update Cloudflare DNS"
  echo "$UPDATE_RESPONSE" | jq -r '.errors[]?.message' 2>/dev/null || true
  exit 1
fi

log "DNS record updated successfully"

# Send consolidated email notification via SES (non-critical)
if [[ -n "$VERIFIED_SENDER" && -n "$NOTIFICATION_EMAIL" ]]; then
  log "Sending email notification..."
  
  # Build email body with all information
  EMAIL_SUBJECT="Minecraft Server Started"
  EMAIL_BODY="Server started at IP: ${PUBLIC_IP}
DNS updated to: ${PUBLIC_IP}"
  
  # Add triggered-by info if available
  if [[ -n "$TRIGGERED_BY" ]]; then
    EMAIL_BODY="Startup triggered by: ${TRIGGERED_BY}
${EMAIL_BODY}"
  fi
  
  aws ses send-email \
    --from "$VERIFIED_SENDER" \
    --destination "ToAddresses=$NOTIFICATION_EMAIL" \
    --message "Subject={Data='${EMAIL_SUBJECT}'},Body={Text={Data='${EMAIL_BODY}'}}" \
    --region "$AWS_REGION" || log "Warning: Failed to send email notification"
  
  # Clean up the trigger parameter after sending notification
  if [[ -n "$TRIGGERED_BY" ]]; then
    aws ssm delete-parameter --name /minecraft/startup-triggered-by --region "$AWS_REGION" 2>/dev/null || true
  fi
else
  log "Skipping notification: email not configured"
fi

# Clear sensitive variables
unset API_TOKEN

log "DNS update complete"