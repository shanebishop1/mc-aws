#!/usr/bin/env bash
# Activate one complete, SSM-published host release on an existing host.
# No individual helper, unit, config, profile member, or agent archive may be rolled out.
set -euo pipefail
umask 077

readonly MC_BOOTSTRAP_PINS_SHA256="1d033a7fe499239b6528b0b36539e410f08a97c969984c4424a535a01a04cd3e"
readonly PINS_SHA256="$MC_BOOTSTRAP_PINS_SHA256"
readonly JOURNAL_ROOT="${MC_RELEASE_JOURNAL_ROOT:-/var/lib/mc-aws/runtime-rollouts}"
readonly MAINTENANCE_FENCE="${MC_MAINTENANCE_LOCK:-/run/mc-agent/maintenance-state.json}"
readonly MAINTENANCE_BOOT_HOLD="${MC_MAINTENANCE_BOOT_HOLD:-/var/lib/mc-aws/maintenance-boot-hold.json}"
readonly BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
readonly OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
readonly EXECUTOR_JOURNAL="${MC_EXECUTOR_JOURNAL:-/var/lib/mc-agent-executor/executor-effect-journal.json}"
readonly EXECUTOR_JOURNAL_CREDENTIAL="${MC_EXECUTOR_JOURNAL_CREDENTIAL:-/etc/mc-agent/executor-journal-hmac.key}"
readonly GATEWAY_RECONCILIATION_JOURNAL="${MC_GATEWAY_RECONCILIATION_JOURNAL:-/var/lib/mc-agent-gateway/executor-reconciliations.json}"
readonly EXECUTOR_JOURNAL_CHECKPOINT="${MC_EXECUTOR_JOURNAL_CHECKPOINT:-0}"
readonly MC_HOST_OPERATION_HELPER="${MC_HOST_OPERATION_HELPER:-/usr/local/bin/mc-host-operation.py}"
readonly WORKSPACE_DAC_HELPER="${MC_WORKSPACE_DAC_HELPER:-/usr/local/bin/mc-agent-workspace-dac.py}"
readonly SERVICE_UNITS=(minecraft-dns.service minecraft.service mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service)
readonly AGENT_TARGET_WANTS=(
  /etc/systemd/system/multi-user.target.wants/mc-agent-world-roots.service
  /etc/systemd/system/sockets.target.wants/mc-agent-executor.socket
  /etc/systemd/system/sockets.target.wants/mc-agent-tool-read.socket
  /etc/systemd/system/sockets.target.wants/mc-agent-tool-write.socket
  /etc/systemd/system/multi-user.target.wants/mc-agent-tool-read.service
  /etc/systemd/system/multi-user.target.wants/mc-agent-tool-write.service
  /etc/systemd/system/multi-user.target.wants/mc-agent-executor.service
  /etc/systemd/system/multi-user.target.wants/mc-agent-gateway.service
)
readonly DRAIN_MAX_ATTEMPTS="${MC_AGENT_DRAIN_MAX_ATTEMPTS:-30}"
readonly DRAIN_INTERVAL="${MC_AGENT_DRAIN_INTERVAL:-1}"
ENABLE_AGENT=0
GATEWAY_CREDENTIAL_SOURCE="${MC_AGENT_GATEWAY_CREDENTIAL_SOURCE:-}"
BACKUP_FENCE_PUBLIC_SOURCE="${MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_SOURCE:-}"
RELEASE_ROOT=""
MANIFEST_FILE=""

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
reconcile_workspace_dac() {
  [[ -x "$WORKSPACE_DAC_HELPER" ]] || fail "workspace DAC helper is unavailable"
  "$WORKSPACE_DAC_HELPER" reconcile
}
verify_bootstrap_pins() {
  local manifest="$1"
  python3 - "$manifest" "$PINS_SHA256" <<'PY'
import json, re, sys
value=json.load(open(sys.argv[1], encoding="utf-8"))
bootstrap=value.get("bootstrapPins")
if not isinstance(bootstrap,dict) or set(bootstrap) != {"manifest","sha256"} or bootstrap["sha256"] != sys.argv[2]:
    raise SystemExit("host release bootstrap pins do not match reviewed pins")
pins=bootstrap["manifest"]
if not isinstance(pins,dict) or set(pins) != {"schemaVersion","reviewedAt","artifacts"} or pins["schemaVersion"] != 1:
    raise SystemExit("invalid host release bootstrap pin manifest")
if not isinstance(pins["reviewedAt"],str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}",pins["reviewedAt"]):
    raise SystemExit("invalid host release bootstrap pin review date")
artifacts=pins["artifacts"]
required={"paper","rclone","nodeArm64","mcstatus","asyncioDgram","dnspython"}
if not isinstance(artifacts,dict) or set(artifacts) != required:
    raise SystemExit("host release bootstrap artifact inventory does not match reviewed pins")
for name, artifact in artifacts.items():
    expected={"version","url","sha256","checksumSource"}
    if name == "paper": expected |= {"minecraftVersion","build"}
    if not isinstance(artifact,dict) or set(artifact) != expected:
        raise SystemExit(f"invalid host release bootstrap artifact: {name}")
    if any(not isinstance(artifact[key],str) or not artifact[key].strip() for key in ("version","url","sha256","checksumSource")):
        raise SystemExit(f"invalid host release bootstrap artifact values: {name}")
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?",artifact["version"]) or not re.fullmatch(r"[a-f0-9]{64}",artifact["sha256"]):
        raise SystemExit(f"invalid host release bootstrap artifact pin: {name}")
    if not artifact["url"].startswith("https://") or not artifact["checksumSource"].startswith("https://"):
        raise SystemExit(f"invalid host release bootstrap artifact URL: {name}")
paper=artifacts["paper"]
if paper["version"] != paper["minecraftVersion"] or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?",paper["minecraftVersion"]) or not isinstance(paper["build"],int) or paper["build"] <= 0:
    raise SystemExit("invalid exact MC_VERSION bootstrap pin")
if f"/objects/{paper['sha256']}/paper-{paper['minecraftVersion']}-{paper['build']}.jar" not in paper["url"]:
    raise SystemExit("MC_VERSION and Paper bootstrap pin do not match")
PY
}

assert_persistent_guard_prerequisite() {
  local staged installed mode
  while IFS=$'\t' read -r staged installed mode; do
    [[ -f "$installed" && ! -L "$installed" && "$(stat -c '%U:%G:%a' "$installed")" == "root:root:$mode" ]] ||
      fail "reboot-persistent maintenance guard is not installed; use the backup/snapshot replacement path before in-place rollout"
    cmp -s "$staged" "$installed" ||
      fail "installed maintenance guard does not match this release; use the backup/snapshot replacement path before in-place rollout"
  done <<EOF
$RELEASE_ROOT/host/mc-maintenance-boot.py	/usr/local/bin/mc-maintenance-boot.py	755
$RELEASE_ROOT/host/mc-aws-maintenance-generator	/usr/lib/systemd/system-generators/mc-aws-maintenance-generator	755
$RELEASE_ROOT/host/mc-maintenance-recovery.service	/etc/systemd/system/mc-maintenance-recovery.service	644
EOF
}
fault_after() {
  assert_runtime_fence
  [[ "${MC_RUNTIME_ROLLOUT_FAULT_AFTER_PHASE:-}" != "$1" ]] || {
    [[ "${MC_RUNTIME_ROLLOUT_TEST_MODE:-0}" == 1 && "$JOURNAL_ROOT" != /var/lib/mc-aws/runtime-rollouts ]] ||
      fail "runtime rollout fault injection is restricted to an isolated test root"
    fail "injected runtime rollout failure after $1"
  }
}

