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

WORKER_SECRET_ALLOWLIST=()

load_worker_secret_allowlist() {
  if ! mapfile -t WORKER_SECRET_ALLOWLIST < <(pnpm exec tsx scripts/get-worker-secret-allowlist.ts); then
    echo "❌ Error: Failed to load Worker secret allowlist from schema"
    echo "   Tip: run pnpm install and ensure scripts/get-worker-secret-allowlist.ts succeeds"
    exit 1
  fi

  if [[ ${#WORKER_SECRET_ALLOWLIST[@]} -eq 0 ]]; then
    echo "❌ Error: Worker secret allowlist is empty"
    exit 1
  fi
}

load_worker_secret_allowlist

is_worker_secret_allowed() {
  local candidate="$1"
  for allowed in "${WORKER_SECRET_ALLOWLIST[@]}"; do
    if [[ "$allowed" == "$candidate" ]]; then
      return 0
    fi
  done

  return 1
}

print_worker_secret_allowlist() {
  for allowed in "${WORKER_SECRET_ALLOWLIST[@]}"; do
    echo "  - $allowed"
  done
}

# Read env file and upload each non-empty, non-comment line as a secret
LINE_NO=0
while IFS= read -r line || [[ -n "$line" ]]; do
  LINE_NO=$((LINE_NO + 1))

  # Skip empty lines and comments
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^#.* ]] && continue

  # Only KEY=VALUE lines
  if [[ "$line" != *=* ]]; then
    continue
  fi

  key="${line%%=*}"
  value="${line#*=}"

  # Allow (and ignore) optional 'export ' prefix.
  if [[ "$key" == export\ * ]]; then
    key="${key#export }"
  fi

  # Trim whitespace around key.
  key="${key#${key%%[![:space:]]*}}"
  key="${key%${key##*[![:space:]]}}"

  # Skip empty keys
  [[ -z "$key" ]] && continue

  # Wrangler secret names must be env-var style.
  if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "❌ Error: Invalid env var name in $ENV_FILE:$LINE_NO: '$key'"
    echo "Secrets must be uppercase letters/numbers/underscores (e.g. FOO_BAR)."
    exit 1
  fi

  if ! is_worker_secret_allowed "$key"; then
    echo "❌ Error: Refusing to upload unapproved Worker secret key '$key' from $ENV_FILE:$LINE_NO"
    echo "Allowed Worker secret keys:"
    print_worker_secret_allowlist
    exit 1
  fi

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
