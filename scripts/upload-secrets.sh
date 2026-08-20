#!/usr/bin/env bash
# Upload all secrets to Cloudflare Workers from a deployment env file.
# Usage: ENV_FILE=.env.production ./scripts/upload-secrets.sh

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.production}"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Error: env file not found: $ENV_FILE"
  exit 1
fi

echo "📤 Uploading secrets from $ENV_FILE to Cloudflare Workers..."
echo ""

echo "🔍 Running strict worker env preflight..."
if ! NODE_ENV=production pnpm exec tsx scripts/validate-env.ts --target worker --strict --env-file "$ENV_FILE"; then
  echo "❌ Error: worker env preflight failed"
  exit 1
fi
echo "✅ Worker env preflight passed"
echo ""

if ! SECRET_ENTRIES_OUTPUT="$(pnpm exec tsx scripts/deploy-env.ts worker-secret-entries --env-file "$ENV_FILE")"; then
  echo "❌ Error: Failed to parse approved Worker secrets from $ENV_FILE"
  exit 1
fi
while IFS=$'\t' read -r key encoded_value; do
  [[ -z "$key" ]] && continue
  echo "Setting: $key"
  node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$encoded_value" | \
    wrangler secret put "$key" --env production
done <<< "$SECRET_ENTRIES_OUTPUT"
unset SECRET_ENTRIES_OUTPUT encoded_value

echo ""
echo "✅ All secrets uploaded successfully!"
echo ""
echo "Next steps:"
echo "  1. Update Google OAuth redirect URI to: https://mc.shane-bishop.com/api/auth/callback/google"
echo "  2. Deploy with: pnpm deploy:cf"