[[ "${1:-}" == "--confirm-pins" && "${2:-}" == "$PINS_SHA256" ]] || fail "exact bootstrap pins confirmation is required"
shift 2
while (( $# > 0 )); do
  case "$1" in
    --enable-agent) ENABLE_AGENT=1; shift ;;
    --gateway-credential-source) [[ -n "${2:-}" ]] || fail "--gateway-credential-source requires a directory"; GATEWAY_CREDENTIAL_SOURCE="$2"; shift 2 ;;
    --backup-fence-public-source) [[ -n "${2:-}" ]] || fail "--backup-fence-public-source requires a file"; BACKUP_FENCE_PUBLIC_SOURCE="$2"; shift 2 ;;
    --release-root) [[ -n "${2:-}" ]] || fail "--release-root requires a directory"; RELEASE_ROOT="$2"; shift 2 ;;
    --manifest-file) [[ -n "${2:-}" ]] || fail "--manifest-file requires a file"; MANIFEST_FILE="$2"; shift 2 ;;
    *) fail "unsupported runtime rollout option" ;;
  esac
done
[[ "$(id -u)" == 0 ]] || fail "host release rollout must run as root"
for command in aws cmp cp flock grep install mktemp python3 sha256sum stat systemctl timeout; do command -v "$command" >/dev/null || fail "missing $command"; done

exec 9>/run/lock/mc-aws-runtime-rollout.lock
flock -n 9 || fail "another host release rollout is active"
exec 8>"$OPERATION_LOCK"
flock -n 8 || fail "another lifecycle operation is active"
work="$(mktemp -d /tmp/mc-aws-host-release-rollout.XXXXXX)"
committed=0
journal_started=0
snapshot_taken=0
fence_acquired=0
boot_hold_acquired=0
quiesce_attempted=0
runtime_quiesced=0
runtime_transition_changed=0
rollback_failed=0
attempt_dir=""
runtime_before=""
node_before=""
runtime_after=""
node_after=""
target_runtime=""
paper_sha256=""
profile_release=""
PROFILE_MANIFEST_FILE=""
minecraft_log_bytes=0
minecraft_log_device=0
minecraft_log_inode=0
readiness_minecraft_started=0
readiness_dns_started=0
candidate_paper=""
candidate_server=""
readiness_unit="mc-runtime-readiness.service"
MAINTENANCE_OWNER="${MC_MAINTENANCE_OWNER:-runtime-rollout-$$-$(python3 -c 'import secrets; print(secrets.token_hex(8))')}"
ADOPT_MAINTENANCE_OPERATION="${MC_RUNTIME_ROLLOUT_ADOPT_OPERATION:-}"
RETAIN_SUCCESSFUL_MAINTENANCE="${MC_RUNTIME_ROLLOUT_RETAIN_MAINTENANCE:-0}"
[[ "$RETAIN_SUCCESSFUL_MAINTENANCE" == "0" || "$RETAIN_SUCCESSFUL_MAINTENANCE" == "1" ]] || fail "runtime rollout maintenance retention must be 0 or 1"
adopted_maintenance_operation=""
preserve_borrowed_maintenance=0

acquire_runtime_fence() {
  install -d -o root -g root -m 0755 "$(dirname -- "$MAINTENANCE_FENCE")"
  python3 - "$MAINTENANCE_FENCE" "$MAINTENANCE_OWNER" <<'PY'
import json, os, sys
path, owner = sys.argv[1:]
payload = {"schemaVersion": 1, "owner": owner, "operation": "runtime-rollout", "phase": "fencing"}
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
with os.fdopen(descriptor, "wb") as output:
    output.write(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("ascii") + b"\n")
    output.flush(); os.fsync(output.fileno())
directory = os.open(os.path.dirname(path), os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
PY
  fence_acquired=1
}

acquire_or_adopt_boot_hold() {
  local existing_owner="" existing_operation=""
  if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
    IFS=$'\t' read -r existing_owner existing_operation < <(
      python3 "$maintenance_helper" --marker "$MAINTENANCE_BOOT_HOLD" inspect |
        python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["owner"] + "\t" + value["operation"])'
    ) ||
      fail "durable maintenance intent is malformed; boot inhibition remains fail-closed"
    [[ -n "$existing_owner" ]] || fail "durable maintenance intent has no owner"
    if [[ "$existing_operation" != "runtime-rollout" ]]; then
      [[ -n "$ADOPT_MAINTENANCE_OPERATION" && "$existing_operation" == "$ADOPT_MAINTENANCE_OPERATION" ]] ||
        fail "durable maintenance intent belongs to another operation; inhibition retained"
      adopted_maintenance_operation="$existing_operation"
      preserve_borrowed_maintenance=1
    fi
    MAINTENANCE_OWNER="$existing_owner"
  else
    python3 "$maintenance_helper" --marker "$MAINTENANCE_BOOT_HOLD" --boot-id-file "$BOOT_ID_FILE" \
      create --owner "$MAINTENANCE_OWNER" --phase fencing
  fi
  boot_hold_acquired=1
}

update_boot_hold() {
  local phase="$1" attempt="${2:-}"
  [[ -z "$adopted_maintenance_operation" ]] || phase="recovery"
  local args=(--marker "$MAINTENANCE_BOOT_HOLD" phase --owner "$MAINTENANCE_OWNER" --phase "$phase")
  (( boot_hold_acquired == 1 )) || fail "durable maintenance intent is not owned"
  [[ -z "$attempt" ]] || args+=(--attempt "$attempt")
  python3 "$maintenance_helper" "${args[@]}"
}

clear_boot_hold() {
  (( boot_hold_acquired == 1 )) || return 0
  (( preserve_borrowed_maintenance == 0 )) || return 0
  python3 "$maintenance_helper" --marker "$MAINTENANCE_BOOT_HOLD" clear --owner "$MAINTENANCE_OWNER"
  boot_hold_acquired=0
}

acquire_or_adopt_maintenance() {
  acquire_or_adopt_boot_hold
  if [[ -e "$MAINTENANCE_FENCE" || -L "$MAINTENANCE_FENCE" ]]; then
    if ! assert_runtime_fence; then
      boot_hold_acquired=0
      fail "volatile maintenance fence conflicts with durable rollout intent; inhibition retained"
    fi
    fence_acquired=1
  else
    acquire_runtime_fence
  fi
}

assert_runtime_fence() {
  python3 - "$MAINTENANCE_FENCE" "$MAINTENANCE_OWNER" "$ADOPT_MAINTENANCE_OPERATION" <<'PY'
import json, sys
path, owner, adopted_operation = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
except (OSError, ValueError):
    raise SystemExit("runtime maintenance fence is unavailable")
allowed = {"runtime-rollout"}
if adopted_operation:
    allowed = {adopted_operation}
if value.get("schemaVersion") != 1 or value.get("owner") != owner or value.get("operation") not in allowed:
    raise SystemExit("runtime maintenance fence ownership changed")
PY
}

