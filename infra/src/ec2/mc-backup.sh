#!/usr/bin/env bash
# Backup Minecraft server to Google Drive
# Usage: mc-backup.sh [--hibernate|--destroy|--replacement|--recover-hibernate] [--require-active] [--agent-two-phase] [backup-name]
# If no name provided, use timestamp

set -euo pipefail
umask 077

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

BACKUP_MODE="ordinary"
TERMINAL_BACKUP=0
REQUIRE_ACTIVE=0
AGENT_TWO_PHASE=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --hibernate)
      BACKUP_MODE="hibernate"
      TERMINAL_BACKUP=1
      ;;
    --destroy)
      BACKUP_MODE="destroy"
      TERMINAL_BACKUP=1
      ;;
    --replacement)
      BACKUP_MODE="replacement"
      TERMINAL_BACKUP=1
      ;;
    --recover-hibernate)
      BACKUP_MODE="recover-hibernate"
      ;;
    --verify-terminal)
      BACKUP_MODE="verify-terminal"
      ;;
    --require-active)
      REQUIRE_ACTIVE=1
      ;;
    --agent-two-phase)
      AGENT_TWO_PHASE=1
      ;;
    *)
      log "ERROR: Unsupported backup option: $1"
      exit 2
      ;;
  esac
  shift
done

if (( $# > 1 )); then
  log "ERROR: Too many backup arguments"
  exit 2
fi

export RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/setup/rclone/rclone.conf}"
RCLONE_CONFIG_HELPER="${MC_RCLONE_CONFIG_HELPER:-/usr/local/bin/mc-rclone-config.sh}"

# Hold one atomic critical section shared by backup, restore, and hibernate recovery.
OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
if ! command -v flock >/dev/null 2>&1; then
  log "ERROR: flock is required for lifecycle operation serialization"
  exit 1
fi
exec 9>"$OPERATION_LOCK"
if ! flock -n 9; then
  log "ERROR: Another backup, restore, or hibernate operation is in progress"
  exit 1
fi

# This is deliberately outside /tmp.  The gateway and executor use PrivateTmp,
# so a /tmp marker is not a process-wide fence.  The root-owned state below is
# readable by the gateway through its explicit ReadOnlyPaths grant.
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/run/mc-agent/maintenance-state.json}"
HIBERNATE_GUARD="${MC_HIBERNATE_GUARD:-/tmp/mc-hibernate-in-progress}"
BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
MAINTENANCE_BOOT_HOLD="${MC_MAINTENANCE_BOOT_HOLD:-/var/lib/mc-aws/maintenance-boot-hold.json}"
MAINTENANCE_BOOT_HELPER="${MC_MAINTENANCE_BOOT_HELPER:-/usr/local/bin/mc-maintenance-boot.py}"
MAINTENANCE_LOCK_OWNED=0
BACKUP_UPLOADED=0
REMOTE_ARCHIVE_UPLOADED=0
SERVICES_QUIESCED=0
SERVICE_RESTORE_FAILED=0
HIBERNATE_QUIESCENCE_HELD=0
QUIESCENCE_EVIDENCE=""
BACKUP_ARCHIVE=""
BACKUP_MANIFEST=""
BACKUP_WORK_DIR=""
MINECRAFT_WAS_ACTIVE=0
BACKUP_JOURNAL=""
BACKUP_ID="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
BACKUP_CREATED_AT=""
BACKUP_GENERATION=""
QUIESCENCE_EPOCH="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
SERVICE_STATES_JSON=""
ROOT_VOLUME_ID="${MC_ROOT_VOLUME_ID:-}"
ROOT_VOLUME_DEVICE="${MC_ROOT_VOLUME_DEVICE:-}"
BOOT_HOLD_OPERATION="backup"
MAINTENANCE_OPERATION="backup"
BOOT_HOLD_OWNED=0
if [[ "$BACKUP_MODE" == "hibernate" || "$BACKUP_MODE" == "recover-hibernate" || "$BACKUP_MODE" == "destroy" || "$BACKUP_MODE" == "replacement" ]]; then
  if [[ "$BACKUP_MODE" == "recover-hibernate" ]]; then
    BOOT_HOLD_OPERATION="hibernate"
  elif [[ "$BACKUP_MODE" == "replacement" ]]; then
    BOOT_HOLD_OPERATION="host-replacement"
    MAINTENANCE_OPERATION="host-replacement"
  else
    BOOT_HOLD_OPERATION="$BACKUP_MODE"
  fi
fi
RECOVERY_PHASE=""
EXECUTOR_JOURNAL="${MC_EXECUTOR_JOURNAL:-/var/lib/mc-agent-executor/executor-effect-journal.json}"
GATEWAY_RECONCILIATION_JOURNAL="${MC_GATEWAY_RECONCILIATION_JOURNAL:-/var/lib/mc-agent-gateway/executor-reconciliations.json}"
EXECUTOR_JOURNAL_CREDENTIAL="${MC_EXECUTOR_JOURNAL_CREDENTIAL:-/etc/mc-agent/executor-journal-hmac.key}"
EXECUTOR_JOURNAL_CHECKPOINT="${MC_EXECUTOR_JOURNAL_CHECKPOINT:-0}"
MC_HOST_OPERATION_HELPER="${MC_HOST_OPERATION_HELPER:-/usr/local/bin/mc-host-operation.py}"
BACKUP_JOURNAL="${MC_BACKUP_JOURNAL:-/var/lib/mc-aws/mc-backup-journal.json}"
MCSTATUS_BIN="${MC_STATUS_BIN:-/usr/local/bin/mcstatus}"
WORLD_ROOTS_HELPER="${MC_WORLD_ROOTS_HELPER:-/usr/local/bin/mc-agent-world-roots.py}"
WORKSPACE_DAC_HELPER="${MC_WORKSPACE_DAC_HELPER:-/usr/local/bin/mc-agent-workspace-dac.py}"
MAINTENANCE_OWNER="${MC_MAINTENANCE_OWNER:-backup-$$-$(python3 -c 'import secrets; print(secrets.token_hex(8))')}"
QUIESCE_UNITS=(minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service)
declare -A SERVICE_WAS_ACTIVE SERVICE_WAS_RUNTIME_MASKED

reconcile_workspace_dac() {
  [[ -x "$WORKSPACE_DAC_HELPER" ]] || { log "ERROR: Workspace DAC helper is unavailable"; return 1; }
  "$WORKSPACE_DAC_HELPER" reconcile
}

