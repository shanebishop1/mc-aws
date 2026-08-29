#!/usr/bin/env bash

# Ownership-aware mc-aws teardown. Inventory/dry-run is the default. Execution
# requires both --execute and an exact, deployment-specific confirmation phrase.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
DRIVE_BACKUP_MAX_AGE_MS=$((24 * 60 * 60 * 1000))
RETAIN_GDRIVE_TOKEN="0"
CONFIRM_ABSENT_STACK_DATA="0"
CONSENT_SSM_NAMES=()

usage() {
  cat <<'EOF'
Usage: scripts/destroy.sh [--execute] [--retain-final-snapshot] [--retain-gdrive-token-for-migration] [--confirm-absent-stack-data] [--consent-delete-ssm NAME] [--cleanup-local-env] [--manifest PATH]

Default: live inventory and dry-run only; no resources or local files change.
  --execute            perform only ownership-verified deletion actions
  --retain-final-snapshot
                       explicitly create and retain a final EBS snapshot instead
                        of relying on independently verified Google Drive backups
  --retain-gdrive-token-for-migration
                       retain only /minecraft/gdrive-token for a separately
                       reviewed Drive migration; other ownership-proven SSM state is deleted
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

if ! MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" validate >/dev/null; then
  error "Manifest validation failed; refusing teardown"
  exit 1
fi

MANIFEST_DIGEST="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"

refresh_manifest_digest() {
  MANIFEST_DIGEST="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"
}

assert_manifest_unchanged() {
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" validate >/dev/null || {
    error "Manifest security/schema validation changed during teardown; refusing further mutation"
    exit 1
  }
  local current_digest
  current_digest="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$MANIFEST_FILE")"
  if [[ "$current_digest" != "$MANIFEST_DIGEST" ]]; then
    error "Deployment manifest changed after inventory; refusing further mutation"
    exit 1
  fi
}

json_get() {
  local path="$1"
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
      item.zoneId, item.id, item.name, item.type, item.content, item.proxied, item.createdByProject,
      item.modifiedByProject, item.original?.proxied,
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
  AWS_PAGER="" "$AWS_CLI" --region "$AWS_REGION_VALUE" "$@"
}

is_stack_not_found_error() { [[ "$1" == *"ValidationError"* && "$1" == *"does not exist"* ]]; }
is_iam_not_found_error() { [[ "$1" == *"NoSuchEntity"* ]]; }
is_dlm_not_found_error() { [[ "$1" == *"ResourceNotFoundException"* ]]; }
is_snapshot_not_found_error() { [[ "$1" == *"InvalidSnapshot.NotFound"* ]]; }
is_volume_not_found_error() { [[ "$1" == *"InvalidVolume.NotFound"* ]]; }
is_ssm_not_found_error() { [[ "$1" == *"ParameterNotFound"* ]]; }
is_dynamodb_not_found_error() { [[ "$1" == *"ResourceNotFoundException"* ]]; }
is_worker_not_found_error() { [[ "$1" =~ (^|[^0-9])(10007|10090)([^0-9]|$) ]]; }

is_exact_stack_delete_complete_json() {
  local response="$1"
  printf '%s' "$response" | EXPECTED_STACK_ID="$STACK_ID" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); const stack=d.Stacks?.[0];
process.exit(stack?.StackId===process.env.EXPECTED_STACK_ID && stack?.StackStatus==="DELETE_COMPLETE" ? 0 : 1);
' 2>/dev/null
}

wrangler() {
  env -i PATH="$PATH" HOME="$WRANGLER_HOME_DIR" TERM="${TERM:-}" USER="${USER:-}" \
    CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" "$WRANGLER_BIN" "$@"
}

cf_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
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

