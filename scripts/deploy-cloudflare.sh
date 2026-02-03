#!/usr/bin/env bash
# Deploy the Next.js app to Cloudflare Workers.
#
# IMPORTANT: Cloudflare authentication modes
# - Deployment (wrangler): use OAuth via `wrangler login` (recommended)
# - Runtime DNS updates (your app/Lambda): use a LIMITED Cloudflare API token
#   stored as the Worker secret `CLOUDFLARE_DNS_API_TOKEN` (typically "Edit zone DNS")
#
# Why this matters:
# - A DNS-scoped API token is not sufficient for Workers deployments / secret management.
# - If your shell exports CLOUDFLARE_DNS_API_TOKEN, wrangler will switch into API-token auth mode
#   and `wrangler login` will refuse to run.

set -euo pipefail

ENV_FILE=".env.production"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Error: $ENV_FILE file not found"
  exit 1
fi

# Never allow the runtime DNS token to affect wrangler auth.
# We still upload it as a Worker secret from $ENV_FILE.
unset CLOUDFLARE_DNS_API_TOKEN

WRANGLER_BIN="./node_modules/.bin/wrangler"
if [[ ! -x "$WRANGLER_BIN" ]]; then
  echo "❌ Error: wrangler is not installed. Run: pnpm install"
  exit 1
fi

# Use an isolated HOME for wrangler so any existing API-token based state in the
# user's real HOME cannot block OAuth login (and so we don't care if they export
# CLOUDFLARE_DNS_API_TOKEN globally).
WRANGLER_HOME_DIR="${HOME}/.config/mc-aws/wrangler-home"
mkdir -p "$WRANGLER_HOME_DIR"
chmod 700 "$WRANGLER_HOME_DIR" || true

wrangler() {
  # Run wrangler in a scrubbed environment so an exported CLOUDFLARE_DNS_API_TOKEN
  # (DNS token) cannot interfere with OAuth deployment auth.
  #
  # Keep PATH/HOME so node, browser launcher, and wrangler config still work.
  env -i \
    PATH="$PATH" \
    HOME="$WRANGLER_HOME_DIR" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}" \
    TERM="${TERM:-}" \
    "$WRANGLER_BIN" "$@"
}

get_env_value() {
  local key="$1"
  local line
  # First matching line wins.
  line=$(grep -E "^${key}=" "$ENV_FILE" | head -n 1 || true)
  if [[ -z "$line" ]]; then
    echo ""
    return 0
  fi

  # Everything after the first '='
  local value
  value="${line#*=}"

  # Strip surrounding quotes
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  echo "$value"
}

is_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" == your-* ]] && return 0
  [[ "$value" == "https://mc.yourdomain.com" ]] && return 0
  [[ "$value" == "http://localhost:3000" ]] && return 0
  return 1
}

# Define required env vars from .env.production
REQUIRED_VARS=(
  "NEXT_PUBLIC_APP_URL"
  "GOOGLE_CLIENT_ID"
  "GOOGLE_CLIENT_SECRET"
  "ADMIN_EMAIL"
  "AWS_REGION"
  "AWS_ACCESS_KEY_ID"
  "AWS_SECRET_ACCESS_KEY"
  "INSTANCE_ID"
  "CLOUDFLARE_DNS_API_TOKEN"
  "CLOUDFLARE_ZONE_ID"
  "CLOUDFLARE_RECORD_ID"
  "CLOUDFLARE_MC_DOMAIN"
)

echo "🔍 Validating required secrets..."

# Check if AUTH_SECRET needs to be generated
if grep -q "AUTH_SECRET=your-secret-here" "$ENV_FILE" || grep -q "AUTH_SECRET=dev-secret-change-in-production" "$ENV_FILE" || ! grep -q "^AUTH_SECRET=" "$ENV_FILE"; then
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
  if grep -q "^AUTH_SECRET=" "$ENV_FILE"; then
    # Replace existing placeholder
    if [[ "$OSTYPE" == "darwin"* ]]; then
      # macOS requires -i with empty string
      sed -i '' "s|^AUTH_SECRET=.*|AUTH_SECRET=$NEW_SECRET|" "$ENV_FILE"
    else
      # Linux
      sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$NEW_SECRET|" "$ENV_FILE"
    fi
  else
    # Add if missing
    echo "AUTH_SECRET=$NEW_SECRET" >> "$ENV_FILE"
  fi
  
  echo "✅ Generated and saved new AUTH_SECRET to $ENV_FILE"
  echo ""
fi