write_maintenance_state() {
  python3 - "$MAINTENANCE_LOCK" "${MAINTENANCE_OWNER}" "$AGENT_TWO_PHASE" "$BACKUP_MODE" "$MAINTENANCE_OPERATION" <<'PY'
import json, os, sys
path, owner, two_phase, mode, operation = sys.argv[1:]
payload = {
    "schemaVersion": 1,
    "owner": owner,
    "operation": operation,
    "phase": "archiving",
    "twoPhase": two_phase == "1",
    "mode": "terminal-hibernate" if mode == "hibernate" else ("terminal-destroy" if mode == "destroy" else ("terminal-replacement" if mode == "replacement" else "ordinary")),
}

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
  chmod 0644 -- "$MAINTENANCE_LOCK"
}

acquire_or_adopt_boot_hold() {
  local existing owner operation
  if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
    if ! existing="$(python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" inspect)"; then
      log "ERROR: Durable maintenance boot hold is invalid"
      return 1
    fi
    owner="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["owner"])' "$existing")"
    operation="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["operation"])' "$existing")"
    if [[ "$owner" != "$MAINTENANCE_OWNER" || "$operation" != "$BOOT_HOLD_OPERATION" ]]; then
      log "ERROR: Durable maintenance boot hold belongs to another transaction"
      return 1
    fi
  else
    if [[ -n "$RECOVERY_PHASE" && "$RECOVERY_PHASE" != "prepared" ]]; then
      log "ERROR: Durable maintenance boot hold is missing for a mutated transaction"
      return 1
    fi
    python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
      create --owner "$MAINTENANCE_OWNER" --operation "$BOOT_HOLD_OPERATION" --attempt "$QUIESCENCE_EPOCH" --phase prepared || return 1
  fi
  BOOT_HOLD_OWNED=1
}

update_boot_hold() {
  (( BOOT_HOLD_OWNED == 1 )) || { log "ERROR: Durable maintenance boot hold is not owned"; return 1; }
  python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
    phase --owner "$MAINTENANCE_OWNER" --phase "$1"
}

clear_boot_hold() {
  (( BOOT_HOLD_OWNED == 1 )) || return 0
  python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" clear --owner "$MAINTENANCE_OWNER" || return 1
  BOOT_HOLD_OWNED=0
}

acquire_maintenance_fence() {
  local existing_owner=""
  if [[ -e "$MAINTENANCE_LOCK" || -L "$MAINTENANCE_LOCK" ]]; then
    existing_owner="$(python3 - "$MAINTENANCE_LOCK" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="ascii"))
    if value.get("schemaVersion") == 1 and isinstance(value.get("owner"), str):
        print(value["owner"])
except (OSError, ValueError, TypeError):
    pass
PY
)"
    if [[ -n "$existing_owner" && -f "$BACKUP_JOURNAL" ]] &&
       "$MC_HOST_OPERATION_HELPER" backup-journal inspect --journal "$BACKUP_JOURNAL" --output json 2>/dev/null |
         python3 -c 'import json,sys; value=json.load(sys.stdin); expected_key,mode,owner=sys.argv[1:]; expected_mode="hibernate" if mode=="recover-hibernate" else mode; raise SystemExit(0 if value["maintenanceOwner"]==owner and value["mode"]==expected_mode and (not expected_key or value["operationKey"]==expected_key) else 1)' "$MC_REMOTE_OPERATION_KEY" "$BACKUP_MODE" "$existing_owner"; then
      # A remote-operation retry may adopt the exact root fence left by a
      # crashed uploader.  The journal operation key, not a /tmp marker, is
      # the authoritative recovery identity.
      MAINTENANCE_OWNER="$existing_owner"
      MAINTENANCE_LOCK_OWNED=1
      return 0
    fi
    log "ERROR: Maintenance fence is already held${existing_owner:+ by ${existing_owner}}"
    return 1
  fi
  write_maintenance_state
  MAINTENANCE_LOCK_OWNED=1
}

capture_service_states() {
  SERVICE_STATES_JSON="$("$MC_HOST_OPERATION_HELPER" service-state capture)" || return 1
  load_service_state_maps
}

load_service_state_maps() {
  local unit active enablement
  while IFS=$'\t' read -r unit active enablement; do
    SERVICE_WAS_ACTIVE["$unit"]="$active"
    [[ "$enablement" == "masked-runtime" ]] && SERVICE_WAS_RUNTIME_MASKED["$unit"]=1 || SERVICE_WAS_RUNTIME_MASKED["$unit"]=0
  done < <(python3 -c 'import json,sys; [print(x["unit"], "1" if x["active"] else "0", x["enablement"], sep="\t") for x in json.loads(sys.argv[1])]' "$SERVICE_STATES_JSON")
}

drain_executor() {
  local attempt
  for ((attempt = 1; attempt <= ${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30}; attempt++)); do
    if [[ ! -e "$EXECUTOR_JOURNAL" ]]; then
      if [[ "${SERVICE_WAS_ACTIVE[mc-agent-executor.service]:-0}" == "1" ]]; then
        log "ERROR: Active executor has no authenticated journal"
        return 1
      fi
    fi
    if [[ ! -x "$MC_HOST_OPERATION_HELPER" ]]; then
      log "ERROR: Host-operation verifier is unavailable"
      return 1
    fi
    if "$MC_HOST_OPERATION_HELPER" executor-idle \
      --journal "$EXECUTOR_JOURNAL" \
      --credential "$EXECUTOR_JOURNAL_CREDENTIAL" \
      --gateway-journal "$GATEWAY_RECONCILIATION_JOURNAL" \
      --handoff-state auto \
      --checkpoint-sequence "$EXECUTOR_JOURNAL_CHECKPOINT" >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt == ${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30} )); then
      log "ERROR: Executor work did not drain before the maintenance deadline"
      return 1
    fi
    sleep "${MC_AGENT_DRAIN_INTERVAL:-1}"
  done
}

quiesce_runtime() {
  local attempt
  [[ -n "$SERVICE_STATES_JSON" ]] || { log "ERROR: Durable service pre-state is unavailable"; return 1; }
  if [[ "${SERVICE_WAS_ACTIVE[mc-agent-gateway.service]:-0}" == "1" ]]; then
    log "Draining the gateway behind the global maintenance fence..."
    systemctl kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service || return 1
    if (( AGENT_TWO_PHASE == 0 )); then
      for ((attempt = 1; attempt <= ${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30}; attempt++)); do
        systemctl is-active --quiet mc-agent-gateway.service || break
        if (( attempt == ${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30} )); then
          log "ERROR: Gateway did not drain before the maintenance deadline"
          return 1
        fi
        sleep "${MC_AGENT_DRAIN_INTERVAL:-1}"
      done
    else
      # The caller is the current gateway runOnce.  Waiting for that gateway
      # to exit here would deadlock the exact post-backup executor effect.
      log "Two-phase agent backup: retaining the current gateway run for its exact authorized effect"
    fi
  fi
  drain_executor || return 1
  log "Masking all runtime activation paths before archiving..."
  systemctl mask --runtime "${QUIESCE_UNITS[@]}" || return 1
  SERVICES_QUIESCED=1
  if (( AGENT_TWO_PHASE == 1 )); then
      systemctl stop mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || return 1
  else
    systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || return 1
  fi
  # A stop can race a final journal write.  Require a second authenticated idle
  # observation after all effect-producing units are stopped.
  drain_executor || return 1
}

