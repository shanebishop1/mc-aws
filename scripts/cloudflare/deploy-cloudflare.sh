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
NEXT_BUILD_ENV_BACKUP_FILE="${NEXT_BUILD_ENV_FILE}.mc-aws-backup"
NEXT_BUILD_ENV_MARKER_FILE="${NEXT_BUILD_ENV_FILE}.mc-aws-generated"
NEXT_BUILD_ENV_GENERATED_FILE=".mc-aws-generated-build.env"
NEXT_BUILD_ENV_STAGE_MARKER_FILE=".mc-aws-build-env-stage"
NEXT_BUILD_DOTENV_FILES=(".env.production.local" ".env.local" ".env.production" ".env")
NEXT_BUILD_ENV_PREPARED="0"
DEPLOY_API_TOKEN_VALUE="${CLOUDFLARE_DEPLOY_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
unset CLOUDFLARE_DEPLOY_API_TOKEN
CLOUDFLARE_DEPLOY_API_TOKEN="$DEPLOY_API_TOKEN_VALUE"
unset DEPLOY_API_TOKEN_VALUE
# The selected dotenv file is the only source for Worker values. Remove any
# same-named exported shell values before starting helper/build processes so a
# caller's environment cannot become an accidental credential transport.
unset AUTH_SECRET ADMIN_EMAIL MC_AGENT_RUNTIME_TOKEN MC_AGENT_RUNTIME_TOKEN_SHA256 \
  MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8 GOOGLE_CLIENT_SECRET GDRIVE_PASSWORD DUCKDNS_TOKEN \
  CLOUDFLARE_DNS_API_TOKEN CLOUDFLARE_API_TOKEN CREDENTIALS_DIRECTORY GITHUB_TOKEN
DEPLOYMENT_MANIFEST_FILE="${MC_AWS_DEPLOYMENT_MANIFEST:-.mc-aws-deployment.json}"
RECOVERY_STATE_DIRECTORY="${MC_AWS_CLOUDFLARE_RECOVERY_STATE_DIRECTORY:-.mc-aws-state}"
RECOVERY_RECORD_FILE="${MC_AWS_CLOUDFLARE_RECOVERY_RECORD:-${RECOVERY_STATE_DIRECTORY}/cloudflare-deployment-recovery.json}"
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
DEPLOY_LOCK_DIR=".mc-aws-cloudflare-deploy.lock"
DEPLOY_LOCK_ACQUIRED="0"
DEPLOY_ENV_FD=""
DEPLOY_ENV_SOURCE="$ENV_FILE"
RUNTIME_STATE_SNAPSHOT_KV_ID=""
RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID=""
MC_BACKEND_MODE_VALUE=""
DEPLOY_ARTIFACT_MERKLE_SHA256=""
DEPLOY_UPLOAD_CONFIG_SHA256=""
WRANGLER_UPLOAD_STAGE_DIR=""
WRANGLER_UPLOAD_FINAL_DIR=""
DEPLOYMENT_RECEIPT_SHA256=""

release_deployment_lock() {
  if [[ "$DEPLOY_LOCK_ACQUIRED" != "1" || ! -L "$DEPLOY_LOCK_DIR" ]]; then
    return 0
  fi
  local owner_pid=""
  owner_pid="$(readlink "$DEPLOY_LOCK_DIR" 2>/dev/null || true)"
  if [[ "$owner_pid" == "$$" ]]; then
    rm -f "$DEPLOY_LOCK_DIR"
  fi
}

acquire_deployment_lock() {
  if ln -s "$$" "$DEPLOY_LOCK_DIR" 2>/dev/null; then
    DEPLOY_LOCK_ACQUIRED="1"
    return 0
  fi
  if [[ ! -L "$DEPLOY_LOCK_DIR" ]]; then
    echo "❌ Error: Refusing unsafe Cloudflare deployment lock path: $DEPLOY_LOCK_DIR" >&2
    return 1
  fi

  local owner_pid=""
  owner_pid="$(readlink "$DEPLOY_LOCK_DIR" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    echo "❌ Error: Another Cloudflare deployment is active (PID $owner_pid)." >&2
    return 1
  fi
  echo "❌ Error: A stale Cloudflare deployment lock remains at $DEPLOY_LOCK_DIR (recorded PID: ${owner_pid:-invalid})." >&2
  echo "Verify no deployment process is active, remove that exact lock, then rerun so recorded provider recovery can proceed." >&2
  return 1
}

resolve_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ Error: Deployment env file not found: $ENV_FILE"
    echo "Tip: set a custom file with: ENV_FILE=.env.production pnpm deploy:cf"
    exit 1
  fi

  return 0
}

prepare_next_build_env_file() {
  # Next.js and OpenNext load dotenv files from the working directory even
  # when the process environment is scrubbed. The shared primitive moves every
  # candidate into a private, journaled directory and exposes only sanitized
  # build input using scripts/cloudflare/deploy-env.ts sanitize-build-env semantics.
  if ! MC_AWS_NEXT_BUILD_ORCHESTRATOR_PID="$$" node --import tsx scripts/validation/next-build-isolation.ts stage \
    --root "$PWD" --source-fd "$DEPLOY_ENV_FD"; then
    echo "❌ Error: Failed to prepare sanitized Next.js build environment" >&2
    exit 1
  fi
  NEXT_BUILD_ENV_PREPARED="1"
}

cleanup_next_build_env_file() {
  if [[ "$NEXT_BUILD_ENV_PREPARED" != "1" ]]; then
    return 0
  fi
  MC_AWS_NEXT_BUILD_ORCHESTRATOR_PID="$$" node --import tsx scripts/validation/next-build-isolation.ts restore --root "$PWD"
  NEXT_BUILD_ENV_PREPARED="0"
}

recover_interrupted_next_build_env_file() {
  MC_AWS_NEXT_BUILD_ORCHESTRATOR_PID="$$" node --import tsx scripts/validation/next-build-isolation.ts recover --root "$PWD"
}

open_deployment_env_snapshot() {
  local validate_backend_mode="${1:-true}"
  if [[ -n "$DEPLOY_ENV_FD" ]]; then
    return 0
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    resolve_env_file
  fi
  # Keep an immutable, inherited read-only descriptor to the validated source.
  # KV provisioning may atomically replace ENV_FILE later; all subsequent
  # configuration and secret reads must use this pre-mutation snapshot.
  exec {DEPLOY_ENV_FD}<"$ENV_FILE"
  DEPLOY_ENV_SOURCE="/proc/self/fd/$DEPLOY_ENV_FD"
  if [[ "$validate_backend_mode" == "true" ]]; then
    MC_BACKEND_MODE_VALUE="$(get_env_value "MC_BACKEND_MODE")"
  fi
  if [[ "$validate_backend_mode" == "true" && "$MC_BACKEND_MODE_VALUE" != "aws" ]]; then
    echo '❌ Error: MC_BACKEND_MODE must be the canonical runtime Worker value "aws".' >&2
    exit 1
  fi
}

run_isolated_build_child() {
  local child_tmp="$1"
  shift
  local child_home="$PWD/.local-artifacts/build-home"
  (
    # The immutable deployment dotenv remains readable only by this orchestrator.
    # Close it before the wrapper spawns the build command with stdio 0-2 only.
    exec {DEPLOY_ENV_FD}<&-
    unset DEPLOY_ENV_FD DEPLOY_ENV_SOURCE MC_AWS_DEPLOYMENT_MANIFEST_LOCK_FD MC_AWS_DEPLOYMENT_MANIFEST_LOCK_HELD
    env -i PATH="$PATH" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-}" \
      node --import tsx scripts/validation/build-child-isolation-cli.ts run \
      --root "$PWD" --home "$child_home" --tmp "$child_tmp" "$@"
  )
}

cleanup_deploy_artifacts() {
  cleanup_next_build_env_file

  if [[ -n "$WRANGLER_UPLOAD_STAGE_DIR" && -d "$WRANGLER_UPLOAD_STAGE_DIR" ]]; then
    # The stage is sealed during upload. Re-open only this private, fixed
    # scratch tree so EXIT cleanup can remove it without touching checkout.
    chmod -R u+rwX -- "$WRANGLER_UPLOAD_STAGE_DIR"
    rm -rf -- "$WRANGLER_UPLOAD_STAGE_DIR"
  fi
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
  release_deployment_lock
  return "$status"
}

trap on_deploy_exit EXIT
acquire_deployment_lock || exit 1
(umask 077 && mkdir -p .local-artifacts/cloudflare-tmp)
chmod 700 .local-artifacts/cloudflare-tmp
export TMPDIR="$PWD/.local-artifacts/cloudflare-tmp"
node --import tsx --input-type=module -e 'import { ensurePrivateRecoveryDirectory } from "./scripts/cloudflare/durable-recovery-journal.ts"; ensurePrivateRecoveryDirectory(process.argv[1]);' "$RECOVERY_STATE_DIRECTORY"
recover_interrupted_next_build_env_file
rm -f .wrangler.deploy.jsonc

RECOVERY_PENDING_EARLY="0"
[[ -e "$RECOVERY_RECORD_FILE" ]] && RECOVERY_PENDING_EARLY="1"
if [[ "$RECOVERY_PENDING_EARLY" == "0" ]]; then
  resolve_env_file
  echo "🧪 Using environment file: $ENV_FILE"