MISSING_VARS=()
for key in "${REQUIRED_VARS[@]}"; do
  value="$(get_env_value "$key")"
  if is_placeholder "$value"; then
    MISSING_VARS+=("$key")
  fi
done

if [[ ${#MISSING_VARS[@]} -ne 0 ]]; then
  echo "❌ Error: Missing required values in $ENV_FILE:"
  for key in "${MISSING_VARS[@]}"; do
    echo "  - $key"
  done
  exit 1
fi

echo "✅ All required secrets are set"
echo ""

NEXT_PUBLIC_APP_URL="$(get_env_value "NEXT_PUBLIC_APP_URL")"

# Extract domain from NEXT_PUBLIC_APP_URL
# e.g., https://panel.example.com -> panel.example.com
DOMAIN=$(echo "$NEXT_PUBLIC_APP_URL" | sed -E 's#https?://([^/]+).*#\1#')

# Extract zone name (base domain)
# e.g., panel.shane-bishop.com -> shane-bishop.com
ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

echo "🔐 Checking Cloudflare deployment authentication..."
if ! wrangler secret list --format pretty >/dev/null 2>&1; then
  echo ""
  echo "⚠️  Wrangler is not authenticated for Workers operations (secrets/deploy)."
  echo "We'll try to fix this by logging you in via OAuth."
  echo ""

  # Clear any existing wrangler session (token-mode sessions can block OAuth).
  wrangler logout >/dev/null 2>&1 || true

  # OAuth login (opens browser). Note: some wrangler failures can return exit code 0,
  # so we always verify after attempting login.
  wrangler login || true

  if ! wrangler secret list --format pretty >/dev/null 2>&1; then
    echo ""
    echo "❌ Error: Still not authenticated for Workers operations."
    echo "Try this manually, then re-run this script:"
    echo "  1) pnpm exec wrangler logout"
    echo "  2) pnpm exec wrangler login"
    echo ""
    echo "If you have CLOUDFLARE_DNS_API_TOKEN exported in your shell profile, remove it."
    exit 1
  fi
fi

echo "✅ Authenticated with Cloudflare"
echo ""

echo "🚀 Deploying to Cloudflare Workers..."
echo "   Domain: $DOMAIN"
echo "   Zone: $ZONE_NAME"
echo "   Backend: aws"
echo "   Dev Login: disabled"
echo ""

# Upload secrets from .env.production
# Note: MC_BACKEND_MODE and ENABLE_DEV_LOGIN are exported above for the build process
# but are NOT uploaded as Cloudflare secrets - they default correctly at runtime.
echo "🔑 Uploading secrets from .env.production..."

SECRET_COUNT=0
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip empty lines and comments
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^#.* ]] && continue

  # Only KEY=VALUE lines
  if [[ "$line" != *=* ]]; then
    continue
  fi

  key="${line%%=*}"
  value="${line#*=}"

  # Skip empty keys
  [[ -z "$key" ]] && continue

  # Strip surrounding quotes
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

  # Skip if value is empty
  [[ -z "$value" ]] && continue

  echo "  Setting: $key"
  if ! echo "$value" | wrangler secret put "$key"; then
    echo ""
    echo "❌ Error: Failed to set secret: $key (see error above)"
    echo "Hint: If you see '/memberships' auth errors, run: env -u CLOUDFLARE_DNS_API_TOKEN pnpm exec wrangler login"
    exit 1
  fi
  ((SECRET_COUNT++))
done < "$ENV_FILE"

echo "✅ Secrets uploaded ($SECRET_COUNT secrets)"
echo ""

# Build the Next.js app
echo "📦 Building Next.js app..."
if ! MC_BACKEND_MODE=aws ENABLE_DEV_LOGIN=false pnpm build; then
  echo ""
  echo "❌ Error: Failed to build Next.js app"
  exit 1
fi
echo "✅ Build successful"
echo ""

# Deploy with wrangler using route flags
echo "🌐 Deploying to Cloudflare..."
if ! wrangler deploy --route "$DOMAIN/*" --compatibility-date=2024-09-23; then
  echo ""
  echo "❌ Error: Failed to deploy to Cloudflare Workers"
  exit 1
fi

echo ""
echo "✅✅✅ Deployment complete! ✅✅✅"
echo ""
echo "   🌍 Your app is live at: https://$DOMAIN"
echo "   📊 Dashboard: https://dash.cloudflare.com"
echo ""
echo "Next steps:"
echo "   1. Test your deployment at https://$DOMAIN"
echo "   2. Check the Cloudflare dashboard for logs and metrics"
echo "   3. Verify all functionality is working as expected"
echo ""
