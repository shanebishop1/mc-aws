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
CLOUDFLARE_DEPLOY_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
DEPLOYMENT_MANIFEST_FILE="${MC_AWS_DEPLOYMENT_MANIFEST:-.mc-aws-deployment.json}"
CLOUDFLARE_ACCOUNT_ID_VALUE=""
WORKER_OWNERSHIP_STATE="unknown"
WORKER_LIVE_DEPLOYMENT_ID=""
PANEL_ROUTE_OWNERSHIP="unproven"
PANEL_ROUTE_ID=""
PANEL_ROUTE_ORIGINAL_SCRIPT=""

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

  # Parse effective dotenv keys so whitespace and export forms cannot bypass
  # deployment-only credential filtering. Empty AWS values also block Next.js
  # from reloading human credentials from .env.local.
  if ! pnpm exec tsx scripts/deploy-env.ts sanitize-build-env \
    --env-file "$ENV_FILE" --output "$NEXT_BUILD_ENV_FILE"; then
    echo "❌ Error: Failed to prepare sanitized Next.js build environment"
    exit 1
  fi
  chmod 600 "$NEXT_BUILD_ENV_FILE" || true
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
# Treat CLOUDFLARE_API_TOKEN as a Wrangler deploy credential only. It is a
# deprecated alias for Minecraft DNS config in app validation, so keep it out of
# the app/build environment when DuckDNS or no-domain mode is selected.
unset CLOUDFLARE_API_TOKEN

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
  # If a deploy-scoped CLOUDFLARE_API_TOKEN is present, pass it through for
  # non-interactive deploy environments where OAuth cannot complete.
  #
  # Keep PATH/HOME so node, browser launcher, and wrangler config still work.
  env -i \
    PATH="$PATH" \
    HOME="$WRANGLER_HOME_DIR" \
    TERM="${TERM:-}" \
    USER="${USER:-}" \
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_API_TOKEN:-}" \
    "$WRANGLER_BIN" "$@"
}

manifest() {
  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/deployment-manifest.mjs "$@" >/dev/null
}

is_worker_not_found_output() {
  [[ "$1" =~ (^|[^0-9])10090([^0-9]|$) ]]
}

deployment_id_from_status_json() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) process.exit(2);
const deployment = JSON.parse(raw.slice(start));
if (typeof deployment.id !== "string" || !deployment.id) process.exit(2);
process.stdout.write(deployment.id);
'
}

record_worker_deployment_identity() {
  local deployments_json deployment_id
  deployments_json="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || {
    echo "❌ Error: Could not read the deployed Worker identity"
    exit 1
  }
  deployment_id="$(printf '%s' "$deployments_json" | deployment_id_from_status_json)"
  if [[ -z "$deployment_id" ]]; then
    echo "❌ Error: Worker deployment succeeded but no provider deployment ID was returned"
    exit 1
  fi
  manifest cloudflare-deployed --deployment-id "$deployment_id"
  echo "✅ Recorded immutable Worker deployment evidence: $deployment_id"
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
    if ! output="$(wrangler --config /dev/null kv namespace create "$binding_name" --preview 2>&1)"; then
      printf '%s\n' "$output"
      return 1
    fi
  else
    if ! output="$(wrangler --config /dev/null kv namespace create "$binding_name" 2>&1)"; then
      printf '%s\n' "$output"
      return 1
    fi
  fi

  printf '%s\n' "$output"
  return 0
}

get_kv_namespace_title() {
  local namespace_id="$1"
  local namespaces_json
  if ! namespaces_json="$(wrangler --config /dev/null kv namespace list 2>/dev/null)"; then
    return 1
  fi

  printf '%s' "$namespaces_json" | node -e '
const fs = require("node:fs");
const id = process.argv[1];
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("[");
if (start === -1) process.exit(1);
const entries = JSON.parse(raw.slice(start));
const match = entries.find((entry) => entry.id === id);
if (!match || typeof match.title !== "string" || !match.title) process.exit(1);
process.stdout.write(match.title);
' "$namespace_id"
}

