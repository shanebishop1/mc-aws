#!/usr/bin/env bash
set -euo pipefail

# Logging function - uses logger for systemd/journald integration
log() {
  logger -t minecraft-idle "$@"
}

log "check-mc-idle.sh invoked"

IDLE_MARKER=/tmp/mc-idle.marker
THRESHOLD=$((15 * 60))   # 15 mins

# 1. Query player count, handling connection errors
set +e # Disable exit on error temporarily
MC_OUTPUT=$(/usr/local/bin/mcstatus localhost status 2>&1) # Capture stdout and stderr
MC_EXIT_CODE=$?
set -e # Re-enable exit on error

PLAYERS=0 # Default to 0 players
if [[ $MC_EXIT_CODE -eq 0 ]]; then
  PLAYERS_LINE=$(echo "$MC_OUTPUT" | grep -i '^players:' || true)

  if [[ -n "$PLAYERS_LINE" ]]; then
    # 2) Extract the “0” from “0/20 …”
    PLAYERS=$(echo "$PLAYERS_LINE" | awk '{ print $2 }' | cut -d'/' -f1)
    log "$PLAYERS players are online"
  else
    log "Warning – no players line in mcstatus output: $MC_OUTPUT"
    PLAYERS=0
  fi

  # 3) Validate it really is a number
  if ! [[ "$PLAYERS" =~ ^[0-9]+$ ]]; then
    log "Warning – failed to parse player count from mcstatus output: $MC_OUTPUT"
    PLAYERS=0
  fi
else
  # For any other mcstatus error, log it and exit to avoid incorrect shutdown
  log "Error - mcstatus failed with unexpected error (Exit Code: $MC_EXIT_CODE): $MC_OUTPUT"
  exit 1 # Exit the script to prevent potentially incorrect shutdown
fi


# 2. If any players are online, remove marker and exit
if (( PLAYERS > 0 )); then
  log "Removing idle marker since players are online"
  rm -f "$IDLE_MARKER"
  exit 0
fi

# 3. No players online:
#    a) If marker doesn't exist, create it and exit
if [[ ! -f "$IDLE_MARKER" ]]; then
  log "No players are online and no idle marker exists, so creating one"
  touch "$IDLE_MARKER"
  exit 0
fi

#    b) Marker exists—check its age
NOW=$(date +%s)
IDLE_TS=$(stat -c %Y "$IDLE_MARKER")
ELAPSED=$(( NOW - IDLE_TS ))

if (( ELAPSED > THRESHOLD )); then
  log "No players for $(( THRESHOLD/60 ))m, shutting down…"

  # Gracefully stop Minecraft
  systemctl stop minecraft.service

  # Wait up to 2m for it to exit
  for i in {1..24}; do
    if ! systemctl is-active --quiet minecraft.service; then
      break
    fi
    sleep 5
  done

  rm -f "$IDLE_MARKER"

  log "Minecraft stopped; halting EC2 instance"

  # Stop the EC2 instance
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
fi
