#!/usr/bin/env bash
# Update Cloudflare DNS to point to this EC2 instance's public IP
# Runs on EC2 startup and sends SNS notification when DNS is updated

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

# Get public IP from IMDSv2
log "Getting instance public IP..."
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/public-ipv4")
log "Public IP: $PUBLIC_IP"

# Fetch Cloudflare credentials and SNS topic from SSM
log "Fetching Cloudflare credentials from SSM..."
ZONE_ID=$(aws ssm get-parameter --name /minecraft/cloudflare-zone-id --query 'Parameter.Value' --output text --region us-east-1)
DOMAIN=$(aws ssm get-parameter --name /minecraft/cloudflare-domain --query 'Parameter.Value' --output text --region us-east-1)
API_TOKEN=$(aws ssm get-parameter --name /minecraft/cloudflare-api-token --with-decryption --query 'Parameter.Value' --output text --region us-east-1)
SNS_TOPIC_ARN=$(aws ssm get-parameter --name /minecraft/sns-topic-arn --query 'Parameter.Value' --output text --region us-east-1)

# Validate required parameters
if [[ -z "$ZONE_ID" || -z "$DOMAIN" || -z "$API_TOKEN" || -z "$SNS_TOPIC_ARN" ]]; then
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

# Send SNS notification (non-critical)
log "Sending SNS notification..."
aws sns publish \
  --topic-arn "$SNS_TOPIC_ARN" \
  --subject "Minecraft DNS Updated" \
  --message "DNS record ${DOMAIN} updated to ${PUBLIC_IP}" \
  --region us-east-1 || log "Warning: Failed to send SNS notification"

# Clear sensitive variables
unset API_TOKEN

log "DNS update complete"