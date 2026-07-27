#!/usr/bin/env bash
set -euo pipefail

# MC-AWS Setup Wizard
# Interactive credential collection for setting up the Minecraft server management system

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

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

  # Fallback ANSI clear
  printf '\033c' || true
}

wizard_header() {
  echo -e "${GREEN}MC-AWS Setup Wizard${NC} (Ctrl+C to exit)"
  echo -e "${BLUE}───────────────────────────────────────────────────────────────${NC}"
}

readonly WIZARD_TOTAL=10
readonly LOCAL_ENV_FILE=".env.local"
readonly PRODUCTION_ENV_FILE=".env.production"

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

mask_value() {
  local value="$1"
  local len=${#value}

  if [[ $len -le 8 ]]; then
    echo "***"
    return
  fi

  echo "${value:0:3}***${value:$((len - 3)):3}"
}

have_env() {
  local key="$1"
  [[ -n "${!key:-}" ]]
}

step_section() {
  local step_num="$1"
  shift
  section "Step ${step_num}/${WIZARD_TOTAL}: $*"
}

# Logging functions
log() {
  echo -e "${BLUE}•${NC} $*"
}

log_success() {
  echo -e "${GREEN}✓${NC} $*"
}

log_warning() {
  echo -e "${YELLOW}!${NC} $*"
}

log_error() {
  echo -e "${RED}x${NC} $*"
}

# Section header
section() {
  screen_clear
  wizard_header
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $*${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

# Prompt for input with default value
prompt() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local is_secret="${4:-false}"

  local label="$prompt_text"
  if [[ "$var_name" =~ ^[A-Z0-9_]+$ ]]; then
    label="${prompt_text} (${var_name})"
  fi

  while true; do
    if [[ -n "${default_value}" ]]; then
      if [[ "$is_secret" == "true" ]]; then
        echo -n "$label [***]: "
      else
        echo -n "$label [$default_value]: "
      fi
    else
      echo -n "$label: "
    fi

    local input
    if [[ "$is_secret" == "true" ]]; then
      read -rs input
      echo ""
    else
      read -r input
    fi

    # Use input if provided, otherwise use default
    if [[ -n "$input" ]]; then
      printf -v "$var_name" '%s' "$input"
      return 0
    elif [[ -n "${default_value}" ]]; then
      printf -v "$var_name" '%s' "${default_value}"
      return 0
    else
      log_error "This field is required. Please enter a value."
      echo ""
    fi
  done
}

# Prompt for optional input
prompt_optional() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local is_secret="${4:-false}"

  local label="$prompt_text"
  if [[ "$var_name" =~ ^[A-Z0-9_]+$ ]]; then
    label="${prompt_text} (${var_name})"
  fi

  if [[ -n "${default_value}" ]]; then
    if [[ "$is_secret" == "true" ]]; then
      echo -n "$label [***, press Enter to skip]: "
    else
      echo -n "$label [$default_value, press Enter to skip]: "
    fi
  else
    echo -n "$label [press Enter to skip]: "
  fi

  local input
  if [[ "$is_secret" == "true" ]]; then
    read -rs input
    echo ""
  else
    read -r input
  fi

  # Use input if provided, otherwise use default or empty
  if [[ -n "$input" ]]; then
    printf -v "$var_name" '%s' "$input"
  elif [[ -n "${default_value}" ]]; then
    printf -v "$var_name" '%s' "${default_value}"
  else
    printf -v "$var_name" '%s' ""
  fi
}

# Write value to env file
write_env() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  # Avoid sed escaping issues (URLs contain '/') by rewriting the file.
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

  write_env "$LOCAL_ENV_FILE" "$key" "$value"
  write_env "$PRODUCTION_ENV_FILE" "$key" "$value"
}

# Check if an env file exists and offer to resume
check_resume() {
  local env_file="$PRODUCTION_ENV_FILE"

  if [[ ! -f "$env_file" && -f "$LOCAL_ENV_FILE" ]]; then
    env_file="$LOCAL_ENV_FILE"
  fi

  if [[ -f "$env_file" ]]; then
    section "Existing Configuration Found"
    log "Found existing environment file ($env_file) with some credentials already set."
    log "Tip: when you see a value in brackets, press Enter to keep it."
    echo ""
    echo "You can either:"
    echo "  1. Continue and update missing credentials"
    echo "  2. Start fresh (will overwrite existing env files)"
    echo ""
    prompt choice "Choose option" "1"

    if [[ "$choice" == "2" ]]; then
      log_warning "Removing existing configuration files..."
      rm -f "$LOCAL_ENV_FILE" "$PRODUCTION_ENV_FILE"
      log_success "Starting fresh setup"
      return 1
    else
      log_success "Resuming setup with existing configuration"
      return 0
    fi
  fi

  return 1
}

