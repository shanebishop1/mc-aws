#!/usr/bin/env bash
set -euo pipefail

# Logging function - uses logger for systemd/journald integration
log() {
  logger -t minecraft-idle "$@"
}

log "check-mc-idle.sh invoked"

# Skip if maintenance is in progress (backup/restore)
MAINTENANCE_LOCK="/tmp/mc-maintenance.lock"
if [[ -f "$MAINTENANCE_LOCK" ]]; then
  log "Maintenance in progress, skipping idle check"
  exit 0
fi

IDLE_MARKER=/tmp/mc-idle.marker
THRESHOLD=$((15 * 60))   # 15 mins

# Helper function to get instance ID (IMDSv2)
get_instance_id() {
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
}

# Helper function to get region (IMDSv2)
get_region() {
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region
}

# Write player count to SSM for frontend display
update_player_count() {
  local count=$1
  local region=$(get_region)
  aws ssm put-parameter \
    --name "/minecraft/player-count" \
    --value "$count" \
    --type "String" \
    --overwrite \
    --region "$region" 2>/dev/null || log "Warning: Failed to update player count in SSM"
}

# 1. Query player count
set +e
MC_OUTPUT=$(/usr/local/bin/mcstatus localhost status 2>&1)
MC_EXIT_CODE=$?
set -e

PLAYERS=0
if [[ $MC_EXIT_CODE -eq 0 ]]; then
  PLAYERS_LINE=$(echo "$MC_OUTPUT" | grep -i '^players:' || true)
  if [[ -n "$PLAYERS_LINE" ]]; then
    PLAYERS=$(echo "$PLAYERS_LINE" | awk '{ print $2 }' | cut -d'/' -f1)
    if ! [[ "$PLAYERS" =~ ^[0-9]+$ ]]; then
      log "Warning: failed to parse player count, treating as 0"
      PLAYERS=0
    fi
  fi
else
  log "mcstatus failed (treating as 0 players): $MC_OUTPUT"
  PLAYERS=0
fi

log "$PLAYERS players online"

# Write player count to SSM
update_player_count "$PLAYERS"

# 2. If players are online, clear marker and exit
if (( PLAYERS > 0 )); then
  log "Players online, clearing idle marker"
  rm -f "$IDLE_MARKER"
  exit 0
fi

# 3. No players (or server down) - start/check idle timer
if [[ ! -f "$IDLE_MARKER" ]]; then
  log "No players, starting idle timer"
  touch "$IDLE_MARKER"
  exit 0
fi

# 4. Check how long we've been idle
NOW=$(date +%s)
IDLE_TS=$(stat -c %Y "$IDLE_MARKER")
ELAPSED=$(( NOW - IDLE_TS ))

log "Idle for $(( ELAPSED / 60 ))m"

if (( ELAPSED > THRESHOLD )); then
  log "Idle for $(( THRESHOLD / 60 ))m, shutting down..."

  # Stop Minecraft gracefully (if running)
  if systemctl is-active --quiet minecraft.service; then
    systemctl stop minecraft.service
    for i in {1..24}; do
      systemctl is-active --quiet minecraft.service || break
      sleep 5
    done
  fi

  rm -f "$IDLE_MARKER"
  log "Stopping EC2 instance"

  INSTANCE_ID=$(get_instance_id)
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
fi
