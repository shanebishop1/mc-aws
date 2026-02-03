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

# Check if .env.local exists and offer to resume
check_resume() {
  local env_file=".env.local"

  if [[ -f "$env_file" ]]; then
    section "Existing Configuration Found"
    log "Found existing .env.local file with some credentials already set."
    log "Tip: when you see a value in brackets, press Enter to keep it."
    echo ""
    echo "You can either:"
    echo "  1. Continue and update missing credentials"
    echo "  2. Start fresh (will overwrite existing .env.local and .env.production)"
    echo ""
    prompt choice "Choose option" "1"

    if [[ "$choice" == "2" ]]; then
      log_warning "Removing existing configuration files..."
      rm -f .env.local .env.production
      log_success "Starting fresh setup"
      return 1
    else
      log_success "Resuming setup with existing configuration"
      return 0
    fi
  fi

  return 1
}

# Load existing values from .env.local
load_existing() {
  local env_file=".env.local"

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

# Validate AWS credentials
validate_aws_credentials() {
  local access_key="$1"
  local secret_key="$2"
  local region="$3"

  log "Validating AWS credentials..."

  # Temporarily set AWS credentials
  export AWS_ACCESS_KEY_ID="$access_key"
  export AWS_SECRET_ACCESS_KEY="$secret_key"
  export AWS_DEFAULT_REGION="$region"

  # Try to get caller identity
  if aws sts get-caller-identity &>/dev/null; then
    log_success "AWS credentials are valid"
    return 0
  else
    log_error "AWS credentials are invalid or lack necessary permissions"
    return 1
  fi
}

# Get AWS account ID
get_aws_account_id() {
  local access_key="$1"
  local secret_key="$2"
  local region="$3"

  export AWS_ACCESS_KEY_ID="$access_key"
  export AWS_SECRET_ACCESS_KEY="$secret_key"
  export AWS_DEFAULT_REGION="$region"

  aws sts get-caller-identity --query Account --output text 2>/dev/null || echo ""
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

# Generate AUTH_SECRET
generate_auth_secret_value() {
  openssl rand -base64 48
}

# ============================================================================
# CREDENTIAL GROUP FUNCTIONS
# ============================================================================

collect_aws_core() {
  step_section 1 "AWS Core Credentials"

  log "These credentials are required to deploy and manage AWS resources."
  log "You'll need an AWS account with appropriate IAM permissions."
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

  # AWS Access Key ID
  echo "To get your AWS access keys:"
  echo "  1. Go to AWS Console → IAM → Users → Your User"
  echo "  2. Click 'Security credentials' tab"
  echo "  3. Click 'Create access key'"
  echo "  4. Choose 'Application running outside AWS' and create"
  echo "  5. Copy the Access key ID and Secret access key"
  echo ""

  prompt AWS_ACCESS_KEY_ID "Enter AWS Access Key ID" "${AWS_ACCESS_KEY_ID:-}"
  prompt AWS_SECRET_ACCESS_KEY "Enter AWS Secret Access Key" "${AWS_SECRET_ACCESS_KEY:-}" true
  echo ""

  # Validate AWS credentials
  if ! validate_aws_credentials "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_REGION"; then
    log_error "Failed to validate AWS credentials. Please check your keys and try again."
    exit 1
  fi

  # Get account ID
  log "Retrieving AWS account ID..."
  CDK_DEFAULT_ACCOUNT=$(get_aws_account_id "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_REGION")

  if [[ -z "$CDK_DEFAULT_ACCOUNT" ]]; then
    log_error "Failed to retrieve AWS account ID"
    exit 1
  fi

  log_success "AWS Account ID: $CDK_DEFAULT_ACCOUNT"
  echo ""

  # CDK_DEFAULT_REGION (same as AWS_REGION)
  CDK_DEFAULT_REGION="$AWS_REGION"

  # Write to env files
  write_env ".env.local" "AWS_REGION" "$AWS_REGION"
  write_env ".env.local" "AWS_ACCESS_KEY_ID" "$AWS_ACCESS_KEY_ID"
  write_env ".env.local" "AWS_SECRET_ACCESS_KEY" "$AWS_SECRET_ACCESS_KEY"
  write_env ".env.local" "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  write_env ".env.local" "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"

  write_env ".env.production" "AWS_REGION" "$AWS_REGION"
  write_env ".env.production" "AWS_ACCESS_KEY_ID" "$AWS_ACCESS_KEY_ID"
  write_env ".env.production" "AWS_SECRET_ACCESS_KEY" "$AWS_SECRET_ACCESS_KEY"
  write_env ".env.production" "CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_ACCOUNT"
  write_env ".env.production" "CDK_DEFAULT_REGION" "$CDK_DEFAULT_REGION"

  log_success "AWS Core credentials saved"
}

collect_ec2_access() {
  step_section 2 "EC2 Access"

  log "You need an EC2 key pair to SSH into your Minecraft server."
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

  prompt KEY_PAIR_NAME "Enter your EC2 key pair name" "${KEY_PAIR_NAME:-}"

  log_success "Using key pair: $KEY_PAIR_NAME"
  echo ""

  # Write to env files
  write_env ".env.local" "KEY_PAIR_NAME" "$KEY_PAIR_NAME"
  write_env ".env.production" "KEY_PAIR_NAME" "$KEY_PAIR_NAME"

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
  echo "  8. Add the exact origin for your control panel to 'Authorized JavaScript origins'"
  echo "     - Use the same host as NEXT_PUBLIC_APP_URL (include https://)"
  echo "     - If your panel is https://panel.yourdomain.com, add https://panel.yourdomain.com"
  echo "     - Only add https://yourdomain.com if your panel actually runs on the apex domain"
  echo "  9. Add your callback URL to 'Authorized redirect URIs'"
  echo "     - Use: https://panel.yourdomain.com/api/auth/callback (no trailing /google)"
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
  write_env ".env.local" "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID"
  write_env ".env.local" "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET"
  write_env ".env.production" "GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_ID"
  write_env ".env.production" "GOOGLE_CLIENT_SECRET" "$GOOGLE_CLIENT_SECRET"

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
  write_env ".env.local" "ADMIN_EMAIL" "$ADMIN_EMAIL"
  write_env ".env.local" "ALLOWED_EMAILS" "$ALLOWED_EMAILS"
  write_env ".env.production" "ADMIN_EMAIL" "$ADMIN_EMAIL"
  write_env ".env.production" "ALLOWED_EMAILS" "$ALLOWED_EMAILS"

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

  echo "Record ID is the DNS record for your Minecraft server."
  echo "You can:"
  echo "  1. Enter an existing record ID (find it in DNS → Records → click record)"
  echo "  2. Leave empty - we'll create it during CDK deployment"
  echo ""

  prompt_optional CLOUDFLARE_RECORD_ID "Enter Cloudflare Record ID (optional)" "${CLOUDFLARE_RECORD_ID:-}"

  if [[ -n "$CLOUDFLARE_RECORD_ID" ]]; then
    log_success "Using existing record ID: $CLOUDFLARE_RECORD_ID"
  else
    log_success "Will create DNS record during deployment"
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
  write_env ".env.local" "CLOUDFLARE_DNS_API_TOKEN" "$CLOUDFLARE_DNS_API_TOKEN"
  write_env ".env.local" "CLOUDFLARE_ZONE_ID" "$CLOUDFLARE_ZONE_ID"
  write_env ".env.local" "CLOUDFLARE_RECORD_ID" "$CLOUDFLARE_RECORD_ID"
  write_env ".env.local" "CLOUDFLARE_MC_DOMAIN" "$CLOUDFLARE_MC_DOMAIN"
  write_env ".env.production" "CLOUDFLARE_DNS_API_TOKEN" "$CLOUDFLARE_DNS_API_TOKEN"
  write_env ".env.production" "CLOUDFLARE_ZONE_ID" "$CLOUDFLARE_ZONE_ID"
  write_env ".env.production" "CLOUDFLARE_RECORD_ID" "$CLOUDFLARE_RECORD_ID"
  write_env ".env.production" "CLOUDFLARE_MC_DOMAIN" "$CLOUDFLARE_MC_DOMAIN"

  log_success "Cloudflare credentials saved"
}

collect_production_url() {
  step_section 6 "Production URL"

  log "This is the URL where your control panel will be accessible."
  echo ""

  echo "Enter the full URL for your control panel."
  echo "Example: https://panel.yourdomain.com"
  echo ""

  while true; do
    prompt NEXT_PUBLIC_APP_URL "Enter control panel URL" "${NEXT_PUBLIC_APP_URL:-}"

    if validate_url "$NEXT_PUBLIC_APP_URL"; then
      break
    else
      log_error "Invalid URL format. Please include https:// and try again."
    fi
  done

  log_success "Control panel URL: $NEXT_PUBLIC_APP_URL"
  echo ""

  # Write to env files
  write_env ".env.local" "NEXT_PUBLIC_APP_URL" "$NEXT_PUBLIC_APP_URL"
  write_env ".env.production" "NEXT_PUBLIC_APP_URL" "$NEXT_PUBLIC_APP_URL"

  log_success "Production URL saved"
}

collect_email_settings() {
  step_section 7 "Optional: Email Settings (SES)"

  log "Configure email notifications for server events."
  log "This feature allows starting the server via email."
  echo ""

  echo "What this email feature does:"
  echo "  - You send an email to a special address (e.g., start@yourdomain.com)"
  echo "  - SES receives it and triggers the start Lambda"
  echo "  - SES also sends notification emails (startup success/failure, etc.)"
  echo ""
  echo "VERIFIED_SENDER is BOTH:"
  echo "  1) The 'To:' address SES listens for (the start trigger address)"
  echo "  2) The 'From:' address SES uses when sending notifications"
  echo ""
  echo "It is NOT an MX record for your Minecraft server."
  echo "It's an email address on a domain you control (e.g., start@yourdomain.com)."
  echo ""
  echo "Prereqs (high level):"
  echo "  - In AWS SES, verify the identity (email or domain)"
  echo "  - In DNS, point the domain's MX record to Amazon SES to enable receiving"
  echo "  - If your SES account is in sandbox, you may also need to verify recipients"
  echo ""
  echo "Leave these empty to skip email configuration."
  echo ""

  prompt_optional VERIFIED_SENDER "Enter start/notification address" "${VERIFIED_SENDER:-}"

  if [[ -n "$VERIFIED_SENDER" ]]; then
    while ! validate_email "$VERIFIED_SENDER"; do
      log_error "Invalid email format. Please try again."
      prompt_optional VERIFIED_SENDER "Enter verified sender email" ""
      [[ -z "$VERIFIED_SENDER" ]] && break
    done
  fi

  if [[ -n "$VERIFIED_SENDER" ]]; then
    prompt_optional NOTIFICATION_EMAIL "Enter notification email" "${NOTIFICATION_EMAIL:-}"

    if [[ -n "$NOTIFICATION_EMAIL" ]]; then
      while ! validate_email "$NOTIFICATION_EMAIL"; do
        log_error "Invalid email format. Please try again."
        prompt_optional NOTIFICATION_EMAIL "Enter notification email" ""
        [[ -z "$NOTIFICATION_EMAIL" ]] && break
      done
    fi

    echo ""
    echo "The START_KEYWORD is a secret word that, when received in an email,"
    echo "will trigger the server to start."
    echo ""

    prompt_optional START_KEYWORD "Enter start keyword" "${START_KEYWORD:-}"

    if [[ -n "$START_KEYWORD" ]]; then
      log_success "Email settings configured"
    else
      log_warning "Email settings incomplete - skipping"
      VERIFIED_SENDER=""
      NOTIFICATION_EMAIL=""
    fi
  else
    log_warning "Skipping email configuration"
  fi
  echo ""

  # Write to env files
  write_env ".env.local" "VERIFIED_SENDER" "$VERIFIED_SENDER"
  write_env ".env.local" "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"
  write_env ".env.local" "START_KEYWORD" "$START_KEYWORD"
  write_env ".env.production" "VERIFIED_SENDER" "$VERIFIED_SENDER"
  write_env ".env.production" "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"
  write_env ".env.production" "START_KEYWORD" "$START_KEYWORD"

  log_success "Email settings saved"
}

collect_github_settings() {
  step_section 8 "Optional: GitHub Configuration Sync"

  log "Configure GitHub integration for backing up server configuration."
  log "This allows syncing server.properties and other config files to GitHub."
  echo ""

  echo "Leave these empty to skip GitHub configuration."
  echo ""

  prompt_optional GITHUB_USER "Enter GitHub username" "${GITHUB_USER:-}"

  if [[ -n "$GITHUB_USER" ]]; then
    prompt_optional GITHUB_REPO "Enter GitHub repository name" "${GITHUB_REPO:-}"

    if [[ -n "$GITHUB_REPO" ]]; then
      echo ""
      echo "To create a GitHub personal access token:"
      echo "  1. Go to GitHub → Settings → Developer settings → Personal access tokens"
      echo "  2. Click 'Tokens (classic)' → 'Generate new token (classic)'"
      echo "  3. Select scopes: repo (full control)"
      echo "  4. Generate and copy the token"
      echo ""

      prompt_optional GITHUB_TOKEN "Enter GitHub personal access token" "${GITHUB_TOKEN:-}" true

      if [[ -n "$GITHUB_TOKEN" ]]; then
        log_success "GitHub settings configured"
      else
        log_warning "GitHub settings incomplete - skipping"
        GITHUB_USER=""
        GITHUB_REPO=""
      fi
    else
      log_warning "Skipping GitHub configuration"
      GITHUB_USER=""
    fi
  else
    log_warning "Skipping GitHub configuration"
  fi
  echo ""

  # Write to env files
  write_env ".env.local" "GITHUB_USER" "$GITHUB_USER"
  write_env ".env.local" "GITHUB_REPO" "$GITHUB_REPO"
  write_env ".env.local" "GITHUB_TOKEN" "$GITHUB_TOKEN"
  write_env ".env.production" "GITHUB_USER" "$GITHUB_USER"
  write_env ".env.production" "GITHUB_REPO" "$GITHUB_REPO"
  write_env ".env.production" "GITHUB_TOKEN" "$GITHUB_TOKEN"

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
  write_env ".env.local" "GDRIVE_REMOTE" "$GDRIVE_REMOTE"
  write_env ".env.local" "GDRIVE_ROOT" "$GDRIVE_ROOT"
  write_env ".env.production" "GDRIVE_REMOTE" "$GDRIVE_REMOTE"
  write_env ".env.production" "GDRIVE_ROOT" "$GDRIVE_ROOT"

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
  write_env ".env.local" "AUTH_SECRET" "$AUTH_SECRET"
  write_env ".env.production" "AUTH_SECRET" "$AUTH_SECRET"

  log_success "AUTH_SECRET saved"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
  section "Welcome"
  log "This wizard will guide you through ${WIZARD_TOTAL} steps and write:"
  echo "  • .env.local"
  echo "  • .env.production"
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
  collect_cloudflare
  collect_production_url
  collect_email_settings
  collect_github_settings
  collect_gdrive_settings
  generate_auth_secret

  # Success message
  section "Setup Complete!"

  log_success "All credentials have been collected and saved!"
  echo ""
  echo "Configuration files created:"
  echo "  • .env.local      (for local development)"
  echo "  • .env.production (for production deployment)"
  echo ""
  if [[ -n "${MC_AWS_SETUP_RETURN_TO_SETUP_SH:-}" ]]; then
    echo "Returning to setup.sh to deploy infrastructure..."
    echo ""
  else
    echo "Next steps:"
    echo "  1. Review your credentials in .env.local"
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
main "$@"