verify_quiescence() {
  local unit active_state enabled_state
  local -a expected_units=("${QUIESCE_UNITS[@]}")

  if [[ ! -f "$MAINTENANCE_LOCK" || -L "$MAINTENANCE_LOCK" ]]; then
    log "ERROR: Runtime maintenance fence is not held"
    return 1
  fi
  if ! python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" "$BACKUP_MODE" "$MAINTENANCE_OPERATION" <<'PY'
import json, sys
path, owner, mode, operation = sys.argv[1:]
try:
    with open(path, encoding="ascii") as source:
        value = json.load(source)
except (OSError, ValueError, TypeError):
    raise SystemExit(1)
if (
    value.get("schemaVersion") != 1
    or value.get("owner") != owner
    or value.get("operation") != operation
    or value.get("phase") != "archiving"
    or value.get("mode") != (
        "terminal-hibernate" if mode == "hibernate"
        else "terminal-destroy" if mode == "destroy"
        else "terminal-replacement" if mode == "replacement"
        else "ordinary"
    )
):
    raise SystemExit(1)
PY
  then
    log "ERROR: Runtime maintenance fence identity or mode changed"
    return 1
  fi

  for unit in "${expected_units[@]}"; do
    active_state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$AGENT_TWO_PHASE" == "1" && "$unit" == "mc-agent-gateway.service" && "$active_state" == "active" ]]; then
      # The invoking gateway run is the one authorized two-phase effect. It
      # remains alive behind the fence until its caller receives this result.
      :
    elif [[ "$active_state" != "inactive" ]]; then
      log "ERROR: Required quiesced unit is not inactive: $unit ($active_state)"
      return 1
    fi
    enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    if [[ "$enabled_state" != "masked" && "$enabled_state" != "masked-runtime" ]]; then
      log "ERROR: Required quiesced unit is not masked: $unit ($enabled_state)"
      return 1
    fi
  done

  if [[ ! -x "$MCSTATUS_BIN" ]]; then
    log "ERROR: Minecraft protocol verifier is unavailable"
    return 1
  fi
  if timeout --kill-after=2s 5s "$MCSTATUS_BIN" 127.0.0.1:25565 status >/dev/null 2>&1; then
    log "ERROR: Minecraft protocol is still open after quiescence"
    return 1
  fi

  QUIESCENCE_EVIDENCE="$(python3 - "$BACKUP_MODE" "$CURRENT_BOOT_ID" "$ROOT_VOLUME_ID" "$ROOT_VOLUME_DEVICE" "$QUIESCENCE_EPOCH" "$MAINTENANCE_OWNER" <<'PY'
import json, sys
mode, boot_id, volume_id, volume_device, epoch, owner = sys.argv[1:]
print(json.dumps({
    "schemaVersion": 2,
    "mode": (
        "terminal-hibernate" if mode == "hibernate"
        else "terminal-destroy" if mode == "destroy"
        else "terminal-replacement" if mode == "replacement"
        else "ordinary"
    ),
    "maintenanceFence": "held",
    "maintenanceOwner": owner,
    "services": "stopped-and-masked",
    "minecraft": "inactive",
    "protocol": "closed",
    "bootId": boot_id,
    "rootVolumeId": volume_id or None,
    "rootVolumeDevice": volume_device or None,
    "quiescenceEpoch": epoch,
}, separators=(",", ":"), sort_keys=True))
PY
)"
  if [[ "$TERMINAL_BACKUP" == "1" ]]; then
    HIBERNATE_QUIESCENCE_HELD=1
  fi
}