record_kv_namespace() {
  local binding="$1"
  local namespace_id="$2"
  local ownership="$3"
  local title
  if ! title="$(get_kv_namespace_title "$namespace_id")"; then
    echo "❌ Error: KV namespace $namespace_id was not found in the authenticated Cloudflare account"
    exit 1
  fi
  manifest kv --binding "$binding" --id "$namespace_id" --title "$title" --ownership "$ownership"
}

ensure_runtime_state_kv_namespace_ids() {
  local runtime_state_snapshot_kv_id
  runtime_state_snapshot_kv_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID")"

  local runtime_state_snapshot_kv_preview_id
  runtime_state_snapshot_kv_preview_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID")"

  if is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id" &&
    { [[ -z "$runtime_state_snapshot_kv_preview_id" ]] || is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; }; then
    record_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV" "$runtime_state_snapshot_kv_id" "preexisting"
    if [[ -n "$runtime_state_snapshot_kv_preview_id" ]]; then
      record_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW" "$runtime_state_snapshot_kv_preview_id" "preexisting"
    fi
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
    record_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV" "$runtime_state_snapshot_kv_id" "created"
    echo "✅ Created RUNTIME_STATE_SNAPSHOT_KV_ID and saved it to $ENV_FILE"
  else
    record_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV" "$runtime_state_snapshot_kv_id" "preexisting"
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
  record_kv_namespace "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW" "$runtime_state_snapshot_kv_preview_id" "created"
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

  WRANGLER_DEPLOY_CONFIG_FILE="$(mktemp "wrangler.deploy.XXXXXX.jsonc")"

  if ! pnpm exec tsx scripts/panel-hosting.ts prepare-config \
    --source "$WRANGLER_CONFIG_FILE" \
    --output "$WRANGLER_DEPLOY_CONFIG_FILE" \
    --kv-id "$runtime_state_snapshot_kv_id" \
    --kv-preview-id "$runtime_state_snapshot_kv_preview_id" \
    --mode "$PANEL_HOSTING_MODE" \
    --custom-workers-dev "$PANEL_WORKERS_DEV_ENABLED"; then
    echo "❌ Error: Failed to prepare runtime-state Wrangler deploy config"
    exit 1
  fi

  echo "✅ Prepared Wrangler config with validated runtime state and workers_dev=${PANEL_WORKERS_DEV_ENABLED}"
}

WRANGLER_DEPLOY_ARGS=()

