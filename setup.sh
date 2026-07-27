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
  tmp="$(mktemp "${env_file}.tmp.XXXXXX")"

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
    "PANEL_HOSTING_MODE"
    "NEXT_PUBLIC_APP_URL"
    "GITHUB_USER"
    "GITHUB_REPO"
    "GITHUB_TOKEN"
  )
  local missing=()

  if [[ -n "${MC_CONNECTION_MODE:-}" && ! "${MC_CONNECTION_MODE}" =~ ^(cloudflare|duckdns|raw_ip)$ ]]; then
    missing+=("MC_CONNECTION_MODE")
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
        "CLOUDFLARE_PANEL_DNS_API_TOKEN"
        "CLOUDFLARE_PANEL_ZONE_ID"
        "PANEL_WORKERS_DEV_ENABLED"
      )
      if [[ -n "${PANEL_WORKERS_DEV_ENABLED:-}" && ! "${PANEL_WORKERS_DEV_ENABLED}" =~ ^(true|false)$ ]]; then
        missing+=("PANEL_WORKERS_DEV_ENABLED")
      fi
      ;;
    *)
      if [[ -n "${PANEL_HOSTING_MODE:-}" ]]; then
        missing+=("PANEL_HOSTING_MODE")
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

resolve_minecraft_connection_mode() {
  case "${MC_CONNECTION_MODE:-}" in
    cloudflare|duckdns|raw_ip)
      printf '%s\n' "$MC_CONNECTION_MODE"
      return
      ;;
  esac

  if [[ -n "${CLOUDFLARE_MC_DOMAIN:-}" || -n "${CLOUDFLARE_DNS_API_TOKEN:-}" || -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
    printf '%s\n' "cloudflare"
  elif [[ -n "${DUCKDNS_DOMAIN:-}" || -n "${DUCKDNS_TOKEN:-}" ]]; then
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
  if [[ -n "${AUTH_SECRET:-}" ]]; then
    return 0
  fi

  # Generate a strong secret (used by the app for auth/session signing)
  if command -v openssl >/dev/null 2>&1; then
    AUTH_SECRET="$(openssl rand -base64 48)"
    export AUTH_SECRET
  elif command -v node >/dev/null 2>&1; then
    AUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
    export AUTH_SECRET
  else
    return 1
  fi

  write_env_files "AUTH_SECRET" "$AUTH_SECRET"
  return 0
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

print_deployment_preflight() {
  step "Deployment preflight — chargeable resources"
  log "Review the target and expected resources before deployment:"
  log "  AWS account: ${CDK_DEFAULT_ACCOUNT}"
  log "  AWS region:  ${CDK_DEFAULT_REGION}"
  log "  Stack:       ${STACK_NAME}"
  log "  EC2:         t4g.medium (ARM), 8 GB encrypted GP3 root volume"
  log "  AWS:         VPC/networking, EC2/EBS, Lambda, IAM, SSM, and optional SES/SNS resources"
  log "  Cloudflare:  Worker, runtime-state bindings/KV, secrets, and optional DNS/route resources"
  echo ""
  log "Estimated recurring cost (not a quote):"
  log "  Running EC2 is roughly \$0.03–0.04/hour and a stopped 8 GB GP3 volume roughly \$0.75/month."
  log "  Region, usage, snapshots, data transfer, requests, optional services, and pricing changes add cost."
  echo ""
  log "Teardown: run 'pnpm destroy' to preview, then 'pnpm destroy:execute' after reviewing the inventory."
  log "AWS backups/snapshots may be retained and billed until you remove them deliberately."
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
  log "  GITHUB_USER=$GITHUB_USER"
  log "  GITHUB_REPO=$GITHUB_REPO"
  log "  GITHUB_TOKEN=$(mask_value "$GITHUB_TOKEN")"
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

  maybe_confirm_existing_credentials

  # Step 1: Ensure mise is installed and configured
  step "Setting up mise (version manager)"

  local mise_install_dir="$HOME/.local/bin"
  local mise_executable="$mise_install_dir/mise"

  # Check if mise is already available in PATH
  if command_exists mise; then
    success "mise is already installed: $(mise --version)"
  else
    # Check if mise is installed but not in PATH
    if [[ -f "$mise_executable" ]]; then
      info "mise is installed at $mise_executable but not in PATH"
      info "Adding mise to PATH for this session..."
      export PATH="$mise_install_dir:$PATH"
      success "mise is now available: $(mise --version)"
    else
      # Install mise
      info "mise is not installed. Installing now..."
      log "Running: curl https://mise.run | sh"
      if curl https://mise.run | sh; then
        success "mise installed successfully to $mise_install_dir"
        export PATH="$mise_install_dir:$PATH"
      else
        error_exit "Failed to install mise. Please install manually and try again."
      fi
    fi
  fi

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

  # Step 5: Run setup wizard (unless credentials already present)
  if [[ "${SKIP_WIZARD}" == "1" ]]; then
    step "Skipping interactive setup wizard"
    success "Using credentials from $PRODUCTION_ENV_FILE"

    # Production env file is already in place
  else
    step "Starting interactive setup wizard"
    log "Launching scripts/setup-wizard.sh..."
    if [ ! -f "scripts/setup-wizard.sh" ]; then
      error_exit "Setup wizard script not found at scripts/setup-wizard.sh"
    fi

    # Make sure the wizard is executable
    chmod +x scripts/setup-wizard.sh

    # Tell the wizard we're returning here after it finishes
    MC_AWS_SETUP_RETURN_TO_SETUP_SH=1 ./scripts/setup-wizard.sh
  fi

  # Reload env for the deploy steps below
  load_env_file "$PRODUCTION_ENV_FILE" || true
  if ! ensure_cdk_defaults; then
    error_exit "AWS CLI credentials are unavailable. Run 'aws sso login' (recommended) or configure local deployment credentials, then re-run ./setup.sh"
  fi

  # Step 6: Deploy AWS infrastructure (CDK)
  step "Deploying AWS infrastructure (CDK)"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
  export CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-$AWS_REGION}"
  STACK_NAME="${STACK_NAME:-MinecraftStack}"

  local stack_state="unknown"
  local existing_stack_id=""
  local stack_probe
  if stack_probe="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].StackId" --output text 2>&1)"; then
    stack_state="existing"
    existing_stack_id="$stack_probe"
  elif [[ "$stack_probe" == *"does not exist"* ]]; then
    stack_state="absent"
  else
    error_exit "Could not determine whether CloudFormation stack '$STACK_NAME' already exists: $stack_probe"
  fi

  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/deployment-manifest.mjs aws-init \
    --account "$CDK_DEFAULT_ACCOUNT" \
    --region "$CDK_DEFAULT_REGION" \
    --stack "$STACK_NAME" \
    --stack-state "$stack_state" \
    --stack-id "${existing_stack_id:-unknown}"
  success "Deployment ownership manifest initialized: $DEPLOYMENT_MANIFEST_FILE"

  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    error_exit "GITHUB_TOKEN is required for CDK deploy (used to seed SSM). Run the wizard and set it, then re-run ./setup.sh"
  fi

  cdk_parameters=(--parameters "GithubTokenParam=$GITHUB_TOKEN")
  if [[ -n "${CLOUDFLARE_DNS_API_TOKEN:-}" ]]; then
    cdk_parameters+=(--parameters "CloudflareTokenParam=$CLOUDFLARE_DNS_API_TOKEN")
  fi
  if [[ -n "${DUCKDNS_TOKEN:-}" ]]; then
    cdk_parameters+=(--parameters "DuckDnsTokenParam=$DUCKDNS_TOKEN")
  fi

  print_deployment_preflight
  (cd infra && run_with_mise pnpm exec cdk deploy "${cdk_parameters[@]}" --require-approval never)
  success "CDK deployment complete"

  # Step 7: Capture INSTANCE_ID from stack outputs
  step "Capturing deployment outputs"
  INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [[ -z "${INSTANCE_ID:-}" || "${INSTANCE_ID}" == "None" ]]; then
    error_exit "Could not read InstanceId output from CloudFormation stack '$STACK_NAME'"
  fi
  success "INSTANCE_ID=$INSTANCE_ID"

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

  MC_AWS_DEPLOYMENT_MANIFEST="$DEPLOYMENT_MANIFEST_FILE" node scripts/deployment-manifest.mjs aws-deployed \
    --stack-id "$STACK_ID" \
    --instance-id "$INSTANCE_ID" \
    --runtime-user "$RUNTIME_IAM_USER_NAME"

  # Update env files with INSTANCE_ID for Cloudflare deploy
  write_env_files "INSTANCE_ID" "$INSTANCE_ID"

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
  log "🔐 Google OAuth callback: ${NEXT_PUBLIC_APP_URL%/}/api/auth/callback"
  echo ""
  log "Next steps:"
  log "  1. Confirm the Google OAuth client contains the exact origin and callback printed above"
  log "  2. Visit your control panel and sign in with the admin address: ${ADMIN_EMAIL}"
  log "  3. Configure and verify Google Drive before using backup, restore, or hibernate"
  log "  4. Start the server (which begins EC2 compute charges), then connect to $(minecraft_connection_target)"
  log "  5. Check AWS Billing/Cost Explorer; preview removal at any time with: pnpm destroy"
  echo ""
}

# Run main function
if [[ "${MC_AWS_SETUP_LIBRARY_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
