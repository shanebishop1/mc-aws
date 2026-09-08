#!/usr/bin/env bash
# Install or roll back immutable Node/Pi runtime releases. This script never resolves packages or secrets.
set -euo pipefail
umask 077

readonly ROOT=/opt/mc-agent
readonly RELEASES="$ROOT/releases"
readonly NODE_RELEASES="$ROOT/node-releases"
readonly MAX_NODE_ARCHIVE_BYTES=$((64 * 1024 * 1024))
readonly MAX_RUNTIME_ARCHIVE_BYTES=$((64 * 1024 * 1024))
readonly MAX_RUNTIME_EXPANDED_BYTES=$((128 * 1024 * 1024))
readonly NODE_VERSION=22.19.0
readonly RECEIPT_ROTATION_JOURNAL=/var/lib/mc-agent-executor/executor-receipt-rotation.json
readonly RECEIPT_ROTATION_BACKUP=/etc/mc-agent/.executor-receipt-private.retiring.pem
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-}"
MAINTENANCE_OWNER="${MC_MAINTENANCE_OWNER:-}"
MAINTENANCE_PARENT_OPERATION="${MC_MAINTENANCE_PARENT_OPERATION:-}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || fail "mc-agent install must run as root"
for command in cmp find flock install openssl python3 readlink sha256sum sleep stat systemctl; do command -v "$command" >/dev/null || fail "missing $command"; done
exec 9>/run/lock/mc-agent-install.lock
flock -n 9 || fail "another agent install is active"

assert_maintenance_fence() {
  [[ -z "$MAINTENANCE_OWNER" ]] && return 0
  [[ -n "$MAINTENANCE_LOCK" ]] || fail "runtime rollout maintenance fence path is missing"
  [[ -z "$MAINTENANCE_PARENT_OPERATION" || "$MAINTENANCE_PARENT_OPERATION" == "host-replacement" ]] ||
    fail "runtime rollout parent maintenance operation is unsupported"
  python3 - "$MAINTENANCE_LOCK" "$MAINTENANCE_OWNER" "$MAINTENANCE_PARENT_OPERATION" <<'PY'
import json, sys
path, owner, parent_operation = sys.argv[1:]
try:
    value = json.load(open(path, encoding="ascii"))
except (OSError, ValueError):
    raise SystemExit("runtime rollout maintenance fence is unavailable")
allowed = {"runtime-rollout"}
if parent_operation:
    allowed = {parent_operation}
if value.get("schemaVersion") != 1 or value.get("owner") != owner or value.get("operation") not in allowed:
    raise SystemExit("runtime rollout maintenance fence ownership changed")
PY
}
assert_maintenance_fence

validate_credential_source() {
  local source="$1"
  [[ -f "$source" && ! -L "$source" ]] || fail "backup-fence public credential source is not a regular file"
  [[ "$(stat -c '%U:%G' -- "$source")" == "root:root" ]] || fail "backup-fence public credential source owner is unsafe"
  case "$(stat -c '%a' -- "$source")" in
    400|444) ;;
    *) fail "backup-fence public credential source mode is unsafe" ;;
  esac
  openssl pkey -pubin -in "$source" -noout >/dev/null || fail "backup-fence public credential source is invalid"
}

install_backup_fence_public() {
  local source="${1:-}"
  if [[ -n "$source" ]]; then
    validate_credential_source "$source"
    if [[ -L /etc/mc-agent/backup-fence-public.pem ]]; then
      fail "backup-fence public credential is unsafe"
    elif [[ -e /etc/mc-agent/backup-fence-public.pem ]]; then
      cmp -s "$source" /etc/mc-agent/backup-fence-public.pem || fail "backup-fence public credential authority changed"
    else
      install -o root -g root -m 0444 "$source" /etc/mc-agent/backup-fence-public.pem
    fi
  fi
  if [[ ! -f /etc/mc-agent/backup-fence-public.pem || -L /etc/mc-agent/backup-fence-public.pem ]]; then
    [[ "${MC_AGENT_REQUIRE_BACKUP_FENCE:-0}" == "1" ]] || return 0
    fail "backup-fence public credential is missing"
  fi
  [[ "$(stat -c '%U:%G:%a' -- /etc/mc-agent/backup-fence-public.pem)" == "root:root:444" ]] || \
    fail "backup-fence public credential metadata is unsafe"
  openssl pkey -pubin -in /etc/mc-agent/backup-fence-public.pem -noout >/dev/null || \
    fail "backup-fence public credential is invalid"
}

