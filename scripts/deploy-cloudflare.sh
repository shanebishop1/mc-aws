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
CLOUDFLARE_DEPLOY_API_TOKEN="${CLOUDFLARE_DEPLOY_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
DEPLOYMENT_MANIFEST_FILE="${MC_AWS_DEPLOYMENT_MANIFEST:-.mc-aws-deployment.json}"
RECOVERY_RECORD_FILE="${MC_AWS_CLOUDFLARE_RECOVERY_RECORD:-${DEPLOYMENT_MANIFEST_FILE}.cloudflare-recovery.json}"
RECOVERY_HISTORY_FILE="${RECOVERY_RECORD_FILE}.last"
CLOUDFLARE_ACCOUNT_ID_VALUE=""
WORKER_OWNERSHIP_STATE="unknown"
WORKER_LIVE_DEPLOYMENT_ID=""
WORKER_LIVE_VERSIONS_JSON="[]"
WORKER_SECRET_INVENTORY_JSON="[]"
WORKER_BINDING_INVENTORY_JSON="[]"
RUNTIME_IAM_USER_NAME=""
RUNTIME_KEY_INVENTORY_JSON="[]"
PANEL_ROUTE_OWNERSHIP="unproven"
PANEL_ROUTE_ID=""
PANEL_ROUTE_ORIGINAL_SCRIPT=""
PANEL_ROUTE_PREFLIGHT_JSON="[]"
PANEL_DNS_PREFLIGHT_STATE="unmanaged"
PANEL_DNS_PREFLIGHT_JSON="null"
MUTATION_STARTED="0"
DEPLOYMENT_SUCCEEDED="0"
RECOVERY_RUNNING="0"
CURRENT_DEPLOYMENT_STAGE="preflight"

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

on_deploy_exit() {
  local status="$?"
  set +e
  if [[ "$status" -ne 0 && "$MUTATION_STARTED" == "1" && "$DEPLOYMENT_SUCCEEDED" != "1" && "$RECOVERY_RUNNING" != "1" ]]; then
    echo ""
    echo "⚠️  Deployment failed during stage '$CURRENT_DEPLOYMENT_STAGE'; starting recorded recovery." >&2
    recover_after_deploy_failure || {
      echo "❌ Automatic recovery is incomplete. Preserve $RECOVERY_RECORD_FILE and follow docs/CLOUDFLARE_DEPLOYMENT_RECOVERY.md." >&2
    }
  fi
  cleanup_deploy_artifacts
  return "$status"
}

RECOVERY_PENDING_EARLY="0"
[[ -e "$RECOVERY_RECORD_FILE" ]] && RECOVERY_PENDING_EARLY="1"
if [[ "$RECOVERY_PENDING_EARLY" == "0" ]]; then
  resolve_env_file
  echo "🧪 Using environment file: $ENV_FILE"
else
  echo "🩹 Active recovery record detected before deployment preflight: $RECOVERY_RECORD_FILE"
fi
echo ""

trap on_deploy_exit EXIT

if [[ "$RECOVERY_PENDING_EARLY" == "0" && ! -f "$WRANGLER_CONFIG_FILE" ]]; then
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

manifest_route_state() {
  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/deployment-manifest.mjs route-state "$@"
}

is_worker_not_found_output() {
  [[ "$1" =~ (^|[^0-9])(10007|10090)([^0-9]|$) ]]
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

deployment_versions_from_status_json() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) process.exit(2);
const deployment = JSON.parse(raw.slice(start));
if (!Array.isArray(deployment.versions) || deployment.versions.length === 0) process.exit(2);
const versions = deployment.versions.map(({ version_id, percentage }) => {
  if (typeof version_id !== "string" || !version_id || typeof percentage !== "number") process.exit(2);
  return { versionId: version_id, percentage };
});
process.stdout.write(JSON.stringify(versions));
'
}

current_version_id_from_status_json() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) process.exit(2);
const deployment = JSON.parse(raw.slice(start));
const versions = Array.isArray(deployment.versions) ? deployment.versions : [];
const version = versions.find((entry) => entry.percentage === 100) || (versions.length === 1 ? versions[0] : null);
if (!version || typeof version.version_id !== "string") process.exit(2);
process.stdout.write(version.version_id);
'
}

sanitize_secret_inventory() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("[");
if (start === -1) process.exit(2);
const entries = JSON.parse(raw.slice(start));
if (!Array.isArray(entries)) process.exit(2);
process.stdout.write(JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.type })).filter((entry) =>
  typeof entry.name === "string" && typeof entry.type === "string"
)));
'
}

sanitize_binding_inventory() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const start = raw.indexOf("{");
if (start === -1) process.exit(2);
const version = JSON.parse(raw.slice(start));
const candidates = version.resources?.bindings || version.bindings || version.metadata?.bindings || [];
if (!Array.isArray(candidates)) process.exit(2);
const allowed = ["name", "type", "namespace_id", "id", "service", "environment"];
const bindings = candidates.map((binding) => Object.fromEntries(allowed
  .filter((key) => typeof binding[key] === "string")
  .map((key) => [key, binding[key]])));
process.stdout.write(JSON.stringify(bindings));
'
}

deployment_stage() {
  CURRENT_DEPLOYMENT_STAGE="$1"
  if [[ "$MUTATION_STARTED" == "1" && -f "$RECOVERY_RECORD_FILE" ]]; then
    update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE"
  fi
  if [[ "${MC_AWS_DEPLOY_FAIL_STAGE:-}" == "$CURRENT_DEPLOYMENT_STAGE" ]]; then
    echo "❌ Injected deployment failure at stage: $CURRENT_DEPLOYMENT_STAGE" >&2
    return 1
  fi
}

