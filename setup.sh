#!/usr/bin/env bash
# Main entry point for the mc-aws setup wizard
# This script verifies prerequisites and guides you through the initial setup

set -euo pipefail

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

write_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"

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

get_missing_required_credentials() {
  local required=(
    "AWS_REGION"
    "AWS_ACCESS_KEY_ID"
    "AWS_SECRET_ACCESS_KEY"
    "GOOGLE_CLIENT_ID"
    "GOOGLE_CLIENT_SECRET"
    "ADMIN_EMAIL"
    "CLOUDFLARE_DNS_API_TOKEN"
    "CLOUDFLARE_ZONE_ID"
    "CLOUDFLARE_RECORD_ID"
    "CLOUDFLARE_MC_DOMAIN"
    "NEXT_PUBLIC_APP_URL"
    "GITHUB_USER"
    "GITHUB_REPO"
    "GITHUB_TOKEN"
  )

  local missing=()
  for key in "${required[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  printf '%s\n' "${missing[@]}"
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

  write_env ".env.local" "AUTH_SECRET" "$AUTH_SECRET"
  write_env ".env.production" "AUTH_SECRET" "$AUTH_SECRET"
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

  write_env ".env.local" "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"
  write_env ".env.local" "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  write_env ".env.production" "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"
  write_env ".env.production" "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  return 0
}

maybe_confirm_existing_credentials() {
  SKIP_WIZARD="0"

  if [[ ! -f ".env.local" ]]; then
    return 0
  fi

  load_env_file ".env.local" || true

  # Only offer skipping the wizard when the repo already has .env.local.
  local missing
  missing="$(get_missing_required_credentials | tr '\n' ' ')"

  if [[ -n "${missing// /}" ]]; then
    return 0
  fi

  screen_clear
  step "Configuration Detected"
  log "All required credentials appear to already be set in .env.local."
  log "Press Enter to accept them and deploy (AWS + Cloudflare), or type 'wizard' to review/update."
  echo ""
  log "Detected:"
  log "  AWS_REGION=$AWS_REGION"
  log "  AWS_ACCESS_KEY_ID=$(mask_value "$AWS_ACCESS_KEY_ID")"
  log "  AWS_SECRET_ACCESS_KEY=$(mask_value "$AWS_SECRET_ACCESS_KEY")"
  log "  GOOGLE_CLIENT_ID=$(mask_value "$GOOGLE_CLIENT_ID")"
  log "  GOOGLE_CLIENT_SECRET=$(mask_value "$GOOGLE_CLIENT_SECRET")"
  log "  ADMIN_EMAIL=$ADMIN_EMAIL"
  log "  CLOUDFLARE_DNS_API_TOKEN=$(mask_value "$CLOUDFLARE_DNS_API_TOKEN")"
  log "  CLOUDFLARE_ZONE_ID=$(mask_value "$CLOUDFLARE_ZONE_ID")"
  log "  CLOUDFLARE_RECORD_ID=$(mask_value "$CLOUDFLARE_RECORD_ID")"
  log "  CLOUDFLARE_MC_DOMAIN=$CLOUDFLARE_MC_DOMAIN"
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

  # Step 1: Check for mise
  step "Checking for mise installation"
  if ! command_exists mise; then
    error_exit "mise is not installed!

Please install mise to manage Node.js and pnpm versions:

  macOS:
    brew install mise

  Linux:
    curl https://mise.run | sh

  Windows (WSL):
    curl https://mise.run | sh

After installation, restart your terminal and run this script again.

For more information, visit: https://mise.jdx.dev/"
  fi
  success "mise is installed: $(mise --version)"

  # Step 2: Install tools with mise
  step "Installing Node.js and pnpm with mise"
  log "Running 'mise install' to ensure correct versions..."
  mise install
  success "Node.js and pnpm are ready"

  # Step 3: Install project dependencies
  step "Installing project dependencies"
  log "Running 'pnpm install' in project root..."
  pnpm install
  success "Project dependencies installed"

  # Step 4: Validate AWS/CDK tooling
  step "Validating AWS + CDK tooling"
  if ! command_exists aws; then
    error_exit "AWS CLI is not installed. Install it, then re-run ./setup.sh\n\n  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
  if ! pnpm exec cdk --version >/dev/null 2>&1; then
    error_exit "CDK CLI is not available. Ensure 'pnpm install' completed successfully, then re-run ./setup.sh"
  fi
  success "AWS CLI + CDK detected"

  # Step 5: Run setup wizard (unless credentials already present)
  if [[ "${SKIP_WIZARD}" == "1" ]]; then
    step "Skipping interactive setup wizard"
    success "Using credentials from .env.local"

    if [[ ! -f ".env.production" ]]; then
      cp .env.local .env.production
      success "Created .env.production from .env.local"
    fi
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
  load_env_file ".env.local" || true

  # Step 6: Deploy AWS infrastructure (CDK)
  step "Deploying AWS infrastructure (CDK)"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
  export CDK_DEFAULT_REGION="${CDK_DEFAULT_REGION:-$AWS_REGION}"

  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    error_exit "GITHUB_TOKEN is required for CDK deploy (used to seed SSM). Run the wizard and set it, then re-run ./setup.sh"
  fi

  (cd infra && pnpm exec cdk deploy --parameters GithubTokenParam="$GITHUB_TOKEN" --require-approval never)
  success "CDK deployment complete"

  # Step 7: Capture INSTANCE_ID from stack outputs
  step "Capturing deployment outputs"
  STACK_NAME="${STACK_NAME:-MinecraftStack}"
  INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [[ -z "${INSTANCE_ID:-}" || "${INSTANCE_ID}" == "None" ]]; then
    error_exit "Could not read InstanceId output from CloudFormation stack '$STACK_NAME'"
  fi
  success "INSTANCE_ID=$INSTANCE_ID"

  # Update env files with INSTANCE_ID for Cloudflare deploy
  write_env ".env.local" "INSTANCE_ID" "$INSTANCE_ID"
  write_env ".env.production" "INSTANCE_ID" "$INSTANCE_ID"

  # Step 8: Deploy Cloudflare Workers frontend
  step "Deploying Cloudflare Workers frontend"
  if ! pnpm deploy:cf; then
    echo ""
    error_exit "Cloudflare deployment failed. Check the error messages above."
  fi
  success "Cloudflare deployment complete"

  step "Setup complete! 🎉"
  echo ""
  success "mc-aws is fully deployed and ready to use!"
  echo ""
  log "📍 Your Minecraft control panel: https://${NEXT_PUBLIC_APP_URL#https://}"
  log "📍 Minecraft server domain: ${CLOUDFLARE_MC_DOMAIN}"
  echo ""
  log "Next steps:"
  log "  1. Visit your control panel and sign in with: ${ADMIN_EMAIL}"
  log "  2. Start your Minecraft server from the panel"
  log "  3. Connect to ${CLOUDFLARE_MC_DOMAIN} in Minecraft"
  echo ""
}

# Run main function
main "$@"
