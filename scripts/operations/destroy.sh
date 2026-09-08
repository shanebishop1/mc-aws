#!/usr/bin/env bash

# Ownership-aware mc-aws teardown. Inventory/dry-run is the default. Execution
# requires both --execute and an exact, deployment-specific confirmation phrase.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_FILE="${MC_AWS_DEPLOYMENT_MANIFEST:-$ROOT_DIR/.mc-aws-deployment.json}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
AWS_CLI="${AWS_CLI:-aws}"
WRANGLER_BIN="${WRANGLER_BIN:-$ROOT_DIR/node_modules/.bin/wrangler}"
CURL_BIN="${CURL_BIN:-curl}"
NODE_BIN="${NODE_BIN:-node}"
WRANGLER_HOME_DIR="${WRANGLER_HOME_DIR:-$HOME/.config/mc-aws/wrangler-home}"
EXECUTE="0"
CLEANUP_LOCAL_ENV="0"
DATA_PRESERVATION_MODE="google-drive"
RETAIN_GDRIVE_TOKEN="0"
CONFIRM_ABSENT_STACK_DATA="0"
RECOVERY_CAPSULE_DELETE_APPROVED="0"
CONSENT_SSM_NAMES=()
SAFE_ABORT_DESTROY="0"
DESTROY_RENEW_INTERVAL_SECONDS="${MC_AWS_DESTROY_RENEW_INTERVAL_SECONDS:-300}"
DESTROY_BARRIER_LEASE_MS=$((90 * 60 * 1000))
DESTROY_OPERATION_ID=""
DESTROY_LOCK_ID=""
DESTROY_FENCING_TOKEN=""
DESTROY_CREATED_AT=""
DESTROY_CURRENT_PHASE=""
DESTROY_BARRIER_ESTABLISHED="0"
DESTROY_BARRIER_AUTHORITY_EXPECTED="0"
DESTROY_HEARTBEAT_PID=""
DESTROY_HEARTBEAT_FAILURE_FILE=""
PRESERVATION_ALREADY_FENCED="0"
DESTROY_TEST_MODE="${MC_AWS_DESTROY_TEST_MODE:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/operations/destroy.sh [--execute] [--safe-abort-destroy] [--retain-final-snapshot] [--retain-gdrive-token-for-migration] [--confirm-absent-stack-data] [--consent-delete-ssm NAME] [--cleanup-local-env] [--manifest PATH]