write_recovery_record() {
  RECOVERY_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_VALUE" \
  RECOVERY_WORKER_NAME="$WORKER_NAME" \
  RECOVERY_WORKER_STATE="$WORKER_OWNERSHIP_STATE" \
  RECOVERY_DEPLOYMENT_ID="${WORKER_LIVE_DEPLOYMENT_ID:-}" \
  RECOVERY_VERSIONS_JSON="$WORKER_LIVE_VERSIONS_JSON" \
  RECOVERY_ROUTES_JSON="$PANEL_ROUTE_PREFLIGHT_JSON" \
  RECOVERY_DNS_STATE="$PANEL_DNS_PREFLIGHT_STATE" \
  RECOVERY_DNS_JSON="$PANEL_DNS_PREFLIGHT_JSON" \
  RECOVERY_SECRETS_JSON="$WORKER_SECRET_INVENTORY_JSON" \
  RECOVERY_BINDINGS_JSON="$WORKER_BINDING_INVENTORY_JSON" \
  RECOVERY_RUNTIME_USER="$RUNTIME_IAM_USER_NAME" \
  RECOVERY_RUNTIME_KEYS_JSON="$RUNTIME_KEY_INVENTORY_JSON" \
  RECOVERY_MODE="$PANEL_HOSTING_MODE" \
  RECOVERY_WORKERS_DEV="$PANEL_WORKERS_DEV_ENABLED" \
  RECOVERY_ZONE_ID="${CF_ZONE_ID:-}" \
  RECOVERY_DOMAIN="${DOMAIN:-}" \
  RECOVERY_LIFECYCLE_TABLE="$(get_env_value "MC_LIFECYCLE_LOCK_TABLE_NAME")" \
  RECOVERY_OPERATION_TABLE="$(get_env_value "MC_OPERATION_STATE_TABLE_NAME")" \
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node <<'NODE'
const fs = require("node:fs");
const path = process.env.RECOVERY_RECORD_FILE;
if (fs.existsSync(path)) throw new Error(`active recovery record already exists: ${path}`);
const parse = (name) => JSON.parse(process.env[name]);
const record = {
  schemaVersion: 1,
  project: "mc-aws",
  status: "active",
  decision: "rollback",
  stage: "preflight-recorded",
  createdAt: new Date().toISOString(),
  cloudflare: {
    accountId: process.env.RECOVERY_ACCOUNT_ID,
    worker: {
      name: process.env.RECOVERY_WORKER_NAME,
      state: process.env.RECOVERY_WORKER_STATE,
      deploymentId: process.env.RECOVERY_DEPLOYMENT_ID || null,
      versions: parse("RECOVERY_VERSIONS_JSON"),
      secrets: parse("RECOVERY_SECRETS_JSON"),
      bindings: parse("RECOVERY_BINDINGS_JSON"),
    },
    panelHostingMode: process.env.RECOVERY_MODE,
    workersDevEnabled: process.env.RECOVERY_WORKERS_DEV === "true",
    zoneId: process.env.RECOVERY_ZONE_ID,
    domain: process.env.RECOVERY_DOMAIN,
    routes: parse("RECOVERY_ROUTES_JSON"),
    dns: { state: process.env.RECOVERY_DNS_STATE, record: parse("RECOVERY_DNS_JSON") },
    applied: { workerDeploymentId: null, routeId: null, dnsRecordId: null },
  },
  runtimeIdentity: {
    userName: process.env.RECOVERY_RUNTIME_USER,
    keys: parse("RECOVERY_RUNTIME_KEYS_JSON"),
    candidateKeyId: null,
    phase: "baseline",
  },
  runtimeConfig: {
    lifecycleLockTableName: process.env.RECOVERY_LIFECYCLE_TABLE,
    operationStateTableName: process.env.RECOVERY_OPERATION_TABLE,
  },
  limitations: [
    "Cloudflare secret values are write-only and are not stored in this record.",
    "Rollback redeploys the recorded immutable Worker version whose secret bindings reference the prior secrets.",
  ],
};
const temporary = `${path}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
fs.renameSync(temporary, path);
fs.chmodSync(path, 0o600);
NODE
  echo "✅ Durable recovery record written before provider mutation: $RECOVERY_RECORD_FILE"
}

update_recovery_progress() {
  local stage="$1"
  local decision="${2:-}"
  local worker_deployment_id="${3:-}"
  local route_id="${4:-}"
  local dns_record_id="${5:-}"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_STAGE="$stage" RECOVERY_DECISION="$decision" \
    RECOVERY_WORKER_DEPLOYMENT_ID="$worker_deployment_id" RECOVERY_ROUTE_ID="$route_id" \
    RECOVERY_DNS_RECORD_ID="$dns_record_id" node <<'NODE'
const fs=require("node:fs"); const path=process.env.RECOVERY_RECORD_FILE; const stat=fs.lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600)throw new Error("unsafe recovery record");
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active")throw new Error("inactive recovery record");
record.stage=process.env.RECOVERY_STAGE;
if(process.env.RECOVERY_DECISION)record.decision=process.env.RECOVERY_DECISION;
if(process.env.RECOVERY_WORKER_DEPLOYMENT_ID)record.cloudflare.applied.workerDeploymentId=process.env.RECOVERY_WORKER_DEPLOYMENT_ID;
if(process.env.RECOVERY_ROUTE_ID)record.cloudflare.applied.routeId=process.env.RECOVERY_ROUTE_ID;
if(process.env.RECOVERY_DNS_RECORD_ID)record.cloudflare.applied.dnsRecordId=process.env.RECOVERY_DNS_RECORD_ID;
record.updatedAt=new Date().toISOString(); const temporary=`${path}.tmp.${process.pid}`;
fs.writeFileSync(temporary,`${JSON.stringify(record,null,2)}\n`,{mode:0o600,flag:"wx"}); fs.renameSync(temporary,path);
NODE
}

update_recovery_record() {
  local status="$1"
  local stage="$2"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_STATUS="$status" RECOVERY_STAGE="$stage" node <<'NODE'
const fs = require("node:fs");
const path = process.env.RECOVERY_RECORD_FILE;
const stat = fs.lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
  throw new Error(`unsafe recovery record: ${path}`);
}
const record = JSON.parse(fs.readFileSync(path, "utf8"));
if (record.schemaVersion !== 1 || record.project !== "mc-aws" || record.status !== "active") {
  throw new Error(`invalid active recovery record: ${path}`);
}
record.status = process.env.RECOVERY_STATUS;
record.stage = process.env.RECOVERY_STAGE;
record.updatedAt = new Date().toISOString();
const temporary = `${path}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
fs.renameSync(temporary, path);
NODE
}