else
  echo "🩹 Active recovery record detected before deployment preflight: $RECOVERY_RECORD_FILE"
fi
echo ""

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
    TMPDIR="$TMPDIR" \
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_DEPLOY_API_TOKEN:-}" \
    "$WRANGLER_BIN" "$@"
}

manifest() {
  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/shared/deployment-manifest.mjs "$@" >/dev/null
}

manifest_route_state() {
  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/shared/deployment-manifest.mjs route-state "$@"
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
  RECOVERY_RECEIPT_VERIFIER_SHA256="$(node --import tsx scripts/cloudflare/deploy-env.ts executor-receipt-sha256 --env-fd "$DEPLOY_ENV_FD")" \
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
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
    dns: {
      state: process.env.RECOVERY_DNS_STATE,
      original: parse("RECOVERY_DNS_JSON"),
      applied: null,
      mutationIntent: null,
    },
    creationIntents: { route: null, dns: null },
    applied: {
      workerDeploymentId: null,
      workerVersionId: null,
      workerScriptEtag: null,
      routeId: null,
      dnsRecordId: null,
    },
  },
  runtimeIdentity: {
    userName: process.env.RECOVERY_RUNTIME_USER,
    keys: parse("RECOVERY_RUNTIME_KEYS_JSON"),
    previousKeyIds: parse("RECOVERY_RUNTIME_KEYS_JSON").filter((key) => key.status === "Active").map((key) => key.accessKeyId),
    candidateKeyId: null,
    newKeyId: null,
    phase: "baseline",
  },
  runtimeConfig: {
    lifecycleLockTableName: process.env.RECOVERY_LIFECYCLE_TABLE,
    operationStateTableName: process.env.RECOVERY_OPERATION_TABLE,
    receiptVerifierSetSha256: process.env.RECOVERY_RECEIPT_VERIFIER_SHA256,
    artifactMerkleSha256: null,
    uploadConfigSha256: null,
    deploymentReceiptSha256: null,
  },
  limitations: [
    "Cloudflare secret values are write-only and are not stored in this record.",
    "Rollback redeploys the recorded immutable Worker version whose secret bindings reference the prior secrets.",
  ],
};
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
journal.durableReplaceFile(path, `${JSON.stringify(record, null, 2)}\n`);
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
    RECOVERY_DNS_RECORD_ID="$dns_record_id" node --import tsx --input-type=module <<'NODE'
import fs from "node:fs"; const path=process.env.RECOVERY_RECORD_FILE; const stat=fs.lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600)throw new Error("unsafe recovery record");
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active")throw new Error("inactive recovery record");
const phaseOrder=["preflight-recorded","kv-mutation","dns-mutation","worker-mutation","worker-deployed","route-verified","secrets-mutation","secrets-mutated","bindings-mutation","bindings-verified","runtime-key-verification","runtime-key-prepared","commit-decided","runtime-key-finalized","success","rollback-complete"];
const previousIndex=phaseOrder.indexOf(record.stage); const nextIndex=phaseOrder.indexOf(process.env.RECOVERY_STAGE);
if(previousIndex<0||nextIndex<0||nextIndex<previousIndex)throw new Error("recovery phase must advance monotonically");
if(record.decision==="commit"&&process.env.RECOVERY_DECISION==="rollback")throw new Error("recovery decision cannot move backward");
record.stage=process.env.RECOVERY_STAGE;
if(process.env.RECOVERY_DECISION)record.decision=process.env.RECOVERY_DECISION;
if(process.env.RECOVERY_WORKER_DEPLOYMENT_ID)record.cloudflare.applied.workerDeploymentId=process.env.RECOVERY_WORKER_DEPLOYMENT_ID;
if(process.env.RECOVERY_ROUTE_ID)record.cloudflare.applied.routeId=process.env.RECOVERY_ROUTE_ID;
if(process.env.RECOVERY_DNS_RECORD_ID)record.cloudflare.applied.dnsRecordId=process.env.RECOVERY_DNS_RECORD_ID;
record.updatedAt=new Date().toISOString();
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
journal.durableReplaceFile(path, `${JSON.stringify(record,null,2)}\n`);
NODE
}

