#!/usr/bin/env bash
# Main entry point for the mc-aws setup wizard
# This script verifies prerequisites and guides you through the initial setup

set -euo pipefail

PRODUCTION_ENV_FILE=".env.production"
LOCAL_ENV_FILE=".env.local"
TOOL_VERSIONS_FILE=".tool-versions"
DEPLOYMENT_MANIFEST_FILE="${MC_AWS_DEPLOYMENT_MANIFEST:-.mc-aws-deployment.json}"

read_tool_version() {
  local tool_name="$1"

  if [[ ! -f "$TOOL_VERSIONS_FILE" ]]; then
    return 1
  fi

  awk -v tool="$tool_name" '$1 == tool { print $2 }' "$TOOL_VERSIONS_FILE"
}

NODE_VERSION_PIN="$(read_tool_version node 2>/dev/null || true)"
PNPM_VERSION_PIN="$(read_tool_version pnpm 2>/dev/null || true)"

# Log function
log() {
  echo "$*"
}

is_tty() {
  [[ -t 1 ]]
}

screen_clear() {
  if ! is_tty; then
    return
  fi

  if command -v tput >/dev/null 2>&1; then
    tput clear || true
    return
  fi

  if command -v clear >/dev/null 2>&1; then
    clear || true
    return
  fi

  printf '\033c' || true
}

mask_value() {
  local value="$1"
  local len=${#value}

  if [[ $len -le 8 ]]; then
    echo "***"
    return
  fi

  echo "${value:0:3}***${value:$((len - 3)):3}"
}

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 1

  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue

    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"

    export "$key=$value"
  done < "$env_file"

  return 0
}

template_for_env_file() {
  local env_file="$1"

  case "$env_file" in
    ".env.local")
      printf '%s\n' ".env.local.example"
      ;;
    ".env.production")
      printf '%s\n' ".env.production.example"
      ;;
    *)
      printf '%s\n' ""
      ;;
  esac
}

seed_env_file_if_missing() {
  local env_file="$1"
  local template_file
  template_file="$(template_for_env_file "$env_file")"

  if [[ -z "$template_file" || -f "$env_file" || ! -f "$template_file" ]]; then
    return 0
  fi

  cp "$template_file" "$env_file"
}

write_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  seed_env_file_if_missing "$env_file"
  touch "$env_file"

  local tmp
  tmp="${env_file}.mc-aws-tmp"
  rm -f "$tmp"
  (umask 077 && : >"$tmp")

  local found="0"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
      found="1"
      continue
    fi

    printf '%s\n' "$line" >> "$tmp"
  done < "$env_file"

  if [[ "$found" == "0" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  mv "$tmp" "$env_file"
}

write_env_files() {
  local key="$1"
  local value="$2"

  write_env "$PRODUCTION_ENV_FILE" "$key" "$value"
  write_env "$LOCAL_ENV_FILE" "$key" "$value"
}

get_missing_required_credentials() {
  local required=(
    "AWS_REGION"
    "GOOGLE_CLIENT_ID"
    "GOOGLE_CLIENT_SECRET"
    "ADMIN_EMAIL"
    "AUTH_SECRET"
    "PANEL_HOSTING_MODE"
    "NEXT_PUBLIC_APP_URL"
    "MC_AGENT_RUNTIME_ENABLED"
  )
  local missing=()

  if [[ -n "${MC_CONNECTION_MODE:-}" && ! "${MC_CONNECTION_MODE}" =~ ^(cloudflare|duckdns|raw_ip)$ ]]; then
    missing+=("MC_CONNECTION_MODE")
  fi

  if [[ -n "${MC_AGENT_RUNTIME_ENABLED:-}" && ! "${MC_AGENT_RUNTIME_ENABLED}" =~ ^(true|false)$ ]]; then
    missing+=("MC_AGENT_RUNTIME_ENABLED")
  fi

  case "$(resolve_minecraft_connection_mode)" in
    cloudflare)
      required+=("CLOUDFLARE_DNS_API_TOKEN" "CLOUDFLARE_ZONE_ID" "CLOUDFLARE_MC_DOMAIN")
      ;;
    duckdns)
      required+=("DUCKDNS_DOMAIN" "DUCKDNS_TOKEN")
      ;;
    raw_ip)
      ;;
    *)
      ;;
  esac

  case "${PANEL_HOSTING_MODE:-}" in
    workers_dev)
      required+=("CLOUDFLARE_WORKERS_SUBDOMAIN")
      ;;
    custom)
      required+=(
        "CLOUDFLARE_PANEL_ZONE_ID"
        "PANEL_WORKERS_DEV_ENABLED"
      )
      case "${PANEL_DNS_MANAGEMENT:-managed}" in
        managed)
          required+=("CLOUDFLARE_PANEL_DNS_API_TOKEN")
          ;;
        external)
          ;;
        *)
          missing+=("PANEL_DNS_MANAGEMENT")
          ;;
      esac
      if [[ -n "${PANEL_WORKERS_DEV_ENABLED:-}" && ! "${PANEL_WORKERS_DEV_ENABLED}" =~ ^(true|false)$ ]]; then
        missing+=("PANEL_WORKERS_DEV_ENABLED")
      fi
      ;;
    *)
      if [[ -n "${PANEL_HOSTING_MODE:-}" ]]; then
        missing+=("PANEL_HOSTING_MODE")
      fi
      if [[ -n "${PANEL_DNS_MANAGEMENT:-}" ]]; then
        missing+=("PANEL_DNS_MANAGEMENT")
      fi
      ;;
  esac

  for key in "${required[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s\n' "${missing[@]}"
  fi
}

ensure_al2023_ami_pin() {
  local pinned_ami
  if ! pinned_ami="$(run_with_mise pnpm exec tsx scripts/setup/pin-al2023-ami.ts ensure \
    --region "$CDK_DEFAULT_REGION" \
    --env-file "$PRODUCTION_ENV_FILE" \
    --env-file "$LOCAL_ENV_FILE")"; then
    return 1
  fi
  AL2023_ARM64_AMI_ID="$pinned_ami"
  export AL2023_ARM64_AMI_ID
}