ensure_host_layout() {
  assert_maintenance_fence
  local backup_fence_source="${1:-${MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_SOURCE:-}}"
  getent group mc-agent >/dev/null || groupadd --system mc-agent
  id mc-agent-gateway >/dev/null 2>&1 || useradd --system --gid mc-agent --home-dir /var/lib/mc-agent-gateway --shell /sbin/nologin mc-agent-gateway
  usermod -a -G mc-agent minecraft
  install -d -o root -g root -m 0755 "$ROOT" "$RELEASES" "$NODE_RELEASES"
  install -d -o root -g root -m 0755 "$ROOT/executor-root"/{workspace,scratch,runtime,config,usr/bin,usr/local/bin,usr/lib,usr/lib64,lib64,run/mc-agent-download,run/screen}
  install -d -o minecraft -g mc-agent -m 0700 /var/lib/mc-agent-executor
  install -d -o mc-agent-gateway -g mc-agent -m 0700 /var/lib/mc-agent-gateway /var/lib/mc-agent-gateway/{work,pi}
  install -d -o root -g root -m 0755 /run/mc-agent
  install -d -o mc-agent-gateway -g mc-agent -m 0750 /run/mc-agent-download
  install -d -o root -g root -m 0755 /etc/mc-agent
  if [[ ! -e /etc/mc-agent/executor-journal-hmac.key && ! -L /etc/mc-agent/executor-journal-hmac.key ]]; then
    [[ ! -e /var/lib/mc-agent-executor/executor-effect-journal.json && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json &&
       ! -e /var/lib/mc-agent-executor/executor-effect-journal.json.checkpoint.0 && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json.checkpoint.0 &&
       ! -e /var/lib/mc-agent-executor/executor-effect-journal.json.checkpoint.1 && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json.checkpoint.1 &&
       ! -e /var/lib/mc-agent-executor/executor-effect-journal.json.append.0 && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json.append.0 &&
       ! -e /var/lib/mc-agent-executor/executor-effect-journal.json.append.1 && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json.append.1 &&
       ! -e /var/lib/mc-agent-executor/executor-effect-journal.json.generation-floor && ! -L /var/lib/mc-agent-executor/executor-effect-journal.json.generation-floor &&
       ! -e /var/lib/mc-agent-gateway/executor-reconciliations.json && ! -L /var/lib/mc-agent-gateway/executor-reconciliations.json ]] || fail "executor journal key is missing while durable recovery state exists; restore the matching key"
    journal_key="$(mktemp /etc/mc-agent/.executor-journal-hmac.XXXXXX)"
    openssl rand 32 > "$journal_key" || { rm -f -- "$journal_key"; fail "executor journal key generation failed"; }
    install -o root -g root -m 0400 "$journal_key" /etc/mc-agent/executor-journal-hmac.key || { rm -f -- "$journal_key"; fail "executor journal key installation failed"; }
    rm -f -- "$journal_key"
  fi
  [[ -f /etc/mc-agent/executor-journal-hmac.key && ! -L /etc/mc-agent/executor-journal-hmac.key ]] || fail "executor journal key is unsafe"
  [[ "$(stat -c '%U:%G:%a:%s' -- /etc/mc-agent/executor-journal-hmac.key)" == "root:root:400:32" ]] || fail "executor journal key metadata is unsafe"
  if [[ ! -e /etc/mc-agent/executor-receipt-private.pem && ! -L /etc/mc-agent/executor-receipt-private.pem ]]; then
    receipt_key="$(mktemp /etc/mc-agent/.executor-receipt-private.XXXXXX)"
    openssl genpkey -algorithm ED25519 -out "$receipt_key" || { rm -f -- "$receipt_key"; fail "executor receipt key generation failed"; }
    install -o root -g root -m 0400 "$receipt_key" /etc/mc-agent/executor-receipt-private.pem || { rm -f -- "$receipt_key"; fail "executor receipt key installation failed"; }
    rm -f -- "$receipt_key"
  fi
  [[ -f /etc/mc-agent/executor-receipt-private.pem && ! -L /etc/mc-agent/executor-receipt-private.pem ]] || fail "executor receipt private key is unsafe"
  [[ "$(stat -c '%U:%G:%a' -- /etc/mc-agent/executor-receipt-private.pem)" == "root:root:400" ]] || fail "executor receipt private key metadata is unsafe"
  openssl pkey -in /etc/mc-agent/executor-receipt-private.pem -pubout -out /etc/mc-agent/.executor-receipt-public.pem
  openssl pkey -in /etc/mc-agent/executor-receipt-private.pem -pubout -outform DER \
    | sha256sum | { read -r receipt_key_digest _; printf 'executor-receipt-%s\n' "$receipt_key_digest"; } \
    > /etc/mc-agent/.executor-receipt-key-id
  openssl pkey -in /etc/mc-agent/executor-receipt-private.pem -pubout -outform DER \
    > /etc/mc-agent/.executor-receipt-public.spki
  if [[ ! -f /etc/mc-agent/executor-receipt-key-epoch ]]; then
    python3 -c 'import time; print(time.time_ns() // 1000)' > /etc/mc-agent/executor-receipt-key-epoch
    chown root:root /etc/mc-agent/executor-receipt-key-epoch
    chmod 0444 /etc/mc-agent/executor-receipt-key-epoch
  fi
  [[ "$(stat -c '%U:%G:%a' -- /etc/mc-agent/executor-receipt-key-epoch)" == "root:root:444" ]] || fail "executor receipt key epoch metadata is unsafe"
  python3 - /etc/mc-agent/.executor-receipt-key-id /etc/mc-agent/.executor-receipt-public.spki /etc/mc-agent/executor-receipt-key-epoch \
    > /etc/mc-agent/.executor-receipt-verifier.json <<'PY'
import base64, json, pathlib, sys
key_id = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip()
spki = base64.b64encode(pathlib.Path(sys.argv[2]).read_bytes()).decode("ascii")
epoch = int(pathlib.Path(sys.argv[3]).read_text(encoding="ascii").strip())
if epoch < 1:
    raise SystemExit("invalid receipt key epoch")
print(json.dumps({"schemaVersion": 1, "keyId": key_id, "publicKeySpki": spki, "keyEpoch": epoch}, separators=(",", ":")))
PY
  install -o root -g root -m 0444 /etc/mc-agent/.executor-receipt-public.pem /etc/mc-agent/executor-receipt-public.pem
  install -o root -g root -m 0444 /etc/mc-agent/.executor-receipt-key-id /etc/mc-agent/executor-receipt-key-id
  install -o root -g root -m 0444 /etc/mc-agent/.executor-receipt-verifier.json /etc/mc-agent/executor-receipt-verifier.json
  rm -f -- /etc/mc-agent/.executor-receipt-public.pem /etc/mc-agent/.executor-receipt-public.spki \
    /etc/mc-agent/.executor-receipt-key-id /etc/mc-agent/.executor-receipt-verifier.json
  if [[ ! -e /etc/mc-agent/executor-clean-start-epoch && ! -L /etc/mc-agent/executor-clean-start-epoch ]]; then
    epoch="$(mktemp /etc/mc-agent/.executor-clean-start-epoch.XXXXXX)"
    openssl rand 32 > "$epoch" || { rm -f -- "$epoch"; fail "executor clean-start epoch generation failed"; }
    install -o root -g root -m 0400 "$epoch" /etc/mc-agent/executor-clean-start-epoch || { rm -f -- "$epoch"; fail "executor clean-start epoch installation failed"; }
    rm -f -- "$epoch"
  fi
  [[ -f /etc/mc-agent/executor-clean-start-epoch && ! -L /etc/mc-agent/executor-clean-start-epoch ]] || fail "executor clean-start epoch is unsafe"
  [[ "$(stat -c '%U:%G:%a:%s' -- /etc/mc-agent/executor-clean-start-epoch)" == "root:root:400:32" ]] || fail "executor clean-start epoch metadata is unsafe"
  [[ -f /etc/mc-agent/gateway-private.pem ]] || {
    openssl genpkey -algorithm ED25519 -out /etc/mc-agent/gateway-private.pem
  }
  [[ -f /etc/mc-agent/gateway-private.pem && ! -L /etc/mc-agent/gateway-private.pem ]] || fail "gateway private key is unsafe"
  chown root:root /etc/mc-agent/gateway-private.pem
  chmod 0400 /etc/mc-agent/gateway-private.pem
  [[ "$(stat -c '%U:%G:%a' -- /etc/mc-agent/gateway-private.pem)" == "root:root:400" ]] || fail "gateway private key metadata is unsafe"
  openssl pkey -in /etc/mc-agent/gateway-private.pem -noout >/dev/null || fail "gateway private key is invalid"
  openssl pkey -in /etc/mc-agent/gateway-private.pem -pubout -out /etc/mc-agent/.gateway-public.pem
  mv -f /etc/mc-agent/.gateway-public.pem /etc/mc-agent/gateway-public.pem
  chown root:root /etc/mc-agent/gateway-private.pem /etc/mc-agent/gateway-public.pem
  chmod 0400 /etc/mc-agent/gateway-private.pem
  chmod 0444 /etc/mc-agent/gateway-public.pem
  install_backup_fence_public "$backup_fence_source"
  for credential in /etc/mc-agent/runtime-bearer /etc/mc-agent/provider-*; do
    [[ -e "$credential" ]] || continue
    [[ -f "$credential" && ! -L "$credential" ]] || fail "agent credential is unsafe"
    [[ "$(stat -c '%U:%G' -- "$credential")" == "root:root" ]] || fail "agent credential owner is unsafe"
    chmod 0400 "$credential"
  done
}