mark_complete() {
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
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
        MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
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

record_google_drive_backup_evidence() {
  local observed_at="$1"
  local backup_json backup_line backup_count backup_cached_at
  backup_json="$(aws_cli ssm get-parameter --name /minecraft/backups-cache --output json)" || {
    error "Google Drive durability mode requires readable backup evidence in /minecraft/backups-cache"
    return 1
  }
  backup_line="$(printf '%s' "$backup_json" | MAX_AGE_MS="$DRIVE_BACKUP_MAX_AGE_MS" "$NODE_BIN" -e '
const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); let cache; try{cache=JSON.parse(d.Parameter?.Value||"");}catch{process.exit(2)}
if(!cache || typeof cache!=="object" || Array.isArray(cache) || !Array.isArray(cache.backups) || cache.backups.length<1 || !Number.isSafeInteger(cache.cachedAt) || cache.cachedAt<=0) process.exit(1);
const now=Date.now(), maxAge=Number(process.env.MAX_AGE_MS);
if(cache.cachedAt>now+5*60*1000 || now-cache.cachedAt>maxAge) process.exit(3);
process.stdout.write(`${cache.backups.length}\t${cache.cachedAt}`);
')" || {
    error "Google Drive durability mode requires non-empty backup cache evidence refreshed within the last 24 hours"
    return 1
  }
  IFS=$'\t' read -r backup_count backup_cached_at <<< "$backup_line"
  assert_manifest_unchanged
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
    google-drive-backup --backup-count "$backup_count" --cached-at "$backup_cached_at" --observed-at "$observed_at" >/dev/null
  refresh_manifest_digest
  log "  ✅ Recorded Google Drive cache evidence: $backup_count backup(s), cachedAt=$backup_cached_at"
  log "     Google Drive content is external and will not be deleted; no EBS snapshot will be retained."
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
    STACK_SSM_NAMES_JSON="${STACK_SSM_NAMES_JSON:-[]}" "$NODE_BIN" - "$MANIFEST_FILE" 3<<<"$inventory_json" <<'NODE'
const fs=require("node:fs");
const parameters=JSON.parse(fs.readFileSync(3,"utf8"));
const manifest=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const facts=manifest.aws?.ssmParameters||[];
const stackOwned=new Set(JSON.parse(process.env.STACK_SSM_NAMES_JSON||"[]"));
const consented=new Set((process.env.CONSENT_SSM_NAMES||"").split(/\n/).filter(Boolean));
const exact=new Map([
  ["/minecraft/gdrive-token","credential"],
  ["/minecraft/cloudflare-api-token","credential"],
  ["/minecraft/duckdns-token","credential"],
  ["/minecraft/email-allowlist","pii"],
  ["/minecraft/verified-sender","pii"],
  ["/minecraft/notification-email","pii"],
  ["/minecraft/startup-triggered-by","pii"],
  ["/minecraft/player-count","runtime-state"],
  ["/minecraft/backups-cache","runtime-state"],
  ["/minecraft/last-scheduled-backup-success","runtime-state"],
  ["/minecraft/scheduled-backup-enabled-at","runtime-state"],
  ["/minecraft/server-action","pii"],
  ["/minecraft/resume-pending","runtime-state"],
  ["/minecraft/server-profile-manifest","runtime-state"],
  ["/minecraft/cloudflare-zone-id","runtime-state"],
  ["/minecraft/cloudflare-domain","runtime-state"],
  ["/minecraft/duckdns-domain","runtime-state"],
  ["/minecraft/github-pat","legacy-credential"],
  ["/minecraft/github-user","legacy-config"],
  ["/minecraft/github-repo","legacy-config"],
]);
const operation=/^\/minecraft\/operations\/(?:start|stop|backup|restore|hibernate|resume)-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailOperation=/^\/minecraft\/operations\/email-(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const claim=/^\/minecraft\/server-action-delete-claim\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const currentHint="/minecraft/server-action-delete-claim/current";
for(const parameter of parameters){
  const name=typeof parameter?.Name==="string"?parameter.Name:"";
  const type=typeof parameter?.Type==="string"?parameter.Type:"unknown";
  let category=exact.get(name);
  if(!category && (operation.test(name)||emailOperation.test(name)||claim.test(name)||name===currentHint)) category="pii";
  const fact=facts.find((entry)=>entry.name===name)||facts.find((entry)=>entry.name.endsWith("/*")&&name.startsWith(entry.name.slice(0,-1)));
  const ownership=fact?.ownership==="created"||stackOwned.has(name)?"created":fact?.ownership==="preexisting"?"preexisting":"unproven";
  let disposition="preserve-unclassified";
  if(category){
    if(ownership==="created") disposition=name==="/minecraft/gdrive-token"&&process.env.RETAIN_GDRIVE_TOKEN==="1"?"retain-for-migration":"delete";
    else if(consented.has(name)) disposition="delete-consented";
    else if(ownership==="preexisting") disposition="preserve-preexisting";
    else disposition="preserve-unproven";
  }
  process.stdout.write([name,type,category||"unclassified",ownership,disposition,fact?.source|| (stackOwned.has(name)?"exact-stack-resource":"none")].join("\t")+"\n");
}
NODE
}