ensure_bootstrap_artifact_pins() {
  local pins_sha256
  if ! pins_sha256="$(run_with_mise pnpm exec tsx scripts/setup/pin-bootstrap-artifacts.ts check \
    --env-file "$PRODUCTION_ENV_FILE" \
    --env-file "$LOCAL_ENV_FILE")"; then
    return 1
  fi
  MC_BOOTSTRAP_PINS_SHA256="$pins_sha256"
  export MC_BOOTSTRAP_PINS_SHA256
}

resolve_minecraft_connection_mode() {
  case "${MC_CONNECTION_MODE:-}" in
    cloudflare|duckdns|raw_ip)
      printf '%s\n' "$MC_CONNECTION_MODE"
      return
      ;;
  esac

  # Infer a provider only from a complete credential set. A half-removed
  # provider is stale configuration, not an instruction to block startup.
  if [[ -n "${CLOUDFLARE_MC_DOMAIN:-}" && -n "${CLOUDFLARE_ZONE_ID:-}" && -n "${CLOUDFLARE_DNS_API_TOKEN:-}" ]]; then
    printf '%s\n' "cloudflare"
  elif [[ -n "${DUCKDNS_DOMAIN:-}" && -n "${DUCKDNS_TOKEN:-}" ]]; then
    printf '%s\n' "duckdns"
  else
    printf '%s\n' "raw_ip"
  fi
}

minecraft_connection_target() {
  case "$(resolve_minecraft_connection_mode)" in
    cloudflare)
      printf '%s\n' "${CLOUDFLARE_MC_DOMAIN:-Cloudflare hostname not configured}"
      ;;
    duckdns)
      printf '%s\n' "${DUCKDNS_DOMAIN:-not-configured}.duckdns.org"
      ;;
    raw_ip)
      printf '%s\n' "the public IP shown in the control panel"
      ;;
    *)
      printf '%s\n' "the connection address shown in the control panel"
      ;;
  esac
}

ensure_auth_secret() {
  if [[ ! -f "$PRODUCTION_ENV_FILE" ]]; then
    if [[ "${MC_AWS_ROTATE_AUTH_SECRET:-0}" != "1" ]]; then
      AUTH_SECRET="${AUTH_SECRET:-}" ./node_modules/.bin/tsx scripts/setup/validate-auth-secret.ts >/dev/null 2>&1
      return $?
    fi
    write_env "$PRODUCTION_ENV_FILE" "AUTH_SECRET" "${AUTH_SECRET:-}"
    write_env "$LOCAL_ENV_FILE" "AUTH_SECRET" "${AUTH_SECRET:-}"
  fi
  ./node_modules/.bin/tsx scripts/setup/manage-auth-secret.ts ensure \
    --env-file "$PRODUCTION_ENV_FILE" \
    --secondary-env-file "$LOCAL_ENV_FILE" \
    --rotate "${MC_AWS_ROTATE_AUTH_SECRET:-0}" >/dev/null
  load_env_file "$PRODUCTION_ENV_FILE" || true
}

ensure_cdk_defaults() {
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"

  if [[ -z "${CDK_DEFAULT_REGION:-}" ]]; then
    CDK_DEFAULT_REGION="$AWS_REGION"
    export CDK_DEFAULT_REGION
  fi

  if [[ -z "${CDK_DEFAULT_ACCOUNT:-}" ]]; then
    if ! command -v aws >/dev/null 2>&1; then
      return 1
    fi
    CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
    export CDK_DEFAULT_ACCOUNT
  fi

  if [[ -z "${CDK_DEFAULT_ACCOUNT:-}" || "${CDK_DEFAULT_ACCOUNT}" == "None" ]]; then
    return 1
  fi

  write_env_files "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"
  write_env_files "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  return 0
}

# A successful empty DescribeParameters result is not sufficient ownership
# evidence.  Probe the exact parameter with GetParameter so only AWS's exact
# ParameterNotFound result is treated as absence.  AccessDenied, throttling,
# timeouts, malformed output, and every other failure stop setup before the
# deployment manifest can record provenance.
probe_ssm_parameter() {
  local name="$1" response parameter_type
  if response="$(aws ssm get-parameter --name "$name" --query 'Parameter.Type' --output text 2>&1)"; then
    parameter_type="${response//$'\r'/}"
    parameter_type="${parameter_type//$'\n'/}"
    case "$parameter_type" in
      String|StringList|SecureString)
        printf '%s\texisting\t%s\n' "$name" "$parameter_type"
        return 0
        ;;
      *)
        error_exit "SSM ownership probe for '$name' returned an empty or invalid type; refusing to write manifest provenance"
        ;;
    esac
  fi

  if [[ "$response" =~ (^|[^[:alnum:]_])ParameterNotFound([^[:alnum:]_]|$) ]]; then
    printf '%s\tabsent\tunknown\n' "$name"
    return 0
  fi

  error_exit "Could not determine SSM ownership for '$name' (only exact ParameterNotFound means absent): $response"
}

probe_ssm_namespace() {
  local name="$1" response count
  if ! response="$(aws ssm describe-parameters \
    --parameter-filters "Key=Path,Option=Recursive,Values=$name" \
    --query 'length(Parameters)' --output text 2>&1)"; then
    error_exit "Could not determine SSM namespace ownership for '$name': $response"
  fi
  count="${response//$'\r'/}"
  count="${count//$'\n'/}"
  [[ "$count" =~ ^[0-9]+$ ]] || error_exit "SSM namespace ownership probe for '$name' returned an empty or malformed response"
  if [[ "$count" == "0" ]]; then
    printf '%s/*\tabsent\tunknown\n' "$name"
  else
    printf '%s/*\texisting\tunknown\n' "$name"
  fi
}