restore_service_states() {
  if [[ "$SERVICES_QUIESCED" != "1" ]]; then return 0; fi
  update_boot_hold restoring-services || return 1
  "$MC_HOST_OPERATION_HELPER" service-state restore --state-json "$SERVICE_STATES_JSON" || return 1
  SERVICES_QUIESCED=0
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [[ "$SERVICES_QUIESCED" == "1" ]]; then
    if [[ "$TERMINAL_BACKUP" == "1" && "$HIBERNATE_QUIESCENCE_HELD" == "1" ]]; then
      # A terminal transaction never restores host writers implicitly. The
      # owning hibernate/replacement/destroy operation must perform an explicit,
      # identity-bound recovery before services can be reopened.
      log "Terminal backup cleanup: retaining stopped/masked services and maintenance fence"
    elif [[ "$BACKUP_UPLOADED" == "1" || "$REMOTE_ARCHIVE_UPLOADED" == "0" ]]; then
      if ! restore_service_states; then
        SERVICE_RESTORE_FAILED=1
        log "CRITICAL: Service-state restoration failed; runtime remains quiesced"
        exit_code=75
      fi
    else
      log "CRITICAL: Archive upload is unresolved; runtime remains quiesced for recovery"
      exit_code=1
    fi
  fi

  if [[ "$TERMINAL_BACKUP" == "1" && "$HIBERNATE_QUIESCENCE_HELD" == "1" ]]; then
    log "Terminal preservation completed without post-backup host mutation"
  elif [[ -n "$BACKUP_ARCHIVE" ]]; then
    rm -f -- "$BACKUP_ARCHIVE"
  fi
  if [[ "$TERMINAL_BACKUP" != "1" || "$BACKUP_UPLOADED" != "1" || "$HIBERNATE_QUIESCENCE_HELD" != "1" ]] &&
     [[ -n "$BACKUP_MANIFEST" ]]; then
    rm -f -- "$BACKUP_MANIFEST"
  fi
  if [[ "$TERMINAL_BACKUP" != "1" || "$BACKUP_UPLOADED" != "1" || "$HIBERNATE_QUIESCENCE_HELD" != "1" ]] &&
     [[ -n "$BACKUP_WORK_DIR" && -d "$BACKUP_WORK_DIR" ]]; then
    rm -rf -- "$BACKUP_WORK_DIR"
  fi
  if [[ "$SERVICE_RESTORE_FAILED" == "0" && "$SERVICES_QUIESCED" == "0" && "$REMOTE_ARCHIVE_UPLOADED" == "0" ]]; then
    clear_boot_hold || { log "CRITICAL: Could not clear durable maintenance boot hold"; exit_code=1; }
    [[ ! -f "$BACKUP_JOURNAL" ]] || ! type -t clear_backup_journal >/dev/null || clear_backup_journal || exit_code=1
  fi
  if [[ "$MAINTENANCE_LOCK_OWNED" == "1" ]]; then
    if [[ "$TERMINAL_BACKUP" == "1" && "$HIBERNATE_QUIESCENCE_HELD" == "1" ]]; then
      log "Terminal backup cleanup: maintenance fence remains held"
    elif [[ "$SERVICE_RESTORE_FAILED" == "0" ]] &&
       { [[ "$REMOTE_ARCHIVE_UPLOADED" == "0" ]] || [[ "$BACKUP_UPLOADED" == "1" ]]; }; then
      python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" "$MAINTENANCE_OPERATION" <<'PY' || true
import json, os, sys
path, owner, operation = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
    if value.get("schemaVersion") == 1 and value.get("owner") == owner and value.get("operation") == operation:
        os.unlink(path)
except FileNotFoundError:
    pass
PY
    else
      log "CRITICAL: Retaining maintenance fence for safe recovery"
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

CURRENT_BOOT_ID="$(cat "$BOOT_ID_FILE" 2>/dev/null || true)"
if [[ -z "$CURRENT_BOOT_ID" ]]; then
  log "ERROR: Current boot identity is unavailable"
  exit 1
fi
if [[ "$BACKUP_MODE" == "verify-terminal" ]]; then
  journal_json="$("$MC_HOST_OPERATION_HELPER" backup-journal inspect --journal "$BACKUP_JOURNAL" --output json)" || exit 1
  marker_json="$(python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" inspect)" || exit 1
  python3 - "$journal_json" "$marker_json" "$CURRENT_BOOT_ID" "${MC_EXPECTED_BOOT_ID:-}" \
    "${MC_EXPECTED_ROOT_VOLUME_ID:-}" "${MC_EXPECTED_ROOT_VOLUME_DEVICE:-}" \
    "${MC_EXPECTED_QUIESCENCE_EPOCH:-}" "${MC_EXPECTED_MAINTENANCE_OWNER:-}" <<'PY'
import json, sys
journal, marker = json.loads(sys.argv[1]), json.loads(sys.argv[2])
current_boot, expected_boot, volume_id, device, epoch, owner = sys.argv[3:]
if not expected_boot or current_boot != expected_boot:
    raise SystemExit("terminal backup boot epoch is stale")
if journal.get("mode") != "hibernate" or journal.get("phase") != "publishing-manifest":
    raise SystemExit("terminal backup journal is not at its final publication boundary")
if any((journal.get("bootId") != expected_boot, journal.get("volumeId") != volume_id,
        journal.get("volumeDevice") != device, journal.get("quiescenceEpoch") != epoch,
        journal.get("maintenanceOwner") != owner)):
    raise SystemExit("terminal backup journal identity changed")
if any((marker.get("operation") != "hibernate", marker.get("owner") != owner,
        marker.get("attempt") != epoch, marker.get("bootId") != expected_boot,
        marker.get("phase") != "publishing-manifest")):
    raise SystemExit("durable terminal maintenance identity changed")
PY
  for unit in "${QUIESCE_UNITS[@]}"; do
    if systemctl is-active --quiet "$unit"; then log "ERROR: Terminal service resumed: $unit"; exit 1; fi
    enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    if [[ "$enabled_state" != "masked" && "$enabled_state" != "masked-runtime" ]]; then
      log "ERROR: Terminal service mask was removed: $unit"
      exit 1
    fi
  done
  if timeout --kill-after=2s 5s "$MCSTATUS_BIN" 127.0.0.1:25565 status >/dev/null 2>&1; then
    log "ERROR: Minecraft protocol resumed after terminal backup"
    exit 1
  fi
  printf 'MC_BACKUP_TERMINAL_VALID\n'
  exit 0
fi

if [[ -e "$HIBERNATE_GUARD" && "$BACKUP_MODE" != "recover-hibernate" ]]; then
  IFS= read -r GUARD_BOOT_ID < "$HIBERNATE_GUARD" || true
  if [[ -z "$CURRENT_BOOT_ID" || "$GUARD_BOOT_ID" != "$CURRENT_BOOT_ID" ]]; then
    log "Removing stale hibernate guard from a previous boot"
    rm -f -- "$HIBERNATE_GUARD"
  fi
fi

if [[ -e "$HIBERNATE_GUARD" && "$BACKUP_MODE" != "recover-hibernate" ]] &&
   [[ "$BACKUP_MODE" != "hibernate" || ! -f "$BACKUP_JOURNAL" ]]; then
  log "ERROR: Hibernate is in progress; refusing to modify server state"
  exit 1
fi

BACKUP_NAME="${1:-server-$(date +%Y%m%d-%H%M%S)}"
GDRIVE_REMOTE_FILE="${MC_RCLONE_REMOTE_FILE:-/etc/minecraft/gdrive-remote}"
if [[ -z "${GDRIVE_REMOTE:-}" && -r "$GDRIVE_REMOTE_FILE" ]]; then
  IFS= read -r GDRIVE_REMOTE < "$GDRIVE_REMOTE_FILE" || true
fi
GDRIVE_ROOT_FILE="${MC_RCLONE_ROOT_FILE:-/etc/minecraft/gdrive-root}"
if [[ -z "${GDRIVE_ROOT:-}" && -r "$GDRIVE_ROOT_FILE" ]]; then
  IFS= read -r GDRIVE_ROOT < "$GDRIVE_ROOT_FILE" || true
fi
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="${MC_SERVER_DIR:-/opt/minecraft/server}"
SERVER_PARENT="$(dirname -- "$SERVER_DIR")"
BACKUP_TEMP_DIR="${MC_BACKUP_TEMP_DIR:-/tmp}"
BACKUP_ARCHIVE="${BACKUP_TEMP_DIR}/${BACKUP_NAME}.tar.gz"
BACKUP_MANIFEST="${BACKUP_ARCHIVE}.manifest.json"
MC_REMOTE_OPERATION_KEY="${MC_REMOTE_OPERATION_KEY:-}"
BACKUP_AUTH_HELPER="${MC_BACKUP_AUTH_HELPER:-/usr/local/bin/mc-backup-auth.py}"
BACKUP_GENERATION_STATE="${MC_BACKUP_GENERATION_STATE:-/var/lib/mc-aws/backup-generation.json}"
MC_HOST_OPERATION_HELPER="${MC_HOST_OPERATION_HELPER:-/usr/local/bin/mc-host-operation.py}"