delete_project_ssm_leftovers() {
  local inventory_json inventory_lines name type category ownership disposition evidence probe delete_error
  inventory_json="$(inventory_ssm_parameters)" || { error "Could not re-inventory project SSM parameters after stack deletion"; return 1; }
  inventory_lines="$(classify_ssm_inventory "$inventory_json")" || return 1
  while IFS=$'\t' read -r name type category ownership disposition evidence; do
    [[ -n "$name" ]] || continue
    if [[ "$disposition" == preserve-* ]]; then
      warn "Preserved $ownership SSM parameter: $name"
      continue
    fi
    if [[ "$disposition" == "retain-for-migration" ]]; then
      warn "Retained Drive credential for explicit migration: $name (security-sensitive; delete immediately after migration)"
      continue
    fi
    assert_manifest_unchanged
    if ! assert_aws_account_now || ! assert_exact_stack_absent_now; then
      error "AWS identity or stack absence changed before exact SSM cleanup"
      return 1
    fi
    if ! probe="$(describe_exact_ssm_parameter "$name" 2>&1)"; then
      error "Could not revalidate exact SSM parameter before deletion: $name"
      return 1
    fi
    if [[ -z "$probe" || "$probe" == "None" ]]; then continue; fi
    [[ "$probe" == "$name" ]] || { error "SSM returned an unexpected parameter identity for $name"; return 1; }
    delete_error=""
    if ! delete_error="$(aws_cli ssm delete-parameter --name "$name" 2>&1)" && ! is_ssm_not_found_error "$delete_error"; then
      error "Failed to delete exact SSM parameter: $name"
      return 1
    fi
    if ! probe="$(describe_exact_ssm_parameter "$name" 2>&1)"; then
      error "Could not verify SSM parameter removal: $name"
      return 1
    elif [[ -n "$probe" && "$probe" != "None" ]]; then
      error "SSM parameter remains after deletion: $name"
      return 1
    fi
    log "  ✅ Deleted and verified $ownership $category SSM parameter: $name"
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
    record_google_drive_backup_evidence "$observed_at" || return 1
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
  quiesce_instance_for_snapshot "$instance_state" "$root_volume_id" || return 1

  if [[ "$DATA_PRESERVATION_MODE" == "google-drive" ]]; then
    record_google_drive_backup_evidence "$observed_at" || return 1
    mark_complete "final-data-preservation"
    return 0
  fi

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
      MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
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
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
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
  MC_AWS_DEPLOYMENT_MANIFEST="$MANIFEST_FILE" "$NODE_BIN" "$ROOT_DIR/scripts/deployment-manifest.mjs" \
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
  while IFS=$'\t' read -r parameter_name parameter_type parameter_category parameter_ownership parameter_disposition parameter_evidence; do
    [[ -n "$parameter_name" ]] || continue
    log "  - $parameter_name [$parameter_type; $parameter_category; ownership=$parameter_ownership; evidence=$parameter_evidence] => $parameter_disposition"
    if [[ "$parameter_disposition" == "preserve-unclassified" || "$parameter_disposition" == "preserve-unproven" ]]; then
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
const evidence=teardown.finalRootSnapshot||teardown.googleDriveBackupEvidence||teardown.hibernatedBackupEvidence;
process.stdout.write(completed&&Boolean(evidence)?"1":"0");
NODE
)"
if [[ "$STACK_LIVE" != "1" && "$DATA_PRESERVATION_RECORDED" != "1" && "$CONFIRM_ABSENT_STACK_DATA" != "1" ]]; then
  add_blocker "stack is absent and no durable final-data-preservation record exists; use --confirm-absent-stack-data only after direct Drive/snapshot proof"
fi

while IFS=$'\t' read -r parameter_name _ _ parameter_ownership parameter_disposition _; do
  case "$parameter_name" in
    /minecraft/cloudflare-api-token|/minecraft/duckdns-token)
      if [[ "$STACK_LIVE" == "1" && "$parameter_ownership" != "created" && "$parameter_disposition" != "delete-consented" ]]; then
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
  route_response=""
  if ! route_response="$(cf_api GET "/zones/${zone_id}/workers/routes" 2>&1)"; then
    add_blocker "Worker route inventory failed for zone $zone_id (a token with Workers Routes Read/Edit is required)"
    continue
  fi
  if ! cf_assert_success "$route_response" "200"; then
    add_blocker "Worker route API returned HTTP $(cf_status "$route_response") or an unsuccessful body for zone $zone_id"
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