# Load existing values from env files
load_existing() {
  local env_file="$PRODUCTION_ENV_FILE"

  if [[ ! -f "$env_file" && -f "$LOCAL_ENV_FILE" ]]; then
    env_file="$LOCAL_ENV_FILE"
  fi

  if [[ -f "$env_file" ]]; then
    while IFS='=' read -r key value; do
      # Skip comments and empty lines
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue

      # Remove leading/trailing whitespace
      key=$(echo "$key" | xargs)
      value=$(echo "$value" | xargs)

      # Export as variable
      export "$key=$value"
    done < "$env_file"
  fi
}

# Validate Cloudflare API token
validate_cloudflare_token() {
  local token="$1"
  
  log "Validating Cloudflare API token..."
  
  # Test the token by verifying it with Cloudflare's API
  local response
  response=$(curl -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json")
  
  if echo "$response" | grep -q '"success":true'; then
    log_success "Cloudflare API token is valid"
    return 0
  else
    log_error "Cloudflare API token is invalid or expired"
    if echo "$response" | grep -q '"code":1000'; then
      log_error "Error code 1000: Invalid API Token"
    fi
    return 1
  fi
}

validate_cloudflare_zone_access() {
  local token="$1"
  local zone_id="$2"

  if [[ ! "$zone_id" =~ ^[A-Fa-f0-9]{32}$ ]]; then
    log_error "Cloudflare Zone ID must be a 32-character hexadecimal ID"
    return 1
  fi

  log "Validating access to Cloudflare zone..."
  local response
  response=$(curl -sS -q -X GET "https://api.cloudflare.com/client/v4/zones/${zone_id}" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" 2>/dev/null || true)

  if echo "$response" | grep -q '"success":true'; then
    log_success "Cloudflare zone access is valid"
    return 0
  fi

  log_error "The token cannot access that Cloudflare zone"
  return 1
}

# Validate email format
validate_email() {
  local email="$1"
  if [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    return 0
  else
    return 1
  fi
}

# Validate URL format
validate_url() {
  local url="$1"
  if [[ "$url" =~ ^https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/.*)?$ ]]; then
    return 0
  else
    return 1
  fi
}

# Validate domain format
validate_domain() {
  local domain="$1"
  if [[ "$domain" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    return 0
  else
    return 1
  fi
}

validate_duckdns_domain() {
  local domain="$1"
  if [[ "$domain" =~ ^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$|^[A-Za-z0-9]$ ]]; then
    return 0
  else
    return 1
  fi
}

validate_duckdns_token() {
  local domain="$1"
  local token="$2"

  log "Validating DuckDNS token..."
  local response
  response=$(curl -fsS "https://www.duckdns.org/update?domains=${domain}&token=${token}&verbose=true" 2>/dev/null || echo "KO")

  if [[ "$response" == OK* ]]; then
    log_success "DuckDNS token is valid"
    return 0
  fi

  log_error "DuckDNS token or subdomain validation failed"
  return 1
}

# Generate AUTH_SECRET
generate_auth_secret_value() {
  openssl rand -base64 48
}

# ============================================================================
# CREDENTIAL GROUP FUNCTIONS
# ============================================================================

collect_aws_core() {
  step_section 1 "AWS Deployment Session"

  log "AWS setup and CDK use only your local AWS CLI credential chain."
  log "AWS IAM Identity Center / SSO is recommended; a local access-key profile is a fallback."
  log "The wizard never copies this human deployment identity into Worker configuration."
  echo ""

  echo "New to AWS? Quick checklist (recommended):"
  echo "  1. Create an AWS account: https://aws.amazon.com/"
  echo "  2. Secure the root user: enable MFA; do NOT create access keys for root"
  echo "  3. Create a separate admin identity for daily use (not root):"
  echo "     - IAM -> Users -> Create user (e.g., mc-aws-admin)"
  echo "     - Attach AdministratorAccess (you can tighten permissions later)"
  echo "  4. Optional (recommended): use a dedicated AWS account for mc-aws"
  echo "     - Better isolation (billing/permissions), safer experimentation, easier cleanup"
  echo "     - If you use AWS Organizations: create a new account (e.g., 'mc-aws') and use it here"
  echo ""

  # AWS Region selection (prefer existing configuration)
  if [[ -z "${AWS_REGION:-}" && -n "${AWS_DEFAULT_REGION:-}" ]]; then
    AWS_REGION="$AWS_DEFAULT_REGION"
  fi
  if [[ -z "${AWS_REGION:-}" && -n "${CDK_DEFAULT_REGION:-}" ]]; then
    AWS_REGION="$CDK_DEFAULT_REGION"
  fi

  if [[ -n "${AWS_REGION:-}" ]]; then
    log_success "Using region: $AWS_REGION"
    echo ""
  else
    echo "Common AWS regions:"
    echo "  1. us-east-1      (N. Virginia)"
    echo "  2. us-west-2      (Oregon)"
    echo "  3. eu-west-1      (Ireland)"
    echo "  4. eu-central-1   (Frankfurt)"
    echo "  5. ap-southeast-1 (Singapore)"
    echo "  6. ap-northeast-1 (Tokyo)"
    echo "  7. Other (enter manually)"
    echo ""

    prompt region_choice "Select your AWS region" "1"

    case "$region_choice" in
      1) AWS_REGION="us-east-1" ;;
      2) AWS_REGION="us-west-2" ;;
      3) AWS_REGION="eu-west-1" ;;
      4) AWS_REGION="eu-central-1" ;;
      5) AWS_REGION="ap-southeast-1" ;;
      6) AWS_REGION="ap-northeast-1" ;;
      7)
        prompt AWS_REGION "Enter your AWS region" ""
        ;;
      *)
        log_warning "Invalid choice, defaulting to us-east-1"
        AWS_REGION="us-east-1"
        ;;
    esac

    log_success "Using region: $AWS_REGION"
    echo ""
  fi

  echo "Before continuing, authenticate the AWS CLI in another terminal if needed:"
  echo "  Recommended: aws sso login [--profile your-profile]"
  echo "  Fallback:    aws configure [--profile your-profile]"
  echo "If you use a named profile, export AWS_PROFILE before running setup."
  echo ""

  export AWS_DEFAULT_REGION="$AWS_REGION"
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    log_error "AWS CLI authentication failed. Run aws sso login or configure a local deployment profile."
    exit 1
  fi

  log "Retrieving AWS account ID..."
  CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"

  if [[ -z "$CDK_DEFAULT_ACCOUNT" ]]; then
    log_error "Failed to retrieve AWS account ID"
    exit 1
  fi

  log_success "AWS Account ID: $CDK_DEFAULT_ACCOUNT"
  echo ""

  # CDK_DEFAULT_REGION (same as AWS_REGION)
  CDK_DEFAULT_REGION="$AWS_REGION"

  # Write to env files
  write_env_files "AWS_REGION" "$AWS_REGION"
  write_env_files "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  write_env_files "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"

  log_success "Local AWS deployment session validated; no human AWS key was copied for Worker upload"
}