if [[ "${REMOTE_OPERATION_KEY+x}" == "x" ]]; then
  log "ERROR: REMOTE_OPERATION_KEY is unsupported; use MC_REMOTE_OPERATION_KEY"
  exit 2
fi

if [[ ! "$BACKUP_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  log "ERROR: Invalid backup name: $BACKUP_NAME"
  exit 1
fi
if [[ -n "$MC_REMOTE_OPERATION_KEY" && ! "$MC_REMOTE_OPERATION_KEY" =~ ^[a-f0-9]{64}$ ]]; then
  log "ERROR: Invalid remote operation key"
  exit 1
fi
if [[ "$(basename -- "$SERVER_DIR")" != "server" || ! -d "$SERVER_PARENT" || ! -d "$BACKUP_TEMP_DIR" ]]; then
  log "ERROR: Backup paths must use an existing parent with a server child and existing temp directory"
  exit 1
fi
if [[ ! -d "$(dirname -- "$BACKUP_JOURNAL")" ]]; then
  log "ERROR: Backup journal parent does not exist"
  exit 1
fi
if [[ ! -d "$(dirname -- "$BACKUP_GENERATION_STATE")" ]]; then
  log "ERROR: Backup generation state parent does not exist"
  exit 1
fi
if [[ ! -d "$(dirname -- "$MAINTENANCE_LOCK")" ]]; then
  log "ERROR: Maintenance fence parent does not exist"
  exit 1
fi
if ! acquire_maintenance_fence; then
  log "ERROR: Another maintenance owner holds the global runtime fence"
  exit 1
fi

resolve_root_volume_identity() {
  local serial=""
  if [[ "$BACKUP_MODE" != "hibernate" && "$BACKUP_MODE" != "destroy" && "$BACKUP_MODE" != "replacement" ]]; then return 0; fi
  if [[ -z "$ROOT_VOLUME_DEVICE" ]] && command -v findmnt >/dev/null 2>&1; then
    ROOT_VOLUME_DEVICE="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
  fi
  if [[ -z "$ROOT_VOLUME_ID" && -n "$ROOT_VOLUME_DEVICE" ]] && command -v lsblk >/dev/null 2>&1; then
    serial="$(lsblk -ndo SERIAL "$ROOT_VOLUME_DEVICE" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$serial" =~ ^vol([a-f0-9]{8,17})$ ]]; then ROOT_VOLUME_ID="vol-${BASH_REMATCH[1]}"; fi
  fi
  if [[ ! "$ROOT_VOLUME_ID" =~ ^vol-[a-f0-9]{8,17}$ || ! "$ROOT_VOLUME_DEVICE" =~ ^/dev/[A-Za-z0-9._/-]{1,127}$ ]]; then
    log "ERROR: Terminal backup requires an exact root-volume identity"
    return 1
  fi
}

write_backup_journal() {
  local phase="$1"
  "$MC_HOST_OPERATION_HELPER" backup-journal write --journal "$BACKUP_JOURNAL" --phase "$phase" \
    --backup-name "$BACKUP_NAME" --mode "$BACKUP_MODE" --operation-key "$MC_REMOTE_OPERATION_KEY" \
    --backup-id "$BACKUP_ID" --created-at "$BACKUP_CREATED_AT" --generation "$BACKUP_GENERATION" \
    --maintenance-owner "$MAINTENANCE_OWNER" --boot-id "$CURRENT_BOOT_ID" \
    --volume-id "$ROOT_VOLUME_ID" --volume-device "$ROOT_VOLUME_DEVICE" \
    --quiescence-epoch "$QUIESCENCE_EPOCH" --service-states-json "$SERVICE_STATES_JSON"
  if [[ "${MC_BACKUP_CRASH_AFTER_PHASE:-}" == "$phase" ]]; then kill -KILL "$$"; fi
}

clear_backup_journal() {
  "$MC_HOST_OPERATION_HELPER" backup-journal clear --journal "$BACKUP_JOURNAL"
}

authenticate_remote_backup() {
  local -a verify_args=(
    remote-verify
    --remote "$GDRIVE_REMOTE"
    --root "$GDRIVE_ROOT"
    --config "$RCLONE_CONFIG"
    --rclone rclone
    --archive-name "${BACKUP_NAME}.tar.gz"
    --expected-backup-id "$BACKUP_ID"
    --expected-generation "$BACKUP_GENERATION"
    --output json
  )
  if [[ -n "$MC_REMOTE_OPERATION_KEY" ]]; then verify_args+=(--expected-operation-key "$MC_REMOTE_OPERATION_KEY"); fi
  BACKUP_MANIFEST_RESULT="$("$BACKUP_AUTH_HELPER" "${verify_args[@]}")"
}