finalize_recovery_record() {
  local status="$1"
  update_recovery_record "$status" "$CURRENT_DEPLOYMENT_STAGE"
  mv "$RECOVERY_RECORD_FILE" "$RECOVERY_HISTORY_FILE"
  chmod 600 "$RECOVERY_HISTORY_FILE" || true
  echo "✅ Recovery record finalized: $RECOVERY_HISTORY_FILE"
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
  [[ "$MUTATION_STARTED" == "1" ]] && update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" "" "$deployment_id"
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
  pnpm exec tsx scripts/wrangler-config.ts worker-name "$WRANGLER_CONFIG_FILE"
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
    return 2
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

  local namespace_title probe_status
  if is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_id"; then
    if namespace_title="$(get_kv_namespace_title "$runtime_state_snapshot_kv_id")"; then
      :
    else
      probe_status="$?"
      if [[ "$probe_status" -eq 2 ]]; then
        echo "❌ Error: Cloudflare KV inventory failed while validating RUNTIME_STATE_SNAPSHOT_KV_ID"
        exit 1
      fi
      echo "🔁 Recorded runtime-state KV namespace is absent; creating a replacement"
      runtime_state_snapshot_kv_id=""
      update_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID" ""
    fi
  fi
  if is_cloudflare_kv_namespace_id "$runtime_state_snapshot_kv_preview_id"; then
    if namespace_title="$(get_kv_namespace_title "$runtime_state_snapshot_kv_preview_id")"; then
      :
    else
      probe_status="$?"
      if [[ "$probe_status" -eq 2 ]]; then
        echo "❌ Error: Cloudflare KV inventory failed while validating RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID"
        exit 1
      fi
      echo "🔁 Recorded preview KV namespace is absent; creating a replacement"
      runtime_state_snapshot_kv_preview_id=""
      update_env_value "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID" ""
    fi
  fi

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
    --custom-workers-dev "$PANEL_WORKERS_DEV_ENABLED" \
    --lifecycle-lock-table "$(get_env_value "MC_LIFECYCLE_LOCK_TABLE_NAME")" \
    --operation-state-table "$(get_env_value "MC_OPERATION_STATE_TABLE_NAME")"; then
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

if [[ "$RECOVERY_PENDING_EARLY" == "1" ]]; then
  EARLY_RECOVERY_CONTEXT="$(RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
if(r.schemaVersion!==1||r.project!=="mc-aws"||r.status!=="active")process.exit(1);
process.stdout.write([r.cloudflare.worker.name,r.cloudflare.panelHostingMode,r.cloudflare.workersDevEnabled?"true":"false",r.cloudflare.domain,r.cloudflare.zoneId,r.cloudflare.dns.state].join("\t"));
')" || { echo "❌ Active recovery record is malformed; refusing normal preflight." >&2; exit 1; }
  IFS=$'\t' read -r WORKER_NAME PANEL_HOSTING_MODE PANEL_WORKERS_DEV_ENABLED DOMAIN CF_ZONE_ID PANEL_DNS_PREFLIGHT_STATE <<< "$EARLY_RECOVERY_CONTEXT"
  NEXT_PUBLIC_APP_URL="https://${DOMAIN}"
  ZONE_NAME="$DOMAIN"
  PANEL_DNS_MANAGEMENT="managed"
  [[ "$PANEL_DNS_PREFLIGHT_STATE" == "unmanaged" ]] && PANEL_DNS_MANAGEMENT="external"
  CF_DNS_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN"
  if [[ -f "$ENV_FILE" && "$PANEL_DNS_MANAGEMENT" == "managed" ]]; then
    CF_DNS_API_TOKEN="$(get_env_value "CLOUDFLARE_PANEL_DNS_API_TOKEN")"
  fi
else
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
echo "   Google sign-in callback: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
echo "   Google Drive callback: ${NEXT_PUBLIC_APP_URL%/}/api/gdrive/callback"
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

capture_panel_dns_before_deploy() {
  if [[ "$PANEL_HOSTING_MODE" != "custom" || "$PANEL_DNS_MANAGEMENT" != "managed" ]]; then
    PANEL_DNS_PREFLIGHT_STATE="unmanaged"
    PANEL_DNS_PREFLIGHT_JSON="null"
    return 0
  fi

  local response record_line record_id record_type record_name record_content record_proxied status
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${DOMAIN}&per_page=100")" || {
    echo "❌ Error: Could not inventory panel DNS before deployment" >&2
    exit 1
  }
  if record_line="$(printf '%s' "$response" | cf_parse_dns_record)"; then
    IFS=$'\t' read -r record_id record_type record_name record_content record_proxied <<< "$record_line"
    PANEL_DNS_PREFLIGHT_STATE="existing"
    PANEL_DNS_PREFLIGHT_JSON="$(DNS_ID="$record_id" DNS_TYPE="$record_type" DNS_NAME="$record_name" \
      DNS_CONTENT="$record_content" DNS_PROXIED="$record_proxied" node -e '
process.stdout.write(JSON.stringify({
  id: process.env.DNS_ID, type: process.env.DNS_TYPE, name: process.env.DNS_NAME,
  content: process.env.DNS_CONTENT, proxied: process.env.DNS_PROXIED === "true",
}));
')"
  else
    status="$?"
    [[ "$status" -eq 1 ]] || { echo "❌ Error: Cloudflare returned an invalid panel DNS inventory" >&2; exit 1; }
    PANEL_DNS_PREFLIGHT_STATE="absent"
    PANEL_DNS_PREFLIGHT_JSON="null"
  fi
}

capture_worker_bindings_and_secrets() {
  if [[ "$WORKER_OWNERSHIP_STATE" == "absent" ]]; then
    WORKER_SECRET_INVENTORY_JSON="[]"
    WORKER_BINDING_INVENTORY_JSON="[]"
    return 0
  fi
  local secrets_json version_ids version_id version_json sanitized_bindings
  secrets_json="$(wrangler secret list --config /dev/null --name "$WORKER_NAME" --format json)" || exit 1
  WORKER_SECRET_INVENTORY_JSON="$(printf '%s' "$secrets_json" | sanitize_secret_inventory)" || exit 1
  version_ids="$(VERSIONS_JSON="$WORKER_LIVE_VERSIONS_JSON" node -e '
for(const version of JSON.parse(process.env.VERSIONS_JSON)) console.log(version.versionId);
')" || exit 1
  WORKER_BINDING_INVENTORY_JSON="[]"
  while IFS= read -r version_id; do
    [[ -n "$version_id" ]] || continue
    version_json="$(wrangler versions view "$version_id" --config /dev/null --name "$WORKER_NAME" --json)" || exit 1
    sanitized_bindings="$(printf '%s' "$version_json" | sanitize_binding_inventory)" || exit 1
    WORKER_BINDING_INVENTORY_JSON="$(EXISTING="$WORKER_BINDING_INVENTORY_JSON" BINDINGS="$sanitized_bindings" \
      VERSION_ID="$version_id" node -e '
const existing=JSON.parse(process.env.EXISTING); existing.push({versionId:process.env.VERSION_ID,bindings:JSON.parse(process.env.BINDINGS)});
process.stdout.write(JSON.stringify(existing));
')" || exit 1
  done <<< "$version_ids"
}

capture_runtime_key_identity() {
  local stack_name runtime_tags access_keys
  stack_name="${STACK_NAME:-MinecraftStack}"
  RUNTIME_IAM_USER_NAME="$(AWS_PAGER="" aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='WorkerRuntimeIamUserName'].OutputValue | [0]" --output text)" || exit 1
  [[ -n "$RUNTIME_IAM_USER_NAME" && "$RUNTIME_IAM_USER_NAME" != "None" ]] || {
    echo "❌ Error: Could not resolve the Worker runtime IAM identity before Cloudflare mutation" >&2; exit 1;
  }
  runtime_tags="$(AWS_PAGER="" aws iam list-user-tags --user-name "$RUNTIME_IAM_USER_NAME" --output json)" || exit 1
  printf '%s' "$runtime_tags" | node -e '
const fs=require("node:fs"); const tags=Object.fromEntries((JSON.parse(fs.readFileSync(0,"utf8")).Tags||[]).map(({Key,Value})=>[Key,Value]));
if(tags.McAwsProject!=="mc-aws"||tags.McAwsPurpose!=="CloudflareWorkerRuntime")process.exit(1);
' || { echo "❌ Error: Runtime IAM identity tags do not prove mc-aws ownership" >&2; exit 1; }
  access_keys="$(AWS_PAGER="" aws iam list-access-keys --user-name "$RUNTIME_IAM_USER_NAME" --output json)" || exit 1
  RUNTIME_KEY_INVENTORY_JSON="$(printf '%s' "$access_keys" | node -e '
const fs=require("node:fs"); const keys=JSON.parse(fs.readFileSync(0,"utf8")).AccessKeyMetadata||[];
process.stdout.write(JSON.stringify(keys.map(({AccessKeyId,Status,CreateDate})=>({accessKeyId:AccessKeyId,status:Status,createDate:CreateDate}))));
')" || exit 1
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
    local live_dns_json
    live_dns_json="$(DNS_ID="$record_id" DNS_TYPE="$record_type" DNS_NAME="$record_name" \
      DNS_CONTENT="$record_content" DNS_PROXIED="$record_proxied" node -e '
process.stdout.write(JSON.stringify({id:process.env.DNS_ID,type:process.env.DNS_TYPE,name:process.env.DNS_NAME,content:process.env.DNS_CONTENT,proxied:process.env.DNS_PROXIED==="true"}));
')"
    if [[ "$PANEL_DNS_PREFLIGHT_STATE" != "existing" || "$live_dns_json" != "$PANEL_DNS_PREFLIGHT_JSON" ]]; then
      echo "❌ Error: Panel DNS changed after preflight; refusing to overwrite concurrent state" >&2
      exit 1
    fi
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
      if [[ "$PANEL_DNS_PREFLIGHT_STATE" != "absent" ]]; then
        echo "❌ Error: Panel DNS disappeared after preflight; refusing concurrent-state mutation" >&2
        exit 1
      fi
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

  [[ "$MUTATION_STARTED" == "1" ]] && update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" "" "" "" "$record_id"
  echo ""
}

