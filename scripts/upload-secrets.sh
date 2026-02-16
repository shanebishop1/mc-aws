#!/bin/bash
# Upload all secrets to Cloudflare Workers from .env
# Usage: ./scripts/upload-secrets.sh

set -e

if [ ! -f ".env" ]; then
  echo "❌ Error: .env file not found"
  exit 1
fi

echo "📤 Uploading secrets from .env to Cloudflare Workers..."
echo ""

# Read .env and upload each non-empty, non-comment line as a secret
while IFS='=' read -r key value; do
  # Skip empty lines and comments
  [[ -z "$key" || "$key" =~ ^#.* ]] && continue
  
  # Remove quotes from value if present
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  
  # Skip if value is empty
  [[ -z "$value" ]] && continue
  
  echo "Setting: $key"
  echo "$value" | wrangler secret put "$key" --env production
done < .env

echo ""
echo "✅ All secrets uploaded successfully!"
echo ""
echo "Next steps:"
echo "  1. Update Google OAuth redirect URI to: https://mc.shane-bishop.com/api/auth/callback/google"
echo "  2. Deploy with: pnpm deploy:cf"