validate_file() {
  local file="$1" digest="$2" expected_bytes="$3" maximum="$4" label="$5"
  [[ -f "$file" && ! -L "$file" ]] || fail "$label is not a regular file"
  local bytes; bytes="$(stat -c '%s' -- "$file")"
  [[ "$expected_bytes" =~ ^[0-9]+$ ]] && (( expected_bytes > 0 && expected_bytes <= maximum )) || fail "$label expected size is invalid"
  [[ "$bytes" == "$expected_bytes" ]] || fail "$label size mismatch"
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || fail "$label digest is invalid"
  printf '%s  %s\n' "$digest" "$file" | sha256sum --check --status || fail "$label checksum mismatch"
}

install_node() {
  local archive="$1" digest="$2" release
  release="$NODE_RELEASES/$digest"
  [[ -d "$release" ]] && return
  local temporary; temporary="$(mktemp -d "$ROOT/.node.XXXXXX")"
  trap 'rm -rf -- "$temporary"' RETURN
  python3 - "$archive" "$temporary" "$NODE_VERSION" <<'PY'
import lzma, os, shutil, stat, sys, tarfile
archive, destination, version = sys.argv[1:]
member_name = f"node-v{version}-linux-arm64/bin/node"
with lzma.open(archive, "rb") as compressed, tarfile.open(fileobj=compressed, mode="r|") as source:
    found = False
    for member in source:
        if member.name != member_name:
            continue
        if not member.isfile() or member.size < 1 or member.size > 128 * 1024 * 1024:
            raise SystemExit("unsafe Node binary member")
        incoming = source.extractfile(member)
        if incoming is None:
            raise SystemExit("missing Node binary bytes")
        os.mkdir(os.path.join(destination, "bin"), 0o755)
        descriptor = os.open(os.path.join(destination, "bin", "node"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o755)
        with incoming, os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(incoming, output)
        found = True
        break
if not found:
    raise SystemExit("exact Node ARM64 binary member was not found")
PY
  "$temporary/bin/node" --version | grep -Fxq "v$NODE_VERSION" || fail "Node binary version mismatch"
  chown -R root:root "$temporary"; chmod 0755 "$temporary" "$temporary/bin" "$temporary/bin/node"
  mv -- "$temporary" "$release"
  trap - RETURN
}

install_runtime() {
  assert_maintenance_fence
  local archive="$1" digest="$2" manifest_digest="$3" release
  release="$RELEASES/$digest"
  if [[ -d "$release" ]]; then
    printf '%s  %s\n' "$manifest_digest" "$release/bundle-manifest.json" | sha256sum --check --status || fail "installed runtime manifest checksum mismatch"
    return
  fi
  local temporary; temporary="$(mktemp -d "$ROOT/.runtime.XXXXXX")"
  trap 'rm -rf -- "$temporary"' RETURN
  python3 - "$archive" "$temporary" "$MAX_RUNTIME_EXPANDED_BYTES" <<'PY'
import hashlib, json, os, shutil, stat, sys, zipfile
from pathlib import PurePosixPath
archive, destination, maximum = sys.argv[1], sys.argv[2], int(sys.argv[3])
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > 512 or sum(item.file_size for item in entries) > maximum:
        raise SystemExit("runtime archive limits exceeded")
    seen = set()
    for item in entries:
        path = PurePosixPath(item.filename)
        mode = item.external_attr >> 16
        if not item.filename or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or path.parts in seen:
            raise SystemExit("unsafe or duplicate runtime path")
        seen.add(path.parts)
        if item.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or item.file_size > 32 * 1024 * 1024:
            raise SystemExit("runtime contains a non-regular or oversized entry")
    for item in entries:
        target = os.path.join(destination, *PurePosixPath(item.filename).parts)
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with source.open(item) as incoming, os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(incoming, output)
manifest_path = os.path.join(destination, "bundle-manifest.json")
manifest = json.load(open(manifest_path, encoding="utf-8"))
if set(manifest) != {"schemaVersion", "nodeVersion", "piVersion", "files"} or manifest["schemaVersion"] != 1 or manifest["nodeVersion"] != "22.19.0" or manifest["piVersion"] != "0.84.4":
    raise SystemExit("runtime bundle manifest is invalid")
if not isinstance(manifest["files"], list) or len(manifest["files"]) != len(entries) - 1:
    raise SystemExit("runtime bundle file inventory is invalid")
expected = set()
for item in manifest["files"]:
    if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256", "mode"}:
        raise SystemExit("runtime bundle file record is invalid")
    if not isinstance(item["path"], str) or not isinstance(item["bytes"], int) or not isinstance(item["sha256"], str) or item["mode"] not in ("0644", "0755"):
        raise SystemExit("runtime bundle file record values are invalid")
    target = os.path.join(destination, *PurePosixPath(item["path"]).parts)
    if item["path"] in expected or not os.path.isfile(target) or os.path.islink(target) or os.path.getsize(target) != item["bytes"]:
        raise SystemExit("runtime bundle file inventory does not match extraction")
    with open(target, "rb") as source:
        if hashlib.sha256(source.read()).hexdigest() != item["sha256"]:
            raise SystemExit("runtime bundle member checksum mismatch")
    expected.add(item["path"])
actual = {item.filename for item in entries if item.filename != "bundle-manifest.json"}
if actual != expected:
    raise SystemExit("runtime bundle contains an unmanifested file")
PY
  printf '%s  %s\n' "$manifest_digest" "$temporary/bundle-manifest.json" | sha256sum --check --status || fail "runtime bundle manifest checksum mismatch"
  chown -R root:root "$temporary"
  find "$temporary" -type d -exec chmod 0755 {} +
  find "$temporary" -type f -exec chmod 0644 {} +
  chmod 0755 "$temporary/gateway-cli.mjs" "$temporary/executor-cli.mjs"
  mv -- "$temporary" "$release"
  trap - RETURN
}

activate() {
  assert_maintenance_fence
  local node_digest="$1" runtime_digest="$2"
  local old_node="" old_runtime=""
  [[ ! -L "$ROOT/node-current" ]] || old_node="$(readlink "$ROOT/node-current")"
  [[ ! -L "$ROOT/current" ]] || old_runtime="$(readlink "$ROOT/current")"
  [[ -f /usr/local/bin/mc-agent-world-roots.py && ! -L /usr/local/bin/mc-agent-world-roots.py ]] || \
    fail "installed world-root verifier is missing"
  install -o root -g root -m 0755 /usr/local/bin/mc-agent-world-roots.py \
    "$ROOT/executor-root/usr/local/bin/mc-agent-world-roots.py"
  /usr/local/bin/mc-agent-world-roots.py verify || fail "agent persistent world roots verification failed"
  if [[ "$old_node" == "node-releases/$node_digest" && "$old_runtime" == "releases/$runtime_digest" ]]; then
    return
  fi
  ln -sfn "node-releases/$node_digest" "$ROOT/.node-current"; mv -Tf "$ROOT/.node-current" "$ROOT/node-current"
  ln -sfn "releases/$runtime_digest" "$ROOT/.runtime-current"; mv -Tf "$ROOT/.runtime-current" "$ROOT/current"
  executor_active=0; gateway_active=0
  systemctl is-active --quiet mc-agent-executor.service && executor_active=1
  systemctl is-active --quiet mc-agent-gateway.service && gateway_active=1
  if (( executor_active == 1 || gateway_active == 1 )); then
    restart_failed=0
    systemctl try-restart mc-agent-executor.service mc-agent-gateway.service || restart_failed=1
    sleep 3
    if (( restart_failed == 1 )) ||
       { (( executor_active == 1 )) && ! systemctl is-active --quiet mc-agent-executor.service; } ||
       { (( gateway_active == 1 )) && ! systemctl is-active --quiet mc-agent-gateway.service; }; then
      if [[ -n "$old_node" ]]; then ln -sfn "$old_node" "$ROOT/.node-rollback"; mv -Tf "$ROOT/.node-rollback" "$ROOT/node-current"; else rm -f -- "$ROOT/node-current"; fi
      if [[ -n "$old_runtime" ]]; then ln -sfn "$old_runtime" "$ROOT/.runtime-rollback"; mv -Tf "$ROOT/.runtime-rollback" "$ROOT/current"; else rm -f -- "$ROOT/current"; fi
      /usr/local/bin/mc-agent-world-roots.py verify && systemctl try-restart mc-agent-executor.service mc-agent-gateway.service || true
      fail "agent service health check failed; previous release restored"
    fi
  fi
}

assert_agent_hard_stopped() {
  for unit in mc-agent-gateway.service mc-agent-executor.socket mc-agent-executor.service; do
    [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "inactive" ]] || \
      fail "$unit must be hard-stopped before clean-start epoch rotation"
    case "$(systemctl is-enabled "$unit" 2>/dev/null || true)" in
      masked|masked-runtime) ;;
      *) fail "$unit must be masked before clean-start epoch rotation" ;;
    esac
  done
}