collect_ec2_access() {
  step_section 2 "EC2 Access"

  log "An EC2 key pair is optional. Add one only if you want SSH key access to the instance."
  echo ""

  echo "To create an EC2 key pair:"
  echo "  1. Go to AWS Console → EC2 → Key Pairs"
  echo "  2. Click 'Create key pair'"
  echo "  3. Enter a name (e.g., 'minecraft-server')"
  echo "  4. Key pair type: RSA"
  echo "  5. Private key file format: .pem"
  echo "  6. Click 'Create key pair' and download the .pem file"
  echo "  7. Save the .pem file securely - you cannot download it again!"
  echo ""

  prompt_optional KEY_PAIR_NAME "Enter your EC2 key pair name" "${KEY_PAIR_NAME:-}"

  if [[ -n "${KEY_PAIR_NAME:-}" ]]; then
    log_success "Using key pair: $KEY_PAIR_NAME"
  else
    log_success "No EC2 key pair configured"
  fi
  echo ""

  # Write to env files
  write_env_files "KEY_PAIR_NAME" "$KEY_PAIR_NAME"

  log_success "EC2 access credentials saved"
}

collect_google_oauth() {
  step_section 3 "Google OAuth Credentials"

  log "These credentials enable Google OAuth authentication for the control panel."
  echo ""

  echo "To create Google OAuth credentials:"
  echo "  1. Go to https://console.cloud.google.com/"
  echo "  2. Create a new project or select existing one"
  echo "  3. Go to 'APIs & Services' → 'OAuth consent screen'"
  echo "  4. If you see a 'Get started' button, click it and complete the form"
  echo "     (app name, support email, developer contact info)."
  echo "  5. Choose 'External' user type (common for personal projects)"
  echo "     and add yourself as a test user while the app is in testing."
  echo "  5. Go to 'APIs & Services' → 'Credentials'"
  echo "  6. Click 'Create Credentials' → 'OAuth client ID'"
  echo "  7. Application type: Web application"
  echo "  8. Setup will print the exact production origin after you choose panel hosting."
  echo "     Add it to 'Authorized JavaScript origins'."
  echo "  9. Setup will also print the exact callback for 'Authorized redirect URIs'."
  echo "     The callback always ends in /api/auth/callback (no trailing /google)."
  echo "  10. If you want to use Google sign-in locally, also add:"
  echo "      - Origin:   http://localhost:3000"
  echo "      - Redirect: http://localhost:3000/api/auth/callback"
  echo "      Otherwise you can skip localhost and use the built-in dev login locally."
  echo "  11. Click 'Create' and copy the Client ID and Client Secret"
  echo ""

  prompt GOOGLE_CLIENT_ID "Enter Google OAuth Client ID" "${GOOGLE_CLIENT_ID:-}"
  prompt GOOGLE_CLIENT_SECRET "Enter Google OAuth Client Secret" "${GOOGLE_CLIENT_SECRET:-}" true
  echo ""

  # Write to env files
  write_env_files "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID"
  write_env_files "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET"

  log_success "Google OAuth credentials saved"
}

