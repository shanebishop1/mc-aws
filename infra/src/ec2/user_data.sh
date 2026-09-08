#!/usr/bin/env bash
set -euo pipefail

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
bootstrap_failed() {
  local exit_code="${1:-$?}"
  (( exit_code != 0 )) || return
  trap - EXIT
  set +e
  log "ERROR: Bootstrap failed; powering off to prevent unattended EC2 charges"
  systemctl poweroff || shutdown -h now
  exit "$exit_code"
}
trap 'bootstrap_failed $?' EXIT

readonly MC_VERSION="1.21.11"
readonly PAPER_BUILD="132"
readonly PAPER_URL="https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar"
readonly PAPER_SHA256="5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba"
readonly RCLONE_VERSION="1.71.2"
readonly RCLONE_URL="https://downloads.rclone.org/v1.71.2/rclone-v1.71.2-linux-arm64.zip"
readonly RCLONE_SHA256="e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1"
readonly NODE_VERSION="22.19.0"
readonly NODE_ARM64_URL="https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz"
readonly NODE_ARM64_SHA256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
readonly MCSTATUS_VERSION="12.0.2"
readonly MCSTATUS_URL="https://files.pythonhosted.org/packages/d3/eb/ede21d01d19e957573c88ff685401341a02ab595b4dba9a4a41fd382676c/mcstatus-12.0.2-py3-none-any.whl"
readonly MCSTATUS_SHA256="b2ee5ff189a4ebf255c658e3983b3e2c74a1e0d222d3e74cfe04c2b4f64f66e6"
readonly ASYNCIO_DGRAM_VERSION="2.2.0"
readonly ASYNCIO_DGRAM_URL="https://files.pythonhosted.org/packages/61/00/cb33d8a9ebad87c9507262b131c92659bcf62975320b7feb9acdfb260ba0/asyncio_dgram-2.2.0-py3-none-any.whl"
readonly ASYNCIO_DGRAM_SHA256="7afe5a587d1d57908c7a02fe84c785f075d3fb59b555039a6ff8aead28622743"
readonly DNSPYTHON_VERSION="2.7.0"
readonly DNSPYTHON_URL="https://files.pythonhosted.org/packages/68/1b/e0a87d256e40e8c888847551b20a017a6b98139178505dc7ffb96f04e954/dnspython-2.7.0-py3-none-any.whl"
readonly DNSPYTHON_SHA256="b4c34b7d10b51bcc3a5071e7b8dee77939f1e878477eeecc965e9835f63c6c86"
readonly MC_BOOTSTRAP_PINS_SHA256="1d033a7fe499239b6528b0b36539e410f08a97c969984c4424a535a01a04cd3e"
readonly PROFILE_MANIFEST_PARAMETER="/minecraft/server-profile-manifest"
readonly BOOTSTRAP_MARKER="/var/lib/mc-aws/bootstrap-complete"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"

# The reviewed AMI is the OS patch boundary. Its installed system-release package
# identifies the immutable AL2023 repository snapshot; pass it explicitly so
# bootstrap cannot follow a later repository release if host/global DNF configuration
# changes. Package NEVRAs within that AWS snapshot remain upstream-controlled and are
# recorded below for diagnosis.
AL2023_RELEASEVER="$(rpm -q --qf '%{VERSION}' system-release)"
readonly AL2023_RELEASEVER
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
cat > /usr/local/bin/mcstatus <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec python3 -m mcstatus "$@"
SH
chmod 0755 /usr/local/bin/mcstatus

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output /tmp/rclone.zip "$RCLONE_URL"
printf '%s  %s\n' "$RCLONE_SHA256" /tmp/rclone.zip | sha256sum --check --status
unzip -q /tmp/rclone.zip -d /tmp/rclone
install -o root -g root -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-arm64/rclone" /usr/local/bin/rclone