prepare_backup_recovery_capsule_adoption() {
  if [[ -z "${MC_BACKUP_RECOVERY_CAPSULE_FILE:-}" ]]; then
    [[ "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTED:-false}" != "true" ]] || \
      error_exit "MC_BACKUP_RECOVERY_CAPSULE_ADOPTED=true requires MC_BACKUP_RECOVERY_CAPSULE_FILE"
    return 0
  fi

  local capsule_identity capsule_server_id capsule_checkpoint capsule_floor capsule_keys capsule_digest
  capsule_identity="$(python3 infra/src/ec2/mc-backup-auth.py capsule-inspect \
    --capsule "$MC_BACKUP_RECOVERY_CAPSULE_FILE")" || \
    error_exit "Recovery capsule validation failed; no deployment provenance was written"
  IFS=$'\t' read -r capsule_server_id capsule_checkpoint capsule_floor capsule_keys capsule_digest <<< "$capsule_identity"
  [[ "$capsule_server_id" =~ ^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$ ]] || \
    error_exit "Recovery capsule has an invalid server identity"
  [[ "$capsule_server_id" == "arn:aws:cloudformation:${CDK_DEFAULT_REGION}:${CDK_DEFAULT_ACCOUNT}:stack/${STACK_NAME}/"* ]] || \
    error_exit "Recovery capsule belongs to a different AWS account, region, or stack"
  [[ "$capsule_checkpoint" =~ ^(0|[1-9][0-9]*)$ && "$capsule_floor" =~ ^(0|[1-9][0-9]*)$ ]] || \
    error_exit "Recovery capsule has invalid generation metadata"
  (( capsule_floor <= capsule_checkpoint )) || \
    error_exit "Recovery capsule restore floor exceeds its generation checkpoint"
  [[ -n "$capsule_keys" ]] || error_exit "Recovery capsule has no verifier key IDs"
  [[ "$capsule_digest" =~ ^[a-f0-9]{64}$ ]] || error_exit "Recovery capsule has no canonical content digest"

  export MC_BACKUP_RECOVERY_CAPSULE_ADOPTED=true
  export MC_BACKUP_SERVER_IDENTITY="$capsule_server_id"
  export MC_BACKUP_RECOVERY_CAPSULE_KEY_IDS="$capsule_keys"
  export MC_BACKUP_RECOVERY_CAPSULE_CHECKPOINT_GENERATION="$capsule_checkpoint"
  export MC_BACKUP_RECOVERY_CAPSULE_FLOOR_GENERATION="$capsule_floor"
  export MC_BACKUP_RECOVERY_CAPSULE_DIGEST="$capsule_digest"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_ADOPTED" "true"
  write_env_files "MC_BACKUP_SERVER_IDENTITY" "$capsule_server_id"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_KEY_IDS" "$capsule_keys"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_CHECKPOINT_GENERATION" "$capsule_checkpoint"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_FLOOR_GENERATION" "$capsule_floor"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_DIGEST" "$capsule_digest"
  success "Validated explicit authenticated recovery capsule adoption (key IDs and generation floor preserved)"
}

adopt_backup_recovery_capsule_state() {
  [[ -n "${MC_BACKUP_RECOVERY_CAPSULE_FILE:-}" ]] || return 0
  if [[ "${MC_AWS_FRESH_STACK:-false}" == "true" ]]; then
    export MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED=true
    write_env_files "MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED" "true"
    success "Deferred recovery-capsule adoption until the fresh stack creates its operation-state table"
    return 0
  fi
  local result adopted_server adopted_checkpoint adopted_floor effective_checkpoint effective_floor adopted_keys verifier_hash keyring_hash effective_checkpoint_backup_id effective_floor_backup_id adopted_digest adopted_verifier
  # The adoption command owns the retained SSM recovery claim for its whole
  # transaction. Do not split this into separate probe/write commands: a crash
  # or response loss must be safe to rerun without the replacement table.
  result="$(run_with_mise pnpm exec tsx scripts/setup/adopt-backup-recovery-capsule.ts \
    --capsule "$MC_BACKUP_RECOVERY_CAPSULE_FILE" \
    --account "$CDK_DEFAULT_ACCOUNT" \
    --region "$CDK_DEFAULT_REGION" \
    --stack "$STACK_NAME")" || error_exit "Authenticated recovery capsule import failed; deployment was not started"
  IFS=$'\t' read -r adopted_server adopted_checkpoint adopted_floor effective_checkpoint effective_floor adopted_keys verifier_hash keyring_hash effective_checkpoint_backup_id effective_floor_backup_id adopted_digest adopted_verifier <<< "$result"
  [[ "$adopted_server" == "$MC_BACKUP_SERVER_IDENTITY" && "$adopted_keys" == "$MC_BACKUP_RECOVERY_CAPSULE_KEY_IDS" ]] || \
    error_exit "Recovery capsule import returned identity or key IDs different from its authenticated contents"
  [[ "$effective_floor" =~ ^(0|[1-9][0-9]*)$ && "$effective_checkpoint" =~ ^(0|[1-9][0-9]*)$ && "$effective_floor" -le "$effective_checkpoint" ]] || \
    error_exit "Recovery capsule import returned an invalid monotonic state floor"
  [[ "$verifier_hash" =~ ^[a-f0-9]{64}$ && "$keyring_hash" =~ ^[a-f0-9]{64}$ ]] || \
    error_exit "Recovery capsule import returned invalid verifier metadata"
  [[ "$adopted_digest" == "$MC_BACKUP_RECOVERY_CAPSULE_DIGEST" ]] || \
    error_exit "Recovery capsule import returned a digest different from its authenticated contents"
  [[ -n "$adopted_verifier" ]] || error_exit "Recovery capsule import returned no verifier metadata"
  export MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_GENERATION="$effective_checkpoint"
  export MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_GENERATION="$effective_floor"
  export MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_SHA256="$verifier_hash"
  export MC_BACKUP_RECOVERY_CAPSULE_KEYRING_SHA256="$keyring_hash"
  export MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_METADATA="$adopted_verifier"
  export MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_BACKUP_ID="$effective_checkpoint_backup_id"
  export MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_BACKUP_ID="$effective_floor_backup_id"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_GENERATION" "$effective_checkpoint"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_GENERATION" "$effective_floor"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_SHA256" "$verifier_hash"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_KEYRING_SHA256" "$keyring_hash"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_METADATA" "$adopted_verifier"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_BACKUP_ID" "$effective_checkpoint_backup_id"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_BACKUP_ID" "$effective_floor_backup_id"
  write_env_files "MC_BACKUP_RECOVERY_CAPSULE_DIGEST" "$adopted_digest"
  success "Imported authenticated recovery capsule state into authoritative SSM (key material omitted)"
}