rotate_clean_start_epoch() {
  [[ "${1:-}" == "ROTATE-EXECUTOR-CLEAN-START-EPOCH" ]] || \
    fail "exact clean-start epoch rotation confirmation is required"
  assert_agent_hard_stopped
  local epoch
  epoch="$(mktemp /etc/mc-agent/.executor-clean-start-epoch.XXXXXX)"
  openssl rand 32 > "$epoch" || { rm -f -- "$epoch"; fail "executor clean-start epoch rotation failed"; }
  install -o root -g root -m 0400 "$epoch" /etc/mc-agent/executor-clean-start-epoch
  rm -f -- "$epoch"
  printf '%s\n' 'Executor clean-start epoch rotated after a verified hard stop; services remain masked.'
}

write_receipt_rotation_journal() {
  local phase="$1" old_key_id="$2" old_epoch="$3" new_key_id="${4:-}"
  python3 - "$RECEIPT_ROTATION_JOURNAL" "$phase" "$old_key_id" "$old_epoch" "$new_key_id" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
path, phase, old_key_id, old_epoch, new_key_id = sys.argv[1:]
if phase not in ("prepared", "installed", "committed") or not old_key_id or not old_epoch.isdigit():
    raise SystemExit("receipt rotation journal identity is invalid")
record = {
    "schemaVersion": 1,
    "phase": phase,
    "oldKeyId": old_key_id,
    "oldEpoch": int(old_epoch),
    "newKeyId": new_key_id or None,
    "backupPath": "/etc/mc-agent/.executor-receipt-private.retiring.pem",
}
target = Path(path)
target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(target.parent, 0o700)
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent, text=True)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as output:
        json.dump(record, output, separators=(",", ":"), sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    descriptor = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

backup_receipt_private_key() {
  python3 - /etc/mc-agent/executor-receipt-private.pem "$RECEIPT_ROTATION_BACKUP" <<'PY'
import os, sys, tempfile
from pathlib import Path
source, target = map(Path, sys.argv[1:])
source_stat = source.lstat()
if not source.is_file() or source.is_symlink() or source_stat.st_nlink != 1 or source_stat.st_mode & 0o077:
    raise SystemExit("executor receipt private key is unsafe to back up")
temporary_fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(temporary_fd, 0o400)
    with os.fdopen(temporary_fd, "wb") as output, source.open("rb") as incoming:
        output.write(incoming.read())
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    os.chown(target, 0, 0)
    os.chmod(target, 0o400)
    descriptor = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
}

recover_receipt_key_rotation() {
  [[ -e "$RECEIPT_ROTATION_JOURNAL" ]] || return 0
  python3 - "$RECEIPT_ROTATION_JOURNAL" "$RECEIPT_ROTATION_BACKUP" \
    /etc/mc-agent/executor-receipt-private.pem /etc/mc-agent/executor-receipt-key-epoch <<'PY'
import json, os, stat, sys, tempfile
from pathlib import Path
journal_path, backup_path, private_path, epoch_path = map(Path, sys.argv[1:])
metadata = journal_path.lstat()
if not journal_path.is_file() or journal_path.is_symlink() or metadata.st_nlink != 1 or metadata.st_mode & 0o077:
    raise SystemExit("receipt rotation journal is unsafe")
record = json.loads(journal_path.read_text(encoding="ascii"))
if set(record) != {"backupPath", "newKeyId", "oldEpoch", "oldKeyId", "phase", "schemaVersion"} or record["schemaVersion"] != 1:
    raise SystemExit("receipt rotation journal schema is invalid")
if record["backupPath"] != str(backup_path) or record["phase"] not in ("prepared", "installed", "committed"):
    raise SystemExit("receipt rotation journal binding is invalid")
if record["phase"] == "committed":
    try:
        backup_path.unlink()
    except FileNotFoundError:
        pass
    journal_path.unlink()
else:
    backup = backup_path.lstat()
    if not backup_path.is_file() or backup_path.is_symlink() or backup.st_nlink != 1 or backup.st_mode & 0o077:
        raise SystemExit("receipt rotation backup is unavailable; refusing to lose the old key")
    temporary_fd, temporary = tempfile.mkstemp(prefix=f".{private_path.name}.", dir=private_path.parent)
    try:
        os.fchmod(temporary_fd, 0o400)
        with os.fdopen(temporary_fd, "wb") as output, backup_path.open("rb") as incoming:
            output.write(incoming.read())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, private_path)
        os.chown(private_path, 0, 0)
        os.chmod(private_path, 0o400)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    epoch_temporary = epoch_path.with_name(f".{epoch_path.name}.restore")
    epoch_temporary.write_text(f"{record['oldEpoch']}\n", encoding="ascii")
    os.chown(epoch_temporary, 0, 0)
    os.chmod(epoch_temporary, 0o444)
    with epoch_temporary.open("rb") as stream:
        os.fsync(stream.fileno())
    os.replace(epoch_temporary, epoch_path)
    backup_path.unlink()
    journal_path.unlink()
directory = os.open(journal_path.parent, os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

assert_no_local_receipt_references() {
  local key_id="$1" key_epoch="$2" references
  [[ -x /usr/local/bin/mc-host-operation.py ]] || fail "receipt reference verifier is missing"
  references="$(python3 /usr/local/bin/mc-host-operation.py executor-receipt-references \
    --key-id "$key_id" --key-epoch "$key_epoch")" || fail "could not verify durable receipt references"
  python3 - "$references" <<'PY'
import json, sys
value = json.loads(sys.argv[1])
if not isinstance(value, dict) or value.get("references") != []:
    raise SystemExit("durable executor/gateway receipt references remain")
PY
}

rotate_receipt_key() {
  [[ "${1:-}" == "ROTATE-EXECUTOR-RECEIPT-KEY" ]] || \
    fail "exact executor receipt key rotation confirmation is required"
  assert_agent_hard_stopped
  recover_receipt_key_rotation
  local receipt_key old_key_id old_epoch new_key_id
  old_key_id="$(< /etc/mc-agent/executor-receipt-key-id)"
  old_epoch="$(< /etc/mc-agent/executor-receipt-key-epoch)"
  [[ "$old_key_id" =~ ^executor-receipt-[a-f0-9]{64}$ ]] || fail "executor receipt key ID is invalid"
  [[ "$old_epoch" =~ ^[1-9][0-9]*$ ]] || fail "executor receipt key epoch is invalid"
  assert_no_local_receipt_references "$old_key_id" "$old_epoch"
  backup_receipt_private_key
  write_receipt_rotation_journal prepared "$old_key_id" "$old_epoch"
  receipt_key="$(mktemp /etc/mc-agent/.executor-receipt-private.XXXXXX)"
  openssl genpkey -algorithm ED25519 -out "$receipt_key" || \
    { rm -f -- "$receipt_key"; fail "executor receipt key rotation failed"; }
  python3 - "$receipt_key" /etc/mc-agent/executor-receipt-private.pem <<'PY'
import os, sys, tempfile
from pathlib import Path
source, target = map(Path, sys.argv[1:])
temporary_fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(temporary_fd, 0o400)
    with os.fdopen(temporary_fd, "wb") as output, source.open("rb") as incoming:
        output.write(incoming.read())
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    os.chown(target, 0, 0)
    os.chmod(target, 0o400)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
  rm -f -- "$receipt_key"
  local previous_epoch
  previous_epoch="$old_epoch"
  [[ "$previous_epoch" =~ ^[1-9][0-9]*$ ]] || fail "executor receipt key epoch is invalid"
  (( previous_epoch < 9007199254740991 )) || fail "executor receipt key epoch is exhausted"
  python3 - "$((previous_epoch + 1))" /etc/mc-agent/executor-receipt-key-epoch <<'PY'
import os, sys, tempfile
from pathlib import Path
value, target = sys.argv[1], Path(sys.argv[2])
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(fd, 0o444)
    with os.fdopen(fd, "w", encoding="ascii") as output:
        output.write(value + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, target)
    os.chown(target, 0, 0)
    os.chmod(target, 0o444)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
PY
  ensure_host_layout
  new_key_id="$(< /etc/mc-agent/executor-receipt-key-id)"
  write_receipt_rotation_journal installed "$old_key_id" "$old_epoch" "$new_key_id"
  write_receipt_rotation_journal committed "$old_key_id" "$old_epoch" "$new_key_id"
  recover_receipt_key_rotation
  cat /etc/mc-agent/executor-receipt-verifier.json
  printf '%s\n' 'Executor receipt key rotated; services remain masked until the verifier set is pinned and deployed.' >&2
}

case "${1:-}" in
  ensure-credentials)
    (( $# <= 2 )) || fail "Usage: mc-agent-install.sh ensure-credentials [backup-fence-public-source]"
    recover_receipt_key_rotation
    ensure_host_layout "${2:-}"
    exit 0
    ;;
esac

recover_receipt_key_rotation
ensure_host_layout
case "${1:-}" in
  install)
    (( $# == 8 )) || fail "Usage: mc-agent-install.sh install <node-archive> <node-sha256> <node-bytes> <runtime-archive> <runtime-sha256> <runtime-bytes> <bundle-manifest-sha256>"
    validate_file "$2" "$3" "$4" "$MAX_NODE_ARCHIVE_BYTES" "Node archive"
    validate_file "$5" "$6" "$7" "$MAX_RUNTIME_ARCHIVE_BYTES" "runtime archive"
    [[ "$8" =~ ^[a-f0-9]{64}$ ]] || fail "runtime bundle manifest digest is invalid"
    install_node "$2" "$3"
    install_runtime "$5" "$6" "$8"
    activate "$3" "$6"
    ;;
  install-runtime-only)
    (( $# == 5 )) || fail "Usage: mc-agent-install.sh install-runtime-only <runtime-archive> <runtime-sha256> <runtime-bytes> <bundle-manifest-sha256>"
    validate_file "$2" "$3" "$4" "$MAX_RUNTIME_ARCHIVE_BYTES" "runtime archive"
    [[ "$5" =~ ^[a-f0-9]{64}$ ]] || fail "runtime bundle manifest digest is invalid"
    current_node="$(readlink "$ROOT/node-current" 2>/dev/null || true)"
    [[ "$current_node" =~ ^node-releases/[a-f0-9]{64}$ ]] || fail "no verified Node release is active"
    install_runtime "$2" "$3" "$5"
    activate "${current_node#node-releases/}" "$3"
    ;;
rollback-transition)
    (( $# == 5 )) || fail "Usage: mc-agent-install.sh rollback-transition <expected-node> <expected-runtime> <prior-node|missing> <prior-runtime|missing>"
    expected_node="$2"; expected_runtime="$3"; old_node="$4"; old_runtime="$5"
    [[ "$expected_node" =~ ^node-releases/[a-f0-9]{64}$ && "$expected_runtime" =~ ^releases/[a-f0-9]{64}$ ]] || fail "expected runtime transition is invalid"
    [[ "$(readlink "$ROOT/node-current" 2>/dev/null || true)" == "$expected_node" && "$(readlink "$ROOT/current" 2>/dev/null || true)" == "$expected_runtime" ]] || fail "runtime transition no longer belongs to this rollback attempt"
    [[ "$old_node" == "missing" || "$old_node" =~ ^node-releases/[a-f0-9]{64}$ && -d "$ROOT/$old_node" ]] || fail "prior Node release is invalid"
    [[ "$old_runtime" == "missing" || "$old_runtime" =~ ^releases/[a-f0-9]{64}$ && -d "$ROOT/$old_runtime" ]] || fail "prior runtime release is invalid"
    /usr/local/bin/mc-agent-world-roots.py verify || fail "agent persistent world roots verification failed"
    if [[ "$old_node" == "missing" ]]; then rm -f -- "$ROOT/node-current"; else ln -sfn "$old_node" "$ROOT/.node-rollback"; mv -Tf "$ROOT/.node-rollback" "$ROOT/node-current"; fi
    if [[ "$old_runtime" == "missing" ]]; then rm -f -- "$ROOT/current"; else ln -sfn "$old_runtime" "$ROOT/.runtime-rollback"; mv -Tf "$ROOT/.runtime-rollback" "$ROOT/current"; fi
    ;;
  rotate-clean-start-epoch)
    (( $# == 3 )) && [[ "$2" == "--confirm-hard-stop" ]] || \
      fail "Usage: mc-agent-install.sh rotate-clean-start-epoch --confirm-hard-stop ROTATE-EXECUTOR-CLEAN-START-EPOCH"
    rotate_clean_start_epoch "$3"
    ;;
  rotate-receipt-key)
    (( $# == 3 )) && [[ "$2" == "--confirm-hard-stop" ]] || \
      fail "Usage: mc-agent-install.sh rotate-receipt-key --confirm-hard-stop ROTATE-EXECUTOR-RECEIPT-KEY"
    rotate_receipt_key "$3"
    ;;
  *) fail "Usage: mc-agent-install.sh <install|install-runtime-only|rollback-transition|rotate-clean-start-epoch|rotate-receipt-key> ..." ;;
esac
