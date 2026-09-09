#!/usr/bin/env bash
# Resume server after instance boot
# Usage: mc-resume.sh <fresh|latest|named> [backup-archive]
# Replacement convergence: mc-resume.sh replacement-convergence <backup-archive> <generation> <backup-id>
# Note: This runs on boot via user_data if "resume" flag is set

set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

export RCLONE_CONFIG="/opt/setup/rclone/rclone.conf"
RESTORE_MODE="${1:-fresh}"
BACKUP_NAME="${2:-}"
BACKUP_GENERATION="${3:-}"
BACKUP_ID="${4:-}"
RESUME_OPERATION_ID="${MC_RESUME_OPERATION_ID:-}"
PARENT_MAINTENANCE_OPERATION="${MC_MAINTENANCE_PARENT_OPERATION:-}"
RETAIN_OUTER_MAINTENANCE="${MC_RETAIN_OUTER_MAINTENANCE:-0}"
[[ "$RETAIN_OUTER_MAINTENANCE" == "0" || "$RETAIN_OUTER_MAINTENANCE" == "1" ]] || {
  log "ERROR: MC_RETAIN_OUTER_MAINTENANCE must be 0 or 1"
  exit 1
}
if [[ -n "$PARENT_MAINTENANCE_OPERATION" && "$PARENT_MAINTENANCE_OPERATION" != "host-replacement" ]]; then
  log "ERROR: Resume maintenance parent must be the exact host-replacement operation"
  exit 1