release_runtime_fence() {
  (( fence_acquired == 1 )) || return 0
  (( preserve_borrowed_maintenance == 0 )) || return 0
  python3 - "$MAINTENANCE_FENCE" "$MAINTENANCE_OWNER" "$ADOPT_MAINTENANCE_OPERATION" <<'PY'
import json, os, sys
path, owner, adopted_operation = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
    allowed = {"runtime-rollout"}
    if adopted_operation:
        allowed = {adopted_operation}
    if value.get("schemaVersion") != 1 or value.get("owner") != owner or value.get("operation") not in allowed:
        raise SystemExit("runtime maintenance fence ownership changed; retaining fence")
    os.unlink(path)
except FileNotFoundError:
    pass
directory = os.open(os.path.dirname(path), os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
PY
  fence_acquired=0
}

release_successful_maintenance() {
  if (( preserve_borrowed_maintenance == 1 || RETAIN_SUCCESSFUL_MAINTENANCE == 1 )); then
    return 0
  fi
  release_runtime_fence
  clear_boot_hold
}

fsync_mutable_state() {
  assert_runtime_fence
  python3 - "$JOURNAL_ROOT" /var/lib/mc-aws /var/lib/mc-agent-executor /var/lib/mc-agent-gateway <<'PY'
import os, stat, sys
excluded = os.path.abspath(sys.argv[1])

def flush(path):
    if os.path.abspath(path) == excluded:
        return
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISREG(metadata.st_mode):
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    elif stat.S_ISDIR(metadata.st_mode):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
        try:
            for entry in sorted(os.scandir(path), key=lambda item: item.name):
                flush(os.path.join(path, entry.name))
            os.fsync(descriptor)
        finally: os.close(descriptor)

for candidate in sys.argv[2:]:
    flush(candidate)
PY
}

drain_and_quiesce_runtime() {
  local attempt
  quiesce_attempted=1
  assert_runtime_fence
  if systemctl is-active --quiet mc-agent-gateway.service; then
    systemctl kill --kill-whom=main --signal=SIGUSR1 mc-agent-gateway.service ||
      fail "could not request gateway drain behind runtime fence"
    for ((attempt = 1; attempt <= DRAIN_MAX_ATTEMPTS; attempt++)); do
      systemctl is-active --quiet mc-agent-gateway.service || break
      (( attempt < DRAIN_MAX_ATTEMPTS )) || fail "gateway did not drain before the maintenance deadline"
      sleep "$DRAIN_INTERVAL"
    done
  fi
  # The gateway may have completed its effect between SIGUSR1 and exit.  The
  # authenticated verifier is the authority, not process state or elapsed time.
  for ((attempt = 1; attempt <= DRAIN_MAX_ATTEMPTS; attempt++)); do
    if [[ ! -x "$MC_HOST_OPERATION_HELPER" ]]; then
      fail "host-operation verifier is unavailable"
    fi
    if "$MC_HOST_OPERATION_HELPER" executor-idle \
      --journal "$EXECUTOR_JOURNAL" \
      --credential "$EXECUTOR_JOURNAL_CREDENTIAL" \
      --gateway-journal "$GATEWAY_RECONCILIATION_JOURNAL" \
      --handoff-state auto \
      --checkpoint-sequence "$EXECUTOR_JOURNAL_CHECKPOINT" >/dev/null 2>&1; then
      break
    fi
    (( attempt < DRAIN_MAX_ATTEMPTS )) || fail "executor effect is not authoritatively idle"
    sleep "$DRAIN_INTERVAL"
  done
  # Mask before stopping: a queued socket activation must not recreate the
  # executor while the release journal is being made authoritative.
  systemctl mask --runtime "${SERVICE_UNITS[@]}" || fail "could not mask runtime activation paths"
  systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-host-broker.socket mc-agent-host-broker.service mc-agent-executor.socket mc-agent-executor.service minecraft.service minecraft-dns.service ||
    fail "could not stop runtime activation paths"
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == inactive ]] || fail "$unit remained active after quiescence"
  done
  # A final authenticated observation closes the stop/journal-write race.
  if ! "$MC_HOST_OPERATION_HELPER" executor-idle \
    --journal "$EXECUTOR_JOURNAL" \
    --credential "$EXECUTOR_JOURNAL_CREDENTIAL" \
    --gateway-journal "$GATEWAY_RECONCILIATION_JOURNAL" \
    --handoff-state auto \
     --checkpoint-sequence "$EXECUTOR_JOURNAL_CHECKPOINT" >/dev/null 2>&1; then
    fail "executor effect became active or indeterminate during quiescence"
  fi
  runtime_quiesced=1
}

capture_service_state() {
  local output="$1" unit active enabled
  : > "$output"
  for unit in "${SERVICE_UNITS[@]}"; do
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    [[ "$active" == active || "$active" == inactive ]] || fail "unstable active state for $unit: $active"
    [[ "$enabled" =~ ^(enabled|enabled-runtime|disabled|static|indirect|masked|masked-runtime|not-found)$ ]] || fail "unsupported enablement state for $unit: $enabled"
    printf '%s\t%s\t%s\n' "$unit" "$active" "$enabled" >> "$output"
  done
  python3 - "$output" <<'PY'
import os, sys
descriptor = os.open(sys.argv[1], os.O_RDONLY)
try: os.fsync(descriptor)
finally: os.close(descriptor)
PY
}

capture_minecraft_log_baseline() {
  if [[ -f /opt/minecraft/server/logs/latest.log && ! -L /opt/minecraft/server/logs/latest.log ]]; then
    read -r minecraft_log_device minecraft_log_inode minecraft_log_bytes < <(
      stat -c '%d %i %s' /opt/minecraft/server/logs/latest.log
    )
  else
    minecraft_log_bytes=0
    minecraft_log_device=0
    minecraft_log_inode=0
  fi
}

agent_target_wants_path() {
  case "$1" in
    mc-agent-executor.socket) printf '%s' /etc/systemd/system/sockets.target.wants/mc-agent-executor.socket ;;
    mc-agent-tool-read.socket) printf '%s' /etc/systemd/system/sockets.target.wants/mc-agent-tool-read.socket ;;
    mc-agent-tool-write.socket) printf '%s' /etc/systemd/system/sockets.target.wants/mc-agent-tool-write.socket ;;
    mc-agent-tool-read.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-tool-read.service ;;
    mc-agent-tool-write.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-tool-write.service ;;
    mc-agent-executor.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-executor.service ;;
    mc-agent-gateway.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-gateway.service ;;
    mc-agent-world-roots.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-world-roots.service ;;
    mc-agent-host-broker.socket) printf '%s' /etc/systemd/system/sockets.target.wants/mc-agent-host-broker.socket ;;
    mc-agent-host-broker.service) printf '%s' /etc/systemd/system/multi-user.target.wants/mc-agent-host-broker.service ;;
    *) return 1 ;;
  esac
}

expected_agent_link_target() {
  printf '/etc/systemd/system/%s' "$1"
}

snapshot_agent_target_wants_record() {
  local path="$1"
  python3 - "$attempt_dir/snapshot.json" "$path" <<'PY'
import hashlib, json, os, sys
snapshot_path, wanted = sys.argv[1:]
envelope = json.load(open(snapshot_path, encoding="utf-8"))
payload = envelope.get("payload")
canonical = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
if envelope.get("schemaVersion") != 2 or hashlib.sha256(canonical).hexdigest() != envelope.get("payloadSha256"):
    raise SystemExit("release snapshot payload digest mismatch")
matches = [record for record in payload.get("records", []) if isinstance(record, dict) and record.get("path") == wanted]
if len(matches) != 1:
    raise SystemExit(f"agent target-wants snapshot is missing an exact record: {wanted}")
record = matches[0]
kind = record.get("type")
if kind == "symlink":
    print(f"symlink\t{record.get('target', '')}")
elif kind == "missing":
    print("missing\t")
else:
    print(f"{kind}\t")
PY
}

restore_agent_target_wants_for_not_found() {
  local unit active enabled path snapshot current expected
  while IFS=$'\t' read -r unit active enabled; do
    [[ "$enabled" == not-found ]] || continue
    path="$(agent_target_wants_path "$unit")" || fail "agent target-wants mapping is incomplete: $unit"
    snapshot="$(snapshot_agent_target_wants_record "$path")" || return 1
    current=""
    if [[ -L "$path" ]]; then
      current="symlink$(printf '\t%s' "$(readlink -- "$path")")"
    elif [[ -e "$path" ]]; then
      current="$(stat -c '%F' -- "$path")"
    fi
    if [[ "$snapshot" == $'missing\t' ]]; then
      if [[ -z "$current" ]]; then
        continue
      fi
      expected="$(expected_agent_link_target "$unit")"
      [[ "$current" == $'symlink\t'"$expected" ]] ||
        fail "unrelated agent target-wants entry changed during rollout: $path"
      rm -f -- "$path"
    elif [[ "$snapshot" == symlink$'\t'* ]]; then
      expected="$(expected_agent_link_target "$unit")"
      [[ "$snapshot" == $'symlink\t'"$expected" ]] ||
        fail "unrelated prior agent target-wants entry is not an exact unit link: $path"
      [[ "$current" == "$snapshot" ]] ||
        fail "pre-existing agent target-wants entry changed during rollout: $path"
    else
      fail "unsupported prior agent target-wants entry: $path"
    fi
  done < "$service_state"
}

