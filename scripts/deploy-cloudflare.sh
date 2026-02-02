#!/bin/bash
# Deploy to Cloudflare Workers with dynamic route configuration
# This script reads .env.production to configure the deployment route

set -e

if [ ! -f ".env.production" ]; then
  echo "❌ Error: .env.production file not found"
  exit 1
fi

# Define required secrets
REQUIRED_SECRETS=(
  "NEXT_PUBLIC_APP_URL"
  "GOOGLE_CLIENT_ID"
  "GOOGLE_CLIENT_SECRET"
  "ADMIN_EMAIL"
  "ALLOWED_EMAILS"
  "AWS_REGION"
  "AWS_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY"
  "CLOUDFLARE_API_TOKEN"
  "CLOUDFLARE_ZONE_ID"
  "CLOUDFLARE_RECORD_ID"
  "CLOUDFLARE_MC_DOMAIN"
  "INSTANCE_ID"
)

# Check if AUTH_SECRET needs to be generated
if grep -q "AUTH_SECRET=your-secret-here" .env.production || grep -q "AUTH_SECRET=dev-secret-change-in-production" .env.production || ! grep -q "^AUTH_SECRET=" .env.production; then
  echo "🔐 Generating strong AUTH_SECRET..."
  
  # Try OpenSSL first, fall back to Node.js
  if command -v openssl &> /dev/null; then
    NEW_SECRET=$(openssl rand -base64 48)
  elif command -v node &> /dev/null; then
    NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
  else
    echo "❌ Error: Neither openssl nor node found. Cannot generate AUTH_SECRET."
    echo "Please install OpenSSL or Node.js, or manually add a strong random string to AUTH_SECRET in .env.production"
    exit 1
  fi
  
  # Update or add AUTH_SECRET in .env.production
  if grep -q "^AUTH_SECRET=" .env.production; then
    # Replace existing placeholder
    if [[ "$OSTYPE" == "darwin"* ]]; then
      # macOS requires -i with empty string
      sed -i '' "s|^AUTH_SECRET=.*|AUTH_SECRET=$NEW_SECRET|" .env.production
    else
      # Linux
      sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$NEW_SECRET|" .env.production
    fi
  else
    # Add if missing
    echo "AUTH_SECRET=$NEW_SECRET" >> .env.production
  fi
  
  echo "✅ Generated and saved new AUTH_SECRET to .env.production"
  echo ""
fi

# Validate all required secrets are set
echo "🔍 Validating required secrets..."
MISSING_SECRETS=()

for secret in "${REQUIRED_SECRETS[@]}"; do
  # Check if secret exists and is not empty or a placeholder
  if ! grep -q "^${secret}=" .env.production; then
    MISSING_SECRETS+=("$secret")
  else
    value=$(grep "^${secret}=" .env.production | cut -d'=' -f2-)
    # Remove quotes
    value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    
    # Check if empty or placeholder
    if [[ -z "$value" ]] || [[ "$value" == "your-"* ]] || [[ "$value" == "https://mc.yourdomain.com" ]]; then
      MISSING_SECRETS+=("$secret")
    fi
  fi
done

if [ ${#MISSING_SECRETS[@]} -ne 0 ]; then
  echo ""
  echo "❌ Error: The following required secrets are missing or not set in .env.production:"
  echo ""
  for secret in "${MISSING_SECRETS[@]}"; do
    echo "  - $secret"
  done
  echo ""
  echo "Please update your .env.production file with the correct values."
  echo "See .env.production.template for reference."
  exit 1
fi

echo "✅ All required secrets are set"
echo ""

# Source .env.production
export $(grep -v '^#' .env.production | xargs)

# Extract domain from NEXT_PUBLIC_APP_URL
# e.g., https://mc.shane-bishop.com -> mc.shane-bishop.com
DOMAIN=$(echo "$NEXT_PUBLIC_APP_URL" | sed -E 's#https?://([^/]+).*#\1#')

# Extract zone name (base domain)
# e.g., mc.shane-bishop.com -> shane-bishop.com
ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

echo "🚀 Deploying to Cloudflare Workers..."
echo "   Domain: $DOMAIN"
echo "   Zone: $ZONE_NAME"
echo ""

# Upload secrets first
echo "🔑 Uploading secrets from .env.production..."
while IFS='=' read -r key value; do
  # Skip empty lines and comments
  [[ -z "$key" || "$key" =~ ^#.* ]] && continue
  
  # Remove quotes from value if present
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  
  # Skip if value is empty
  [[ -z "$value" ]] && continue
  
  echo "  Setting: $key"
  echo "$value" | wrangler secret put "$key" >/dev/null 2>&1
done < .env.production

echo "✅ Secrets uploaded"
echo ""

# Build the Next.js app
echo "📦 Building Next.js app..."
pnpm build

# Deploy with wrangler using route flags
echo "🌐 Deploying to Cloudflare..."
wrangler deploy --route "$DOMAIN/*" --compatibility-date=2024-09-23

echo ""
echo "✅ Deployment complete!"
echo "   Your app should be live at: https://$DOMAIN"