prepare_wrangler_deploy_args() {
  local helper_args=(
    deployment-args
    --config "$WRANGLER_DEPLOY_CONFIG_FILE"
    --worker-name "$WORKER_NAME"
    --mode "$PANEL_HOSTING_MODE"
  )
  if [[ "$PANEL_HOSTING_MODE" == "custom" ]]; then
    helper_args+=(--hostname "$DOMAIN")
  fi

  local args_output
  if ! args_output="$(pnpm exec tsx scripts/panel-hosting.ts "${helper_args[@]}")"; then
    echo "❌ Error: Failed to construct safe Wrangler deployment arguments"
    exit 1
  fi

  WRANGLER_DEPLOY_ARGS=()
  while IFS= read -r argument; do
    [[ -n "$argument" ]] && WRANGLER_DEPLOY_ARGS+=("$argument")
  done <<< "$args_output"
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

WORKER_NAME="$(get_worker_name)"
if [[ -z "$WORKER_NAME" ]]; then
  echo "❌ Error: Could not determine Worker name from $WRANGLER_CONFIG_FILE"
  exit 1
fi

echo "🔍 Validating panel hosting configuration..."
PANEL_VALIDATION_OUTPUT="$(pnpm exec tsx scripts/panel-hosting.ts validate-env \
  --env-file "$ENV_FILE" --worker-name "$WORKER_NAME")" || {
  echo "❌ Error: panel hosting configuration is invalid"
  exit 1
}
IFS=$'\t' read -r PANEL_HOSTING_MODE NEXT_PUBLIC_APP_URL PANEL_WORKERS_DEV_ENABLED PANEL_DNS_MANAGEMENT <<< "$PANEL_VALIDATION_OUTPUT"
echo "✅ Panel hosting mode: $PANEL_HOSTING_MODE (workers_dev=$PANEL_WORKERS_DEV_ENABLED)"
if [[ "$PANEL_HOSTING_MODE" == "custom" ]]; then
  echo "   Panel DNS management: $PANEL_DNS_MANAGEMENT"
fi
echo "   Canonical URL: $NEXT_PUBLIC_APP_URL"
echo "   Google OAuth callback: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
echo ""

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

# Extract domain from NEXT_PUBLIC_APP_URL
# e.g., https://panel.example.com -> panel.example.com
DOMAIN=$(echo "$NEXT_PUBLIC_APP_URL" | sed -E 's#https?://([^/]+).*#\1#')

# Extract zone name (base domain)
# e.g., panel.shane-bishop.com -> shane-bishop.com
ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

CF_DNS_API_TOKEN="$(get_env_value "CLOUDFLARE_PANEL_DNS_API_TOKEN")"
if [[ "$PANEL_HOSTING_MODE" == "custom" && "$PANEL_DNS_MANAGEMENT" == "external" && -z "$CF_DNS_API_TOKEN" ]]; then
  # External mode never calls DNS APIs. Reuse the shell-only Wrangler credential
  # transiently for the zone-scoped route ownership checks only.
  CF_DNS_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN"
fi
CF_ZONE_ID="$(get_env_value "CLOUDFLARE_PANEL_ZONE_ID")"
if [[ "$PANEL_HOSTING_MODE" == "custom" && -z "$CF_DNS_API_TOKEN" ]]; then
  echo "❌ Error: Custom panel route ownership checks require a Cloudflare API token."
  echo "   Set CLOUDFLARE_PANEL_DNS_API_TOKEN for managed DNS, or export CLOUDFLARE_API_TOKEN for external DNS."
  exit 1
fi

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

const results = Array.isArray(data.result) ? data.result : data.result ? [data.result] : [];
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

  if [[ -z "$CF_ZONE_ID" || -z "$CF_DNS_API_TOKEN" ]]; then
    echo "❌ Error: Custom panel hosting requires panel-specific Cloudflare zone and DNS credentials."
    exit 1
  fi

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
    local original_proxied="$record_proxied"
    local modified="false"

    echo "✅ DNS record found: ${record_type} ${record_name} (proxied=${record_proxied})"
    if [[ "$record_proxied" != "true" ]]; then
      echo "🔧 Enabling Cloudflare proxy (orange cloud) for ${record_name}..."
      if ! cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}" '{"proxied":true}' | cf_assert_success >/dev/null; then
        echo "❌ Error: Failed to enable proxy for DNS record ${record_name}"
        exit 1
      fi
      echo "✅ Proxy enabled"
      record_proxied="true"
      modified="true"
    fi
    manifest dns --zone "$CF_ZONE_ID" --id "$record_id" --name "$record_name" --type "$record_type" \
      --content "$record_content" --proxied "$record_proxied" --ownership preexisting \
      --modified "$modified" --original-proxied "$original_proxied"
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
      local create_response
      if ! create_response="$(cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$create_body")" || \
        ! printf '%s' "$create_response" | cf_assert_success >/dev/null; then
        echo "❌ Error: Failed to create DNS record for ${DOMAIN}"
        exit 1
      fi
      if ! record_line="$(printf '%s' "$create_response" | cf_parse_dns_record)"; then
        echo "❌ Error: Panel DNS record was created but its ownership ID could not be captured"
        exit 1
      fi
      IFS=$'\t' read -r record_id record_type record_name record_content record_proxied <<< "$record_line"
      manifest dns --zone "$CF_ZONE_ID" --id "$record_id" --name "$record_name" --type "$record_type" \
        --content "$record_content" --proxied "$record_proxied" --ownership created --modified false
      echo "✅ DNS record created (proxied)"
    else
      echo "❌ Error: Failed to query Cloudflare DNS records"
      exit 1
    fi
  fi

  echo ""
}