print_deployment_preflight() {
  step "Deployment preflight — chargeable resources"
  log "Review the target and expected resources before deployment:"
  log "  AWS account: ${CDK_DEFAULT_ACCOUNT}"
  log "  AWS region:  ${CDK_DEFAULT_REGION}"
  log "  Stack:       ${STACK_NAME}"
  log "  EC2:         t4g.medium (ARM), 8 GB encrypted GP3 root volume"
  log "  AWS:         VPC/networking, EC2/EBS, Lambda, IAM, SSM, CloudWatch alarms/logs, SNS, SQS, and optional schedules/SES"
  log "  Cloudflare:  Worker, runtime-state bindings/KV, secrets, and optional DNS/route resources"
  log "  Backups:     scheduled Drive backup ${MC_SCHEDULED_BACKUP_ENABLED:-false} (${MC_SCHEDULED_BACKUP_SCHEDULE:-cron(0 5 ? * SUN *)})"
   if [[ "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTED:-false}" == "true" && "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED:-false}" != "true" ]]; then
    log "  Recovery:    explicitly adopting authenticated capsule; old signed archives and anti-replay floor retained"
  else
    log "  Recovery:    new authenticated capsule identity; existing capsule parameters require explicit adoption"
  fi
  if [[ -n "${MC_ALARM_EMAIL:-}" ]]; then
    log "  Alerts:      SNS confirmation will be required for ${MC_ALARM_EMAIL}"
  else
    log "  Alerts:      SNS topic/alarms only; no email subscription configured"
  fi
  echo ""
  log "Estimated recurring cost (not a quote):"
  log "  Running EC2 is roughly \$0.03–0.04/hour and a stopped 8 GB GP3 volume roughly \$0.75/month."
  log "  CloudWatch alarms/custom metrics and retained logs can add roughly \$1–3/month at low volume."
  log "  EventBridge, SNS email, SQS, SSM, and scheduled Lambda requests are usually pennies at this cadence."
  log "  Region, usage, snapshots, data transfer, requests, optional services, and pricing changes add cost."
  echo ""
  log "Teardown: run 'pnpm destroy' to preview, then 'pnpm destroy:execute' after reviewing the inventory."
  log "Default teardown relies on separately verified Google Drive backups and creates no snapshot."
  log "An explicitly requested final EBS snapshot is retained and billed until you remove it deliberately."
  echo ""

  local confirmation=""
  if is_tty; then
    read -r -p "Type DEPLOY to create or update these resources: " confirmation
  else
    read -r confirmation || true
  fi

  if [[ "$confirmation" != "DEPLOY" ]]; then
    error_exit "Deployment cancelled. Re-run setup and type DEPLOY at the chargeable-resource preflight."
  fi

  success "Deployment explicitly confirmed"
}

maybe_confirm_existing_credentials() {
  SKIP_WIZARD="0"

  if [[ ! -f "$PRODUCTION_ENV_FILE" ]]; then
    return 0
  fi

  load_env_file "$PRODUCTION_ENV_FILE" || true

  if [[ -z "${MC_CONNECTION_MODE:-}" ]]; then
    MC_CONNECTION_MODE="$(resolve_minecraft_connection_mode)"
    export MC_CONNECTION_MODE
  fi

  # Only offer skipping the wizard when the repo already has .env.production.
  local missing
  missing="$(get_missing_required_credentials | tr '\n' ' ')"

  if [[ -n "${missing// /}" ]]; then
    return 0
  fi

  screen_clear
  step "Configuration Detected"
  log "All required credentials appear to already be set in $PRODUCTION_ENV_FILE."
  log "Press Enter to accept them and deploy (AWS + Cloudflare), or type 'wizard' to review/update."
  echo ""
  log "Detected:"
  log "  AWS_REGION=$AWS_REGION"
  log "  GOOGLE_CLIENT_ID=$(mask_value "$GOOGLE_CLIENT_ID")"
  log "  GOOGLE_CLIENT_SECRET=$(mask_value "$GOOGLE_CLIENT_SECRET")"
  log "  ADMIN_EMAIL=$ADMIN_EMAIL"
  log "  MC_CONNECTION_MODE=$MC_CONNECTION_MODE"
  case "$MC_CONNECTION_MODE" in
    cloudflare)
      log "  CLOUDFLARE_DNS_API_TOKEN=$(mask_value "$CLOUDFLARE_DNS_API_TOKEN")"
      log "  CLOUDFLARE_ZONE_ID=$(mask_value "$CLOUDFLARE_ZONE_ID")"
      log "  CLOUDFLARE_MC_DOMAIN=$CLOUDFLARE_MC_DOMAIN"
      ;;
    duckdns)
      log "  DUCKDNS_DOMAIN=$DUCKDNS_DOMAIN"
      log "  DUCKDNS_TOKEN=$(mask_value "$DUCKDNS_TOKEN")"
      ;;
    raw_ip)
      log "  Minecraft connection uses the public IP shown in the panel"
      ;;
  esac
  log "  PANEL_HOSTING_MODE=$PANEL_HOSTING_MODE"
  if [[ "$PANEL_HOSTING_MODE" == "workers_dev" ]]; then
    log "  CLOUDFLARE_WORKERS_SUBDOMAIN=$CLOUDFLARE_WORKERS_SUBDOMAIN"
  else
    log "  CLOUDFLARE_PANEL_ZONE_ID=$(mask_value "$CLOUDFLARE_PANEL_ZONE_ID")"
    log "  PANEL_WORKERS_DEV_ENABLED=$PANEL_WORKERS_DEV_ENABLED"
  fi
  log "  NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL"
  log "  MC_SERVER_PROFILE_DIR=${MC_SERVER_PROFILE_DIR:-auto (server-profile when present, otherwise config)}"
  log "  MC_SERVER_PROFILE_APPROVED_EXTERNAL_PATH=${MC_SERVER_PROFILE_APPROVED_EXTERNAL_PATH:-unset (required only for external profiles)}"
  log "  MC_SCHEDULED_BACKUP_ENABLED=${MC_SCHEDULED_BACKUP_ENABLED:-false}"
  log "  MC_ALARM_EMAIL=${MC_ALARM_EMAIL:-not configured}"
  echo ""

  if is_tty; then
    read -r -p "> " choice
    if [[ "${choice}" == "wizard" ]]; then
      SKIP_WIZARD="0"
    else
      SKIP_WIZARD="1"
    fi
  else
    SKIP_WIZARD="1"
  fi
}