cf_parse_worker_route() {
  local expected_pattern="$1"
  node -e '
const fs = require("node:fs");
const expected = process.argv[1];
let data;
try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(2); }
if (data.success !== true || !Array.isArray(data.result)) process.exit(2);
const route = data.result.find((entry) => entry.pattern === expected);
if (!route) process.exit(1);
process.stdout.write([route.id || "", route.pattern, route.script || ""].join("\t"));
' "$expected_pattern"
}

capture_panel_route_before_deploy() {
  [[ "$PANEL_HOSTING_MODE" == "custom" ]] || return 0
  local pattern="${DOMAIN}/*"
  local response route_line route_pattern route_script route_state
  if ! response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")"; then
    echo "❌ Error: Could not inventory Worker routes with the panel token."
    echo "   Refusing deployment because an existing route cannot be safely distinguished or restored."
    echo "   Grant Workers Routes Read/Edit for the panel zone and retry."
    exit 1
  fi
  if route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")"; then
    IFS=$'\t' read -r PANEL_ROUTE_ID route_pattern route_script <<< "$route_line"
    if [[ "$route_pattern" != "$pattern" ]]; then
      echo "❌ Error: Worker route inventory returned an unexpected pattern"
      exit 1
    fi
    if [[ "$route_script" != "$WORKER_NAME" ]]; then
      echo "❌ Error: Existing route '$pattern' targets '$route_script', not '$WORKER_NAME'." >&2
      echo "   Automatic replacement of a pre-existing route is unsupported; no provider mutation was attempted." >&2
      exit 1
    fi
    PANEL_ROUTE_PREFLIGHT_JSON="$(ROUTE_ID="$PANEL_ROUTE_ID" ROUTE_PATTERN="$pattern" ROUTE_SCRIPT="$route_script" node -e '
process.stdout.write(JSON.stringify([{ id: process.env.ROUTE_ID, pattern: process.env.ROUTE_PATTERN, script: process.env.ROUTE_SCRIPT }]));
')"
    if ! route_state="$(manifest_route_state --zone "$CF_ZONE_ID" --id "$PANEL_ROUTE_ID" --pattern "$pattern" \
      --script "$route_script")"; then
      echo "❌ Error: Existing Worker route does not match the validated deployment manifest"
      exit 1
    fi
    if [[ "$route_state" == "created" ]]; then
      PANEL_ROUTE_OWNERSHIP="created"
    elif [[ "$route_state" == "preexisting" ]]; then
      echo "❌ Error: The exact panel route is recorded as pre-existing." >&2
      echo "   Wrangler may replace its immutable route ID, so this deployment cannot restore it exactly." >&2
      echo "   Refusing unsupported pre-existing route replacement before any provider mutation." >&2
      exit 1
    elif [[ "$route_state" == "untracked" ]]; then
      echo "❌ Error: The exact panel route exists but has no project ownership evidence." >&2
      echo "   Refusing unsupported pre-existing route replacement before any provider mutation." >&2
      exit 1
    else
      echo "❌ Error: Deployment manifest returned an invalid Worker route ownership state"
      exit 1
    fi
  else
    local status="$?"
    if [[ "$status" -ne 1 ]]; then
      echo "❌ Error: Cloudflare returned an invalid Worker route inventory"
      exit 1
    fi
    if ! route_state="$(manifest_route_state --zone "$CF_ZONE_ID" --id absent --pattern "$pattern" --script absent)"; then
      echo "❌ Error: Missing Worker route does not match the validated deployment manifest"
      exit 1
    fi
    if [[ "$route_state" == "preexisting" ]]; then
      echo "❌ Error: A pre-existing manifest route is unexpectedly absent"
      exit 1
    fi
    if [[ "$route_state" != "created" && "$route_state" != "untracked" ]]; then
      echo "❌ Error: Deployment manifest returned an invalid Worker route ownership state"
      exit 1
    fi
    PANEL_ROUTE_OWNERSHIP="created"
    PANEL_ROUTE_PREFLIGHT_JSON="[]"
    if [[ "$route_state" == "untracked" ]]; then
      manifest route --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$WORKER_NAME" --ownership created
    fi
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
  if [[ "$route_pattern" != "$pattern" ]]; then
    echo "❌ Error: Verified Worker route pattern does not exactly match '$pattern'"
    exit 1
  fi
  if [[ "$route_script" != "$WORKER_NAME" ]]; then
    echo "❌ Error: Route '$pattern' does not target the deployed Worker '$WORKER_NAME'"
    exit 1
  fi
  if [[ "$live_route_id" != "$PANEL_ROUTE_ID" && -n "$PANEL_ROUTE_ID" ]]; then
    echo "🔁 Worker route ID replaced during deployment: $PANEL_ROUTE_ID -> $live_route_id"
    manifest route --zone "$CF_ZONE_ID" --id "$live_route_id" --pattern "$pattern" --script "$WORKER_NAME" \
      --ownership created --replaces-id "$PANEL_ROUTE_ID"
    PANEL_ROUTE_OWNERSHIP="created"
  elif [[ "$PANEL_ROUTE_OWNERSHIP" == "preexisting" ]]; then
    manifest route --zone "$CF_ZONE_ID" --id "$PANEL_ROUTE_ID" --pattern "$pattern" --script "$WORKER_NAME" \
      --ownership preexisting --original-script "$PANEL_ROUTE_ORIGINAL_SCRIPT"
  else
    manifest route --zone "$CF_ZONE_ID" --id "$live_route_id" --pattern "$pattern" --script "$WORKER_NAME" --ownership created
  fi
  PANEL_ROUTE_ID="$live_route_id"
  [[ "$MUTATION_STARTED" == "1" ]] && update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" "" "" "$live_route_id"
}

