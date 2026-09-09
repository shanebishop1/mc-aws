#!/usr/bin/env bash
# Install the content-addressed runtime/profile assets and explicitly apply the profile.
set -euo pipefail
umask 077

readonly MANIFEST_PARAMETER="/minecraft/server-profile-manifest"
readonly SETUP_ROOT="/opt/setup"
SERVER_ROOT="/opt/minecraft/server"
readonly MAX_ARCHIVE_FILES=2500
readonly MAX_ARCHIVE_BYTES=157286400
readonly MAX_PLUGIN_BYTES=$((32 * 1024 * 1024))

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

BOOTSTRAP=0
RESTORE_STAGING=0
RELEASE_ROOT=""
DEFER_SERVICES=0
ACTIVATE_QUIESCED=0
ENABLE_AGENT=0
ROLLBACK_FROM=""
EXPECTED_PROFILE_URI=""
EXPECTED_PROFILE_HASH=""
MANIFEST_FILE=""
EXPECTED_BOOTSTRAP_PINS_SHA256=""
GATEWAY_CREDENTIAL_SOURCE="${MC_AGENT_GATEWAY_CREDENTIAL_SOURCE:-}"
BACKUP_FENCE_PUBLIC_SOURCE="${MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_SOURCE:-}"
MAINTENANCE_BOOT_HOLD="${MC_MAINTENANCE_BOOT_HOLD:-/var/lib/mc-aws/maintenance-boot-hold.json}"
RELEASE_JOURNAL_ROOT="${MC_RELEASE_JOURNAL_ROOT:-}"
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-}"
MAINTENANCE_OWNER="${MC_MAINTENANCE_OWNER:-}"
MAINTENANCE_PARENT_OPERATION="${MC_MAINTENANCE_PARENT_OPERATION:-}"
WORLD_ROOTS_HELPER="${MC_WORLD_ROOTS_HELPER:-/usr/local/bin/mc-agent-world-roots.py}"
WORLD_ROOT_GENERATION_BEFORE=""
SERVER_PROPERTIES_TRANSACTION_STARTED=0
while (( $# > 0 )); do
  case "$1" in
    --bootstrap) BOOTSTRAP=1; shift ;;
    --release-root) (( $# >= 2 )) || fail "--release-root requires a directory"; RELEASE_ROOT="$2"; shift 2 ;;
    --defer-services) DEFER_SERVICES=1; shift ;;
    --activate-quiesced) ACTIVATE_QUIESCED=1; shift ;;
    --enable-agent) ENABLE_AGENT=1; shift ;;
    --gateway-credential-source) (( $# >= 2 )) || fail "--gateway-credential-source requires a directory"; GATEWAY_CREDENTIAL_SOURCE="$2"; shift 2 ;;
    --backup-fence-public-source) (( $# >= 2 )) || fail "--backup-fence-public-source requires a file"; BACKUP_FENCE_PUBLIC_SOURCE="$2"; shift 2 ;;
    --rollback-from) (( $# >= 2 )) || fail "--rollback-from requires a backup directory"; ROLLBACK_FROM="$2"; shift 2 ;;
    --expected-profile-uri) (( $# >= 2 )) || fail "--expected-profile-uri requires a URI"; EXPECTED_PROFILE_URI="$2"; shift 2 ;;
    --expected-profile-sha256) (( $# >= 2 )) || fail "--expected-profile-sha256 requires a digest"; EXPECTED_PROFILE_HASH="$2"; shift 2 ;;
    --manifest-file) (( $# >= 2 )) || fail "--manifest-file requires a file"; MANIFEST_FILE="$2"; shift 2 ;;
    --bootstrap-pins-sha256) (( $# >= 2 )) || fail "--bootstrap-pins-sha256 requires a digest"; EXPECTED_BOOTSTRAP_PINS_SHA256="$2"; shift 2 ;;
    --restore-staging) (( $# >= 2 )) || fail "--restore-staging requires a directory"; RESTORE_STAGING=1; SERVER_ROOT="$2"; shift 2 ;;
    *) fail "Usage: mc-profile-install.sh [--bootstrap] [--release-root <host-release>] [--bootstrap-pins-sha256 <digest>] [--defer-services|--activate-quiesced] [--enable-agent] [--gateway-credential-source <directory>] [--backup-fence-public-source <file>] [--expected-profile-uri <uri>] [--expected-profile-sha256 <digest>] [--manifest-file <file>] [--restore-staging <staged-server-root>]" ;;
  esac
done

(( DEFER_SERVICES + ACTIVATE_QUIESCED <= 1 )) || fail "deferred validation and quiesced activation are mutually exclusive"
(( RESTORE_STAGING == 0 || (DEFER_SERVICES == 0 && ACTIVATE_QUIESCED == 0 && BOOTSTRAP == 0) )) || \
  fail "restore staging cannot be combined with bootstrap or release activation modes"

[[ "$(id -u)" == "0" ]] || fail "must run as root"
for command in aws cmp python3 curl sha256sum install stat systemd-tmpfiles; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

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
replace_release_file() {
  local source="$1" destination="$2" mode="$3"
  assert_maintenance_fence
  [[ ! -d "$destination" ]] || fail "release destination unexpectedly became a directory: $destination"
  rm -f -- "$destination"
  install -o root -g root -m "$mode" "$source" "$destination"
}
install_persistent_guard_file() {
  local source="$1" destination="$2" mode="$3"
  if (( ACTIVATE_QUIESCED == 1 )); then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "persistent maintenance guard disappeared during activation"
    cmp -s "$source" "$destination" || fail "persistent maintenance guard changed during activation"
    [[ "$(stat -c '%U:%G:%a' "$destination")" == "root:root:$mode" ]] ||
      fail "persistent maintenance guard metadata changed during activation"
    return
  fi
  replace_release_file "$source" "$destination" "$mode"
}
assert_maintenance_fence
if (( RESTORE_STAGING == 1 )); then
  python3 - "$SERVER_ROOT" "${MC_RESTORE_STAGING_PARENT:-/opt}" <<'PY'
import os, pathlib, stat, sys
candidate, staging_parent = map(pathlib.Path, sys.argv[1:])
try:
    candidate_stat = candidate.lstat()
    resolved = candidate.resolve(strict=True)
    trusted = staging_parent.resolve(strict=True)
except OSError as error:
    raise SystemExit(f"restore staging root could not be resolved: {error}")
if not stat.S_ISDIR(candidate_stat.st_mode) or candidate.is_symlink() or candidate.name != "server":
    raise SystemExit("restore staging root must be a real staged server directory")
if resolved == pathlib.Path("/opt/minecraft/server") or trusted not in resolved.parents:
    raise SystemExit("restore staging root must remain beneath the trusted staging parent and outside the live server")
current = trusted
for part in resolved.relative_to(trusted).parts:
    current = current / part
    if current.is_symlink():
        raise SystemExit("restore staging root has a symlinked ancestor")
PY
fi
if (( ACTIVATE_QUIESCED == 1 )); then
  [[ -n "$MAINTENANCE_OWNER" && -n "$MAINTENANCE_LOCK" ]] || fail "quiesced activation requires an exact maintenance owner"
  for unit in minecraft.service minecraft-dns.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-gateway.service mc-agent-world-roots.service mc-agent-host-broker.socket mc-agent-host-broker.service; do
    [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == inactive ]] || fail "quiesced activation requires $unit to be inactive"
    [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" =~ ^masked(-runtime)?$ ]] || fail "quiesced activation requires $unit to be masked"
  done
fi

work="$(mktemp -d /opt/.mc-profile-install.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
signal_exit() { local status="$1"; trap - HUP INT TERM; exit "$status"; }
trap cleanup EXIT
trap 'signal_exit 129' HUP
trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM

restore_release_metadata() {
  for name in host-release-manifest.json runtime-hashes.sha256; do
    if [[ -f "$ROLLBACK_FROM/$name" && ! -L "$ROLLBACK_FROM/$name" ]]; then
      install -o root -g root -m 0644 "$ROLLBACK_FROM/$name" "/var/lib/mc-aws/$name"
    elif [[ -f "$ROLLBACK_FROM/$name.missing" && ! -L "$ROLLBACK_FROM/$name.missing" ]]; then
      rm -f -- "/var/lib/mc-aws/$name"
    else
      fail "host release rollback metadata evidence is incomplete: $name"
    fi
  done
}

restore_server_properties_transaction() {
  (( SERVER_PROPERTIES_TRANSACTION_STARTED == 1 )) || return 0
  local destination="$SERVER_ROOT/server.properties" temporary
  assert_maintenance_fence
  temporary="$work/.server.properties.rollback"
  if [[ -f "$previous_server_properties" && ! -L "$previous_server_properties" ]]; then
    install -o root -g root -m 0600 "$previous_server_properties" "$temporary"
    mv -Tf -- "$temporary" "$destination"
  elif [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  elif [[ -f "$destination" && ! -L "$destination" ]]; then
    rm -f -- "$destination"
  else
    fail "server.properties rollback target is unsafe"
  fi
}

restore_world_root_transaction() {
  [[ -n "$WORLD_ROOT_GENERATION_BEFORE" ]] || return 0
  [[ -x "$WORLD_ROOTS_HELPER" || -f "$WORLD_ROOTS_HELPER" ]] || fail "world-root rollback helper is missing"
  assert_maintenance_fence
  if [[ "$WORLD_ROOT_GENERATION_BEFORE" == missing ]]; then
    if [[ -L /etc/mc-agent/world-roots-current ]]; then
      rm -f -- /etc/mc-agent/world-roots-current
    elif [[ -e /etc/mc-agent/world-roots-current ]]; then
      fail "world-root generation rollback target is unsafe"
    fi
  else
    "$WORLD_ROOTS_HELPER" activate --generation "$WORLD_ROOT_GENERATION_BEFORE" ||
      fail "world-root generation rollback failed"
  fi
}

validate_release_metadata() {
  for name in host-release-manifest.json runtime-hashes.sha256; do
    [[ -f "$ROLLBACK_FROM/$name" && ! -L "$ROLLBACK_FROM/$name" ]] ||
      [[ -f "$ROLLBACK_FROM/$name.missing" && ! -L "$ROLLBACK_FROM/$name.missing" ]] ||
      fail "host release rollback metadata evidence is incomplete: $name"
  done
}

provision_gateway_credentials() {
  readarray -t gateway_credentials < <(python3 - "$runtime_release/host/mc-agent-gateway.json" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
names = value.get("providerCredentialNames")
if not isinstance(names, list) or any(not isinstance(name, str) or not re.fullmatch(r"provider-[a-z0-9][a-z0-9-]{0,62}", name) for name in names):
    raise SystemExit("gateway provider credential allowlist is invalid")
print("runtime-bearer")
for name in names:
    print(name)
PY
  )
  (( ${#gateway_credentials[@]} >= 1 )) || fail "gateway credential inventory is empty"
  python3 - "/etc/mc-agent" "${gateway_credentials[@]:1}" <<'PY'
import os, stat, sys
root, *providers = sys.argv[1:]
allowed = set(providers)
actual = {name for name in os.listdir(root) if name.startswith("provider-")}
if actual - allowed:
    raise SystemExit("gateway credential directory contains an unallowlisted provider credential")
for name in actual:
    path = os.path.join(root, name)
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o400:
        raise SystemExit("gateway provider credential metadata is unsafe")
PY
  (( ENABLE_AGENT == 1 )) || return 0
  [[ -n "$GATEWAY_CREDENTIAL_SOURCE" && -d "$GATEWAY_CREDENTIAL_SOURCE" && ! -L "$GATEWAY_CREDENTIAL_SOURCE" ]] || \
    fail "agent enablement requires an authoritative gateway credential source"
  [[ "$(stat -c '%U:%G:%a' -- "$GATEWAY_CREDENTIAL_SOURCE")" == "root:root:700" ]] || \
    fail "gateway credential source metadata is unsafe"
  python3 - "$GATEWAY_CREDENTIAL_SOURCE" "${gateway_credentials[@]}" <<'PY'
import os, stat, sys
source, *required = sys.argv[1:]
actual = sorted(os.listdir(source))
if actual != sorted(required):
    raise SystemExit("gateway credential source contains missing or extra credentials")
for name in required:
    path = os.path.join(source, name)
    mode = os.lstat(path)
    if not stat.S_ISREG(mode.st_mode) or mode.st_uid != 0 or mode.st_gid != 0 or stat.S_IMODE(mode.st_mode) != 0o400:
        raise SystemExit("gateway credential source member metadata is unsafe")
PY
  for name in "${gateway_credentials[@]}"; do
    install -o root -g root -m 0400 "$GATEWAY_CREDENTIAL_SOURCE/$name" "/etc/mc-agent/$name"
  done
  python3 - "/etc/mc-agent" "${gateway_credentials[@]}" <<'PY'
import os, stat, sys
root, *required = sys.argv[1:]
actual = {name for name in os.listdir(root) if name == "runtime-bearer" or name.startswith("provider-")}
if actual != set(required):
    raise SystemExit("installed gateway credentials do not exactly match the service allowlist")
for name in required:
    metadata = os.lstat(os.path.join(root, name))
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o400:
        raise SystemExit("installed gateway credential metadata is unsafe")
PY
}

provision_executor_credentials() {
  local installer="$runtime_release/host/mc-agent-install.sh"
  [[ -f "$installer" && ! -L "$installer" ]] || fail "release executor credential installer is missing"
  chmod 0755 "$installer"
  MC_AGENT_REQUIRE_BACKUP_FENCE="$ENABLE_AGENT" \
  MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_SOURCE="$BACKUP_FENCE_PUBLIC_SOURCE" \
    bash "$installer" ensure-credentials "$BACKUP_FENCE_PUBLIC_SOURCE"
  provision_gateway_credentials
}

if [[ -n "$ROLLBACK_FROM" ]]; then
  [[ -d "$ROLLBACK_FROM" && ! -L "$ROLLBACK_FROM" &&
    -f "$ROLLBACK_FROM/release-manifest.json" && ! -L "$ROLLBACK_FROM/release-manifest.json" &&
    -d "$ROLLBACK_FROM/release-members" && ! -L "$ROLLBACK_FROM/release-members" ]] ||
    fail "host release rollback evidence is missing"
  validate_release_metadata
  python3 - "$ROLLBACK_FROM/release-manifest.json" "$ROLLBACK_FROM/release-members" <<'PY'
import json, os, shutil, sys
manifest, inventory = sys.argv[1:]
items = json.load(open(manifest, encoding="utf-8"))["files"]
expected = set()
for index, item in enumerate(items):
    saved = os.path.join(inventory, str(index))
    if os.path.isfile(saved) and not os.path.islink(saved):
        expected.add(str(index))
    elif os.path.isfile(saved + ".missing"):
        expected.add(f"{index}.missing")
    else:
        raise SystemExit("host release rollback evidence is incomplete")
if set(os.listdir(inventory)) != expected:
    raise SystemExit("host release rollback inventory contains unexpected entries")
for index, item in enumerate(items):
    target, saved = item["destination"], os.path.join(inventory, str(index))
    if os.path.isfile(saved) and not os.path.islink(saved):
        os.makedirs(os.path.dirname(target), exist_ok=True); shutil.copy2(saved, target)
    else:
        try: os.unlink(target)
        except FileNotFoundError: pass
PY
  restore_release_metadata
  exit 0
fi

manifest="$work/manifest.json"
if [[ -n "$MANIFEST_FILE" ]]; then
  [[ -f "$MANIFEST_FILE" && ! -L "$MANIFEST_FILE" ]] || fail "asset manifest snapshot is not a regular file"
  install -o root -g root -m 0600 "$MANIFEST_FILE" "$manifest"
else
  aws ssm get-parameter --name "$MANIFEST_PARAMETER" --query Parameter.Value --output text > "$manifest"
fi

readarray -t fields < <(python3 - "$manifest" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
if set(value) != {"version", "hostRelease", "profile"} or value["version"] != 3:
    raise SystemExit("invalid asset manifest schema")
for kind in ("hostRelease", "profile"):
    item = value[kind]
    expected_keys = {"uri", "sha256", "bytes", "releaseManifestSha256", "releaseManifestBytes"} if kind == "hostRelease" else {"uri", "sha256", "fileCount", "totalBytes", "plugins"}
    if not isinstance(item, dict) or set(item) != expected_keys:
        raise SystemExit(f"invalid {kind} asset manifest")
    if not isinstance(item["uri"], str) or not re.fullmatch(r"s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9!_.*'()/-]+", item["uri"]):
        raise SystemExit(f"invalid {kind} S3 URI")
    if not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
        raise SystemExit(f"invalid {kind} archive checksum")
    if kind == "hostRelease" and (not isinstance(item["bytes"], int) or item["bytes"] < 1 or item["bytes"] > 67108864 or not isinstance(item["releaseManifestSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["releaseManifestSha256"]) or not isinstance(item["releaseManifestBytes"], int) or item["releaseManifestBytes"] < 1):
        raise SystemExit("invalid host release immutable metadata")
    if kind == "profile" and (not isinstance(item["fileCount"], int) or item["fileCount"] < 1 or not isinstance(item["totalBytes"], int) or item["totalBytes"] < 1 or not isinstance(item["plugins"], list)):
        raise SystemExit("invalid profile immutable metadata")
    print(item["uri"])
    print(item["sha256"])
    if kind == "hostRelease":
        print(item["bytes"])
        print(item["releaseManifestSha256"])
        print(item["releaseManifestBytes"])
PY
)
(( ${#fields[@]} == 7 )) || fail "asset manifest validation failed"
release_uri="${fields[0]}"; release_hash="${fields[1]}"; release_bytes="${fields[2]}"
release_manifest_hash="${fields[3]}"; release_manifest_bytes="${fields[4]}"
profile_uri="${fields[5]}"; profile_hash="${fields[6]}"
if [[ -n "$EXPECTED_PROFILE_URI" || -n "$EXPECTED_PROFILE_HASH" ]]; then
  [[ "$profile_uri" == "$EXPECTED_PROFILE_URI" && "$profile_hash" == "$EXPECTED_PROFILE_HASH" ]] || fail "profile asset manifest changed during rollout"
fi

download_and_extract() {
  local kind="$1" uri="$2" expected_hash="$3" archive="$work/$1.zip" destination="$work/$1"
  aws s3 cp --only-show-errors "$uri" "$archive"
  printf '%s  %s\n' "$expected_hash" "$archive" | sha256sum --check --status || fail "$kind asset archive checksum mismatch"
  mkdir -p -- "$destination"
  python3 - "$archive" "$destination" "$MAX_ARCHIVE_FILES" "$MAX_ARCHIVE_BYTES" <<'PY'
import os, shutil, stat, sys, zipfile
from pathlib import Path, PurePosixPath

archive_path, destination = Path(sys.argv[1]), Path(sys.argv[2])
max_files, max_bytes = int(sys.argv[3]), int(sys.argv[4])
try:
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if not entries:
            raise ValueError("archive is empty")
        files = total = 0
        seen = set()
        for entry in entries:
            name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
            path = PurePosixPath(name)
            parts = path.parts
            if not name or path.is_absolute() or any(part in ("", ".", "..") for part in parts):
                raise ValueError("unsafe archive path")
            if parts in seen:
                raise ValueError("duplicate archive path")
            seen.add(parts)
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            is_directory = entry.is_dir()
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (is_directory and kind == stat.S_IFREG):
                raise ValueError("symlink or special archive entry")
            if not is_directory:
                files += 1
                total += entry.file_size
                if entry.file_size > 32 * 1024 * 1024:
                    raise ValueError("archive member too large")
        if files > max_files or total > max_bytes:
            raise ValueError("archive limits exceeded")
        if total > shutil.disk_usage(destination).free - 64 * 1024 * 1024:
            raise ValueError("insufficient extraction space")
        for entry in entries:
            name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
            target = destination.joinpath(*PurePosixPath(name).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(target, flags, 0o600)
            with archive.open(entry) as source, os.fdopen(descriptor, "wb") as output:
                shutil.copyfileobj(source, output)
except (OSError, ValueError, zipfile.BadZipFile) as error:
    print(f"asset archive rejected: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

if [[ -n "$RELEASE_ROOT" ]]; then
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || fail "host release root is not a real directory"
else
  aws s3 cp --only-show-errors "$release_uri" "$work/host-release.zip"
  [[ "$(stat -c '%s' -- "$work/host-release.zip")" == "$release_bytes" ]] || fail "host release size mismatch"
  printf '%s  %s\n' "$release_hash" "$work/host-release.zip" | sha256sum --check --status || fail "host release checksum mismatch"
  RELEASE_ROOT="$work/host-release"
  mkdir "$RELEASE_ROOT"
  python3 - "$work/host-release.zip" "$RELEASE_ROOT" "$release_manifest_hash" "$release_manifest_bytes" <<'PY'
import hashlib, os, stat, sys, zipfile
from pathlib import PurePosixPath
archive, destination, manifest_hash, manifest_bytes = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > 128:
        raise SystemExit("host release archive limits exceeded")
    for entry in entries:
        path = PurePosixPath(entry.filename)
        mode = entry.external_attr >> 16
        if not path.parts or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or stat.S_IFMT(mode) != stat.S_IFREG:
            raise SystemExit("unsafe host release archive entry")
        target = os.path.join(destination, *path.parts)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with source.open(entry) as incoming, os.fdopen(descriptor, "wb") as output:
            output.write(incoming.read())
manifest = os.path.join(destination, "release-manifest.json")
data = open(manifest, "rb").read()
if len(data) != int(manifest_bytes) or hashlib.sha256(data).hexdigest() != manifest_hash:
    raise SystemExit("host release manifest digest or size mismatch")
PY
fi
[[ -f "$RELEASE_ROOT/release-manifest.json" && ! -L "$RELEASE_ROOT/release-manifest.json" ]] || fail "host release manifest is missing"
[[ "$(stat -c '%s' -- "$RELEASE_ROOT/release-manifest.json")" == "$release_manifest_bytes" ]] || fail "host release manifest size mismatch"
printf '%s  %s\n' "$release_manifest_hash" "$RELEASE_ROOT/release-manifest.json" | sha256sum --check --status || fail "host release manifest checksum mismatch"
if [[ -n "$EXPECTED_BOOTSTRAP_PINS_SHA256" ]]; then
  python3 - "$RELEASE_ROOT/release-manifest.json" "$EXPECTED_BOOTSTRAP_PINS_SHA256" <<'PY'
import json, re, sys
value=json.load(open(sys.argv[1], encoding="utf-8")); bootstrap=value.get("bootstrapPins")
if not isinstance(bootstrap,dict) or set(bootstrap) != {"manifest","sha256"} or bootstrap["sha256"] != sys.argv[2]: raise SystemExit("host release bootstrap pins do not match reviewed pins")
pins=bootstrap["manifest"]
if not isinstance(pins,dict) or set(pins) != {"schemaVersion","reviewedAt","artifacts"} or pins["schemaVersion"] != 1: raise SystemExit("invalid host release bootstrap pin manifest")
artifacts=pins["artifacts"]; required={"paper","rclone","nodeArm64","mcstatus","asyncioDgram","dnspython"}
if not isinstance(artifacts,dict) or set(artifacts) != required: raise SystemExit("host release bootstrap artifact inventory does not match reviewed pins")
for name, artifact in artifacts.items():
    expected={"version","url","sha256","checksumSource"} | ({"minecraftVersion","build"} if name == "paper" else set())
    if not isinstance(artifact,dict) or set(artifact) != expected or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?",artifact["version"]) or not re.fullmatch(r"[a-f0-9]{64}",artifact["sha256"]): raise SystemExit(f"invalid host release bootstrap artifact: {name}")
paper=artifacts["paper"]
if paper["version"] != paper["minecraftVersion"] or not isinstance(paper["build"],int) or paper["build"] <= 0 or f"/objects/{paper['sha256']}/paper-{paper['minecraftVersion']}-{paper['build']}.jar" not in paper["url"]: raise SystemExit("MC_VERSION and Paper bootstrap pin do not match")
PY
fi
download_and_extract profile "$profile_uri" "$profile_hash"
python3 - "$manifest" "$work/profile" <<'PY'
import json, os, pathlib, stat, sys
manifest, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
expected = json.load(manifest.open(encoding="utf-8"))["profile"]
files = []
for current, directories, names in os.walk(root, followlinks=False):
    for name in directories + names:
        mode = os.lstat(pathlib.Path(current) / name).st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise SystemExit("profile archive contains a non-regular entry")
    files.extend(pathlib.Path(current) / name for name in names)
if len(files) != expected["fileCount"] or sum(item.stat().st_size for item in files) != expected["totalBytes"]:
    raise SystemExit("profile archive count or expanded byte evidence mismatch")
lock = root / "plugins.lock.json"
plugins = json.load(lock.open(encoding="utf-8"))["plugins"] if lock.is_file() else []
if plugins != expected["plugins"]:
    raise SystemExit("profile plugin inventory does not match published evidence")
PY
if (( DEFER_SERVICES == 1 )); then
  # Continue through profile/plugin validation and pinned downloads, but route
  # every destination into this invocation's private candidate tree.
  SERVER_ROOT="$work/deferred-candidate/server"
  install -d -o minecraft -g minecraft -m 0755 "$SERVER_ROOT"
  RESTORE_STAGING=1
fi
runtime_release="$SETUP_ROOT/host-release-$release_hash"
profile_release="$SETUP_ROOT/profile-$profile_hash"

# Existing-host activation owns one durable attempt journal. Extend its initial
# snapshot with every path this profile/release can mutate before making the
# first host change. Restore staging intentionally does not enter this path.
if [[ -n "$RELEASE_JOURNAL_ROOT" && "$RESTORE_STAGING" == 0 ]]; then
  assert_maintenance_fence
  journal_helper="$RELEASE_ROOT/host/mc-release-journal.py"
  [[ -x "$journal_helper" || -f "$journal_helper" ]] || fail "release journal helper is missing"
  journal_paths="$work/release-journal-paths.json"
  python3 - "$runtime_release" "$profile_release" "$RELEASE_ROOT/release-manifest.json" "$work/profile" "$SERVER_ROOT" > "$journal_paths" <<'PY'
import json, os, pathlib, sys
runtime_release, profile_release, manifest_path, profile_root, server_root = sys.argv[1:]
paths = {
    "/opt/mc-agent/agent-runtime.zip",
    "/opt/mc-agent/current",
    "/opt/mc-agent/node-current",
    "/opt/mc-agent/node-previous",
    "/opt/mc-agent/runtime-previous",
    "/var/lib/mc-aws/host-release-manifest.json",
    "/var/lib/mc-aws/runtime-hashes.sha256",
    "/etc/mc-agent/world-roots-current",
    "/etc/mc-agent/world-roots-generations",
}
for item in json.load(open(manifest_path, encoding="utf-8"))["files"]:
    paths.add(item["destination"])
profile = pathlib.Path(profile_root)
server = pathlib.Path(server_root)
paths.add(str(server))
paths.add(str(server / "server.properties"))
for current, directories, files in os.walk(profile, followlinks=False):
    relative = pathlib.Path(current).relative_to(profile)
    for name in files:
        if relative == pathlib.Path(".") and name in {"plugins.lock.json", "rclone.conf"}:
            continue
        target = server / relative / name
        paths.add(str(target))
        paths.add(str(target.parent / f".{name}.mc-profile.tmp"))
        parent = target.parent
        while parent != server and server in parent.parents:
            paths.add(str(parent)); parent = parent.parent
lock = profile / "plugins.lock.json"
if lock.is_file():
    for plugin in json.load(open(lock, encoding="utf-8"))["plugins"]:
        paths.add(str(server / "plugins" / plugin["destination"]))
        paths.add(str(server / "plugins" / f'.{plugin["destination"]}.mc-profile.tmp'))
    paths.add(str(server / "plugins"))
print(json.dumps(sorted(paths), separators=(",", ":")))
PY
   python3 "$journal_helper" --root "$RELEASE_JOURNAL_ROOT" capture \
     --recursive /opt/setup --recursive /etc/mc-agent --recursive "$SERVER_ROOT/plugins" \
    --path /opt/setup --path /etc/mc-agent --paths-file "$journal_paths"
fi

assert_maintenance_fence
if (( RESTORE_STAGING == 0 )); then
  install -d -o root -g root -m 0755 "$SETUP_ROOT"
[[ -e "$runtime_release" ]] || cp -aT -- "$RELEASE_ROOT" "$runtime_release"
[[ -e "$profile_release" ]] || mv -- "$work/profile" "$profile_release"
chown -R root:root "$runtime_release" "$profile_release"
find "$runtime_release" "$profile_release" -type d -exec chmod 0755 {} +
find "$runtime_release" "$profile_release" -type f -exec chmod 0644 {} +
chmod 0755 "$runtime_release/host"/*.sh "$runtime_release/host"/*.py

# Config files are release members too.  Stage them under the transaction's
# private directory before any /etc destination is inspected; reconciliation
# below is the only operation that creates the final destinations.
config_stage="$work/config-stage"
install -d -o root -g root -m 0700 "$config_stage"
install -o root -g root -m 0644 "$runtime_release/host/mc-agent-gateway.json" "$config_stage/gateway.json"
install -o root -g root -m 0644 "$runtime_release/host/mc-agent-executor.json" "$config_stage/executor.json"

# Credentials are established before service/config validation.  This makes a
# missing or extra executor credential a deterministic install failure rather
# than a service-start failure after a partial release activation.
provision_executor_credentials

# Validate the complete release inventory before exposing even one member.  A
# missing, stale, or extra member is an old-host mismatch and is intentionally
# not repaired by mixing files from a previous release.
python3 - "$runtime_release/release-manifest.json" "$runtime_release" <<'PY'
import hashlib, json, os, stat, sys
manifest_path, root = sys.argv[1:]
value = json.load(open(manifest_path, encoding="utf-8"))
if set(value) != {"schemaVersion", "release", "releaseVersion", "bootstrapPins", "files", "agentRuntime"} or value["schemaVersion"] != 1 or value["release"] != "mc-aws-host-runtime" or value["releaseVersion"] != 1:
    raise SystemExit("invalid host release manifest")
if not isinstance(value["files"], list) or not value["files"]:
    raise SystemExit("host release inventory is empty")
seen = set()
config_destinations = {
    "/etc/mc-agent/world-roots-current/gateway.json",
    "/etc/mc-agent/world-roots-current/executor.json",
}
for item in value["files"]:
    if not isinstance(item, dict) or set(item) != {"path", "destination", "bytes", "sha256", "mode"}:
        raise SystemExit("invalid host release member record")
    path = item["path"]
    if path in seen or not path.startswith("host/") or ".." in path.split("/") or not isinstance(item["destination"], str) or not isinstance(item["bytes"], int) or not isinstance(item["sha256"], str) or item["mode"] not in ("0644", "0755"):
        raise SystemExit("invalid host release member")
    seen.add(path)
    target = os.path.join(root, *path.split("/"))
    # The two config members are intentionally transformed by root
    # reconciliation. Their immutable release bytes were already checked in
    # the staged release tree; their /etc destinations are created later.
    if item["destination"] in config_destinations:
        continue
    if not os.path.isfile(target) or os.path.islink(target) or os.path.getsize(target) != item["bytes"] or hashlib.sha256(open(target, "rb").read()).hexdigest() != item["sha256"]:
        raise SystemExit("host release member digest or size mismatch")
actual = {os.path.join("host", name) for name in os.listdir(os.path.join(root, "host"))}
if actual != seen:
    raise SystemExit("host release contains an omitted or unmanifested script")
agent = value["agentRuntime"]
if set(agent) != {"path", "bytes", "sha256", "bundleManifestSha256", "bundleManifestBytes"} or agent["path"] != "agent-runtime.zip":
    raise SystemExit("invalid agent runtime release member")
agent_path = os.path.join(root, agent["path"])
if not os.path.isfile(agent_path) or os.path.getsize(agent_path) != agent["bytes"] or hashlib.sha256(open(agent_path, "rb").read()).hexdigest() != agent["sha256"]:
    raise SystemExit("agent runtime release member digest or size mismatch")
PY

release_rollback="${MC_RELEASE_ROLLBACK_DIR:-$work/release-rollback}"
release_members="$release_rollback/release-members"
mkdir -p "$release_members"
for name in host-release-manifest.json runtime-hashes.sha256; do
  if [[ -f "/var/lib/mc-aws/$name" && ! -L "/var/lib/mc-aws/$name" ]]; then
    install -o root -g root -m 0644 "/var/lib/mc-aws/$name" "$release_rollback/$name"
  else
    : > "$release_rollback/$name.missing"
  fi
done
install -o root -g root -m 0644 "$runtime_release/release-manifest.json" "$release_rollback/release-manifest.json"
python3 - "$runtime_release/release-manifest.json" "$release_members" <<'PY'
import json, os, shutil, sys
manifest, inventory = sys.argv[1:]
items = json.load(open(manifest, encoding="utf-8"))["files"]
expected = set()
for index, item in enumerate(items):
    target = item["destination"]
    marker = os.path.join(inventory, str(index))
    if os.path.isfile(target) and not os.path.islink(target):
        shutil.copy2(target, marker)
        expected.add(str(index))
    else:
        open(marker + ".missing", "wb").close()
        expected.add(f"{index}.missing")
if set(os.listdir(inventory)) != expected or len(expected) != len(items):
    raise SystemExit("host release rollback inventory is incomplete")
PY
release_install_started=1
agent_runtime_before="$(readlink /opt/mc-agent/current 2>/dev/null || true)"
rollback_release() {
  status=$?
  if (( status != 0 && release_install_started == 1 )); then
    if [[ "$(readlink /opt/mc-agent/current 2>/dev/null || true)" != "$agent_runtime_before" ]]; then
      if [[ -n "$agent_runtime_before" ]]; then
        ln -sfn "$agent_runtime_before" /opt/mc-agent/.runtime-rollback && mv -Tf /opt/mc-agent/.runtime-rollback /opt/mc-agent/current
      else
        rm -f -- /opt/mc-agent/current
      fi
    fi
    python3 - "$release_rollback/release-manifest.json" "$release_rollback/release-members" <<'PY' || true
import json, os, shutil, sys
manifest, inventory = sys.argv[1:]
items = json.load(open(manifest, encoding="utf-8"))["files"]
expected = set()
for index, item in enumerate(items):
    saved = os.path.join(inventory, str(index))
    if os.path.isfile(saved) and not os.path.islink(saved):
        expected.add(str(index))
    elif os.path.isfile(saved + ".missing"):
        expected.add(f"{index}.missing")
    else:
        raise SystemExit("host release rollback evidence is incomplete")
if set(os.listdir(inventory)) != expected or len(expected) != len(items):
    raise SystemExit("host release rollback inventory is incomplete")
for index, item in enumerate(items):
    target, saved = item["destination"], os.path.join(inventory, str(index))
    if os.path.isfile(saved) and not os.path.islink(saved):
        os.makedirs(os.path.dirname(target), exist_ok=True); shutil.copy2(saved, target)
    else:
        try: os.unlink(target)
        except FileNotFoundError: pass
PY
    restore_server_properties_transaction || true
    restore_world_root_transaction || true
    ROLLBACK_FROM="$release_rollback" restore_release_metadata
    log "Host release activation failed; every cooperating member was rolled back and lifecycle remains quiesced"
  fi
  cleanup
  exit "$status"
}
trap rollback_release EXIT

was_active=0
if (( BOOTSTRAP == 0 && RESTORE_STAGING == 0 )) && systemctl is-active --quiet minecraft.service; then was_active=1; fi
if (( RESTORE_STAGING == 0 && DEFER_SERVICES == 0 && BOOTSTRAP == 0 )); then
  # Quiesce every activation path before replacing any cooperating script,
  # unit, socket, config, or authentication helper.
  systemctl mask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service
  systemctl stop mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service
fi

MC_AGENT_ENABLE="$ENABLE_AGENT" python3 - "$config_stage/gateway.json" "$runtime_release/host/mc-agent-gateway.service" "$config_stage/executor.json" "$runtime_release/host/mc-agent-executor.service" <<'PY'
import json, os, re, sys
config_path, service_path, executor_config_path, executor_service_path = sys.argv[1:]
with open(config_path, encoding="utf-8") as source:
    config = json.load(source)
with open(service_path, encoding="utf-8") as source:
    unit = source.read()
allowed = config.get("providerCredentialNames")
profiles = config.get("profiles")
extensions = config.get("extensions", {"enabled": False, "bundlePaths": []})
pattern = re.compile(r"^provider-[a-z0-9][a-z0-9-]{0,62}$")
extension_pattern = re.compile(r"^extensions/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/extension[.]json$")
forbidden = re.compile(r"(?:^|-)(?:runtime-bearer|signing-key|private-key|public-key)(?:-|$)")
if not isinstance(allowed, list) or not isinstance(profiles, list) or len(allowed) > 32:
    raise SystemExit("invalid provider credential allowlist")
if len(set(allowed)) != len(allowed) or any(not isinstance(name, str) or not pattern.fullmatch(name) or forbidden.search(name) for name in allowed):
    raise SystemExit("unsafe provider credential name")
used = [profile.get("credentialName") for profile in profiles if isinstance(profile, dict)]
if len(used) != len(profiles) or set(used) != set(allowed):
    raise SystemExit("provider profiles do not exactly match the credential allowlist")
if (not isinstance(extensions, dict) or set(extensions) != {"enabled", "bundlePaths"} or
        not isinstance(extensions["enabled"], bool) or not isinstance(extensions["bundlePaths"], list) or
        len(extensions["bundlePaths"]) > 8 or
        (extensions["enabled"] and len(extensions["bundlePaths"]) == 0) or
        len(set(extensions["bundlePaths"])) != len(extensions["bundlePaths"]) or
        any(not isinstance(item, str) or not extension_pattern.fullmatch(item) or ".." in item for item in extensions["bundlePaths"])):
    raise SystemExit("extension bundle configuration is invalid")
if os.environ.get("MC_AGENT_ENABLE", "0") == "1" and re.search(r"replace-with|\.invalid|placeholder|example\.com", open(config_path, encoding="utf-8").read(), re.I):
    raise SystemExit("enabled gateway configuration contains a packaged placeholder")
loaded = set(re.findall(r"^LoadCredential=([^:]+):", unit, re.MULTILINE))
if loaded != {"runtime-bearer", "gateway-private-key", *allowed}:
    raise SystemExit("gateway service credentials do not match its provider allowlist")
with open(executor_config_path, encoding="utf-8") as source:
    executor_config = json.load(source)
with open(executor_service_path, encoding="utf-8") as source:
    executor_unit = source.read()
if executor_config.get("journalCredentialName") != "executor-journal-hmac" or executor_config.get("receiptCredentialName") != "executor-receipt-private" or executor_config.get("cleanStartEpochCredentialName") != "executor-clean-start-epoch" or executor_config.get("backupFencePublicKeyPath") != "/config/backup-fence-public.pem" or executor_config.get("shellReadSocketPath") != "/run/mc-agent/shell-read.sock" or executor_config.get("shellWriteSocketPath") != "/run/mc-agent/shell-write.sock" or executor_config.get("hostBrokerSocketPath") != "/run/mc-agent/host-broker.sock":
    raise SystemExit("executor credential requirements are invalid")
executor_loaded = set(re.findall(r"^LoadCredential=([^:]+):", executor_unit, re.MULTILINE))
if executor_loaded != {"executor-journal-hmac", "executor-receipt-private", "executor-clean-start-epoch"}:
    raise SystemExit("executor service credentials do not match its exact requirements")
if "BindReadOnlyPaths=/etc/mc-agent/backup-fence-public.pem:/config/backup-fence-public.pem" not in executor_unit:
    raise SystemExit("executor service backup-fence public credential is not pinned")
PY

assert_maintenance_fence
ln -sfn "$(basename -- "$runtime_release")/host" "$SETUP_ROOT/.runtime-current"
mv -Tf -- "$SETUP_ROOT/.runtime-current" "$SETUP_ROOT/runtime"
ln -sfn "$(basename -- "$profile_release")" "$SETUP_ROOT/.profile-current"
mv -Tf -- "$SETUP_ROOT/.profile-current" "$SETUP_ROOT/profile"

for script in check-mc-idle.sh mc-rclone-config.sh mc-backup.sh mc-restore.sh mc-hibernate.sh mc-resume.sh mc-wait-ready.sh mc-runtime-rollout.sh update-dns.sh mc-profile-install.sh mc-stop.sh mc-agent-install.sh mc-agent-world-roots.py mc-release-journal.py mc-agent-host-broker.py mc-agent-workspace-dac.py; do
  replace_release_file "$SETUP_ROOT/runtime/$script" "/usr/local/bin/$script" 0755
done
install -d -o root -g root -m 0755 /opt/mc-agent/executor-root/usr/local/bin
install -o root -g root -m 0755 "$SETUP_ROOT/runtime/mc-agent-world-roots.py" \
  /opt/mc-agent/executor-root/usr/local/bin/mc-agent-world-roots.py
install -o root -g root -m 0755 "$SETUP_ROOT/runtime/mc-agent-workspace-dac.py" \
  /opt/mc-agent/executor-root/usr/local/bin/mc-agent-workspace-dac.py
cmp -s "$SETUP_ROOT/runtime/mc-agent-world-roots.py" \
  /opt/mc-agent/executor-root/usr/local/bin/mc-agent-world-roots.py || fail "executor world-root verifier staging failed"
install_persistent_guard_file "$SETUP_ROOT/runtime/mc-maintenance-boot.py" /usr/local/bin/mc-maintenance-boot.py 755
replace_release_file "$SETUP_ROOT/runtime/mc-host-operation.py" /usr/local/bin/mc-host-operation.py 0750
replace_release_file "$SETUP_ROOT/runtime/mc-backup-auth.py" /usr/local/bin/mc-backup-auth.py 0750
replace_release_file "$SETUP_ROOT/runtime/minecraft.service" /etc/systemd/system/minecraft.service 0644
replace_release_file "$SETUP_ROOT/runtime/minecraft-dns.service" /etc/systemd/system/minecraft-dns.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-gateway.service" /etc/systemd/system/mc-agent-gateway.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-executor.service" /etc/systemd/system/mc-agent-executor.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-executor.socket" /etc/systemd/system/mc-agent-executor.socket 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-tool-read.service" /etc/systemd/system/mc-agent-tool-read.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-tool-read.socket" /etc/systemd/system/mc-agent-tool-read.socket 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-tool-write.service" /etc/systemd/system/mc-agent-tool-write.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-tool-write.socket" /etc/systemd/system/mc-agent-tool-write.socket 0644
  replace_release_file "$SETUP_ROOT/runtime/mc-agent-world-roots.service" /etc/systemd/system/mc-agent-world-roots.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-host-broker.service" /etc/systemd/system/mc-agent-host-broker.service 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-host-broker.socket" /etc/systemd/system/mc-agent-host-broker.socket 0644
replace_release_file "$SETUP_ROOT/runtime/mc-agent-workspace-dac.py" /usr/local/bin/mc-agent-workspace-dac.py 0755
/usr/local/bin/mc-agent-workspace-dac.py reconcile
install_persistent_guard_file "$SETUP_ROOT/runtime/mc-maintenance-recovery.service" /etc/systemd/system/mc-maintenance-recovery.service 644
install -d -o root -g root -m 0755 /usr/lib/systemd/system-generators
install_persistent_guard_file "$SETUP_ROOT/runtime/mc-aws-maintenance-generator" /usr/lib/systemd/system-generators/mc-aws-maintenance-generator 755
replace_release_file "$SETUP_ROOT/runtime/mc-agent-runtime.tmpfiles" /usr/lib/tmpfiles.d/mc-agent.conf 0644
systemd-tmpfiles --create /usr/lib/tmpfiles.d/mc-agent.conf
install -d -o root -g root -m 0755 /etc/mc-agent
replace_release_file "$SETUP_ROOT/runtime/host-operation-contract.json" /etc/mc-agent/host-operation-contract.json 0644
install -o root -g root -m 0644 /dev/null /etc/cron.d/minecraft-idle
printf '%s\n' '*/1 * * * * root /usr/local/bin/check-mc-idle.sh' > /etc/cron.d/minecraft-idle

python3 - "$runtime_release/release-manifest.json" <<'PY'
import hashlib, json, os, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
for item in manifest["files"]:
    path = item["destination"]
    if path in {
        "/etc/mc-agent/world-roots-current/gateway.json",
        "/etc/mc-agent/world-roots-current/executor.json",
    }:
        continue
    with open(path, "rb") as source:
        data = source.read()
    if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise SystemExit(f"installed host release member mismatch: {path}")
PY
install -d -o root -g root -m 0755 /opt/mc-agent
install -o root -g root -m 0644 "$runtime_release/agent-runtime.zip" /opt/mc-agent/agent-runtime.zip
current_node="$(readlink /opt/mc-agent/node-current 2>/dev/null || true)"
  if (( ACTIVATE_QUIESCED == 0 )) && [[ "$current_node" =~ ^node-releases/[a-f0-9]{64}$ ]]; then
  readarray -t runtime_evidence < <(python3 - "$runtime_release/release-manifest.json" <<'PY'
import json, sys
item = json.load(open(sys.argv[1], encoding="utf-8"))["agentRuntime"]
print(item["sha256"]); print(item["bytes"]); print(item["bundleManifestSha256"])
PY
  )
  (( ${#runtime_evidence[@]} == 3 )) || fail "agent runtime release evidence is incomplete"
  /usr/local/bin/mc-agent-install.sh install-runtime-only /opt/mc-agent/agent-runtime.zip "${runtime_evidence[0]}" "${runtime_evidence[1]}" "${runtime_evidence[2]}"
fi
install -d -o root -g root -m 0755 /var/lib/mc-aws
install -o root -g root -m 0644 "$runtime_release/release-manifest.json" /var/lib/mc-aws/host-release-manifest.json
{
  printf 'release-manifest %s %s\n' "$(sha256sum "$runtime_release/release-manifest.json" | cut -d ' ' -f 1)" "$(stat -c '%s' "$runtime_release/release-manifest.json")"
  while IFS=$'\t' read -r destination digest bytes; do printf '%s %s %s\n' "$destination" "$digest" "$bytes"; done < <(python3 - "$runtime_release/release-manifest.json" <<'PY'
import json, sys
for item in json.load(open(sys.argv[1], encoding="utf-8"))["files"]:
    print(f"{item['destination']}\t{item['sha256']}\t{item['bytes']}")
PY
  )
  readarray -t agent_evidence < <(python3 - "$runtime_release/release-manifest.json" <<'PY'
import json, sys
item = json.load(open(sys.argv[1], encoding="utf-8"))["agentRuntime"]
print(item["sha256"]); print(item["bytes"]); print(item["bundleManifestSha256"]); print(item["bundleManifestBytes"])
PY
  )
  (( ${#agent_evidence[@]} == 4 )) || fail "agent runtime release evidence is incomplete"
  printf 'agent-runtime %s %s\n' "${agent_evidence[0]}" "${agent_evidence[1]}"
  printf 'agent-runtime-manifest %s %s\n' "${agent_evidence[2]}" "${agent_evidence[3]}"
} > /var/lib/mc-aws/runtime-hashes.sha256
chmod 0644 /var/lib/mc-aws/runtime-hashes.sha256
fi

profile_source="$SETUP_ROOT/profile"
assert_maintenance_fence
(( RESTORE_STAGING == 0 )) || profile_source="$work/profile"
previous_server_properties="$work/previous-server.properties"
if (( RESTORE_STAGING == 0 )) && [[ -f "$SERVER_ROOT/server.properties" && ! -L "$SERVER_ROOT/server.properties" ]]; then
  install -o root -g root -m 0600 "$SERVER_ROOT/server.properties" "$previous_server_properties"
fi
if (( RESTORE_STAGING == 0 )); then
  [[ -x "$WORLD_ROOTS_HELPER" || -f "$WORLD_ROOTS_HELPER" ]] || fail "world-root transaction helper is missing"
  if [[ -L /etc/mc-agent/world-roots-current ]]; then
    WORLD_ROOT_GENERATION_BEFORE="$($WORLD_ROOTS_HELPER inspect --output generation)"
    [[ "$WORLD_ROOT_GENERATION_BEFORE" =~ ^[a-f0-9]{64}$ ]] || fail "active world-root generation identity is invalid"
  elif [[ ! -e /etc/mc-agent/world-roots-current ]]; then
    WORLD_ROOT_GENERATION_BEFORE="missing"
  else
    fail "active world-root generation path is unsafe"
  fi
  SERVER_PROPERTIES_TRANSACTION_STARTED=1
fi
python3 - "$profile_source" "$SERVER_ROOT" "$RESTORE_STAGING" <<'PY'
import os, pwd, shutil, stat, sys
from pathlib import Path
source, destination = Path(sys.argv[1]), Path(sys.argv[2])
restore_staging = sys.argv[3] == "1"
account = pwd.getpwnam("minecraft")
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
parent_fd = os.open(destination.parent, directory_flags)
try:
    try:
        os.mkdir(destination.name, 0o755, dir_fd=parent_fd)
    except FileExistsError:
        pass
    os.fsync(parent_fd)
    destination_fd = os.open(destination.name, directory_flags, dir_fd=parent_fd)
finally:
    os.close(parent_fd)

def open_directory(root_fd, parts):
    descriptor = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o755, dir_fd=descriptor)
            except FileExistsError:
                pass
            os.fsync(descriptor)
            child = os.open(part, directory_flags, dir_fd=descriptor)
            os.fchown(child, account.pw_uid, account.pw_gid)
            os.fsync(child)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise

for root, directories, files in os.walk(source, followlinks=False):
    relative = Path(root).relative_to(source)
    target_fd = open_directory(destination_fd, relative.parts)
    for name in directories + files:
        item = Path(root) / name
        mode = os.lstat(item).st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise SystemExit("profile changed to contain a non-regular entry")
    for name in files:
        if relative == Path(".") and (name in ("plugins.lock.json", "rclone.conf") or (name == "server.properties" and not restore_staging)):
            continue
        source_file, temporary = Path(root) / name, f".{name}.mc-profile.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600, dir_fd=target_fd)
        try:
            with source_file.open("rb") as incoming, os.fdopen(descriptor, "wb", closefd=False) as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            os.fchmod(descriptor, 0o644)
            os.fchown(descriptor, account.pw_uid, account.pw_gid)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, name, src_dir_fd=target_fd, dst_dir_fd=target_fd)
        os.fsync(target_fd)
    os.fsync(target_fd)
    os.close(target_fd)
os.fchown(destination_fd, account.pw_uid, account.pw_gid)
os.fsync(destination_fd)
os.close(destination_fd)
PY

lock="$profile_source/plugins.lock.json"
plugin_list="$work/plugins.tsv"
: > "$plugin_list"
if [[ -f "$lock" ]]; then
    python3 - "$lock" "$SERVER_ROOT" > "$plugin_list" <<'PY'
import hashlib, json, pathlib, re, stat, sys, urllib.parse
value = json.load(open(sys.argv[1], encoding="utf-8"))
live_root = pathlib.Path(sys.argv[2])
if set(value) != {"version", "plugins"} or value["version"] != 1 or not isinstance(value["plugins"], list):
    raise SystemExit("invalid plugin lock schema")
names, destinations = set(), set()
for plugin in value["plugins"]:
    if not isinstance(plugin, dict) or set(plugin) not in ({"name", "destination", "url", "sha256"}, {"name", "destination", "url", "sha256", "bytes"}):
        raise SystemExit("invalid plugin entry")
    name, destination, url, digest = (plugin[key] for key in ("name", "destination", "url", "sha256"))
    parsed = urllib.parse.urlsplit(url)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jar", destination):
        raise SystemExit("unsafe plugin name or destination")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443) or not parsed.path.lower().endswith(".jar"):
        raise SystemExit("unsafe plugin URL")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or name.lower() in names or destination.lower() in destinations:
        raise SystemExit("invalid or duplicate plugin checksum entry")
    expected_bytes = plugin.get("bytes")
    if expected_bytes is not None and (not isinstance(expected_bytes, int) or isinstance(expected_bytes, bool) or not 1 <= expected_bytes <= 32 * 1024 * 1024):
        raise SystemExit("invalid plugin byte identity")
    existing = live_root / "plugins" / destination
    if expected_bytes is None:
        try:
            existing_metadata = existing.lstat()
        except FileNotFoundError:
            existing_metadata = None
        if (
            existing_metadata is None
            or not stat.S_ISREG(existing_metadata.st_mode)
            or stat.S_ISLNK(existing_metadata.st_mode)
            or hashlib.sha256(existing.read_bytes()).hexdigest() != digest
        ):
            raise SystemExit("new or changed plugin entries require an exact bytes field")
    names.add(name.lower()); destinations.add(destination.lower())
    print("\t".join((name, destination, url, digest, "" if expected_bytes is None else str(expected_bytes))))
PY
  while IFS=$'\t' read -r name destination url digest expected_bytes; do
    [[ -n "$name" ]] || continue
    temporary="$work/plugin-${digest}.download"
    rm -f -- "$temporary"
    log "Downloading checksum-pinned plugin: $name"
    if ! (
      ulimit -f $(( (MAX_PLUGIN_BYTES + 1023) / 1024 ))
      curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-filesize "$MAX_PLUGIN_BYTES" --output "$temporary" "$url"
    ); then
      rm -f -- "$temporary"
      fail "plugin download failed or exceeded ${MAX_PLUGIN_BYTES} bytes: $name"
    fi
    [[ -f "$temporary" && ! -L "$temporary" ]] || fail "plugin download is not a regular file: $name"
    plugin_bytes="$(stat -c '%s' -- "$temporary")" || fail "could not inspect plugin download: $name"
    [[ "$plugin_bytes" =~ ^[0-9]+$ ]] && (( plugin_bytes > 0 && plugin_bytes <= MAX_PLUGIN_BYTES )) || {
      rm -f -- "$temporary"
      fail "plugin download has an invalid size: $name"
    }
    [[ -z "$expected_bytes" || "$plugin_bytes" == "$expected_bytes" ]] || {
      rm -f -- "$temporary"
      fail "plugin byte identity mismatch: $name"
    }
    printf '%s  %s\n' "$digest" "$temporary" | sha256sum --check --status || fail "plugin checksum mismatch: $name"
    python3 - "$temporary" "$SERVER_ROOT" "$destination" <<'PY'
import os, pwd, shutil, sys
source, server_root, destination = sys.argv[1:]
account = pwd.getpwnam("minecraft")
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
server_fd = os.open(server_root, directory_flags)
try:
    try:
        os.mkdir("plugins", 0o755, dir_fd=server_fd)
    except FileExistsError:
        pass
    plugins_fd = os.open("plugins", directory_flags, dir_fd=server_fd)
finally:
    os.close(server_fd)
try:
    os.fchown(plugins_fd, account.pw_uid, account.pw_gid)
    temporary = f".{destination}.mc-profile.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=plugins_fd)
    try:
        with open(source, "rb") as incoming, os.fdopen(descriptor, "wb", closefd=False) as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        os.fchmod(descriptor, 0o644)
        os.fchown(descriptor, account.pw_uid, account.pw_gid)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, destination, src_dir_fd=plugins_fd, dst_dir_fd=plugins_fd)
    os.fsync(plugins_fd)
finally:
    os.close(plugins_fd)
PY
  done < "$plugin_list"
fi

# The reviewed plugin manifest is an exact set.  Remove every other JAR from
# the live plugin tree after the release journal has captured the complete
# tree.  Non-JAR regular files and directories are an explicit compatibility
# allowance for Paper/plugin-generated data; links and special files are not.
python3 - "$SERVER_ROOT" "$plugin_list" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path

server_root, lock_path = map(Path, sys.argv[1:])
plugins_root = server_root / "plugins"
expected = {}
for line in lock_path.read_text(encoding="utf-8").splitlines():
    fields = line.split("\t")
    if len(fields) != 5:
        raise SystemExit("plugin manifest evidence is malformed")
    name, destination, url, digest, bytes_value = fields
    if not name or not destination or not digest or not url:
        raise SystemExit("plugin manifest evidence is malformed")
    if bytes_value:
        try:
            expected_bytes = int(bytes_value)
        except ValueError:
            raise SystemExit("plugin manifest evidence has an invalid byte identity")
        if expected_bytes < 1:
            raise SystemExit("plugin manifest evidence has an invalid byte identity")
    else:
        expected_bytes = None
    expected[destination.lower()] = (destination, digest, expected_bytes)

try:
    metadata = plugins_root.lstat()
except FileNotFoundError:
    if expected:
        raise SystemExit("live plugins path is missing")
    raise SystemExit(0)
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
    raise SystemExit("live plugins path is unsafe")

def reconcile(directory: Path) -> None:
    changed = False
    for entry in sorted(os.scandir(directory), key=lambda item: item.name.lower()):
        path = Path(entry.path)
        item = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(item.st_mode) or not (stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode)):
            raise SystemExit("live plugin tree contains a link or special file")
        if stat.S_ISDIR(item.st_mode):
            reconcile(path)
            continue
        if not entry.name.lower().endswith(".jar"):
            continue
        relative = path.relative_to(plugins_root).as_posix()
        if relative.lower() != entry.name.lower() or entry.name.lower() not in expected or entry.name != expected[entry.name.lower()][0]:
            path.unlink()
            changed = True
    if changed:
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

reconcile(plugins_root)
for destination, digest, expected_bytes in expected.values():
    path = plugins_root / destination
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        raise SystemExit(f"reviewed plugin is missing after reconciliation: {destination}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"reviewed plugin is not a regular file: {destination}")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f"reviewed plugin digest mismatch after reconciliation: {destination}")
    if expected_bytes is not None and len(data) != expected_bytes:
        raise SystemExit(f"reviewed plugin byte identity mismatch after reconciliation: {destination}")
PY

if (( RESTORE_STAGING == 0 )); then
  reconcile_args=(
    --gateway-template "$config_stage/gateway.json"
    --executor-template "$config_stage/executor.json"
  )
  [[ -f "$previous_server_properties" ]] && reconcile_args+=(--previous-server-properties "$previous_server_properties")
  if [[ -f "$profile_source/server.properties" && ! -L "$profile_source/server.properties" ]]; then
    "$WORLD_ROOTS_HELPER" transaction \
      "${reconcile_args[@]}" \
      --server-properties "$SERVER_ROOT/server.properties" \
      --staged-server-properties "$profile_source/server.properties" \
      --server-properties-owner minecraft \
      --server-properties-group minecraft
  else
    "$WORLD_ROOTS_HELPER" reconcile "${reconcile_args[@]}"
  fi
  # Reconciliation commits one immutable /etc generation. Only now can its
  # ownership, type, schema, and canonical roots be verified.
  [[ -f /etc/mc-agent/world-roots-current/gateway.json && ! -L /etc/mc-agent/world-roots-current/gateway.json ]] || fail "reconciled gateway config was not created"
  [[ -f /etc/mc-agent/world-roots-current/executor.json && ! -L /etc/mc-agent/world-roots-current/executor.json ]] || fail "reconciled executor config was not created"
  "$WORLD_ROOTS_HELPER" verify
fi

if (( BOOTSTRAP == 0 && RESTORE_STAGING == 0 && ACTIVATE_QUIESCED == 0 )); then
  systemctl daemon-reload
  if systemctl is-active --quiet mc-agent-world-roots.service; then
    systemctl restart mc-agent-world-roots.service
  fi
  systemctl enable minecraft.service minecraft-dns.service
  if (( ENABLE_AGENT == 1 )); then
     systemctl enable mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-gateway.service mc-agent-executor.service mc-agent-world-roots.service mc-agent-host-broker.socket mc-agent-host-broker.service
  fi
  if [[ -e "$MAINTENANCE_BOOT_HOLD" || -L "$MAINTENANCE_BOOT_HOLD" ]]; then
    log "Durable boot inhibition is active; service activation remains deferred"
  else
      systemctl unmask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service
    if (( ENABLE_AGENT == 1 )); then
      systemctl start mc-agent-world-roots.service
      systemctl start mc-agent-tool-read.socket mc-agent-tool-write.socket mc-agent-executor.socket mc-agent-host-broker.socket
      systemctl start mc-agent-executor.service
      systemctl start mc-agent-gateway.service
    fi
    (( was_active == 0 )) || systemctl start minecraft.service
  fi
fi
if (( DEFER_SERVICES == 1 )); then
  log "Validated and staged host release $release_hash and profile $profile_hash without mutating live host destinations"
elif (( RESTORE_STAGING == 0 && ACTIVATE_QUIESCED == 1 )); then
  log "Installed host release $release_hash under the exact quiesced rollout owner; service restoration remains pending"
else
  log "Installed host release $release_hash and applied profile $profile_hash"
fi
