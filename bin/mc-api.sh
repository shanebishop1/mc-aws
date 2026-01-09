#!/usr/bin/env bash
# ============================================================================
# Minecraft Server API CLI
# ============================================================================
# Shell wrapper for the Minecraft management API.
# This provides a CLI interface to the Next.js API endpoints.
# ============================================================================

set -euo pipefail

# Configuration
API_URL="${MC_API_URL:-http://localhost:3000}"

# Logger
log() { echo "[$(date -Is)] $*"; }

show_help() {
  cat << EOF
Minecraft Server API CLI

Usage: mc-api.sh <command> [options]

Commands:
  status    - Get server status
  start     - Start the server
  stop      - Stop the server
  hibernate - Backup + stop + delete volume
  resume    - Create volume + start (optionally from backup)
  backup    - Trigger backup to Google Drive
  restore   - Restore from backup (optionally specify backup name)
  backups   - List available backups

Options:
  --help    - Show this help message

Environment:
  MC_API_URL - API base URL (default: http://localhost:3000)

Examples:
  mc-api.sh status
  mc-api.sh start
  mc-api.sh restore mc-backup-2026-01-09-120000
EOF
}

# Check for command
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]]; then
  show_help
  exit 0
fi

COMMAND="$1"
shift

# Pretty print helper
print_response() {
  if command -v jq >/dev/null 2>&1; then
    jq '.'
  else
    cat
  fi
}

# Generic API call helper
api_call() {
  local method="$1"
  local endpoint="$2"
  local data="${3:-}"

  if [[ "$method" == "POST" ]]; then
    if [[ -n "$data" ]]; then
      curl -s -X POST -H "Content-Type: application/json" -d "$data" "${API_URL}/api/${endpoint}" | print_response
    else
      # Send empty JSON object as default body for POST
      curl -s -X POST -H "Content-Type: application/json" -d "{}" "${API_URL}/api/${endpoint}" | print_response
    fi
  else
    curl -s "${API_URL}/api/${endpoint}" | print_response
  fi
}

case "$COMMAND" in
  status)
    log "Getting server status..."
    api_call "GET" "status"
    ;;
  start)
    log "Starting server..."
    api_call "POST" "start"
    ;;
  stop)
    log "Stopping server..."
    api_call "POST" "stop"
    ;;
  hibernate)
    log "Hibernating server..."
    api_call "POST" "hibernate"
    ;;
  resume)
    BACKUP_NAME="${1:-}"
    if [[ -n "$BACKUP_NAME" ]]; then
      log "Resuming server from backup: $BACKUP_NAME..."
      api_call "POST" "resume" "{\"backupName\": \"$BACKUP_NAME\"}"
    else
      log "Resuming server..."
      api_call "POST" "resume"
    fi
    ;;
  backup)
    log "Triggering backup..."
    api_call "POST" "backup"
    ;;
  restore)
    BACKUP_NAME="${1:-}"
    if [[ -n "$BACKUP_NAME" ]]; then
      log "Restoring from backup: $BACKUP_NAME..."
      api_call "POST" "restore" "{\"backupName\": \"$BACKUP_NAME\"}"
    else
      log "Restoring from latest backup..."
      api_call "POST" "restore"
    fi
    ;;
  backups)
    log "Listing backups..."
    api_call "GET" "backups"
    ;;
  *)
    echo "Error: Unknown command '$COMMAND'"
    show_help
    exit 1
    ;;
esac