recovery_value() {
  local selector="$1"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs = require("node:fs");
const selector = process.argv[1].split(".");
let value = JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE, "utf8"));
for (const part of selector) value = value?.[part];
if (value === undefined) process.exit(2);
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
' "$selector"
}

validate_recovery_record() {
  [[ -f "$RECOVERY_RECORD_FILE" ]] || return 1
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" EXPECTED_ACCOUNT="$CLOUDFLARE_ACCOUNT_ID_VALUE" \
    EXPECTED_WORKER="$WORKER_NAME" node <<'NODE'
const fs = require("node:fs");
const path = process.env.RECOVERY_RECORD_FILE;
const stat = fs.lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
  throw new Error(`recovery record must be an owned regular 0600 file with one link: ${path}`);
}
if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("recovery record owner mismatch");
const record = JSON.parse(fs.readFileSync(path, "utf8"));
if (record.schemaVersion !== 1 || record.project !== "mc-aws" || record.status !== "active") {
  throw new Error("unsupported or inactive recovery record");
}
if (record.cloudflare?.accountId !== process.env.EXPECTED_ACCOUNT ||
    record.cloudflare?.worker?.name !== process.env.EXPECTED_WORKER) {
  throw new Error("recovery record Cloudflare identity mismatch");
}
if (!Array.isArray(record.cloudflare.worker.versions) || !Array.isArray(record.cloudflare.routes) ||
    !Array.isArray(record.runtimeIdentity?.keys)) throw new Error("malformed recovery inventory");
NODE
}

run_runtime_rotation() {
  local mode="$1"
  VERIFY_URL="$NEXT_PUBLIC_APP_URL" \
    WORKER_NAME="$WORKER_NAME" \
    RUNTIME_IAM_USER_NAME="$(recovery_value runtimeIdentity.userName)" \
    WRANGLER_CONFIG_FILE="${WRANGLER_DEPLOY_CONFIG_FILE:-/dev/null}" \
    WRANGLER_HOME_DIR="$WRANGLER_HOME_DIR" \
    CLOUDFLARE_DEPLOY_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN" \
    MC_AWS_CLOUDFLARE_RECOVERY_RECORD="$RECOVERY_RECORD_FILE" \
    ROTATION_MODE="$mode" bash scripts/rotate-worker-runtime-key.sh
}

assert_lifecycle_recovery_unblocked() {
  local ssm_output lifecycle_table dynamo_output
  if ssm_output="$(AWS_PAGER="" aws ssm get-parameter --name /minecraft/server-action --output json 2>&1)"; then
    echo "❌ Lifecycle remains blocked by /minecraft/server-action; recovery will not be reported complete." >&2
    return 1
  elif [[ "$ssm_output" != *"ParameterNotFound"* ]]; then
    echo "❌ Could not prove legacy lifecycle lock absence: $ssm_output" >&2
    return 1
  fi
  lifecycle_table="$(recovery_value runtimeConfig.lifecycleLockTableName)" || return 1
  [[ -n "$lifecycle_table" ]] || return 0
  dynamo_output="$(AWS_PAGER="" aws dynamodb get-item --table-name "$lifecycle_table" \
    --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' --consistent-read --output json)" || return 1
  if ! printf '%s' "$dynamo_output" | node -e '
const fs=require("node:fs"); const item=JSON.parse(fs.readFileSync(0,"utf8")).Item;
if(!item)process.exit(0); if(item.released?.BOOL===true)process.exit(0);
const lease=Number(item.leaseExpiresAt?.N); if(Number.isFinite(lease)&&lease<Date.now())process.exit(0); process.exit(1);
'; then
    echo "❌ DynamoDB lifecycle lease remains active or malformed; recovery remains incomplete." >&2
    return 1
  fi
}

restore_recorded_routes() {
  [[ "$(recovery_value cloudflare.panelHostingMode)" == "custom" ]] || return 0
  local prior_routes pattern response route_line route_id route_pattern route_script prior_id prior_script create_response applied_id expected_manifest_id
  prior_routes="$(recovery_value cloudflare.routes)"
  applied_id="$(recovery_value cloudflare.applied.routeId)"
  [[ "$applied_id" != "null" ]] || applied_id=""
  pattern="${DOMAIN}/*"
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")" || return 1
  if [[ "$prior_routes" != "[]" ]]; then
    prior_id="$(ROUTES_JSON="$prior_routes" node -e 'const r=JSON.parse(process.env.ROUTES_JSON); if(r.length!==1)process.exit(1); process.stdout.write(r[0].id)')" || return 1
    prior_script="$(ROUTES_JSON="$prior_routes" node -e 'const r=JSON.parse(process.env.ROUTES_JSON); if(r.length!==1)process.exit(1); process.stdout.write(r[0].script)')" || return 1
    [[ "$prior_script" == "$WORKER_NAME" ]] || return 1
    expected_manifest_id="${applied_id:-$prior_id}"
    if route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")"; then
      IFS=$'\t' read -r route_id route_pattern route_script <<< "$route_line"
      [[ "$route_script" == "$prior_script" ]] || {
        echo "❌ Recorded route now targets concurrent state '$route_script'; refusing overwrite." >&2
        return 1
      }
      if [[ -n "$applied_id" && "$route_id" != "$applied_id" ]]; then
        echo "❌ Live route ID does not match the transaction-journaled route ID; refusing concurrent state." >&2
        return 1
      fi
    else
      [[ "$?" -eq 1 ]] || return 1
      create_response="$(cf_api POST "/zones/${CF_ZONE_ID}/workers/routes" "{\"pattern\":\"${pattern}\",\"script\":\"${prior_script}\"}")" || return 1
      printf '%s' "$create_response" | cf_assert_success >/dev/null || return 1
      response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")" || return 1
      route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")" || return 1
      IFS=$'\t' read -r route_id route_pattern route_script <<< "$route_line"
    fi
    manifest route-recovered --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$prior_script" \
      --baseline-state present --expected-current-id "$expected_manifest_id" --restored-id "$route_id" || return 1
    return 0
  fi
  if route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")"; then
    IFS=$'\t' read -r route_id route_pattern route_script <<< "$route_line"
    if [[ "$route_script" != "$WORKER_NAME" ]]; then
      echo "❌ Route '$pattern' now targets '$route_script'; refusing to delete concurrent state." >&2
      return 1
    fi
    if [[ -z "$applied_id" || "$route_id" != "$applied_id" ]]; then
      echo "❌ Unjournaled route exists for an absent baseline; refusing deletion." >&2
      return 1
    fi
    cf_api DELETE "/zones/${CF_ZONE_ID}/workers/routes/${route_id}" | cf_assert_success >/dev/null || return 1
  else
    [[ "$?" -eq 1 ]] || return 1
  fi
  manifest route-recovered --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$WORKER_NAME" \
    --baseline-state absent --expected-current-id "${applied_id:-absent}" --restored-id absent || return 1
}