id minecraft >/dev/null 2>&1 || useradd -m -r minecraft
install -d -o minecraft -g minecraft -m 0755 /opt/minecraft/server
install -d -o root -g root -m 0755 /opt/setup /etc/minecraft
install -d -o root -g root -m 0755 "$(dirname -- "$BOOTSTRAP_MARKER")"
operation_state_table_file="$(mktemp /etc/minecraft/.operation-state-table-name.XXXXXX)"
printf '%s\n' "$MC_OPERATION_STATE_TABLE_NAME" > "$operation_state_table_file"
install -o root -g root -m 0644 "$operation_state_table_file" /etc/minecraft/operation-state-table-name
rm -f -- "$operation_state_table_file"
if [[ -n "${MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_PEM_BASE64:-}" ]]; then
  install -d -o root -g root -m 0755 /etc/mc-agent
  fence_public_key="$(mktemp /etc/mc-agent/.backup-fence-public.XXXXXX)"
  printf '%s' "$MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_PEM_BASE64" | base64 --decode > "$fence_public_key"
  openssl pkey -pubin -in "$fence_public_key" -noout >/dev/null
  install -o root -g root -m 0444 "$fence_public_key" /etc/mc-agent/backup-fence-public.pem
  rm -f -- "$fence_public_key"
fi

resume_pending=0
resume_operation_id=""
resume_intent_file="$(mktemp /tmp/mc-resume-intent.XXXXXX)"
chmod 0600 "$resume_intent_file"
if aws dynamodb get-item --table-name "$MC_OPERATION_STATE_TABLE_NAME" --consistent-read \
  --key '{"operationId":{"S":"mc-aws-resume-intent"}}' --output json > "$resume_intent_file" 2> /tmp/resume-intent-error; then
  resume_operation_id="$(python3 - "$resume_intent_file" /var/lib/mc-aws/maintenance-boot-hold.json /proc/sys/kernel/random/boot_id <<'PY'
import json, os, re, stat, subprocess, sys, tempfile
from pathlib import Path

pointer_file, hold_path, boot_id_file = map(Path, sys.argv[1:])
document = json.loads(pointer_file.read_text(encoding="ascii"))
item = document.get("Item") or {}
raw = item.get("payload", {}).get("S")
if raw is None:
    print("")
    raise SystemExit(0)
pointer = json.loads(raw)
if not isinstance(pointer, dict) or pointer.get("schemaVersion") != 1 or pointer.get("kind") != "mc-aws-resume-intent":
    raise SystemExit("resume intent pointer has an invalid schema")