# Check if a command exists
command_exists() {
  command -v "$1" &> /dev/null
}

activate_mise_for_current_shell() {
  if ! command_exists mise; then
    return 1
  fi

  return 0
}

run_with_mise() {
  if ! command_exists mise; then
    error_exit "mise is required but not available in PATH"
  fi

  mise exec -- "$@"
}

verify_pinned_tool_versions() {
  local actual_node_version
  local actual_pnpm_version

  actual_node_version="$(run_with_mise node --version | tr -d 'v')"
  actual_pnpm_version="$(run_with_mise pnpm --version)"

  if [[ -n "$NODE_VERSION_PIN" && "$actual_node_version" != "$NODE_VERSION_PIN" ]]; then
    error_exit "Expected Node.js $NODE_VERSION_PIN from $TOOL_VERSIONS_FILE but found $actual_node_version"
  fi

  if [[ -n "$PNPM_VERSION_PIN" && "$actual_pnpm_version" != "$PNPM_VERSION_PIN" ]]; then
    error_exit "Expected pnpm $PNPM_VERSION_PIN from $TOOL_VERSIONS_FILE but found $actual_pnpm_version"
  fi
}

print_mise_shell_hint() {
  echo ""
  info "Optional: enable mise automatically in future shells:"
  info "  zsh:  echo 'eval \"\$(mise activate zsh)\"' >> ~/.zshrc"
  info "  bash: echo 'eval \"\$(mise activate bash)\"' >> ~/.bashrc"
  info "  fish: echo 'mise activate fish | source' >> ~/.config/fish/config.fish"
  echo ""
}

# Print error and exit
error_exit() {
  log "❌ Error: $*"
  exit 1
}

# Print success message
success() {
  log "✅ $*"
}

# Print info message
info() {
  log "ℹ️  $*"
}

# Print step header
step() {
  echo ""
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "📋 $*"
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Main setup process
main() {
  step "Welcome to mc-aws Setup"
  log "This script will guide you through the initial setup process."
  log "Please ensure you have your AWS credentials and other required information ready."

  # Step 1: Install the repository-pinned mise binary before reading any
  # credential-bearing environment file. Never replace this with a curl pipe.
  step "Setting up mise (version manager)"

  local mise_install_dir="$HOME/.local/bin"
  if ! env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" bash ./scripts/setup/bootstrap-mise.sh install; then
    error_exit "Failed to install the checksum-verified repository-pinned mise release. Review config/mise-pins.json and retry."
  fi
  export PATH="$mise_install_dir:$PATH"
  success "Verified repository-pinned mise: $(mise --version)"

  if ! activate_mise_for_current_shell; then
    error_exit "mise is installed but could not be prepared for this setup session. Restart your terminal and re-run ./setup.sh"
  fi

  print_mise_shell_hint

  # Step 2: Install tools with mise
  step "Installing Node.js and pnpm with mise"
  log "Running 'mise install' to ensure correct versions..."
  mise install
  verify_pinned_tool_versions
  success "Node.js and pnpm are ready"
  info "Pinned toolchain: Node.js ${NODE_VERSION_PIN:-unknown}, pnpm ${PNPM_VERSION_PIN:-unknown}"

  # Step 3: Install project dependencies
  step "Installing project dependencies"
  log "Running 'pnpm install --frozen-lockfile' in project root..."
  run_with_mise pnpm install --frozen-lockfile
  run_with_mise pnpm repo:doctor -- --toolchain-only
  success "Project dependencies installed"

  # Step 4: Validate AWS/CDK tooling
  step "Validating AWS + CDK tooling"
  if ! command_exists aws; then
    error_exit "AWS CLI is not installed. Install it, then re-run ./setup.sh\n\n  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
  if ! run_with_mise pnpm exec cdk --version >/dev/null 2>&1; then
    error_exit "CDK CLI is not available. Ensure 'pnpm install --frozen-lockfile' completed successfully, then re-run ./setup.sh"
  fi
  success "AWS CLI + CDK detected"

  # Credential env loading starts only after mise, Node.js, pnpm, dependencies,
  # and CDK tooling are pinned and verified.
  maybe_confirm_existing_credentials

  # A clean clone must establish player access before collecting credentials or creating cloud resources.
  load_env_file "$PRODUCTION_ENV_FILE" || true
  if [[ -z "${MC_SERVER_PROFILE_DIR:-}" && ! -e "server-profile" && ! -L "server-profile" ]]; then
    run_with_mise pnpm profile:init
    error_exit "Created server-profile/. Add at least one Minecraft UUID/name to server-profile/whitelist.json, run 'pnpm profile:validate', then re-run ./setup.sh"
  fi
  run_with_mise pnpm profile:validate

  # Step 5: Run setup wizard (unless credentials already present)
  if [[ "${SKIP_WIZARD}" == "1" ]]; then
    step "Skipping interactive setup wizard"
    success "Using credentials from $PRODUCTION_ENV_FILE"

    # Production env file is already in place
  else
    step "Starting interactive setup wizard"
    log "Launching scripts/setup/setup-wizard.sh..."
    if [ ! -f "scripts/setup/setup-wizard.sh" ]; then
      error_exit "Setup wizard script not found at scripts/setup/setup-wizard.sh"
    fi

    # Make sure the wizard is executable
    chmod +x scripts/setup/setup-wizard.sh

    # Tell the wizard we're returning here after it finishes
    run_with_mise env MC_AWS_SETUP_RETURN_TO_SETUP_SH=1 bash ./scripts/setup/setup-wizard.sh
  fi

  # Reload env for the deploy steps below
  load_env_file "$PRODUCTION_ENV_FILE" || true
  if ! ensure_auth_secret; then
    error_exit "AUTH_SECRET is not production-safe. Re-run the wizard to generate it, or explicitly rotate all panel sessions with MC_AWS_ROTATE_AUTH_SECRET=1 ./setup.sh. The secret will not be printed."
  fi
  if ! ensure_cdk_defaults; then
    error_exit "AWS CLI credentials are unavailable. Run 'aws sso login' (recommended) or configure local deployment credentials, then re-run ./setup.sh"
  fi
  STACK_NAME="${STACK_NAME:-MinecraftStack}"

  step "Checking SES inbound-command prerequisites"
  if ! run_with_mise pnpm exec tsx scripts/setup/ses-preflight.ts; then
    error_exit "SES inbound-command prerequisites are not ready. No deployment changes were made; review docs/setup/SES_SETUP.md and re-run setup."
  fi

  step "Resolving immutable Amazon Linux 2023 image"
  if ! ensure_al2023_ami_pin; then
    error_exit "Could not validate or persist the exact ARM64 Amazon Linux 2023 AMI pin. Existing pins are never refreshed automatically; use the reviewed pnpm ami:upgrade workflow for an intentional change."
  fi
  success "Validated exact ARM64 AL2023 AMI pin: $AL2023_ARM64_AMI_ID"

  step "Validating reviewed bootstrap artifact pins"
  if ! ensure_bootstrap_artifact_pins; then
    error_exit "Bootstrap artifact pins are invalid or differ from user_data.sh. Review config/bootstrap-pins.json and use the intentional pnpm bootstrap:upgrade workflow."
  fi
  success "Validated and persisted bootstrap pin set: $MC_BOOTSTRAP_PINS_SHA256"

  # Step 6: Deploy AWS infrastructure (CDK)
  step "Deploying AWS infrastructure (CDK)"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
  export CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-$AWS_REGION}"
  run_with_mise pnpm clean:cdk
  CDK_TEMP_DIR="$PWD/.local-artifacts/cdk-tmp"
  mkdir -p "$CDK_TEMP_DIR"

  local stack_state="unknown"
  local existing_stack_id=""
  local setup_claim_token=""
  local stack_probe
  if stack_probe="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].StackId" --output text 2>&1)"; then
    stack_state="existing"
    existing_stack_id="$stack_probe"
  elif [[ "$stack_probe" == *"does not exist"* ]]; then
    stack_state="absent"
  else
    error_exit "Could not determine whether CloudFormation stack '$STACK_NAME' already exists: $stack_probe"
  fi

  if [[ "$stack_state" == "absent" ]]; then
    setup_claim_token="$(node - "$DEPLOYMENT_MANIFEST_FILE" <<'NODE'