collect_authorization() {
  step_section 4 "Authorization Settings"

  log "Configure who can access and control your Minecraft server."
  echo ""

  # Admin email
  echo "The admin email has full access to all features."
  echo "This should be your Google account email."
  echo ""

  while true; do
    prompt ADMIN_EMAIL "Enter admin email (your Google email)" "${ADMIN_EMAIL:-}"

    if validate_email "$ADMIN_EMAIL"; then
      break
    else
      log_error "Invalid email format. Please try again."
    fi
  done

  log_success "Admin email: $ADMIN_EMAIL"
  echo ""

  # Allowed emails
  echo "Allowed emails are users who can start/stop the server."
  echo "Enter a comma-separated list (e.g., friend1@yourdomain.com,friend2@gmail.com)"
  echo "Leave empty to only allow the admin."
  echo ""

  prompt_optional ALLOWED_EMAILS "Enter additional allowed emails" "${ALLOWED_EMAILS:-}"

  if [[ -n "$ALLOWED_EMAILS" ]]; then
    log_success "Allowed emails: $ALLOWED_EMAILS"
  else
    log_success "Only admin will have access"
  fi
  echo ""

  # Write to env files
  write_env_files "ADMIN_EMAIL" "$ADMIN_EMAIL"
  write_env_files "ALLOWED_EMAILS" "$ALLOWED_EMAILS"

  log_success "Authorization settings saved"
}

collect_cloudflare() {
  step_section 5 "Cloudflare DNS Credentials"

  log "These credentials enable automatic DNS updates for your Minecraft server."
  echo ""
  echo "NOTE: You need a Cloudflare API Token for runtime DNS updates (Lambda)."
  echo "      Deployment uses 'wrangler login' (OAuth), not this token."
  echo ""

  echo "To create an API token for DNS updates:"
  echo "  1. Go to https://dash.cloudflare.com/profile/api-tokens"
  echo "  2. Click 'Create Token'"
  echo "  3. Use template 'Edit zone DNS' or create custom with:"
  echo "     - Zone → DNS → Edit"
  echo "     - Include → Specific zone → select your domain"
  echo "  4. Copy the API token (NOT the Global API Key!)"
  echo ""
  echo "This token should have LIMITED permissions (just DNS) for security."
  echo ""

  # Loop until we get a valid token
  while true; do
    prompt CLOUDFLARE_DNS_API_TOKEN "Enter Cloudflare DNS API Token (for DNS updates)" "${CLOUDFLARE_DNS_API_TOKEN:-}" true
    echo ""

    if validate_cloudflare_token "$CLOUDFLARE_DNS_API_TOKEN"; then
      break
    else
      log_error "Please check your API token and try again."
      log_error "Make sure you created a new token (not using a Global API Key)."
      echo ""
      # Clear the invalid token so they can't just hit Enter again
      CLOUDFLARE_DNS_API_TOKEN=""
    fi
  done

  echo "To get your Zone ID:"
  echo "  1. Go to Cloudflare Dashboard → select your domain"
  echo "  2. On the right sidebar, find 'Zone ID'"
  echo "  3. Click to copy"
  echo ""

  prompt CLOUDFLARE_ZONE_ID "Enter Cloudflare Zone ID" "${CLOUDFLARE_ZONE_ID:-}"
  echo ""

  echo "Create an A record for the Minecraft hostname before deployment (a placeholder IP is fine)."
  echo "The updater locates it by hostname, so the legacy record ID is optional."
  echo ""

  prompt_optional CLOUDFLARE_RECORD_ID "Enter Cloudflare Record ID (optional)" "${CLOUDFLARE_RECORD_ID:-}"

  if [[ -n "$CLOUDFLARE_RECORD_ID" ]]; then
    log_success "Using existing record ID: $CLOUDFLARE_RECORD_ID"
  else
    log_success "The existing Minecraft DNS record will be located by hostname"
  fi
  echo ""

  # Minecraft domain
  echo "Enter the subdomain for your Minecraft server."
  echo "This is the domain players will use to connect."
  echo "Example: mc.yourdomain.com"
  echo ""

  while true; do
    prompt CLOUDFLARE_MC_DOMAIN "Enter Minecraft server domain" "${CLOUDFLARE_MC_DOMAIN:-}"

    if validate_domain "$CLOUDFLARE_MC_DOMAIN"; then
      break
    else
      log_error "Invalid domain format. Please try again."
    fi
  done

  log_success "Minecraft domain: $CLOUDFLARE_MC_DOMAIN"
  echo ""

  # Write to env files
  write_env_files "CLOUDFLARE_DNS_API_TOKEN" "$CLOUDFLARE_DNS_API_TOKEN"
  write_env_files "CLOUDFLARE_ZONE_ID" "$CLOUDFLARE_ZONE_ID"
  write_env_files "CLOUDFLARE_RECORD_ID" "$CLOUDFLARE_RECORD_ID"
  write_env_files "CLOUDFLARE_MC_DOMAIN" "$CLOUDFLARE_MC_DOMAIN"

  log_success "Cloudflare credentials saved"
}