operation_id = pointer.get("operationId")
owner_token = pointer.get("ownerToken")
status = pointer.get("status")
intent = pointer.get("intent")
if (not isinstance(operation_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", operation_id)
        or not isinstance(owner_token, str) or not owner_token
        or status not in ("active", "completed", "failed")
        or not isinstance(pointer.get("version"), int) or pointer["version"] < 1
        or not isinstance(intent, dict) or intent.get("mode") not in ("fresh", "latest", "named", "replacement-convergence")):
    raise SystemExit("resume intent pointer has an invalid identity")
if status != "active":
    print("")
    raise SystemExit(0)
table = os.environ.get("MC_OPERATION_STATE_TABLE_NAME", "").strip()
try:
    authoritative = subprocess.run(
        ["aws", "dynamodb", "get-item", "--table-name", table, "--consistent-read", "--key", json.dumps({"operationId": {"S": operation_id}}), "--output", "json"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    operation_item = json.loads(authoritative.stdout).get("Item") or {}
    state = json.loads(operation_item.get("payload", {}).get("S", ""))
except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as error:
    raise SystemExit("resume operation authority could not be verified") from error
if state.get("id", state.get("operationId")) != operation_id or state.get("status") != "running":
    raise SystemExit("resume intent is not bound to a running authoritative operation")
if state.get("type") == "resume":
    if state.get("executionToken") != owner_token:
        raise SystemExit("resume intent executor ownership changed")
elif state.get("kind") == "mc-aws-host-replacement":
    if state.get("operationOwnerId") != owner_token:
        raise SystemExit("replacement resume intent executor ownership changed")
else:
    raise SystemExit("resume intent operation kind is invalid")
operation_intent = state.get("resumeIntent")
if not isinstance(operation_intent, dict) or operation_intent.get("mode") != intent.get("mode"):
    raise SystemExit("resume intent does not match the authoritative operation")
if operation_intent.get("backupArchiveName") != intent.get("backupArchiveName"):
    raise SystemExit("resume intent backup selection changed")
mode = intent.get("mode")
backup_name = intent.get("backupArchiveName")
if mode in ("named", "replacement-convergence") and (not isinstance(backup_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz", backup_name)):
    raise SystemExit("resume intent backup archive is invalid")
if mode in ("fresh", "latest") and backup_name is not None:
    raise SystemExit("resume intent backup selection is invalid")
boot_id = boot_id_file.read_text(encoding="ascii").strip()
if not boot_id:
    raise SystemExit("boot identity is unavailable")
if hold.exists() or hold.is_symlink():
    metadata = hold.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o644:
        raise SystemExit("existing maintenance boot hold has unsafe metadata")
    current = json.loads(hold.read_text(encoding="ascii"))
    if current.get("schemaVersion") != 1 or (current.get("operation") == "restore" and current.get("owner") == operation_id):
        if current.get("operation") == "restore" and current.get("owner") == operation_id:
            print(operation_id)
            raise SystemExit(0)
        raise SystemExit("existing maintenance boot hold is malformed")
    if (mode != "replacement-convergence" or current.get("operation") != "host-replacement"
            or current.get("phase") != "publishing-manifest" or current.get("owner") != intent.get("maintenanceOwner")
            or current.get("attempt") != intent.get("quiescenceEpoch")):
        raise SystemExit("maintenance boot hold belongs to another preservation transaction")
value = {"schemaVersion": 1, "operation": "restore", "owner": operation_id, "attempt": operation_id, "phase": "prepared", "bootId": boot_id}
hold.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
descriptor, temporary = tempfile.mkstemp(prefix=f".{hold.name}.", dir=hold.parent)
try:
    os.fchmod(descriptor, 0o644)
    with os.fdopen(descriptor, "wb") as output:
        output.write((json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii"))
        output.flush(); os.fsync(output.fileno())
    os.replace(temporary, hold)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
directory = os.open(hold.parent, os.O_RDONLY | os.O_DIRECTORY)
try: os.fsync(directory)
finally: os.close(directory)
print(operation_id)
PY
)" || { log "ERROR: Could not establish durable resume boot inhibition"; exit 1; }
  if [[ -n "$resume_operation_id" ]]; then resume_pending=1; fi
elif grep -q "ResourceNotFoundException" /tmp/resume-intent-error; then
  log "ERROR: Resume operation authority table is unavailable"
  exit 1
else
  log "ERROR: Could not determine whether a resume is pending"
  exit 1
fi
rm -f /tmp/resume-intent-error "$resume_intent_file"

if [[ ! "$GDRIVE_REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || [[ -z "$GDRIVE_ROOT" || "$GDRIVE_ROOT" == *$'\n'* || "$GDRIVE_ROOT" == *$'\r'* ]]; then
  log "ERROR: Invalid Google Drive destination"
  exit 1
fi
printf '%s\n' "$GDRIVE_REMOTE" > /etc/minecraft/gdrive-remote
printf '%s\n' "$GDRIVE_ROOT" > /etc/minecraft/gdrive-root
chmod 0644 /etc/minecraft/gdrive-remote /etc/minecraft/gdrive-root

bootstrap="$(mktemp -d /opt/.mc-bootstrap.XXXXXX)"
cleanup_bootstrap() {
  local exit_code=$?
  local cleanup_code
  trap - EXIT
  set +e
  rm -rf -- "$bootstrap"
  cleanup_code=$?
  (( exit_code != 0 )) || exit_code="$cleanup_code"
  bootstrap_failed "$exit_code"
  exit "$exit_code"
}
trap cleanup_bootstrap EXIT
manifest="$bootstrap/manifest.json"
aws ssm get-parameter --name "$PROFILE_MANIFEST_PARAMETER" --query Parameter.Value --output text > "$manifest"
readarray -t release_asset < <(python3 - "$manifest" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
if set(value) != {"version", "hostRelease", "profile"} or value["version"] != 3:
    raise SystemExit("invalid profile asset manifest")
item = value["hostRelease"]
if set(item) != {"uri", "sha256", "bytes", "releaseManifestSha256", "releaseManifestBytes"} or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) or not re.fullmatch(r"[a-f0-9]{64}", item["releaseManifestSha256"]) or not isinstance(item["bytes"], int) or item["bytes"] < 1 or item["bytes"] > 67108864 or not isinstance(item["releaseManifestBytes"], int) or not re.fullmatch(r"s3://[^/]+/[A-Za-z0-9!_.*'()/-]+", item["uri"]):
    raise SystemExit("invalid host release asset")
print(item["uri"]); print(item["sha256"]); print(item["bytes"]); print(item["releaseManifestSha256"]); print(item["releaseManifestBytes"])
PY
)
(( ${#release_asset[@]} == 5 )) || { log "ERROR: invalid host release manifest"; exit 1; }
release_uri="${release_asset[0]}"; release_sha256="${release_asset[1]}"; release_bytes="${release_asset[2]}"; release_manifest_sha256="${release_asset[3]}"; release_manifest_bytes="${release_asset[4]}"
aws s3 cp --only-show-errors "$release_uri" "$bootstrap/host-release.zip"
[[ "$(stat -c '%s' -- "$bootstrap/host-release.zip")" == "$release_bytes" ]] || { log "ERROR: host release size mismatch"; exit 1; }
printf '%s  %s\n' "$release_sha256" "$bootstrap/host-release.zip" | sha256sum --check --status || { log "ERROR: host release checksum mismatch"; exit 1; }
python3 - "$bootstrap/host-release.zip" "$bootstrap/host-release" "$release_manifest_sha256" "$release_manifest_bytes" <<'PY'
import hashlib, os, shutil, stat, sys, zipfile
from pathlib import PurePosixPath
archive, destination, manifest_hash, manifest_bytes = sys.argv[1:]; os.mkdir(destination)
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > 128 or sum(entry.file_size for entry in entries) > 157286400:
        raise SystemExit("runtime archive limits exceeded")
    seen = set()
    for entry in entries:
        name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
        path = PurePosixPath(name); mode = entry.external_attr >> 16
        if path.parts in seen or entry.file_size > 32 * 1024 * 1024:
            raise SystemExit("duplicate or oversized host release archive entry")
        seen.add(path.parts)
        if not name or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise SystemExit("unsafe host release archive entry")
    for entry in entries:
        name = entry.filename[:-1] if entry.filename.endswith("/") else entry.filename
        target = destination.joinpath(*PurePosixPath(name).parts)
        if entry.is_dir(): raise SystemExit("host release directories are not allowed")
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with source.open(entry) as incoming, os.fdopen(descriptor, "wb") as outgoing: shutil.copyfileobj(incoming, outgoing)
data = open(os.path.join(destination, "release-manifest.json"), "rb").read()
if len(data) != int(manifest_bytes) or hashlib.sha256(data).hexdigest() != manifest_hash:
    raise SystemExit("host release manifest digest or size mismatch")
PY
chmod 0755 "$bootstrap/host-release/host/mc-profile-install.sh"
"$bootstrap/host-release/host/mc-profile-install.sh" --bootstrap --release-root "$bootstrap/host-release" --bootstrap-pins-sha256 "$MC_BOOTSTRAP_PINS_SHA256" --manifest-file "$manifest"
readarray -t agent_runtime < <(python3 - "$bootstrap/host-release/release-manifest.json" <<'PY'
import json, sys
item = json.load(open(sys.argv[1], encoding="utf-8"))["agentRuntime"]
print(item["sha256"]); print(item["bytes"]); print(item["bundleManifestSha256"])
PY
)
(( ${#agent_runtime[@]} == 3 )) || { log "ERROR: invalid agent runtime release member"; exit 1; }

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-filesize 67108864 --output "$bootstrap/node.tar.xz" "$NODE_ARM64_URL"
printf '%s  %s\n' "$NODE_ARM64_SHA256" "$bootstrap/node.tar.xz" | sha256sum --check --status || { log "ERROR: Node archive checksum mismatch"; exit 1; }
/usr/local/bin/mc-agent-install.sh install \
  "$bootstrap/node.tar.xz" "$NODE_ARM64_SHA256" "$(stat -c '%s' -- "$bootstrap/node.tar.xz")" \
  /opt/mc-agent/agent-runtime.zip "${agent_runtime[0]}" "${agent_runtime[1]}" "${agent_runtime[2]}"

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
  printf 'node-arm64 %s\n' "$NODE_ARM64_SHA256"
} >> /var/lib/mc-aws/runtime-hashes.sha256
chmod 0644 /var/lib/mc-aws/runtime-hashes.sha256
systemctl daemon-reload
/usr/local/bin/mc-agent-world-roots.py verify
if (( resume_pending == 1 )); then
  log "DynamoDB resume intent detected; bootstrap completed without starting DNS or Minecraft"
else
  systemctl start minecraft.service
  MC_READY_REQUIRE_BOOTSTRAP_MARKER=0 /usr/local/bin/mc-wait-ready.sh raw_ip '' ''
fi
touch "$BOOTSTRAP_MARKER"
chmod 0644 "$BOOTSTRAP_MARKER"
systemctl enable minecraft.service minecraft-dns.service