fi
if [[ ! "$RESUME_OPERATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
  log "ERROR: Resume requires an exact durable operation identity"
  exit 1
fi
# Backward compatibility for legacy invocation: mc-resume.sh <backup-archive>
if [[ "$RESTORE_MODE" != "fresh" && "$RESTORE_MODE" != "latest" && "$RESTORE_MODE" != "named" && "$RESTORE_MODE" != "replacement-convergence" ]]; then
  BACKUP_NAME="$RESTORE_MODE"
  RESTORE_MODE="named"
fi
RESUME_OPERATION_OWNER_TOKEN="${MC_RESUME_OPERATION_OWNER_TOKEN:-$RESUME_OPERATION_ID}"
if [[ -z "${MC_OPERATION_STATE_TABLE_NAME:-}" ]]; then
  operation_state_table_file="${MC_OPERATION_STATE_TABLE_FILE:-/etc/minecraft/operation-state-table-name}"
  if [[ ! -f "$operation_state_table_file" ]] || ! IFS= read -r MC_OPERATION_STATE_TABLE_NAME < "$operation_state_table_file"; then
    log "ERROR: Resume operation-state table configuration is unavailable"
    exit 1
  fi
fi
if [[ ! "$MC_OPERATION_STATE_TABLE_NAME" =~ ^[A-Za-z0-9_.:-]{3,255}$ ]]; then
  log "ERROR: Resume operation-state table configuration is invalid"
  exit 1
fi
export MC_OPERATION_STATE_TABLE_NAME
resume_intent_terminal=0
resume_pointer_file="$(mktemp /tmp/mc-resume-intent.XXXXXX)"
chmod 0600 "$resume_pointer_file"
if ! aws dynamodb get-item --table-name "${MC_OPERATION_STATE_TABLE_NAME:?MC_OPERATION_STATE_TABLE_NAME is required}" \
  --consistent-read --key '{"operationId":{"S":"mc-aws-resume-intent"}}' --output json > "$resume_pointer_file"; then
  log "ERROR: Could not read the authoritative DynamoDB resume intent"
  exit 1
fi
resume_intent_terminal="$(python3 - "$resume_pointer_file" "$RESUME_OPERATION_ID" "$RESUME_OPERATION_OWNER_TOKEN" "$RESTORE_MODE" "$BACKUP_NAME" <<'PY'
import json, re, subprocess, sys

pointer_file, operation_id, owner_token, mode, backup_name = sys.argv[1:]
item = json.load(open(pointer_file, encoding="ascii")).get("Item") or {}
raw = item.get("payload", {}).get("S")
if not raw:
    raise SystemExit("authoritative resume intent is absent")
pointer = json.loads(raw)
if (not isinstance(pointer, dict) or pointer.get("schemaVersion") != 1 or pointer.get("kind") != "mc-aws-resume-intent"
        or pointer.get("operationId") != operation_id or pointer.get("ownerToken") != owner_token
        or pointer.get("status") not in ("active", "completed", "failed") or not isinstance(pointer.get("version"), int)):
    raise SystemExit("resume intent ownership or schema is invalid")
intent = pointer.get("intent")
if not isinstance(intent, dict) or intent.get("mode") != mode:
    raise SystemExit("resume invocation does not match the authoritative intent")
expected_name = None if mode in ("fresh", "latest") else backup_name
if intent.get("backupArchiveName") != expected_name:
    raise SystemExit("resume invocation backup does not match the authoritative intent")
if mode in ("named", "replacement-convergence") and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz", backup_name)):
    raise SystemExit("resume archive name is invalid")
if pointer["status"] != "active":
    print("1")
    raise SystemExit(0)
table = __import__("os").environ.get("MC_OPERATION_STATE_TABLE_NAME", "")
try:
    state_item = json.loads(subprocess.run(
        ["aws", "dynamodb", "get-item", "--table-name", table, "--consistent-read", "--key", json.dumps({"operationId": {"S": operation_id}}), "--output", "json"],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout).get("Item") or {}
    state = json.loads(state_item.get("payload", {}).get("S", ""))
except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as error:
    raise SystemExit("resume operation authority could not be verified") from error
if state.get("id", state.get("operationId")) != operation_id or state.get("status") != "running":
    raise SystemExit("resume intent is not authorized by a running operation")
if state.get("type") == "resume":
    if state.get("executionToken") != owner_token:
        raise SystemExit("resume operation executor ownership changed")
elif state.get("kind") == "mc-aws-host-replacement":
    if state.get("operationOwnerId") != owner_token:
        raise SystemExit("replacement operation executor ownership changed")
else:
    raise SystemExit("resume operation kind is invalid")
print("0")
PY
)" || { log "ERROR: Resume intent validation failed"; exit 1; }
rm -f "$resume_pointer_file"

# This path is outside PrivateTmp and is shared with the gateway and backup
# scripts.  Resume owns the marker atomically for its whole lifecycle.
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/run/mc-agent/maintenance-state.json}"
MAINTENANCE_BOOT_HOLD="${MC_MAINTENANCE_BOOT_HOLD:-/var/lib/mc-aws/maintenance-boot-hold.json}"
MAINTENANCE_BOOT_HELPER="${MC_MAINTENANCE_BOOT_HELPER:-/usr/local/bin/mc-maintenance-boot.py}"
BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
export MC_MAINTENANCE_OWNER="$RESUME_OPERATION_ID"
if ! boot_hold="$(python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" inspect)" ||
   ! python3 -c 'import json,sys; value=json.loads(sys.argv[1]); expected,parent=sys.argv[2:]; raise SystemExit(0 if value["operation"]==(parent or "restore") and value["owner"]==expected else 1)' "$boot_hold" "$RESUME_OPERATION_ID" "$PARENT_MAINTENANCE_OPERATION"; then
  log "ERROR: Resume durable boot inhibition is missing or belongs to another operation"
  exit 1
fi
MC_MAINTENANCE_OWNER="$(python3 - "$MAINTENANCE_LOCK" "$MC_MAINTENANCE_OWNER" "$RESTORE_MODE" "${MC_RESTORE_JOURNAL:-/var/lib/mc-aws/mc-restore-journal.json}" "$PARENT_MAINTENANCE_OPERATION" <<'PY'
import json, os, sys
path, owner, restore_mode, journal_path, parent_operation = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
except FileNotFoundError:
    value = None
except (OSError, ValueError):
    raise SystemExit("existing maintenance fence is malformed")
if value is not None:
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or value.get("operation") != (parent_operation or "restore")
        or not isinstance(value.get("owner"), str)
        or not value["owner"]
    ):
        raise SystemExit("existing maintenance fence belongs to another operation")
    if value["owner"] != owner:
        raise SystemExit("restore maintenance fence belongs to another operation")
    print(value["owner"])
    raise SystemExit(0)
encoded = json.dumps({"schemaVersion": 1, "operation": "restore", "owner": owner, "phase": "boot-inhibited"}, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n"
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
with os.fdopen(descriptor, "wb") as output:
    output.write(encoded); output.flush(); os.fsync(output.fileno())
print(owner)
PY
 )"