const fs=require("node:fs"), crypto=require("node:crypto"), path=process.argv[2];
if (!fs.existsSync(path)) process.stdout.write(crypto.randomUUID());
else {
  const token=JSON.parse(fs.readFileSync(path,"utf8")).aws?.stack?.claimToken;
  process.stdout.write(typeof token === "string" && /^[a-f0-9-]{36}$/.test(token) ? token : crypto.randomUUID());
}
NODE
)"
  else
    setup_claim_token="$(node - "$DEPLOYMENT_MANIFEST_FILE" <<'NODE'
const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2],"utf8")).aws?.stack?.claimToken||"");
NODE
)"
    [[ "$setup_claim_token" =~ ^[a-f0-9-]{36}$ ]] || error_exit "Existing stack has no durable ownership claim token; refusing adoption"
    local live_setup_claim_token
    live_setup_claim_token="$(aws cloudformation describe-stacks --stack-name "$existing_stack_id" \
      --query 'Stacks[0].Tags[?Key==`McAwsClaimToken`].Value | [0]' --output text 2>/dev/null || true)"
    [[ "$live_setup_claim_token" == "$setup_claim_token" ]] || error_exit "Existing stack claim tag does not match the deployment manifest; refusing concurrent ownership"
  fi
  export MC_AWS_SETUP_CLAIM_TOKEN="$setup_claim_token"
  export MC_AWS_FRESH_STACK="$([[ "$stack_state" == "absent" ]] && printf true || printf false)"
  export MC_AWS_SETUP_LOCK_FILE="$CDK_TEMP_DIR/mc-aws-setup.lock"

  (
    unset CLOUDFLARE_API_TOKEN
    TMPDIR="$CDK_TEMP_DIR" run_with_mise pnpm exec tsx scripts/aws/migrate-existing-deployment.ts \
      --assert-standard-deploy-safe \
      --account "$CDK_DEFAULT_ACCOUNT" \
      --stack-name "$STACK_NAME" \
      --region "$CDK_DEFAULT_REGION"
  )

  # Complete every ownership probe before aws-init. aws-init is the first
  # command allowed to create deployment-manifest provenance; no ambiguous AWS
  # response may be converted into a false "absent" observation first.
  prepare_backup_recovery_capsule_adoption
  local -a ssm_observations=()
  local ssm_observation
  local ssm_name ssm_metadata ssm_state ssm_type
  local -a installation_ssm_names=(
    /minecraft/gdrive-token
    /minecraft/backup-auth-keyring
    /minecraft/backup-server-identity
    /minecraft/backup-generation-checkpoint
    /minecraft/restore-generation-floor
    /minecraft/backup-transfer-authorization
     /minecraft/backup-verifier-metadata
     /minecraft/backup-recovery-adoption-lock
    /minecraft/cloudflare-api-token
    /minecraft/duckdns-token
    /minecraft/email-allowlist
    /minecraft/verified-sender
    /minecraft/notification-email
    /minecraft/startup-triggered-by
    /minecraft/player-count
    /minecraft/backups-cache
    /minecraft/last-scheduled-backup-success
    /minecraft/scheduled-backup-enabled-at
    /minecraft/server-action
    /minecraft/resume-pending
    /minecraft/server-profile-manifest
     /minecraft/cloudflare-zone-id
     /minecraft/cloudflare-domain
     /minecraft/duckdns-domain
     /minecraft/dns-mode
     /minecraft/github-pat
    /minecraft/github-user
    /minecraft/github-repo
  )
  for ssm_name in "${installation_ssm_names[@]}"; do
    ssm_observation="$(probe_ssm_parameter "$ssm_name")"
    ssm_observations+=("$ssm_observation")
  done
  for ssm_name in /minecraft/operations /minecraft/server-action-delete-claim; do
    ssm_observation="$(probe_ssm_namespace "$ssm_name")"
    ssm_observations+=("$ssm_observation")
  done
  for ssm_observation in "${ssm_observations[@]}"; do
    IFS=$'\t' read -r ssm_name ssm_state ssm_type <<< "$ssm_observation"
    case "$ssm_name" in
       /minecraft/backup-auth-keyring|/minecraft/backup-server-identity|/minecraft/backup-generation-checkpoint|/minecraft/restore-generation-floor|/minecraft/backup-verifier-metadata|/minecraft/backup-recovery-adoption-lock)
        if [[ "$ssm_state" == "existing" && "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTED:-false}" != "true" ]]; then
          error_exit "Existing recovery-capsule parameter '$ssm_name' requires explicit MC_BACKUP_RECOVERY_CAPSULE_FILE adoption"
        fi
        ;;
    esac
  done
  success "Completed fail-closed pre-deployment SSM ownership probes"

  # Existing-stack capsules are imported only after all ownership probes succeed
  # and before deployment provenance is initialized. For a fresh stack, the
  # capsule is deliberately deferred until the operation-state table is
  # available after CDK deployment. The importer atomically claims the retained
  # account-scoped SSM recovery lock, authenticates the MAC, account/server
  # binding, complete keyring, and monotonic state, then rolls back
  # newly-created records if any SSM write fails.
  adopt_backup_recovery_capsule_state

  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs aws-init \
    --account "$CDK_DEFAULT_ACCOUNT" \
    --region "$CDK_DEFAULT_REGION" \
    --stack "$STACK_NAME" \
    --stack-state "$stack_state" \
     --stack-id "${existing_stack_id:-unknown}" \
     --claim-token "$setup_claim_token" \
     --claim-observed "$([[ "$stack_state" == "existing" ]] && printf true || printf false)"
  success "Local deployment record initialized: $DEPLOYMENT_MANIFEST_FILE"
  if [[ "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTED:-false}" == "true" && "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED:-false}" != "true" ]]; then
    MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs \
      recovery-capsule --status adopted \
      --checkpoint-generation "$MC_BACKUP_RECOVERY_CAPSULE_CHECKPOINT_GENERATION" \
       --floor-generation "$MC_BACKUP_RECOVERY_CAPSULE_FLOOR_GENERATION" \
       --capsule-digest "$MC_BACKUP_RECOVERY_CAPSULE_DIGEST" \
       --verifier-sha256 "$MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_SHA256" \
       --keyring-sha256 "$MC_BACKUP_RECOVERY_CAPSULE_KEYRING_SHA256" \
       --preserved-at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >/dev/null
    success "Recorded explicit recovery-capsule adoption in the deployment manifest"
  fi

  # Record the already-completed observations only after all probes succeeded.
  # Existing observations remain monotonic across setup reruns.
  for ssm_observation in "${ssm_observations[@]}"; do
    IFS=$'\t' read -r ssm_name ssm_state ssm_type <<< "$ssm_observation"
    MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs ssm-observe \
      --name "$ssm_name" --state "$ssm_state" --type "$ssm_type" >/dev/null
  done
  success "Recorded pre-deployment SSM ownership facts"

  print_deployment_preflight
  if ! run_with_mise pnpm backup-auth:keyring -- provision --key-id "initial-$(date -u '+%Y-%m')"; then
    error_exit "Could not provision the backup authentication SecureString; secret values were omitted."
  fi
  local dns_materialization_output dns_name dns_action dns_version
  if ! dns_materialization_output="$(MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise pnpm exec tsx scripts/setup/materialize-dns-secrets.ts)"; then
    error_exit "Could not materialize the selected DNS credential as an SSM SecureString; secret values were omitted."
  fi
  while IFS=$'\t' read -r dns_name dns_action dns_version; do
    [[ "$dns_action" == "created" && "$dns_version" =~ ^[1-9][0-9]*$ ]] || continue
    MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs ssm-claim \
      --name "$dns_name" --type SecureString --claim-token "$setup_claim_token" --resource-version "$dns_version" >/dev/null
  done <<< "$dns_materialization_output"
  (
    cd infra
    unset CLOUDFLARE_API_TOKEN
    TMPDIR="$CDK_TEMP_DIR" run_with_mise pnpm exec cdk deploy "$STACK_NAME" --require-approval never
  )
  success "CDK deployment complete"

  # Step 7: Capture INSTANCE_ID from stack outputs
  step "Capturing deployment outputs"
  INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [[ -z "${INSTANCE_ID:-}" || "${INSTANCE_ID}" == "None" ]]; then
    error_exit "Could not read InstanceId output from CloudFormation stack '$STACK_NAME'"
  fi
  success "INSTANCE_ID=$INSTANCE_ID"

  MC_LIFECYCLE_LOCK_TABLE_NAME="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='LifecycleLockTableName'].OutputValue | [0]" --output text 2>/dev/null || true)"
  MC_OPERATION_STATE_TABLE_NAME="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='OperationStateTableName'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [[ -z "$MC_LIFECYCLE_LOCK_TABLE_NAME" || "$MC_LIFECYCLE_LOCK_TABLE_NAME" == "None" || -z "$MC_OPERATION_STATE_TABLE_NAME" || "$MC_OPERATION_STATE_TABLE_NAME" == "None" ]]; then
    error_exit "Could not read lifecycle DynamoDB table outputs from CloudFormation stack '$STACK_NAME'"
  fi

  RUNTIME_IAM_USER_NAME="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='WorkerRuntimeIamUserName'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [[ -z "${RUNTIME_IAM_USER_NAME:-}" || "${RUNTIME_IAM_USER_NAME}" == "None" ]]; then
    error_exit "Could not locate dedicated Worker runtime IAM identity in stack '$STACK_NAME'"
  fi
  export RUNTIME_IAM_USER_NAME
  success "Dedicated Worker runtime identity located: $RUNTIME_IAM_USER_NAME"

  STACK_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].StackId" --output text 2>/dev/null || true)"
  if [[ -z "${STACK_ID:-}" || "${STACK_ID}" == "None" ]]; then
    error_exit "Could not read StackId for CloudFormation stack '$STACK_NAME'"
  fi

  local live_claim_token
  live_claim_token="$(aws cloudformation describe-stacks --stack-name "$STACK_ID" \
    --query 'Stacks[0].Tags[?Key==`McAwsClaimToken`].Value | [0]' --output text 2>/dev/null || true)"
  [[ "$live_claim_token" == "$setup_claim_token" ]] || error_exit "CloudFormation did not prove the exact setup ownership claim; refusing to mark the stack project-owned"

  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs aws-deployed \
    --stack-id "$STACK_ID" \
    --instance-id "$INSTANCE_ID" \
    --runtime-user "$RUNTIME_IAM_USER_NAME" \
    --claim-token "$setup_claim_token" \
    --claim-observed true

  while IFS=$'\t' read -r ssm_logical_id ssm_name; do
    [[ -n "$ssm_logical_id" && -n "$ssm_name" ]] || continue
    ssm_type="$(aws ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=$ssm_name" \
      --query 'Parameters[0].Type' --output text)"
    MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs ssm-stack-resource \
      --name "$ssm_name" --type "$ssm_type" --logical-id "$ssm_logical_id" --stack-id "$STACK_ID" >/dev/null
  done < <(aws cloudformation list-stack-resources --stack-name "$STACK_ID" \
    --query 'StackResourceSummaries[?ResourceType==`AWS::SSM::Parameter`].[LogicalResourceId,PhysicalResourceId]' --output text)

  # Update env files with INSTANCE_ID for Cloudflare deploy
  write_env_files "INSTANCE_ID" "$INSTANCE_ID"
  write_env_files "MC_LIFECYCLE_LOCK_TABLE_NAME" "$MC_LIFECYCLE_LOCK_TABLE_NAME"
  write_env_files "MC_OPERATION_STATE_TABLE_NAME" "$MC_OPERATION_STATE_TABLE_NAME"

  if [[ "${MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED:-false}" == "true" ]]; then
    unset MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED
    write_env_files "MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED" "false"
    export MC_AWS_FRESH_STACK=false
    adopt_backup_recovery_capsule_state
    MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs \
      recovery-capsule --status adopted \
      --checkpoint-generation "$MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_GENERATION" \
      --floor-generation "$MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_GENERATION" \
      --capsule-digest "$MC_BACKUP_RECOVERY_CAPSULE_DIGEST" \
      --verifier-sha256 "$MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_SHA256" \
      --keyring-sha256 "$MC_BACKUP_RECOVERY_CAPSULE_KEYRING_SHA256" \
      --preserved-at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >/dev/null
    success "Recorded deferred recovery-capsule adoption in the deployment manifest"
  fi

  step "Pinning executor terminal receipt verifier"
  receipt_command_id="$(aws ssm send-command --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters '{"commands":["set -euo pipefail","while [[ ! -f /var/lib/mc-aws/bootstrap-complete ]]; do sleep 5; done","cat /etc/mc-agent/executor-receipt-verifier.json"]}' \
    --query 'Command.CommandId' --output text)"
  [[ "$receipt_command_id" =~ ^[A-Fa-f0-9-]{36}$ ]] || error_exit "Could not start executor verifier discovery"
  receipt_status=""
  for _ in $(seq 1 180); do
    receipt_status="$(aws ssm get-command-invocation --command-id "$receipt_command_id" --instance-id "$INSTANCE_ID" \
      --query Status --output text 2>/dev/null || true)"
    [[ "$receipt_status" == "Success" ]] && break
    [[ "$receipt_status" =~ ^(Cancelled|TimedOut|Failed|Cancelling)$ ]] && \
      error_exit "Executor verifier discovery failed with status $receipt_status"
    sleep 5
  done
  [[ "$receipt_status" == "Success" ]] || error_exit "Executor verifier discovery timed out"
  receipt_verifier="$(aws ssm get-command-invocation --command-id "$receipt_command_id" --instance-id "$INSTANCE_ID" \
    --query StandardOutputContent --output text)"
  readarray -t receipt_fields < <(run_with_mise node -e \
    'const v=JSON.parse(process.argv[1]); console.log(v.keyId); console.log(v.publicKeySpki); console.log(v.keyEpoch)' "$receipt_verifier")
  (( ${#receipt_fields[@]} == 3 )) || error_exit "Executor verifier discovery returned malformed authority"
  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node scripts/shared/deployment-manifest.mjs \
    executor-receipt --key-id "${receipt_fields[0]}" --public-key-spki "${receipt_fields[1]}" --key-epoch "${receipt_fields[2]}" >/dev/null
  executor_receipt_verifiers="$(MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" run_with_mise node \
    scripts/shared/deployment-manifest.mjs executor-receipt-state)"
  write_env_files "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS" "$executor_receipt_verifiers"
  success "Executor terminal receipt verifier pinned with bounded rotation history"

  # Step 8: Deploy Cloudflare Workers frontend
  step "Deploying Cloudflare Workers frontend"
  if ! run_with_mise pnpm deploy:cf; then
    echo ""
    error_exit "Cloudflare deployment failed. Check the error messages above."
  fi
  success "Cloudflare deployment complete"

  step "Setup complete! 🎉"
  echo ""
  success "AWS infrastructure and the Cloudflare control panel were deployed."
  echo ""
  log "📍 Your Minecraft control panel: ${NEXT_PUBLIC_APP_URL}"
  log "📍 Minecraft connection: $(minecraft_connection_target)"
  log "🔐 Google OAuth origin: ${NEXT_PUBLIC_APP_URL%/}"
  log "🔐 Google sign-in callback: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
  log "🔐 Google Drive callback: ${NEXT_PUBLIC_APP_URL%/}/api/gdrive/callback"
  echo ""
  log "Next steps:"
  log "  1. Confirm the Google OAuth client contains the exact origin and both callbacks printed above"
  log "  2. Enable Google Drive API; while an External app is in Testing, add allowed accounts as test users"
  log "  3. Visit your control panel and sign in with the admin address: ${ADMIN_EMAIL}"
  log "  4. Wait for the already-started server to become ready, then connect to $(minecraft_connection_target)"
  log "  5. Configure and verify Google Drive before using backup, restore, or hibernate"
  if [[ -n "${MC_ALARM_EMAIL:-}" ]]; then
    log "  6. Confirm the AWS SNS subscription email sent to ${MC_ALARM_EMAIL}; alerts are silent until confirmed"
  else
    log "  6. No alarm email is configured; monitor the project CloudWatch alarms/SNS topic in AWS"
  fi
  log "  7. Check AWS Billing/Cost Explorer; preview removal at any time with: pnpm destroy"
  echo ""
}

# Run main function
if [[ "${MC_AWS_SETUP_LIBRARY_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