recover_backup_journal() {
  [[ -f "$BACKUP_JOURNAL" ]] || return 1
  local journal_identity journal_field
  if ! journal_identity="$("$MC_HOST_OPERATION_HELPER" backup-journal inspect --journal "$BACKUP_JOURNAL" --output json)"; then
    log "CRITICAL: Backup journal could not be recovered"
    exit 1
  fi
  journal_field() { python3 -c 'import json,sys; value=json.loads(sys.argv[1])[sys.argv[2]]; print(json.dumps(value,separators=(",",":"),sort_keys=True) if isinstance(value,(dict,list)) else ("" if value is None else value))' "$journal_identity" "$1"; }
  local journal_phase="$(journal_field phase)"
  local journal_name="$(journal_field backupName)"
  local journal_mode="$(journal_field mode)"
  local journal_operation_key="$(journal_field operationKey)"
  local journal_backup_id="$(journal_field backupId)"
  local journal_created_at="$(journal_field createdAt)"
  local journal_generation="$(journal_field generation)"
  local journal_boot_id="$(journal_field bootId)"
  if [[ "$journal_mode" != "$BACKUP_MODE" ]]; then
    log "ERROR: An uploaded backup is awaiting recovery under a different operation identity"
    exit 1
  fi
  if [[ -n "$journal_operation_key" ]]; then
    if [[ "$journal_operation_key" != "$MC_REMOTE_OPERATION_KEY" ]]; then
      log "ERROR: An uploaded backup is awaiting recovery under a different operation identity"
      exit 1
    fi
    BACKUP_NAME="$journal_name"
    BACKUP_ARCHIVE="${BACKUP_TEMP_DIR}/${BACKUP_NAME}.tar.gz"
    BACKUP_MANIFEST="${BACKUP_ARCHIVE}.manifest.json"
  elif [[ "$journal_name" != "$BACKUP_NAME" ]]; then
    log "ERROR: An uploaded backup is awaiting recovery under a different backup name"
    exit 1
  fi
  BACKUP_ID="$journal_backup_id"
  BACKUP_CREATED_AT="$journal_created_at"
  BACKUP_GENERATION="$journal_generation"
  MAINTENANCE_OWNER="$(journal_field maintenanceOwner)"
  if [[ "$journal_mode" != "ordinary" && "$journal_boot_id" != "$CURRENT_BOOT_ID" ]]; then
    log "CRITICAL: Terminal quiescence evidence belongs to a previous boot; preserving the root volume"
    REMOTE_ARCHIVE_UPLOADED=1
    SERVICES_QUIESCED=1
    exit 1
  fi
  ROOT_VOLUME_ID="$(journal_field volumeId)"
  ROOT_VOLUME_DEVICE="$(journal_field volumeDevice)"
  QUIESCENCE_EPOCH="$(journal_field quiescenceEpoch)"
  SERVICE_STATES_JSON="$(journal_field serviceStates)"
  load_service_state_maps
  RECOVERY_PHASE="$journal_phase"
  acquire_or_adopt_boot_hold || exit 1
  case "$journal_phase" in
    prepared|quiescing|quiesced|uploading|archive-uploaded|publishing-manifest)
      if [[ "$journal_phase" == "publishing-manifest" ]]; then
        REMOTE_ARCHIVE_UPLOADED=1
        SERVICES_QUIESCED=1
      fi
      log "Retrying the same remote target after an unresolved upload result"
      return 1
      ;;
    uploaded)
      REMOTE_ARCHIVE_UPLOADED=1
      BACKUP_UPLOADED=1
      if [[ "$BACKUP_MODE" == "ordinary" ]]; then
        SERVICES_QUIESCED=1
        if ! restore_service_states; then
          SERVICE_RESTORE_FAILED=1
          log "CRITICAL: Uploaded backup is durable, but exact service restoration remains pending"
          exit 75
        fi
        write_backup_journal "restart-complete"
        clear_boot_hold || exit 1
      fi
      if [[ -z "$MC_REMOTE_OPERATION_KEY" ]]; then
        clear_backup_journal
      fi
      log "SUCCESS: Authenticated backup ${BACKUP_NAME}.tar.gz was already uploaded"
      if ! authenticate_remote_backup; then
        log "ERROR: Uploaded backup failed authenticated retry reconciliation"
        exit 1
      fi
      printf 'MC_BACKUP_MANIFEST_RESULT %s\n' "$BACKUP_MANIFEST_RESULT"
      return 0
      ;;
    restoring-services)
      REMOTE_ARCHIVE_UPLOADED=1
      BACKUP_UPLOADED=1
      SERVICES_QUIESCED=1
      if ! restore_service_states; then
        SERVICE_RESTORE_FAILED=1
        log "CRITICAL: Uploaded backup is durable, but exact service restoration remains pending"
        exit 75
      fi
      write_backup_journal "restart-complete"
      clear_boot_hold || exit 1
      [[ -n "$MC_REMOTE_OPERATION_KEY" ]] || clear_backup_journal
      log "SUCCESS: Authenticated backup ${BACKUP_NAME}.tar.gz was already uploaded and exact service state was restored"
      return 0
      ;;
    restart-complete)
      REMOTE_ARCHIVE_UPLOADED=1
      BACKUP_UPLOADED=1
      clear_boot_hold || exit 1
      log "SUCCESS: Authenticated backup ${BACKUP_NAME}.tar.gz was already uploaded and restarted"
      return 0
      ;;
  esac
}

recover_hibernate_transaction() {
  local journal journal_field mode
  if [[ ! -f "$BACKUP_JOURNAL" ]]; then
    if [[ -e "$HIBERNATE_GUARD" ]]; then
      log "CRITICAL: Hibernate guard exists without durable service pre-state"
      return 1
    fi
    log "No hibernate transaction is present; recovery is not required"
    return 0
  fi
  journal="$("$MC_HOST_OPERATION_HELPER" backup-journal inspect --journal "$BACKUP_JOURNAL" --output json)" || return 1
  journal_field() { python3 -c 'import json,sys; value=json.loads(sys.argv[1])[sys.argv[2]]; print(json.dumps(value,separators=(",",":"),sort_keys=True) if isinstance(value,(dict,list)) else ("" if value is None else value))' "$journal" "$1"; }
  mode="$(journal_field mode)"
  [[ "$mode" == "hibernate" ]] || { log "ERROR: Refusing to recover a non-hibernate transaction"; return 1; }
  MAINTENANCE_OWNER="$(journal_field maintenanceOwner)"
  QUIESCENCE_EPOCH="$(journal_field quiescenceEpoch)"
  SERVICE_STATES_JSON="$(journal_field serviceStates)"
  RECOVERY_PHASE="$(journal_field phase)"
  acquire_or_adopt_boot_hold || return 1
  SERVICES_QUIESCED=1
  restore_service_states || return 1
  clear_backup_journal || return 1
  clear_boot_hold || return 1
  rm -f -- "$HIBERNATE_GUARD"
  log "Hibernate failure recovery restored the exact pre-transaction service state"
}

if [[ "$BACKUP_MODE" == "recover-hibernate" ]]; then
  recover_hibernate_transaction
  exit $?
fi

if recover_backup_journal; then
  exit 0
fi

if [[ -z "$RECOVERY_PHASE" ]]; then
  BACKUP_CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  BACKUP_GENERATION=0
  resolve_root_volume_identity || exit 1
  capture_service_states || { log "ERROR: Could not capture exact service pre-state"; exit 1; }
  reconcile_workspace_dac || exit 1
  write_backup_journal prepared
fi
acquire_or_adopt_boot_hold || exit 1