collect_duckdns() {
  step_section 5 "DuckDNS Credentials"

  log "DuckDNS provides a free subdomain like myserver.duckdns.org."
  echo "Create the subdomain and copy your token from https://www.duckdns.org."
  echo ""

  while true; do
    prompt DUCKDNS_DOMAIN "Enter DuckDNS subdomain name (without .duckdns.org)" "${DUCKDNS_DOMAIN:-}"

    if validate_duckdns_domain "$DUCKDNS_DOMAIN"; then
      break
    fi

    log_error "Use only letters, numbers, and hyphens. Do not include .duckdns.org."
  done

  while true; do
    prompt DUCKDNS_TOKEN "Enter DuckDNS token" "${DUCKDNS_TOKEN:-}" true

    if validate_duckdns_token "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN"; then
      break
    fi

    DUCKDNS_TOKEN=""
  done

  write_env_files "DUCKDNS_DOMAIN" "$DUCKDNS_DOMAIN"
  write_env_files "DUCKDNS_TOKEN" "$DUCKDNS_TOKEN"
  write_env_files "CLOUDFLARE_DNS_API_TOKEN" ""
  write_env_files "CLOUDFLARE_ZONE_ID" ""
  write_env_files "CLOUDFLARE_RECORD_ID" ""
  write_env_files "CLOUDFLARE_MC_DOMAIN" ""

  log_success "DuckDNS credentials saved"
}

collect_dns_mode() {
  step_section 5 "Minecraft Connection DNS"

  echo "Choose how you want to connect to the Minecraft server:"
  echo ""
  echo "  1. Custom domain (e.g. mc.example.com) - requires domain purchase"
  echo "  2. Free DuckDNS subdomain (e.g. myserver.duckdns.org)"
  echo "  3. No domain - connect via raw IP address"
  echo ""

  prompt dns_choice "Enter choice" "2"

  case "$dns_choice" in
    1)
      collect_cloudflare
      write_env_files "DUCKDNS_DOMAIN" ""
      write_env_files "DUCKDNS_TOKEN" ""
      write_env_files "MC_CONNECTION_MODE" "cloudflare"
      ;;
    2)
      collect_duckdns
      write_env_files "MC_CONNECTION_MODE" "duckdns"
      ;;
    3)
      write_env_files "DUCKDNS_DOMAIN" ""
      write_env_files "DUCKDNS_TOKEN" ""
      write_env_files "CLOUDFLARE_DNS_API_TOKEN" ""
      write_env_files "CLOUDFLARE_ZONE_ID" ""
      write_env_files "CLOUDFLARE_RECORD_ID" ""
      write_env_files "CLOUDFLARE_MC_DOMAIN" ""
      write_env_files "MC_CONNECTION_MODE" "raw_ip"
      log_warning "Friends will need to use the IP address shown in the panel to connect."
      ;;
    *)
      log_warning "Invalid choice, defaulting to DuckDNS."
      collect_duckdns
      write_env_files "MC_CONNECTION_MODE" "duckdns"
      ;;
  esac
}