while IFS=$'\t' read -r zone_id record_id record_name record_type record_content record_proxied record_owned record_modified original_proxied; do
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
const r=d.result; process.stdout.write(["FOUND",r.id,r.type,r.name,r.content,String(Boolean(r.proxied))].join("\t"));
' 2>/dev/null)"; then
    add_blocker "panel DNS API returned an invalid or unsuccessful inventory for record $record_id"
    continue
  fi
  if [[ "$dns_parse" == FOUND$'\t'* ]]; then
    dns_line="${dns_parse#*$'\t'}"
    IFS=$'\t' read -r live_dns_id live_dns_type live_dns_name live_dns_content live_dns_proxied <<< "$dns_line"
    if [[ "$record_owned" == "true" && ( "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" ) ]]; then
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

log ""
log "Planned ownership-safe actions:"
log "  - Worker/secrets: $([[ "$WORKER_OWNED" == "true" ]] && printf 'delete Worker directly if live and verified' || printf 'preserve (pre-existing or unproven)')"
log "  - Routes: delete project-created; restore pre-existing route targets; preserve unproven"
log "  - KV/DNS: delete project-created only; preserve pre-existing (restore proxy state when recorded)"
log "  - Runtime IAM: revoke/delete keys before CloudFormation deletes the stack-owned user"
log "  - SSM: after data preservation and stack deletion, delete and verify each allowlisted credential/PII/runtime parameter"
if [[ "$RETAIN_GDRIVE_TOKEN" == "1" ]]; then
  log "  - SSM exception: retain only /minecraft/gdrive-token for an explicitly reviewed Drive migration"
fi
log "  - DLM: delete only manifest-owned policies with matching live tags"
log "  - Stack: $([[ "$STACK_OWNED" == "true" ]] && printf 'delete exact recorded StackId via CloudFormation if live' || printf 'preserve (not proven project-created)')"
if [[ "$DATA_PRESERVATION_MODE" == "snapshot" ]]; then
  log "  - Root data: stop/quiesce and create/verify an explicitly requested retained final EBS snapshot"
else
  log "  - Root data: stop/quiesce, require a cache refresh within 24 hours plus direct-Drive confirmation, and retain no new EBS snapshot"
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

if [[ "$STACK_LIVE" == "1" && "$DATA_PRESERVATION_MODE" == "google-drive" ]]; then
  drive_confirmation_phrase="drive backup directly verified for ${STACK_ID}"
  warn "The bounded backup cache is only application evidence, not proof that Drive is readable or restorable."
  log "After directly checking the expected archive in Google Drive, type exactly: $drive_confirmation_phrase"
  IFS= read -r drive_confirmation || drive_confirmation=""
  if [[ "$drive_confirmation" != "$drive_confirmation_phrase" ]]; then
    error "Direct Google Drive verification confirmation did not match. No mutations were performed."
    exit 1
  fi
fi

log ""
log "Executing verified teardown..."
assert_manifest_unchanged
if [[ "$WORKER_LIVE" == "1" ]] && ! assert_worker_deployment_now; then
  error "Worker deployment identity changed after inventory; no mutations were performed"
  exit 1
fi

