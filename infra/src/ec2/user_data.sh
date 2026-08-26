#!/usr/bin/env bash
set -euo pipefail

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
bootstrap_failed() {
  local exit_code=$?
  (( exit_code != 0 )) || return
  trap - EXIT
  set +e
  log "ERROR: Bootstrap failed; powering off to prevent unattended EC2 charges"
  systemctl poweroff || shutdown -h now
  exit "$exit_code"
}
trap bootstrap_failed EXIT

readonly MC_VERSION="1.21.11"
readonly PROFILE_MANIFEST_PARAMETER="/minecraft/server-profile-manifest"
readonly RESUME_PENDING_PARAMETER="/minecraft/resume-pending"
readonly BOOTSTRAP_MARKER="/var/lib/mc-aws/bootstrap-complete"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"

dnf update -y
rpm --import https://yum.corretto.aws/corretto.key
curl --fail --location --proto '=https' --tlsv1.2 --output /etc/yum.repos.d/corretto.repo https://yum.corretto.aws/corretto.repo
dnf install -y java-21-amazon-corretto-devel unzip python3 python3-pip cronie screen jq awscli2
systemctl enable --now crond
python3 -m pip install mcstatus

curl --fail --location --proto '=https' --tlsv1.2 --output /tmp/rclone.zip https://downloads.rclone.org/rclone-current-linux-arm64.zip
unzip -q /tmp/rclone.zip -d /tmp/rclone
install -o root -g root -m 0755 /tmp/rclone/rclone-*/rclone /usr/local/bin/rclone

id minecraft >/dev/null 2>&1 || useradd -m -r minecraft
install -d -o minecraft -g minecraft -m 0755 /opt/minecraft/server
install -d -o root -g root -m 0755 /opt/setup /etc/minecraft
install -d -o root -g root -m 0755 "$(dirname -- "$BOOTSTRAP_MARKER")"

resume_pending=0
if aws ssm get-parameter --name "$RESUME_PENDING_PARAMETER" --query Parameter.Name --output text >/dev/null 2> /tmp/resume-pending-error; then
  resume_pending=1
elif grep -q "ParameterNotFound" /tmp/resume-pending-error; then
  resume_pending=0
else
  log "ERROR: Could not determine whether a resume is pending"
  exit 1
fi
rm -f /tmp/resume-pending-error

if [[ ! "$GDRIVE_REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || [[ -z "$GDRIVE_ROOT" || "$GDRIVE_ROOT" == *$'\n'* || "$GDRIVE_ROOT" == *$'\r'* ]]; then
  log "ERROR: Invalid Google Drive destination"
  exit 1
fi
printf '%s\n' "$GDRIVE_REMOTE" > /etc/minecraft/gdrive-remote
printf '%s\n' "$GDRIVE_ROOT" > /etc/minecraft/gdrive-root
chmod 0644 /etc/minecraft/gdrive-remote /etc/minecraft/gdrive-root

bootstrap="$(mktemp -d /opt/.mc-bootstrap.XXXXXX)"
trap 'rm -rf -- "$bootstrap"; bootstrap_failed' EXIT
manifest="$bootstrap/manifest.json"
aws ssm get-parameter --name "$PROFILE_MANIFEST_PARAMETER" --query Parameter.Value --output text > "$manifest"
readarray -t runtime_asset < <(python3 - "$manifest" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
if set(value) != {"version", "runtime", "profile"} or value["version"] != 1:
    raise SystemExit("invalid profile asset manifest")
item = value["runtime"]
if set(item) != {"uri", "sha256"} or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) or not re.fullmatch(r"s3://[^/]+/[A-Za-z0-9!_.*'()/-]+", item["uri"]):
    raise SystemExit("invalid runtime asset")
print(item["uri"])
print(item["sha256"])
PY
)
(( ${#runtime_asset[@]} == 2 )) || { log "ERROR: invalid runtime asset manifest"; exit 1; }
runtime_uri="${runtime_asset[0]}"
runtime_sha256="${runtime_asset[1]}"
aws s3 cp --only-show-errors "$runtime_uri" "$bootstrap/runtime.zip"
printf '%s  %s\n' "$runtime_sha256" "$bootstrap/runtime.zip" | sha256sum --check --status || { log "ERROR: runtime archive checksum mismatch"; exit 1; }
python3 - "$bootstrap/runtime.zip" "$bootstrap/runtime" <<'PY'
import os, shutil, stat, sys, zipfile
from pathlib import Path, PurePosixPath
archive, destination = Path(sys.argv[1]), Path(sys.argv[2]); destination.mkdir()
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > 2500 or sum(entry.file_size for entry in entries) > 157286400:
        raise SystemExit("runtime archive limits exceeded")
    seen = set()
    for entry in entries:
        name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
        path = PurePosixPath(name); mode = entry.external_attr >> 16
        if path.parts in seen or entry.file_size > 32 * 1024 * 1024:
            raise SystemExit("duplicate or oversized runtime archive entry")
        seen.add(path.parts)
        if not name or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise SystemExit("unsafe runtime archive entry")
    for entry in entries:
        name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
        target = destination.joinpath(*PurePosixPath(name).parts)
        if entry.is_dir(): target.mkdir(parents=True, exist_ok=True); continue
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with source.open(entry) as incoming, os.fdopen(descriptor, "wb") as outgoing: shutil.copyfileobj(incoming, outgoing)
PY
chmod 0755 "$bootstrap/runtime/mc-profile-install.sh"
"$bootstrap/runtime/mc-profile-install.sh" --bootstrap

readonly PAPER_USER_AGENT="mc-aws/1.0"
builds="$(curl --fail --silent --show-error --location --retry 3 -H "User-Agent: ${PAPER_USER_AGENT}" "https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds")"
paper_url="$(jq -r 'first(.[] | select(.channel == "STABLE") | .downloads."server:default".url) // empty' <<<"$builds")"
[[ "$paper_url" == https://* ]] || { log "ERROR: no stable Paper build"; exit 1; }
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 -H "User-Agent: ${PAPER_USER_AGENT}" "$paper_url" -o /tmp/paper.jar
install -o minecraft -g minecraft -m 0644 /tmp/paper.jar /opt/minecraft/server/paper.jar
printf '%s\n' 'eula=true' > /opt/minecraft/server/eula.txt
chown minecraft:minecraft /opt/minecraft/server/eula.txt

/usr/local/bin/mc-rclone-config.sh --bootstrap
systemctl daemon-reload
systemctl enable minecraft.service minecraft-dns.service
touch "$BOOTSTRAP_MARKER"
chmod 0644 "$BOOTSTRAP_MARKER"
if (( resume_pending == 1 )); then
  log "Resume marker detected; bootstrap completed without starting DNS or Minecraft"
else
  systemctl start minecraft.service
fi
rm -rf -- "$bootstrap"
trap bootstrap_failed EXIT