start_candidate_minecraft() {
  local unit_path="/run/systemd/system/$readiness_unit"
  [[ -n "$candidate_server" && -d "$candidate_server" && ! -L "$candidate_server" ]] || return 1
  cat > "$unit_path" <<EOF
[Unit]
Description=Disposable mc-aws runtime rollout readiness server
After=network-online.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=$candidate_server
ExecStart=/usr/bin/screen -DmS mc-rollout-readiness /usr/bin/java -Xms3276M -Xmx3276M -jar paper.jar nogui
ExecStopPost=-/usr/bin/screen -S mc-rollout-readiness -X quit
KillMode=control-group
TimeoutStartSec=300
TimeoutStopSec=30
Restart=no
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=full
ProtectHome=true
PrivateMounts=true
PrivateUsers=true
ProtectProc=ptraceable
ProcSubset=pid
RestrictNamespaces=true
ReadWritePaths=$candidate_server
InaccessiblePaths=/opt/minecraft/server /etc/mc-agent /run/credentials /var/lib/mc-agent-executor /opt/mc-agent/executor-root
IPAddressDeny=169.254.169.254/32
IPAddressDeny=fd00:ec2::254/128
EOF
  chmod 0600 "$unit_path"
  systemctl daemon-reload || return 1
  systemctl start "$readiness_unit" || return 1
  readiness_minecraft_started=1
}

stop_candidate_minecraft() {
  (( readiness_minecraft_started == 1 )) || return 0
  systemctl stop "$readiness_unit" || return 1
  readiness_minecraft_started=0
  rm -f -- "/run/systemd/system/$readiness_unit"
  systemctl daemon-reload || return 1
}

restore_enablement() {
  local unit="$1" enabled="$2" current temp
  case "$enabled" in
    enabled) systemctl enable "$unit" ;;
    enabled-runtime) systemctl enable --runtime "$unit" ;;
    disabled) systemctl disable "$unit" ;;
    masked)
      current="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
      if [[ "$current" != masked ]]; then
        install -d -o root -g root -m 0755 /etc/systemd/system.control
        temp="/etc/systemd/system.control/.${unit}.mc-rollout-mask"
        [[ ! -e "$temp" && ! -L "$temp" ]] || return 1
        ln -s /dev/null "$temp" || return 1
        mv -Tf -- "$temp" "/etc/systemd/system.control/$unit" || return 1
      fi
      ;;
    masked-runtime|static|indirect|not-found) ;;
    *) return 1 ;;
  esac
}

restore_services() {
  local state="$1" mode="${2:-exact}" unit active enabled
  assert_runtime_fence
  systemctl daemon-reload || return 1
  while IFS=$'\t' read -r unit active enabled; do
    [[ "$enabled" == masked-runtime ]] || systemctl unmask --runtime "$unit" || return 1
    restore_enablement "$unit" "$enabled" || return 1
  done < "$state"
  systemctl daemon-reload || return 1
  for unit in "${SERVICE_UNITS[@]}"; do
    [[ "$mode" != precommit || "$unit" != minecraft.service ]] || continue
    active="$(while IFS=$'\t' read -r found found_active _; do [[ "$found" != "$unit" ]] || { printf '%s' "$found_active"; break; }; done < "$state")"
    [[ "$active" != active ]] || { [[ "$unit" == mc-agent-world-roots.service ]] && systemctl restart "$unit" || systemctl start "$unit"; } || return 1
  done
}

prepare_service_restoration() {
  update_boot_hold validating
  # Re-running generators on this boot removes only the generated boot masks.
  # A reboot changes bootId and therefore regenerates fail-closed masks.
  systemctl daemon-reload || return 1
}

verify_service_state() {
  local state="$1" mode="${2:-exact}" unit active enabled current_active current_enabled expected_enabled expected_active_state
  while IFS=$'\t' read -r unit active enabled; do
    current_active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    current_enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    expected_enabled="$enabled"
    expected_active_state="$active"
    [[ "$unit" == minecraft.service && "$readiness_minecraft_started" == 1 ]] && expected_active_state=active
    [[ "$mode" != precommit && "$mode" != precommit-agent || "$unit" != minecraft.service ]] || continue
    [[ "$mode" != installed || "$enabled" != not-found ]] || expected_enabled=disabled
    if [[ "$mode" =~ ^(installed-agent|precommit-agent)$ && "$unit" =~ ^mc-agent-(executor\.socket|executor\.service|gateway\.service|world-roots\.service)$ ]]; then
      expected_enabled=enabled
      expected_active_state=active
    elif [[ "$mode" =~ ^(installed-agent|precommit-agent)$ && "$enabled" == not-found ]]; then
      expected_enabled=disabled
    fi
    [[ "$current_active" == "$expected_active_state" && "$current_enabled" == "$expected_enabled" ]] || return 1
  done < "$state"
}

expected_active() {
  local unit="$1" active
  if [[ "$unit" == minecraft.service && "$readiness_minecraft_started" == 1 ]]; then
    systemctl is-active --quiet "$unit"
    return
  fi
  if (( ENABLE_AGENT == 1 )) && [[ "$unit" =~ ^mc-agent-(executor\.socket|executor\.service|gateway\.service|world-roots\.service)$ ]]; then
    systemctl is-active --quiet "$unit"
    return
  fi
  active="$(while IFS=$'\t' read -r found found_active _; do [[ "$found" != "$unit" ]] || { printf '%s' "$found_active"; break; }; done < "$service_state")"
  [[ "$active" == active ]]
}

stable_unit() {
  local unit="$1"
  for _ in 1 2 3; do
    timeout --kill-after=2s 2s systemctl is-active --quiet "$unit" || return 1
    sleep 1
  done
}

probe_unix_service() {
  local socket="$1" expected_error="$2"
  timeout --kill-after=2s 3s python3 - "$socket" "$expected_error" <<'PY'
import socket, sys
path, expected = sys.argv[1:]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(2)
client.connect(path)
client.sendall(b"{}\n")
response = client.recv(4096)
if not response or expected.encode() not in response:
    raise SystemExit("unexpected local health response")
PY
}

validate_profile_readiness() {
  python3 - "$profile_release" /opt/minecraft/server "$PROFILE_MANIFEST_FILE" "$paper_sha256" "$candidate_paper" <<'PY'
import hashlib, json, os, pathlib, stat, sys

profile_root, live_root, asset_manifest_path = map(pathlib.Path, sys.argv[1:4])
expected_paper = sys.argv[4]
candidate_path = pathlib.Path(sys.argv[5])
asset_manifest = json.loads(asset_manifest_path.read_text(encoding="utf-8"))
published_profile = asset_manifest.get("profile")
if not isinstance(published_profile, dict) or not isinstance(published_profile.get("plugins"), list):
    raise SystemExit("published profile plugin evidence is invalid")
lock_path = profile_root / "plugins.lock.json"
if not lock_path.is_file() or lock_path.is_symlink():
    raise SystemExit("staged plugin lock is unavailable")
lock = json.loads(lock_path.read_text(encoding="utf-8"))
if lock.get("version") != 1 or not isinstance(lock.get("plugins"), list):
    raise SystemExit("staged plugin lock schema is invalid")
if lock["plugins"] != published_profile["plugins"]:
    raise SystemExit("staged plugin lock contents do not match published evidence")

def regular(path: pathlib.Path, label: str) -> bytes:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        raise SystemExit(f"{label} is missing")
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"{label} is not a regular file")
    return path.read_bytes()

candidate_paper = regular(candidate_path, "staged Paper")
if hashlib.sha256(candidate_paper).hexdigest() != expected_paper:
    raise SystemExit("staged Paper digest mismatch")
if hashlib.sha256(regular(live_root / "paper.jar", "live Paper")).hexdigest() != expected_paper:
    raise SystemExit("live Paper digest mismatch")
profile_paper = profile_root / "paper.jar"
if profile_paper.exists() and hashlib.sha256(regular(profile_paper, "profile Paper")).hexdigest() != expected_paper:
    raise SystemExit("profile Paper digest mismatch")

for current, directories, files in os.walk(profile_root, followlinks=False):
    current_path = pathlib.Path(current)
    for name in directories:
        if (current_path / name).is_symlink():
            raise SystemExit("staged profile contains a symlinked directory")
    for name in files:
        relative = (current_path / name).relative_to(profile_root)
        if relative.parts == ("plugins.lock.json",) or relative.parts == ("rclone.conf",):
            continue
        source = current_path / name
        target = live_root.joinpath(*relative.parts)
        source_bytes = regular(source, f"staged profile destination {relative}")
        target_bytes = regular(target, f"live profile destination {relative}")
        if source_bytes != target_bytes:
            raise SystemExit(f"live profile destination mismatch: {relative}")