# Complete the selected data-preservation gate before deleting any provider,
# DLM, or runtime-credential resource. On a partial rerun with an absent stack,
# the prior stack deletion proves this gate was already passed.
if [[ "$STACK_OWNED" == "true" && "$STACK_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_aws_account_now || ! assert_exact_stack_live_now || ! assert_runtime_iam_tags_now; then
    error "AWS stack/runtime IAM identity changed before final data preservation; refusing provider cleanup"
    exit 1
  fi
  preserve_final_root_data || exit 1
fi

# Routes first so an owned Worker is never deleted while an owned/custom route is still attached.
while IFS=$'\t' read -r zone_id route_id pattern script route_owned ownership_proven original_script; do
  [[ -n "$zone_id" ]] || continue
  route_response="$(cf_api GET "/zones/${zone_id}/workers/routes")"
  cf_assert_success "$route_response" "200" || { error "Route provider response changed or failed before mutation"; exit 1; }
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

while IFS=$'\t' read -r zone_id record_id record_name record_type record_content record_proxied record_owned record_modified original_proxied; do
  [[ -n "$zone_id" ]] || continue
  dns_response="$(cf_api GET "/zones/${zone_id}/dns_records/${record_id}")"
  if cf_is_exact_dns_absence "$dns_response"; then continue; fi
  cf_assert_success "$dns_response" "200" || { error "DNS provider response changed or failed before mutation"; exit 1; }
  dns_parse="$(cf_body "$dns_response" | "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8"));
if(d.success!==true || !d.result) process.exit(2); const r=d.result;
process.stdout.write(["FOUND",r.id,r.type,r.name,r.content,String(Boolean(r.proxied))].join("\t"));
')"
  [[ "$dns_parse" == FOUND$'\t'* ]] || continue
  dns_line="${dns_parse#*$'\t'}"
  IFS=$'\t' read -r live_dns_id live_dns_type live_dns_name live_dns_content live_dns_proxied <<< "$dns_line"
  if [[ "$record_owned" == "true" && ( "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" ) ]]; then
    error "Panel DNS record '$record_name' changed after inventory; refusing mutation"
    exit 1
  fi
  if [[ "$record_owned" == "true" ]]; then
    response="$(cf_api DELETE "/zones/${zone_id}/dns_records/${record_id}")"
    cf_assert_success "$response" "200" || { error "Cloudflare did not confirm DNS deletion"; exit 1; }
    log "  ✅ Deleted project-created panel DNS record: $record_name"
  elif [[ "$record_modified" == "true" ]]; then
    if [[ "$live_dns_id" != "$record_id" || "$live_dns_type" != "$record_type" || "$live_dns_name" != "$record_name" || "$live_dns_content" != "$record_content" ]]; then
      warn "Preserved changed pre-existing DNS record '$record_name' without restoring its proxy state"
    elif [[ "$live_dns_proxied" == "$record_proxied" && "$live_dns_proxied" != "$original_proxied" ]]; then
      dns_body="$(DNS_TYPE="$record_type" DNS_NAME="$record_name" DNS_CONTENT="$record_content" DNS_PROXIED="$original_proxied" "$NODE_BIN" -e '
process.stdout.write(JSON.stringify({type:process.env.DNS_TYPE,name:process.env.DNS_NAME,content:process.env.DNS_CONTENT,proxied:process.env.DNS_PROXIED==="true"}));
')"
      response="$(cf_api PUT "/zones/${zone_id}/dns_records/${record_id}" "$dns_body")"
      cf_assert_success "$response" "200" || { error "Cloudflare did not confirm DNS restoration"; exit 1; }
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

if [[ "$STACK_OWNED" == "true" && "$STACK_LIVE" == "1" ]]; then
  assert_manifest_unchanged
  if ! assert_aws_account_now || ! assert_exact_stack_live_now || ! assert_runtime_iam_tags_now; then
    error "AWS stack/runtime IAM identity changed after data preservation; blocking stack deletion"
    exit 1
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
    while IFS=$'\t' read -r parameter_name parameter_type parameter_category parameter_ownership parameter_disposition parameter_evidence; do
      [[ -n "$parameter_name" ]] || continue
      if [[ "$parameter_disposition" == "retain-for-migration" ]]; then
        warn "Security residual: retained credential $parameter_name; it remains usable and must be deleted after migration"
      elif [[ "$parameter_disposition" == preserve-* ]]; then
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
  final_routes="$(cf_api GET "/zones/${zone_id}/workers/routes")" || { final_failures+=("route '$pattern' could not be verified absent"); continue; }
  if ! cf_assert_success "$final_routes" "200"; then final_failures+=("route '$pattern' provider verification failed"); continue; fi
  if cf_body "$final_routes" | EXPECTED_PATTERN="$pattern" "$NODE_BIN" -e '
const fs=require("node:fs"); const d=JSON.parse(fs.readFileSync(0,"utf8")); if(d.success!==true) process.exit(2);
process.exit((d.result||[]).some((route)=>route.pattern===process.env.EXPECTED_PATTERN) ? 0 : 1);
'; then
    final_failures+=("owned Worker route '$pattern' remains")
  fi
done < <(manifest_lines routes)

while IFS=$'\t' read -r zone_id record_id record_name _ _ _ record_owned _ _; do
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
