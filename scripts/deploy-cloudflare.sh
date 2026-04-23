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

ENV_FILE="${ENV_FILE:-.env.production}"
WRANGLER_CONFIG_FILE="wrangler.jsonc"
WRANGLER_DEPLOY_CONFIG_FILE=""
NEXT_BUILD_ENV_FILE=".env.production.local"
NEXT_BUILD_ENV_BACKUP_FILE=""
NEXT_BUILD_ENV_PREPARED="0"

resolve_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ Error: Deployment env file not found: $ENV_FILE"
    echo "Tip: set a custom file with: ENV_FILE=.env.production pnpm deploy:cf"
    exit 1
  fi

  return 0
}

prepare_next_build_env_file() {
  # Next.js loads .env.local during production builds, which can override
  # .env.production. Copy the deploy env to .env.production.local so deploy
  # always uses the intended production values.
  if [[ -f "$NEXT_BUILD_ENV_FILE" ]]; then
    NEXT_BUILD_ENV_BACKUP_FILE="$(mktemp "${NEXT_BUILD_ENV_FILE}.backup.XXXXXX")"
    cp "$NEXT_BUILD_ENV_FILE" "$NEXT_BUILD_ENV_BACKUP_FILE"
  fi

  cp "$ENV_FILE" "$NEXT_BUILD_ENV_FILE"
  NEXT_BUILD_ENV_PREPARED="1"
}

cleanup_next_build_env_file() {
  if [[ "$NEXT_BUILD_ENV_PREPARED" != "1" ]]; then
    return 0
  fi

  if [[ -n "$NEXT_BUILD_ENV_BACKUP_FILE" ]]; then
    mv "$NEXT_BUILD_ENV_BACKUP_FILE" "$NEXT_BUILD_ENV_FILE"
    return 0
  fi

  rm -f "$NEXT_BUILD_ENV_FILE"
}

cleanup_deploy_artifacts() {
  cleanup_next_build_env_file

  if [[ -n "$WRANGLER_DEPLOY_CONFIG_FILE" && -f "$WRANGLER_DEPLOY_CONFIG_FILE" ]]; then
    rm -f "$WRANGLER_DEPLOY_CONFIG_FILE"
  fi
}

resolve_env_file

echo "🧪 Using environment file: $ENV_FILE"
echo ""

trap cleanup_deploy_artifacts EXIT

if [[ ! -f "$WRANGLER_CONFIG_FILE" ]]; then
  echo "❌ Error: $WRANGLER_CONFIG_FILE not found (required to determine Worker name)"
  exit 1
fi

# Never allow the runtime DNS token to affect wrangler auth.
# We still upload it as a Worker secret from $ENV_FILE.
unset CLOUDFLARE_DNS_API_TOKEN

WRANGLER_BIN="./node_modules/.bin/wrangler"
if [[ ! -x "$WRANGLER_BIN" ]]; then
  echo "❌ Error: wrangler is not installed. Run: pnpm install --frozen-lockfile"
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
    TERM="${TERM:-}" \
    USER="${USER:-}" \
    "$WRANGLER_BIN" "$@"
}