expected_destinations = set()
for plugin in lock["plugins"]:
    if not isinstance(plugin, dict) or set(plugin) not in ({"name", "destination", "url", "sha256"}, {"name", "destination", "url", "sha256", "bytes"}):
        raise SystemExit("staged plugin lock entry is invalid")
    destination = plugin["destination"]
    if not isinstance(destination, str) or "/" in destination or destination in {"", ".", ".."}:
        raise SystemExit("staged plugin lock destination is unsafe")
    expected_destinations.add(destination)
    plugin_bytes = regular(live_root / "plugins" / destination, f"live plugin {destination}")
    if hashlib.sha256(plugin_bytes).hexdigest() != plugin["sha256"]:
        raise SystemExit(f"live plugin digest mismatch: {destination}")
    if "bytes" in plugin and (not isinstance(plugin["bytes"], int) or plugin["bytes"] != len(plugin_bytes)):
        raise SystemExit(f"live plugin byte identity mismatch: {destination}")

plugins_root = live_root / "plugins"
if plugins_root.exists():
    plugins_metadata = plugins_root.lstat()
    if plugins_root.is_symlink() or not stat.S_ISDIR(plugins_metadata.st_mode):
        raise SystemExit("live plugins path is unsafe")
    for current, directories, files in os.walk(plugins_root, followlinks=False):
        current_path = pathlib.Path(current)
        for name in directories + files:
            entry = current_path / name
            metadata = entry.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                raise SystemExit("live plugin tree contains a link or special file")
            if stat.S_ISREG(metadata.st_mode) and name.lower().endswith(".jar"):
                relative = entry.relative_to(plugins_root)
                if relative.parts != (name,) or name not in expected_destinations:
                    raise SystemExit(f"live plugin tree contains an unreviewed JAR: {relative}")
PY
}

stage_candidate_server() {
  local candidate_parent="$work/readiness-candidate"
  candidate_server="$candidate_parent/server"
  install -d -o root -g root -m 0700 "$candidate_parent"
  [[ -d /opt/minecraft/server && ! -L /opt/minecraft/server && ! -e "$candidate_server" ]] || return 1
  # The readiness JVM receives a private copy/reflink of every world and plugin
  # datum.  Any startup migration, player write, or plugin mutation is discarded
  # and cannot escape into the pre-commit live tree.
  cp -a --reflink=auto -- /opt/minecraft/server "$candidate_server" || return 1
  chown -R minecraft:minecraft "$candidate_server" || return 1
  candidate_paper="$candidate_server/paper.jar"
}

run_readiness_and_restore_state() {
  stage_candidate_server || return 1
  validate_profile_readiness || return 1
  start_candidate_minecraft || return 1
  if ! (probe_readiness || return 1); then stop_candidate_minecraft || true; return 1; fi
  stop_candidate_minecraft || return 1
  if (( ENABLE_AGENT == 1 )); then
    verify_service_state "$service_state" precommit-agent || return 1
  else
    verify_service_state "$service_state" precommit || return 1
  fi
}

probe_readiness() {
  local unit
  /usr/local/bin/mc-agent-world-roots.py verify || return 1
  for unit in "${SERVICE_UNITS[@]}"; do [[ "$unit" == minecraft.service ]] && continue; expected_active "$unit" || continue; stable_unit "$unit" || return 1; done
  stable_unit "$readiness_unit" || return 1
  if (( readiness_minecraft_started == 1 )); then
    timeout --kill-after=2s 5s mcstatus 127.0.0.1:25565 status >/dev/null || return 1
    if [[ -f "$candidate_server/logs/latest.log" ]]; then
      python3 - "$candidate_server/logs/latest.log" <<'PY'
import re, sys
path = sys.argv[1]
with open(path, "rb") as source:
    text = source.read(4 * 1024 * 1024).decode("utf-8", "replace")
if re.search(r"(?:Error occurred while enabling|Could not load|Failed to (?:load|enable) plugin)", text, re.I):
    raise SystemExit("plugin initialization failed")
PY
      python3 - "$candidate_server/logs/latest.log" "$profile_release/plugins.lock.json" <<'PY'
import json, pathlib, re, sys
log = pathlib.Path(sys.argv[1]).read_bytes().decode("utf-8", "replace")
lock_path = pathlib.Path(sys.argv[2])
plugins = json.loads(lock_path.read_text(encoding="utf-8")).get("plugins", []) if lock_path.is_file() else []
if not re.search(r"Done \(", log):
    raise SystemExit("fresh startup did not publish Minecraft readiness")
for plugin in plugins:
    name = plugin.get("name")
    if not isinstance(name, str) or not re.search(re.escape(name), log, re.I):
        raise SystemExit(f"fresh startup did not publish readiness for installed plugin: {name}")
PY
    fi
  fi
  if (( ENABLE_AGENT == 1 )) || expected_active mc-agent-executor.socket; then
    [[ -S /run/mc-agent/executor.sock ]] || return 1
    probe_unix_service /run/mc-agent/executor.sock invalid-request || return 1
    if (( ENABLE_AGENT == 0 )) && ! expected_active mc-agent-executor.service; then
      systemctl stop mc-agent-executor.service || return 1
    fi
  elif expected_active mc-agent-executor.service; then
    probe_unix_service /run/mc-agent/executor.sock invalid-request || return 1
  fi
  if (( ENABLE_AGENT == 1 )) || expected_active mc-agent-gateway.service; then
    probe_unix_service /run/mc-agent-download/download.sock invalid || return 1
  fi
  if (( ENABLE_AGENT == 1 )) || expected_active mc-agent-world-roots.service; then
    probe_unix_service /run/mc-agent-world-roots/transaction.sock schema || return 1
  fi
  if (( ENABLE_AGENT == 1 )); then verify_service_state "$service_state" installed-agent
  else verify_service_state "$service_state" installed
  fi
}

verify_installed_release() {
  [[ "$(readlink /opt/mc-agent/current 2>/dev/null || true)" == "$target_runtime" ]] || return 1
  printf '%s  %s\n' "$release_manifest_sha256" /var/lib/mc-aws/host-release-manifest.json | sha256sum --check --status || return 1
  python3 - /var/lib/mc-aws/host-release-manifest.json /var/lib/mc-aws/runtime-hashes.sha256 <<'PY'
import hashlib, json, os, sys
manifest_path, evidence_path = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding="utf-8"))
evidence = set(open(evidence_path, encoding="utf-8").read().splitlines())
shell = manifest.get("shellToolchain")
if manifest.get("packagingMode") not in ("qualified", "local-disposable"):
    raise SystemExit("installed host release packaging mode is invalid")
if not isinstance(shell, dict) or set(shell) != {"path", "bytes", "sha256"} or shell.get("path") != "toolchain/shell-toolchain.json":
    raise SystemExit("installed shell toolchain release identity is incomplete")
transformed = {
    "/etc/mc-agent/world-roots-current/gateway.json",
    "/etc/mc-agent/world-roots-current/executor.json",
}
for item in manifest["files"]:
    expected = f'{item["destination"]} {item["sha256"]} {item["bytes"]}'
    if expected not in evidence:
        raise SystemExit("installed host release evidence is incomplete")
    if item["destination"] in transformed:
        continue
    data = open(item["destination"], "rb").read()
    if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise SystemExit("installed host release member mismatch")
agent = manifest["agentRuntime"]
if f'agent-runtime {agent["sha256"]} {agent["bytes"]}' not in evidence or f'agent-runtime-manifest {agent["bundleManifestSha256"]} {agent["bundleManifestBytes"]}' not in evidence:
    raise SystemExit("installed agent runtime evidence is incomplete")
PY
  /usr/local/bin/mc-agent-world-roots.py verify || return 1
}