record_dns_applied() {
  local applied_json="$1"
  [[ -n "$RECOVERY_RECORD_FILE" ]] || return 0
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_DNS_APPLIED_JSON="$applied_json" node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
const applied=JSON.parse(process.env.RECOVERY_DNS_APPLIED_JSON);
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active")throw new Error("inactive recovery record");
if(!applied||typeof applied!=="object"||!applied.id||typeof applied.ttl!=="number"||typeof applied.proxied!=="boolean")throw new Error("incomplete DNS applied recovery evidence");
if(record.cloudflare.dns.state==="existing"&&(!record.cloudflare.dns.original||record.cloudflare.dns.original.id!==applied.id))throw new Error("applied DNS identity does not match the original record ID");
if(record.cloudflare.dns.state==="existing"&&!record.cloudflare.dns.mutationIntent)throw new Error("applied DNS evidence has no mutation intent");
if(record.cloudflare.dns.applied&&JSON.stringify(record.cloudflare.dns.applied)!==JSON.stringify(applied))throw new Error("applied DNS recovery evidence changed");
record.cloudflare.dns.applied=applied;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

record_dns_mutation_intent() {
  [[ -n "$RECOVERY_RECORD_FILE" ]] || return 0
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active")throw new Error("inactive recovery record");
if(record.cloudflare.dns.state!=="existing"||!record.cloudflare.dns.original?.id)throw new Error("DNS mutation intent requires an original record");
const intent={id:record.cloudflare.dns.original.id,operation:"enable-proxy",requested:{proxied:true}};
if(record.cloudflare.dns.mutationIntent&&JSON.stringify(record.cloudflare.dns.mutationIntent)!==JSON.stringify(intent))throw new Error("DNS mutation intent changed");
record.cloudflare.dns.mutationIntent=intent;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

journal_creation_intent() {
  local kind="$1"
  local operation_id="$2"
  local identity_json="$3"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_CREATE_KIND="$kind" \
    RECOVERY_OPERATION_ID="$operation_id" RECOVERY_CREATE_IDENTITY="$identity_json" \
    node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active")throw new Error("inactive recovery record");
const kind=process.env.RECOVERY_CREATE_KIND;
if(kind!=="route"&&kind!=="dns")throw new Error("invalid creation intent kind");
const identity=JSON.parse(process.env.RECOVERY_CREATE_IDENTITY);
if(!identity||typeof identity!=="object"||!/^[a-f0-9-]{36}$/.test(process.env.RECOVERY_OPERATION_ID))throw new Error("malformed recovery create intent");
if(kind==="dns"&&(!identity.type||identity.ttl!==1||identity.comment!==`mc-aws-dns-operation:${process.env.RECOVERY_OPERATION_ID}`))throw new Error("incomplete DNS creation intent");
if(kind==="route"&&(!identity.pattern||!identity.script))throw new Error("incomplete route creation intent");
const intent={operationId:process.env.RECOVERY_OPERATION_ID,...identity};
const prior=record.cloudflare.creationIntents?.[kind];
if(prior&&JSON.stringify(prior)!==JSON.stringify(intent))throw new Error(`immutable ${kind} creation intent mismatch`);
record.cloudflare.creationIntents??={route:null,dns:null};
record.cloudflare.creationIntents[kind]=intent;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

journal_creation_result() {
  local kind="$1"
  local resource_id="$2"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_CREATE_KIND="$kind" RECOVERY_RESOURCE_ID="$resource_id" \
    node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
const kind=process.env.RECOVERY_CREATE_KIND;
if(record.schemaVersion!==1||record.status!=="active"||(kind!=="route"&&kind!=="dns"))throw new Error("invalid recovery record");
const intent=record.cloudflare.creationIntents?.[kind];
if(!intent)throw new Error(`missing durable ${kind} creation intent`);
if(!/^[a-f0-9]{32}$/i.test(process.env.RECOVERY_RESOURCE_ID))throw new Error(`malformed ${kind} provider ID`);
const resultKey=kind==="route"?"routeId":"dnsRecordId";
if(record.cloudflare.applied[resultKey]&&record.cloudflare.applied[resultKey]!==process.env.RECOVERY_RESOURCE_ID)throw new Error(`immutable ${kind} result mismatch`);
record.cloudflare.applied[resultKey]=process.env.RECOVERY_RESOURCE_ID;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

journal_artifact_attestation_input() {
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_ARTIFACT_MERKLE_SHA256="$DEPLOY_ARTIFACT_MERKLE_SHA256" \
    node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
const digest=process.env.RECOVERY_ARTIFACT_MERKLE_SHA256;
if(!/^[a-f0-9]{64}$/.test(digest)||record.schemaVersion!==1||record.status!=="active")throw new Error("invalid artifact attestation input");
if(record.runtimeConfig.artifactMerkleSha256&&record.runtimeConfig.artifactMerkleSha256!==digest)throw new Error("immutable artifact attestation input mismatch");
record.runtimeConfig.artifactMerkleSha256=digest;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

journal_upload_config_attestation_input() {
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_UPLOAD_CONFIG_SHA256="$DEPLOY_UPLOAD_CONFIG_SHA256" \
    node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const digest=process.env.RECOVERY_UPLOAD_CONFIG_SHA256;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(!/^[a-f0-9]{64}$/.test(digest)||record.schemaVersion!==1||record.status!=="active")throw new Error("invalid upload config attestation input");
if(record.runtimeConfig.uploadConfigSha256&&record.runtimeConfig.uploadConfigSha256!==digest)throw new Error("immutable upload config attestation input mismatch");
record.runtimeConfig.uploadConfigSha256=digest;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

verify_sealed_worker_upload() {
  local observed_artifact_sha256 observed_config_sha256
  observed_artifact_sha256="$(node --import tsx scripts/cloudflare/deploy-env.ts artifact-merkle-sha256 \
    --path "$WRANGLER_UPLOAD_FINAL_DIR/artifact")" || return 1
  observed_config_sha256="$(node --import tsx scripts/cloudflare/deploy-env.ts upload-config-sha256 \
    --config "$WRANGLER_UPLOAD_FINAL_DIR/wrangler.jsonc")" || return 1
  if [[ "$observed_artifact_sha256" != "$DEPLOY_ARTIFACT_MERKLE_SHA256" || \
    "$observed_config_sha256" != "$DEPLOY_UPLOAD_CONFIG_SHA256" || \
    "$observed_artifact_sha256" != "$(recovery_value runtimeConfig.artifactMerkleSha256)" || \
    "$observed_config_sha256" != "$(recovery_value runtimeConfig.uploadConfigSha256)" ]]; then
    echo "❌ Sealed Worker artifact/config changed after attestation; refusing provider publication." >&2
    return 1
  fi
}

journal_deployment_receipt() {
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_DEPLOYMENT_RECEIPT_SHA256="$DEPLOYMENT_RECEIPT_SHA256" \
    node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const receipt=process.env.RECOVERY_DEPLOYMENT_RECEIPT_SHA256;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(!/^[a-f0-9]{64}$/.test(receipt)||record.schemaVersion!==1||record.status!=="active")throw new Error("invalid Worker deployment receipt");
if(record.runtimeConfig.deploymentReceiptSha256&&record.runtimeConfig.deploymentReceiptSha256!==receipt)throw new Error("immutable Worker deployment receipt mismatch");
record.runtimeConfig.deploymentReceiptSha256=receipt;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
}

update_recovery_record() {
  local status="$1"
  local stage="$2"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_STATUS="$status" RECOVERY_STAGE="$stage" node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
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
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
journal.durableReplaceFile(path, `${JSON.stringify(record, null, 2)}\n`);
NODE
}

finalize_recovery_record() {
  local status="$1"
  update_recovery_record "$status" "$CURRENT_DEPLOYMENT_STAGE"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_HISTORY_FILE="$RECOVERY_HISTORY_FILE" \
    node --import tsx --input-type=module <<'NODE'
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
journal.durableRenameFile(process.env.RECOVERY_RECORD_FILE, process.env.RECOVERY_HISTORY_FILE);
NODE
  echo "✅ Recovery record finalized: $RECOVERY_HISTORY_FILE"
}

record_worker_deployment_identity() {
  local receipt_authority_deployed="${1:-false}"
  local deployments_json deployment_id version_id version_json script_etag receipt_verifier_set_sha256 artifact_merkle_sha256 upload_config_sha256 evidence
  deployments_json="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || {
    echo "❌ Error: Could not read the deployed Worker identity"
    exit 1
  }
  deployment_id="$(printf '%s' "$deployments_json" | deployment_id_from_status_json)"
  if [[ -z "$deployment_id" ]]; then
    echo "❌ Error: Worker deployment succeeded but no provider deployment ID was returned"
    exit 1
  fi
  version_id="$(printf '%s' "$deployments_json" | current_version_id_from_status_json)" || {
    echo "❌ Error: Worker deployment does not identify one exact active version" >&2
    return 1
  }
  version_json="$(wrangler versions view "$version_id" --config /dev/null --name "$WORKER_NAME" --json)" || return 1
  script_etag="$(VERSION_JSON="$version_json" EXPECTED_VERSION_ID="$version_id" node -e '
const raw=process.env.VERSION_JSON; const value=JSON.parse(raw.slice(raw.indexOf("{")));
const etag=value.resources?.script?.etag;
if(value.id!==process.env.EXPECTED_VERSION_ID||typeof etag!=="string"||!etag||/[\t\r\n]/.test(etag))process.exit(1);
process.stdout.write(etag);
')" || { echo "❌ Error: Active Worker version has no exact provider script ETag" >&2; return 1; }

  if [[ -f "$RECOVERY_RECORD_FILE" && "$receipt_authority_deployed" != "true" ]]; then
    RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_WORKER_DEPLOYMENT_ID="$deployment_id" \
      RECOVERY_WORKER_VERSION_ID="$version_id" RECOVERY_WORKER_SCRIPT_ETAG="$script_etag" \
      node --import tsx --input-type=module <<'NODE'
import fs from "node:fs";
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
const path=process.env.RECOVERY_RECORD_FILE;
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.status!=="active")throw new Error("invalid recovery record");
record.cloudflare.applied.workerDeploymentId=process.env.RECOVERY_WORKER_DEPLOYMENT_ID;
record.cloudflare.applied.workerVersionId=process.env.RECOVERY_WORKER_VERSION_ID;
record.cloudflare.applied.workerScriptEtag=process.env.RECOVERY_WORKER_SCRIPT_ETAG;
record.updatedAt=new Date().toISOString();
journal.durableReplaceFile(path,`${JSON.stringify(record,null,2)}\n`);
NODE
  fi
    if [[ "$receipt_authority_deployed" == "true" ]]; then
    receipt_verifier_set_sha256="$(recovery_value runtimeConfig.receiptVerifierSetSha256)" || return 1
    artifact_merkle_sha256="$(recovery_value runtimeConfig.artifactMerkleSha256)" || return 1
    upload_config_sha256="$(recovery_value runtimeConfig.uploadConfigSha256)" || return 1
    [[ "$(recovery_value cloudflare.applied.workerDeploymentId)" == "$deployment_id" && \
      "$(recovery_value cloudflare.applied.workerVersionId)" == "$version_id" && \
      "$(recovery_value cloudflare.applied.workerScriptEtag)" == "$script_etag" ]] || {
      echo "❌ Error: Active Worker changed after the transaction journaled its final version; refusing attestation" >&2
      return 1
    }
    evidence="$(printf '%s\0%s' "$deployments_json" "$version_json" | node --import tsx scripts/cloudflare/deploy-env.ts \
      worker-version-evidence --artifact-merkle-sha256 "$artifact_merkle_sha256" \
      --receipt-verifier-set-sha256 "$receipt_verifier_set_sha256" \
      --upload-config-sha256 "$upload_config_sha256")" || return 1
    IFS=$'\t' read -r deployment_id version_id script_etag <<< "$evidence"
    [[ "$receipt_verifier_set_sha256" == "$(recovery_value runtimeConfig.receiptVerifierSetSha256)" ]] || {
      echo "❌ Error: Selected deployment env receipt authority changed after provider mutation" >&2
      return 1
    }
    DEPLOYMENT_RECEIPT_SHA256="$(node --import tsx scripts/cloudflare/deploy-env.ts deployment-receipt-sha256 \
      --deployment-id "$deployment_id" --version-id "$version_id" --script-etag "$script_etag" \
      --artifact-merkle-sha256 "$artifact_merkle_sha256" --receipt-verifier-set-sha256 "$receipt_verifier_set_sha256" \
      --upload-config-sha256 "$(recovery_value runtimeConfig.uploadConfigSha256)")" || return 1
    journal_deployment_receipt || return 1

    # Publication is allowed only after a fresh provider read immediately
    # before the manifest command. This closes the observe/attest race and
    # prevents a receipt for one active version being published for another.
    local final_deployments_json final_version_id final_version_json final_evidence final_receipt final_deployment_id final_script_etag
    final_deployments_json="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
    final_version_id="$(printf '%s' "$final_deployments_json" | current_version_id_from_status_json)" || return 1
    final_version_json="$(wrangler versions view "$final_version_id" --config /dev/null --name "$WORKER_NAME" --json)" || return 1
    final_evidence="$(printf '%s\0%s\0%s\0%s' "$deployments_json" "$version_json" "$final_deployments_json" "$final_version_json" | \
      node --import tsx scripts/cloudflare/deploy-env.ts worker-receipt-evidence \
        --artifact-merkle-sha256 "$artifact_merkle_sha256" --receipt-verifier-set-sha256 "$receipt_verifier_set_sha256" \
        --upload-config-sha256 "$(recovery_value runtimeConfig.uploadConfigSha256)" \
        --expected-receipt-sha256 "$DEPLOYMENT_RECEIPT_SHA256")" || return 1
    IFS=$'\t' read -r final_deployment_id final_version_id final_script_etag final_receipt <<< "$final_evidence"
    [[ "$final_deployment_id" == "$deployment_id" && "$final_version_id" == "$version_id" && \
      "$final_script_etag" == "$script_etag" && "$final_receipt" == "$DEPLOYMENT_RECEIPT_SHA256" && \
      "$final_receipt" == "$(recovery_value runtimeConfig.deploymentReceiptSha256)" ]] || {
      echo "❌ Error: Active Worker tuple/receipt changed before publication; refusing manifest update" >&2
      return 1
    }
    manifest cloudflare-deployed --deployment-id "$deployment_id" --receipt-authority-deployed true \
      --version-id "$version_id" --script-etag "$script_etag" \
      --artifact-merkle-sha256 "$artifact_merkle_sha256" \
      --receipt-verifier-set-sha256 "$receipt_verifier_set_sha256" \
      --deployment-receipt-sha256 "$DEPLOYMENT_RECEIPT_SHA256" \
      --upload-config-sha256 "$(recovery_value runtimeConfig.uploadConfigSha256)"
    echo "ℹ️ Deployment receipt $DEPLOYMENT_RECEIPT_SHA256 was durably journaled and persisted in the authoritative manifest." >&2
  else
    manifest cloudflare-deployed --deployment-id "$deployment_id" --receipt-authority-deployed false
  fi
  echo "✅ Recorded immutable Worker deployment/version evidence: $deployment_id / $version_id / $script_etag"
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
  pnpm exec tsx scripts/cloudflare/wrangler-config.ts worker-name "$WRANGLER_CONFIG_FILE"
}

get_env_value() {
  local key="$1"
  local line
  if [[ "$key" == "RUNTIME_STATE_SNAPSHOT_KV_ID" && -n "$RUNTIME_STATE_SNAPSHOT_KV_ID" ]]; then
    printf '%s\n' "$RUNTIME_STATE_SNAPSHOT_KV_ID"
    return 0
  fi
  if [[ "$key" == "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID" && -n "$RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID" ]]; then
    printf '%s\n' "$RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID"
    return 0
  fi
  local source_file="${DEPLOY_ENV_SOURCE:-$ENV_FILE}"
  # First matching line wins.
  line=$(grep -E "^${key}=" "$source_file" | head -n 1 || true)
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
  tmp_file="${ENV_FILE}.mc-aws-tmp"
  rm -f "$tmp_file"
  (umask 077 && : >"$tmp_file")

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
  RUNTIME_STATE_SNAPSHOT_KV_ID="$runtime_state_snapshot_kv_id"
  RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID="$runtime_state_snapshot_kv_preview_id"

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
    RUNTIME_STATE_SNAPSHOT_KV_ID="$runtime_state_snapshot_kv_id"
    RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID="$runtime_state_snapshot_kv_preview_id"
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
    RUNTIME_STATE_SNAPSHOT_KV_ID="$runtime_state_snapshot_kv_id"
    RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID="$runtime_state_snapshot_kv_preview_id"
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
  RUNTIME_STATE_SNAPSHOT_KV_ID="$runtime_state_snapshot_kv_id"
  RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID="$runtime_state_snapshot_kv_preview_id"
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

  WRANGLER_DEPLOY_CONFIG_FILE=".wrangler.deploy.jsonc"

  if ! pnpm exec tsx scripts/cloudflare/panel-hosting.ts prepare-config \
    --source "$WRANGLER_CONFIG_FILE" \
    --output "$WRANGLER_DEPLOY_CONFIG_FILE" \
    --kv-id "$runtime_state_snapshot_kv_id" \
    --kv-preview-id "$runtime_state_snapshot_kv_preview_id" \
    --mode "$PANEL_HOSTING_MODE" \
    --custom-workers-dev "$PANEL_WORKERS_DEV_ENABLED" \
    --backend-mode "$MC_BACKEND_MODE_VALUE" \
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
  local args_output
  if ! args_output="$(pnpm exec tsx scripts/cloudflare/panel-hosting.ts "${helper_args[@]}")"; then
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
  # Durable recovery identity and mode are authoritative. Only after reading
  # them may recovery snapshot mutable dotenv for a write-only provider token.
  if [[ -f "$ENV_FILE" ]]; then
    open_deployment_env_snapshot false
  fi
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

# Validate AUTH_SECRET before authentication or any provider mutation. The
# rotation helper journals one candidate before changing dotenv files, so an
# interrupted rerun repairs and deploys the same value instead of generating
# another secret. The value itself is never printed by the helper.
if ! ./node_modules/.bin/tsx scripts/setup/manage-auth-secret.ts ensure \
  --env-file "$ENV_FILE" \
  --rotate "${MC_AWS_ROTATE_AUTH_SECRET:-0}" >/dev/null; then
  echo "❌ Error: AUTH_SECRET is missing, unsafe, or requires explicit rotation." >&2
  echo "Run with MC_AWS_ROTATE_AUTH_SECRET=1 to prepare rotation without printing the replacement." >&2
  exit 1
fi
echo "✅ AUTH_SECRET deployment preflight passed (runtime Worker binding only)"
echo ""

WORKER_NAME="$(get_worker_name)"
if [[ -z "$WORKER_NAME" ]]; then
  echo "❌ Error: Could not determine Worker name from $WRANGLER_CONFIG_FILE"
  exit 1
fi

echo "🔍 Validating panel hosting configuration..."
PANEL_VALIDATION_OUTPUT="$(pnpm exec tsx scripts/cloudflare/panel-hosting.ts validate-env \
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
if ! NODE_ENV=production pnpm exec tsx scripts/validation/validate-env.ts --target worker --strict --env-file "$ENV_FILE"; then
  echo "❌ Error: strict production schema validation failed"
  exit 1
fi
echo "✅ Production schema validation passed"
echo ""

echo "🔍 Validating runtime-state Wrangler setup..."
if ! pnpm exec tsx scripts/cloudflare/validate-runtime-state-deploy.ts --env-file "$ENV_FILE" --wrangler-config "$WRANGLER_CONFIG_FILE"; then
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
  tmp="$(umask 077; mktemp "${TMPDIR:-/tmp}/mc-aws-cf.XXXXXX")"
  chmod 600 "$tmp"
  local http_code=""
  local auth_header_config
  auth_header_config="$(printf 'header = \"Authorization: Bearer %s\"\n' "$CF_DNS_API_TOKEN")"

  # -q disables reading ~/.curlrc, which can inject flags (like `-i`) and break JSON parsing.
  # We capture the HTTP status code separately and always emit the response body.
  if [[ -n "$json_body" ]]; then
    if ! http_code=$(printf '%s' "$auth_header_config" | curl --config - -sS -q \
      -o "$tmp" \
      -w "%{http_code}" \
      -X "$method" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data "$json_body" \
      "$url"); then
      echo "❌ Error: Cloudflare API request failed (curl)" >&2
      rm -f "$tmp"
      return 1
    fi
  else
    if ! http_code=$(printf '%s' "$auth_header_config" | curl --config - -sS -q \
      -o "$tmp" \
      -w "%{http_code}" \
      -X "$method" \
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

  if ! cat "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  auth_header_config=""

  if [[ ! "$http_code" =~ ^2 ]]; then
    echo "❌ Error: Cloudflare API returned HTTP ${http_code}" >&2
    return 1
  fi
  return 0
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

  local response inventory
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records?name=${DOMAIN}&per_page=100")" || {
    echo "❌ Error: Could not inventory panel DNS before deployment" >&2
    exit 1
  }
  inventory="$(printf '%s' "$response" | node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts \
    dns-inventory --name "$DOMAIN")" || {
    echo "❌ Error: Cloudflare returned ambiguous or invalid panel DNS inventory" >&2
    exit 1
  }
   if [[ "$inventory" != "absent" ]]; then
    PANEL_DNS_PREFLIGHT_STATE="existing"
    PANEL_DNS_PREFLIGHT_JSON="$inventory"
  else
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

  local record_line inventory
  local record_id
  local record_type
  local record_name
  local record_content
  local record_ttl
  local record_proxied
  local applied_json

  inventory="$(printf '%s' "$resp" | node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts \
    dns-inventory --name "$DOMAIN")" || {
    echo "❌ Error: Panel DNS inventory is ambiguous" >&2
    exit 1
  }
  if [[ "$inventory" != "absent" ]]; then
    if [[ "$PANEL_DNS_PREFLIGHT_STATE" != "existing" || "$inventory" != "$PANEL_DNS_PREFLIGHT_JSON" ]]; then
      echo "❌ Error: Panel DNS changed after preflight; refusing to overwrite concurrent state" >&2
      exit 1
    fi
    record_line="$(DNS_JSON="$inventory" node -e '
const r=JSON.parse(process.env.DNS_JSON); process.stdout.write([r.id,r.type,r.name,r.content,String(r.ttl),r.proxied?"true":"false"].join("\t"));
')"
    IFS=$'\t' read -r record_id record_type record_name record_content record_ttl record_proxied <<< "$record_line"
    applied_json="$inventory"
    local original_proxied="$record_proxied"
    local original_ttl="$record_ttl"
    local modified="false"

    echo "✅ DNS record found: ${record_type} ${record_name} (proxied=${record_proxied})"
    if [[ "$record_proxied" != "true" ]]; then
      echo "🔧 Enabling Cloudflare proxy (orange cloud) for ${record_name}..."
      record_dns_mutation_intent
      if ! cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}" '{"proxied":true}' | cf_assert_success >/dev/null; then
        echo "❌ Error: Failed to enable proxy for DNS record ${record_name}"
        exit 1
      fi
      if ! applied_json="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
        node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-observe \
          --id "$record_id" --type "$record_type" --name "$record_name" --content "$record_content" --proxied true)"; then
        echo "❌ Error: DNS proxy mutation could not be verified by exact ID and canonical applied TTL" >&2
        exit 1
      fi
      record_line="$(DNS_JSON="$applied_json" node -e '
const r=JSON.parse(process.env.DNS_JSON); process.stdout.write([r.id,r.type,r.name,r.content,String(r.ttl),r.proxied?"true":"false"].join("\t"));
')"
      IFS=$'\t' read -r record_id record_type record_name record_content record_ttl record_proxied <<< "$record_line"
      [[ "$record_proxied" == "true" ]] || { echo "❌ Error: DNS proxy mutation was not applied" >&2; exit 1; }
      echo "✅ Proxy enabled"
      modified="true"
    fi
    [[ "$modified" == "true" ]] && record_dns_applied "$applied_json"
    manifest dns --zone "$CF_ZONE_ID" --id "$record_id" --name "$record_name" --type "$record_type" \
      --content "$record_content" --ttl "$record_ttl" --proxied "$record_proxied" --ownership preexisting \
      --modified "$modified" --original-proxied "$original_proxied" --original-ttl "$original_ttl"
  else
    if [[ "$PANEL_DNS_PREFLIGHT_STATE" == "absent" ]]; then
      echo "➕ No DNS record found for ${DOMAIN}; creating a proxied record..."
      echo "   Note: The origin IP is unused because the Worker handles requests."

      local operation_id operation_comment create_identity create_body create_response created_json record_id
      operation_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
      operation_comment="mc-aws-dns-operation:${operation_id}"
      create_identity="$(CF_ZONE_ID="$CF_ZONE_ID" DNS_NAME="$DOMAIN" DNS_COMMENT="$operation_comment" node -e '
       process.stdout.write(JSON.stringify({zoneId:process.env.CF_ZONE_ID,name:process.env.DNS_NAME,type:"A",content:"192.0.2.1",ttl:1,proxied:true,comment:process.env.DNS_COMMENT}));
')"
      journal_creation_intent dns "$operation_id" "$create_identity"
      create_body="$(DNS_NAME="$DOMAIN" DNS_COMMENT="$operation_comment" node -e '
process.stdout.write(JSON.stringify({type:"A",name:process.env.DNS_NAME,content:"192.0.2.1",ttl:1,proxied:true,comment:process.env.DNS_COMMENT}));
')"
      if ! create_response="$(cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$create_body")"; then
        echo "❌ Error: DNS create response was indeterminate; active journal preserved and no record was adopted." >&2
        exit 1
      fi
      if ! created_json="$(printf '%s' "$create_response" | node --import tsx \
        scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-create-response \
        --type A --name "$DOMAIN" --content 192.0.2.1 --ttl 1 --proxied true --comment "$operation_comment")"; then
        echo "❌ Error: A successful DNS POST did not return a complete immutable result; active journal preserved." >&2
        exit 1
      fi
      record_id="$(CREATED_JSON="$created_json" node -e 'process.stdout.write(JSON.parse(process.env.CREATED_JSON).id)')"
      # The returned provider ID is the only safe correlation identity. Journal
      # it before any GET, list, manifest update, or other provider operation.
      journal_creation_result dns "$record_id"
      if ! applied_json="$(cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
         node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-verify \
           --id "$record_id" --type A --name "$DOMAIN" --content 192.0.2.1 --ttl 1 --proxied true \
           --comment "$operation_comment")"; then
        echo "❌ Error: DNS create ID $record_id could not be verified by exact complete identity; active journal preserved." >&2
        exit 1
      fi
      record_type="A"; record_name="$DOMAIN"; record_content="192.0.2.1"; record_ttl="1"; record_proxied="true"
      record_dns_applied "$applied_json"
      manifest dns --zone "$CF_ZONE_ID" --id "$record_id" --name "$record_name" --type "$record_type" \
        --content "$record_content" --ttl "$record_ttl" --proxied "$record_proxied" --comment "$operation_comment" \
        --operation-id "$operation_id" --ownership created --modified false
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
  node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts route-inventory \
    --pattern "$expected_pattern" | node -e '
const fs = require("node:fs");
const raw=fs.readFileSync(0,"utf8"); if(raw==="absent")process.exit(1);
let route; try{route=JSON.parse(raw);}catch{process.exit(2);}
process.stdout.write([route.id || "", route.pattern, route.script || ""].join("\t"));
'
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
  fi
}

ensure_panel_route() {
  [[ "$PANEL_HOSTING_MODE" == "custom" ]] || return 0
  local pattern="${DOMAIN}/*" inventory_status
  local response route_line route_id route_pattern route_script operation_id create_identity create_response created_json
  response="$(cf_api GET "/zones/${CF_ZONE_ID}/workers/routes")" || return 1
  if route_line="$(printf '%s' "$response" | cf_parse_worker_route "$pattern")"; then
    IFS=$'\t' read -r route_id route_pattern route_script <<< "$route_line"
    if [[ "$PANEL_ROUTE_PREFLIGHT_JSON" == "[]" || "$route_id" != "$PANEL_ROUTE_ID" || "$route_script" != "$WORKER_NAME" ]]; then
      echo "❌ Worker route changed after preflight; refusing concurrent state." >&2
      return 1
    fi
    return 0
  else
    inventory_status="$?"
  fi
  [[ "$inventory_status" -eq 1 && "$PANEL_ROUTE_PREFLIGHT_JSON" == "[]" && -z "$PANEL_ROUTE_ID" ]] || {
    echo "❌ Worker route inventory is invalid or changed after preflight." >&2
    return 1
  }

  operation_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  create_identity="$(CF_ZONE_ID="$CF_ZONE_ID" ROUTE_PATTERN="$pattern" ROUTE_SCRIPT="$WORKER_NAME" node -e '
process.stdout.write(JSON.stringify({zoneId:process.env.CF_ZONE_ID,pattern:process.env.ROUTE_PATTERN,script:process.env.ROUTE_SCRIPT}));
')"
  journal_creation_intent route "$operation_id" "$create_identity"
  if ! create_response="$(cf_api POST "/zones/${CF_ZONE_ID}/workers/routes" \
    "{\"pattern\":\"${pattern}\",\"script\":\"${WORKER_NAME}\"}")"; then
    echo "❌ Error: Worker route create response was indeterminate; active journal preserved and no route was adopted." >&2
    return 1
  fi
  if ! created_json="$(printf '%s' "$create_response" | node --import tsx \
    scripts/cloudflare/cloudflare-resource-reconciliation.ts route-create-response \
    --pattern "$pattern" --script "$WORKER_NAME")"; then
    echo "❌ Error: A successful route POST did not return a complete immutable result; active journal preserved." >&2
    return 1
  fi
  route_id="$(CREATED_JSON="$created_json" node -e 'process.stdout.write(JSON.parse(process.env.CREATED_JSON).id)')"
  # Journal the exact returned ID before verifying it or updating ownership.
  journal_creation_result route "$route_id"
  if ! cf_api GET "/zones/${CF_ZONE_ID}/workers/routes/${route_id}" | \
    node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts route-verify \
      --id "$route_id" --pattern "$pattern" --script "$WORKER_NAME" >/dev/null; then
    echo "❌ Error: Worker route ID $route_id could not be verified by exact complete identity; active journal preserved." >&2
    return 1
  fi
  manifest route --zone "$CF_ZONE_ID" --id "$route_id" --pattern "$pattern" --script "$WORKER_NAME" \
    --operation-id "$operation_id" --ownership created
  PANEL_ROUTE_ID="$route_id"
  echo "✅ Explicit Worker route created and reconciled: $route_id"
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
  if [[ -z "$PANEL_ROUTE_ID" ]]; then
    echo "❌ Worker route was observed without a durably identified operation; refusing adoption." >&2
    exit 1
  elif [[ "$live_route_id" != "$PANEL_ROUTE_ID" ]]; then
    echo "❌ Worker route ID changed outside the explicit journaled operation; refusing concurrent state." >&2
    exit 1
  else
    manifest route --zone "$CF_ZONE_ID" --id "$live_route_id" --pattern "$pattern" --script "$WORKER_NAME" --ownership created
  fi
  PANEL_ROUTE_ID="$live_route_id"
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

recovery_optional_value() {
  local selector="$1"
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); let value=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
for(const part of process.argv[1].split("."))value=value?.[part];
process.stdout.write(value===undefined||value===null?"null":typeof value==="string"?value:JSON.stringify(value));
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
    !Array.isArray(record.runtimeIdentity?.keys) || !Array.isArray(record.runtimeIdentity?.previousKeyIds)) throw new Error("malformed recovery inventory");
const intents=record.cloudflare.creationIntents;
if(!intents||typeof intents!=="object"||!("route" in intents)||!("dns" in intents))throw new Error("malformed creation intent inventory");
for(const [kind,intent] of Object.entries(intents)){
  if(intent===null)continue;
  if(!intent||typeof intent!=="object"||!/^[a-f0-9-]{36}$/.test(intent.operationId))throw new Error(`malformed ${kind} creation intent`);
}
if(record.runtimeConfig.artifactMerkleSha256!==null&&!/^[a-f0-9]{64}$/.test(record.runtimeConfig.artifactMerkleSha256))throw new Error("malformed artifact attestation input");
if(record.runtimeConfig.uploadConfigSha256!==null&&!/^[a-f0-9]{64}$/.test(record.runtimeConfig.uploadConfigSha256))throw new Error("malformed upload config attestation input");
if(record.runtimeConfig.deploymentReceiptSha256!==null&&!/^[a-f0-9]{64}$/.test(record.runtimeConfig.deploymentReceiptSha256))throw new Error("malformed Worker deployment receipt");
for(const key of ["workerDeploymentId","workerVersionId","workerScriptEtag","routeId","dnsRecordId"]){
  const value=record.cloudflare.applied[key]; if(value!==null&&(typeof value!=="string"||!value))throw new Error(`malformed applied ${key}`);
}
const previous = record.runtimeIdentity.previousKeyIds;
if (previous.some((id) => typeof id !== "string" || !/^AKIA[A-Z0-9]+$/.test(id)) || new Set(previous).size !== previous.length) {
  throw new Error("malformed runtime key identity inventory");
}
if (record.runtimeIdentity.candidateKeyId !== null &&
    (record.runtimeIdentity.newKeyId !== record.runtimeIdentity.candidateKeyId || !/^AKIA[A-Z0-9]+$/.test(record.runtimeIdentity.newKeyId))) {
  throw new Error("malformed runtime candidate key identity");
}
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
    ROTATION_MODE="$mode" bash scripts/cloudflare/rotate-worker-runtime-key.sh
}

