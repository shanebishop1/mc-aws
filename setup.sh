#!/usr/bin/env bash
# Main entry point for the mc-aws setup wizard
# This script verifies prerequisites and guides you through the initial setup

set -euo pipefail

iso_now() {
  if date -Is >/dev/null 2>&1; then
    date -Is
    return
  fi

  # macOS/BSD date does not support -I
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

# Log function with timestamp
log() {
  echo "[$(iso_now)] $*"
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

  # Step 4: Install CDK dependencies
  step "Installing CDK infrastructure dependencies"
  log "Running 'pnpm install' in /infra directory..."
  cd infra
  pnpm install
  cd ..
  success "CDK dependencies installed"

  # Step 5: Run setup wizard
  step "Starting interactive setup wizard"
  log "Launching scripts/setup-wizard.sh..."
  if [ ! -f "scripts/setup-wizard.sh" ]; then
    error_exit "Setup wizard script not found at scripts/setup-wizard.sh"
  fi

  # Make sure the wizard is executable
  chmod +x scripts/setup-wizard.sh

  # Run the wizard
  exec ./scripts/setup-wizard.sh
}

# Run main function
main "$@"