restore_recorded_dns() {
  local dns_state dns_json record_id original_proxied response record_line live_id live_type live_name live_content live_proxied expected_dns_identity live_dns_identity applied_dns_id
  dns_state="$(recovery_value cloudflare.dns.state)"
  applied_dns_id="$(recovery_value cloudflare.applied.dnsRecordId)"
  [[ "$applied_dns_id" != "null" ]] || applied_dns_id=""
  [[ "$dns_state" != "unmanaged" ]] || return 0
  dns_json="$(recovery_value cloudflare.dns.record)"
  if [[ "$dns_state" == "existing" ]]; then
    record_id="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).id)')"
    original_proxied="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_DNS_JSON).proxied))')"
    expected_dns_identity="$(RECOVERY_DNS_JSON="$dns_json" node -e 'const r=JSON.parse(process.env.RECOVERY_DNS_JSON); process.stdout.write([r.id,r.type,r.name,r.content].join("\t"))')"
    response="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}")" || return 1
    record_line="$(printf '%s' "$response" | cf_parse_dns_record)" || return 1
    IFS=$'\t' read -r live_id live_type live_name live_content live_proxied <<< "$record_line"
    live_dns_identity="$(printf '%s\t%s\t%s\t%s' "$live_id" "$live_type" "$live_name" "$live_content")"
    if [[ "$live_dns_identity" != "$expected_dns_identity" ]]; then
      echo "❌ Recorded DNS identity/content changed concurrently; refusing proxy restoration." >&2
      return 1
    fi
    cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}" "{\"proxied\":${original_proxied}}" | \
      cf_assert_success >/dev/null || return 1
    return 0
  fi
  [[ "$dns_state" == "absent" ]] || return 1
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${DOMAIN}&per_page=100")" || return 1
  if record_line="$(printf '%s' "$response" | cf_parse_dns_record)"; then
    IFS=$'\t' read -r live_id live_type live_name live_content live_proxied <<< "$record_line"
    if [[ -z "$applied_dns_id" || "$live_id" != "$applied_dns_id" ]]; then
      echo "❌ Unjournaled DNS record exists for an absent baseline; refusing deletion." >&2
      return 1
    fi
    if [[ "$live_type" != "A" || "$live_name" != "$DOMAIN" || "$live_content" != "192.0.2.1" || "$live_proxied" != "true" ]]; then
      echo "❌ Panel DNS now contains non-deployer state; refusing to delete it." >&2
      return 1
    fi
    cf_api DELETE "/zones/${CF_ZONE_ID}/dns_records/${live_id}" | cf_assert_success >/dev/null || return 1
  else
    [[ "$?" -eq 1 ]] || return 1
  fi
}