finalize_runtime_rotation_and_attest() {
  local prior_phase
  prior_phase="$(recovery_value runtimeIdentity.phase)" || return 1
  run_runtime_rotation finalize || return 1
  case "$prior_phase" in
    temporary-secrets-removed|prior-key-deletion-intent|finalized)
      # This invocation did not perform the final Worker secret mutation. Only
      # an already-journaled exact active deployment/version may be attested;
      # recovery must not adopt whatever happens to be active now.
      record_worker_deployment_identity true || return 1
      ;;
    *)
      # Finalization returned after performing its own Worker secret mutations.
      # Durably observe that resulting active identity, then re-read and require
      # exact deployment/version/ETag equality while attaching attestation.
      record_worker_deployment_identity || return 1
      record_worker_deployment_identity true || return 1
      ;;
  esac
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
  local prior_routes pattern route_id prior_id prior_script applied_id intent operation_id
  prior_routes="$(recovery_value cloudflare.routes)"
  applied_id="$(recovery_value cloudflare.applied.routeId)"
  [[ "$applied_id" != "null" ]] || applied_id=""
  intent="$(recovery_optional_value cloudflare.creationIntents.route)" || return 1
  pattern="${DOMAIN}/*"
  if [[ "$prior_routes" != "[]" ]]; then
    prior_id="$(ROUTES_JSON="$prior_routes" node -e 'const r=JSON.parse(process.env.ROUTES_JSON); if(r.length!==1)process.exit(1); process.stdout.write(r[0].id)')" || return 1
    prior_script="$(ROUTES_JSON="$prior_routes" node -e 'const r=JSON.parse(process.env.ROUTES_JSON); if(r.length!==1)process.exit(1); process.stdout.write(r[0].script)')" || return 1
    [[ "$prior_script" == "$WORKER_NAME" ]] || return 1
    [[ "$intent" == "null" ]] || { echo "❌ Unexpected route creation intent for a present baseline." >&2; return 1; }
    cf_api GET "/zones/${CF_ZONE_ID}/workers/routes/${prior_id}" | \
      node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts route-verify \
        --id "$prior_id" --pattern "$pattern" --script "$prior_script" >/dev/null || {
      echo "❌ Recorded baseline route identity changed or disappeared; refusing overwrite." >&2
      return 1
    }
    return 0
  fi
  if [[ "$intent" == "null" ]]; then
    echo "ℹ️ No durable route-create intent exists; this transaction deterministically created no route and recovery leaves concurrent provider state untouched." >&2
    return 0
  fi
  operation_id="$(ROUTE_INTENT="$intent" EXPECTED_ZONE="$CF_ZONE_ID" EXPECTED_PATTERN="$pattern" EXPECTED_SCRIPT="$WORKER_NAME" node -e '
