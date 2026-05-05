#!/usr/bin/env bash
# Update configured DNS to point to this EC2 instance's public IP.
# Runs on EC2 startup and sends email notification via SES when configured.

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "ERROR: Required command '$cmd' not found"
    exit 1
  fi
}

for cmd in aws curl jq; do
  require_command "$cmd"
done

get_ssm_parameter() {
  local name="$1"
  local decrypt="${2:-false}"
  local decrypt_arg=()

  if [[ "$decrypt" == "true" ]]; then
    decrypt_arg=(--with-decryption)
  fi

  aws ssm get-parameter \
    --name "$name" \
    "${decrypt_arg[@]}" \
    --query 'Parameter.Value' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo ""
}

dns_update_cloudflare() {
  local ip="$1"
  local zone_id="$2"
  local domain="$3"
  local api_token="$4"

  if [[ -z "$zone_id" || -z "$domain" || -z "$api_token" ]]; then
    log "ERROR: Missing Cloudflare SSM parameters"
    return 1
  fi

  log "Checking current DNS record for $domain..."
  local dns_response
  dns_response=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=A&name=${domain}" \
    -H "Authorization: Bearer ${api_token}" \
    -H "Content-Type: application/json")

  if ! echo "$dns_response" | jq -e '.success' >/dev/null 2>&1; then
    log "ERROR: Failed to query Cloudflare API"
    echo "$dns_response" | jq -r '.errors[]?.message' 2>/dev/null || true
    return 1
  fi

  local record_id
  local current_ip
  record_id=$(echo "$dns_response" | jq -r '.result[0].id // empty')
  current_ip=$(echo "$dns_response" | jq -r '.result[0].content // empty')

  if [[ -z "$record_id" ]]; then
    log "ERROR: No DNS record found for domain $domain"
    return 1
  fi

  log "Current DNS IP: $current_ip"

  if [[ "$current_ip" == "$ip" ]]; then
    log "DNS already points to correct IP ($ip)"
    return 0
  fi

  log "Updating DNS record from $current_ip to $ip..."
  local update_response
  update_response=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${record_id}" \
    -H "Authorization: Bearer ${api_token}" \
    -H "Content-Type: application/json" \
    --data "{\"content\": \"${ip}\"}")

  if ! echo "$update_response" | jq -e '.success' >/dev/null 2>&1; then
    log "ERROR: Failed to update Cloudflare DNS"
    echo "$update_response" | jq -r '.errors[]?.message' 2>/dev/null || true
    return 1
  fi

  log "Cloudflare DNS record updated successfully"
}

dns_update_duckdns() {
  local ip="$1"
  local domain="$2"
  local token="$3"

  if [[ -z "$domain" || -z "$token" ]]; then
    log "ERROR: Missing DuckDNS SSM parameters"
    return 1
  fi

  local response
  response=$(curl -fsS "https://www.duckdns.org/update?domains=${domain}&token=${token}&ip=${ip}&verbose=true")
  if [[ "$response" != OK* ]]; then
    log "ERROR: DuckDNS update failed: $response"
    return 1
  fi

  log "DuckDNS updated ${domain}.duckdns.org"
}

# Get instance metadata from IMDSv2
log "Getting instance metadata..."
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/public-ipv4")
AWS_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/placement/region")
if [[ -z "$TOKEN" || -z "$PUBLIC_IP" || -z "$AWS_REGION" ]]; then
  log "ERROR: Failed to resolve required EC2 metadata (token/public-ip/region)"
  exit 1
fi
log "Public IP: $PUBLIC_IP"
log "AWS Region: $AWS_REGION"

# Fetch DNS provider config and email config from SSM
log "Fetching DNS configuration from SSM..."
ZONE_ID=$(get_ssm_parameter /minecraft/cloudflare-zone-id)
DOMAIN=$(get_ssm_parameter /minecraft/cloudflare-domain)
API_TOKEN=$(get_ssm_parameter /minecraft/cloudflare-api-token true)
DUCKDNS_DOMAIN=$(get_ssm_parameter /minecraft/duckdns-domain)
DUCKDNS_TOKEN=$(get_ssm_parameter /minecraft/duckdns-token true)
VERIFIED_SENDER=$(get_ssm_parameter /minecraft/verified-sender)
NOTIFICATION_EMAIL=$(get_ssm_parameter /minecraft/notification-email)

# Get sender email if available (set by Lambda when startup is triggered)
TRIGGERED_BY=$(get_ssm_parameter /minecraft/startup-triggered-by)

if [[ -n "$DUCKDNS_DOMAIN" || -n "$DUCKDNS_TOKEN" ]]; then
  dns_update_duckdns "$PUBLIC_IP" "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN"
elif [[ -n "$ZONE_ID" || -n "$DOMAIN" || -n "$API_TOKEN" ]]; then
  dns_update_cloudflare "$PUBLIC_IP" "$ZONE_ID" "$DOMAIN" "$API_TOKEN"
else
  log "[DNS] No provider configured; skipping DNS update. Public IP: $PUBLIC_IP"
fi

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
unset DUCKDNS_TOKEN

log "DNS update complete"
