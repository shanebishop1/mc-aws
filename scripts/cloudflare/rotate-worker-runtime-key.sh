#!/usr/bin/env bash

# Safely provision or rotate the dedicated Cloudflare Worker AWS runtime key.
# Human/deployment credentials are used only by the local AWS CLI. The newly
# created runtime secret is held in process memory and piped directly to Wrangler.

set -euo pipefail

AWS_CLI="${AWS_CLI:-aws}"
WRANGLER_BIN="${WRANGLER_BIN:-./node_modules/.bin/wrangler}"
CURL_BIN="${CURL_BIN:-curl}"
VERIFY_MAX_ATTEMPTS="${VERIFY_MAX_ATTEMPTS:-8}"
VERIFY_RETRY_DELAY_SECONDS="${VERIFY_RETRY_DELAY_SECONDS:-12}"
VERIFY_REQUEST_TIMEOUT_SECONDS="${VERIFY_REQUEST_TIMEOUT_SECONDS:-5}"
STACK_NAME="${STACK_NAME:-MinecraftStack}"
AWS_REGION_VALUE="${AWS_REGION:-${AWS_DEFAULT_REGION:-${CDK_DEFAULT_REGION:-}}}"
WRANGLER_CONFIG_FILE="${WRANGLER_CONFIG_FILE:-/dev/null}"
WRANGLER_SOURCE_CONFIG_FILE="${WRANGLER_SOURCE_CONFIG_FILE:-wrangler.jsonc}"
WRANGLER_HOME_DIR="${WRANGLER_HOME_DIR:-$HOME}"
CLOUDFLARE_DEPLOY_API_TOKEN="${CLOUDFLARE_DEPLOY_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
ROTATION_MODE="${ROTATION_MODE:-full}"
RECOVERY_RECORD_FILE="${MC_AWS_CLOUDFLARE_RECOVERY_RECORD:-}"

NEW_ACCESS_KEY_ID=""
NEW_SECRET_ACCESS_KEY=""
PROBE_TOKEN=""
PROMOTED="0"
ROTATION_COMPLETE="0"
PRIOR_KEYS_REVOKED="0"
VERIFY_RESPONSE_FILE=""
prior_key_ids=()

log_error() {
  echo "❌ Error: $*" >&2
}

