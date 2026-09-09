#!/usr/bin/env bash
set -euo pipefail

# Logging function - uses logger for systemd/journald integration
log() {
  logger -t minecraft-idle "$@"
}

log "check-mc-idle.sh invoked"

# Skip if maintenance is in progress (backup/restore)
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/run/mc-agent/maintenance-state.json}"
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
OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
MC_HOST_OPERATION_HELPER="${MC_HOST_OPERATION_HELPER:-/usr/local/bin/mc-host-operation.py}"
EXECUTOR_JOURNAL="${MC_EXECUTOR_JOURNAL:-/var/lib/mc-agent-executor/executor-effect-journal.json}"
EXECUTOR_JOURNAL_CREDENTIAL="${MC_EXECUTOR_JOURNAL_CREDENTIAL:-/etc/mc-agent/executor-journal-hmac.key}"
GATEWAY_RECONCILIATION_JOURNAL="${MC_GATEWAY_RECONCILIATION_JOURNAL:-/var/lib/mc-agent-gateway/executor-reconciliations.json}"
EXECUTOR_JOURNAL_CHECKPOINT="${MC_EXECUTOR_JOURNAL_CHECKPOINT:-0}"
AGENT_DRAIN_MAX_ATTEMPTS="${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30}"
AGENT_DRAIN_INTERVAL="${MC_AGENT_DRAIN_INTERVAL:-1}"
QUIESCE_UNITS=(minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service)

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

  if ! command -v flock >/dev/null 2>&1 || [[ ! -x "$MC_HOST_OPERATION_HELPER" ]]; then
    log "Warning: authoritative idle-shutdown verification is unavailable"
    clear_idle_state
    exit 0
  fi
  exec 9>"$OPERATION_LOCK"
  if ! flock -n 9; then
    log "Lifecycle operation in progress; suppressing idle shutdown"
    clear_idle_state
    exit 0
  fi
  if [[ -e "$MAINTENANCE_LOCK" || -L "$MAINTENANCE_LOCK" ]]; then
    log "Maintenance began during idle observation; suppressing idle shutdown"
    clear_idle_state
    exit 0
  fi

  MAINTENANCE_OWNER="idle-shutdown-$$-$(python3 -c 'import secrets; print(secrets.token_hex(8))')"
  python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" <<'PY'
import json, os, sys
path, owner = sys.argv[1:]
payload = {"schemaVersion": 1, "owner": owner, "operation": "idle-shutdown", "phase": "quiescing"}
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
with os.fdopen(descriptor, "wb") as output:
    output.write(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n")
    output.flush()
    os.fsync(output.fileno())
directory = os.open(os.path.dirname(path), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY

  declare -A SERVICE_WAS_ACTIVE SERVICE_WAS_RUNTIME_MASKED
  for unit in "${QUIESCE_UNITS[@]}"; do
    if systemctl is-active --quiet "$unit"; then SERVICE_WAS_ACTIVE["$unit"]=1; else SERVICE_WAS_ACTIVE["$unit"]=0; fi
    if [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == "masked-runtime" ]]; then
      SERVICE_WAS_RUNTIME_MASKED["$unit"]=1
    else
      SERVICE_WAS_RUNTIME_MASKED["$unit"]=0
    fi
  done
  SERVICES_MASKED=0
  SHUTDOWN_COMMITTED=0
  cleanup_quiescence() {
    local exit_code=$?
    trap - EXIT HUP INT TERM
    if [[ "$SHUTDOWN_COMMITTED" != "1" ]]; then
      if [[ "$SERVICES_MASKED" == "1" ]]; then
        for unit in "${QUIESCE_UNITS[@]}"; do
          if [[ "${SERVICE_WAS_RUNTIME_MASKED[$unit]}" != "1" ]]; then systemctl unmask --runtime "$unit" || true; fi
        done
        systemctl daemon-reload || true
      fi
      for unit in "${QUIESCE_UNITS[@]}"; do
        if [[ "${SERVICE_WAS_ACTIVE[$unit]}" == "1" ]]; then systemctl start "$unit" || true; fi
      done
      python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" <<'PY' || true
import json, os, sys
path, owner = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
    if value.get("schemaVersion") == 1 and value.get("owner") == owner and value.get("operation") == "idle-shutdown":
        os.unlink(path)
except FileNotFoundError:
    pass
PY
    fi
    exit "$exit_code"
  }
  trap cleanup_quiescence EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [[ "${SERVICE_WAS_ACTIVE[mc-agent-gateway.service]}" == "1" ]]; then
    systemctl kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service
    for ((attempt = 1; attempt <= AGENT_DRAIN_MAX_ATTEMPTS; attempt++)); do
      systemctl is-active --quiet mc-agent-gateway.service || break
      if (( attempt == AGENT_DRAIN_MAX_ATTEMPTS )); then
        log "Warning: gateway did not drain; suppressing idle shutdown"
        exit 0
      fi
      sleep "$AGENT_DRAIN_INTERVAL"
    done
  fi
  systemctl mask --runtime "${QUIESCE_UNITS[@]}"
  SERVICES_MASKED=1

  VERIFIED_IDLE=0
  for ((attempt = 1; attempt <= AGENT_DRAIN_MAX_ATTEMPTS; attempt++)); do
    if "$MC_HOST_OPERATION_HELPER" executor-idle \
      --journal "$EXECUTOR_JOURNAL" \
      --credential "$EXECUTOR_JOURNAL_CREDENTIAL" \
      --gateway-journal "$GATEWAY_RECONCILIATION_JOURNAL" \
      --handoff-state auto \
      --checkpoint-sequence "$EXECUTOR_JOURNAL_CHECKPOINT" >/dev/null 2>&1; then
      VERIFIED_IDLE=1
      break
    fi
    if (( attempt < AGENT_DRAIN_MAX_ATTEMPTS )); then sleep "$AGENT_DRAIN_INTERVAL"; fi
  done
  if [[ "$VERIFIED_IDLE" != "1" ]]; then
    log "Warning: executor journal is not authoritatively idle; suppressing shutdown"
    clear_idle_state
    exit 0
  fi

  systemctl stop "${QUIESCE_UNITS[@]}"
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
  SHUTDOWN_COMMITTED=1
fi