get_worker_name() {
  node -e '
const fs = require("node:fs");
const raw = fs.readFileSync("wrangler.jsonc", "utf8");
const config = JSON.parse(raw.slice(raw.indexOf("{")));
if (typeof config.name !== "string" || !config.name.trim()) process.exit(1);
process.stdout.write(config.name.trim());
'
}

collect_panel_hosting() {
  step_section 6 "Control Panel Hosting"

  log "Panel hosting is independent of the Minecraft connection mode you just selected."
  echo ""
  echo "  1. Cloudflare workers.dev (no custom domain required)"
  echo "  2. Custom hostname in a Cloudflare-managed DNS zone"
  echo ""
  prompt panel_hosting_choice "Enter choice" "1"

  local worker_name
  worker_name="$(get_worker_name)" || { log_error "Could not read Worker name from wrangler.jsonc"; exit 1; }

  case "$panel_hosting_choice" in
    1)
      PANEL_HOSTING_MODE="workers_dev"
      echo ""
      log "Find your Workers subdomain in Cloudflare: Workers & Pages -> Account details."
      log "Enter account-name, account-name.workers.dev, or the full expected Worker URL."

      local workers_input
      while true; do
        prompt workers_input "Enter Workers account subdomain or full panel URL" "${CLOUDFLARE_WORKERS_SUBDOMAIN:-}"
        local derived
        if derived=$(pnpm exec tsx scripts/panel-hosting.ts derive-workers-url \
          --worker-name "$worker_name" --input "$workers_input" 2>/dev/null); then
          IFS=$'\t' read -r CLOUDFLARE_WORKERS_SUBDOMAIN NEXT_PUBLIC_APP_URL <<< "$derived"
          break
        fi
        log_error "Invalid Workers subdomain or URL, or it does not match Worker '$worker_name'."
      done

      PANEL_WORKERS_DEV_ENABLED="true"
      CLOUDFLARE_PANEL_ZONE_ID=""
      CLOUDFLARE_PANEL_DNS_API_TOKEN=""
      ;;
    2)
      PANEL_HOSTING_MODE="custom"
      while true; do
        prompt NEXT_PUBLIC_APP_URL "Enter full custom control panel URL" "${NEXT_PUBLIC_APP_URL:-}"
        local validated_custom_url
        if validated_custom_url=$(pnpm exec tsx scripts/panel-hosting.ts validate-custom-url \
          --url "$NEXT_PUBLIC_APP_URL" 2>/dev/null); then
          NEXT_PUBLIC_APP_URL="$validated_custom_url"
          break
        fi
        log_error "Use an HTTPS custom hostname with no path, query, fragment, or port."
      done

      log "Custom panel teardown needs one zone-scoped token with DNS Read/Edit and Workers Routes Read/Edit."
      log "Those permissions let setup record whether the route/DNS pre-existed and let teardown preserve them safely."
      while true; do
        prompt CLOUDFLARE_PANEL_DNS_API_TOKEN "Enter DNS-edit token for the panel zone" \
          "${CLOUDFLARE_PANEL_DNS_API_TOKEN:-${CLOUDFLARE_DNS_API_TOKEN:-}}" true
        validate_cloudflare_token "$CLOUDFLARE_PANEL_DNS_API_TOKEN" && break
        CLOUDFLARE_PANEL_DNS_API_TOKEN=""
      done
      while true; do
        prompt CLOUDFLARE_PANEL_ZONE_ID "Enter Zone ID for the panel hostname" \
          "${CLOUDFLARE_PANEL_ZONE_ID:-${CLOUDFLARE_ZONE_ID:-}}"
        validate_cloudflare_zone_access "$CLOUDFLARE_PANEL_DNS_API_TOKEN" "$CLOUDFLARE_PANEL_ZONE_ID" && break
      done

      echo ""
      echo "Keep the Worker reachable at its workers.dev address in addition to the custom hostname?"
      echo "  1. No (recommended: custom hostname only)"
      echo "  2. Yes"
      prompt workers_dev_choice "Enter choice" "1"
      if [[ "$workers_dev_choice" == "2" ]]; then
        PANEL_WORKERS_DEV_ENABLED="true"
      else
        PANEL_WORKERS_DEV_ENABLED="false"
      fi
      CLOUDFLARE_WORKERS_SUBDOMAIN=""
      ;;
    *)
      log_error "Invalid panel hosting choice. Select 1 or 2."
      exit 1
      ;;
  esac

  write_env_files "PANEL_HOSTING_MODE" "$PANEL_HOSTING_MODE"
  write_env_files "CLOUDFLARE_WORKERS_SUBDOMAIN" "$CLOUDFLARE_WORKERS_SUBDOMAIN"
  write_env_files "PANEL_WORKERS_DEV_ENABLED" "$PANEL_WORKERS_DEV_ENABLED"
  write_env_files "CLOUDFLARE_PANEL_ZONE_ID" "$CLOUDFLARE_PANEL_ZONE_ID"
  write_env_files "CLOUDFLARE_PANEL_DNS_API_TOKEN" "$CLOUDFLARE_PANEL_DNS_API_TOKEN"
  write_env_files "NEXT_PUBLIC_APP_URL" "$NEXT_PUBLIC_APP_URL"

  log_success "Control panel URL: $NEXT_PUBLIC_APP_URL"
  echo ""
  echo "Google OAuth production settings:"
  echo "  Authorized JavaScript origin: $NEXT_PUBLIC_APP_URL"
  echo "  Authorized redirect URI:      ${NEXT_PUBLIC_APP_URL}/api/auth/callback"
  echo "Update the Google OAuth client now; sign-in will fail until both exact values are registered."
  echo ""
}

