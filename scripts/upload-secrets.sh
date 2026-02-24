#!/bin/bash
# Upload all secrets to Cloudflare Workers from a deployment env file.
# Usage: ENV_FILE=.env.production ./scripts/upload-secrets.sh

set -e

ENV_FILE="${ENV_FILE:-.env.production}"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Error: env file not found: $ENV_FILE"
  exit 1
fi

echo "📤 Uploading secrets from $ENV_FILE to Cloudflare Workers..."
echo ""

# Read env file and upload each non-empty, non-comment line as a secret
while IFS='=' read -r key value; do
  # Skip empty lines and comments
  [[ -z "$key" || "$key" =~ ^#.* ]] && continue
  
  # Remove quotes from value if present
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  
  # Skip if value is empty
  [[ -z "$value" ]] && continue
  
  echo "Setting: $key"
  echo "$value" | wrangler secret put "$key" --env production
done < "$ENV_FILE"

echo ""
echo "✅ All secrets uploaded successfully!"
echo ""
echo "Next steps:"
echo "  1. Update Google OAuth redirect URI to: https://mc.shane-bishop.com/api/auth/callback/google"
echo "  2. Deploy with: pnpm deploy:cf"
