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
readonly PAPER_BUILD="132"
readonly PAPER_URL="https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar"
readonly PAPER_SHA256="5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
readonly RCLONE_VERSION="1.71.2"
readonly RCLONE_URL="https://downloads.rclone.org/v1.71.2/rclone-v1.71.2-linux-arm64.zip"
readonly RCLONE_SHA256="e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1"
readonly MCSTATUS_VERSION="12.0.2"
readonly MCSTATUS_URL="https://files.pythonhosted.org/packages/d3/eb/ede21d01d19e957573c88ff685401341a02ab595b4dba9a4a41fd382676c/mcstatus-12.0.2-py3-none-any.whl"
readonly MCSTATUS_SHA256="b2ee5ff189a4ebf255c658e3983b3e2c74a1e0d222d3e74cfe04c2b4f64f66e6"
readonly ASYNCIO_DGRAM_VERSION="2.2.0"
readonly ASYNCIO_DGRAM_URL="https://files.pythonhosted.org/packages/61/00/cb33d8a9ebad87c9507262b131c92659bcf62975320b7feb9acdfb260ba0/asyncio_dgram-2.2.0-py3-none-any.whl"
readonly ASYNCIO_DGRAM_SHA256="7afe5a587d1d57908c7a02fe84c785f075d3fb59b555039a6ff8aead28622743"
readonly DNSPYTHON_VERSION="2.7.0"
readonly DNSPYTHON_URL="https://files.pythonhosted.org/packages/68/1b/e0a87d256e40e8c888847551b20a017a6b98139178505dc7ffb96f04e954/dnspython-2.7.0-py3-none-any.whl"
readonly DNSPYTHON_SHA256="b4c34b7d10b51bcc3a5071e7b8dee77939f1e878477eeecc965e9835f63c6c86"
readonly MC_BOOTSTRAP_PINS_SHA256="4caf08790154b32ae4d9948e9829b95811146022d30325e5fed2406881527bdd"
readonly PROFILE_MANIFEST_PARAMETER="/minecraft/server-profile-manifest"
readonly RESUME_PENDING_PARAMETER="/minecraft/resume-pending"
readonly BOOTSTRAP_MARKER="/var/lib/mc-aws/bootstrap-complete"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"

# The reviewed AMI is the OS patch boundary. Its releasever points at an immutable
# AL2023 repository snapshot; pass it explicitly so bootstrap cannot follow a later
# repository release if host/global DNF configuration changes. Package NEVRAs within
# that AWS snapshot remain upstream-controlled and are recorded below for diagnosis.
readonly AL2023_RELEASEVER="$(tr -d '[:space:]' < /etc/dnf/vars/releasever)"
[[ "$AL2023_RELEASEVER" =~ ^2023\.[0-9]+\.[0-9]+$ ]] || { log "ERROR: reviewed AL2023 AMI has an invalid releasever"; exit 1; }
dnf install -y --releasever="$AL2023_RELEASEVER" --setopt=install_weak_deps=False --setopt=metadata_expire=never \
  java-21-amazon-corretto-devel unzip python3 python3-pip cronie screen jq
command -v aws >/dev/null 2>&1 || { log "ERROR: pinned AL2023 image does not provide the AWS CLI"; exit 1; }
install -d -o root -g root -m 0755 /var/lib/mc-aws
{
  printf 'releasever %s\n' "$AL2023_RELEASEVER"
  rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}.%{ARCH}\n' \
    java-21-amazon-corretto-devel unzip python3 python3-pip cronie screen jq | LC_ALL=C sort
} > /var/lib/mc-aws/os-package-manifest.txt
chmod 0644 /var/lib/mc-aws/os-package-manifest.txt
systemctl enable --now crond
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/mcstatus-12.0.2-py3-none-any.whl "$MCSTATUS_URL"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/asyncio_dgram-2.2.0-py3-none-any.whl "$ASYNCIO_DGRAM_URL"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/dnspython-2.7.0-py3-none-any.whl "$DNSPYTHON_URL"
printf '%s  %s\n' "$MCSTATUS_SHA256" /tmp/mcstatus-12.0.2-py3-none-any.whl | sha256sum --check --status
printf '%s  %s\n' "$ASYNCIO_DGRAM_SHA256" /tmp/asyncio_dgram-2.2.0-py3-none-any.whl | sha256sum --check --status
printf '%s  %s\n' "$DNSPYTHON_SHA256" /tmp/dnspython-2.7.0-py3-none-any.whl | sha256sum --check --status
python3 -m pip install --no-index --no-deps \
  /tmp/asyncio_dgram-2.2.0-py3-none-any.whl \
  /tmp/dnspython-2.7.0-py3-none-any.whl \
  /tmp/mcstatus-12.0.2-py3-none-any.whl

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/rclone.zip "$RCLONE_URL"
printf '%s  %s\n' "$RCLONE_SHA256" /tmp/rclone.zip | sha256sum --check --status
unzip -q /tmp/rclone.zip -d /tmp/rclone
install -o root -g root -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-arm64/rclone" /usr/local/bin/rclone

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
log "Installing reviewed Paper ${MC_VERSION} build ${PAPER_BUILD}"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 -H "User-Agent: ${PAPER_USER_AGENT}" "$PAPER_URL" -o /tmp/paper.jar
printf '%s  %s\n' "$PAPER_SHA256" /tmp/paper.jar | sha256sum --check --status || { log "ERROR: Paper checksum mismatch"; exit 1; }
install -o minecraft -g minecraft -m 0644 /tmp/paper.jar /opt/minecraft/server/paper.jar
printf '%s\n' 'eula=true' > /opt/minecraft/server/eula.txt
chown minecraft:minecraft /opt/minecraft/server/eula.txt

/usr/local/bin/mc-rclone-config.sh --bootstrap
{
  printf 'pins %s\n' "$MC_BOOTSTRAP_PINS_SHA256"
  printf 'paper %s\n' "$(sha256sum /opt/minecraft/server/paper.jar | cut -d ' ' -f 1)"
  printf 'rclone %s\n' "$(sha256sum /usr/local/bin/rclone | cut -d ' ' -f 1)"
  printf 'mc-wait-ready %s\n' "$(sha256sum /usr/local/bin/mc-wait-ready.sh | cut -d ' ' -f 1)"
  printf 'mc-runtime-rollout %s\n' "$(sha256sum /usr/local/bin/mc-runtime-rollout.sh | cut -d ' ' -f 1)"
} > /var/lib/mc-aws/runtime-hashes.sha256
chmod 0644 /var/lib/mc-aws/runtime-hashes.sha256
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