cf_parse_worker_route() {
  local expected_pattern="$1"
  node -e '
const fs = require("node:fs");
const expected = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));
if (data.success !== true || !Array.isArray(data.result)) process.exit(2);
const route = data.result.find((entry) => entry.pattern === expected);
if (!route) process.exit(1);
process.stdout.write([route.id || "", route.pattern, route.script || ""].join("\t"));
' "$expected_pattern"
}

capture_panel_route_before_deploy() {
  [[ "$PANEL_HOSTING_MODE" == "custom" ]] || return 0
  local pattern="${DOMAIN}/*"
  local response route_line
  if ! response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")"; then
    echo "❌ Error: Could not inventory Worker routes with the panel token."
    echo "   Refusing deployment because an existing route cannot be safely distinguished or restored."
    echo "   Grant Workers Routes Read/Edit for the panel zone and retry."
    exit 1
  fi
  if route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")"; then
    IFS=$'\t' read -r PANEL_ROUTE_ID _ PANEL_ROUTE_ORIGINAL_SCRIPT <<< "$route_line"
    PANEL_ROUTE_OWNERSHIP="preexisting"
    manifest route --zone "$CF_ZONE_ID" --id "$PANEL_ROUTE_ID" --pattern "$pattern" --script "$WORKER_NAME" \
      --ownership preexisting --original-script "$PANEL_ROUTE_ORIGINAL_SCRIPT"
  else
    local status="$?"
    if [[ "$status" -ne 1 ]]; then
      echo "❌ Error: Cloudflare returned an invalid Worker route inventory"
      exit 1
    fi
    PANEL_ROUTE_OWNERSHIP="created"
    manifest route --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$WORKER_NAME" --ownership created
  fi
}

capture_panel_route_after_deploy() {
  [[ "$PANEL_HOSTING_MODE" == "custom" ]] || return 0
  [[ "$PANEL_ROUTE_OWNERSHIP" != "unproven" ]] || return 0
  local pattern="${DOMAIN}/*"
  local response route_line route_pattern route_script live_route_id
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")" || {
    echo "❌ Error: Could not verify the custom Worker route after deployment"
    exit 1
  }
  route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")" || {
    echo "❌ Error: Expected custom Worker route '$pattern' was not found after deployment"
    exit 1
  }
  IFS=$'\t' read -r live_route_id route_pattern route_script <<< "$route_line"
  if [[ "$route_script" != "$WORKER_NAME" ]]; then
    echo "❌ Error: Route '$pattern' does not target the deployed Worker '$WORKER_NAME'"
    exit 1
  fi
  if [[ "$PANEL_ROUTE_OWNERSHIP" == "preexisting" && "$live_route_id" != "$PANEL_ROUTE_ID" ]]; then
    echo "❌ Error: Route '$pattern' was replaced during deployment; refusing to inherit ownership"
    exit 1
  fi
  PANEL_ROUTE_ID="$live_route_id"
  if [[ "$PANEL_ROUTE_OWNERSHIP" == "preexisting" ]]; then
    manifest route --zone "$CF_ZONE_ID" --id "$PANEL_ROUTE_ID" --pattern "$pattern" --script "$WORKER_NAME" \
      --ownership preexisting --original-script "$PANEL_ROUTE_ORIGINAL_SCRIPT"
  else
    manifest route --zone "$CF_ZONE_ID" --id "$PANEL_ROUTE_ID" --pattern "$pattern" --script "$WORKER_NAME" --ownership created
  fi
}

echo "🔐 Checking Cloudflare deployment authentication..."
if ! wrangler --config /dev/null whoami >/dev/null 2>&1; then
  echo ""
  echo "⚠️  Wrangler is not authenticated for Workers operations (secrets/deploy)."
  echo "We'll try to fix this by logging you in via OAuth."
  echo ""

  # Clear any existing wrangler session (token-mode sessions can block OAuth).
  wrangler --config /dev/null logout >/dev/null 2>&1 || true

  # OAuth login (opens browser). Note: some wrangler failures can return exit code 0,
  # so we always verify after attempting login.
  wrangler --config /dev/null login || true

  if ! wrangler --config /dev/null whoami >/dev/null 2>&1; then
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

