#!/usr/bin/env bash
set -euo pipefail

# Logging function - uses logger for systemd/journald integration
log() {
  logger -t minecraft-idle "$@"
}

log "check-mc-idle.sh invoked"

# Skip if maintenance is in progress (backup/restore)
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/tmp/mc-maintenance.lock}"
if [[ -f "$MAINTENANCE_LOCK" ]]; then
  log "Maintenance in progress, skipping idle check"
  exit 0
fi

IDLE_MARKER="${MC_IDLE_MARKER:-/tmp/mc-idle.marker}"
EMPTY_STREAK_FILE="${MC_EMPTY_STREAK_FILE:-/tmp/mc-idle-empty-streak}"
THRESHOLD=$((15 * 60)) # 15 mins
CHECK_INTERVAL_SECONDS="${MC_IDLE_CHECK_INTERVAL_SECONDS:-60}"
REQUIRED_EMPTY_OBSERVATIONS="${MC_IDLE_REQUIRED_EMPTY_OBSERVATIONS:-$((THRESHOLD / CHECK_INTERVAL_SECONDS))}"
MCSTATUS_BIN="${MCSTATUS_BIN:-/usr/local/bin/mcstatus}"

# Helper function to get instance ID (IMDSv2)
get_instance_id() {
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id
}

# Helper function to get region (IMDSv2)
get_region() {
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region
}

# Write player count to SSM for frontend display
update_player_count() {
  local count=$1
  aws ssm put-parameter \
    --name "/minecraft/player-count" \
    --value "$count" \
    --type "String" \
    --overwrite \
    --region "$AWS_REGION" 2>/dev/null || log "Warning: Failed to update player count in SSM"
}

clear_idle_state() {
  rm -f "$IDLE_MARKER" "$EMPTY_STREAK_FILE"
}

record_empty_observation() {
  local now=$1
  local count=0
  local first_observed_ts=$now

  if [[ -f "$EMPTY_STREAK_FILE" ]]; then
    local streak_raw
    streak_raw=$(<"$EMPTY_STREAK_FILE")
    local existing_count
    local existing_first_ts
    IFS=':' read -r existing_count existing_first_ts <<<"$streak_raw"

    if [[ "$existing_count" =~ ^[0-9]+$ ]] && [[ "$existing_first_ts" =~ ^[0-9]+$ ]]; then
      count=$((existing_count + 1))
      first_observed_ts=$existing_first_ts
    else
      log "Warning: malformed idle streak state '$streak_raw', resetting"
      count=1
      first_observed_ts=$now
    fi
  else
    count=1
  fi

  printf "%s:%s" "$count" "$first_observed_ts" >"$EMPTY_STREAK_FILE"
  touch "$IDLE_MARKER"
  printf "%s:%s" "$count" "$first_observed_ts"
}

AWS_REGION="${AWS_REGION:-}"
if [[ -z "$AWS_REGION" ]]; then
  AWS_REGION=$(get_region)
fi

if [[ -z "$AWS_REGION" ]]; then
  log "Warning: could not resolve AWS region; suppressing idle shutdown check"
  exit 0
fi

# 1. Query player count
set +e
MC_OUTPUT=$($MCSTATUS_BIN localhost status 2>&1)
MC_EXIT_CODE=$?
set -e

PLAYERS=""
PROBE_OK=0

if [[ $MC_EXIT_CODE -eq 0 ]]; then
  PLAYERS_LINE=$(echo "$MC_OUTPUT" | grep -i '^players:' || true)
  if [[ -n "$PLAYERS_LINE" ]]; then
    PLAYERS=$(echo "$PLAYERS_LINE" | awk '{ print $2 }' | cut -d'/' -f1)
    if [[ "$PLAYERS" =~ ^[0-9]+$ ]]; then
      PROBE_OK=1
    else
      log "Probe parse failure: non-numeric player count '$PLAYERS' from '$PLAYERS_LINE'"
    fi
  else
    log "Probe parse failure: missing players line in mcstatus output"
  fi
else
  log "Probe command failure: mcstatus exit=$MC_EXIT_CODE output='$MC_OUTPUT'"
fi

if [[ "$PROBE_OK" -ne 1 ]]; then
  clear_idle_state
  log "Probe unavailable/malformed; cleared idle streak and suppressed shutdown"
  exit 0
fi

log "$PLAYERS players online"

# Write player count to SSM
update_player_count "$PLAYERS"

# 2. If players are online, clear marker and exit
if (( PLAYERS > 0 )); then
  log "Players online, clearing idle streak"
  clear_idle_state
  exit 0
fi

# 3. No players and probe succeeded - advance successful empty streak
NOW=$(date +%s)
STREAK_STATE=$(record_empty_observation "$NOW")
STREAK_COUNT=${STREAK_STATE%%:*}
FIRST_EMPTY_TS=${STREAK_STATE##*:}
ELAPSED=$((NOW - FIRST_EMPTY_TS))

log "Empty-player observation $STREAK_COUNT/$REQUIRED_EMPTY_OBSERVATIONS (elapsed ${ELAPSED}s)"

if (( STREAK_COUNT >= REQUIRED_EMPTY_OBSERVATIONS )); then
  log "Idle shutdown triggered after $STREAK_COUNT consecutive successful empty probes"

  # Stop Minecraft gracefully (if running)
  if systemctl is-active --quiet minecraft.service; then
    systemctl stop minecraft.service
    for i in {1..24}; do
      systemctl is-active --quiet minecraft.service || break
      sleep 5
    done
  fi

  clear_idle_state
  log "Stopping EC2 instance due to verified idle condition"

  INSTANCE_ID="${INSTANCE_ID:-}"
  if [[ -z "$INSTANCE_ID" ]]; then
    INSTANCE_ID=$(get_instance_id)
  fi

  if [[ -z "$INSTANCE_ID" ]]; then
    log "Warning: could not resolve instance ID; skipping stop-instances"
    exit 0
  fi

  aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$AWS_REGION"
fi