require_command() {
  local command_path="$1"
  if [[ "$command_path" == */* ]]; then
    [[ -x "$command_path" ]] || { log_error "Required executable not found: $command_path"; exit 1; }
    return
  fi

  command -v "$command_path" >/dev/null 2>&1 || { log_error "Required command not found: $command_path"; exit 1; }
}

aws_cli() {
  if [[ -n "$AWS_REGION_VALUE" ]]; then
    AWS_PAGER="" "$AWS_CLI" --region "$AWS_REGION_VALUE" "$@"
  else
    AWS_PAGER="" "$AWS_CLI" "$@"
  fi
}

wrangler() {
  env -i \
    PATH="$PATH" \
    HOME="$WRANGLER_HOME_DIR" \
    TERM="${TERM:-}" \
    USER="${USER:-}" \
    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN" \
    "$WRANGLER_BIN" "$@"
}

resolve_worker_name() {
  if [[ -n "${WORKER_NAME:-}" ]]; then
    printf '%s\n' "$WORKER_NAME"
    return
  fi

  pnpm exec tsx scripts/cloudflare/wrangler-config.ts worker-name "$WRANGLER_SOURCE_CONFIG_FILE"
}

resolve_runtime_user_name() {
  if [[ -n "${RUNTIME_IAM_USER_NAME:-}" ]]; then
    printf '%s\n' "$RUNTIME_IAM_USER_NAME"
    return
  fi

  aws_cli cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='WorkerRuntimeIamUserName'].OutputValue | [0]" \
    --output text
}

assert_runtime_identity_tags() {
  local user_name="$1"
  if [[ "${SKIP_RUNTIME_IDENTITY_TAG_CHECK:-0}" == "1" ]]; then
    return
  fi

  local tags_json
  tags_json="$(aws_cli iam list-user-tags --user-name "$user_name" --output json)"
  if ! printf '%s' "$tags_json" | node -e '
const fs = require("node:fs");
const tags = Object.fromEntries((JSON.parse(fs.readFileSync(0, "utf8")).Tags || []).map(({ Key, Value }) => [Key, Value]));
if (tags.McAwsProject !== "mc-aws" || tags.McAwsPurpose !== "CloudflareWorkerRuntime") process.exit(1);
'; then
    log_error "IAM user '$user_name' is not tagged as the mc-aws Cloudflare Worker runtime identity"
    log_error "Refusing to create or upload keys for an unverified identity."
    exit 1
  fi
}

list_access_keys() {
  local user_name="$1"
  aws_cli iam list-access-keys --user-name "$user_name" --output json
}

key_ids_with_status() {
  local status="$1"
  node -e '
const fs = require("node:fs");
const status = process.argv[1];
const keys = JSON.parse(fs.readFileSync(0, "utf8")).AccessKeyMetadata || [];
for (const key of keys) if (key.Status === status && key.AccessKeyId) console.log(key.AccessKeyId);
' "$status"
}

delete_secret_if_present() {
  local secret_name="$1"
  wrangler secret delete --config "$WRANGLER_CONFIG_FILE" --name "$WORKER_NAME" "$secret_name" >/dev/null 2>&1 || true
}

delete_secret_required() {
  local secret_name="$1"
  local attempt=1
  while [[ "$attempt" -le 3 ]]; do
    if wrangler secret delete --config "$WRANGLER_CONFIG_FILE" --name "$WORKER_NAME" "$secret_name" >/dev/null; then
      return 0
    fi
    sleep "$attempt"
    attempt=$((attempt + 1))
  done

  log_error "Failed to remove temporary Worker secret: $secret_name"
  return 1
}

update_manifest_worker_identity_best_effort() {
  local manifest_file="${MC_AWS_DEPLOYMENT_MANIFEST:-.mc-aws-deployment.json}"
  [[ -f "$manifest_file" && -n "${WORKER_NAME:-}" ]] || return 0
  local deployments_json deployment_id
  deployments_json="$(wrangler --config /dev/null deployments status --name "$WORKER_NAME" --json 2>/dev/null)" || return 0
  deployment_id="$(printf '%s' "$deployments_json" | node -e '
const fs=require("node:fs"); const raw=fs.readFileSync(0,"utf8"); const start=raw.indexOf("{"); if(start<0) process.exit(2);
const deployment=JSON.parse(raw.slice(start)); if(typeof deployment.id!=="string") process.exit(2); process.stdout.write(deployment.id);
' 2>/dev/null)" || return 0
  MC_AWS_DEPLOYMENT_MANIFEST="$manifest_file" node scripts/shared/deployment-manifest.mjs \
    cloudflare-deployed --deployment-id "$deployment_id" >/dev/null 2>&1 || true
}

cleanup_on_exit() {
  local status="$?"
  set +e

  if [[ "$status" -ne 0 && "$ROTATION_MODE" == "full" && -n "$NEW_ACCESS_KEY_ID" && "$PROMOTED" == "0" ]]; then
    echo "⚠️  Candidate verification failed; retaining every prior runtime key." >&2
    delete_secret_if_present "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID"
    delete_secret_if_present "MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY"
    delete_secret_if_present "MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN"
    aws_cli iam delete-access-key --user-name "$RUNTIME_IAM_USER_NAME" --access-key-id "$NEW_ACCESS_KEY_ID" >/dev/null 2>&1 || true
  fi

  NEW_SECRET_ACCESS_KEY=""
  PROBE_TOKEN=""
  unset NEW_SECRET_ACCESS_KEY PROBE_TOKEN
  if [[ -n "$VERIFY_RESPONSE_FILE" ]]; then
    rm -f "$VERIFY_RESPONSE_FILE"
  fi
  return "$status"
}
trap cleanup_on_exit EXIT

build_candidate_secret_json() {
  MC_ACCESS_KEY_ID="$NEW_ACCESS_KEY_ID" \
    MC_SECRET_ACCESS_KEY="$NEW_SECRET_ACCESS_KEY" \
    MC_PROBE_TOKEN="$PROBE_TOKEN" \
    node -e 'process.stdout.write(JSON.stringify({
      MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID: process.env.MC_ACCESS_KEY_ID,
      MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY: process.env.MC_SECRET_ACCESS_KEY,
      MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN: process.env.MC_PROBE_TOKEN,
    }))'
}

build_primary_secret_json() {
  MC_ACCESS_KEY_ID="$NEW_ACCESS_KEY_ID" \
    MC_SECRET_ACCESS_KEY="$NEW_SECRET_ACCESS_KEY" \
    node -e 'process.stdout.write(JSON.stringify({
      AWS_ACCESS_KEY_ID: process.env.MC_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.MC_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: "",
    }))'
}

verify_worker_identity() {
  local mode="$1"
  local attempt=1
  local curl_status http_status retry_reason

  if [[ -z "$VERIFY_RESPONSE_FILE" ]]; then
    VERIFY_RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/mc-aws-runtime-verify.XXXXXX")"
  fi

  while [[ "$attempt" -le "$VERIFY_MAX_ATTEMPTS" ]]; do
    curl_status=0
    http_status="$("$CURL_BIN" --http1.1 --silent \
      --connect-timeout "$VERIFY_REQUEST_TIMEOUT_SECONDS" \
      --max-time "$VERIFY_REQUEST_TIMEOUT_SECONDS" \
      --output "$VERIFY_RESPONSE_FILE" \
      --write-out '%{response_code}' \
      -H "Authorization: Bearer $PROBE_TOKEN" \
      "${VERIFY_URL%/}/api/internal/runtime-credentials/verify?mode=$mode")" || curl_status=$?

    if [[ "$curl_status" -eq 0 && "$http_status" =~ ^2[0-9][0-9]$ ]]; then
      if node - "$VERIFY_RESPONSE_FILE" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (response.success !== true || response.data?.managedInstanceVerified !== true) process.exit(1);
NODE
      then
        echo "   $mode verification succeeded on attempt $attempt/$VERIFY_MAX_ATTEMPTS."
        return 0
      fi

      log_error "$mode verification returned an invalid success response (HTTP $http_status); refusing to continue."
      return 1
    fi

    if [[ "$curl_status" -ne 0 ]]; then
      retry_reason="transport error (curl exit $curl_status)"
    elif [[ "$http_status" == "404" || "$http_status" == "502" || "$http_status" == "503" ]]; then
      retry_reason="HTTP $http_status"
    else
      log_error "$mode verification failed with non-retryable HTTP status ${http_status:-unknown}; refusing to continue."
      return 1
    fi

    if [[ "$attempt" -ge "$VERIFY_MAX_ATTEMPTS" ]]; then
      log_error "$mode verification did not succeed within $VERIFY_MAX_ATTEMPTS attempts (last result: $retry_reason)."
      return 1
    fi

    echo "   $mode verification attempt $attempt/$VERIFY_MAX_ATTEMPTS returned $retry_reason; retrying in ${VERIFY_RETRY_DELAY_SECONDS}s..."
    if [[ "$VERIFY_RETRY_DELAY_SECONDS" != "0" ]]; then
      sleep "$VERIFY_RETRY_DELAY_SECONDS"
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

validate_retry_configuration() {
  if [[ ! "$VERIFY_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
    log_error "VERIFY_MAX_ATTEMPTS must be a positive integer"
    exit 1
  fi
  if [[ ! "$VERIFY_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
    log_error "VERIFY_RETRY_DELAY_SECONDS must be a non-negative integer"
    exit 1
  fi
  if [[ ! "$VERIFY_REQUEST_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    log_error "VERIFY_REQUEST_TIMEOUT_SECONDS must be a positive integer"
    exit 1
  fi
}

runtime_journal() {
  local phase="$1"
  local candidate_id="${2:-}"
  [[ -n "$RECOVERY_RECORD_FILE" ]] || return 0
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" RUNTIME_PHASE="$phase" RUNTIME_CANDIDATE_ID="$candidate_id" node <<'NODE'
const fs=require("node:fs"); const path=process.env.RECOVERY_RECORD_FILE; const stat=fs.lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600) throw new Error("unsafe recovery record");
const record=JSON.parse(fs.readFileSync(path,"utf8"));
if(record.schemaVersion!==1||record.project!=="mc-aws"||record.status!=="active") throw new Error("inactive recovery record");
record.runtimeIdentity.phase=process.env.RUNTIME_PHASE;
if(process.env.RUNTIME_CANDIDATE_ID) record.runtimeIdentity.candidateKeyId=process.env.RUNTIME_CANDIDATE_ID;
record.stage=`runtime-${process.env.RUNTIME_PHASE}`; record.updatedAt=new Date().toISOString();
const temporary=`${path}.tmp.${process.pid}`; fs.writeFileSync(temporary,`${JSON.stringify(record,null,2)}\n`,{mode:0o600,flag:"wx"}); fs.renameSync(temporary,path);
NODE
  if [[ "${MC_AWS_RUNTIME_FAIL_STAGE:-}" == "$phase" ]]; then
    log_error "Injected runtime rotation failure at phase: $phase"
    return 1
  fi
}

recorded_candidate_key_id() {
  if [[ -n "$NEW_ACCESS_KEY_ID" ]]; then printf '%s' "$NEW_ACCESS_KEY_ID"; return; fi
  [[ -n "$RECOVERY_RECORD_FILE" ]] || return 1
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
if(typeof r.runtimeIdentity?.candidateKeyId!=="string")process.exit(1); process.stdout.write(r.runtimeIdentity.candidateKeyId);
'
}

recorded_prior_key_ids() {
  if [[ ${#prior_key_ids[@]} -gt 0 ]]; then printf '%s\n' "${prior_key_ids[@]}"; return; fi
  [[ -n "$RECOVERY_RECORD_FILE" ]] || return 0
  RECOVERY_RECORD_FILE="$RECOVERY_RECORD_FILE" node -e '
const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.env.RECOVERY_RECORD_FILE,"utf8"));
for(const key of r.runtimeIdentity?.keys||[]) if(key.status==="Active") console.log(key.accessKeyId);
'
}

key_status_from_inventory() {
  local key_id="$1"
  node -e 'const fs=require("node:fs");const id=process.argv[1];const k=(JSON.parse(fs.readFileSync(0,"utf8")).AccessKeyMetadata||[]).find(x=>x.AccessKeyId===id);if(k)process.stdout.write(k.Status);' "$key_id"
}

prepare_rotation() {
  local access_keys_json prior_key_output created_key_json
  access_keys_json="$(list_access_keys "$RUNTIME_IAM_USER_NAME")"
  if [[ -n "$(printf '%s' "$access_keys_json" | key_ids_with_status Inactive)" ]]; then
    log_error "Runtime identity has an inactive key; refusing to delete unclassified recovery state."
    return 1
  fi
  prior_key_ids=()
  prior_key_output="$(printf '%s' "$access_keys_json" | key_ids_with_status Active)"
  while IFS= read -r key_id; do [[ -n "$key_id" ]] && prior_key_ids+=("$key_id"); done <<< "$prior_key_output"
  if [[ ${#prior_key_ids[@]} -ge 2 ]]; then
    log_error "Runtime identity already has two active keys; recovery must classify the extra key first."
    return 1
  fi
  created_key_json="$(aws_cli iam create-access-key --user-name "$RUNTIME_IAM_USER_NAME" --output json)"
  NEW_ACCESS_KEY_ID="$(printf '%s' "$created_key_json" | node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.AccessKey.AccessKeyId)')"
  NEW_SECRET_ACCESS_KEY="$(printf '%s' "$created_key_json" | node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.AccessKey.SecretAccessKey)')"
  created_key_json=""
  runtime_journal candidate-created "$NEW_ACCESS_KEY_ID"
  PROBE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  build_candidate_secret_json | wrangler secret bulk --config "$WRANGLER_CONFIG_FILE" --name "$WORKER_NAME" >/dev/null
  runtime_journal candidate-staged "$NEW_ACCESS_KEY_ID"
  verify_worker_identity candidate
  runtime_journal candidate-verified "$NEW_ACCESS_KEY_ID"
  build_primary_secret_json | wrangler secret bulk --config "$WRANGLER_CONFIG_FILE" --name "$WORKER_NAME" >/dev/null
  PROMOTED="1"
  runtime_journal primary-promoted "$NEW_ACCESS_KEY_ID"
  verify_worker_identity primary
  runtime_journal prepared "$NEW_ACCESS_KEY_ID"
  NEW_SECRET_ACCESS_KEY=""; PROBE_TOKEN=""; unset NEW_SECRET_ACCESS_KEY PROBE_TOKEN
}

finalize_rotation() {
  local candidate_id access_keys_json prior_output prior_id status
  candidate_id="$(recorded_candidate_key_id)" || { log_error "Recovery record has no candidate key identity"; return 1; }
  access_keys_json="$(list_access_keys "$RUNTIME_IAM_USER_NAME")"
  status="$(printf '%s' "$access_keys_json" | key_status_from_inventory "$candidate_id")"
  [[ "$status" == "Active" ]] || { log_error "Verified replacement key $candidate_id is not active"; return 1; }
  PROBE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  MC_PROBE_TOKEN="$PROBE_TOKEN" node -e 'process.stdout.write(JSON.stringify({MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN:process.env.MC_PROBE_TOKEN}))' | \
    wrangler secret bulk --config "$WRANGLER_CONFIG_FILE" --name "$WORKER_NAME" >/dev/null
  verify_worker_identity primary
  prior_output="$(recorded_prior_key_ids)"
  while IFS= read -r prior_id; do
    [[ -n "$prior_id" ]] || continue
    access_keys_json="$(list_access_keys "$RUNTIME_IAM_USER_NAME")"
    status="$(printf '%s' "$access_keys_json" | key_status_from_inventory "$prior_id")"
    if [[ "$status" == "Active" ]]; then
      aws_cli iam update-access-key --user-name "$RUNTIME_IAM_USER_NAME" --access-key-id "$prior_id" --status Inactive
    elif [[ "$status" != "Inactive" && -n "$status" ]]; then
      log_error "Prior key $prior_id has unexpected status $status"; return 1
    fi
  done <<< "$prior_output"
  runtime_journal prior-deactivated "$candidate_id"
  if ! verify_worker_identity primary; then
    log_error "Replacement failed after prior deactivation; prior keys remain present for recovery."
    return 1
  fi
  delete_secret_required "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID"
  delete_secret_required "MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY"
  delete_secret_required "MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN"
  delete_secret_required "AWS_SESSION_TOKEN"
  runtime_journal temporary-secrets-removed "$candidate_id"
  while IFS= read -r prior_id; do
    [[ -n "$prior_id" ]] || continue
    access_keys_json="$(list_access_keys "$RUNTIME_IAM_USER_NAME")"
    status="$(printf '%s' "$access_keys_json" | key_status_from_inventory "$prior_id")"
    [[ -z "$status" ]] || aws_cli iam delete-access-key --user-name "$RUNTIME_IAM_USER_NAME" --access-key-id "$prior_id"
  done <<< "$prior_output"
  runtime_journal finalized "$candidate_id"
  PROBE_TOKEN=""; unset PROBE_TOKEN
}

rollback_rotation() {
  local candidate_id access_keys_json prior_output prior_id status
  candidate_id="$(recorded_candidate_key_id 2>/dev/null || true)"
  access_keys_json="$(list_access_keys "$RUNTIME_IAM_USER_NAME")"
  prior_output="$(recorded_prior_key_ids)"
  while IFS= read -r prior_id; do
    [[ -n "$prior_id" ]] || continue
    status="$(printf '%s' "$access_keys_json" | key_status_from_inventory "$prior_id")"
    [[ "$status" == "Active" ]] || { log_error "Recorded prior key $prior_id is not available and active; rollback is incomplete"; return 1; }
  done <<< "$prior_output"
  if [[ -n "$candidate_id" ]]; then
    status="$(printf '%s' "$access_keys_json" | key_status_from_inventory "$candidate_id")"
    [[ -z "$status" ]] || aws_cli iam delete-access-key --user-name "$RUNTIME_IAM_USER_NAME" --access-key-id "$candidate_id"
  fi
  runtime_journal rolled-back "$candidate_id"
}

require_command "$AWS_CLI"
require_command "$WRANGLER_BIN"
require_command "$CURL_BIN"
require_command node
require_command mktemp
validate_retry_configuration

if [[ -z "${VERIFY_URL:-}" ]]; then
  log_error "VERIFY_URL is required (the deployed panel origin, for example https://panel.example.com)"
  exit 1
fi

WORKER_NAME="$(resolve_worker_name)" || { log_error "Could not resolve Worker name"; exit 1; }
RUNTIME_IAM_USER_NAME="$(resolve_runtime_user_name)"
if [[ -z "$RUNTIME_IAM_USER_NAME" || "$RUNTIME_IAM_USER_NAME" == "None" ]]; then
  log_error "Could not locate WorkerRuntimeIamUserName in stack '$STACK_NAME'"
  exit 1
fi

assert_runtime_identity_tags "$RUNTIME_IAM_USER_NAME"

echo "🔐 Rotating dedicated Worker runtime credentials"
echo "   IAM identity: $RUNTIME_IAM_USER_NAME"
echo "   Worker: $WORKER_NAME"

case "$ROTATION_MODE" in
  prepare)
    prepare_rotation
    echo "✅ Replacement runtime key prepared and verified; every prior key remains active"
    ;;
  finalize)
    finalize_rotation
    echo "✅ Replacement runtime key finalized after the outer deployment commit decision"
    ;;
  rollback)
    rollback_rotation
    echo "✅ Candidate runtime key cleanup verified; recorded prior keys remain active"
    ;;
  full)
    prepare_rotation
    finalize_rotation
    echo "✅ Worker runtime key rotation verified and complete"
    ;;
  *)
    log_error "ROTATION_MODE must be prepare, finalize, rollback, or full"
    exit 1
    ;;
esac