validate_server_tree() {
  python3 - "$SERVER_DIR" <<'PY'
import os
import stat
import sys

root = sys.argv[1]


def validate_directory(directory: str) -> None:
    with os.scandir(directory) as entries:
        for entry in entries:
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(entry_stat.st_mode):
                validate_directory(entry.path)
            elif not stat.S_ISREG(entry_stat.st_mode):
                raise ValueError(f"unsupported server entry type: {entry.path}")
            elif entry_stat.st_nlink != 1:
                raise ValueError(f"hard-linked server file: {entry.path}")


try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("server root is not a directory")
    validate_directory(root)
except (OSError, ValueError) as error:
    print(f"Server tree validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

validate_backup_archive() {
  python3 - "$BACKUP_ARCHIVE" <<'PY'
import sys
import tarfile

archive_path = sys.argv[1]
try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        seen = set()
        regular_file_count = 0
        for member in members:
            name = member.name
            normalized = name[:-1] if name.endswith("/") else name
            parts = tuple(normalized.split("/"))
            if not normalized or normalized.startswith("/") or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"unsafe archive path: {name!r}")
            if parts[0] != "server":
                raise ValueError(f"archive entry is outside the server root: {name!r}")
            if not (member.isdir() or member.isfile()):
                raise ValueError(f"unsupported archive entry type: {name!r}")
            if member.isfile():
                regular_file_count += 1
            if parts == ("server",) and not member.isdir():
                raise ValueError("archive server root is not a directory")
            if parts in seen:
                raise ValueError(f"duplicate archive entry: {name!r}")
            seen.add(parts)
        if not members:
            raise ValueError("archive is empty")
        if regular_file_count == 0:
            raise ValueError("archive contains no server files")
except (OSError, tarfile.TarError, ValueError) as error:
    print(f"Produced archive validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

log "Starting backup: $BACKUP_NAME"

if [[ "$RECOVERY_PHASE" == "publishing-manifest" ]]; then
  if [[ ! -r "$RCLONE_CONFIG" || -L "$RCLONE_CONFIG" ]]; then
    log "ERROR: Published terminal recovery requires the already-materialized Drive configuration"
    exit 1
  fi
elif ! "$RCLONE_CONFIG_HELPER"; then
  log "ERROR: Failed to materialize Google Drive configuration"
  exit 1
fi

recover_published_manifest() {
  [[ "$RECOVERY_PHASE" == "publishing-manifest" ]] || return 1
  if ! authenticate_remote_backup; then
    log "Published backup completion is not yet authenticated; retrying the same exact remote object"
    return 1
  fi
  BACKUP_UPLOADED=1
  REMOTE_ARCHIVE_UPLOADED=1
  SERVICES_QUIESCED=1
  if [[ "$BACKUP_MODE" == "ordinary" ]]; then
    write_backup_journal "uploaded"
    write_backup_journal "restoring-services"
    if ! restore_service_states; then
      SERVICE_RESTORE_FAILED=1
      log "CRITICAL: Published backup is durable, but exact service restoration remains pending"
      exit 75
    fi
    write_backup_journal "restart-complete"
    clear_boot_hold || exit 1
  else
    if ! verify_quiescence; then
      log "CRITICAL: Terminal backup was published, but current-boot quiescence proof is no longer valid"
      exit 1
    fi
    printf 'MC_BACKUP_QUIESCENCE_RESULT %s\n' "$QUIESCENCE_EVIDENCE"
  fi
  printf 'MC_BACKUP_MANIFEST_RESULT %s\n' "$BACKUP_MANIFEST_RESULT"
  log "SUCCESS: Authenticated backup ${BACKUP_NAME}.tar.gz was already published and reconciled"
  return 0
}

if recover_published_manifest; then
  exit 0
fi

BACKUP_WORK_DIR="$(mktemp -d "${BACKUP_TEMP_DIR}/.mc-backup.XXXXXX")"
BACKUP_ARCHIVE="${BACKUP_WORK_DIR}/${BACKUP_NAME}.tar.gz"
BACKUP_MANIFEST="${BACKUP_ARCHIVE}.manifest.json"
WORLD_ROOTS_METADATA="${BACKUP_WORK_DIR}/world-roots-metadata.json"
if ! "$WORLD_ROOTS_HELPER" inspect --output roots-json > "$WORLD_ROOTS_METADATA"; then
  log "ERROR: Canonical custom world-root configuration is unavailable"
  exit 1
fi

if [[ -z "$RECOVERY_PHASE" ]]; then
  if REMOTE_MATCHES="$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --max-depth 1 --files-only \
      --include "/${BACKUP_NAME}.tar.gz" --include "/${BACKUP_NAME}.tar.gz.manifest.json")"; then
    if [[ -n "$REMOTE_MATCHES" ]]; then
      log "ERROR: Refusing to replace an existing backup archive or manifest"
      exit 1
    fi
  else
    log "ERROR: Could not prove the backup name is unused"
    exit 1
  fi
fi

log "Validating server tree before downtime..."
if ! validate_server_tree; then
  log "ERROR: Server tree contains entries that cannot be safely restored"
  exit 1
fi

if [[ -n "$RECOVERY_PHASE" ]]; then
  MINECRAFT_WAS_ACTIVE="${SERVICE_WAS_ACTIVE[minecraft.service]:-0}"
  if [[ "$REQUIRE_ACTIVE" == "1" && "$MINECRAFT_WAS_ACTIVE" != "1" ]]; then
    log "SKIP: Durable pre-service state proves Minecraft was inactive"
    exit 3
  fi
elif systemctl is-active --quiet minecraft.service; then
  MINECRAFT_WAS_ACTIVE=1
elif [[ "$REQUIRE_ACTIVE" == "1" ]]; then
  log "SKIP: Minecraft service is not active; scheduled backup will not start it"
  exit 3
else
  log "Minecraft service was already inactive; backup will preserve that state"
fi

update_boot_hold quiescing || exit 1
write_backup_journal quiescing
if ! quiesce_runtime; then
  log "ERROR: Failed to drain and quiesce the runtime; backup not archived"
  exit 1
fi
if ! verify_quiescence; then
  log "ERROR: Runtime quiescence could not be verified; backup not archived"
  exit 1
fi
if [[ -z "$BACKUP_CREATED_AT" ]]; then
  BACKUP_CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi
if [[ -z "$BACKUP_GENERATION" || "$BACKUP_GENERATION" == "0" ]]; then
  if ! BACKUP_GENERATION="$($BACKUP_AUTH_HELPER checkpoint-allocate \
      --state-file "$BACKUP_GENERATION_STATE" \
      --backup-id "$BACKUP_ID" \
      --updated-at "$BACKUP_CREATED_AT")"; then
    log "ERROR: Failed to reserve an authenticated monotonic backup generation"
    exit 1
  fi
fi
update_boot_hold quiesced || exit 1
write_backup_journal quiesced
if [[ "$BACKUP_MODE" == "hibernate" && "$MINECRAFT_WAS_ACTIVE" == "1" ]]; then
  printf '%s\n' "$CURRENT_BOOT_ID" > "$HIBERNATE_GUARD"
fi

# Close the validation/archive race while the service is stopped.
if ! validate_server_tree; then
  log "ERROR: Server tree changed to contain an unsupported entry before archiving"
  exit 1
fi

# Create tar archive
log "Creating tar archive..."
tar -czf "$BACKUP_ARCHIVE" -C "$SERVER_PARENT" server/ -C "$BACKUP_WORK_DIR" \
  --transform='s#^world-roots-metadata.json$#server/.mc-aws-world-roots.json#' world-roots-metadata.json || {
  log "ERROR: Failed to create tar archive"
  exit 1
}

if ! validate_backup_archive; then
  log "ERROR: Produced archive does not satisfy the restore contract"
  rm -f "$BACKUP_ARCHIVE"
  exit 1
fi

rm -f -- "$BACKUP_MANIFEST"
AUTH_CREATE_ARGS=(
  create
  --archive "$BACKUP_ARCHIVE"
  --manifest "$BACKUP_MANIFEST"
  --archive-name "${BACKUP_NAME}.tar.gz"
  --backup-name "$BACKUP_NAME"
  --backup-id "$BACKUP_ID"
  --created-at "$BACKUP_CREATED_AT"
  --generation "$BACKUP_GENERATION"
)
if [[ -n "$MC_REMOTE_OPERATION_KEY" ]]; then AUTH_CREATE_ARGS+=(--operation-key "$MC_REMOTE_OPERATION_KEY"); fi
if ! "$BACKUP_AUTH_HELPER" "${AUTH_CREATE_ARGS[@]}"; then
  log "ERROR: Failed to create authenticated backup manifest"
  exit 1
fi

# Upload to Google Drive
log "Uploading to Google Drive..."
if [[ -n "$MC_REMOTE_OPERATION_KEY" || "$BACKUP_MODE" == "ordinary" || "$TERMINAL_BACKUP" == "1" ]]; then
  # Persist the selected object name before starting rclone. A retry after an
  # ambiguous rclone result therefore overwrites this exact object with copyto
  # instead of creating an archive under a newly generated timestamp.
  update_boot_hold uploading || exit 1
  write_backup_journal "uploading"
fi
REMOTE_ARCHIVE_UPLOADED=1
rclone copyto "$BACKUP_ARCHIVE" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_NAME}.tar.gz" || {
  log "ERROR: Failed to upload to Google Drive"
  rm -f "$BACKUP_ARCHIVE"
  exit 1
}
if [[ -n "$MC_REMOTE_OPERATION_KEY" || "$BACKUP_MODE" == "ordinary" || "$TERMINAL_BACKUP" == "1" ]]; then
  update_boot_hold archive-uploaded || exit 1
  write_backup_journal "archive-uploaded"
fi
if [[ -n "$MC_REMOTE_OPERATION_KEY" || "$BACKUP_MODE" == "ordinary" || "$TERMINAL_BACKUP" == "1" ]]; then
  update_boot_hold publishing-manifest || exit 1
  write_backup_journal "publishing-manifest"
fi
# Authenticate the exact local pair and re-check quiescence before the remote
# manifest publication that becomes the terminal backup commit point.
AUTH_VERIFY_ARGS=(
  verify
  --archive "$BACKUP_ARCHIVE"
  --manifest "$BACKUP_MANIFEST"
  --archive-name "${BACKUP_NAME}.tar.gz"
  --expected-backup-id "$BACKUP_ID"
  --expected-generation "$BACKUP_GENERATION"
  --output json
)
if [[ -n "$MC_REMOTE_OPERATION_KEY" ]]; then AUTH_VERIFY_ARGS+=(--expected-operation-key "$MC_REMOTE_OPERATION_KEY"); fi
if ! BACKUP_MANIFEST_RESULT="$($BACKUP_AUTH_HELPER "${AUTH_VERIFY_ARGS[@]}")"; then
  log "ERROR: Authenticated backup result could not be verified before publication"
  exit 1
fi
if ! verify_quiescence; then
  log "ERROR: Runtime quiescence was lost before archive publication"
  exit 1
fi
# The manifest is uploaded last and is the only completion marker. Restore and
# listing paths never select an archive without this exact detached manifest.
rclone copyto "$BACKUP_MANIFEST" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_NAME}.tar.gz.manifest.json" || {
  log "ERROR: Archive uploaded, but authenticated manifest publication is unresolved"
  exit 1
}
if [[ "$BACKUP_MODE" == "ordinary" ]]; then
  write_backup_journal "uploaded"