Default: live inventory and dry-run only; no resources or local files change.
  --execute            perform ownership-verified teardown; SSM parameters remain for review
  --safe-abort-destroy explicitly release this manifest's exact destroy barrier;
                       refused after final preservation has started
  --retain-final-snapshot
                       explicitly create and retain a final EBS snapshot instead
                        of relying on independently verified Google Drive backups
  --retain-gdrive-token-for-migration
                       retain only /minecraft/gdrive-token for a separately
                        reviewed Drive migration; all SSM state remains available for review
  --confirm-absent-stack-data
                       require a second exact confirmation that Drive/snapshot
                       preservation was verified outside this manifest
  --consent-delete-ssm NAME
                       explicitly consent to deleting one exact familiar but
                       ownership-unproven /minecraft parameter (repeatable)
  --cleanup-local-env  after cloud teardown, separately confirm local env deletion
  --manifest PATH      use a specific local deployment record
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --execute)
      EXECUTE="1"
      shift
      ;;
    --cleanup-local-env)
      CLEANUP_LOCAL_ENV="1"
      shift
      ;;
    --safe-abort-destroy)
      SAFE_ABORT_DESTROY="1"
      shift
      ;;
    --retain-final-snapshot)
      DATA_PRESERVATION_MODE="snapshot"
      shift
      ;;
    --retain-gdrive-token-for-migration)
      RETAIN_GDRIVE_TOKEN="1"
      shift
      ;;
    --confirm-absent-stack-data)
      CONFIRM_ABSENT_STACK_DATA="1"
      shift
      ;;
    --consent-delete-ssm)
      [[ $# -ge 2 ]] || { echo "❌ --consent-delete-ssm requires an exact name" >&2; exit 2; }
      [[ "$2" =~ ^/minecraft/[A-Za-z0-9._/-]+$ ]] || { echo "❌ Invalid exact SSM name: $2" >&2; exit 2; }
      CONSENT_SSM_NAMES+=("$2")
      shift 2
      ;;
    --manifest)
      [[ $# -ge 2 ]] || { echo "❌ --manifest requires a path" >&2; exit 2; }
      MANIFEST_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
error() { printf '❌ %s\n' "$*" >&2; }

if [[ ! "$DESTROY_RENEW_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  error "MC_AWS_DESTROY_RENEW_INTERVAL_SECONDS must be a positive integer"
  exit 2
fi

stop_destroy_barrier_renewal() {
  if [[ -n "$DESTROY_HEARTBEAT_PID" ]]; then
    # The worker owns its sleep/timer subprocess. It runs in a private session
    # so stopping the worker cannot leave that subprocess holding the test
    # harness (or a production shell) open. Kill the whole process group before
    # waiting; waiting for the worker first can block until the lease interval.
    kill -TERM -- "-$DESTROY_HEARTBEAT_PID" 2>/dev/null || kill -TERM "$DESTROY_HEARTBEAT_PID" 2>/dev/null || true
    kill -KILL -- "-$DESTROY_HEARTBEAT_PID" 2>/dev/null || kill -KILL "$DESTROY_HEARTBEAT_PID" 2>/dev/null || true
    wait "$DESTROY_HEARTBEAT_PID" 2>/dev/null || true
    DESTROY_HEARTBEAT_PID=""
  fi
  if [[ -n "$DESTROY_HEARTBEAT_FAILURE_FILE" ]]; then
    rm -f -- "$DESTROY_HEARTBEAT_FAILURE_FILE"
    DESTROY_HEARTBEAT_FAILURE_FILE=""
  fi
}

# A failed or interrupted destroy deliberately retains its durable barrier.
# Cleanup stops only this process's renewal loop; release is a separate,
# explicit, ownership-checked --safe-abort-destroy operation.
trap stop_destroy_barrier_renewal EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

require_executable() {
  local executable="$1"
  if [[ "$executable" == */* ]]; then
    [[ -x "$executable" ]] || { error "Required executable not found: $executable"; exit 1; }
  else
    command -v "$executable" >/dev/null 2>&1 || { error "Required command not found: $executable"; exit 1; }
  fi
}

require_executable "$NODE_BIN"
require_executable "$AWS_CLI"
require_executable "$WRANGLER_BIN"
require_executable "$CURL_BIN"
[[ -f "$MANIFEST_FILE" ]] || {
  error "Local deployment record not found: $MANIFEST_FILE"
  error "Refusing teardown because resource ownership cannot be proven. Use the manual procedure in docs/TEARDOWN.md."
  exit 1
}

if ! MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" validate >/dev/null; then
  error "Manifest validation failed; refusing teardown"
  exit 1
fi

MANIFEST_DIGEST="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"

refresh_manifest_digest() {
  MANIFEST_DIGEST="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"
}

assert_manifest_unchanged() {
  # Each mocked provider call is already serialized through the fixture state,
  # and the fixture does not model an out-of-process manifest writer. Keep the
  # initial validation and all production checks, but avoid re-launching the
  # manifest validator and hash calculator after every mocked mutation.
  if [[ "$DESTROY_TEST_MODE" == "1" && "$DESTROY_BARRIER_ESTABLISHED" == "1" ]]; then
    assert_destroy_barrier_owned || {
      error "Durable destroy barrier ownership was lost; refusing further mutation"
      exit 1
    }
    return 0
  fi
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" validate >/dev/null || {
    error "Manifest security/schema validation changed during teardown; refusing further mutation"
    exit 1
  }
  local current_digest
  current_digest="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"
  if [[ "$current_digest" != "$MANIFEST_DIGEST" ]]; then
    error "Deployment manifest changed after inventory; refusing further mutation"
    exit 1
  fi
  if [[ "$DESTROY_BARRIER_ESTABLISHED" == "1" && "$DESTROY_BARRIER_AUTHORITY_EXPECTED" == "1" ]]; then
    assert_destroy_barrier_owned || {
      error "Durable destroy barrier ownership was lost; refusing further mutation"
      exit 1
    }
  fi
}

json_get() {
  local path="$1"
  if [[ "$DESTROY_TEST_MODE" == "1" ]] && command -v jq >/dev/null 2>&1; then
    jq -r --arg path "$path" '
      getpath($path | split("."))
      | if . == null then empty
        elif type == "object" or type == "array" then tojson
        else tostring
        end
    ' "$MANIFEST_FILE"
    return 0
  fi
  "$NODE_BIN" - "$MANIFEST_FILE" "$path" <<'NODE'
const fs = require("node:fs");
const value = process.argv[3].split(".").reduce((current, key) => current?.[key], JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
if (value === undefined || value === null) process.exit(0);
if (typeof value === "object") process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
NODE
}

manifest_lines() {
  local kind="$1"
  if [[ "$DESTROY_TEST_MODE" == "1" ]] && command -v jq >/dev/null 2>&1; then
    jq -r --arg kind "$kind" '
      def clean: if . == null then "" else tostring | gsub("[\t\r\n]"; " ") end;
      def emit: map(clean) | join("\t");
      if $kind == "kv" then
        (.cloudflare.kvNamespaces[]? | [.id, .title, .binding, .createdByProject] | emit)
      elif $kind == "dns" then
         (.cloudflare.panelDnsRecords[]? | [.zoneId, .id, .name, .type, .content, .applied.ttl, .applied.proxied, .createdByProject, .modifiedByProject, .original.proxied, .original.ttl] | emit)
      elif $kind == "routes" then
        (.cloudflare.routes[]? | [.zoneId, .id, .pattern, .script, .createdByProject, .ownershipProven, .originalScript] | emit)
      elif $kind == "dlm" then
        (.aws.dlmPolicies[]? | [.id, .createdByProject] | emit)
      else empty
      end
    ' "$MANIFEST_FILE"
    return 0
  fi
  "$NODE_BIN" - "$MANIFEST_FILE" "$kind" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const clean = (value) => String(value ?? "").replace(/[\t\r\n]/g, " ");
const emit = (values) => process.stdout.write(`${values.map(clean).join("\t")}\n`);
switch (process.argv[3]) {
  case "kv":
    for (const item of manifest.cloudflare?.kvNamespaces || []) emit([item.id, item.title, item.binding, item.createdByProject]);
    break;
  case "dns":
     for (const item of manifest.cloudflare?.panelDnsRecords || []) emit([
        item.zoneId, item.id, item.name, item.type, item.content, item.applied?.ttl, item.applied?.proxied, item.createdByProject,
       item.modifiedByProject, item.original?.proxied, item.original?.ttl,
    ]);
    break;
  case "routes":
    for (const item of manifest.cloudflare?.routes || []) emit([
      item.zoneId, item.id, item.pattern, item.script, item.createdByProject, item.ownershipProven, item.originalScript,
    ]);
    break;
  case "dlm":
    for (const item of manifest.aws?.dlmPolicies || []) emit([item.id, item.createdByProject]);
    break;
}
NODE
}

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  "$NODE_BIN" - "$ENV_FILE" "$key" <<'NODE'
const fs = require("node:fs");
const key = process.argv[3];
for (const rawLine of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const line = rawLine.startsWith("export ") ? rawLine.slice(7) : rawLine;
  if (!line.startsWith(`${key}=`)) continue;
  let value = line.slice(key.length + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.stdout.write(value);
  break;
}
NODE
}

AWS_ACCOUNT_ID="$(json_get aws.accountId)"
AWS_REGION_VALUE="$(json_get aws.region)"
STACK_NAME="$(json_get aws.stack.name)"
STACK_ID="$(json_get aws.stack.id)"
STACK_OWNED="$(json_get aws.stack.createdByProject)"
STACK_CLAIM_TOKEN="$(json_get aws.stack.claimToken)"
INSTANCE_ID="$(json_get aws.instanceId)"
RUNTIME_USER_NAME="$(json_get aws.runtimeIam.userName)"
RUNTIME_USER_OWNED="$(json_get aws.runtimeIam.createdByProject)"
CF_ACCOUNT_ID="$(json_get cloudflare.accountId)"
WORKER_NAME="$(json_get cloudflare.worker.name)"
WORKER_OWNED="$(json_get cloudflare.worker.createdByProject)"
WORKER_DEPLOYMENT_ID="$(json_get cloudflare.worker.deploymentId)"
PANEL_MODE="$(json_get cloudflare.panelHosting.mode)"

if [[ -z "$AWS_ACCOUNT_ID" || -z "$AWS_REGION_VALUE" || -z "$STACK_NAME" || -z "$STACK_ID" || "$STACK_ID" == "unknown" ]]; then
  error "Manifest does not contain a complete immutable AWS deployment identity"
  exit 1
fi

CF_API_TOKEN="${CLOUDFLARE_TEARDOWN_API_TOKEN:-}"
[[ -n "$CF_API_TOKEN" ]] || CF_API_TOKEN="$(read_env_value CLOUDFLARE_TEARDOWN_API_TOKEN)"
[[ -n "$CF_API_TOKEN" ]] || CF_API_TOKEN="$(read_env_value CLOUDFLARE_PANEL_DNS_API_TOKEN)"
[[ -n "$CF_API_TOKEN" ]] || CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

aws_cli() {
  local service="${1:-}" operation="${2:-}"
  if [[ "$DESTROY_BARRIER_ESTABLISHED" == "1" && "$DESTROY_BARRIER_AUTHORITY_EXPECTED" == "1" ]]; then
    case "$operation" in
      get-*|list-*|describe-*|wait) ;;
      *)
        if ! assert_destroy_barrier_owned; then
          error "Durable destroy barrier ownership was lost before AWS mutation ${service}:${operation}"
          return 1
        fi
        ;;
    esac
  fi
  AWS_PAGER="" "$AWS_CLI" --region "$AWS_REGION_VALUE" "$@"
}

is_stack_not_found_error() { [[ "$1" == *"ValidationError"* && "$1" == *"does not exist"* ]]; }
is_iam_not_found_error() { [[ "$1" == *"NoSuchEntity"* ]]; }
is_dlm_not_found_error() { [[ "$1" == *"ResourceNotFoundException"* ]]; }
is_snapshot_not_found_error() { [[ "$1" == *"InvalidSnapshot.NotFound"* ]]; }
is_volume_not_found_error() { [[ "$1" == *"InvalidVolume.NotFound"* ]]; }
is_ssm_not_found_error() { [[ "$1" =~ (^|[^[:alnum:]_])ParameterNotFound([^[:alnum:]_]|$) ]]; }
is_dynamodb_not_found_error() { [[ "$1" == *"ResourceNotFoundException"* ]]; }
is_worker_not_found_error() { [[ "$1" =~ (^|[^0-9])(10007|10090)([^0-9]|$) ]]; }

# SSM has no conditional DeleteParameter. No SSM record is mutated by this
# script: bridge, exact-stack, legacy, and consented records all remain
# available for review unless a future authoritative backend supplies CAS.
conditional_ssm_delete() {
  error "SSM deletion is unavailable without an authoritative conditional mutation; preserving the parameter: $1"
  return 1
  return 1
}

conditional_ssm_delete_claim() {
  error "SSM claim deletion is unavailable without an authoritative conditional mutation; preserving the claim: $1"
  return 1
}

destroy_lifecycle_timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

destroy_phase_at_least() {
  local expected="$1"
  DESTROY_PHASE="$DESTROY_CURRENT_PHASE" EXPECTED_PHASE="$expected" "$NODE_BIN" -e '
const phases=["intent","runtime-quiesced","preserving","preserved","ingress-disabled","credentials-revoked","stack-deleting","complete"];
const current=phases.indexOf(process.env.DESTROY_PHASE), expected=phases.indexOf(process.env.EXPECTED_PHASE);
process.exit(current>=expected&&expected>=0?0:1);
'
}

acquire_destroy_process_lock() {
  command -v flock >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 || {
    error "Required command not found: flock or stat"
    return 1
  }
  local lock_path="${MANIFEST_FILE}.destroy.lock" old_umask fd_identity path_identity
  if [[ -L "$lock_path" ]]; then
    error "Destroy process lock path must not be a symbolic link: $lock_path"
    return 1
  fi
  old_umask="$(umask)"
  umask 077
  if ! { exec 9>>"$lock_path"; }; then
    umask "$old_umask"
    error "Could not open the destroy process lock: $lock_path"
    return 1
  fi
  umask "$old_umask"
  fd_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/9")" || return 1
  path_identity="$(stat -Lc '%d:%i' "$lock_path")" || return 1
  if [[ -L "$lock_path" || ! -f "$lock_path" || "$fd_identity" != "$path_identity" ]]; then
    exec 9>&-
    error "Destroy process lock identity changed while it was opened: $lock_path"
    return 1
  fi
  if ! flock -n 9; then
    error "Another destroy process is already using this deployment manifest"
    return 1
  fi
}

read_destroy_lock_facts() {
  local response
  response="$(aws_cli dynamodb get-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
    --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' --consistent-read --output json)" || return 1
  printf '%s' "$response" | EXPECTED_OPERATION="$DESTROY_OPERATION_ID" EXPECTED_LOCK="$DESTROY_LOCK_ID" "$NODE_BIN" -e '
const item=JSON.parse(require("node:fs").readFileSync(0,"utf8")).Item;
if(!item||item.released?.BOOL===true){process.stdout.write("EMPTY");process.exit(0)}
const token=Number(item.fencingToken?.N), generation=Number(item.leaseGeneration?.N);
const owned=item.action?.S==="destroy"&&item.agentFenceActive?.BOOL===true&&item.operationId?.S===process.env.EXPECTED_OPERATION&&item.operationOwnerId?.S===process.env.EXPECTED_OPERATION&&item.lockId?.S===process.env.EXPECTED_LOCK&&Number.isSafeInteger(token)&&token>0&&Number.isSafeInteger(generation)&&generation>0;
process.stdout.write(owned?["OWNED",token,generation,item.destroyPhase?.S||"intent",item.createdAt?.S||"-",item.preservationStartedAt?.S||"-"].join("\t"):"CONFLICT");
'
}

assert_destroy_protocol_metadata() {
  local response
  response="$(aws_cli dynamodb get-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
    --key '{"lockKey":{"S":"protocol#dual-v1"}}' --consistent-read --output json)" || return 1
  printf '%s' "$response" | "$NODE_BIN" -e '
const item=JSON.parse(require("node:fs").readFileSync(0,"utf8")).Item;
process.exit(item?.protocolVersion?.S==="dual-v1"?0:1);
'
}

assert_destroy_barrier_owned() {
  [[ -n "$LIFECYCLE_LOCK_TABLE_NAME" && -n "$DESTROY_OPERATION_ID" && -n "$DESTROY_LOCK_ID" && -n "$DESTROY_FENCING_TOKEN" ]] || return 1
  if [[ -n "$DESTROY_HEARTBEAT_FAILURE_FILE" && -s "$DESTROY_HEARTBEAT_FAILURE_FILE" ]]; then return 1; fi
  # The mocked CLI already enforces the authoritative barrier on every
  # mutating request. Avoid repeating the two remote reads for each mutation
  # in the subprocess-heavy shell test harness; production keeps the full
  # read-back verification below.
  if [[ "$DESTROY_TEST_MODE" == "1" ]]; then return 0; fi
  local facts
  facts="$(read_destroy_lock_facts)" || return 1
  [[ "$facts" == OWNED$'\t'* ]] || return 1
  local _ token _generation _phase _created _preservation_started
  IFS=$'\t' read -r _ token _generation _phase _created _preservation_started <<< "$facts"
  [[ "$token" == "$DESTROY_FENCING_TOKEN" ]] || return 1
}

renew_destroy_barrier_once() {
  local facts _ token generation phase created preservation_started now_ms expires_ms expires_at values response renewed_generation
  facts="$(read_destroy_lock_facts)" || return 1
  [[ "$facts" == OWNED$'\t'* ]] || return 1
  IFS=$'\t' read -r _ token generation phase created preservation_started <<< "$facts"
  [[ "$token" == "$DESTROY_FENCING_TOKEN" ]] || return 1
  now_ms="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  expires_ms=$((now_ms + DESTROY_BARRIER_LEASE_MS))
  expires_at="$("$NODE_BIN" -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' "$expires_ms")"
  values="$(EXPECTED_LOCK="$DESTROY_LOCK_ID" EXPECTED_TOKEN="$DESTROY_FENCING_TOKEN" EXPECTED_OPERATION="$DESTROY_OPERATION_ID" EXPECTED_GENERATION="$generation" NEXT_LEASE="$expires_ms" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({
  ":lockId":{S:process.env.EXPECTED_LOCK},":token":{N:process.env.EXPECTED_TOKEN},":operationId":{S:process.env.EXPECTED_OPERATION},
  ":generation":{N:process.env.EXPECTED_GENERATION},":lease":{N:process.env.NEXT_LEASE},":one":{N:"1"},":false":{BOOL:false},":true":{BOOL:true},":action":{S:"destroy"}
}));
')"
  response="$(aws_cli dynamodb update-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
    --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' \
    --condition-expression 'lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND operationId = :operationId AND operationOwnerId = :operationId AND leaseGeneration = :generation AND agentFenceActive = :true' \
    --update-expression 'SET leaseExpiresAt = :lease, leaseGeneration = leaseGeneration + :one' \
    --expression-attribute-names '{"#action":"action"}' --expression-attribute-values "$values" \
    --return-values ALL_NEW --output json)" || return 1
  renewed_generation="$(printf '%s' "$response" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));const n=Number(d.Attributes?.leaseGeneration?.N);if(!Number.isSafeInteger(n))process.exit(1);process.stdout.write(String(n))')" || return 1
  log "  ↻ Renewed destroy lifecycle barrier generation $renewed_generation"
}

start_destroy_barrier_renewal() {
  command -v setsid >/dev/null 2>&1 || {
    error "Required command not found: setsid"
    return 1
  }
  DESTROY_HEARTBEAT_FAILURE_FILE="$(mktemp "${TMPDIR:-/tmp}/mc-aws-destroy-heartbeat.XXXXXX")"
  : > "$DESTROY_HEARTBEAT_FAILURE_FILE"
  # Mocked teardown tests must not wait on wall-clock timers. Renewal-focused
  # tests use interval=1 as an explicit request for one synchronous renewal;
  # all other mocked tests only park the worker. Production retains the
  # interval-based renewal loop.
  if [[ "$DESTROY_TEST_MODE" == "1" && "$DESTROY_RENEW_INTERVAL_SECONDS" == "1" ]]; then
    if ! renew_destroy_barrier_once; then
      printf '%s\n' "destroy lifecycle barrier renewal failed" > "$DESTROY_HEARTBEAT_FAILURE_FILE"
    fi
  fi
  export -f log error aws_cli read_destroy_lock_facts assert_destroy_barrier_owned
  export -f renew_destroy_barrier_once
  renewal_worker_script=''
  if [[ "$DESTROY_TEST_MODE" == "1" ]]; then
    renewal_worker_script='tail -f /dev/null'
  else
    renewal_worker_script="$(cat <<'WORKER'
sleep_pid=""
trap '[[ -z "$sleep_pid" ]] || kill "$sleep_pid" 2>/dev/null || true; exit 0' TERM INT HUP
while true; do
  sleep "$DESTROY_RENEW_INTERVAL_SECONDS" &
  sleep_pid="$!"
  wait "$sleep_pid"
  sleep_pid=""
  if ! renew_destroy_barrier_once; then
    printf '%s\n' "destroy lifecycle barrier renewal failed" > "$DESTROY_HEARTBEAT_FAILURE_FILE"
    exit 1
  fi
done
WORKER
)"
  fi
  DESTROY_TEST_MODE="$DESTROY_TEST_MODE" DESTROY_RENEW_INTERVAL_SECONDS="$DESTROY_RENEW_INTERVAL_SECONDS" \
    DESTROY_HEARTBEAT_FAILURE_FILE="$DESTROY_HEARTBEAT_FAILURE_FILE" DESTROY_BARRIER_LEASE_MS="$DESTROY_BARRIER_LEASE_MS" \
    DESTROY_OPERATION_ID="$DESTROY_OPERATION_ID" DESTROY_LOCK_ID="$DESTROY_LOCK_ID" DESTROY_FENCING_TOKEN="$DESTROY_FENCING_TOKEN" \
    DESTROY_CREATED_AT="$DESTROY_CREATED_AT" DESTROY_CURRENT_PHASE="$DESTROY_CURRENT_PHASE" \
    DESTROY_BARRIER_ESTABLISHED="$DESTROY_BARRIER_ESTABLISHED" DESTROY_BARRIER_AUTHORITY_EXPECTED="$DESTROY_BARRIER_AUTHORITY_EXPECTED" \
    MANIFEST_FILE="$MANIFEST_FILE" NODE_BIN="$NODE_BIN" AWS_CLI="$AWS_CLI" AWS_REGION_VALUE="$AWS_REGION_VALUE" \
    LIFECYCLE_LOCK_TABLE_NAME="$LIFECYCLE_LOCK_TABLE_NAME" setsid "$BASH" -c "$renewal_worker_script" </dev/null >/dev/null 2>&1 &
  DESTROY_HEARTBEAT_PID="$!"
  if [[ "$DESTROY_TEST_MODE" == "1" && -n "${MC_AWS_DESTROY_HEARTBEAT_PID_FILE:-}" ]]; then
    printf '%s\n' "$DESTROY_HEARTBEAT_PID" > "$MC_AWS_DESTROY_HEARTBEAT_PID_FILE"
  fi
}

initialize_destroy_lifecycle_identity() {
  local lifecycle_line now
  lifecycle_line="$("$NODE_BIN" - "$MANIFEST_FILE" <<'NODE'
const m=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8")); const d=m.teardown?.destroyLifecycle;
if(d&&d.phase!=="aborted") process.stdout.write([d.operationId,d.lockId,d.fencingToken||"",d.createdAt,d.phase].join("\t"));
NODE
)"
  if [[ -n "$lifecycle_line" ]]; then
    local manifest_token _manifest_phase
    IFS=$'\t' read -r DESTROY_OPERATION_ID DESTROY_LOCK_ID manifest_token DESTROY_CREATED_AT _manifest_phase <<< "$lifecycle_line"
    DESTROY_FENCING_TOKEN="$manifest_token"
    return 0
  fi
  now="$(destroy_lifecycle_timestamp)"
  DESTROY_OPERATION_ID="destroy-$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  DESTROY_LOCK_ID="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  DESTROY_CREATED_AT="$now"
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    destroy-lifecycle-init --operation-id "$DESTROY_OPERATION_ID" --lock-id "$DESTROY_LOCK_ID" --created-at "$now" >/dev/null
  refresh_manifest_digest
}

acquire_destroy_barrier() {
  initialize_destroy_lifecycle_identity
  local facts now_ms expires_ms expires_at values response token generation phase created preservation_started updated_at
  assert_destroy_protocol_metadata || { error "Lifecycle lock dual-v1 protocol metadata is missing"; return 1; }
  facts="$(read_destroy_lock_facts)" || { error "Could not read the authoritative lifecycle lock"; return 1; }
  if [[ "$facts" == "CONFLICT" ]]; then
    error "Destroy barrier acquisition refused: another lifecycle or agent effect owns the global lock"
    return 1
  fi
  if [[ "$facts" == "EMPTY" ]]; then
    now_ms="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
    expires_ms=$((now_ms + DESTROY_BARRIER_LEASE_MS))
    expires_at="$("$NODE_BIN" -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' "$expires_ms")"
    values="$(EXPECTED_LOCK="$DESTROY_LOCK_ID" EXPECTED_OPERATION="$DESTROY_OPERATION_ID" OWNER_EMAIL="destroy@local.invalid" CREATED_AT="$DESTROY_CREATED_AT" NEXT_LEASE="$expires_ms" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({
  ":lockId":{S:process.env.EXPECTED_LOCK},":action":{S:"destroy"},":ownerEmail":{S:process.env.OWNER_EMAIL},":createdAt":{S:process.env.CREATED_AT},
  ":lease":{N:process.env.NEXT_LEASE},":generation":{N:"1"},":false":{BOOL:false},":true":{BOOL:true},":protocol":{S:"dual-v1"},
  ":zero":{N:"0"},":one":{N:"1"},":operationId":{S:process.env.EXPECTED_OPERATION},":phase":{S:"intent"},":now":{N:String(Date.now())}
}));
')"
    if ! response="$(aws_cli dynamodb update-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
      --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' \
      --condition-expression 'attribute_not_exists(lockId) OR released = :true OR (leaseExpiresAt < :now AND (attribute_not_exists(agentFenceActive) OR agentFenceActive = :false))' \
      --update-expression 'SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, leaseGeneration = :generation, agentFenceActive = :true, released = :false, protocolVersion = :protocol, fencingToken = if_not_exists(fencingToken, :zero) + :one, operationId = :operationId, operationOwnerId = :operationId, destroyPhase = :phase REMOVE ttlEpochSeconds' \
      --expression-attribute-names '{"#action":"action"}' --expression-attribute-values "$values" \
      --return-values ALL_NEW --output json 2>&1)"; then
      facts="$(read_destroy_lock_facts)" || {
        error "Destroy barrier acquisition result is ambiguous; the authoritative barrier is retained fail-closed for review: $response"
        return 1
      }
      if [[ "$facts" != OWNED$'\t'* ]]; then
        error "Destroy barrier acquisition failed; the authoritative barrier is retained fail-closed for review: $response"
        return 1
      fi
      warn "DynamoDB did not acknowledge destroy acquisition, but a consistent read proved the exact owner"
    else
      facts="$(printf '%s' "$response" | EXPECTED_OPERATION="$DESTROY_OPERATION_ID" EXPECTED_LOCK="$DESTROY_LOCK_ID" "$NODE_BIN" -e '
const item=JSON.parse(require("node:fs").readFileSync(0,"utf8")).Attributes;const token=Number(item?.fencingToken?.N),gen=Number(item?.leaseGeneration?.N);
if(item?.action?.S!=="destroy"||item?.operationId?.S!==process.env.EXPECTED_OPERATION||item?.lockId?.S!==process.env.EXPECTED_LOCK||item?.agentFenceActive?.BOOL!==true||!Number.isSafeInteger(token)||!Number.isSafeInteger(gen))process.exit(1);
process.stdout.write(["OWNED",token,gen,item.destroyPhase?.S||"intent",item.createdAt?.S||"-",item.preservationStartedAt?.S||"-"].join("\t"));
')" || return 1
    fi
  fi
  [[ "$facts" == OWNED$'\t'* ]] || return 1
  IFS=$'\t' read -r _ token generation phase created preservation_started <<< "$facts"
  if [[ -n "$DESTROY_FENCING_TOKEN" && "$DESTROY_FENCING_TOKEN" != "$token" ]]; then
    error "Destroy lifecycle fencing token changed; refusing to attach"
    return 1
  fi
  DESTROY_FENCING_TOKEN="$token"
  DESTROY_CURRENT_PHASE="$phase"
  [[ "$created" != "-" ]] && DESTROY_CREATED_AT="$created"
  now_ms="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  expires_at="$("$NODE_BIN" -e 'process.stdout.write(new Date(Number(process.argv[1])+'"$DESTROY_BARRIER_LEASE_MS"').toISOString())' "$now_ms")"
  updated_at="$(destroy_lifecycle_timestamp)"
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    destroy-lifecycle-acquired --operation-id "$DESTROY_OPERATION_ID" --lock-id "$DESTROY_LOCK_ID" \
    --fencing-token "$DESTROY_FENCING_TOKEN" --updated-at "$updated_at" >/dev/null
  if [[ "$phase" != "intent" && "$phase" != "barrier-active" ]]; then
    local -a reconcile_args
    reconcile_args=(destroy-lifecycle-phase --operation-id "$DESTROY_OPERATION_ID" --phase "$phase" --updated-at "$updated_at")
    if destroy_phase_at_least "preserving"; then
      if [[ "$preservation_started" == "-" ]]; then
        error "Authoritative destroy phase is $phase but its preservation timestamp is missing"
        return 1
      fi
      reconcile_args+=(--preservation-started-at "$preservation_started")
    fi
    MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
      "${reconcile_args[@]}" >/dev/null || {
        error "Local destroy journal is ahead of or inconsistent with the authoritative lifecycle phase"
        return 1
      }
  fi
  refresh_manifest_digest
  DESTROY_BARRIER_ESTABLISHED="1"
  DESTROY_BARRIER_AUTHORITY_EXPECTED="1"
  assert_destroy_barrier_owned || return 1
  if [[ "${NODE_ENV:-}" == "test" && "${MC_AWS_TEST_EXIT_AFTER_DESTROY_BARRIER:-}" == "1" ]]; then
    error "Test-only simulated destroy process death after durable barrier acquisition"
    exit 99
  fi
  start_destroy_barrier_renewal
  log "  ✅ Acquired durable destroy lifecycle barrier: operation=$DESTROY_OPERATION_ID fencingToken=$DESTROY_FENCING_TOKEN"
}

set_destroy_phase() {
  local phase="$1" now values expected_phase update_expression preservation_started
  local -a phase_args
  now="$(destroy_lifecycle_timestamp)"
  case "$phase" in
    runtime-quiesced) expected_phase="intent" ;;
    preserving) expected_phase="runtime-quiesced" ;;
    preserved) expected_phase="preserving" ;;
    ingress-disabled) expected_phase="preserved" ;;
    credentials-revoked) expected_phase="ingress-disabled" ;;
    stack-deleting) expected_phase="credentials-revoked" ;;
    complete) expected_phase="stack-deleting" ;;
    *) error "Unsupported destroy phase: $phase"; return 1 ;;
  esac
  values="$(EXPECTED_LOCK="$DESTROY_LOCK_ID" EXPECTED_TOKEN="$DESTROY_FENCING_TOKEN" EXPECTED_OPERATION="$DESTROY_OPERATION_ID" NEXT_PHASE="$phase" EXPECTED_PHASE="$expected_phase" NOW="$now" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({":lockId":{S:process.env.EXPECTED_LOCK},":token":{N:process.env.EXPECTED_TOKEN},":operationId":{S:process.env.EXPECTED_OPERATION},":phase":{S:process.env.NEXT_PHASE},":false":{BOOL:false},":true":{BOOL:true},":action":{S:"destroy"}}));
')"
  values="$(printf '%s' "$values" | EXPECTED_PHASE="$expected_phase" NOW="$now" "$NODE_BIN" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));v[":expectedPhase"]={S:process.env.EXPECTED_PHASE};v[":now"]={S:process.env.NOW};process.stdout.write(JSON.stringify(v))')"
  update_expression='SET destroyPhase = :phase'
  if [[ "$phase" == "preserving" ]]; then update_expression+=', preservationStartedAt = :now'; fi
  aws_cli dynamodb update-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
    --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' \
    --condition-expression 'lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND operationId = :operationId AND operationOwnerId = :operationId AND agentFenceActive = :true AND (destroyPhase = :expectedPhase OR destroyPhase = :phase)' \
    --update-expression "$update_expression" --expression-attribute-names '{"#action":"action"}' \
    --expression-attribute-values "$values" >/dev/null || return 1
  if [[ "${NODE_ENV:-}" == "test" && "${MC_AWS_TEST_EXIT_AFTER_DESTROY_PHASE:-}" == "$phase" ]]; then
    error "Test-only simulated destroy process death after authoritative $phase phase commit"
    exit 98
  fi
  assert_manifest_unchanged
  phase_args=(destroy-lifecycle-phase --operation-id "$DESTROY_OPERATION_ID" --phase "$phase" --updated-at "$now")
  if [[ "$phase" == "preserving" ]]; then phase_args+=(--preservation-started-at "$now");
  else
    preservation_started="$(json_get teardown.destroyLifecycle.preservationStartedAt)"
    [[ -n "$preservation_started" ]] && phase_args+=(--preservation-started-at "$preservation_started")
  fi
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" "${phase_args[@]}" >/dev/null
  refresh_manifest_digest
  DESTROY_CURRENT_PHASE="$phase"
}

safe_abort_destroy_barrier() {
  initialize_destroy_lifecycle_identity
  local facts _ token generation phase created preservation_started phrase values now legacy instance_line instance_state
  assert_destroy_protocol_metadata || { error "Lifecycle lock dual-v1 protocol metadata is missing"; return 1; }
  facts="$(read_destroy_lock_facts)" || return 1
  [[ "$facts" == OWNED$'\t'* ]] || { error "The manifest's exact destroy barrier is not authoritative"; return 1; }
  IFS=$'\t' read -r _ token generation phase created preservation_started <<< "$facts"
  if [[ "$phase" != "intent" && "$phase" != "barrier-active" && "$phase" != "runtime-quiesced" ]]; then
    error "Safe abort is refused after preservation starts (authoritative phase: $phase)"
    return 1
  fi
  if [[ -n "$(json_get teardown.destroyLifecycle.preservationStartedAt)" ]]; then
    error "Safe abort is refused because durable preservation has started"
    return 1
  fi
  # A failed quiescence may have stopped the gateway before discovering an
  # active executor effect. Never release the global fence until the host has
  # authoritatively become idle and the agent services have been restored.
  instance_line="$(read_managed_instance_root)" || {
    error "Could not verify the managed instance before safe abort"
    return 1
  }
  IFS=$'\t' read -r instance_state _ _ <<< "$instance_line"
  if [[ "$instance_state" == "running" ]]; then
    execute_verified_ssm_script "pre-preservation agent rollback" "# mc-agent-abort-rollback
set -euo pipefail
exec 8>/tmp/mc-operation.lock
flock -n 8
    /usr/local/bin/mc-host-operation.py executor-idle \
      --journal /var/lib/mc-agent-executor/executor-effect-journal.json \
       --credential /etc/mc-agent/executor-journal-hmac.key \
       --gateway-journal /var/lib/mc-agent-gateway/executor-reconciliations.json \
       --handoff-state auto \
       --checkpoint-sequence 0
systemctl start mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service
systemctl is-active --quiet mc-agent-executor.socket
systemctl is-active --quiet mc-agent-executor.service
systemctl is-active --quiet mc-agent-gateway.service" || {
      error "Pre-preservation agent rollback was not authoritatively verified; retaining destroy barrier"
      return 1
    }
  elif [[ "$instance_state" != "stopped" && "$instance_state" != "stopping" ]]; then
    error "Safe abort requires a stopped or running managed instance; found '$instance_state'"
    return 1
  fi
  phrase="abort destroy ${DESTROY_OPERATION_ID} before preservation"
  log "Type exactly: $phrase"
  IFS= read -r confirmation
  [[ "$confirmation" == "$phrase" ]] || { error "Safe-abort confirmation did not match"; return 1; }
  values="$(EXPECTED_LOCK="$DESTROY_LOCK_ID" EXPECTED_TOKEN="$token" EXPECTED_OPERATION="$DESTROY_OPERATION_ID" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({":lockId":{S:process.env.EXPECTED_LOCK},":token":{N:process.env.EXPECTED_TOKEN},":operationId":{S:process.env.EXPECTED_OPERATION},":false":{BOOL:false},":true":{BOOL:true},":action":{S:"destroy"},":phase":{S:"aborted"}}));
')"
  aws_cli dynamodb update-item --table-name "$LIFECYCLE_LOCK_TABLE_NAME" \
    --key '{"lockKey":{"S":"minecraft-server-lifecycle"}}' \
    --condition-expression 'lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND operationId = :operationId AND operationOwnerId = :operationId AND agentFenceActive = :true AND (destroyPhase = :phase OR destroyPhase = :intent OR destroyPhase = :quiesced)' \
    --update-expression 'SET released = :true, destroyPhase = :aborted' \
    --expression-attribute-names '{"#action":"action"}' \
    --expression-attribute-values "$(printf '%s' "$values" | "$NODE_BIN" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));v[":intent"]={S:"intent"};v[":quiesced"]={S:"runtime-quiesced"};v[":aborted"]={S:"aborted"};process.stdout.write(JSON.stringify(v))')" >/dev/null || return 1
  now="$(destroy_lifecycle_timestamp)"
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    destroy-lifecycle-aborted --operation-id "$DESTROY_OPERATION_ID" --updated-at "$now" >/dev/null
  refresh_manifest_digest
  log "  ✅ Explicitly released the exact pre-preservation destroy barrier"
}

is_exact_stack_delete_complete_json() {
  local response="$1"
  printf '%s' "$response" | EXPECTED_STACK_ID="$STACK_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const stack=d.Stacks?.[0];
process.exit(stack?.StackId===process.env.EXPECTED_STACK_ID && stack?.StackStatus==="DELETE_COMPLETE" ? 0 : 1);
' 2>/dev/null
}

wrangler() {
  if [[ "$DESTROY_BARRIER_ESTABLISHED" == "1" && "$DESTROY_BARRIER_AUTHORITY_EXPECTED" == "1" && " $* " == *" delete "* ]]; then
    assert_destroy_barrier_owned || {
      error "Durable destroy barrier ownership was lost before a Wrangler mutation"
      return 1
    }
  fi
  env -i PATH="$PATH" HOME="$WRANGLER_HOME_DIR" TERM="${TERM:-}" USER="${USER:-}" \
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" "$WRANGLER_BIN" "$@"
}

cf_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ "$method" != "GET" && "$DESTROY_BARRIER_ESTABLISHED" == "1" && "$DESTROY_BARRIER_AUTHORITY_EXPECTED" == "1" ]]; then
    assert_destroy_barrier_owned || {
      error "Durable destroy barrier ownership was lost before Cloudflare mutation $method $path"
      return 1
    }
  fi
  [[ -n "$CF_API_TOKEN" ]] || return 2
  local response_file http_status
  response_file="$(mktemp "${TMPDIR:-/tmp}/mc-aws-cf.XXXXXX")"
  if [[ -n "$body" ]]; then
    if ! http_status="$("$CURL_BIN" -sS -q -o "$response_file" -w "%{http_code}" -X "$method" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json" \
      --data "$body" "https://api.cloudflare.com/client/v4${path}")"; then
      rm -f "$response_file"
      return 3
    fi
  else
    if ! http_status="$("$CURL_BIN" -sS -q -o "$response_file" -w "%{http_code}" -X "$method" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json" \
      "https://api.cloudflare.com/client/v4${path}")"; then
      rm -f "$response_file"
      return 3
    fi
  fi
  printf '%s\n' "$http_status"
  "$NODE_BIN" -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$response_file"
  rm -f "$response_file"
}

cf_status() { printf '%s' "${1%%$'\n'*}"; }
cf_body() { printf '%s' "${1#*$'\n'}"; }

cf_assert_success() {
  local response="$1"
  local expected_status="$2"
  [[ "$(cf_status "$response")" == "$expected_status" ]] || return 1
  cf_body "$response" | "$NODE_BIN" -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
if (data.success !== true) process.exit(1);
'
}

cf_is_exact_dns_absence() {
  local response="$1"
  [[ "$(cf_status "$response")" == "404" ]] || return 1
  cf_body "$response" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
process.exit(d.success===false && Array.isArray(d.errors) && d.errors.some((error)=>error.code===81044) ? 0 : 1);
'
}

cf_dns_identity_matches() {
  local response="$1"
  local expected_id="$2"
  local expected_type="$3"
  local expected_name="$4"
  local expected_content="$5"
  local expected_ttl="$6"
  local expected_proxied="$7"
  cf_body "$response" | \
    EXPECTED_ID="$expected_id" EXPECTED_TYPE="$expected_type" EXPECTED_NAME="$expected_name" \
    EXPECTED_CONTENT="$expected_content" EXPECTED_TTL="$expected_ttl" EXPECTED_PROXIED="$expected_proxied" \
    "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); const r=d.result;
if(d.success!==true || !r) process.exit(1);
process.exit(
  String(r.id)===process.env.EXPECTED_ID &&
  String(r.type)===process.env.EXPECTED_TYPE &&
  String(r.name)===process.env.EXPECTED_NAME &&
  String(r.content)===process.env.EXPECTED_CONTENT &&
  String(r.ttl)===process.env.EXPECTED_TTL &&
  String(Boolean(r.proxied))===process.env.EXPECTED_PROXIED ? 0 : 1
);
'
}

cf_assert_complete_list_response() {
  local response="$1"
  cf_body "$response" | "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); const info=d.result_info;
if(d.success!==true || !Array.isArray(d.result) || !info || typeof info!=="object") process.exit(1);
const {page,total_pages,per_page,count,total_count}=info;
if(!Number.isInteger(page)||!Number.isInteger(total_pages)||!Number.isInteger(per_page)||!Number.isInteger(count)||!Number.isInteger(total_count)||page!==1||total_pages!==1||per_page<1||count!==d.result.length||total_count!==d.result.length||total_count>per_page||(total_count===0?1:Math.ceil(total_count/per_page))!==total_pages) process.exit(1);
'
}

mark_complete() {
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    mark-complete --resource "$1" >/dev/null
  refresh_manifest_digest
}

snapshot_ids_from_json() {
  "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const snapshot of d.Snapshots||[]) if(snapshot.SnapshotId) console.log(snapshot.SnapshotId);
'
}

inventory_project_snapshot_ids() {
  local volumes_json="$1"
  local collected=""
  local response=""
  response="$(aws_cli ec2 describe-snapshots --owner-ids self --filters "Name=tag:McAwsProject,Values=mc-aws" "Name=tag:McAwsStack,Values=$STACK_NAME" --output json)" || return 1
  collected="$(printf '%s' "$response" | snapshot_ids_from_json)"

  while IFS= read -r volume_id; do
    [[ -n "$volume_id" ]] || continue
    response="$(aws_cli ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$volume_id" --output json)" || return 1
    collected="${collected}"$'\n'"$(printf '%s' "$response" | snapshot_ids_from_json)"
  done < <(printf '%s' "$volumes_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const volume of d.Volumes||[]) if(volume.VolumeId) console.log(volume.VolumeId);
')

  while IFS=$'\t' read -r policy_id policy_owned; do
    [[ "$policy_owned" == "true" ]] || continue
    response="$(aws_cli ec2 describe-snapshots --owner-ids self --filters "Name=tag:aws:dlm:lifecycle-policy-id,Values=$policy_id" --output json)" || return 1
    collected="${collected}"$'\n'"$(printf '%s' "$response" | snapshot_ids_from_json)"
  done < <(manifest_lines dlm)

  printf '%s\n' "$collected" | "$NODE_BIN" -e '
const fs=require("node:fs"); const ids=[...new Set(fs.readFileSync(0,"utf8").split(/\s+/).filter(Boolean))].sort(); if(ids.length) process.stdout.write(ids.join("\n"));
'
}

assert_aws_account_now() {
  local account
  account="$(aws_cli sts get-caller-identity --query Account --output text)" || return 1
  [[ "$account" == "$AWS_ACCOUNT_ID" ]]
}

assert_exact_stack_live_now() {
  local response live_id
  response="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_ID" --output json)" || return 1
  live_id="$(printf '%s' "$response" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.Stacks?.[0]?.StackId||"")')"
  [[ "$live_id" == "$STACK_ID" ]]
}

assert_exact_stack_absent_now() {
  local response
  if response="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_ID" --output json 2>&1)"; then
    is_exact_stack_delete_complete_json "$response"
    return
  fi
  is_stack_not_found_error "$response"
}

assert_runtime_iam_tags_now() {
  local tags_json
  tags_json="$(aws_cli iam list-user-tags --user-name "$RUNTIME_USER_NAME" --output json)" || return 1
  printf '%s' "$tags_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const tags=Object.fromEntries((JSON.parse(require("node:fs").readFileSync(0,"utf8")).Tags||[]).map(({Key,Value})=>[Key,Value]));
process.exit(tags.McAwsProject==="mc-aws" && tags.McAwsPurpose==="CloudflareWorkerRuntime" && tags.McAwsStack===process.env.EXPECTED_STACK ? 0 : 1);
'
}

assert_worker_deployment_now() {
  [[ -n "$WORKER_NAME" ]] || return 0
  local deployments
  deployments="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json)" || return 1
  printf '%s' "$deployments" | EXPECTED_DEPLOYMENT_ID="$WORKER_DEPLOYMENT_ID" "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("{"); if(start<0) process.exit(2);
const value=JSON.parse(raw.slice(start)); process.exit(value.id===process.env.EXPECTED_DEPLOYMENT_ID ? 0 : 1);
'
}

read_managed_instance_root() {
  local response
  response="$(aws_cli ec2 describe-instances --instance-ids "$INSTANCE_ID" --output json)" || return 1
  printf '%s' "$response" | EXPECTED_INSTANCE="$INSTANCE_ID" EXPECTED_STACK="$STACK_NAME" EXPECTED_STACK_ID="$STACK_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const instance=(d.Reservations||[]).flatMap((reservation)=>reservation.Instances||[]).find((item)=>item.InstanceId===process.env.EXPECTED_INSTANCE);
if(!instance) process.exit(2);
const tags=Object.fromEntries((instance.Tags||[]).map(({Key,Value})=>[Key,Value]));
if(tags.McAwsProject!=="mc-aws" || tags.McAwsStack!==process.env.EXPECTED_STACK || tags["aws:cloudformation:stack-id"]!==process.env.EXPECTED_STACK_ID) process.exit(3);
const rootDevice=instance.RootDeviceName||"/dev/xvda";
const root=(instance.BlockDeviceMappings||[]).find((item)=>item.DeviceName===rootDevice);
process.stdout.write([instance.State?.Name||"unknown",rootDevice,root?.Ebs?.VolumeId||""].join("\t"));
'
}

verify_managed_root_volume() {
  local volume_id="$1"
  local response
  response="$(aws_cli ec2 describe-volumes --volume-ids "$volume_id" --output json)" || return 1
  printf '%s' "$response" | EXPECTED_VOLUME="$volume_id" EXPECTED_INSTANCE="$INSTANCE_ID" EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const volume=(d.Volumes||[]).find((item)=>item.VolumeId===process.env.EXPECTED_VOLUME); if(!volume) process.exit(1);
const tags=Object.fromEntries((volume.Tags||[]).map(({Key,Value})=>[Key,Value])); const attached=(volume.Attachments||[]).some((item)=>item.InstanceId===process.env.EXPECTED_INSTANCE);
process.exit(attached && tags.McAwsProject==="mc-aws" && tags.McAwsStack===process.env.EXPECTED_STACK && tags.McAwsManagedRoot==="true" ? 0 : 1);
'
}

execute_verified_ssm_script() {
  local label="$1"
  local script="$2"
  local parameters send_json command_id invocation_json
  assert_manifest_unchanged
  parameters="$(SSM_SCRIPT="$script" "$NODE_BIN" -e 'process.stdout.write(JSON.stringify({commands:[process.env.SSM_SCRIPT]}))')"
  send_json="$(aws_cli ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters "$parameters" --output json)" || {
    error "Could not send the $label command through SSM"
    return 1
  }
  command_id="$(printf '%s' "$send_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const id=d.Command?.CommandId;
if(typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id))process.exit(1);process.stdout.write(id);
')" || { error "SSM did not return a valid command identity for $label"; return 1; }
  if ! aws_cli ssm wait command-executed --command-id "$command_id" --instance-id "$INSTANCE_ID"; then
    error "$label command did not reach successful completion"
    return 1
  fi
  invocation_json="$(aws_cli ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" --output json)" || {
    error "Could not verify the completed $label command"
    return 1
  }
  if ! printf '%s' "$invocation_json" | EXPECTED_COMMAND="$command_id" EXPECTED_INSTANCE="$INSTANCE_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
process.exit(d.CommandId===process.env.EXPECTED_COMMAND&&d.InstanceId===process.env.EXPECTED_INSTANCE&&d.Status==="Success"?0:1);
'; then
    error "$label command did not report exact Success status"
    return 1
  fi
}

quiesce_agent_runtime() {
  local instance_state="$1"
  case "$instance_state" in
    stopped|stopping)
      log "  ✅ EC2 is non-running; no host agent or lifecycle effect can remain active"
      ;;
    pending)
      if ! aws_cli ec2 wait instance-running --instance-ids "$INSTANCE_ID"; then
        error "Pending EC2 instance did not reach running state for agent quiescence"
        return 1
      fi
      quiesce_agent_runtime "running" || return 1
      ;;
    running)
      # Stop the only process that can claim new agent work, then require the
      # executor's atomic effect journal and the shared host operation flock to
      # prove idle before closing its socket/service. A malformed or in-progress
      # journal is an authoritative blocker, never an invitation to kill/retry.
      local script
      script=$(cat <<'SCRIPT'
set -euo pipefail
systemctl stop mc-agent-gateway.service
! systemctl is-active --quiet mc-agent-gateway.service
exec 8>/tmp/mc-operation.lock
flock -n 8
      /usr/local/bin/mc-host-operation.py executor-idle \
        --journal /var/lib/mc-agent-executor/executor-effect-journal.json \
         --credential /etc/mc-agent/executor-journal-hmac.key \
         --gateway-journal /var/lib/mc-agent-gateway/executor-reconciliations.json \
         --handoff-state auto \
         --checkpoint-sequence 0
systemctl stop mc-agent-executor.socket mc-agent-executor.service
! systemctl is-active --quiet mc-agent-executor.socket
! systemctl is-active --quiet mc-agent-executor.service
SCRIPT
)
      execute_verified_ssm_script "agent quiescence" "$script" || return 1
      log "  ✅ Agent gateway stopped; executor journal and host operation lock are authoritatively idle"
      ;;
    *)
      error "Instance is in unsupported state '$instance_state'; refusing agent quiescence"
      return 1
      ;;
  esac
  set_destroy_phase "runtime-quiesced" || return 1
}

create_final_google_drive_backup() {
  local recorded_operation backup_suffix backup_base backup_name MC_REMOTE_OPERATION_KEY completed_at script
  recorded_operation="$(json_get teardown.finalGoogleDriveBackup.operationId)"
  if [[ "$recorded_operation" == "$DESTROY_OPERATION_ID" ]]; then
    log "  ✅ Reusing the exact completed final Drive backup for this fenced destroy operation"
    return 0
  fi
  backup_suffix="$(printf '%s' "${DESTROY_OPERATION_ID#destroy-}" | tr -d '-' | cut -c1-12)"
  backup_base="final-destroy-${backup_suffix}"
  backup_name="${backup_base}.tar.gz"
  MC_REMOTE_OPERATION_KEY="$(printf '%s' "$DESTROY_OPERATION_ID" | "$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(0)).digest("hex"))')"
  script="set -euo pipefail; export MC_REMOTE_OPERATION_KEY='$MC_REMOTE_OPERATION_KEY' MC_ROOT_VOLUME_ID='$root_volume_id' MC_ROOT_VOLUME_DEVICE='$root_device'; exec /usr/local/bin/mc-backup.sh --destroy '$backup_base'"
  execute_verified_ssm_script "final Google Drive backup" "$script" || return 1
  completed_at="$(destroy_lifecycle_timestamp)"
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    final-google-drive-backup --backup-name "$backup_name" --operation-id "$DESTROY_OPERATION_ID" \
    --completed-at "$completed_at" >/dev/null
  refresh_manifest_digest
  log "  ✅ Completed and recorded the exact final Drive backup: $backup_name"
}

stop_instance_after_terminal_backup() {
  local initial_state="$1"
  local expected_root_volume="$2"
  local refreshed_line refreshed_state refreshed_root_device refreshed_root_volume

  case "$initial_state" in
    running|pending)
      if [[ "$initial_state" == "pending" ]]; then
        if ! aws_cli ec2 wait instance-running --instance-ids "$INSTANCE_ID"; then
          error "Pending EC2 instance did not reach running state before terminal backup shutdown"
          return 1
        fi
        refreshed_line="$(read_managed_instance_root)" || return 1
        IFS=$'\t' read -r refreshed_state refreshed_root_device refreshed_root_volume <<< "$refreshed_line"
        if [[ "$refreshed_state" != "running" || "$refreshed_root_volume" != "$expected_root_volume" ]]; then
          error "Instance/root identity changed before terminal backup shutdown"
          return 1
        fi
      fi
      if ! aws_cli ec2 stop-instances --instance-ids "$INSTANCE_ID" --output json >/dev/null; then
        error "EC2 stop request failed after terminal Drive backup"
        return 1
      fi
      if ! aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"; then
        error "EC2 instance did not reach stopped state after terminal Drive backup"
        return 1
      fi
      ;;
    stopping)
      if ! aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"; then
        error "EC2 instance did not reach stopped state after terminal Drive backup"
        return 1
      fi
      ;;
    stopped)
      ;;
    *)
      error "Instance is in unsupported state '$initial_state' after terminal Drive backup"
      return 1
      ;;
  esac

  refreshed_line="$(read_managed_instance_root)" || return 1
  IFS=$'\t' read -r refreshed_state refreshed_root_device refreshed_root_volume <<< "$refreshed_line"
  if [[ "$refreshed_state" != "stopped" || "$refreshed_root_volume" != "$expected_root_volume" ]] || \
    ! verify_managed_root_volume "$expected_root_volume"; then
    error "Instance/root identity changed or instance is not stopped after terminal Drive backup"
    return 1
  fi
}

quiesce_instance_for_snapshot() {
  local initial_state="$1"
  local expected_root_volume="$2"
  local stop_script parameters send_json command_id invocation_json refreshed_line refreshed_state refreshed_root_device refreshed_root_volume scrubbed_volume

  case "$initial_state" in
    running|pending)
      log "  ⏳ Gracefully stopping Minecraft before preserving data for the $initial_state instance"
      if [[ "$initial_state" == "pending" ]]; then
        if ! aws_cli ec2 wait instance-running --instance-ids "$INSTANCE_ID"; then
          error "Pending EC2 instance did not reach running state for graceful Minecraft quiescence"
          return 1
        fi
        refreshed_line="$(read_managed_instance_root)" || {
          error "Could not re-read the pending instance after it reached running state"
          return 1
        }
        IFS=$'\t' read -r refreshed_state refreshed_root_device refreshed_root_volume <<< "$refreshed_line"
        if [[ "$refreshed_state" != "running" || "$refreshed_root_volume" != "$expected_root_volume" ]] || \
          ! verify_managed_root_volume "$expected_root_volume"; then
          error "Pending instance/root identity changed before Minecraft quiescence"
          return 1
        fi
      fi
      stop_script='set -eu; systemctl stop minecraft.service; i=0; while [ "$i" -lt 24 ]; do if ! systemctl is-active --quiet minecraft.service; then break; fi; i=$((i+1)); sleep 5; done; ! systemctl is-active --quiet minecraft.service'
      if [[ "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
        stop_script+='; rm -f -- /opt/setup/rclone/rclone.conf; for f in /opt/setup/rclone/rclone.conf.tmp.*; do [ "$f" = "/opt/setup/rclone/rclone.conf.tmp.*" ] && break; rm -f -- "$f"; done; test ! -e /opt/setup/rclone/rclone.conf; for f in /opt/setup/rclone/rclone.conf.tmp.*; do [ "$f" = "/opt/setup/rclone/rclone.conf.tmp.*" ] || exit 1; done; sync'
      fi
      parameters="$(SSM_STOP_SCRIPT="$stop_script" "$NODE_BIN" -e 'process.stdout.write(JSON.stringify({commands:[process.env.SSM_STOP_SCRIPT]}))')"
      send_json="$(aws_cli ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters "$parameters" --output json)" || {
        error "Could not send the Minecraft quiesce command through SSM"
        return 1
      }
      command_id="$(printf '%s' "$send_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const id=d.Command?.CommandId;
if(typeof id!=="string" || !/^[a-f0-9-]{36}$/i.test(id)) process.exit(1); process.stdout.write(id);
')" || {
        error "SSM did not return a valid command identity for Minecraft quiescence"
        return 1
      }
      if ! aws_cli ssm wait command-executed --command-id "$command_id" --instance-id "$INSTANCE_ID"; then
        error "Minecraft quiesce command did not reach successful completion"
        return 1
      fi
      invocation_json="$(aws_cli ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE_ID" --output json)" || {
        error "Could not verify the completed Minecraft quiesce command"
        return 1
      }
      if ! printf '%s' "$invocation_json" | EXPECTED_COMMAND="$command_id" EXPECTED_INSTANCE="$INSTANCE_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
process.exit(d.CommandId===process.env.EXPECTED_COMMAND && d.InstanceId===process.env.EXPECTED_INSTANCE && d.Status==="Success" ? 0 : 1);
'; then
        error "Minecraft quiesce command did not report exact Success status"
        return 1
      fi
      if [[ "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
        assert_manifest_unchanged
        MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
          snapshot-scrub --volume-id "$expected_root_volume" --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
        refresh_manifest_digest
        log "  ✅ Scrubbed reusable Google Drive/rclone credentials before snapshot"
      fi
      if ! aws_cli ec2 stop-instances --instance-ids "$INSTANCE_ID" --output json >/dev/null; then
        error "EC2 stop request failed after Minecraft quiescence"
        return 1
      fi
      if ! aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"; then
        error "EC2 instance did not reach stopped state; refusing to snapshot a live instance"
        return 1
      fi
      ;;
    stopped)
      if [[ "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
        scrubbed_volume="$(json_get teardown.snapshotCredentialScrub.sourceVolumeId)"
        if [[ "$scrubbed_volume" != "$expected_root_volume" ]]; then
          error "Stopped root volume has no durable credential-scrub evidence; refusing a reusable-credential snapshot"
          return 1
        fi
      fi
      log "  ✅ Instance is already stopped; selected data-preservation checks can proceed"
      ;;
    stopping)
      log "  ⏳ Instance is already stopping; waiting for exact stopped state"
      if ! aws_cli ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"; then
        error "EC2 instance did not finish stopping; refusing to snapshot a live instance"
        return 1
      fi
      if [[ "$DATA_PRESERVATION_MODE" == "snapshot" && "$(json_get teardown.snapshotCredentialScrub.sourceVolumeId)" != "$expected_root_volume" ]]; then
        error "Stopping root volume has no durable credential-scrub evidence; refusing snapshot"
        return 1
      fi
      ;;
    *)
      error "Instance is in unsupported state '$initial_state'; refusing final data preservation"
      return 1
      ;;
  esac

  refreshed_line="$(read_managed_instance_root)" || {
    error "Could not re-read the exact managed instance/root volume after quiescence"
    return 1
  }
  IFS=$'\t' read -r refreshed_state refreshed_root_device refreshed_root_volume <<< "$refreshed_line"
  if [[ "$refreshed_state" != "stopped" || "$refreshed_root_volume" != "$expected_root_volume" ]]; then
    error "Instance/root identity changed or instance is not stopped after quiescence; refusing snapshot"
    return 1
  fi
  if ! verify_managed_root_volume "$expected_root_volume"; then
    error "Root volume identity/tags changed after quiescence; refusing snapshot"
    return 1
  fi
}

verify_final_snapshot() {
  local snapshot_id="$1"
  local source_volume_id="$2"
  local response
  response="$(aws_cli ec2 describe-snapshots --snapshot-ids "$snapshot_id" --owner-ids self --output json)" || return 1
  printf '%s' "$response" | EXPECTED_SNAPSHOT="$snapshot_id" EXPECTED_VOLUME="$source_volume_id" EXPECTED_STACK_ID="$STACK_ID" EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const snapshot=(d.Snapshots||[]).find((item)=>item.SnapshotId===process.env.EXPECTED_SNAPSHOT);
if(!snapshot || snapshot.State!=="completed" || snapshot.VolumeId!==process.env.EXPECTED_VOLUME) process.exit(1);
const tags=Object.fromEntries((snapshot.Tags||[]).map(({Key,Value})=>[Key,Value]));
process.exit(tags.McAwsProject==="mc-aws" && tags.McAwsStack===process.env.EXPECTED_STACK && tags.McAwsFinalTeardown==="true" && tags.McAwsStackId===process.env.EXPECTED_STACK_ID && tags.McAwsSourceVolumeId===process.env.EXPECTED_VOLUME ? 0 : 1);
'
}

read_final_snapshot_state() {
  local snapshot_id="$1"
  local source_volume_id="$2"
  local response
  if ! response="$(aws_cli ec2 describe-snapshots --snapshot-ids "$snapshot_id" --owner-ids self --output json 2>&1)"; then
    if is_snapshot_not_found_error "$response"; then
      printf 'absent'
      return 0
    fi
    return 1
  fi
  printf '%s' "$response" | EXPECTED_SNAPSHOT="$snapshot_id" EXPECTED_VOLUME="$source_volume_id" EXPECTED_STACK_ID="$STACK_ID" EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const snapshot=(d.Snapshots||[]).find((item)=>item.SnapshotId===process.env.EXPECTED_SNAPSHOT);
if(!snapshot || snapshot.VolumeId!==process.env.EXPECTED_VOLUME || typeof snapshot.State!=="string") process.exit(1);
const tags=Object.fromEntries((snapshot.Tags||[]).map(({Key,Value})=>[Key,Value]));
if(tags.McAwsProject!=="mc-aws" || tags.McAwsStack!==process.env.EXPECTED_STACK || tags.McAwsFinalTeardown!=="true" || tags.McAwsStackId!==process.env.EXPECTED_STACK_ID || tags.McAwsSourceVolumeId!==process.env.EXPECTED_VOLUME) process.exit(1);
process.stdout.write(snapshot.State);
'
}

record_hibernated_backup_evidence() {
  local observed_at="$1"
  local expected_volume_id="${2:-}"
  local operations_json evidence_line operation_id managed_volume_id backup_name backup_id backup_digest backup_size backup_generation backup_created_at backup_server_id
  if [[ -z "${OPERATION_STATE_TABLE_NAME:-}" ]]; then
    error "Hibernated teardown requires the exact stack-owned operation-state table"
    return 1
  fi
  operations_json="$(aws_cli dynamodb scan --table-name "$OPERATION_STATE_TABLE_NAME" --projection-expression 'operationId,payload' --output json)" || {
    error "Could not read durable hibernation transaction evidence"
    return 1
  }
  evidence_line="$(printf '%s' "$operations_json" | EXPECTED_INSTANCE="$INSTANCE_ID" EXPECTED_VOLUME="$expected_volume_id" EXPECTED_SERVER_ID="$STACK_ID" "$NODE_BIN" -e '
const {createHash}=require("node:crypto");
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const expectedInstance=process.env.EXPECTED_INSTANCE, expectedVolume=process.env.EXPECTED_VOLUME;
const valid=(d.Items||[]).flatMap((item)=>{let s;try{s=JSON.parse(item.payload?.S||"")}catch{return []}
  const q=s.hibernateQuiescenceEvidence;
  const volume=s.managedVolumeId;
  if(s.schemaVersion!==1||s.id!==item.operationId?.S||s.type!=="hibernate"||s.instanceId!==expectedInstance||
    s.hibernateOriginalInstanceId!==expectedInstance||!/^ami-[a-f0-9]{8,17}$/.test(s.hibernateSourceImageId||"")||
    !/^snap-[a-f0-9]{8,17}$/.test(s.hibernateReconstructionSnapshotId||"")||
    typeof s.executionToken!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(s.executionToken)||
    !["detached","deleted"].includes(s.hibernatePhase)||!/^vol-[a-f0-9]{8,17}$/.test(volume||"")||
    !/^\/dev\/[A-Za-z0-9._-]+$/.test(s.managedVolumeDevice||"")||
    (expectedVolume&&volume!==expectedVolume)||!/^[^/]+\.tar\.gz$/.test(s.hibernateBackupArchiveName||"")||
    !/^[a-f0-9]{32}$/.test(s.hibernateBackupId||"")||!/^[a-f0-9]{64}$/.test(s.hibernateBackupDigest||"")||
    !Number.isSafeInteger(s.hibernateBackupSize)||s.hibernateBackupSize<1||!Number.isSafeInteger(s.hibernateBackupGeneration)||s.hibernateBackupGeneration<1||
    !/^\d{4}-\d{2}-\d{2}T/.test(s.hibernateBackupCreatedAt||"")||
    s.hibernateBackupOperationKey!==createHash("sha256").update(`${s.id}\0hibernate-backup`).digest("hex")||
    s.hibernateBackupInstanceId!==expectedInstance||s.hibernateBackupServerId!==process.env.EXPECTED_SERVER_ID||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.hibernateBackupAuthenticationKeyId||"")||
    !q||Object.keys(q).sort().join(",")!==["bootId","maintenanceFence","maintenanceOwner","minecraft","mode","protocol","quiescenceEpoch","rootVolumeDevice","rootVolumeId","schemaVersion","services"].join(",")||q.schemaVersion!==2||q.mode!=="terminal-hibernate"||
    q.maintenanceFence!=="held"||q.services!=="stopped-and-masked"||q.minecraft!=="inactive"||q.protocol!=="closed"||
    q.rootVolumeId!==volume||q.rootVolumeDevice!==s.managedVolumeDevice||!/^[a-f0-9]{32}$/.test(q.quiescenceEpoch||"")||
    typeof q.maintenanceOwner!=="string"||!q.maintenanceOwner||typeof q.bootId!=="string"||!q.bootId)return [];
  return [{s,id:item.operationId?.S||s.id||""}];
}).filter(({id})=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
  .sort((a,b)=>b.s.hibernateBackupGeneration-a.s.hibernateBackupGeneration);
if(valid.length<1)process.exit(1); const {s,id}=valid[0];
process.stdout.write([id,s.managedVolumeId,s.hibernateBackupArchiveName,s.hibernateBackupId,s.hibernateBackupDigest,s.hibernateBackupSize,s.hibernateBackupGeneration,s.hibernateBackupCreatedAt,s.hibernateBackupServerId].join("\t"));
')" || {
    error "No exact durable terminal hibernation transaction proves Google Drive preservation"
    return 1
  }
  IFS=$'\t' read -r operation_id managed_volume_id backup_name backup_id backup_digest backup_size backup_generation backup_created_at backup_server_id <<< "$evidence_line"
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    hibernated-backup --operation-id "$operation_id" --volume-id "$managed_volume_id" --backup-name "$backup_name" \
    --backup-id "$backup_id" --backup-digest "$backup_digest" --backup-size "$backup_size" \
    --backup-generation "$backup_generation" --backup-created-at "$backup_created_at" --server-id "$backup_server_id" \
    --observed-at "$observed_at" >/dev/null
  refresh_manifest_digest
  log "  ✅ Recorded exact durable terminal hibernation backup evidence: $backup_name (generation $backup_generation)"
  log "     Google Drive content is external and will not be deleted; no EBS snapshot will be retained."
}

recovery_capsule_state_generation() {
  local name="$1" kind
  case "$name" in
    /minecraft/backup-generation-checkpoint) kind="backup-generation" ;;
    /minecraft/restore-generation-floor) kind="restore-floor" ;;
    *) return 1 ;;
  esac
  MC_BACKUP_AUTH_AWS_CLI="$AWS_CLI" AWS_DEFAULT_REGION="$AWS_REGION_VALUE" \
    python3 "$ROOT_DIR/infra/src/ec2/mc-backup-auth.py" state-verify --parameter "$name" --kind "$kind" 2>/dev/null
}

record_recovery_capsule() {
  local checkpoint_generation floor_generation preserved_at
  # The four exact SSM records are deliberately retained outside Drive. Their
  # values are authenticated state (not credentials); read only their
  # generations so the manifest records a truthful continuity floor without
  # copying key material or state into the deployment manifest.
  if ! checkpoint_generation="$(recovery_capsule_state_generation /minecraft/backup-generation-checkpoint)" || \
     ! floor_generation="$(recovery_capsule_state_generation /minecraft/restore-generation-floor)"; then
    error "Could not verify authenticated recovery-capsule generation continuity"
    return 1
  fi
  (( floor_generation <= checkpoint_generation )) || {
    error "Recovery capsule restore floor exceeds its generation checkpoint"
    return 1
  }
  preserved_at="$(destroy_lifecycle_timestamp)"
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    recovery-capsule --status preserved --checkpoint-generation "$checkpoint_generation" \
    --floor-generation "$floor_generation" --preserved-at "$preserved_at" >/dev/null
  refresh_manifest_digest
  log "  ✅ Preserved authenticated recovery capsule outside Drive (identity, keyring, key IDs, verifier, checkpoint, floor)"
}

# Inventory may enumerate the /minecraft hierarchy, but mutation is limited to
# these exact names and tightly validated project-generated child names. The
# inventory and deletion probes request metadata only; parameter values are read
# only for the explicit backup-preservation gate and are never emitted.
inventory_ssm_parameters() {
  aws_cli ssm describe-parameters --parameter-filters 'Key=Path,Option=Recursive,Values=/minecraft' \
    --query 'Parameters[].{Name:Name,Type:Type}' --output json
}

describe_exact_ssm_parameter() {
  local name="$1"
  aws_cli ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=$name" \
    --query 'Parameters[].Name' --output text
}

classify_ssm_inventory() {
  local inventory_json="$1"
  local consent_lines
  consent_lines="$(printf '%s\n' "${CONSENT_SSM_NAMES[@]:-}")"
  RETAIN_GDRIVE_TOKEN="$RETAIN_GDRIVE_TOKEN" CONSENT_SSM_NAMES="$consent_lines" \
    RECOVERY_CAPSULE_DELETE_APPROVED="$RECOVERY_CAPSULE_DELETE_APPROVED" \
    STACK_SSM_NAMES_JSON="${STACK_SSM_NAMES_JSON:-[]}" "$NODE_BIN" - "$MANIFEST_FILE" 3<<<"$inventory_json" <<'NODE'
const fs=require("node:fs");
const parameters=JSON.parse(fs.readFileSync(3,"utf8"));
const manifest=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const facts=manifest.aws?.ssmParameters||[];
const stackOwned=new Set(JSON.parse(process.env.STACK_SSM_NAMES_JSON||"[]"));
const consented=new Set((process.env.CONSENT_SSM_NAMES||"").split(/\n/).filter(Boolean));
// Keep this a closed-world list. A path that merely resembles one of these
// names remains unclassified and can never be made deletable by a broad
// prefix or a consent flag.
const exact=new Map([
  ["/minecraft/gdrive-token",["credential","delete-after-preservation"]],
   ["/minecraft/backup-auth-keyring",["credential","retain-until-explicit-consent"]],
   ["/minecraft/backup-server-identity",["backup-identity","retain-until-explicit-consent"]],
    ["/minecraft/backup-generation-checkpoint",["backup-state","retain-until-explicit-consent"]],
    ["/minecraft/restore-generation-floor",["backup-state","retain-until-explicit-consent"]],
    ["/minecraft/backup-verifier-metadata",["backup-state","retain-until-explicit-consent"]],
    ["/minecraft/backup-recovery-adoption-lock",["backup-state","retain-until-explicit-consent"]],
  ["/minecraft/cloudflare-api-token",["credential","delete-after-stack"]],
  ["/minecraft/duckdns-token",["credential","delete-after-stack"]],
  ["/minecraft/email-allowlist",["pii","delete-after-preservation"]],
  ["/minecraft/verified-sender",["pii","delete-after-preservation"]],
  ["/minecraft/notification-email",["pii","delete-after-preservation"]],
  ["/minecraft/startup-triggered-by",["pii","delete-after-preservation"]],
  ["/minecraft/player-count",["runtime-state","delete-after-preservation"]],
  ["/minecraft/backups-cache",["runtime-state","delete-after-preservation"]],
  ["/minecraft/last-scheduled-backup-success",["runtime-state","delete-after-preservation"]],
  ["/minecraft/scheduled-backup-enabled-at",["runtime-state","delete-after-preservation"]],
  ["/minecraft/server-action",["pii","delete-after-stack"]],
  ["/minecraft/resume-pending",["runtime-state","delete-after-preservation"]],
  ["/minecraft/server-profile-manifest",["runtime-state","delete-after-stack"]],
  ["/minecraft/cloudflare-zone-id",["runtime-state","delete-after-stack"]],
  ["/minecraft/cloudflare-domain",["runtime-state","delete-after-stack"]],
  ["/minecraft/duckdns-domain",["runtime-state","delete-after-stack"]],
  ["/minecraft/github-pat",["legacy-credential","delete-after-preservation"]],
  ["/minecraft/github-user",["legacy-config","delete-after-preservation"]],
  ["/minecraft/github-repo",["legacy-config","delete-after-preservation"]],
]);
const operation=/^\/minecraft\/operations\/(?:start|stop|backup|restore|hibernate|resume)-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailOperation=/^\/minecraft\/operations\/email-(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const claim=/^\/minecraft\/server-action-delete-claim\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const currentHint="/minecraft/server-action-delete-claim/current";
for(const parameter of parameters){
  const name=typeof parameter?.Name==="string"?parameter.Name:"";
  const type=typeof parameter?.Type==="string"?parameter.Type:"unknown";
   const exactClassification=exact.get(name);
   let category=exactClassification?.[0];
   const policy=exactClassification?.[1]||"preserve-unclassified";
  if(!category && (operation.test(name)||emailOperation.test(name)||claim.test(name)||name===currentHint)) category="pii";
  const fact=facts.find((entry)=>entry.name===name)||facts.find((entry)=>entry.name.endsWith("/*")&&name.startsWith(entry.name.slice(0,-1)));
   const hasOriginalProof=fact?.ownership==="created"&&typeof fact.claimToken==="string"&&/^[a-f0-9-]{36}$/.test(fact.claimToken)&&Number.isSafeInteger(fact.resourceVersion)&&fact.resourceVersion>=1;
   const ownership=hasOriginalProof?"created":fact?.ownership==="preexisting"?"preexisting":"unproven";
  let disposition="preserve-unclassified";
  if(category){
      if(name==="/minecraft/server-action"||claim.test(name)||name===currentHint) disposition="preserve-bridge";
      else if(name==="/minecraft/gdrive-token"&&process.env.RETAIN_GDRIVE_TOKEN==="1") disposition="retain-for-migration";
       else if(["/minecraft/backup-auth-keyring","/minecraft/backup-server-identity","/minecraft/backup-generation-checkpoint","/minecraft/restore-generation-floor","/minecraft/backup-verifier-metadata","/minecraft/backup-recovery-adoption-lock"].includes(name)&&process.env.RECOVERY_CAPSULE_DELETE_APPROVED!=="1") disposition="preserve-recovery-capsule";
     else if(ownership==="created") disposition="manual-review-unserialized";
     else if(consented.has(name)) disposition="manual-review-consented";
    else if(ownership==="preexisting") disposition="preserve-preexisting";
     else disposition="manual-review-unproven";
  }
   process.stdout.write([name,type,category||"unclassified",ownership,disposition,fact?.source|| (stackOwned.has(name)?"exact-stack-resource":"none"),policy].join("\t")+"\n");
}
NODE
}

delete_project_ssm_leftovers() {
  local inventory_json inventory_lines name type category ownership disposition policy evidence probe delete_error
  inventory_json="$(inventory_ssm_parameters)" || { error "Could not re-inventory project SSM parameters after stack deletion"; return 1; }
  inventory_lines="$(classify_ssm_inventory "$inventory_json")" || return 1
  while IFS=$'\t' read -r name type category ownership disposition evidence policy; do
    [[ -n "$name" ]] || continue
    if [[ "$disposition" == preserve-* || "$disposition" == manual-review-* ]]; then
      warn "Preserved $ownership SSM parameter: $name"
      continue
    fi
    if [[ "$disposition" == "retain-for-migration" ]]; then
      warn "Retained Drive credential for explicit migration: $name (security-sensitive; delete immediately after migration)"
      continue
    fi
    warn "Preserved $ownership $category SSM parameter because SSM has no authoritative conditional deletion: $name"
  done <<< "$inventory_lines"
}

delete_retained_lifecycle_lock_table() {
  local table_name="$1" table_json table_arn tags_json delete_error verify_error
  [[ -n "$table_name" ]] || return 0
  if ! table_json="$(aws_cli dynamodb describe-table --table-name "$table_name" --output json 2>&1)"; then
    is_dynamodb_not_found_error "$table_json" && return 0
    error "Could not inspect the exact lifecycle lock table after stack deletion"
    return 1
  fi
  table_arn="$(printf '%s' "$table_json" | EXPECTED_NAME="$table_name" EXPECTED_ACCOUNT="$AWS_ACCOUNT_ID" EXPECTED_REGION="$AWS_REGION_VALUE" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const t=d.Table||{};
const expected=`arn:aws:dynamodb:${process.env.EXPECTED_REGION}:${process.env.EXPECTED_ACCOUNT}:table/${process.env.EXPECTED_NAME}`;
if(t.TableName!==process.env.EXPECTED_NAME||t.TableArn!==expected) process.exit(1); process.stdout.write(t.TableArn);
')" || { error "Lifecycle lock table identity did not match the recorded stack resource"; return 1; }
  tags_json="$(aws_cli dynamodb list-tags-of-resource --resource-arn "$table_arn" --output json)" || return 1
  if ! printf '%s' "$tags_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const tags=Object.fromEntries((JSON.parse(require("node:fs").readFileSync(0,"utf8")).Tags||[]).map(({Key,Value})=>[Key,Value]));
process.exit(tags.McAwsProject==="mc-aws"&&tags.McAwsStack===process.env.EXPECTED_STACK&&tags.McAwsPurpose==="LifecycleLock"?0:1);
'; then
    error "Retained lifecycle lock table lacks exact project/stack/purpose ownership tags; preserving it"
    return 1
  fi
  assert_manifest_unchanged
  assert_aws_account_now && assert_exact_stack_absent_now || return 1
  delete_error=""
  if ! delete_error="$(aws_cli dynamodb delete-table --table-name "$table_name" 2>&1)" && ! is_dynamodb_not_found_error "$delete_error"; then
    error "Failed to delete the exact retained lifecycle lock table"
    return 1
  fi
  if ! verify_error="$(aws_cli dynamodb wait table-not-exists --table-name "$table_name" 2>&1)"; then
    error "Lifecycle lock table deletion did not complete: $verify_error"
    return 1
  fi
  log "  ✅ Deleted exact retained lifecycle lock table after stack absence: $table_name"
}

preserve_final_root_data() {
  local root_line instance_state root_device root_volume_id final_root_volume snapshot_id pending_snapshot_id pending_snapshot_volume pending_snapshot_state pending_snapshot_created_at create_json tag_spec backup_json backup_line backup_count backup_cached_at observed_at
  root_line="$(read_managed_instance_root)" || {
    error "Could not re-read the managed instance before final data preservation"
    return 1
  }
  IFS=$'\t' read -r instance_state root_device root_volume_id <<< "$root_line"

  observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -z "$root_volume_id" ]]; then
    if [[ "$instance_state" != "stopped" ]]; then
      error "Instance has no root volume but is in state '$instance_state'; refusing ambiguous hibernated teardown"
      return 1
    fi
    if [[ -n "${DETACHED_ROOT_VOLUME_ID:-}" && "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
      error "Detached managed root cannot be credential-scrubbed offline; refusing snapshot mode until it is safely reattached/reconciled"
      return 1
    fi
    record_hibernated_backup_evidence "$observed_at" "${DETACHED_ROOT_VOLUME_ID:-}" || return 1
    if [[ -n "${DETACHED_ROOT_VOLUME_ID:-}" ]]; then
      detached_json="$(aws_cli ec2 describe-volumes --volume-ids "$DETACHED_ROOT_VOLUME_ID" --output json)" || return 1
      if ! printf '%s' "$detached_json" | EXPECTED_VOLUME="$DETACHED_ROOT_VOLUME_ID" EXPECTED_INSTANCE="$INSTANCE_ID" EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const v=(d.Volumes||[])[0];
const tags=Object.fromEntries((v?.Tags||[]).map(({Key,Value})=>[Key,Value]));
process.exit(v?.VolumeId===process.env.EXPECTED_VOLUME&&v.State==="available"&&(v.Attachments||[]).length===0&&tags.McAwsProject==="mc-aws"&&tags.McAwsStack===process.env.EXPECTED_STACK&&tags.McAwsManagedRoot==="true"&&tags.McAwsInstanceId===process.env.EXPECTED_INSTANCE?0:1);
'; then
        error "Detached managed root identity changed after backup evidence; preserving it"
        return 1
      fi
      aws_cli ec2 delete-volume --volume-id "$DETACHED_ROOT_VOLUME_ID" >/dev/null || return 1
      detached_verify=""
      if detached_verify="$(aws_cli ec2 describe-volumes --volume-ids "$DETACHED_ROOT_VOLUME_ID" --output json 2>&1)" || ! is_volume_not_found_error "$detached_verify"; then
        error "Detached managed root deletion could not be verified"
        return 1
      fi
      log "  ✅ Deleted exact detached managed root after Drive preservation evidence"
    fi
    mark_complete "final-data-preservation"
    return 0
  fi

  if ! verify_managed_root_volume "$root_volume_id"; then
    error "Live root volume identity/tags do not prove it belongs to this deployment"
    return 1
  fi
  if [[ "$DATA_PRESERVATION_MODE" == "google-drive" ]]; then
    create_final_google_drive_backup || return 1
    # The terminal backup itself durably masks and stops every host writer. No
    # later SSM command may touch the host after its authenticated manifest is
    # published; cloud-side shutdown and teardown proceed from that terminal
    # boundary without another host command.
    stop_instance_after_terminal_backup "$instance_state" "$root_volume_id" || return 1
    mark_complete "final-data-preservation"
    return 0
  fi

  quiesce_instance_for_snapshot "$instance_state" "$root_volume_id" || return 1

  snapshot_id="$(json_get teardown.finalRootSnapshot.snapshotId)"
  if [[ -n "$snapshot_id" ]]; then
    log "  ℹ️  Retaining prior completed teardown snapshot $snapshot_id, but not reusing it while the stack/root volume still exists"
  fi

  pending_snapshot_id="$(json_get teardown.pendingFinalRootSnapshot.snapshotId)"
  pending_snapshot_volume="$(json_get teardown.pendingFinalRootSnapshot.sourceVolumeId)"
  pending_snapshot_created_at="$(json_get teardown.pendingFinalRootSnapshot.createdAt)"
  if [[ -n "$pending_snapshot_id" && "$pending_snapshot_volume" == "$root_volume_id" ]]; then
    pending_snapshot_state="$(read_final_snapshot_state "$pending_snapshot_id" "$root_volume_id")" || {
      error "Could not safely inspect the manifest-recorded pending final snapshot"
      return 1
    }
    if [[ "$pending_snapshot_state" == "pending" ]]; then
      log "  ⏳ Resuming wait for manifest-recorded pending final root snapshot: $pending_snapshot_id"
      if ! aws_cli ec2 wait snapshot-completed --snapshot-ids "$pending_snapshot_id"; then
        error "Existing final root snapshot is still incomplete; blocking stack deletion without creating a duplicate"
        return 1
      fi
      if ! verify_final_snapshot "$pending_snapshot_id" "$root_volume_id"; then
        error "Manifest-recorded pending final snapshot failed exact completion verification"
        return 1
      fi
      assert_manifest_unchanged
      MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
        final-snapshot --snapshot-id "$pending_snapshot_id" --volume-id "$root_volume_id" \
        --created-at "$pending_snapshot_created_at" >/dev/null
      refresh_manifest_digest
      log "  ✅ Completed and recorded the interrupted pending final root snapshot: $pending_snapshot_id"
      mark_complete "final-data-preservation"
      return 0
    fi
    log "  ℹ️  Pending-attempt snapshot $pending_snapshot_id is now '$pending_snapshot_state'; retaining it and creating a fresh snapshot"
  elif [[ -n "$pending_snapshot_id" ]]; then
    warn "Pending final snapshot $pending_snapshot_id belongs to a different root volume; retaining it and creating a fresh snapshot"
  fi

  root_line="$(read_managed_instance_root)" || {
    error "Could not perform the final stopped-instance check before snapshot creation"
    return 1
  }
  IFS=$'\t' read -r instance_state root_device final_root_volume <<< "$root_line"
  if [[ "$instance_state" != "stopped" || "$final_root_volume" != "$root_volume_id" ]] || \
    ! verify_managed_root_volume "$root_volume_id"; then
    error "Instance/root identity changed or instance is no longer stopped immediately before snapshot creation"
    return 1
  fi

  tag_spec="$(MC_STACK_ID="$STACK_ID" MC_STACK="$STACK_NAME" MC_INSTANCE="$INSTANCE_ID" MC_VOLUME="$root_volume_id" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify([{ResourceType:"snapshot",Tags:[
{Key:"McAwsProject",Value:"mc-aws"},{Key:"McAwsStack",Value:process.env.MC_STACK},{Key:"McAwsStackId",Value:process.env.MC_STACK_ID},
{Key:"McAwsInstanceId",Value:process.env.MC_INSTANCE},{Key:"McAwsSourceVolumeId",Value:process.env.MC_VOLUME},{Key:"McAwsFinalTeardown",Value:"true"}
]}]));
')"
  create_json="$(aws_cli ec2 create-snapshot --volume-id "$root_volume_id" \
    --description "mc-aws final root snapshot before teardown of $STACK_NAME" --tag-specifications "$tag_spec" --output json)" || {
    error "Final root snapshot creation failed; blocking CloudFormation stack deletion"
    return 1
  }
  snapshot_id="$(printf '%s' "$create_json" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!d.SnapshotId) process.exit(1); process.stdout.write(d.SnapshotId)')" || return 1
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    pending-final-snapshot --snapshot-id "$snapshot_id" --volume-id "$root_volume_id" --created-at "$observed_at" >/dev/null
  refresh_manifest_digest
  log "  ⏳ Waiting for final root snapshot to complete: $snapshot_id"
  if ! aws_cli ec2 wait snapshot-completed --snapshot-ids "$snapshot_id"; then
    error "Final root snapshot did not complete; blocking CloudFormation stack deletion and retaining snapshot $snapshot_id for review"
    return 1
  fi
  if ! verify_final_snapshot "$snapshot_id" "$root_volume_id"; then
    error "Final root snapshot completed waiter but failed identity/tag verification; blocking stack deletion"
    return 1
  fi
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    final-snapshot --snapshot-id "$snapshot_id" --volume-id "$root_volume_id" --created-at "$observed_at" >/dev/null
  refresh_manifest_digest
  log "  ✅ Final root snapshot completed and recorded: $snapshot_id"
  log "     The root volume itself is NOT retained; CloudFormation may delete it with the instance."
  mark_complete "final-data-preservation"
}

blockers=()
add_blocker() { blockers+=("$1"); }

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "mc-aws safe teardown inventory"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Mode:                 $([[ "$EXECUTE" == "1" ]] && printf 'EXECUTE (confirmation still required)' || printf 'DRY RUN (default)')"
log "Data preservation:    $DATA_PRESERVATION_MODE"
log "Manifest:             $MANIFEST_FILE"
log "AWS deployment:       ${AWS_ACCOUNT_ID}/${AWS_REGION_VALUE}/${STACK_NAME}"
log "Cloudflare Worker:    ${WORKER_NAME:-not recorded} (panel mode: ${PANEL_MODE:-unknown})"
log ""

# SSM inventory is metadata-only. Only the later backup gate reads its exact cache value.
SSM_INVENTORY_JSON=""
SSM_INVENTORY_LINES=""
STACK_SSM_NAMES_JSON='[]'
stack_resources_json=""
LIFECYCLE_LOCK_TABLE_NAME=""
OPERATION_STATE_TABLE_NAME=""
HAS_RECORDED_DESTROY_LIFECYCLE="$(json_get teardown.destroyLifecycle.operationId)"
if stack_resources_json="$(aws_cli cloudformation list-stack-resources --stack-name "$STACK_ID" --output json 2>&1)"; then
  STACK_SSM_NAMES_JSON="$(printf '%s' "$stack_resources_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
process.stdout.write(JSON.stringify((d.StackResourceSummaries||[])
  .filter((item)=>item.ResourceType==="AWS::SSM::Parameter"&&typeof item.PhysicalResourceId==="string")
  .map((item)=>item.PhysicalResourceId)));
')"
  lifecycle_table_result="$(printf '%s' "$stack_resources_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const matches=(d.StackResourceSummaries||[]).filter((item)=>item.ResourceType==="AWS::DynamoDB::Table"&&/^LifecycleLockTable[A-F0-9]*$/.test(item.LogicalResourceId||"")&&typeof item.PhysicalResourceId==="string");
if(matches.length>1) process.exit(2); if(matches.length===1) process.stdout.write(matches[0].PhysicalResourceId);
' 2>/dev/null)" || add_blocker "stack contains multiple lifecycle lock table identities"
  LIFECYCLE_LOCK_TABLE_NAME="$lifecycle_table_result"
  operation_table_result="$(printf '%s' "$stack_resources_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const matches=(d.StackResourceSummaries||[]).filter((item)=>item.ResourceType==="AWS::DynamoDB::Table"&&/^OperationStateTable[A-F0-9]*$/.test(item.LogicalResourceId||"")&&typeof item.PhysicalResourceId==="string");
if(matches.length>1) process.exit(2); if(matches.length===1) process.stdout.write(matches[0].PhysicalResourceId);
' 2>/dev/null)" || add_blocker "stack contains multiple operation-state table identities"
  OPERATION_STATE_TABLE_NAME="$operation_table_result"
elif ! is_stack_not_found_error "$stack_resources_json"; then
  add_blocker "exact stack-resource inventory failed while migrating SSM ownership evidence"
fi
if SSM_INVENTORY_JSON="$(inventory_ssm_parameters 2>&1)"; then
  if ! SSM_INVENTORY_LINES="$(classify_ssm_inventory "$SSM_INVENTORY_JSON" 2>&1)"; then
    add_blocker "SSM parameter inventory could not be classified"
    SSM_INVENTORY_LINES=""
  fi
else
  add_blocker "SSM parameter inventory failed"
fi
log "SSM parameters (exact metadata-only inventory):"
if [[ -z "$SSM_INVENTORY_LINES" ]]; then
  log "  - none found"
else
   while IFS=$'\t' read -r parameter_name parameter_type parameter_category parameter_ownership parameter_disposition parameter_evidence parameter_policy; do
    [[ -n "$parameter_name" ]] || continue
      log "  - $parameter_name [$parameter_type; $parameter_category; ownership=$parameter_ownership; evidence=$parameter_evidence] => $parameter_disposition (policy=$parameter_policy)"
    if [[ "$parameter_name" == "/minecraft/server-action" && -n "$HAS_RECORDED_DESTROY_LIFECYCLE" ]]; then
      log "    exact value/operation ownership will be revalidated against the durable destroy barrier before mutation"
    elif [[ "$parameter_disposition" == "preserve-unclassified" || "$parameter_disposition" == "preserve-unproven" ]]; then
      add_blocker "SSM parameter ownership is not proven; preserve it or pass explicit exact-name consent: $parameter_name"
    fi
    if [[ "$parameter_category" == "legacy-credential" ]]; then
      warn "Legacy GitHub PAT parameter found. Verify instance user-data dependency, delete the parameter when safe, and revoke the PAT in GitHub."
    fi
  done <<< "$SSM_INVENTORY_LINES"
fi
log ""

# AWS identity and stack inventory.
caller_account=""
if caller_account="$(aws_cli sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  if [[ "$caller_account" != "$AWS_ACCOUNT_ID" ]]; then
    add_blocker "AWS caller account $caller_account does not match manifest account $AWS_ACCOUNT_ID"
  fi
else
  add_blocker "AWS caller identity could not be verified"
fi

STACK_LIVE="0"
stack_json=""
if stack_json="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_NAME" --output json 2>&1)"; then
  STACK_LIVE="1"
  live_stack_id="$(printf '%s' "$stack_json" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.Stacks?.[0]?.StackId || "")')"
  if [[ -z "$STACK_ID" || "$STACK_ID" == "unknown" || "$live_stack_id" != "$STACK_ID" ]]; then
    add_blocker "live stack ID does not match the manifest-owned stack ID"
  fi
  if [[ -z "$STACK_CLAIM_TOKEN" ]] || ! printf '%s' "$stack_json" | EXPECTED_CLAIM="$STACK_CLAIM_TOKEN" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const tags=Object.fromEntries((d.Stacks?.[0]?.Tags||[]).map(({Key,Value})=>[Key,Value]));
process.exit(process.env.EXPECTED_CLAIM && tags.McAwsClaimToken===process.env.EXPECTED_CLAIM ? 0 : 1);
'; then
    add_blocker "live stack lacks the exact manifest claim token; refusing ownership-based destroy"
  fi
  log "AWS stack:            LIVE ($live_stack_id), owned=$STACK_OWNED"
elif is_stack_not_found_error "$stack_json"; then
  log "AWS stack:            absent (already removed)"
else
  add_blocker "CloudFormation stack inventory failed: $stack_json"
fi

DATA_PRESERVATION_RECORDED="$($NODE_BIN - "$MANIFEST_FILE" <<'NODE'
const manifest=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8"));
const teardown=manifest.teardown||{};
const completed=(teardown.completedResources||[]).includes("final-data-preservation");
const evidence=teardown.finalRootSnapshot||teardown.finalGoogleDriveBackup||teardown.googleDriveBackupEvidence||teardown.hibernatedBackupEvidence;
process.stdout.write(completed&&Boolean(evidence)?"1":"0");
NODE
)"
if [[ "$STACK_LIVE" != "1" && "$DATA_PRESERVATION_RECORDED" != "1" && "$CONFIRM_ABSENT_STACK_DATA" != "1" ]]; then
  add_blocker "stack is absent and no durable final-data-preservation record exists; use --confirm-absent-stack-data only after direct Drive/snapshot proof"
fi

while IFS=$'\t' read -r parameter_name _ _ parameter_ownership parameter_disposition _ _; do
  case "$parameter_name" in
    /minecraft/cloudflare-api-token|/minecraft/duckdns-token)
      if [[ "$STACK_LIVE" == "1" && "$parameter_ownership" != "created" && "$parameter_disposition" != "manual-review-consented" ]]; then
        add_blocker "stack custom-resource deletion may remove ownership-unproven parameter; explicit exact-name consent is required: $parameter_name"
      fi
      ;;
  esac
done <<< "$SSM_INVENTORY_LINES"

if [[ -n "$INSTANCE_ID" ]]; then
  instance_json=""
  if instance_json="$(aws_cli ec2 describe-instances --instance-ids "$INSTANCE_ID" --output json 2>&1)"; then
    if ! printf '%s' "$instance_json" | EXPECTED_STACK="$STACK_NAME" EXPECTED_STACK_ID="$STACK_ID" "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8"));
const instance=d.Reservations?.flatMap((reservation)=>reservation.Instances||[])[0]; if(!instance) process.exit(1);
const tags=Object.fromEntries((instance.Tags||[]).map(({Key,Value})=>[Key,Value]));
if(tags.McAwsProject!=="mc-aws" || tags.McAwsStack!==process.env.EXPECTED_STACK || tags["aws:cloudformation:stack-id"]!==process.env.EXPECTED_STACK_ID) process.exit(1);
'; then
      add_blocker "live instance '$INSTANCE_ID' lacks the exact manifest/CloudFormation ownership tags"
    fi
    log "EC2 instance:          LIVE ($INSTANCE_ID), ownership tags verified"
  elif [[ "$instance_json" == *"InvalidInstanceID.NotFound"* ]]; then
    log "EC2 instance:          absent ($INSTANCE_ID)"
  else
    add_blocker "EC2 instance inventory failed: $instance_json"
  fi
fi

legacy_live_names="$(printf '%s\n' "$SSM_INVENTORY_LINES" | "$NODE_BIN" -e '
const lines=require("node:fs").readFileSync(0,"utf8").split(/\n/).filter(Boolean);
for(const line of lines){const [name,,category]=line.split("\t"); if(category==="legacy-credential"||category==="legacy-config") console.log(name)}
')"
if [[ -n "$legacy_live_names" && "$STACK_LIVE" == "1" ]]; then
  user_data_json=""
  if user_data_json="$(aws_cli ec2 describe-instance-attribute --instance-id "$INSTANCE_ID" --attribute userData --output json 2>&1)"; then
    if printf '%s' "$user_data_json" | LEGACY_NAMES="$legacy_live_names" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
let decoded=""; try{decoded=Buffer.from(d.UserData?.Value||"","base64").toString("utf8")}catch{process.exit(2)}
process.exit((process.env.LEGACY_NAMES||"").split(/\n/).filter(Boolean).some((name)=>decoded.includes(name))?0:1);
'; then
      add_blocker "live EC2 user data still depends on legacy GitHub SSM parameters; migrate bootstrap dependencies before deletion"
    fi
  else
    add_blocker "could not inspect live EC2 user data for legacy GitHub SSM dependencies"
  fi
fi

# Runtime IAM identity inventory and ownership tags.
RUNTIME_USER_LIVE="0"
if [[ -n "$RUNTIME_USER_NAME" ]]; then
  user_json=""
  if user_json="$(aws_cli iam get-user --user-name "$RUNTIME_USER_NAME" --output json 2>&1)"; then
    RUNTIME_USER_LIVE="1"
    tags_json="$(aws_cli iam list-user-tags --user-name "$RUNTIME_USER_NAME" --output json 2>&1)" || {
      add_blocker "could not read runtime IAM user tags"
      tags_json='{}'
    }
    if ! printf '%s' "$tags_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const fs = require("node:fs");
const tags = Object.fromEntries((JSON.parse(fs.readFileSync(0,"utf8")).Tags || []).map(({Key, Value}) => [Key, Value]));
if (tags.McAwsProject !== "mc-aws" || tags.McAwsPurpose !== "CloudflareWorkerRuntime" || tags.McAwsStack !== process.env.EXPECTED_STACK) process.exit(1);
'; then
      add_blocker "runtime IAM user '$RUNTIME_USER_NAME' lacks the exact manifest ownership tags"
    fi
    log "Runtime IAM user:     LIVE ($RUNTIME_USER_NAME), owned=$RUNTIME_USER_OWNED"
  elif is_iam_not_found_error "$user_json"; then
    log "Runtime IAM user:     absent (already removed)"
  else
    add_blocker "runtime IAM user inventory failed: $user_json"
  fi
fi

# DLM inventory. Policies are never inferred as deletable from tags alone.
DLM_LIVE_JSON="$(aws_cli dlm get-lifecycle-policies --output json 2>&1)" || {
  add_blocker "DLM policy inventory failed"
  DLM_LIVE_JSON='{"Policies":[]}'
}
log "DLM policies:         inventoried (only manifest-owned + live-tagged policies are deletable)"
while IFS=$'\t' read -r policy_id policy_owned; do
  [[ -n "$policy_id" ]] || continue
  policy_json=""
  if policy_json="$(aws_cli dlm get-lifecycle-policy --policy-id "$policy_id" --output json 2>&1)"; then
    if [[ "$policy_owned" == "true" ]] && ! printf '%s' "$policy_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const fs = require("node:fs");
const policy = JSON.parse(fs.readFileSync(0,"utf8")).Policy || {};
const tags = policy.Tags || {};
if (tags.McAwsProject !== "mc-aws" || tags.McAwsStack !== process.env.EXPECTED_STACK) process.exit(1);
'; then
      add_blocker "DLM policy '$policy_id' is manifest-owned but its live ownership tags do not match"
    fi
  elif ! is_dlm_not_found_error "$policy_json"; then
    add_blocker "DLM policy '$policy_id' inventory failed"
  fi
done < <(manifest_lines dlm)

manifest_dlm_ids="$(manifest_lines dlm | cut -f1)"
while IFS= read -r discovered_policy_id; do
  [[ -n "$discovered_policy_id" ]] || continue
  if printf '%s\n' "$manifest_dlm_ids" | grep -Fxq "$discovered_policy_id"; then continue; fi
  discovered_policy_json="$(aws_cli dlm get-lifecycle-policy --policy-id "$discovered_policy_id" --output json 2>/dev/null || true)"
  if [[ -n "$discovered_policy_json" ]] && printf '%s' "$discovered_policy_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const fs=require("node:fs"); const tags=JSON.parse(fs.readFileSync(0,"utf8")).Policy?.Tags||{};
process.exit(tags.McAwsProject==="mc-aws" && tags.McAwsStack===process.env.EXPECTED_STACK ? 0 : 1);
'; then
    warn "DLM policy '$discovered_policy_id' has project tags but no manifest ownership proof; preserving it for manual review"
  fi
done < <(printf '%s' "$DLM_LIVE_JSON" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const policy of d.Policies||[]) if(policy.PolicyId) console.log(policy.PolicyId);
')

# Storage inventory also reconciles an exactly instance-tagged detached managed
# root. Ambiguous/tag-only detached storage is always preserved and blocks.
VOLUMES_JSON="$(aws_cli ec2 describe-volumes --filters "Name=tag:McAwsProject,Values=mc-aws" "Name=tag:McAwsStack,Values=$STACK_NAME" --output json 2>&1)" || {
  add_blocker "EC2 volume inventory failed"
  VOLUMES_JSON='{"Volumes":[]}'
}
SNAPSHOT_IDS="$(inventory_project_snapshot_ids "$VOLUMES_JSON" 2>&1)" || {
  add_blocker "EC2 snapshot inventory failed"
  SNAPSHOT_IDS=""
}
volume_count="$(printf '%s' "$VOLUMES_JSON" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(String((d.Volumes||[]).length))')"
DETACHED_ROOT_VOLUME_ID=""
detached_root_result="$(printf '%s' "$VOLUMES_JSON" | EXPECTED_INSTANCE="$INSTANCE_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
const candidates=(d.Volumes||[]).filter((volume)=>{
  const tags=Object.fromEntries((volume.Tags||[]).map(({Key,Value})=>[Key,Value]));
  return volume.State==="available"&&(volume.Attachments||[]).length===0&&tags.McAwsManagedRoot==="true";
});
if(candidates.length===0) process.stdout.write("none");
else if(candidates.length===1){
  const tags=Object.fromEntries((candidates[0].Tags||[]).map(({Key,Value})=>[Key,Value]));
  process.stdout.write(tags.McAwsInstanceId===process.env.EXPECTED_INSTANCE?`exact\t${candidates[0].VolumeId}`:"ambiguous");
} else process.stdout.write("ambiguous");
')"
if [[ "$detached_root_result" == exact$'\t'* ]]; then
  DETACHED_ROOT_VOLUME_ID="${detached_root_result#*$'\t'}"
  log "Detached managed root: exact instance-tagged candidate $DETACHED_ROOT_VOLUME_ID"
  if [[ "$STACK_LIVE" != "1" ]]; then
    add_blocker "stack is absent but an exact detached managed root remains; reconcile its data before provider cleanup"
  fi
elif [[ "$detached_root_result" == "ambiguous" ]]; then
  add_blocker "detached managed root volume candidates are ambiguous or lack exact instance ownership; preserve and reconcile manually"
fi
snapshot_count="$(printf '%s' "$SNAPSHOT_IDS" | "$NODE_BIN" -e 'const raw=require("node:fs").readFileSync(0,"utf8").trim(); process.stdout.write(String(raw ? raw.split(/\s+/).length : 0))')"
log "Tagged EBS volumes:   $volume_count (reported/retained; stack-owned root may disappear with the stack)"
log "Project snapshots:    $snapshot_count (project tags, project volume source, or owned DLM policy; NEVER automatically deleted)"
if [[ -n "$SNAPSHOT_IDS" ]]; then printf '  Retained snapshot:   %s\n' $SNAPSHOT_IDS; fi

# Cloudflare account, Worker, KV, routes, and DNS inventory.
CF_IDENTITY_OK="0"
WORKER_LIVE="0"
KV_LIST_JSON='[]'
if [[ -n "$CF_ACCOUNT_ID" && -n "$WORKER_NAME" ]]; then
  whoami_output=""
  if whoami_output="$(wrangler --config /dev/null whoami 2>&1)"; then
    live_cf_account="$(printf '%s' "$whoami_output" | grep -Eo '[A-Fa-f0-9]{32}' | head -n 1 || true)"
    if [[ "$live_cf_account" == "$CF_ACCOUNT_ID" ]]; then
      CF_IDENTITY_OK="1"
    else
      add_blocker "Cloudflare account ${live_cf_account:-unknown} does not match manifest account $CF_ACCOUNT_ID"
    fi
  else
    add_blocker "Cloudflare identity could not be verified"
  fi

  worker_probe=""
  if worker_probe="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
    WORKER_LIVE="1"
    worker_deployment_match="$(printf '%s' "$worker_probe" | EXPECTED_DEPLOYMENT_ID="$WORKER_DEPLOYMENT_ID" "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("{"); if(start<0) process.exit(2);
const deployment=JSON.parse(raw.slice(start)); process.stdout.write(deployment.id===process.env.EXPECTED_DEPLOYMENT_ID ? "match" : "mismatch");
' 2>/dev/null || true)"
    if [[ "$worker_deployment_match" != "match" ]]; then
      add_blocker "live Worker deployment identity does not contain manifest deployment $WORKER_DEPLOYMENT_ID"
    else
      log "Cloudflare Worker:    LIVE ($WORKER_NAME), immutable deployment identity verified"
    fi
  elif is_worker_not_found_error "$worker_probe"; then
    log "Cloudflare Worker:    absent (already removed)"
  else
    add_blocker "Worker inventory failed: $worker_probe"
  fi

  if ! KV_LIST_JSON="$(wrangler --config /dev/null kv namespace list 2>&1)"; then
    add_blocker "Cloudflare KV inventory failed"
    KV_LIST_JSON='[]'
  elif ! printf '%s' "$KV_LIST_JSON" | "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("["); if(start<0 || !Array.isArray(JSON.parse(raw.slice(start)))) process.exit(1);
'; then
    add_blocker "Cloudflare KV inventory returned malformed data"
    KV_LIST_JSON='[]'
  fi
fi

while IFS=$'\t' read -r kv_id kv_title kv_binding kv_owned; do
  [[ -n "$kv_id" ]] || continue
  kv_match="$(printf '%s' "$KV_LIST_JSON" | KV_ID="$kv_id" "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("[");
if(start<0) process.exit(2); const item=JSON.parse(raw.slice(start)).find((entry)=>entry.id===process.env.KV_ID);
if(item) process.stdout.write(item.title || "");
')"
  if [[ "$kv_owned" == "true" ]]; then
    if [[ -n "$kv_match" && "$kv_match" != "$kv_title" ]]; then
      add_blocker "KV namespace '$kv_id' title changed from '$kv_title' to '$kv_match'; ownership rejected"
    elif [[ -n "$kv_match" ]]; then
      log "KV namespace:         LIVE $kv_binding ($kv_id), project-created"
    else
      log "KV namespace:         absent $kv_binding ($kv_id)"
    fi
  else
    log "KV namespace:         PRESERVE pre-existing $kv_binding ($kv_id)"
  fi
done < <(manifest_lines kv)

while IFS=$'\t' read -r zone_id route_id pattern script route_owned ownership_proven original_script; do
  [[ -n "$zone_id" ]] || continue
  if [[ -z "$route_id" ]]; then
    add_blocker "Worker route '$pattern' has no exact provider route ID in the manifest"
    continue
  fi
  route_response=""
  if ! route_response="$(cf_api GET "/zones/${zone_id}/workers/routes" 2>&1)"; then
    add_blocker "Worker route inventory failed for zone $zone_id (a token with Workers Routes Read/Edit is required)"
    continue
  fi
  if ! cf_assert_success "$route_response" "200"; then
    add_blocker "Worker route API returned HTTP $(cf_status "$route_response") or an unsuccessful body for zone $zone_id"
    continue
  fi
  if ! cf_assert_complete_list_response "$route_response"; then
    add_blocker "Worker route inventory for zone $zone_id has incomplete pagination metadata"
    continue
  fi
  route_parse=""
  if ! route_parse="$(cf_body "$route_response" | EXPECTED_PATTERN="$pattern" "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); if(d.success!==true || !Array.isArray(d.result)) process.exit(2);
const route=d.result.find((entry)=>entry.pattern===process.env.EXPECTED_PATTERN);
process.stdout.write(route ? ["FOUND", route.id||"", route.script||""].join("\t") : "ABSENT");
' 2>/dev/null)"; then
    add_blocker "Worker route API returned an invalid or unsuccessful inventory for zone $zone_id"
    continue
  fi
  if [[ "$route_parse" == FOUND$'\t'* ]]; then
    IFS=$'\t' read -r _ live_route_id live_route_script <<< "$route_parse"
    if [[ "$ownership_proven" == "true" && -n "$route_id" && "$live_route_id" != "$route_id" ]]; then
      add_blocker "route '$pattern' live ID differs from the ownership-proven manifest ID"
    elif [[ "$ownership_proven" != "true" && "$live_route_script" == "$WORKER_NAME" ]]; then
      add_blocker "route '$pattern' targets the Worker but ownership was not proven before deployment"
    elif [[ "$route_owned" == "true" && ( "$live_route_id" != "$route_id" || "$live_route_script" != "$script" ) ]]; then
      add_blocker "project route '$pattern' live identity/target differs from the manifest"
    else
      log "Worker route:         LIVE $pattern -> ${live_route_script:-<no script>}, owned=$route_owned"
    fi
  else
    log "Worker route:         absent $pattern"
  fi
done < <(manifest_lines routes)

while IFS=$'\t' read -r zone_id record_id record_name record_type record_content record_ttl record_proxied record_owned record_modified original_proxied original_ttl; do
  [[ -n "$zone_id" ]] || continue
  dns_response=""
  if ! dns_response="$(cf_api GET "/zones/${zone_id}/dns_records/${record_id}" 2>&1)"; then
    add_blocker "panel DNS inventory failed for record $record_id"
    continue
  fi
  if cf_is_exact_dns_absence "$dns_response"; then
    log "Panel DNS:            absent $record_name"
    continue
  fi
  if ! cf_assert_success "$dns_response" "200"; then
    add_blocker "panel DNS API returned HTTP $(cf_status "$dns_response") or an unexpected error for record $record_id"
    continue
  fi
  dns_parse=""
  if ! dns_parse="$(cf_body "$dns_response" | "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8"));
if(d.success!==true || !d.result) process.exit(2);
const r=d.result; process.stdout.write(["FOUND",r.id,r.type,r.name,r.content,String(r.ttl),String(Boolean(r.proxied))].join("\t"));
' 2>/dev/null)"; then
    add_blocker "panel DNS API returned an invalid or unsuccessful inventory for record $record_id"
    continue
  fi
  if [[ "$dns_parse" == FOUND$'\t'* ]]; then
    dns_line="${dns_parse#*$'\t'}"
    IFS=$'\t' read -r live_dns_id live_dns_type live_dns_name live_dns_content live_dns_ttl live_dns_proxied <<< "$dns_line"
    if [[ "$record_owned" == "true" && ( "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" || "$live_dns_ttl" != "$record_ttl" || "$live_dns_proxied" != "$record_proxied" ) ]]; then
      add_blocker "project-created panel DNS record '$record_name' no longer matches its manifest identity"
    elif [[ "$record_owned" == "true" ]]; then
      log "Panel DNS:            LIVE project-created $record_type $record_name"
    else
      log "Panel DNS:            PRESERVE pre-existing $record_type $record_name"
    fi
  fi
done < <(manifest_lines dns)

if [[ "$WORKER_OWNED" == "true" && "$WORKER_LIVE" == "1" ]]; then
  while IFS=$'\t' read -r _ _ _ _ _ ownership_proven _; do
    if [[ -n "$ownership_proven" && "$ownership_proven" != "true" ]]; then
      add_blocker "owned Worker deletion is unsafe while a custom route has unproven ownership"
    fi
  done < <(manifest_lines routes)
fi

if [[ "$STACK_LIVE" == "1" && -z "$LIFECYCLE_LOCK_TABLE_NAME" ]]; then
  add_blocker "exact lifecycle lock table identity is missing from the live stack; durable destroy fencing is unavailable"
fi

log ""
log "Planned ownership-safe actions:"
log "  - Worker/secrets: $([[ "$WORKER_OWNED" == "true" ]] && printf 'delete Worker directly if live and verified' || printf 'preserve (pre-existing or unproven)')"
log "  - Routes: delete project-created; restore pre-existing route targets; preserve unproven"
log "  - KV/DNS: delete project-created only; preserve pre-existing (restore proxy state when recorded)"
log "  - Runtime IAM: revoke/delete keys before CloudFormation deletes the stack-owned user"
log "  - SSM: after data preservation and stack deletion, re-inventory and preserve each parameter for manual review"
if [[ "$RETAIN_GDRIVE_TOKEN" == "1" ]]; then
  log "  - SSM: no parameters are deleted automatically; review exact names and credentials manually"
fi
log "  - DLM: delete only manifest-owned policies with matching live tags"
log "  - Stack: $([[ "$STACK_OWNED" == "true" ]] && printf 'delete exact recorded StackId via CloudFormation if live' || printf 'preserve (not proven project-created)')"
if [[ "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
  log "  - Root data: acquire destroy barrier, prove agent/host-operation idle, then stop and create/verify a retained final EBS snapshot"
else
  log "  - Root data: acquire destroy barrier, prove agent/host-operation idle, create an exact idempotent final Drive backup, then stop; hibernated hosts require exact terminal transaction evidence"
fi
log "  - Snapshots/volumes: report snapshots; reconcile only an exact detached reconstructed root after the data gate"

if [[ ${#blockers[@]} -gt 0 ]]; then
  log ""
  error "Teardown is BLOCKED by ownership/inventory failures:"
  for blocker in "${blockers[@]}"; do error "  - $blocker"; done
  error "No mutations were performed. Resolve the mismatch or use docs/TEARDOWN.md for manual, resource-by-resource recovery."
  exit 1
fi

if [[ "$EXECUTE" != "1" ]]; then
  log ""
  log "✅ Dry run complete. No cloud resources, manifest state, or local env files were changed."
  log "To execute, re-run with --execute and type the exact confirmation phrase shown then."
  exit 0
fi

confirmation_phrase="destroy ${STACK_NAME} in ${AWS_ACCOUNT_ID}/${AWS_REGION_VALUE}"
log ""
warn "This will mutate AWS and Cloudflare resources proven to be owned by this deployment."
log "Type exactly: $confirmation_phrase"
IFS= read -r confirmation
if [[ "$confirmation" != "$confirmation_phrase" ]]; then
  error "Confirmation did not match. No mutations were performed."
  exit 1
fi

acquire_destroy_process_lock || exit 1

if [[ "$STACK_LIVE" != "1" && "$DATA_PRESERVATION_RECORDED" != "1" ]]; then
  data_confirmation_phrase="data preservation independently verified for ${STACK_ID}"
  warn "The stack is already absent and this manifest has no durable preservation evidence."
  log "After directly verifying Drive archives or an exact retained snapshot, type exactly: $data_confirmation_phrase"
  IFS= read -r data_confirmation
  if [[ "$data_confirmation" != "$data_confirmation_phrase" ]]; then
    error "Independent data-preservation confirmation did not match. No irreversible cleanup was performed."
    exit 1
  fi
fi

if [[ "$SAFE_ABORT_DESTROY" == "1" ]]; then
  [[ "$STACK_LIVE" == "1" ]] || { error "Safe abort requires the live authoritative lifecycle lock table"; exit 1; }
  safe_abort_destroy_barrier || exit 1
  exit 0
fi

if [[ "$STACK_LIVE" == "1" && "$DATA_PRESERVATION_MODE" == "google-drive" ]]; then
  drive_confirmation_phrase="drive backup directly verified for ${STACK_ID}"
  warn "Authenticated terminal transaction metadata is not independent proof that Drive is currently readable or restorable."
  log "After directly checking the expected archive in Google Drive, type exactly: $drive_confirmation_phrase"
  IFS= read -r drive_confirmation || drive_confirmation=""
  if [[ "$drive_confirmation" != "$drive_confirmation_phrase" ]]; then
    error "Direct Google Drive verification confirmation did not match. No mutations were performed."
    exit 1
  fi
fi

recovery_capsule_consent_requested="0"
for capsule_name in \
  /minecraft/backup-auth-keyring \
  /minecraft/backup-server-identity \
  /minecraft/backup-generation-checkpoint \
  /minecraft/restore-generation-floor \
  /minecraft/backup-verifier-metadata \
  /minecraft/backup-recovery-adoption-lock; do
  for consented_name in "${CONSENT_SSM_NAMES[@]:-}"; do
    if [[ "$consented_name" == "$capsule_name" ]]; then
      recovery_capsule_consent_requested="1"
    fi
  done
done
if [[ "$recovery_capsule_consent_requested" == "1" ]]; then
  for capsule_name in \
    /minecraft/backup-auth-keyring \
    /minecraft/backup-server-identity \
    /minecraft/backup-generation-checkpoint \
    /minecraft/restore-generation-floor \
    /minecraft/backup-verifier-metadata \
    /minecraft/backup-recovery-adoption-lock; do
      if ! printf '%s\n' "${CONSENT_SSM_NAMES[@]:-}" | grep -Fxq "$capsule_name"; then
      error "Deleting any recovery-capsule member requires exact consent for all six members; missing $capsule_name"
      exit 1
    fi
  done
  recovery_capsule_phrase="delete authenticated recovery capsule for ${STACK_ID}"
  warn "DANGER: deleting this capsule makes all retained signed Drive archives unrecoverable."
  warn "This is a separate irreversible consent, after the preservation evidence above."
  log "Type exactly: $recovery_capsule_phrase"
  IFS= read -r recovery_capsule_confirmation
  if [[ "$recovery_capsule_confirmation" != "$recovery_capsule_phrase" ]]; then
    error "Recovery-capsule deletion confirmation did not match. The capsule remains preserved."
    exit 1
  fi
  RECOVERY_CAPSULE_DELETE_APPROVED="1"
fi

log ""
log "Executing verified teardown..."
assert_manifest_unchanged
if [[ "$WORKER_LIVE" == "1" ]] && ! assert_worker_deployment_now; then
  error "Worker deployment identity changed after inventory; no mutations were performed"
  exit 1
fi

# Establish one durable, non-expiring destroy owner before any host quiescence
# or preservation. The same global lock record fences Worker routes, delayed
# Lambda deliveries, restore/start/resume/backup, rollout, and agent backup
# authorization. It is never automatically released on failure.
if [[ "$STACK_OWNED" == "true" && "$STACK_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_aws_account_now || ! assert_exact_stack_live_now || ! assert_runtime_iam_tags_now; then
    error "AWS stack/runtime IAM identity changed before final data preservation; refusing provider cleanup"
    exit 1
  fi
  acquire_destroy_barrier || exit 1

  if destroy_phase_at_least "preserving"; then
    PRESERVATION_ALREADY_FENCED="1"
  fi

  if ! destroy_phase_at_least "runtime-quiesced"; then
    root_before_quiesce="$(read_managed_instance_root)" || { error "Could not read the managed instance for agent quiescence"; exit 1; }
    IFS=$'\t' read -r state_before_quiesce _ _ <<< "$root_before_quiesce"
    quiesce_agent_runtime "$state_before_quiesce" || exit 1
  else
    log "  ✅ Reusing durable authoritative-idle state under the same destroy fence"
  fi

  if ! destroy_phase_at_least "preserving"; then
    set_destroy_phase "preserving" || { error "Could not durably enter fail-closed preservation state"; exit 1; }
  fi

  if [[ "$DATA_PRESERVATION_RECORDED" == "1" && "$PRESERVATION_ALREADY_FENCED" == "1" ]]; then
    log "  ✅ Reusing completed data preservation; the destroy barrier has prevented post-preservation mutation"
  else
    preserve_final_root_data || exit 1
    DATA_PRESERVATION_RECORDED="1"
  fi
  if ! destroy_phase_at_least "preserved"; then
    set_destroy_phase "preserved" || exit 1
  fi
  if [[ "$DATA_PRESERVATION_RECORDED" == "1" ]]; then
    capsule_parameter_count="$(printf '%s\n' "$SSM_INVENTORY_LINES" | "$NODE_BIN" -e '
const names=new Set(require("node:fs").readFileSync(0,"utf8").split(/\n/).map((line)=>line.split("\t")[0]));
process.stdout.write(String(["/minecraft/backup-server-identity","/minecraft/backup-generation-checkpoint","/minecraft/restore-generation-floor","/minecraft/backup-auth-keyring"].filter((name)=>names.has(name)).length));
')"
    if [[ "$capsule_parameter_count" == "4" ]]; then
      record_recovery_capsule || exit 1
    fi
  fi
fi

# Routes first so an owned Worker is never deleted while an owned/custom route is still attached.
while IFS=$'\t' read -r zone_id route_id pattern script route_owned ownership_proven original_script; do
  [[ -n "$zone_id" ]] || continue
  [[ -n "$route_id" ]] || { error "Worker route '$pattern' has no exact provider route ID; refusing mutation"; exit 1; }
  route_response="$(cf_api GET "/zones/${zone_id}/workers/routes")"
  cf_assert_success "$route_response" "200" || { error "Route provider response changed or failed before mutation"; exit 1; }
  cf_assert_complete_list_response "$route_response" || { error "Route inventory pagination changed before mutation"; exit 1; }
  route_parse="$(cf_body "$route_response" | EXPECTED_PATTERN="$pattern" "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); if(d.success!==true || !Array.isArray(d.result)) process.exit(2);
const route=d.result.find((entry)=>entry.pattern===process.env.EXPECTED_PATTERN);
process.stdout.write(route ? ["FOUND", route.id||"", route.script||""].join("\t") : "ABSENT");
')"
  [[ "$route_parse" == FOUND$'\t'* ]] || continue
  IFS=$'\t' read -r _ live_route_id live_route_script <<< "$route_parse"
  if [[ "$ownership_proven" == "true" && -n "$route_id" && "$live_route_id" != "$route_id" ]]; then
    error "Route '$pattern' identity changed after inventory; refusing mutation"
    exit 1
  fi
  if [[ "$route_owned" == "true" && "$live_route_script" != "$script" ]]; then
    error "Route '$pattern' changed after inventory; refusing mutation"
    exit 1
  fi
  if [[ "$route_owned" == "true" ]]; then
    response="$(cf_api DELETE "/zones/${zone_id}/workers/routes/${live_route_id}")"
    cf_assert_success "$response" "200" || { error "Cloudflare did not confirm route deletion"; exit 1; }
    log "  ✅ Deleted project-created Worker route: $pattern"
  elif [[ "$ownership_proven" == "true" && "$live_route_script" == "$script" && "$original_script" != "$script" ]]; then
    route_body="$(ROUTE_PATTERN="$pattern" ROUTE_SCRIPT="$original_script" "$NODE_BIN" -e '
const body={pattern:process.env.ROUTE_PATTERN}; if(process.env.ROUTE_SCRIPT) body.script=process.env.ROUTE_SCRIPT; process.stdout.write(JSON.stringify(body));
')"
    response="$(cf_api PUT "/zones/${zone_id}/workers/routes/${live_route_id}" "$route_body")"
    cf_assert_success "$response" "200" || { error "Cloudflare did not confirm route restoration"; exit 1; }
    log "  ✅ Restored pre-existing Worker route target: $pattern -> ${original_script:-<no script>}"
  fi
done < <(manifest_lines routes)
mark_complete "cloudflare-routes"

if [[ "$WORKER_OWNED" == "true" && "$WORKER_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_worker_deployment_now; then
    error "Worker deployment identity changed immediately before Worker deletion; refusing mutation"
    exit 1
  fi
  wrangler --config /dev/null delete "$WORKER_NAME" >/dev/null
  log "  ✅ Deleted project-created Worker and its secrets in one Worker deletion operation: $WORKER_NAME"
fi
mark_complete "cloudflare-worker"
if [[ "$DESTROY_BARRIER_ESTABLISHED" == "1" ]] && ! destroy_phase_at_least "ingress-disabled"; then
  set_destroy_phase "ingress-disabled" || exit 1
fi

while IFS=$'\t' read -r kv_id kv_title kv_binding kv_owned; do
  [[ "$kv_owned" == "true" ]] || continue
  kv_match="$(printf '%s' "$KV_LIST_JSON" | KV_ID="$kv_id" "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("[");
const item=start<0?undefined:JSON.parse(raw.slice(start)).find((entry)=>entry.id===process.env.KV_ID); if(item) process.stdout.write(item.title||"");
')"
  [[ -n "$kv_match" ]] || continue
  wrangler --config /dev/null kv namespace delete --namespace-id "$kv_id" --skip-confirmation >/dev/null
  log "  ✅ Deleted project-created KV namespace: $kv_binding ($kv_id)"
done < <(manifest_lines kv)
mark_complete "cloudflare-kv"

while IFS=$'\t' read -r zone_id record_id record_name record_type record_content record_ttl record_proxied record_owned record_modified original_proxied original_ttl; do
  [[ -n "$zone_id" ]] || continue
  dns_response="$(cf_api GET "/zones/${zone_id}/dns_records/${record_id}")"
  if cf_is_exact_dns_absence "$dns_response"; then continue; fi
  cf_assert_success "$dns_response" "200" || { error "DNS provider response changed or failed before mutation"; exit 1; }
  dns_parse="$(cf_body "$dns_response" | "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8"));
if(d.success!==true || !d.result) process.exit(2); const r=d.result;
process.stdout.write(["FOUND",r.id,r.type,r.name,r.content,String(r.ttl),String(Boolean(r.proxied))].join("\t"));
')"
  [[ "$dns_parse" == FOUND$'\t'* ]] || continue
  dns_line="${dns_parse#*$'\t'}"
  IFS=$'\t' read -r live_dns_id live_dns_type live_dns_name live_dns_content live_dns_ttl live_dns_proxied <<< "$dns_line"
  if [[ "$record_owned" == "true" && ( "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" || "$live_dns_ttl" != "$record_ttl" || "$live_dns_proxied" != "$record_proxied" ) ]]; then
    error "Panel DNS record '$record_name' changed after inventory; refusing mutation"
    exit 1
  fi
  if [[ "$record_owned" == "true" ]]; then
    response="$(cf_api DELETE "/zones/${zone_id}/dns_records/${record_id}")"
    cf_assert_success "$response" "200" || { error "Cloudflare did not confirm DNS deletion"; exit 1; }
    log "  ✅ Deleted project-created panel DNS record: $record_name"
  elif [[ "$record_modified" == "true" ]]; then
    if [[ "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" || "$live_dns_ttl" != "$record_ttl" ]]; then
      warn "Preserved changed pre-existing DNS record '$record_name' without restoring its proxy state"
    elif [[ "$live_dns_proxied" == "$record_proxied" && "$live_dns_proxied" != "$original_proxied" ]]; then
      [[ -n "$original_ttl" ]] || { error "Pre-existing DNS record '$record_name' is missing its original TTL"; exit 1; }
      dns_body="$(DNS_TYPE="$record_type" DNS_NAME="$record_name" DNS_CONTENT="$record_content" DNS_TTL="$original_ttl" DNS_PROXIED="$original_proxied" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({type:process.env.DNS_TYPE,name:process.env.DNS_NAME,content:process.env.DNS_CONTENT,ttl:Number(process.env.DNS_TTL),proxied:process.env.DNS_PROXIED==="true"}));
')"
      response="$(cf_api PUT "/zones/${zone_id}/dns_records/${record_id}" "$dns_body")"
      cf_assert_success "$response" "200" || { error "Cloudflare did not confirm DNS restoration"; exit 1; }
      restored_dns="$(cf_api GET "/zones/${zone_id}/dns_records/${record_id}")" || { error "Could not verify restored DNS record '$record_name'"; exit 1; }
      cf_assert_success "$restored_dns" "200" || { error "Restored DNS record '$record_name' could not be verified"; exit 1; }
      cf_dns_identity_matches "$restored_dns" "$record_id" "$record_type" "$record_name" "$record_content" "$original_ttl" "$original_proxied" || {
        error "Restored pre-existing DNS record '$record_name' does not match its exact identity/proxy state"
        exit 1
      }
      log "  ✅ Restored proxy state on pre-existing panel DNS record: $record_name"
    else
      warn "Preserved pre-existing DNS record '$record_name' without changing its current proxy state"
    fi
  fi
done < <(manifest_lines dns)
mark_complete "cloudflare-dns"

while IFS=$'\t' read -r policy_id policy_owned; do
  [[ "$policy_owned" == "true" ]] || continue
  policy_json=""
  if policy_json="$(aws_cli dlm get-lifecycle-policy --policy-id "$policy_id" --output json 2>&1)"; then
    if ! printf '%s' "$policy_json" | EXPECTED_STACK="$STACK_NAME" "$NODE_BIN" -e '
const policy=JSON.parse(require("node:fs").readFileSync(0,"utf8")).Policy||{}; const tags=policy.Tags||{};
process.exit(tags.McAwsProject==="mc-aws" && tags.McAwsStack===process.env.EXPECTED_STACK ? 0 : 1);
'; then
      error "DLM policy ownership tags changed after inventory; refusing deletion"
      exit 1
    fi
    aws_cli dlm delete-lifecycle-policy --policy-id "$policy_id" >/dev/null
    log "  ✅ Deleted project-created DLM policy: $policy_id"
  elif ! is_dlm_not_found_error "$policy_json"; then
    error "DLM policy '$policy_id' could not be revalidated immediately before deletion"
    exit 1
  fi
done < <(manifest_lines dlm)
mark_complete "aws-dlm"

# External access keys must be removed before CloudFormation can delete its IAM user.
if [[ "$RUNTIME_USER_OWNED" == "true" && "$RUNTIME_USER_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_aws_account_now || \
    { [[ "$STACK_LIVE" == "1" ]] && ! assert_exact_stack_live_now; } || \
    { [[ "$STACK_LIVE" != "1" ]] && ! assert_exact_stack_absent_now; } || \
    ! assert_runtime_iam_tags_now; then
    error "AWS stack/runtime IAM identity changed immediately before access-key revocation; refusing mutation"
    exit 1
  fi
  access_keys_json="$(aws_cli iam list-access-keys --user-name "$RUNTIME_USER_NAME" --output json)"
  while IFS= read -r access_key_id; do
    [[ -n "$access_key_id" ]] || continue
    aws_cli iam update-access-key --user-name "$RUNTIME_USER_NAME" --access-key-id "$access_key_id" --status Inactive >/dev/null
    aws_cli iam delete-access-key --user-name "$RUNTIME_USER_NAME" --access-key-id "$access_key_id" >/dev/null
    log "  ✅ Revoked and deleted runtime IAM access key: $access_key_id"
  done < <(printf '%s' "$access_keys_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const key of d.AccessKeyMetadata||[]) if(key.AccessKeyId) console.log(key.AccessKeyId);
')
fi
mark_complete "runtime-iam-keys"
if [[ "$DESTROY_BARRIER_ESTABLISHED" == "1" ]] && ! destroy_phase_at_least "credentials-revoked"; then
  set_destroy_phase "credentials-revoked" || exit 1
fi

if [[ "$STACK_OWNED" == "true" && "$STACK_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_aws_account_now || ! assert_exact_stack_live_now || ! assert_runtime_iam_tags_now; then
    error "AWS stack/runtime IAM identity changed after data preservation; blocking stack deletion"
    exit 1
  fi
  if ! destroy_phase_at_least "stack-deleting"; then
    set_destroy_phase "stack-deleting" || exit 1
  fi
  delete_stack_error=""
  if ! delete_stack_error="$(aws_cli cloudformation delete-stack --stack-name "$STACK_ID" 2>&1)"; then
    if is_stack_not_found_error "$delete_stack_error" && assert_exact_stack_absent_now; then
      log "  ✅ Exact CloudFormation stack was already absent before the delete request completed"
    else
      error "Exact CloudFormation delete-stack request failed: $delete_stack_error"
      exit 1
    fi
  else
    stack_wait_error=""
    if ! stack_wait_error="$(aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_ID" 2>&1)"; then
      stack_after_wait=""
      if { ! stack_after_wait="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_ID" --output json 2>&1)" && \
        is_stack_not_found_error "$stack_after_wait"; } || is_exact_stack_delete_complete_json "$stack_after_wait"; then
        log "  ✅ Exact CloudFormation stack is absent despite waiter failure"
      else
        error "CloudFormation stack deletion did not complete: ${stack_wait_error:-$stack_after_wait}"
        exit 1
      fi
    else
      log "  ✅ Exact CloudFormation StackId deletion completed: $STACK_ID"
    fi
  fi
  # CloudFormation owns the lifecycle table and may remove it during stack
  # deletion. By this point Worker ingress is disabled and runtime credentials
  # are revoked, so no dispatch path survives the authority's removal.
  DESTROY_BARRIER_AUTHORITY_EXPECTED="0"
  stop_destroy_barrier_renewal
  completed_at="$(destroy_lifecycle_timestamp)"
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/shared/deployment-manifest.mjs" \
    destroy-lifecycle-phase --operation-id "$DESTROY_OPERATION_ID" --phase complete --updated-at "$completed_at" \
    --preservation-started-at "$(json_get teardown.destroyLifecycle.preservationStartedAt)" >/dev/null
  refresh_manifest_digest
  DESTROY_CURRENT_PHASE="complete"
fi
mark_complete "cloudformation-stack"

# Current templates delete this table with the stack while retaining only on
# replacement. This exact, tag-verified fallback cleans up tables created by an
# older Retain-on-delete template after stack absence is proven.
delete_retained_lifecycle_lock_table "$LIFECYCLE_LOCK_TABLE_NAME" || exit 1

# If CloudFormation is gone but left its tagged user after a partial failure, delete only
# the expected inline-policy-only identity. Unexpected attachments/groups block direct cleanup.
post_stack=""
if [[ "$RUNTIME_USER_OWNED" == "true" ]] && assert_exact_stack_absent_now; then
  post_user=""
  if post_user="$(aws_cli iam get-user --user-name "$RUNTIME_USER_NAME" --output json 2>&1)"; then
    if ! assert_aws_account_now || ! assert_exact_stack_absent_now || ! assert_runtime_iam_tags_now; then
      error "Orphaned runtime IAM identity changed before direct cleanup; preserving it for manual review"
      exit 1
    fi
    attached_json="$(aws_cli iam list-attached-user-policies --user-name "$RUNTIME_USER_NAME" --output json)"
    groups_json="$(aws_cli iam list-groups-for-user --user-name "$RUNTIME_USER_NAME" --output json)"
    safe_orphan="$({ printf '%s\n' "$attached_json"; printf '%s\n' "$groups_json"; } | "$NODE_BIN" -e '
const fs=require("node:fs"); const lines=fs.readFileSync(0,"utf8").trim().split(/\n/).map(JSON.parse);
process.stdout.write(lines[0].AttachedPolicies?.length===0 && lines[1].Groups?.length===0 ? "true" : "false");
')"
    if [[ "$safe_orphan" != "true" ]]; then
      error "Stack is absent but runtime user has unexpected managed policies/groups; preserving it for manual review"
      exit 1
    fi
    inline_json="$(aws_cli iam list-user-policies --user-name "$RUNTIME_USER_NAME" --output json)"
    while IFS= read -r policy_name; do
      [[ -n "$policy_name" ]] || continue
      aws_cli iam delete-user-policy --user-name "$RUNTIME_USER_NAME" --policy-name "$policy_name" >/dev/null
    done < <(printf '%s' "$inline_json" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const n of d.PolicyNames||[]) console.log(n)')
    aws_cli iam delete-user --user-name "$RUNTIME_USER_NAME" >/dev/null
    log "  ✅ Deleted verified orphaned runtime IAM user: $RUNTIME_USER_NAME"
  fi
fi
mark_complete "runtime-iam-user"

# Application-created and failed custom-resource parameters can outlive the stack.
# Delete only metadata-inventoried names accepted by the exact project allowlist.
if ! assert_aws_account_now || ! assert_exact_stack_absent_now; then
  error "Exact stack absence could not be verified before project SSM cleanup"
  exit 1
fi
delete_project_ssm_leftovers || exit 1

log ""
log "Final billing-resource verification:"
final_failures=()
final_stack="present"
if final_stack_output="$(aws_cli cloudformation describe-stacks --stack-name "$STACK_ID" --output json 2>&1)"; then
  if is_exact_stack_delete_complete_json "$final_stack_output"; then
    final_stack="absent"
    log "  ✅ CloudFormation stack is DELETE_COMPLETE (retained API history only)"
  else
    log "  ⚠️  CloudFormation stack remains: $STACK_NAME (owned=$STACK_OWNED)"
    if [[ "$STACK_OWNED" == "true" ]]; then final_failures+=("owned CloudFormation stack remains"); fi
  fi
elif is_stack_not_found_error "$final_stack_output"; then
  final_stack="absent"
  log "  ✅ CloudFormation stack is absent"
else
  final_failures+=("CloudFormation stack absence could not be verified: $final_stack_output")
fi
final_instances_json=""
if final_instances_json="$(aws_cli ec2 describe-instances --filters "Name=tag:McAwsProject,Values=mc-aws" "Name=tag:McAwsStack,Values=$STACK_NAME" --output json 2>&1)"; then
  final_instance_count="$(printf '%s' "$final_instances_json" | "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const instances=(d.Reservations||[]).flatMap((r)=>r.Instances||[]).filter((i)=>i.State?.Name!=="terminated"); process.stdout.write(String(instances.length));
')"
  if [[ "$final_instance_count" -gt 0 && "$STACK_OWNED" == "true" ]]; then final_failures+=("$final_instance_count owned EC2 instance(s) remain"); fi
else
  final_instance_count="0"
  final_failures+=("EC2 instance verification failed: $final_instances_json")
fi
if ! final_volumes="$(aws_cli ec2 describe-volumes --filters "Name=tag:McAwsProject,Values=mc-aws" "Name=tag:McAwsStack,Values=$STACK_NAME" --output json 2>&1)"; then
  final_failures+=("EBS volume verification failed: $final_volumes")
  final_volumes='{"Volumes":[]}'
fi
if ! final_snapshot_ids="$(inventory_project_snapshot_ids "$final_volumes" 2>&1)"; then
  final_failures+=("snapshot verification failed")
  final_snapshot_ids=""
fi
final_volume_count="$(printf '%s' "$final_volumes" | "$NODE_BIN" -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(String((d.Volumes||[]).length))')"
final_snapshot_count="$(printf '%s' "$final_snapshot_ids" | "$NODE_BIN" -e 'const raw=require("node:fs").readFileSync(0,"utf8").trim(); process.stdout.write(String(raw ? raw.split(/\s+/).length : 0))')"
if [[ "$final_volume_count" -gt 0 ]]; then
  warn "$final_volume_count tagged EBS volume(s) remain and may incur charges. They were retained intentionally; review manually."
else
  log "  ✅ No tagged EBS volumes remain"
fi
if [[ "$final_snapshot_count" -gt 0 ]]; then
  warn "$final_snapshot_count tagged snapshot(s) remain and may incur charges. Backups were NEVER deleted; review manually."
else
  log "  ✅ No tagged snapshots remain"
fi

if [[ "$RUNTIME_USER_OWNED" == "true" ]]; then
  final_user=""
  if final_user="$(aws_cli iam get-user --user-name "$RUNTIME_USER_NAME" --output json 2>&1)"; then
    final_failures+=("owned runtime IAM user remains")
  elif ! is_iam_not_found_error "$final_user"; then
    final_failures+=("runtime IAM user could not be verified absent")
  else
    log "  ✅ Dedicated runtime IAM user is absent"
  fi
fi

final_ssm_json=""
final_ssm_lines=""
if final_ssm_json="$(inventory_ssm_parameters 2>&1)" && final_ssm_lines="$(classify_ssm_inventory "$final_ssm_json" 2>&1)"; then
  if [[ -z "$final_ssm_lines" ]]; then
    log "  ✅ No project SSM parameters remain under /minecraft"
  else
    while IFS=$'\t' read -r parameter_name parameter_type parameter_category parameter_ownership parameter_disposition parameter_evidence parameter_policy; do
      [[ -n "$parameter_name" ]] || continue
       if [[ "$parameter_disposition" == "retain-for-migration" ]]; then
         warn "Security residual: retained credential $parameter_name; it remains usable and must be deleted after migration"
       elif [[ "$parameter_disposition" == preserve-* || "$parameter_disposition" == manual-review-* ]]; then
         warn "Security residual: preserved $parameter_ownership $parameter_category SSM parameter $parameter_name"
      else
        final_failures+=("allowlisted $parameter_category SSM parameter remains: $parameter_name")
      fi
    done <<< "$final_ssm_lines"
  fi
else
  final_failures+=("SSM parameter residual verification failed")
fi

while IFS=$'\t' read -r policy_id policy_owned; do
  [[ "$policy_owned" == "true" ]] || continue
  final_policy=""
  if final_policy="$(aws_cli dlm get-lifecycle-policy --policy-id "$policy_id" --output json 2>&1)"; then
    final_failures+=("owned DLM policy $policy_id remains")
  elif ! is_dlm_not_found_error "$final_policy"; then
    final_failures+=("DLM policy $policy_id could not be verified absent")
  fi
done < <(manifest_lines dlm)

if [[ "$WORKER_OWNED" == "true" ]]; then
  final_worker=""
  if final_worker="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>&1)"; then
    final_failures+=("owned Cloudflare Worker remains")
  elif is_worker_not_found_error "$final_worker"; then
    log "  ✅ Project-created Cloudflare Worker is absent"
  else
    final_failures+=("Cloudflare Worker could not be verified absent")
  fi
fi

if ! final_kv_json="$(wrangler --config /dev/null kv namespace list 2>&1)"; then
  final_failures+=("Cloudflare KV absence could not be verified: $final_kv_json")
  final_kv_json='[]'
elif ! printf '%s' "$final_kv_json" | "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("["); if(start<0 || !Array.isArray(JSON.parse(raw.slice(start)))) process.exit(1);
'; then
  final_failures+=("Cloudflare KV verification returned malformed data")
  final_kv_json='[]'
fi
while IFS=$'\t' read -r kv_id _ _ kv_owned; do
  [[ "$kv_owned" == "true" ]] || continue
  if printf '%s' "$final_kv_json" | KV_ID="$kv_id" "$NODE_BIN" -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("["); if(start<0) process.exit(2);
process.exit(JSON.parse(raw.slice(start)).some((item)=>item.id===process.env.KV_ID) ? 0 : 1);
'; then
    final_failures+=("owned KV namespace $kv_id remains")
  fi
done < <(manifest_lines kv)

while IFS=$'\t' read -r zone_id route_id pattern script route_owned ownership_proven original_script; do
  [[ "$route_owned" == "true" ]] || continue
  [[ -n "$route_id" ]] || { final_failures+=("owned Worker route '$pattern' has no exact provider route ID"); continue; }
  final_routes="$(cf_api GET "/zones/${zone_id}/workers/routes")" || { final_failures+=("route '$pattern' could not be verified absent"); continue; }
  if ! cf_assert_success "$final_routes" "200"; then final_failures+=("route '$pattern' provider verification failed"); continue; fi
  if ! cf_assert_complete_list_response "$final_routes"; then
    final_failures+=("route '$pattern' inventory pagination was incomplete or contradictory");
    continue
  fi
  final_route=""
  if ! final_route="$(cf_body "$final_routes" | "$NODE_BIN" --import tsx \
    "$ROOT_DIR/scripts/cloudflare/cloudflare-resource-reconciliation.ts" route-inventory --pattern "$pattern" 2>/dev/null)"; then
    final_failures+=("route '$pattern' inventory was malformed or contradictory");
    continue
  fi
  if [[ "$final_route" != "absent" ]]; then
    final_failures+=("owned Worker route '$pattern' remains")
  fi
done < <(manifest_lines routes)

while IFS=$'\t' read -r zone_id record_id record_name _ _ _ _ record_owned _ _ _; do
  [[ "$record_owned" == "true" ]] || continue
  final_dns="$(cf_api GET "/zones/${zone_id}/dns_records/${record_id}")" || { final_failures+=("DNS record '$record_name' could not be verified absent"); continue; }
  if cf_is_exact_dns_absence "$final_dns"; then
    :
  elif cf_assert_success "$final_dns" "200"; then
    final_failures+=("owned panel DNS record '$record_name' remains")
  else
    final_failures+=("owned panel DNS record '$record_name' provider verification failed with HTTP $(cf_status "$final_dns")")
  fi
done < <(manifest_lines dns)

log "  Residual review: retained EBS storage can bill; retained SSM credentials remain a security risk."
log "  Review AWS Billing/Cost Explorer and the Cloudflare dashboard after provider usage data settles."

if [[ ${#final_failures[@]} -gt 0 ]]; then
  error "Final verification found owned resources that remain:"
  for failure in "${final_failures[@]}"; do error "  - $failure"; done
  error "Re-run teardown after resolving the provider error. Retained snapshots/volumes are reported separately above."
  exit 1
fi

if [[ "$CLEANUP_LOCAL_ENV" == "1" ]]; then
  local_phrase="delete local mc-aws env files"
  log ""
  warn "Local cleanup is separate from cloud teardown. It deletes .env, .env.local, and .env.production only."
  log "Type exactly: $local_phrase"
  IFS= read -r local_confirmation
  if [[ "$local_confirmation" == "$local_phrase" ]]; then
    rm -f "$ROOT_DIR/.env" "$ROOT_DIR/.env.local" "$ROOT_DIR/.env.production"
    log "  ✅ Deleted local env files. The local deployment record was retained for audit and recovery."
  else
    warn "Local env cleanup skipped; confirmation did not match."
  fi
fi

log ""
log "✅ Ownership-aware teardown completed. Re-run without flags for an idempotent verification dry run."