whoami_output="$(wrangler --config /dev/null whoami)"
CLOUDFLARE_ACCOUNT_ID_VALUE="$(printf '%s' "$whoami_output" | grep -Eo '[A-Fa-f0-9]{32}' | head -n 1 || true)"
if [[ -z "$CLOUDFLARE_ACCOUNT_ID_VALUE" ]]; then
  echo "❌ Error: Could not determine the authenticated Cloudflare account ID"
  exit 1
fi

worker_probe=""
if worker_probe="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
  WORKER_OWNERSHIP_STATE="existing"
  WORKER_LIVE_DEPLOYMENT_ID="$(printf '%s' "$worker_probe" | deployment_id_from_status_json)" || {
    echo "❌ Error: Existing Worker returned malformed deployment identity data"
    exit 1
  }
elif is_worker_not_found_output "$worker_probe"; then
  WORKER_OWNERSHIP_STATE="absent"
else
  echo "❌ Error: Worker pre-existence could not be proven. Refusing to overwrite code or secrets."
  echo "$worker_probe"
  exit 1
fi
manifest cloudflare-init --account "$CLOUDFLARE_ACCOUNT_ID_VALUE" --worker "$WORKER_NAME" \
  --worker-state "$WORKER_OWNERSHIP_STATE" --live-deployment "${WORKER_LIVE_DEPLOYMENT_ID:-none}" \
  --mode "$PANEL_HOSTING_MODE" --workers-dev "$PANEL_WORKERS_DEV_ENABLED"
echo "✅ Cloudflare ownership inventory recorded in $DEPLOYMENT_MANIFEST_FILE"
echo ""

capture_panel_route_before_deploy

if [[ "$PANEL_HOSTING_MODE" == "custom" && "$PANEL_DNS_MANAGEMENT" == "managed" ]]; then
  ensure_panel_dns
elif [[ "$PANEL_HOSTING_MODE" == "custom" ]]; then
  echo "🧭 Preserving externally managed panel DNS for ${DOMAIN}; no DNS records will be read, created, modified, or recorded"
  echo ""
else
  echo "🧭 Skipping panel DNS checks for workers.dev hosting"
  echo ""
fi

ensure_runtime_state_kv_namespace_ids

echo "🚀 Deploying to Cloudflare Workers..."
echo "   Panel mode: $PANEL_HOSTING_MODE"
echo "   URL: $NEXT_PUBLIC_APP_URL"
if [[ "$PANEL_HOSTING_MODE" == "custom" ]]; then
  echo "   Zone: $ZONE_NAME"
fi
echo "   Backend: aws"
echo "   Dev Login: disabled"
echo ""

echo "📦 Building Next.js app..."
prepare_next_build_env_file
if ! env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  MC_BACKEND_MODE=aws ENABLE_DEV_LOGIN= pnpm build; then
  echo ""
  echo "❌ Error: Failed to build Next.js app"
  exit 1
fi
echo "✅ Next.js build successful"
echo ""

prepare_wrangler_deploy_config
prepare_wrangler_deploy_args

echo "📦 Building for Cloudflare (OpenNext)..."
if ! env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  MC_BACKEND_MODE=aws ENABLE_DEV_LOGIN= pnpm exec opennextjs-cloudflare build --skipNextBuild --config "$WRANGLER_DEPLOY_CONFIG_FILE"; then
  echo ""
  echo "❌ Error: Failed to build for Cloudflare"
  exit 1
fi
echo "✅ Build successful"
echo ""

echo "🌐 Deploying to Cloudflare..."
if ! retry 3 wrangler "${WRANGLER_DEPLOY_ARGS[@]}"; then
  echo ""
  echo "❌ Error: Failed to deploy to Cloudflare Workers"
  exit 1
fi
echo "✅ Deploy successful"
echo ""
capture_panel_route_after_deploy
record_worker_deployment_identity