fi
BACKUP_UPLOADED=1
if ! verify_quiescence; then
  log "ERROR: Runtime quiescence was lost after archive publication"
  exit 1
fi
printf 'MC_BACKUP_QUIESCENCE_RESULT %s\n' "$QUIESCENCE_EVIDENCE"
printf 'MC_BACKUP_MANIFEST_RESULT %s\n' "$BACKUP_MANIFEST_RESULT"

if [[ "$TERMINAL_BACKUP" == "1" ]]; then
  # No command after the authenticated manifest publication may mutate the
  # host. The pre-publication journal and durable hold intentionally remain as
  # terminal evidence until the instance/root volume is removed or recovered.
  log "SUCCESS: Authenticated terminal backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
  exit 0
fi

if [[ "$BACKUP_MODE" == "ordinary" ]]; then
  # Do not mark the operation restart-complete until every service state has
  # been restored.  A restart failure must leave the authenticated upload
  # journal and the root maintenance fence available for recovery.
  write_backup_journal "restoring-services"
  if ! restore_service_states; then
    SERVICE_RESTORE_FAILED=1
    log "CRITICAL: Authenticated backup completed, but prior service states could not be restored"
    exit 75
  fi
fi

# Cleanup
log "Cleaning up temporary files..."
rm -f "$BACKUP_ARCHIVE"
rm -f "$BACKUP_MANIFEST"

if [[ -n "$MC_REMOTE_OPERATION_KEY" || "$BACKUP_MODE" == "ordinary" ]]; then
  write_backup_journal "restart-complete"
fi
clear_boot_hold || {
  log "CRITICAL: Service state is restored, but durable maintenance inhibition could not be retired"
  exit 1
}

# Commands run under the durable SSM wrapper retain this final journal until
# the wrapper has committed its own output and done marker. The wrapper then
# acknowledges only the journal carrying its exact operation key.
if [[ -f "$BACKUP_JOURNAL" && -z "$MC_REMOTE_OPERATION_KEY" ]]; then
  clear_backup_journal
fi

log "SUCCESS: Authenticated backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