rollback_from_recovery_record() {
  RECOVERY_RUNNING="1"
  validate_recovery_record || return 1
  local prior_worker_state version_specs_output rollback_status
  CF_ZONE_ID="$(recovery_value cloudflare.zoneId)" || return 1
  DOMAIN="$(recovery_value cloudflare.domain)" || return 1
  prior_worker_state="$(recovery_value cloudflare.worker.state)" || return 1
  if [[ "$prior_worker_state" == "existing" ]]; then
    version_specs_output="$(RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
for (const version of r.cloudflare.worker.versions) console.log(`${version.versionId}@${version.percentage}%`);
')" || return 1
    local version_specs=()
    while IFS= read -r spec; do [[ -n "$spec" ]] && version_specs+=("$spec"); done <<< "$version_specs_output"
    [[ ${#version_specs[@]} -gt 0 ]] || return 1
    retry 3 wrangler versions deploy "${version_specs[@]}" --config /dev/null --name "$WORKER_NAME" --yes \
      --message "mc-aws automatic rollback from $CURRENT_DEPLOYMENT_STAGE" || return 1
    rollback_status="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
    WORKER_LIVE_DEPLOYMENT_ID="$(printf '%s' "$rollback_status" | deployment_id_from_status_json)" || return 1
    manifest cloudflare-deployed --deployment-id "$WORKER_LIVE_DEPLOYMENT_ID" || return 1
    restore_recorded_routes || return 1
  elif [[ "$prior_worker_state" == "absent" ]]; then
    restore_recorded_routes || return 1
    local current_worker_probe
    if current_worker_probe="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
      wrangler delete "$WORKER_NAME" --config /dev/null --force || return 1
    elif ! is_worker_not_found_output "$current_worker_probe"; then
      echo "❌ Error: Could not prove whether the newly created Worker exists during rollback." >&2
      return 1
    fi
  else
    return 1
  fi
  restore_recorded_dns || return 1
  run_runtime_rotation rollback || return 1
  assert_lifecycle_recovery_unblocked || return 1
  CURRENT_DEPLOYMENT_STAGE="rollback-complete"
  finalize_recovery_record "rolled_back" || return 1
  echo "✅ Recorded Worker deployment/routes/DNS recovery completed." >&2
  echo "   Previous secret values were not read; the recorded prior Worker version was redeployed." >&2
  RECOVERY_RUNNING="0"
}

recover_pending_deployment() {
  [[ -e "$RECOVERY_RECORD_FILE" ]] || return 0
  echo "⚠️  Found unfinished Cloudflare deployment record: $RECOVERY_RECORD_FILE" >&2
  local decision
  decision="$(recovery_value decision)" || exit 1
  if [[ "$decision" == "commit" ]]; then
    echo "   The commit decision is durable; resuming runtime-key cleanup without baseline rollback." >&2
    run_runtime_rotation finalize || exit 1
    record_worker_deployment_identity
    CURRENT_DEPLOYMENT_STAGE="success"
    DEPLOYMENT_SUCCEEDED="1"
    finalize_recovery_record "succeeded" || exit 1
    echo "   Forward recovery finished. The verified replacement remains deployed." >&2
  else
    echo "   Rolling it back before considering a new deployment." >&2
    rollback_from_recovery_record || exit 1
    echo "   Recovery finished. Re-run pnpm deploy:cf to start a fresh deployment." >&2
  fi
  exit 0
}

recover_after_deploy_failure() {
  local decision
  decision="$(recovery_value decision)" || return 1
  if [[ "$decision" == "commit" ]]; then
    echo "⚠️  Commit was already decided; resuming forward runtime-key cleanup instead of rollback." >&2
    run_runtime_rotation finalize || return 1
    record_worker_deployment_identity || return 1
    CURRENT_DEPLOYMENT_STAGE="success"
    DEPLOYMENT_SUCCEEDED="1"
    finalize_recovery_record "succeeded"
    return
  fi
  rollback_from_recovery_record
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

recover_pending_deployment

if ! PREFLIGHT_SECRET_ENTRIES_OUTPUT="$(pnpm exec tsx scripts/deploy-env.ts worker-secret-entries --env-file "$ENV_FILE")"; then
  echo "❌ Error: Failed to parse approved Worker secrets before provider mutation" >&2
  exit 1
fi

worker_probe=""
if worker_probe="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
  WORKER_OWNERSHIP_STATE="existing"
  WORKER_LIVE_DEPLOYMENT_ID="$(printf '%s' "$worker_probe" | deployment_id_from_status_json)" || {
    echo "❌ Error: Existing Worker returned malformed deployment identity data"
    exit 1
  }
  WORKER_LIVE_VERSIONS_JSON="$(printf '%s' "$worker_probe" | deployment_versions_from_status_json)" || {
    echo "❌ Error: Existing Worker returned malformed active-version data"
    exit 1
  }
elif is_worker_not_found_output "$worker_probe"; then
  WORKER_OWNERSHIP_STATE="absent"
  WORKER_LIVE_VERSIONS_JSON="[]"
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
capture_panel_dns_before_deploy
capture_worker_bindings_and_secrets
capture_runtime_key_identity
write_recovery_record
MUTATION_STARTED="1"
deployment_stage preflight-recorded || exit 1

deployment_stage kv-mutation || exit 1
ensure_runtime_state_kv_namespace_ids

if [[ "$PANEL_HOSTING_MODE" == "custom" && "$PANEL_DNS_MANAGEMENT" == "managed" ]]; then
  deployment_stage dns-mutation || exit 1
  ensure_panel_dns
elif [[ "$PANEL_HOSTING_MODE" == "custom" ]]; then
  echo "🧭 Preserving externally managed panel DNS for ${DOMAIN}; no DNS records will be read, created, modified, or recorded"
  echo ""
else
  echo "🧭 Skipping panel DNS checks for workers.dev hosting"
  echo ""
fi

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
deployment_stage worker-mutation || exit 1
if ! retry 3 wrangler "${WRANGLER_DEPLOY_ARGS[@]}"; then
  echo ""
  echo "❌ Error: Failed to deploy to Cloudflare Workers"
  exit 1
fi
echo "✅ Deploy successful"
echo ""
deployment_stage worker-deployed || exit 1
capture_panel_route_after_deploy
deployment_stage route-verified || exit 1
record_worker_deployment_identity

# Upload secrets from selected deployment env file
# Note: MC_BACKEND_MODE is exported above for the build process but is NOT uploaded
# as a Cloudflare secret. ENABLE_DEV_LOGIN is explicitly unset for production.
echo "🔑 Uploading secrets from $ENV_FILE..."

put_secret() {
  local put_key="$1"
  local put_value="$2"
  echo "$put_value" | \
    wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key" || return 1
  record_worker_deployment_identity
}

put_secret_base64() {
  local put_key="$1"
  local encoded_value="$2"
  node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$encoded_value" | \
    wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key" || return 1
  record_worker_deployment_identity
}

prune_obsolete_worker_secrets_bulk() {
  local deletion_patch="$1"
  printf '%s' "$deletion_patch" | \
    wrangler secret bulk --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" || return 1
  record_worker_deployment_identity
}

verify_deployed_secret_and_binding_inventory() {
  local live_secrets expected_entries expected_names deployments_json version_id version_json live_bindings expected_kv_id
  live_secrets="$(wrangler secret list --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" --format json)" || return 1
  live_secrets="$(printf '%s' "$live_secrets" | sanitize_secret_inventory)" || return 1
  expected_entries="$(pnpm exec tsx scripts/deploy-env.ts worker-secret-entries --env-file "$ENV_FILE")" || return 1
  expected_names="$(printf '%s' "$expected_entries" | node -e '
const fs=require("node:fs"); const names=fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean).map((line)=>line.split("\t",1)[0]);
process.stdout.write(JSON.stringify(names));
')" || return 1
  if [[ -z "$(get_env_value "AWS_ACCOUNT_ID")" && -n "$(get_env_value "CDK_DEFAULT_ACCOUNT")" ]]; then
    expected_names="$(EXPECTED_NAMES="$expected_names" node -e 'const n=JSON.parse(process.env.EXPECTED_NAMES); if(!n.includes("AWS_ACCOUNT_ID"))n.push("AWS_ACCOUNT_ID"); process.stdout.write(JSON.stringify(n))')"
  fi
  LIVE_SECRETS="$live_secrets" EXPECTED_NAMES="$expected_names" node -e '
const live = new Map(JSON.parse(process.env.LIVE_SECRETS).map((entry) => [entry.name, entry.type]));
for (const name of JSON.parse(process.env.EXPECTED_NAMES)) {
  if (!live.has(name) || !String(live.get(name)).startsWith("secret")) {
    console.error(`Missing expected secret binding: ${name}`); process.exit(1);
  }
}
' || return 1

  deployments_json="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
  version_id="$(printf '%s' "$deployments_json" | current_version_id_from_status_json)" || return 1
  version_json="$(wrangler versions view "$version_id" --config /dev/null --name "$WORKER_NAME" --json)" || return 1
  live_bindings="$(printf '%s' "$version_json" | sanitize_binding_inventory)" || return 1
  expected_kv_id="$(get_env_value "RUNTIME_STATE_SNAPSHOT_KV_ID")"
  LIVE_BINDINGS="$live_bindings" EXPECTED_KV_ID="$expected_kv_id" node -e '
const bindings=JSON.parse(process.env.LIVE_BINDINGS);
const kv=bindings.find((binding)=>binding.name==="RUNTIME_STATE_SNAPSHOT_KV");
if (!kv || (kv.namespace_id || kv.id) !== process.env.EXPECTED_KV_ID) {
  console.error("RUNTIME_STATE_SNAPSHOT_KV binding identity does not match deployment input"); process.exit(1);
}
' || return 1
  EXPECTED_LIFECYCLE_TABLE="$(get_env_value "MC_LIFECYCLE_LOCK_TABLE_NAME")" \
    EXPECTED_OPERATION_TABLE="$(get_env_value "MC_OPERATION_STATE_TABLE_NAME")" \
    VERSION_JSON="$version_json" node -e '
const raw=process.env.VERSION_JSON; const version=JSON.parse(raw.slice(raw.indexOf("{")));
const bindings=version.resources?.bindings||version.bindings||version.metadata?.bindings||[];
for(const [name,expected] of [["MC_LIFECYCLE_LOCK_TABLE_NAME",process.env.EXPECTED_LIFECYCLE_TABLE],["MC_OPERATION_STATE_TABLE_NAME",process.env.EXPECTED_OPERATION_TABLE]]) {
  const binding=bindings.find((item)=>item.name===name);
  if(!binding||binding.type!=="plain_text"||binding.text!==expected){console.error(`${name} plain-text binding mismatch`);process.exit(1);}
}
' || return 1
}

provider_secret_deletion_patch() {
  case "$(get_env_value "MC_CONNECTION_MODE")" in
    cloudflare)
      printf '%s' '{"DUCKDNS_DOMAIN":null,"DUCKDNS_TOKEN":null}'
      ;;
    duckdns)
      printf '%s' '{"CLOUDFLARE_DNS_API_TOKEN":null,"CLOUDFLARE_ZONE_ID":null,"CLOUDFLARE_RECORD_ID":null,"CLOUDFLARE_MC_DOMAIN":null}'
      ;;
    raw_ip)
      printf '%s' '{"CLOUDFLARE_DNS_API_TOKEN":null,"CLOUDFLARE_ZONE_ID":null,"CLOUDFLARE_RECORD_ID":null,"CLOUDFLARE_MC_DOMAIN":null,"DUCKDNS_DOMAIN":null,"DUCKDNS_TOKEN":null}'
      ;;
    *)
      echo "❌ Error: MC_CONNECTION_MODE is invalid while pruning provider secrets" >&2
      return 1
      ;;
  esac
}