retry() {
  local max_attempts="$1"
  shift

  local attempt=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" -ge "$max_attempts" ]]; then
      return 1
    fi

    echo "   ⚠️  Command failed; retrying ($attempt/$max_attempts) in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

get_worker_name() {
  # Read the Worker name from wrangler.jsonc.
  # This is a simple extraction that expects a top-level "name": "..." entry.
  local name
  name=$(grep -E '^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"[^"]+"' "$WRANGLER_CONFIG_FILE" | head -n 1 | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)
  echo "${name:-}"
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

update_env_value() {
  local key="$1"
  local value="$2"

  local tmp_file
  tmp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

  local found="0"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
      found="1"
      continue
    fi

    printf '%s\n' "$line" >> "$tmp_file"
  done < "$ENV_FILE"

  if [[ "$found" == "0" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
  fi

  mv "$tmp_file" "$ENV_FILE"
}

WORKER_SECRET_ALLOWLIST=()

load_worker_secret_allowlist() {
  if ! mapfile -t WORKER_SECRET_ALLOWLIST < <(pnpm exec tsx scripts/get-worker-secret-allowlist.ts); then
    echo "❌ Error: Failed to load Worker secret allowlist from schema"
    echo "   Tip: run pnpm install --frozen-lockfile and ensure scripts/get-worker-secret-allowlist.ts succeeds"
    exit 1
  fi

  if [[ ${#WORKER_SECRET_ALLOWLIST[@]} -eq 0 ]]; then
    echo "❌ Error: Worker secret allowlist is empty"
    exit 1
  fi
}

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

is_cloudflare_kv_namespace_id() {
  local value="$1"
  [[ "$value" =~ ^[A-Fa-f0-9]{32}$ ]]
}

extract_cloudflare_kv_namespace_id() {
  local raw_output="$1"

  printf '%s\n' "$raw_output" | grep -Eo '[A-Fa-f0-9]{32}' | head -n 1 || true
}

create_cloudflare_kv_namespace() {
  local binding_name="$1"
  local preview_mode="$2"
  local output

  if [[ "$preview_mode" == "preview" ]]; then
    if ! output="$(wrangler kv namespace create "$binding_name" --preview 2>&1)"; then
      printf '%s\n' "$output"
      return 1
    fi
  else
    if ! output="$(wrangler kv namespace create "$binding_name" 2>&1)"; then
      printf '%s\n' "$output"
      return 1
    fi
  fi

  printf '%s\n' "$output"
  return 0
}

ensure_runtime_state_kv_namespace_ids() {
  local runtime_state_snapshot_kv_id
  runtime_state_snapshot_kv_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID")"

  local runtime_state_snapshot_kv_preview_id
  runtime_state_snapshot_kv_preview_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID")"

  if is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id" &&
    { [[ -z "$runtime_state_snapshot_kv_preview_id" ]] || is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; }; then
    return 0
  fi

  echo "🪣 Ensuring runtime-state KV namespaces exist..."

  if ! is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id"; then
    local create_output
    if ! create_output="$(create_cloudflare_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV" standard)"; then
      echo "$create_output"
      echo "❌ Error: Failed to create RUNTIME_STATE_SNAPSHOT_KV namespace"
      exit 1
    fi
    runtime_state_snapshot_kv_id="$(extract_cloudflare_kv_namespace_id "$create_output")"

    if ! is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id"; then
      echo "$create_output"
      echo "❌ Error: Failed to create or parse RUNTIME_STATE_SNAPSHOT_KV namespace id"
      exit 1
    fi

    update_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID" "$runtime_state_snapshot_kv_id"
    echo "✅ Created RUNTIME_STATE_SNAPSHOT_KV_ID and saved it to $ENV_FILE"
  fi

  if [[ -n "$runtime_state_snapshot_kv_preview_id" ]] && is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; then
    echo ""
    return 0
  fi

  local preview_output
  if ! preview_output="$(create_cloudflare_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV" preview)"; then
    echo "$preview_output"
    echo "❌ Error: Failed to create RUNTIME_STATE_SNAPSHOT_KV preview namespace"
    exit 1
  fi
  runtime_state_snapshot_kv_preview_id="$(extract_cloudflare_kv_namespace_id "$preview_output")"

  if ! is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; then
    echo "$preview_output"
    echo "❌ Error: Failed to create or parse RUNTIME_STATE_SNAPSHOT_KV preview namespace id"
    exit 1
  fi

  update_env_value "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID" "$runtime_state_snapshot_kv_preview_id"
  echo "✅ Created RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID and saved it to $ENV_FILE"
  echo ""
}

prepare_wrangler_deploy_config() {
  local runtime_state_snapshot_kv_id
  runtime_state_snapshot_kv_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID")"

  local runtime_state_snapshot_kv_preview_id
  runtime_state_snapshot_kv_preview_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID")"
  if [[ -z "$runtime_state_snapshot_kv_preview_id" ]]; then
    runtime_state_snapshot_kv_preview_id="$runtime_state_snapshot_kv_id"
  fi

  if ! is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id"; then
    echo "❌ Error: RUNTIME_STATE_SNAPSHOT_KV_ID must be a 32-character Cloudflare KV namespace id"
    exit 1
  fi

  if ! is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; then
    echo "❌ Error: RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID must be a 32-character Cloudflare KV namespace id"
    echo "   Tip: set RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID in $ENV_FILE, or leave it unset to reuse RUNTIME_STATE_SNAPSHOT_KV_ID"
    exit 1
  fi

  WRANGLER_DEPLOY_CONFIG_FILE="$(mktemp "${WRANGLER_CONFIG_FILE}.deploy.XXXXXX")"

  if ! node - "$WRANGLER_CONFIG_FILE" "$WRANGLER_DEPLOY_CONFIG_FILE" "$runtime_state_snapshot_kv_id" "$runtime_state_snapshot_kv_preview_id" <<'NODE'; then
const fs = require("node:fs");

const [sourcePath, outputPath, kvId, kvPreviewId] = process.argv.slice(2);

const raw = fs.readFileSync(sourcePath, "utf8");
const start = raw.indexOf("{");
if (start === -1) {
  console.error("❌ Error: Invalid wrangler config (missing JSON object)");
  process.exit(1);
}

const config = JSON.parse(raw.slice(start));
const kvNamespaces = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
const runtimeBinding = kvNamespaces.find((entry) => entry && entry.binding === "RUNTIME_STATE_SNAPSHOT_KV");

if (!runtimeBinding) {
  console.error("❌ Error: wrangler.jsonc is missing kv_namespaces entry for RUNTIME_STATE_SNAPSHOT_KV");
  process.exit(1);
}

runtimeBinding.id = kvId;
runtimeBinding.preview_id = kvPreviewId;

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
    echo "❌ Error: Failed to prepare runtime-state Wrangler deploy config"
    exit 1
  fi

  echo "✅ Prepared runtime-state Wrangler config with validated KV namespace ids"
}

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
    echo "Please install OpenSSL or Node.js, or manually add a strong random string to AUTH_SECRET in $ENV_FILE"
    exit 1
  fi

  # Update or add AUTH_SECRET in the selected deployment env file
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

echo "🔍 Running strict production schema validation..."
if ! NODE_ENV=production pnpm exec tsx scripts/validate-env.ts --target worker --strict --env-file "$ENV_FILE"; then
  echo "❌ Error: strict production schema validation failed"
  exit 1
fi
echo "✅ Production schema validation passed"
echo ""

echo "🔍 Validating runtime-state Wrangler setup..."
if ! pnpm exec tsx scripts/validate-runtime-state-deploy.ts --env-file "$ENV_FILE" --wrangler-config "$WRANGLER_CONFIG_FILE"; then
  echo "❌ Error: runtime-state deployment preflight failed"
  exit 1
fi
echo "✅ Runtime-state setup validation passed"
echo ""

load_worker_secret_allowlist

NEXT_PUBLIC_APP_URL="$(get_env_value "NEXT_PUBLIC_APP_URL")"

# Extract domain from NEXT_PUBLIC_APP_URL
# e.g., https://panel.example.com -> panel.example.com
DOMAIN=$(echo "$NEXT_PUBLIC_APP_URL" | sed -E 's#https?://([^/]+).*#\1#')

# Extract zone name (base domain)
# e.g., panel.shane-bishop.com -> shane-bishop.com
ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

CF_DNS_API_TOKEN="$(get_env_value "CLOUDFLARE_DNS_API_TOKEN")"
CF_ZONE_ID="$(get_env_value "CLOUDFLARE_ZONE_ID")"

cf_api() {
  local method="$1"
  local path="$2"
  local json_body="${3:-}"

  local url="https://api.cloudflare.com/client/v4${path}"

  local tmp
  tmp="$(mktemp)"
  local http_code=""

  # -q disables reading ~/.curlrc, which can inject flags (like `-i`) and break JSON parsing.
  # We capture the HTTP status code separately and always emit the response body.
  if [[ -n "$json_body" ]]; then
    if ! http_code=$(curl -sS -q \
      -o "$tmp" \
      -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data "$json_body" \
      "$url"); then
      echo "❌ Error: Cloudflare API request failed (curl)" >&2
      rm -f "$tmp"
      return 1
    fi
  else
    if ! http_code=$(curl -sS -q \
      -o "$tmp" \
      -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      "$url"); then
      echo "❌ Error: Cloudflare API request failed (curl)" >&2
      rm -f "$tmp"
      return 1
    fi
  fi

  local bytes
  bytes=$(wc -c < "$tmp" | tr -d ' ')
  if [[ "$bytes" -eq 0 ]]; then
    echo "❌ Error: Cloudflare API returned an empty response (HTTP ${http_code})" >&2
    rm -f "$tmp"
    return 1
  fi

  cat "$tmp"
  rm -f "$tmp"

  if [[ ! "$http_code" =~ ^2 ]]; then
    echo "❌ Error: Cloudflare API returned HTTP ${http_code}" >&2
    return 1
  fi
  return 0
}

cf_parse_dns_record() {
  # Output: id\ttype\tname\tcontent\tproxied
  # Exit codes:
  # - 0: found
  # - 1: not found
  # - 2: invalid JSON
  # - 3: Cloudflare API error (prints messages to stderr)
  node -e "$(cat <<'NODE'
const fs = require("node:fs");

const rawAll = fs.readFileSync(0, "utf8");
const raw = rawAll.trim();

// Some curl configs can prepend HTTP headers; find the first JSON object.
const start = raw.indexOf("{");
if (start === -1) {
  const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
  console.error("❌ Error: Failed to parse Cloudflare API response as JSON (no '{' found)");
  console.error("Response preview:", JSON.stringify(preview));
  process.exit(2);
}

let data;
try {
  data = JSON.parse(raw.slice(start));
} catch {
  const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
  console.error("❌ Error: Failed to parse Cloudflare API response as JSON");
  console.error("Response preview:", JSON.stringify(preview));
  process.exit(2);
}

if (!data.success) {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  if (errors.length > 0) {
    for (const err of errors) {
      console.error("❌ Cloudflare API: " + (err.message || JSON.stringify(err)));
    }
  } else {
    console.error("❌ Error: Cloudflare API request failed");
  }
  process.exit(3);
}

const results = Array.isArray(data.result) ? data.result : [];
const record = results.find((r) => ["A", "AAAA", "CNAME"].includes(r.type)) || null;
if (!record) {
  process.exit(1);
}

process.stdout.write(
  [
    record.id,
    record.type,
    record.name,
    record.content,
    record.proxied ? "true" : "false",
  ].join("\t"),
);
NODE
)"
}

cf_assert_success() {
  # Exit codes:
  # - 0: success
  # - 2: invalid JSON
  # - 3: Cloudflare API error (prints messages to stderr)
  node -e "$(cat <<'NODE'
const fs = require("node:fs");

const rawAll = fs.readFileSync(0, "utf8");
const raw = rawAll.trim();

const start = raw.indexOf("{");
if (start === -1) {
  const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
  console.error("❌ Error: Cloudflare API returned a non-JSON response");
  console.error("Response preview:", JSON.stringify(preview));
  process.exit(2);
}

let data;
try {
  data = JSON.parse(raw.slice(start));
} catch {
  const preview = raw.slice(0, 200).replace(/\n/g, "\\n");
  console.error("❌ Error: Failed to parse Cloudflare API response as JSON");
  console.error("Response preview:", JSON.stringify(preview));
  process.exit(2);
}

if (!data.success) {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  if (errors.length > 0) {
    for (const err of errors) {
      console.error("❌ Cloudflare API: " + (err.message || JSON.stringify(err)));
    }
  } else {
    console.error("❌ Error: Cloudflare API request failed");
  }
  process.exit(3);
}
NODE
)"
}

ensure_panel_dns() {
  echo "🧭 Ensuring DNS exists for https://${DOMAIN}"
  echo "   (Workers routes do not create DNS records; the hostname must exist + be proxied.)"

  local resp
  if ! resp="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${DOMAIN}&per_page=100")"; then
    echo "❌ Error: Failed to query Cloudflare DNS records"
    exit 1
  fi

  local record_line
  local record_id
  local record_type
  local record_name
  local record_content
  local record_proxied

  if record_line="$(printf "%s" "$resp" | cf_parse_dns_record)"; then
    IFS=$'\t' read -r record_id record_type record_name record_content record_proxied <<< "$record_line"

    echo "✅ DNS record found: ${record_type} ${record_name} (proxied=${record_proxied})"
    if [[ "$record_proxied" != "true" ]]; then
      echo "🔧 Enabling Cloudflare proxy (orange cloud) for ${record_name}..."
      if ! cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}" '{"proxied":true}' | cf_assert_success >/dev/null; then
        echo "❌ Error: Failed to enable proxy for DNS record ${record_name}"
        exit 1
      fi
      echo "✅ Proxy enabled"
    fi
  else
    local code="$?"
    if [[ "$code" -eq 1 ]]; then
      echo "➕ No DNS record found for ${DOMAIN}; creating a proxied record..."
      echo "   Note: The origin IP is unused because the Worker handles requests."

      local create_body
      create_body=$(cat <<EOF
{"type":"A","name":"${DOMAIN}","content":"192.0.2.1","ttl":1,"proxied":true}
EOF
)
      if ! cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$create_body" | cf_assert_success >/dev/null; then
        echo "❌ Error: Failed to create DNS record for ${DOMAIN}"
        exit 1
      fi
      echo "✅ DNS record created (proxied)"
    else
      echo "❌ Error: Failed to query Cloudflare DNS records"
      exit 1
    fi
  fi

  echo ""
}

ensure_panel_dns

echo "🔐 Checking Cloudflare deployment authentication..."
if ! wrangler whoami >/dev/null 2>&1; then
  echo ""
  echo "⚠️  Wrangler is not authenticated for Workers operations (secrets/deploy)."
  echo "We'll try to fix this by logging you in via OAuth."
  echo ""

  # Clear any existing wrangler session (token-mode sessions can block OAuth).
  wrangler logout >/dev/null 2>&1 || true

  # OAuth login (opens browser). Note: some wrangler failures can return exit code 0,
  # so we always verify after attempting login.
  wrangler login || true

  if ! wrangler whoami >/dev/null 2>&1; then
    echo ""
    echo "❌ Error: Still not authenticated for Workers operations."
    echo "Try this manually, then re-run this script:"
    echo "  1) pnpm exec wrangler logout"
    echo "  2) pnpm exec wrangler login"
    echo ""
    exit 1
  fi
fi

echo "✅ Authenticated with Cloudflare"
echo ""

ensure_runtime_state_kv_namespace_ids

echo "🚀 Deploying to Cloudflare Workers..."
echo "   Domain: $DOMAIN"
echo "   Zone: $ZONE_NAME"
echo "   Backend: aws"
echo "   Dev Login: disabled"
echo ""

WORKER_NAME="$(get_worker_name)"
if [[ -z "$WORKER_NAME" ]]; then
  echo "❌ Error: Could not determine Worker name from $WRANGLER_CONFIG_FILE"
  exit 1
fi

echo "📦 Building Next.js app..."
prepare_next_build_env_file
if ! MC_BACKEND_MODE=aws ENABLE_DEV_LOGIN=false pnpm build; then
  echo ""
  echo "❌ Error: Failed to build Next.js app"
  exit 1
fi
echo "✅ Next.js build successful"
echo ""

echo "📦 Building for Cloudflare (OpenNext)..."
if ! MC_BACKEND_MODE=aws ENABLE_DEV_LOGIN=false pnpm exec opennextjs-cloudflare build --skipNextBuild; then
  echo ""
  echo "❌ Error: Failed to build for Cloudflare"
  exit 1
fi
echo "✅ Build successful"
echo ""

prepare_wrangler_deploy_config

echo "🌐 Deploying to Cloudflare..."
if ! retry 3 wrangler deploy --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" --route "$DOMAIN/*" --compatibility-date=2024-09-23; then
  echo ""
  echo "❌ Error: Failed to deploy to Cloudflare Workers"
  exit 1
fi
echo "✅ Deploy successful"
echo ""

# Upload secrets from selected deployment env file
# Note: MC_BACKEND_MODE and ENABLE_DEV_LOGIN are exported above for the build process
# but are NOT uploaded as Cloudflare secrets - they default correctly at runtime.
echo "🔑 Uploading secrets from $ENV_FILE..."

SECRET_COUNT=0
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
    echo ""
    echo "❌ Error: Invalid env var name in $ENV_FILE:$LINE_NO: '$key'"
    echo "Secrets must be uppercase letters/numbers/underscores (e.g. FOO_BAR)."
    exit 1
  fi

  if ! is_worker_secret_allowed "$key"; then
    echo ""
    echo "❌ Error: Refusing to upload unapproved Worker secret key '$key' from $ENV_FILE:$LINE_NO"
    echo "Allowed Worker secret keys:"
    print_worker_secret_allowlist
    exit 1
  fi

  # Strip surrounding quotes
  value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

  # Skip if value is empty
  [[ -z "$value" ]] && continue

  echo ""
  echo "  Setting: $key"

  put_secret() {
    local put_key="$1"
    local put_value="$2"
    echo "$put_value" | wrangler secret put --name "$WORKER_NAME" "$put_key"
  }

  if ! retry 3 put_secret "$key" "$value"; then
    echo ""
    echo "❌ Error: Failed to set secret: $key (see error above)"
    exit 1
  fi
  # Avoid `set -e` exiting on a post-increment from 0.
  ((SECRET_COUNT+=1))
done < "$ENV_FILE"

echo "✅ Secrets uploaded ($SECRET_COUNT secrets)"
echo ""

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