collect_email_settings() {
  step_section 7 "Optional: Email Settings (SES)"

  local existing_verified_sender="${VERIFIED_SENDER:-}"
  local existing_notification_email="${NOTIFICATION_EMAIL:-}"
  local existing_inbound_recipient="${SES_INBOUND_RECIPIENT:-}"
  local existing_rule_set_name="${SES_RECEIPT_RULE_SET_NAME:-}"
  local existing_start_keyword="${START_KEYWORD:-}"

  log "Outbound notifications and inbound email commands are independent capabilities."
  log "Core panel/server operations work even when this section is skipped."
  echo ""
  echo "  1. Disabled (no SES receipt resources or send permissions)"
  echo "  2. Outbound notifications only"
  echo "  3. Inbound email commands only"
  echo "  4. Both outbound notifications and inbound commands"
  echo ""
  prompt ses_mode "Enter choice" "1"

  SES_NOTIFICATIONS_ENABLED="false"
  SES_INBOUND_COMMANDS_ENABLED="false"
  VERIFIED_SENDER=""
  NOTIFICATION_EMAIL=""
  SES_INBOUND_RECIPIENT=""
  SES_RECEIPT_RULE_SET_NAME=""
  START_KEYWORD=""

  case "$ses_mode" in
    2) SES_NOTIFICATIONS_ENABLED="true" ;;
    3) SES_INBOUND_COMMANDS_ENABLED="true" ;;
    4)
      SES_NOTIFICATIONS_ENABLED="true"
      SES_INBOUND_COMMANDS_ENABLED="true"
      ;;
    1) log_warning "Skipping all SES capabilities" ;;
    *) log_warning "Invalid choice; SES capabilities will remain disabled" ;;
  esac

  if [[ "$SES_NOTIFICATIONS_ENABLED" == "true" ]]; then
    echo ""
    log "Outbound notifications require an SES-verified sender identity."
    while true; do
      prompt VERIFIED_SENDER "Enter verified sender email" "$existing_verified_sender"
      validate_email "$VERIFIED_SENDER" && break
      log_error "Invalid email format. Please try again."
    done
    while true; do
      prompt NOTIFICATION_EMAIL "Enter notification destination" "${existing_notification_email:-${ADMIN_EMAIL:-}}"
      validate_email "$NOTIFICATION_EMAIL" && break
      log_error "Invalid email format. Please try again."
    done
  fi

  if [[ "$SES_INBOUND_COMMANDS_ENABLED" == "true" ]]; then
    echo ""
    log "Inbound commands require an existing, active receipt rule set that you name explicitly."
    log "The stack adds/removes only its own rule and never changes which account-wide rule set is active."
    while true; do
      prompt SES_INBOUND_RECIPIENT "Enter inbound command recipient" "$existing_inbound_recipient"
      validate_email "$SES_INBOUND_RECIPIENT" && break
      log_error "Invalid email format. Please try again."
    done
    prompt SES_RECEIPT_RULE_SET_NAME "Enter existing receipt rule set name" "$existing_rule_set_name"
    prompt START_KEYWORD "Enter private start keyword" "$existing_start_keyword"
  fi
  echo ""

  write_env_files "SES_NOTIFICATIONS_ENABLED" "$SES_NOTIFICATIONS_ENABLED"
  write_env_files "SES_INBOUND_COMMANDS_ENABLED" "$SES_INBOUND_COMMANDS_ENABLED"
  write_env_files "VERIFIED_SENDER" "$VERIFIED_SENDER"
  write_env_files "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"
  write_env_files "SES_INBOUND_RECIPIENT" "$SES_INBOUND_RECIPIENT"
  write_env_files "SES_RECEIPT_RULE_SET_NAME" "$SES_RECEIPT_RULE_SET_NAME"
  write_env_files "START_KEYWORD" "$START_KEYWORD"

  log_success "Email settings saved"
}