SECRET_COUNT=0
SECRET_ENTRIES_OUTPUT="$PREFLIGHT_SECRET_ENTRIES_OUTPUT"
unset PREFLIGHT_SECRET_ENTRIES_OUTPUT
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

echo "🧹 Pruning secrets for inactive Minecraft DNS providers..."
if ! PROVIDER_SECRET_DELETION_PATCH="$(provider_secret_deletion_patch)" || \
  ! retry 3 prune_obsolete_worker_secrets_bulk "$PROVIDER_SECRET_DELETION_PATCH"; then
  echo "❌ Error: Failed to prune inactive Minecraft DNS provider secrets"
  exit 1
fi
unset PROVIDER_SECRET_DELETION_PATCH
echo "✅ Inactive Minecraft DNS provider secrets pruned"
echo ""

# Wrangler v4 secret bulk uses RFC 7396 merge-patch semantics: included null
# values are deleted and every omitted secret remains unchanged. Inventory the
# Worker first so an empty intersection is a no-op and only the explicit legacy
# policy can ever contribute deletion keys.
echo "🧹 Pruning explicitly obsolete Worker secrets..."
if ! WORKER_SECRET_INVENTORY="$(wrangler secret list --config "$WRANGLER_DEPLOY_CONFIG_FILE" \
  --name "$WORKER_NAME" --format json)"; then
  echo "❌ Error: Failed to inventory Worker secrets before legacy pruning"
  exit 1
fi
if ! LEGACY_SECRET_DELETION_PATCH="$(printf '%s' "$WORKER_SECRET_INVENTORY" | \
  pnpm exec tsx scripts/legacy-worker-secret-policy.ts merge-patch)"; then
  echo "❌ Error: Failed to apply the explicit legacy Worker secret policy"
  exit 1
fi
unset WORKER_SECRET_INVENTORY

if [[ "$LEGACY_SECRET_DELETION_PATCH" == "{}" ]]; then
  echo "✅ No obsolete Worker secrets found"
elif ! retry 3 prune_obsolete_worker_secrets_bulk "$LEGACY_SECRET_DELETION_PATCH"; then
  echo ""
  echo "❌ Error: Failed to prune explicitly obsolete Worker secrets"
  exit 1
else
  echo "✅ Obsolete Worker secrets pruned with one merge-patch request"
fi
unset LEGACY_SECRET_DELETION_PATCH
echo ""
deployment_stage secrets-mutated || exit 1

echo "🔁 Restoring non-secret Worker bindings after secret upload..."
if ! retry 3 wrangler "${WRANGLER_DEPLOY_ARGS[@]}"; then
  echo ""
  echo "❌ Error: Failed to restore Worker bindings after secret upload"
  exit 1
fi
echo "✅ Worker bindings restored"
echo ""
capture_panel_route_after_deploy
record_worker_deployment_identity

echo "🔎 Verifying deployed secret names/types and non-secret binding identities..."
if ! verify_deployed_secret_and_binding_inventory; then
  echo "❌ Error: Post-deploy Worker secret/binding verification failed" >&2
  exit 1
fi
echo "✅ Worker secret/binding inventory verified"
deployment_stage bindings-verified || exit 1

echo "🔐 Provisioning dedicated least-privilege AWS runtime credentials..."
deployment_stage runtime-key-verification || exit 1
if ! run_runtime_rotation prepare; then
  echo ""
  echo "❌ Error: Dedicated Worker runtime credential preparation failed"
  echo "   Every previously valid runtime IAM key remains available for rollback."
  exit 1
fi
deployment_stage runtime-key-prepared || exit 1
CURRENT_DEPLOYMENT_STAGE="commit-decided"
update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" commit
deployment_stage commit-decided || exit 1
if ! run_runtime_rotation finalize; then
  echo "❌ Error: Runtime key cleanup is incomplete after the durable commit decision." >&2
  echo "   The next deploy run will resume forward cleanup and will not attempt an impossible old-version rollback." >&2
  exit 1
fi
record_worker_deployment_identity
deployment_stage runtime-key-finalized || exit 1
echo ""

if [[ "$PANEL_HOSTING_MODE" == "workers_dev" ]]; then
  echo "✅ Verified actual Workers URL through runtime credential probe: $NEXT_PUBLIC_APP_URL"
  echo "   Google sign-in redirect URI: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
  echo "   Google Drive redirect URI: ${NEXT_PUBLIC_APP_URL%/}/api/gdrive/callback"
  echo ""
fi

CURRENT_DEPLOYMENT_STAGE="success"
DEPLOYMENT_SUCCEEDED="1"
if ! finalize_recovery_record "succeeded"; then
  echo "❌ Deployment and runtime verification succeeded, but the local recovery record could not be finalized." >&2
  echo "   Do not delete $RECOVERY_RECORD_FILE; inspect it before the next run." >&2
  exit 1
fi

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