recover_active_attempt() {
  local phase attempt release profile state_digest prior_runtime prior_node requested_target requested_enable
  readarray -t recovery < <(python3 "$journal_helper" --root "$JOURNAL_ROOT" describe | python3 -c '
import json,sys
value=json.load(sys.stdin); descriptor=value["descriptor"]
for item in (value["phase"],value["attempt"],descriptor["hostReleaseSha256"],descriptor["profileSha256"],descriptor["serviceStateSha256"],descriptor.get("runtimeBefore",""),descriptor.get("nodeBefore",""),descriptor.get("targetRuntime",""),"1" if descriptor.get("enableAgent") is True else "0"): print(item)
')
  (( ${#recovery[@]} == 9 )) || fail "active release journal description is incomplete"
  phase="${recovery[0]}"; attempt="${recovery[1]}"; release="${recovery[2]}"; profile="${recovery[3]}"
  state_digest="${recovery[4]}"; prior_runtime="${recovery[5]}"; prior_node="${recovery[6]}"; requested_target="${recovery[7]}"
  requested_enable="${recovery[8]}"
  [[ "$release" == "$release_sha256" && "$profile" == "$profile_sha256" && "$requested_target" == "$target_runtime" && "$requested_enable" == "$ENABLE_AGENT" ]] ||
    fail "unresolved release attempt does not match this exact requested release"

  acquire_or_adopt_maintenance
  update_boot_hold recovering "$(basename -- "$attempt")"
  service_state="$attempt/service-state.tsv"
  service_state_sha256="$state_digest"
  runtime_before="$prior_runtime"; node_before="$prior_node"; journal_started=1; quiesce_attempted=1
  [[ -f "$service_state" && ! -L "$service_state" ]] || fail "active release service-state evidence is unavailable"
  [[ "$(sha256sum "$service_state" | cut -d ' ' -f 1)" == "$service_state_sha256" ]] ||
    fail "active release service-state evidence digest mismatch"
  [[ "$phase" =~ ^(snapshotted|profile-installed|runtime-installed|services-restored|readiness-passed|rolling-back|filesystem-restored|rolled-back|committed)$ ]] && snapshot_taken=1 || snapshot_taken=0

  if [[ "$phase" == committed ]]; then
    verify_installed_release || fail "committed release evidence no longer matches"
    prepare_service_restoration || return 1
    capture_minecraft_log_baseline || return 1
    restore_services "$service_state" || return 1
    if (( ENABLE_AGENT == 1 )); then
      systemctl unmask mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service || return 1
      systemctl enable mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service || return 1
      systemctl start mc-agent-tool-read.socket mc-agent-tool-write.socket || return 1
      systemctl start mc-agent-executor.socket mc-agent-host-broker.socket || return 1
      systemctl start mc-agent-gateway.service || return 1
    fi
    # The generation is already committed, but reuse the same isolated
    # readiness proof without contending with the live listener.
    systemctl stop minecraft.service || return 1
    run_readiness_and_restore_state || return 1
    restore_services "$service_state" || return 1
    python3 "$journal_helper" --root "$JOURNAL_ROOT" finish committed || return 1
    journal_started=0; committed=1
    release_successful_maintenance || return 1
    printf 'MC_EXECUTOR_RECEIPT_VERIFIER='; cat /etc/mc-agent/executor-receipt-verifier.json
    printf 'Host release verified: %s\n' "$release_manifest_sha256"
    return 10
  fi
  [[ "$phase" =~ ^(prepared|quiesced|snapshotted|profile-installed|runtime-installed|services-restored|readiness-passed|pre-snapshot-rolling-back|rolling-back|filesystem-restored|rolled-back)$ ]] ||
    fail "active release journal has an unsupported phase"
  drain_and_quiesce_runtime || return 1
  runtime_after="$(readlink /opt/mc-agent/current 2>/dev/null || true)"
  node_after="$(readlink /opt/mc-agent/node-current 2>/dev/null || true)"
  [[ "$runtime_after" == "$runtime_before" || "$runtime_after" == "$target_runtime" ]] ||
    fail "active release runtime link changed outside the recorded attempt"
  [[ "$node_after" == "$node_before" ]] || fail "active release Node link changed outside the recorded attempt"
  [[ "$runtime_after" == "$runtime_before" ]] || runtime_transition_changed=1
  if [[ "$phase" != pre-snapshot-rolling-back && "$phase" != rolling-back && "$phase" != filesystem-restored && "$phase" != rolled-back ]]; then
    if (( snapshot_taken == 1 )); then
      python3 "$journal_helper" --root "$JOURNAL_ROOT" phase rolling-back || return 1
      phase="rolling-back"
    else
      python3 "$journal_helper" --root "$JOURNAL_ROOT" phase pre-snapshot-rolling-back || return 1
      phase="pre-snapshot-rolling-back"
    fi
  fi
  if (( snapshot_taken == 1 )) && [[ "$phase" == rolling-back ]]; then
    restore_agent_target_wants_for_not_found || return 1
    python3 "$journal_helper" --root "$JOURNAL_ROOT" restore || return 1
  fi
  if [[ "$phase" == rolling-back || "$phase" == pre-snapshot-rolling-back ]]; then
    python3 "$journal_helper" --root "$JOURNAL_ROOT" phase filesystem-restored || return 1
    phase="filesystem-restored"
  fi
  prepare_service_restoration || return 1
  restore_services "$service_state" || return 1
  verify_service_state "$service_state" || fail "prior service state could not be restored exactly"
  [[ "$phase" == rolled-back ]] || python3 "$journal_helper" --root "$JOURNAL_ROOT" phase rolled-back || return 1
  python3 "$journal_helper" --root "$JOURNAL_ROOT" finish rolled-back || return 1
  journal_started=0; snapshot_taken=0; runtime_quiesced=0
  release_successful_maintenance || return 1
  printf '%s\n' 'MC_RELEASE_RECOVERY=rolled-back'
  printf '%s\n' 'Recovered and exactly rolled back the unresolved prior release attempt; the requested release was not applied.' >&2
  return 20
}

rollback_attempt() {
  set +e
  if ! assert_runtime_fence; then
    rollback_failed=1
    set -e
    return 0
  fi
  if (( quiesce_attempted == 1 && runtime_quiesced == 0 )); then
    printf '%s\n' 'Runtime quiescence could not be proven; the attempt journal, runtime masks, and maintenance fence are retained.' >&2
    set -e
    return 0
  fi
  systemctl mask --runtime "${SERVICE_UNITS[@]}" || rollback_failed=1
  systemctl stop "${SERVICE_UNITS[@]}" || rollback_failed=1
  if (( rollback_failed == 0 )); then
    if (( snapshot_taken == 1 )); then
      python3 "$journal_helper" --root "$JOURNAL_ROOT" phase rolling-back || rollback_failed=1
    else
      python3 "$journal_helper" --root "$JOURNAL_ROOT" phase pre-snapshot-rolling-back || rollback_failed=1
    fi
  fi
  if (( runtime_transition_changed == 1 )); then
    [[ "$(readlink /opt/mc-agent/current 2>/dev/null || true)" == "$runtime_after" &&
       "$(readlink /opt/mc-agent/node-current 2>/dev/null || true)" == "$node_after" ]] || rollback_failed=1
  fi
  if [[ "${MC_RUNTIME_ROLLOUT_FAULT_ROLLBACK:-0}" == 1 && "${MC_RUNTIME_ROLLOUT_TEST_MODE:-0}" == 1 && "$JOURNAL_ROOT" != /var/lib/mc-aws/runtime-rollouts ]]; then
    rollback_failed=1
  elif (( rollback_failed == 0 && snapshot_taken == 1 )); then
    restore_agent_target_wants_for_not_found || rollback_failed=1
  fi
  if (( rollback_failed == 0 && snapshot_taken == 1 )); then
    if (( runtime_transition_changed == 1 )); then
      python3 "$journal_helper" --root "$JOURNAL_ROOT" restore || rollback_failed=1
    else
      python3 "$journal_helper" --root "$JOURNAL_ROOT" restore \
        --skip-path /opt/mc-agent/current --skip-path /opt/mc-agent/node-current \
        --skip-path /opt/mc-agent/node-previous --skip-path /opt/mc-agent/runtime-previous || rollback_failed=1
    fi
  fi
  if (( rollback_failed == 0 )); then
    python3 "$journal_helper" --root "$JOURNAL_ROOT" phase filesystem-restored || rollback_failed=1
  fi
  if (( rollback_failed == 0 )); then
    prepare_service_restoration || rollback_failed=1
    [[ "$(sha256sum "$service_state" | cut -d ' ' -f 1)" == "$service_state_sha256" ]] &&
      restore_services "$service_state" && verify_service_state "$service_state" || rollback_failed=1
  fi
  if (( rollback_failed == 0 )); then
    if python3 "$journal_helper" --root "$JOURNAL_ROOT" phase rolled-back &&
       python3 "$journal_helper" --root "$JOURNAL_ROOT" finish rolled-back; then
      journal_started=0
      release_runtime_fence || rollback_failed=1
      (( rollback_failed != 0 )) || clear_boot_hold || rollback_failed=1
    else
      rollback_failed=1
    fi
  fi
  if (( rollback_failed != 0 )); then
    systemctl mask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || true
    systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service || true
    printf '%s\n' 'Host release rollback failed; the attempt journal is retained and lifecycle remains explicitly quiesced.' >&2
  else
    printf '%s\n' 'Host release activation failed; the exact prior filesystem and service state was restored.' >&2
  fi
  set -e
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if (( status != 0 && committed == 0 && journal_started == 1 )); then
    runtime_after="$(readlink /opt/mc-agent/current 2>/dev/null || true)"
    node_after="$(readlink /opt/mc-agent/node-current 2>/dev/null || true)"
    if [[ "$runtime_after" != "$runtime_before" || "$node_after" != "$node_before" ]]; then
      if [[ "$runtime_after" == "$target_runtime" && "$node_after" == "$node_before" ]]; then runtime_transition_changed=1; else rollback_failed=1; fi
    fi
    rollback_attempt
  elif (( status != 0 && committed == 0 && (fence_acquired == 1 || boot_hold_acquired == 1) )); then
    if release_runtime_fence; then
      clear_boot_hold || true
    fi
  fi
  systemctl stop "$readiness_unit" >/dev/null 2>&1 || true
  rm -f -- "/run/systemd/system/$readiness_unit"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
signal_exit() {
  local status="$1"
  trap - HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'signal_exit 129' HUP
trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM

if [[ -n "$MANIFEST_FILE" ]]; then
  [[ -f "$MANIFEST_FILE" && ! -L "$MANIFEST_FILE" ]] || fail "manifest snapshot is unsafe"
  cp -- "$MANIFEST_FILE" "$work/asset-manifest.json"
else
  aws ssm get-parameter --name /minecraft/server-profile-manifest --query Parameter.Value --output text > "$work/asset-manifest.json"
fi
readarray -t release_fields < <(python3 - "$work/asset-manifest.json" <<'PY'
import json, re, sys
value=json.load(open(sys.argv[1], encoding="utf-8"))
if set(value) != {"version","hostRelease","profile"} or value["version"] != 3: raise SystemExit("invalid release manifest")
release=value["hostRelease"]; profile=value["profile"]
if not isinstance(release,dict) or not isinstance(profile,dict): raise SystemExit("invalid release entries")
if not re.fullmatch(r"[a-f0-9]{64}", release.get("sha256","")) or not isinstance(release.get("bytes"),int): raise SystemExit("invalid release evidence")
if not re.fullmatch(r"[a-f0-9]{64}", release.get("releaseManifestSha256","")) or not isinstance(release.get("releaseManifestBytes"),int): raise SystemExit("invalid release manifest evidence")
if not re.fullmatch(r"[a-f0-9]{64}", profile.get("sha256","")): raise SystemExit("invalid profile evidence")
print(release["uri"]); print(release["sha256"]); print(release["bytes"]); print(release["releaseManifestSha256"]); print(release["releaseManifestBytes"]); print(profile["sha256"])
PY
)
(( ${#release_fields[@]} == 6 )) || fail "release manifest is incomplete"
release_uri="${release_fields[0]}"; release_sha256="${release_fields[1]}"; release_bytes="${release_fields[2]}"
release_manifest_sha256="${release_fields[3]}"; release_manifest_bytes="${release_fields[4]}"; profile_sha256="${release_fields[5]}"
PROFILE_MANIFEST_FILE="$work/asset-manifest.json"
profile_release="/opt/setup/profile-$profile_sha256"
if [[ -z "$RELEASE_ROOT" ]]; then
  aws s3 cp --only-show-errors "$release_uri" "$work/host-release.zip"
  [[ "$(stat -c '%s' "$work/host-release.zip")" == "$release_bytes" ]] || fail "host release size mismatch"
  printf '%s  %s\n' "$release_sha256" "$work/host-release.zip" | sha256sum --check --status || fail "host release checksum mismatch"
  RELEASE_ROOT="$work/extracted"
  mkdir "$RELEASE_ROOT"
  python3 - "$work/host-release.zip" "$RELEASE_ROOT" <<'PY'
import os, stat, sys, zipfile
from pathlib import PurePosixPath
archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries=source.infolist()
    if not entries or len(entries)>128 or sum(item.file_size for item in entries)>157286400: raise SystemExit("host release archive limits exceeded")
    for item in entries:
        path=PurePosixPath(item.filename); mode=item.external_attr >> 16
        if item.is_dir() or path.is_absolute() or any(part in ("",".","..") for part in path.parts) or stat.S_IFMT(mode) not in (0,stat.S_IFREG): raise SystemExit("unsafe host release member")
        target=os.path.join(destination,*path.parts); os.makedirs(os.path.dirname(target),exist_ok=True)
        descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
        with source.open(item) as incoming, os.fdopen(descriptor,"wb") as output: output.write(incoming.read())
PY
fi
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || fail "release root is unsafe"
[[ "$EXECUTOR_JOURNAL_CHECKPOINT" =~ ^(0|[1-9][0-9]*)$ ]] || fail "executor journal checkpoint must be a non-negative integer"
[[ "$(stat -c '%s' "$RELEASE_ROOT/release-manifest.json")" == "$release_manifest_bytes" ]] || fail "release manifest size mismatch"
printf '%s  %s\n' "$release_manifest_sha256" "$RELEASE_ROOT/release-manifest.json" | sha256sum --check --status || fail "release manifest checksum mismatch"
verify_bootstrap_pins "$RELEASE_ROOT/release-manifest.json"
readarray -t release_runtime_fields < <(python3 - "$RELEASE_ROOT/release-manifest.json" <<'PY'
import json, sys
value=json.load(open(sys.argv[1], encoding="utf-8"))
print(value["agentRuntime"]["sha256"])
print(value["bootstrapPins"]["manifest"]["artifacts"]["paper"]["sha256"])
PY
)
(( ${#release_runtime_fields[@]} == 2 )) || fail "host release runtime evidence is incomplete"
target_runtime="releases/${release_runtime_fields[0]}"
paper_sha256="${release_runtime_fields[1]}"
[[ "$target_runtime" =~ ^releases/[a-f0-9]{64}$ ]] || fail "target runtime link is invalid"
journal_helper="$RELEASE_ROOT/host/mc-release-journal.py"
maintenance_helper="$RELEASE_ROOT/host/mc-maintenance-boot.py"
profile_installer="$RELEASE_ROOT/host/mc-profile-install.sh"
[[ -f "$journal_helper" && ! -L "$journal_helper" && -f "$maintenance_helper" && ! -L "$maintenance_helper" &&
   -f "$profile_installer" && ! -L "$profile_installer" ]] || fail "release activation helpers are missing"
assert_persistent_guard_prerequisite
if [[ -e "$JOURNAL_ROOT/active" || -L "$JOURNAL_ROOT/active" ]]; then
  set +e
  recover_active_attempt
  recovery_status=$?
  set -e
  if (( recovery_status == 10 )); then
    trap - EXIT HUP INT TERM
    rm -rf -- "$work"
    exit 0
  fi
  if (( recovery_status == 20 )); then
    trap - EXIT HUP INT TERM
    rm -rf -- "$work"
    exit 0
  fi
  exit "$recovery_status"
fi

acquire_or_adopt_maintenance
reconcile_workspace_dac
if [[ -n "$adopted_maintenance_operation" ]]; then
  update_boot_hold recovery
   systemctl unmask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service
  systemctl daemon-reload
fi

service_state="$work/service-state.tsv"
capture_service_state "$service_state"
capture_service_state "$work/service-state.check.tsv"
cmp -s "$service_state" "$work/service-state.check.tsv" || fail "service state changed while establishing the rollout transaction"
service_state_sha256="$(sha256sum "$service_state" | cut -d ' ' -f 1)"
runtime_before="$(readlink /opt/mc-agent/current 2>/dev/null || true)"
node_before="$(readlink /opt/mc-agent/node-current 2>/dev/null || true)"
attempt_nonce="$(< /proc/sys/kernel/random/uuid)"
begin_args=(--root "$JOURNAL_ROOT" begin --nonce "$attempt_nonce" --release-sha256 "$release_sha256" --profile-sha256 "$profile_sha256" --service-state-sha256 "$service_state_sha256" --service-state-file "$service_state" --runtime-before "$runtime_before" --node-before "$node_before" --target-runtime "$target_runtime")
(( ENABLE_AGENT == 0 )) || begin_args+=(--enable-agent)
attempt_dir="$(python3 "$journal_helper" "${begin_args[@]}")"
journal_started=1
update_boot_hold prepared "$(basename -- "$attempt_dir")"
quiesce_attempted=1
fault_after prepared
capture_minecraft_log_baseline
drain_and_quiesce_runtime
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase quiesced
fault_after quiesced
# Services are stopped and activation paths are masked before mutable state is
# flushed.  The fence remains owned by this attempt through activation and rollback.
fsync_mutable_state
snapshot_args=(
  capture
  --recursive /opt/setup --recursive /etc/mc-agent
  --path /opt/setup --path /etc/mc-agent
  --path /opt/mc-agent --path /opt/mc-agent/releases --path /opt/mc-agent/node-releases
  --path /opt/mc-agent/executor-root --path /opt/mc-agent/executor-root/workspace
  --path /opt/mc-agent/executor-root/scratch --path /opt/mc-agent/executor-root/runtime
  --path /opt/mc-agent/executor-root/config --recursive /opt/mc-agent/executor-root/usr
  --path /opt/mc-agent/executor-root/usr/bin --path /opt/mc-agent/executor-root/usr/lib64
  --path /opt/mc-agent/executor-root/lib64 --path /opt/mc-agent/executor-root/run
  --path /opt/mc-agent/executor-root/run/mc-agent-download --path /opt/mc-agent/executor-root/run/screen
  --path "/opt/mc-agent/$target_runtime"
  --path /opt/mc-agent/agent-runtime.zip --path /opt/mc-agent/current --path /opt/mc-agent/node-current
  --path /opt/mc-agent/node-previous --path /opt/mc-agent/runtime-previous
  --exclude-path "$JOURNAL_ROOT"
  --recursive /etc/systemd/system.control --path /etc/systemd/system.control
  --path /var/lib/mc-aws --path /var/lib/mc-aws/host-release-manifest.json --path /var/lib/mc-aws/runtime-hashes.sha256
  --path /var/lib/mc-agent-executor --path /var/lib/mc-agent-gateway
  --path /var/lib/mc-agent-gateway/work --path /var/lib/mc-agent-gateway/pi
)
for target_wants in "${AGENT_TARGET_WANTS[@]}"; do snapshot_args+=(--path "$target_wants"); done
python3 "$journal_helper" --root "$JOURNAL_ROOT" "${snapshot_args[@]}"
snapshot_taken=1
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase snapshotted
fault_after snapshotted

profile_args=(--manifest-file "$work/asset-manifest.json" --release-root "$RELEASE_ROOT" --bootstrap-pins-sha256 "$PINS_SHA256" --activate-quiesced)
if (( ENABLE_AGENT == 1 )); then
  [[ -n "$GATEWAY_CREDENTIAL_SOURCE" && -n "$BACKUP_FENCE_PUBLIC_SOURCE" ]] || fail "agent enablement requires authoritative credential sources"
  profile_args+=(--enable-agent --gateway-credential-source "$GATEWAY_CREDENTIAL_SOURCE" --backup-fence-public-source "$BACKUP_FENCE_PUBLIC_SOURCE")
fi
MC_RELEASE_JOURNAL_ROOT="$JOURNAL_ROOT" MC_MAINTENANCE_LOCK="$MAINTENANCE_FENCE" MC_MAINTENANCE_OWNER="$MAINTENANCE_OWNER" MC_MAINTENANCE_PARENT_OPERATION="$ADOPT_MAINTENANCE_OPERATION" \
  "$profile_installer" "${profile_args[@]}"
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase profile-installed
fault_after profile-installed

readarray -t agent < <(python3 - /var/lib/mc-aws/host-release-manifest.json <<'PY'
import json, sys
item=json.load(open(sys.argv[1],encoding="utf-8"))["agentRuntime"]
print(item["sha256"]); print(item["bytes"]); print(item["bundleManifestSha256"]); print(item["bundleManifestBytes"])
PY
)
(( ${#agent[@]} == 4 )) || fail "installed host release agent metadata is incomplete"
MC_MAINTENANCE_LOCK="$MAINTENANCE_FENCE" MC_MAINTENANCE_OWNER="$MAINTENANCE_OWNER" MC_MAINTENANCE_PARENT_OPERATION="$ADOPT_MAINTENANCE_OPERATION" \
  /usr/local/bin/mc-agent-install.sh install-runtime-only /opt/mc-agent/agent-runtime.zip "${agent[0]}" "${agent[1]}" "${agent[2]}"
runtime_after="$(readlink /opt/mc-agent/current 2>/dev/null || true)"
node_after="$(readlink /opt/mc-agent/node-current 2>/dev/null || true)"
if [[ "$runtime_after" != "$runtime_before" || "$node_after" != "$node_before" ]]; then runtime_transition_changed=1; fi
grep -Fq "release-manifest $release_manifest_sha256 $release_manifest_bytes" /var/lib/mc-aws/runtime-hashes.sha256
grep -Fq "agent-runtime ${agent[0]} ${agent[1]}" /var/lib/mc-aws/runtime-hashes.sha256
grep -Fq "agent-runtime-manifest ${agent[2]} ${agent[3]}" /var/lib/mc-aws/runtime-hashes.sha256
/usr/local/bin/mc-agent-world-roots.py verify
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase runtime-installed
fault_after runtime-installed

prepare_service_restoration
capture_minecraft_log_baseline
restore_services "$service_state" precommit
# Live Minecraft must remain stopped until the release journal crosses its
# irreversible commit.  It is validated below only through the disposable copy.
if (( ENABLE_AGENT == 1 )); then
  systemctl unmask mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service
  systemctl enable mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-host-broker.socket mc-agent-host-broker.service
  # --enable-agent is an affirmative enable request, not permission to
  # preserve a previously inactive agent. Start every unit explicitly and
  # let readiness probes validate the real endpoints before commit.
  systemctl restart mc-agent-world-roots.service
  systemctl start mc-agent-tool-read.socket mc-agent-tool-write.socket mc-agent-executor.socket mc-agent-host-broker.socket
  systemctl start mc-agent-gateway.service
fi
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase services-restored
fault_after services-restored

run_readiness_and_restore_state
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase readiness-passed
fault_after readiness-passed
python3 "$journal_helper" --root "$JOURNAL_ROOT" barrier \
  --extra-path /etc/systemd/system --extra-path /run/systemd/system
printf 'MC_EXECUTOR_RECEIPT_VERIFIER='; cat /etc/mc-agent/executor-receipt-verifier.json
trap '' HUP INT TERM
python3 "$journal_helper" --root "$JOURNAL_ROOT" phase committed
committed=1
fault_after committed
restore_services "$service_state"
if (( ENABLE_AGENT == 1 )); then
  systemctl start mc-agent-world-roots.service mc-agent-tool-read.socket mc-agent-tool-write.socket mc-agent-executor.socket mc-agent-host-broker.socket mc-agent-gateway.service
fi
if (( ENABLE_AGENT == 1 )); then verify_service_state "$service_state" installed-agent
else verify_service_state "$service_state" installed
fi
python3 "$journal_helper" --root "$JOURNAL_ROOT" finish committed
journal_started=0
release_successful_maintenance
trap - EXIT HUP INT TERM
rm -rf -- "$work"
printf 'Host release verified: %s\n' "$release_manifest_sha256"