const i=JSON.parse(process.env.ROUTE_INTENT); if(i.zoneId!==process.env.EXPECTED_ZONE||i.pattern!==process.env.EXPECTED_PATTERN||i.script!==process.env.EXPECTED_SCRIPT||!/^[a-f0-9-]{36}$/.test(i.operationId))process.exit(1); process.stdout.write(i.operationId);
')" || return 1
  [[ -n "$applied_id" ]] || {
    echo "❌ Indeterminate route create has no durably journaled provider ID; refusing adoption or deletion." >&2
    return 1
  }
  route_id="$applied_id"
  cf_api GET "/zones/${CF_ZONE_ID}/workers/routes/${route_id}" | \
    node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts route-verify \
      --id "$route_id" --pattern "$pattern" --script "$WORKER_NAME" >/dev/null || {
    echo "❌ Journaled route ID does not match exact provider identity; refusing deletion." >&2
    return 1
  }
  cf_api DELETE "/zones/${CF_ZONE_ID}/workers/routes/${route_id}" | cf_assert_success >/dev/null || return 1
  manifest route-recovered --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$WORKER_NAME" \
    --baseline-state absent --expected-current-id "$route_id" --restored-id absent || return 1
}

restore_recorded_dns() {
  local dns_state dns_json applied_dns_json record_id original_proxied original_ttl applied_proxied applied_ttl record_type record_name record_content record_comment applied_dns_id intent operation_id
  dns_state="$(recovery_value cloudflare.dns.state)"
  applied_dns_id="$(recovery_value cloudflare.applied.dnsRecordId)"
  [[ "$applied_dns_id" != "null" ]] || applied_dns_id=""
  [[ "$dns_state" != "unmanaged" ]] || return 0
  dns_json="$(recovery_value cloudflare.dns.original)"
  applied_dns_json="$(recovery_value cloudflare.dns.applied)"
  if [[ "$dns_state" == "existing" ]]; then
    [[ "$dns_json" != "null" ]] || {
      echo "❌ DNS recovery journal is missing the original record evidence; refusing restoration." >&2
      return 1
    }
    record_id="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).id)')"
    original_proxied="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_DNS_JSON).proxied))')"
    original_ttl="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_DNS_JSON).ttl))')"
    record_type="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).type)')"
    record_name="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).name)')"
    record_content="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).content)')"
    record_comment="$(RECOVERY_DNS_JSON="$dns_json" node -e 'process.stdout.write(JSON.parse(process.env.RECOVERY_DNS_JSON).comment ?? "")')"
    if [[ "$applied_dns_json" == "null" ]]; then
      if [[ "$(recovery_value cloudflare.dns.mutationIntent)" != "null" ]]; then
        echo "❌ DNS mutation intent has no observed applied identity after a possible provider response loss; refusing rollback and requiring reconciliation." >&2
      else
        if ! cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
          node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-verify \
            --id "$record_id" --type "$record_type" --name "$record_name" --content "$record_content" \
            --ttl "$original_ttl" --proxied "$original_proxied" --comment "$record_comment" >/dev/null; then
          echo "❌ DNS record changed without a journaled mutation; refusing restoration." >&2
          return 1
        fi
        return 0
      fi
      return 1
    fi
    applied_proxied="$(RECOVERY_DNS_JSON="$applied_dns_json" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_DNS_JSON).proxied))')"
    applied_ttl="$(RECOVERY_DNS_JSON="$applied_dns_json" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_DNS_JSON).ttl))')"
    [[ "$original_proxied" == "true" || "$original_proxied" == "false" ]] && [[ "$applied_proxied" == "true" || "$applied_proxied" == "false" ]] && [[ "$original_ttl" =~ ^[0-9]+$ && "$applied_ttl" =~ ^[0-9]+$ ]] || {
      echo "❌ DNS recovery journal is missing distinct original/applied TTL and proxy evidence; refusing restoration." >&2
      return 1
    }
    if ! cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
      node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-verify \
        --id "$record_id" --type "$record_type" --name "$record_name" --content "$record_content" \
        --ttl "$applied_ttl" --proxied "$applied_proxied" \
        --comment "$record_comment" >/dev/null; then
      echo "❌ Applied DNS identity is not the exact journaled TTL/proxy state; refusing proxy restoration." >&2
      return 1
    fi
    if [[ "$applied_ttl" == "$original_ttl" && "$applied_proxied" == "$original_proxied" ]]; then
      return 0
    fi
    dns_body="$(DNS_TYPE="$record_type" DNS_NAME="$record_name" DNS_CONTENT="$record_content" DNS_TTL="$original_ttl" DNS_PROXIED="$original_proxied" DNS_COMMENT="$record_comment" node -e '
process.stdout.write(JSON.stringify({type:process.env.DNS_TYPE,name:process.env.DNS_NAME,content:process.env.DNS_CONTENT,ttl:Number(process.env.DNS_TTL),proxied:process.env.DNS_PROXIED==="true",comment:process.env.DNS_COMMENT}));
')"
    cf_api PUT "/zones/${CF_ZONE_ID}/dns_records/${record_id}" "$dns_body" | \
      cf_assert_success >/dev/null || return 1
    if ! cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
      node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-verify \
        --id "$record_id" --type "$record_type" --name "$record_name" --content "$record_content" \
        --ttl "$original_ttl" --proxied "$original_proxied" --comment "$record_comment" >/dev/null; then
      echo "❌ Restored DNS identity could not be verified by exact original TTL/proxy state." >&2
      return 1
    fi
    return 0
  fi
  [[ "$dns_state" == "absent" ]] || return 1
  intent="$(recovery_optional_value cloudflare.creationIntents.dns)" || return 1
  if [[ "$intent" == "null" ]]; then
    echo "ℹ️ No durable DNS-create intent exists; this transaction deterministically created no DNS record and recovery leaves concurrent provider state untouched." >&2
    return 0
  fi
  [[ -n "$applied_dns_id" ]] || {
    echo "❌ Indeterminate DNS create has no durably journaled provider ID; refusing adoption or deletion." >&2
    return 1
  }
  IFS=$'\t' read -r operation_id record_comment <<< "$(DNS_INTENT="$intent" EXPECTED_ZONE="$CF_ZONE_ID" EXPECTED_NAME="$DOMAIN" node -e '
const i=JSON.parse(process.env.DNS_INTENT); if(i.zoneId!==process.env.EXPECTED_ZONE||i.name!==process.env.EXPECTED_NAME||i.type!=="A"||i.content!=="192.0.2.1"||i.ttl!==1||i.proxied!==true||i.comment!==`mc-aws-dns-operation:${i.operationId}`)process.exit(1); process.stdout.write(`${i.operationId}\t${i.comment}`);
')" || return 1
  record_id="$applied_dns_id"
  if ! cf_api GET "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | \
    node --import tsx scripts/cloudflare/cloudflare-resource-reconciliation.ts dns-verify \
      --id "$record_id" --type A --name "$DOMAIN" --content 192.0.2.1 --ttl 1 --proxied true \
      --comment "$record_comment" >/dev/null; then
    echo "❌ Journaled DNS ID does not match exact provider identity; refusing deletion." >&2
    return 1
  fi
  cf_api DELETE "/zones/${CF_ZONE_ID}/dns_records/${record_id}" | cf_assert_success >/dev/null || return 1
}