collect_github_settings() {
  step_section 8 "GitHub Repo Access"

  log "Configure GitHub access so the EC2 instance can clone your fork during setup."
  echo ""

  echo "Use your fork of this repository."
  echo ""

  prompt GITHUB_USER "Enter GitHub username" "${GITHUB_USER:-}"

  prompt GITHUB_REPO "Enter GitHub repository name" "${GITHUB_REPO:-}"

  echo ""
  echo "To create a GitHub personal access token:"
  echo "  1. Go to GitHub → Settings → Developer settings → Personal access tokens"
  echo "  2. Create a token that can read your fork"
  echo "  3. If using a classic token, select scope: repo"
  echo "  4. Generate and copy the token"
  echo ""

  prompt GITHUB_TOKEN "Enter GitHub personal access token" "${GITHUB_TOKEN:-}" true

  log_success "GitHub settings configured"
  echo ""

  # Write to env files
  write_env_files "GITHUB_USER" "$GITHUB_USER"
  write_env_files "GITHUB_REPO" "$GITHUB_REPO"
  write_env_files "GITHUB_TOKEN" "$GITHUB_TOKEN"

  log_success "GitHub settings saved"
}

collect_gdrive_settings() {
  step_section 9 "Optional: Google Drive Backups"

  log "Configure Google Drive integration for server backups."
  log "This requires rclone to be configured with a Google Drive remote."
  echo ""

  echo "Leave these empty to skip Google Drive configuration."
  echo ""

  prompt_optional GDRIVE_REMOTE "Enter rclone remote name (usually 'gdrive')" "${GDRIVE_REMOTE:-gdrive}"

  if [[ -n "$GDRIVE_REMOTE" ]]; then
    echo ""
    echo "Enter the folder path in Google Drive where backups will be stored."
    echo "Example: /MinecraftBackups or leave empty for root"
    echo ""

    prompt_optional GDRIVE_ROOT "Enter Google Drive backup folder path" "${GDRIVE_ROOT:-}"

    log_success "Google Drive settings configured"
  else
    log_warning "Skipping Google Drive configuration"
  fi
  echo ""

  # Write to env files
  write_env_files "GDRIVE_REMOTE" "$GDRIVE_REMOTE"
  write_env_files "GDRIVE_ROOT" "$GDRIVE_ROOT"

  log_success "Google Drive settings saved"
}

generate_auth_secret() {
  step_section 10 "Generating AUTH_SECRET"

  log "Generating a secure AUTH_SECRET for session encryption..."
  echo ""

  AUTH_SECRET=$(generate_auth_secret_value)

  log_success "AUTH_SECRET generated"
  echo ""

  # Write to env files
  write_env_files "AUTH_SECRET" "$AUTH_SECRET"

  log_success "AUTH_SECRET saved"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
  section "Welcome"
  log "This wizard will guide you through ${WIZARD_TOTAL} steps and write:"
  echo "  • $LOCAL_ENV_FILE"
  echo "  • $PRODUCTION_ENV_FILE"
  echo ""

  if is_tty; then
    echo "Press Enter to begin..."
    read -r
  fi

  # Check if we should resume
  if check_resume; then
    load_existing
  fi

  # Collect all credentials
  collect_aws_core
  collect_ec2_access
  collect_google_oauth
  collect_authorization
  collect_dns_mode
  collect_panel_hosting
  collect_email_settings
  collect_github_settings
  collect_gdrive_settings
  generate_auth_secret

  # Success message
  section "Setup Complete!"

  log_success "All credentials have been collected and saved!"
  echo ""
  echo "Configuration files created:"
  echo "  • $LOCAL_ENV_FILE      (for local development)"
  echo "  • $PRODUCTION_ENV_FILE (for production deployment)"
  echo ""
  if [[ -n "${MC_AWS_SETUP_RETURN_TO_SETUP_SH:-}" ]]; then
    echo "Returning to setup.sh to deploy infrastructure..."
    echo ""
  else
    echo "Next steps:"
    echo "  1. Review your credentials in $PRODUCTION_ENV_FILE"
    echo "  2. Run './setup.sh' to deploy AWS infrastructure and Cloudflare"
    echo ""
  fi
  log_success "Setup wizard completed successfully!"
  echo ""

  if is_tty; then
    echo "Press Enter to finish..."
    read -r
  fi
}

# Run main function
if [[ "${MC_AWS_SETUP_LIBRARY_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