export MC_MAINTENANCE_OWNER
maintenance_release_allowed=0
release_maintenance_fence() {
  (( maintenance_release_allowed == 1 )) || return 0
  python3 - "$MAINTENANCE_LOCK" "$MC_MAINTENANCE_OWNER" <<'PY'
import json, os, sys
path, owner = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
    if value.get("owner") == owner and value.get("schemaVersion") == 1 and value.get("operation") in (None, "restore", "host-replacement"):
        os.unlink(path)
except FileNotFoundError:
    pass
PY
}
trap release_maintenance_fence EXIT

clear_resume_boot_hold() {
  python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" clear --owner "$RESUME_OPERATION_ID"
}

log "Starting resume process"

case "$RESTORE_MODE" in
  fresh)
    log "Fresh resume requested (no restore)"
    ;;
  latest)
    log "Latest-backup resume requested"
    ;;
  named)
    if [[ -z "$BACKUP_NAME" ]]; then
      log "ERROR: Backup archive name is required for named resume"
      exit 1
    fi
    log "Named-backup resume requested: $BACKUP_NAME"
    ;;
  replacement-convergence)
    if (( $# != 4 )) || [[ -z "$BACKUP_NAME" ]] || [[ ! "$BACKUP_GENERATION" =~ ^[1-9][0-9]*$ ]] ||
       [[ ! "$BACKUP_ID" =~ ^[a-f0-9]{32}$ ]]; then
      log "ERROR: Replacement convergence requires <backup-archive> <generation> <backup-id>"
      exit 2
    fi
    log "Replacement convergence resume requested: $BACKUP_NAME at generation $BACKUP_GENERATION"
    ;;
esac

if [[ "$resume_intent_terminal" == "1" ]]; then
  log "Resume intent is already terminal; skipping duplicate restore"
elif [[ "$RESTORE_MODE" == "latest" ]]; then
  log "Restoring latest backup..."
  MC_RETAIN_BOOT_HOLD=1 /usr/local/bin/mc-restore.sh latest || { log "ERROR: Latest backup restore failed"; exit 1; }
elif [[ "$RESTORE_MODE" == "named" ]]; then
  log "Restoring named backup..."
  MC_RETAIN_BOOT_HOLD=1 /usr/local/bin/mc-restore.sh "$BACKUP_NAME" || { log "ERROR: Named backup restore failed"; exit 1; }
elif [[ "$RESTORE_MODE" == "replacement-convergence" ]]; then
  log "Converging on the exact replacement restore generation..."
  MC_RETAIN_BOOT_HOLD=1 /usr/local/bin/mc-restore.sh --replacement-convergence "$BACKUP_NAME" \
    --expected-generation "$BACKUP_GENERATION" --expected-backup-id "$BACKUP_ID" || { log "ERROR: Replacement convergence restore failed"; exit 1; }
fi

# Publish DNS before opening Minecraft so a DNS failure cannot leave the game running.
resume_boot_phase="restoring-services"
[[ -z "$PARENT_MAINTENANCE_OPERATION" ]] || resume_boot_phase="recovery"
python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
  phase --owner "$RESUME_OPERATION_ID" --phase "$resume_boot_phase" --attempt "$RESUME_OPERATION_ID"
systemctl daemon-reload
systemctl unmask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service \
  mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service
if ! systemctl start minecraft-dns.service; then
  log "ERROR: Failed to start minecraft DNS service"
  exit 1
fi

log "Starting Minecraft server service..."
if ! systemctl start minecraft; then
  log "ERROR: Failed to start minecraft service"
  exit 1
fi

sleep 3
if ! systemctl is-active --quiet minecraft; then
  log "ERROR: Minecraft service is not active after resume"
  systemctl status minecraft --no-pager -l || true
  exit 1
fi
if ! /usr/local/bin/mc-wait-ready.sh raw_ip '' ''; then
  log "ERROR: Minecraft protocol readiness failed while maintenance ownership remained held"
  exit 1
fi

if [[ "$resume_intent_terminal" != "1" ]]; then
  resume_pointer_file="$(mktemp /tmp/mc-resume-intent.XXXXXX)"
  chmod 0600 "$resume_pointer_file"
  aws dynamodb get-item --table-name "$MC_OPERATION_STATE_TABLE_NAME" --consistent-read \
    --key '{"operationId":{"S":"mc-aws-resume-intent"}}' --output json > "$resume_pointer_file"
  resume_pointer_record="$(python3 - "$resume_pointer_file" "$RESUME_OPERATION_ID" "$RESUME_OPERATION_OWNER_TOKEN" <<'PY'
import json, sys
import base64
from datetime import datetime, timezone
document = json.load(open(sys.argv[1], encoding="ascii")); item = document.get("Item") or {}
pointer = json.loads(item.get("payload", {}).get("S", ""))
if pointer.get("status") != "active" or pointer.get("operationId") != sys.argv[2] or pointer.get("ownerToken") != sys.argv[3]:
    raise SystemExit("resume intent successor owns the pointer")
pointer["status"] = "completed"; pointer["version"] += 1; pointer["updatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
print(item.get("version", {}).get("N", ""), base64.b64encode(json.dumps(pointer, separators=(",", ":"), sort_keys=True).encode("ascii")).decode("ascii"))
PY
  )" || { rm -f "$resume_pointer_file"; log "ERROR: Resume intent completion validation failed"; exit 1; }
  read -r resume_pointer_version resume_pointer_payload_b64 <<< "$resume_pointer_record"
  new_pointer_version=$((resume_pointer_version + 1))
  aws dynamodb update-item --table-name "$MC_OPERATION_STATE_TABLE_NAME" --key '{"operationId":{"S":"mc-aws-resume-intent"}}' \
    --condition-expression '#version = :expected AND #status = :active AND operationIdOwner = :operationId AND ownerToken = :ownerToken' \
    --update-expression 'SET payload = :payload, #version = :version, #status = :status, updatedAt = :updatedAt' \
    --expression-attribute-names '{"#version":"version","#status":"status"}' \
    --expression-attribute-values "$(python3 - "$resume_pointer_payload_b64" "$new_pointer_version" <<'PY'
import base64, json, sys
pointer = json.loads(base64.b64decode(sys.argv[1]).decode("ascii"))
print(json.dumps({":expected":{"N":str(int(sys.argv[2])-1)},":active":{"S":"active"},":operationId":{"S":pointer["operationId"]},":ownerToken":{"S":pointer["ownerToken"]},":payload":{"S":json.dumps(pointer,separators=(",",":"),sort_keys=True)},":version":{"N":str(pointer["version"])},":status":{"S":"completed"},":updatedAt":{"S":pointer["updatedAt"]}}, separators=(",", ":")))
PY
  )"
  rm -f "$resume_pointer_file"
fi

resume_commit_phase="committed"
[[ -z "$PARENT_MAINTENANCE_OPERATION" ]] || resume_commit_phase="recovery"
python3 "$MAINTENANCE_BOOT_HELPER" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
  phase --owner "$RESUME_OPERATION_ID" --phase "$resume_commit_phase" --attempt "$RESUME_OPERATION_ID"
if [[ -n "$PARENT_MAINTENANCE_OPERATION" || "$RETAIN_OUTER_MAINTENANCE" == "1" ]]; then
  log "SUCCESS: Resume completed (${RESTORE_MODE}); parent maintenance ownership remains held for outer commit"
  exit 0
fi
maintenance_release_allowed=1
release_maintenance_fence
maintenance_release_allowed=0
if systemctl is-enabled --quiet mc-agent-world-roots.service; then systemctl start mc-agent-world-roots.service; fi
if systemctl is-enabled --quiet mc-agent-tool-read.socket; then systemctl start mc-agent-tool-read.socket; fi
if systemctl is-enabled --quiet mc-agent-tool-write.socket; then systemctl start mc-agent-tool-write.socket; fi
if systemctl is-enabled --quiet mc-agent-executor.socket; then systemctl start mc-agent-executor.socket; fi
if systemctl is-enabled --quiet mc-agent-executor.service; then systemctl start mc-agent-executor.service; fi
if systemctl is-enabled --quiet mc-agent-gateway.service; then systemctl start mc-agent-gateway.service; fi
if systemctl is-enabled --quiet mc-agent-host-broker.socket; then systemctl start mc-agent-host-broker.socket; fi
clear_resume_boot_hold
maintenance_release_allowed=1
log "SUCCESS: Resume completed (${RESTORE_MODE})"