rollback_from_recovery_record() {
  RECOVERY_RUNNING="1"
  validate_recovery_record || return 1
  local prior_worker_state version_specs_output rollback_status current_worker_status applied_worker_deployment_id rollback_decision baseline_versions_json
  CF_ZONE_ID="$(recovery_value cloudflare.zoneId)" || return 1
  DOMAIN="$(recovery_value cloudflare.domain)" || return 1
  prior_worker_state="$(recovery_value cloudflare.worker.state)" || return 1
  if [[ "$prior_worker_state" == "existing" ]]; then
    baseline_versions_json="$(recovery_value cloudflare.worker.versions)" || return 1
    version_specs_output="$(RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
for (const version of r.cloudflare.worker.versions) console.log(`${version.versionId}@${version.percentage}%`);
')" || return 1
    local version_specs=()
    while IFS= read -r spec; do [[ -n "$spec" ]] && version_specs+=("$spec"); done <<< "$version_specs_output"
    [[ ${#version_specs[@]} -gt 0 ]] || return 1
    applied_worker_deployment_id="$(recovery_optional_value cloudflare.applied.workerDeploymentId)" || return 1
    current_worker_status="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
    rollback_decision="$(printf '%s' "$current_worker_status" | node --import tsx scripts/cloudflare/deploy-env.ts \
      worker-rollback-decision --baseline-versions-json "$baseline_versions_json" \
      --applied-deployment-id "$applied_worker_deployment_id")" || {
      echo "❌ Active Worker is not transaction deployment B or baseline A; refusing to overwrite concurrent deployment C." >&2
      return 1
    }
    if [[ "$rollback_decision" == "restore-baseline" ]]; then
      retry 3 wrangler versions deploy "${version_specs[@]}" --config /dev/null --name "$WORKER_NAME" --yes \
        --message "mc-aws automatic rollback from $CURRENT_DEPLOYMENT_STAGE" || return 1
    elif [[ "$rollback_decision" != "already-baseline" ]]; then
      echo "❌ Invalid Worker rollback CAS decision: $rollback_decision" >&2
      return 1
    fi
    rollback_status="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
    WORKER_LIVE_DEPLOYMENT_ID="$(printf '%s' "$rollback_status" | deployment_id_from_status_json)" || return 1
    manifest cloudflare-deployed --deployment-id "$WORKER_LIVE_DEPLOYMENT_ID" || return 1
    restore_recorded_routes || return 1
  elif [[ "$prior_worker_state" == "absent" ]]; then
    restore_recorded_routes || return 1
    local current_worker_probe recorded_worker_deployment_id current_worker_deployment_id
    recorded_worker_deployment_id="$(recovery_optional_value cloudflare.applied.workerDeploymentId)" || return 1
    if current_worker_probe="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
      [[ "$recorded_worker_deployment_id" != "null" && -n "$recorded_worker_deployment_id" ]] || {
        echo "❌ Worker exists after an absent-baseline rollback without a durably journaled deployment ID; refusing deletion." >&2
        return 1
      }
      current_worker_deployment_id="$(printf '%s' "$current_worker_probe" | deployment_id_from_status_json)" || return 1
      [[ "$current_worker_deployment_id" == "$recorded_worker_deployment_id" ]] || {
        echo "❌ Worker deployment changed outside the journaled operation; refusing deletion." >&2
        return 1
      }
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
  if [[ "$prior_worker_state" == "existing" ]]; then
    record_worker_deployment_identity || return 1
  fi
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
  local status
  status="$(recovery_value status)" || exit 1
  if [[ "$status" == "succeeded" || "$status" == "rolled_back" ]]; then
    [[ ! -e "$RECOVERY_HISTORY_FILE" ]] || { echo "❌ Terminal recovery record and history both exist; refusing cleanup." >&2; exit 1; }
    RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RECOVERY_HISTORY_FILE="$RECOVERY_HISTORY_FILE" \
      node --import tsx --input-type=module <<'NODE'
import journal from "./scripts/cloudflare/durable-recovery-journal.ts";
journal.durableRenameFile(process.env.RECOVERY_RECORD_FILE, process.env.RECOVERY_HISTORY_FILE);
NODE
    echo "   Finalized the already-terminal recovery record after the interrupted history rename." >&2
    exit 0
  fi
  local decision
  decision="$(recovery_value decision)" || exit 1
  if [[ "$decision" == "commit" ]]; then
    echo "   The commit decision is durable; resuming runtime-key cleanup without baseline rollback." >&2
    finalize_runtime_rotation_and_attest || exit 1
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
    finalize_runtime_rotation_and_attest || return 1
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

if [[ "$RECOVERY_PENDING_EARLY" == "0" ]]; then
  open_deployment_env_snapshot
fi
recover_pending_deployment

if ! PREFLIGHT_SECRET_NAMES_OUTPUT="$(env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="$TMPDIR" \
  node --import tsx scripts/cloudflare/deploy-env.ts worker-secret-names --env-fd "$DEPLOY_ENV_FD")"; then
  echo "❌ Error: Failed to parse approved Worker secret names before provider mutation" >&2
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

echo "🚀 Building Next.js app before provider mutation..."
run_isolated_build_child "$TMPDIR" -- pnpm clean:build
mkdir -p "$TMPDIR"
prepare_next_build_env_file
if ! run_isolated_build_child "$TMPDIR" --env "NODE_ENV=production" \
  --env "MC_BACKEND_MODE=$MC_BACKEND_MODE_VALUE" --env "ENABLE_DEV_LOGIN=" -- pnpm build; then
  echo ""
  echo "❌ Error: Failed to build Next.js app"
  exit 1
fi
cleanup_next_build_env_file
echo "✅ Next.js route-import build passed before provider mutation"
echo ""

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

prepare_wrangler_deploy_config
prepare_wrangler_deploy_args

echo "📦 Building for Cloudflare (OpenNext)..."
mkdir -p .local-artifacts/opennext-tmp
prepare_next_build_env_file
if ! run_isolated_build_child "$PWD/.local-artifacts/opennext-tmp" --env "NODE_ENV=production" \
  --env "MC_BACKEND_MODE=$MC_BACKEND_MODE_VALUE" --env "ENABLE_DEV_LOGIN=" -- \
  pnpm exec opennextjs-cloudflare build --skipNextBuild --config "$WRANGLER_DEPLOY_CONFIG_FILE"; then
  echo ""
  echo "❌ Error: Failed to build for Cloudflare"
  exit 1
fi
echo "✅ Build successful"
echo ""

# Restore operator dotenv files before reading the selected source for the
# scanner. Neither build command receives AUTH_SECRET, and the scanner checks
# every sensitive value from the source against every file that can be uploaded.
cleanup_next_build_env_file
echo "🔎 Scanning all deploy artifacts for secret material..."
WRANGLER_UPLOAD_STAGE_DIR="$PWD/.local-artifacts/cloudflare-upload-stage"
WRANGLER_UPLOAD_FINAL_DIR="$WRANGLER_UPLOAD_STAGE_DIR/final"
if ! node --import tsx scripts/cloudflare/deploy-env.ts stage-worker-assets \
  --source .open-next/assets --output "$WRANGLER_UPLOAD_STAGE_DIR/input-assets"; then
  echo "❌ Error: Could not snapshot the Worker assets before bundling." >&2
  exit 1
fi
mkdir -p "$WRANGLER_UPLOAD_STAGE_DIR/bundle"
if ! run_isolated_build_child "$TMPDIR" --env "NODE_ENV=production" -- "$WRANGLER_BIN" deploy --dry-run \
  --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" \
  --assets "$WRANGLER_UPLOAD_STAGE_DIR/input-assets" \
  --outdir "$WRANGLER_UPLOAD_STAGE_DIR/bundle"; then
  echo "❌ Error: Wrangler could not produce a finalized no-network upload bundle; refusing attestation and upload." >&2
  exit 1
fi
if ! node --import tsx scripts/cloudflare/deploy-env.ts stage-final-worker-upload \
  --config "$WRANGLER_DEPLOY_CONFIG_FILE" \
  --bundle "$WRANGLER_UPLOAD_STAGE_DIR/bundle" \
  --assets "$WRANGLER_UPLOAD_STAGE_DIR/input-assets" \
  --output "$WRANGLER_UPLOAD_FINAL_DIR"; then
  echo "❌ Error: Could not stage the finalized Wrangler bundle and assets." >&2
  exit 1
fi
DEPLOY_ARTIFACT_MERKLE_SHA256="$(node --import tsx scripts/cloudflare/deploy-env.ts artifact-merkle-sha256 \
  --path "$WRANGLER_UPLOAD_FINAL_DIR/artifact")" || {
  echo "❌ Error: Could not content-address the finalized staged Worker upload." >&2
  exit 1
}
WRANGLER_FINAL_UPLOAD_CONFIG_FILE="$WRANGLER_UPLOAD_FINAL_DIR/wrangler.jsonc"
if ! pnpm exec tsx scripts/cloudflare/panel-hosting.ts bind-attestation \
  --config "$WRANGLER_FINAL_UPLOAD_CONFIG_FILE" \
  --artifact-merkle-sha256 "$DEPLOY_ARTIFACT_MERKLE_SHA256" \
  --receipt-verifier-set-sha256 "$(recovery_value runtimeConfig.receiptVerifierSetSha256)"; then
  echo "❌ Error: Failed to bind deployment attestation digests into the Worker version." >&2
  exit 1
fi
DEPLOY_UPLOAD_CONFIG_SHA256="$(node --import tsx scripts/cloudflare/deploy-env.ts upload-config-sha256 \
  --config "$WRANGLER_FINAL_UPLOAD_CONFIG_FILE")" || {
  echo "❌ Error: Could not hash the effective final Wrangler upload config." >&2
  exit 1
}
if ! pnpm exec tsx scripts/cloudflare/panel-hosting.ts bind-attestation \
  --config "$WRANGLER_FINAL_UPLOAD_CONFIG_FILE" \
  --artifact-merkle-sha256 "$DEPLOY_ARTIFACT_MERKLE_SHA256" \
  --receipt-verifier-set-sha256 "$(recovery_value runtimeConfig.receiptVerifierSetSha256)" \
  --upload-config-sha256 "$DEPLOY_UPLOAD_CONFIG_SHA256"; then
  echo "❌ Error: Failed to bind the effective upload config digest into the Worker version." >&2
  exit 1
fi
journal_artifact_attestation_input
journal_upload_config_attestation_input
if ! node --import tsx scripts/cloudflare/deploy-env.ts scan-artifacts \
  --env-fd "$DEPLOY_ENV_FD" --path "$WRANGLER_UPLOAD_FINAL_DIR"; then
  echo "❌ Error: Immutable staged Worker upload scan failed; refusing upload." >&2
  exit 1
fi
if ! node --import tsx scripts/cloudflare/deploy-env.ts seal-worker-upload \
  --stage "$WRANGLER_UPLOAD_FINAL_DIR"; then
  echo "❌ Error: Could not seal the immutable Wrangler upload stage." >&2
  exit 1
fi
if ! verify_sealed_worker_upload; then
  echo "❌ Error: Final sealed Worker upload rehash did not match the journaled attestation." >&2
  exit 1
fi
WRANGLER_DEPLOY_CONFIG_FILE="$WRANGLER_UPLOAD_FINAL_DIR/wrangler.jsonc"
prepare_wrangler_deploy_args
WRANGLER_DEPLOY_ARGS+=(--no-bundle)
echo "✅ Bound content-addressed artifact and receipt authority digests into the upload"
echo ""

echo "🌐 Deploying to Cloudflare..."
deployment_stage worker-mutation || exit 1
if ! retry 3 wrangler "${WRANGLER_DEPLOY_ARGS[@]}"; then
  echo ""
  echo "❌ Error: Failed to deploy to Cloudflare Workers"
  exit 1
fi
if ! verify_sealed_worker_upload; then
  echo "❌ Error: Provider-uploaded Worker artifact/config no longer matches the sealed attestation." >&2
  exit 1
fi
echo "✅ Deploy successful"
echo ""
deployment_stage worker-deployed || exit 1
ensure_panel_route
capture_panel_route_after_deploy
deployment_stage route-verified || exit 1
record_worker_deployment_identity

# Upload secrets from selected deployment env file
# Note: MC_BACKEND_MODE is exported above for the build process but is NOT uploaded
# as a Cloudflare secret. ENABLE_DEV_LOGIN is explicitly unset for production.
echo "🔑 Uploading secrets from $ENV_FILE..."
deployment_stage secrets-mutation || exit 1

put_secret() {
  local put_key="$1"
  local put_value="$2"
  printf '%s\n' "$put_value" | \
    wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key" || return 1
  put_value=""
  unset put_value
  record_worker_deployment_identity
}

put_secret_from_selected_env() {
  local put_key="$1"
  # The helper emits one already-parsed value directly into Wrangler's stdin.
  # Its isolated environment contains no selected-file values, and the only
  # value in this pipeline is never an argument, exported variable, or log.
  if ! env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="$TMPDIR" \
    node --import tsx scripts/cloudflare/deploy-env.ts worker-secret-value \
      --env-fd "$DEPLOY_ENV_FD" --name "$put_key" | \
    wrangler secret put --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" "$put_key"; then
    return 1
  fi
  record_worker_deployment_identity
}

prune_obsolete_worker_secrets_bulk() {
  local deletion_patch="$1"
  printf '%s' "$deletion_patch" | \
    wrangler secret bulk --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" || return 1
  record_worker_deployment_identity
}

verify_deployed_secret_and_binding_inventory() {
  local live_secrets expected_names deployments_json version_id version_json live_bindings expected_kv_id
  live_secrets="$(wrangler secret list --config "$WRANGLER_DEPLOY_CONFIG_FILE" --name "$WORKER_NAME" --format json)" || return 1
  live_secrets="$(printf '%s' "$live_secrets" | sanitize_secret_inventory)" || return 1
  expected_names="$(env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="$TMPDIR" \
    node --import tsx scripts/cloudflare/deploy-env.ts worker-secret-names --env-fd "$DEPLOY_ENV_FD" | \
    node -e 'const fs=require("node:fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean));')" || return 1
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
SECRET_NAMES_OUTPUT="$PREFLIGHT_SECRET_NAMES_OUTPUT"
unset PREFLIGHT_SECRET_NAMES_OUTPUT
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  echo ""
  echo "  Setting: $key"
  if ! retry 3 put_secret_from_selected_env "$key"; then
    echo ""
    echo "❌ Error: Failed to set secret: $key (see error above)"
    exit 1
  fi
  # Avoid `set -e` exiting on a post-increment from 0.
  ((SECRET_COUNT+=1))
done <<< "$SECRET_NAMES_OUTPUT"
unset SECRET_NAMES_OUTPUT

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
  pnpm exec tsx scripts/cloudflare/legacy-worker-secret-policy.ts merge-patch)"; then
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
deployment_stage bindings-mutation || exit 1
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
record_worker_deployment_identity
deployment_stage runtime-key-prepared || exit 1
CURRENT_DEPLOYMENT_STAGE="commit-decided"
update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" commit
deployment_stage commit-decided || exit 1
if ! finalize_runtime_rotation_and_attest; then
  echo "❌ Error: Runtime key cleanup is incomplete after the durable commit decision." >&2
  echo "   The next deploy run will resume forward cleanup and will not attempt an impossible old-version rollback." >&2
  exit 1
fi
deployment_stage runtime-key-finalized || exit 1
echo ""

if [[ "$PANEL_HOSTING_MODE" == "workers_dev" ]]; then
  echo "✅ Verified actual Workers URL through runtime credential probe: $NEXT_PUBLIC_APP_URL"
  echo "   Google sign-in redirect URI: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
  echo "   Google Drive redirect URI: ${NEXT_PUBLIC_APP_URL%/}/api/gdrive/callback"
  echo ""
fi

# Only remove the local rotation journal after the exact selected-file value
# has been uploaded, verified, and runtime credentials have committed. A
# crash before this point leaves a recoverable candidate for the next run.
if ! ./node_modules/.bin/tsx scripts/setup/manage-auth-secret.ts complete --env-file "$ENV_FILE" >/dev/null; then
  echo "❌ Deployment succeeded but AUTH_SECRET rotation state could not be finalized; refusing success." >&2
  exit 1
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
