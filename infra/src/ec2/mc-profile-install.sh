#!/usr/bin/env bash
# Install the content-addressed runtime/profile assets and explicitly apply the profile.
set -euo pipefail
umask 077

readonly MANIFEST_PARAMETER="/minecraft/server-profile-manifest"
readonly SETUP_ROOT="/opt/setup"
readonly SERVER_ROOT="/opt/minecraft/server"
readonly MAX_ARCHIVE_FILES=2500
readonly MAX_ARCHIVE_BYTES=157286400
readonly MAX_PLUGIN_BYTES=$((32 * 1024 * 1024))

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != "--bootstrap" ]]; }; then
  fail "Usage: mc-profile-install.sh [--bootstrap]"
fi
BOOTSTRAP=0
(( $# == 1 )) && BOOTSTRAP=1

[[ "$(id -u)" == "0" ]] || fail "must run as root"
for command in aws python3 curl sha256sum install stat; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

work="$(mktemp -d /opt/.mc-profile-install.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

manifest="$work/manifest.json"
aws ssm get-parameter --name "$MANIFEST_PARAMETER" --query Parameter.Value --output text > "$manifest"

readarray -t fields < <(python3 - "$manifest" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
if set(value) != {"version", "runtime", "profile"} or value["version"] != 1:
    raise SystemExit("invalid asset manifest schema")
for kind in ("runtime", "profile"):
    item = value[kind]
    if not isinstance(item, dict) or set(item) != {"uri", "sha256"}:
        raise SystemExit(f"invalid {kind} asset manifest")
    if not isinstance(item["uri"], str) or not re.fullmatch(r"s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9!_.*'()/-]+", item["uri"]):
        raise SystemExit(f"invalid {kind} S3 URI")
    if not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
        raise SystemExit(f"invalid {kind} archive checksum")
    print(item["uri"])
    print(item["sha256"])
PY
)
(( ${#fields[@]} == 4 )) || fail "asset manifest validation failed"
runtime_uri="${fields[0]}"
runtime_hash="${fields[1]}"
profile_uri="${fields[2]}"
profile_hash="${fields[3]}"

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

download_and_extract runtime "$runtime_uri" "$runtime_hash"
download_and_extract profile "$profile_uri" "$profile_hash"

runtime_release="$SETUP_ROOT/runtime-$runtime_hash"
profile_release="$SETUP_ROOT/profile-$profile_hash"
install -d -o root -g root -m 0755 "$SETUP_ROOT"
[[ -e "$runtime_release" ]] || mv -- "$work/runtime" "$runtime_release"
[[ -e "$profile_release" ]] || mv -- "$work/profile" "$profile_release"
chown -R root:root "$runtime_release" "$profile_release"
find "$runtime_release" "$profile_release" -type d -exec chmod 0755 {} +
find "$runtime_release" "$profile_release" -type f -exec chmod 0644 {} +
chmod 0755 "$runtime_release"/*.sh

ln -sfn "$(basename -- "$runtime_release")" "$SETUP_ROOT/.runtime-current"
mv -Tf -- "$SETUP_ROOT/.runtime-current" "$SETUP_ROOT/runtime"
ln -sfn "$(basename -- "$profile_release")" "$SETUP_ROOT/.profile-current"
mv -Tf -- "$SETUP_ROOT/.profile-current" "$SETUP_ROOT/profile"

for script in check-mc-idle.sh mc-rclone-config.sh mc-backup.sh mc-restore.sh mc-hibernate.sh mc-resume.sh update-dns.sh mc-profile-install.sh mc-stop.sh; do
  install -o root -g root -m 0755 "$SETUP_ROOT/runtime/$script" "/usr/local/bin/$script"
done
install -o root -g root -m 0644 "$SETUP_ROOT/runtime/minecraft.service" /etc/systemd/system/minecraft.service
install -o root -g root -m 0644 "$SETUP_ROOT/runtime/minecraft-dns.service" /etc/systemd/system/minecraft-dns.service
install -o root -g root -m 0644 /dev/null /etc/cron.d/minecraft-idle
printf '%s\n' '*/1 * * * * root /usr/local/bin/check-mc-idle.sh' > /etc/cron.d/minecraft-idle

was_active=0
if (( BOOTSTRAP == 0 )) && systemctl is-active --quiet minecraft.service; then
  was_active=1
  systemctl stop minecraft.service
fi

python3 - "$SETUP_ROOT/profile" "$SERVER_ROOT" <<'PY'
import os, pwd, shutil, stat, sys
from pathlib import Path
source, destination = Path(sys.argv[1]), Path(sys.argv[2])
account = pwd.getpwnam("minecraft")
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
parent_fd = os.open(destination.parent, directory_flags)
try:
    try:
        os.mkdir(destination.name, 0o755, dir_fd=parent_fd)
    except FileExistsError:
        pass
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
            child = os.open(part, directory_flags, dir_fd=descriptor)
            os.fchown(child, account.pw_uid, account.pw_gid)
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
        if relative == Path(".") and name in ("plugins.lock.json", "rclone.conf"):
            continue
        source_file, temporary = Path(root) / name, f".{name}.mc-profile.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600, dir_fd=target_fd)
        try:
            with source_file.open("rb") as incoming, os.fdopen(descriptor, "wb", closefd=False) as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            os.fchmod(descriptor, 0o644)
            os.fchown(descriptor, account.pw_uid, account.pw_gid)
        finally:
            os.close(descriptor)
        os.replace(temporary, name, src_dir_fd=target_fd, dst_dir_fd=target_fd)
    os.close(target_fd)
os.fchown(destination_fd, account.pw_uid, account.pw_gid)
os.close(destination_fd)
PY

lock="$SETUP_ROOT/profile/plugins.lock.json"
if [[ -f "$lock" ]]; then
  plugin_list="$work/plugins.tsv"
  python3 - "$lock" > "$plugin_list" <<'PY'
import json, re, sys, urllib.parse
value = json.load(open(sys.argv[1], encoding="utf-8"))
if set(value) != {"version", "plugins"} or value["version"] != 1 or not isinstance(value["plugins"], list):
    raise SystemExit("invalid plugin lock schema")
names, destinations = set(), set()
for plugin in value["plugins"]:
    if not isinstance(plugin, dict) or set(plugin) != {"name", "destination", "url", "sha256"}:
        raise SystemExit("invalid plugin entry")
    name, destination, url, digest = (plugin[key] for key in ("name", "destination", "url", "sha256"))
    parsed = urllib.parse.urlsplit(url)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jar", destination):
        raise SystemExit("unsafe plugin name or destination")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443):
        raise SystemExit("unsafe plugin URL")
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or name.lower() in names or destination.lower() in destinations:
        raise SystemExit("invalid or duplicate plugin checksum entry")
    names.add(name.lower()); destinations.add(destination.lower())
    print("\t".join((name, destination, url, digest)))
PY
  while IFS=$'\t' read -r name destination url digest; do
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
    finally:
        os.close(descriptor)
    os.replace(temporary, destination, src_dir_fd=plugins_fd, dst_dir_fd=plugins_fd)
finally:
    os.close(plugins_fd)
PY
  done < "$plugin_list"
fi

systemctl daemon-reload
systemctl enable minecraft.service minecraft-dns.service
(( was_active == 0 )) || systemctl start minecraft.service
log "Installed runtime $runtime_hash and applied profile $profile_hash"