# Upload secrets from selected deployment env file
# Note: MC_BACKEND_MODE is exported above for the build process but is NOT uploaded
# as a Cloudflare secret. ENABLE_DEV_LOGIN is explicitly unset for production.
echo "🔑 Uploading secrets from $ENV_FILE..."

put_secret() {
  local put_key="$1"
  local put_value="$2"
  echo "$put_value" | wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key"
  record_worker_deployment_identity
}

put_secret_base64() {
  local put_key="$1"
  local encoded_value="$2"
  node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$encoded_value" | \
    wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key"
  record_worker_deployment_identity
}

SECRET_COUNT=0
if ! SECRET_ENTRIES_OUTPUT="$(pnpm exec tsx scripts/deploy-env.ts worker-secret-entries --env-file "$ENV_FILE")"; then
  echo "❌ Error: Failed to parse approved Worker secrets from $ENV_FILE"
  exit 1
fi
while IFS=$'\t' read -r key encoded_value; do
  [[ -z "$key" ]] && continue
  echo ""
  echo "  Setting: $key"
  if ! retry 3 put_secret_base64 "$key" "$encoded_value"; then
    echo ""
    echo "❌ Error: Failed to set secret: $key (see error above)"
    exit 1
  fi
  # Avoid `set -e` exiting on a post-increment from 0.
  ((SECRET_COUNT+=1))
done <<< "$SECRET_ENTRIES_OUTPUT"
unset SECRET_ENTRIES_OUTPUT encoded_value

if [[ -z "$(get_env_value "AWS_ACCOUNT_ID")" && -n "$(get_env_value "CDK_DEFAULT_ACCOUNT")" ]]; then
  echo ""
  echo "  Setting: AWS_ACCOUNT_ID (from CDK_DEFAULT_ACCOUNT)"

  if ! retry 3 put_secret "AWS_ACCOUNT_ID" "$(get_env_value "CDK_DEFAULT_ACCOUNT")"; then
    echo ""
    echo "❌ Error: Failed to set derived secret: AWS_ACCOUNT_ID (see error above)"
    exit 1
  fi

  ((SECRET_COUNT+=1))
fi

echo "✅ Secrets uploaded ($SECRET_COUNT secrets)"
echo ""

echo "🔁 Restoring non-secret Worker bindings after secret upload..."
if ! retry 3 wrangler "${WRANGLER_DEPLOY_ARGS[@]}"; then
  echo ""
  echo "❌ Error: Failed to restore Worker bindings after secret upload"
  exit 1
fi
echo "✅ Worker bindings restored"
echo ""
record_worker_deployment_identity

echo "🔐 Provisioning dedicated least-privilege AWS runtime credentials..."
if ! VERIFY_URL="$NEXT_PUBLIC_APP_URL" \
  WORKER_NAME="$WORKER_NAME" \
  WRANGLER_CONFIG_FILE="$WRANGLER_DEPLOY_CONFIG_FILE" \
  WRANGLER_HOME_DIR="$WRANGLER_HOME_DIR" \
  CLOUDFLARE_DEPLOY_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN" \
  bash scripts/rotate-worker-runtime-key.sh; then
  echo ""
  echo "❌ Error: Dedicated Worker runtime credential provisioning/rotation failed"
  echo "   No previously valid runtime IAM key is revoked until its replacement verifies."
  exit 1
fi
echo ""

if [[ "$PANEL_HOSTING_MODE" == "workers_dev" ]]; then
  echo "✅ Verified actual Workers URL through runtime credential probe: $NEXT_PUBLIC_APP_URL"
  echo "   Google OAuth redirect URI: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
  echo ""
fi

record_worker_deployment_identity

echo ""
echo "✅✅✅ Deployment complete! ✅✅✅"
echo ""
echo "   🌍 Your app is live at: $NEXT_PUBLIC_APP_URL"
echo "   📊 Dashboard: https://dash.cloudflare.com"
echo ""
echo "Next steps:"
echo "   1. Test your deployment at $NEXT_PUBLIC_APP_URL"
echo "   2. Check the Cloudflare dashboard for logs and metrics"
echo "   3. Verify all functionality is working as expected"
echo ""
