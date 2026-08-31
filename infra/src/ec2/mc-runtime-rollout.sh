#!/usr/bin/env bash
# Idempotently apply the exact reviewed bootstrap artifacts to an existing host.
# UserData is launch-only; this is the supported in-place maintenance path.
set -euo pipefail
umask 077

readonly MC_BOOTSTRAP_PINS_SHA256="4caf08790154b32ae4d9948e9829b95811146022d30325e5fed2406881527bdd"
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

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "${1:-}" == "--confirm-pins" && "${2:-}" == "$MC_BOOTSTRAP_PINS_SHA256" && -z "${3:-}" ]] ||
  fail "exact --confirm-pins $MC_BOOTSTRAP_PINS_SHA256 is required"
[[ "$(id -u)" == "0" ]] || fail "runtime rollout must run as root"
for command in curl flock install python3 sha256sum systemctl unzip; do command -v "$command" >/dev/null || fail "missing $command"; done

exec 9>/run/lock/mc-aws-runtime-rollout.lock
flock -n 9 || fail "another runtime rollout is active"
work="$(mktemp -d /opt/.mc-runtime-rollout.XXXXXX)"
was_active=0
stopped=0
cleanup() {
  status=$?
  rm -rf -- "$work"
  if (( status != 0 && was_active == 1 && stopped == 1 )); then systemctl start minecraft.service || true; fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

download() {
  local url="$1" digest="$2" destination="$3"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$destination" "$url"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status || fail "artifact checksum mismatch"
}

download "$PAPER_URL" "$PAPER_SHA256" "$work/paper.jar"
download "$RCLONE_URL" "$RCLONE_SHA256" "$work/rclone.zip"
download "$MCSTATUS_URL" "$MCSTATUS_SHA256" "$work/mcstatus-12.0.2-py3-none-any.whl"
download "$ASYNCIO_DGRAM_URL" "$ASYNCIO_DGRAM_SHA256" "$work/asyncio_dgram-2.2.0-py3-none-any.whl"
download "$DNSPYTHON_URL" "$DNSPYTHON_SHA256" "$work/dnspython-2.7.0-py3-none-any.whl"
unzip -q "$work/rclone.zip" -d "$work/rclone"
printf '%s  %s\n' "$RCLONE_SHA256" "$work/rclone.zip" | sha256sum --check --status

if systemctl is-active --quiet minecraft.service; then was_active=1; fi
if (( was_active == 1 )); then systemctl stop minecraft.service; stopped=1; fi

# Keep reversible copies until every exact artifact and readiness check succeeds.
[[ ! -f /opt/minecraft/server/paper.jar ]] || cp -p -- /opt/minecraft/server/paper.jar "$work/paper.previous"
[[ ! -f /usr/local/bin/rclone ]] || cp -p -- /usr/local/bin/rclone "$work/rclone.previous"
rollback_files() {
  [[ ! -f "$work/paper.previous" ]] || install -o minecraft -g minecraft -m 0644 "$work/paper.previous" /opt/minecraft/server/paper.jar
  [[ ! -f "$work/rclone.previous" ]] || install -o root -g root -m 0755 "$work/rclone.previous" /usr/local/bin/rclone
}
trap 'rollback_files; cleanup' EXIT HUP INT TERM

install -o minecraft -g minecraft -m 0644 "$work/paper.jar" /opt/minecraft/server/paper.jar
install -o root -g root -m 0755 "$work/rclone/rclone-v${RCLONE_VERSION}-linux-arm64/rclone" /usr/local/bin/rclone
python3 -m pip install --disable-pip-version-check --no-index --no-deps --force-reinstall \
  "$work/asyncio_dgram-2.2.0-py3-none-any.whl" \
  "$work/dnspython-2.7.0-py3-none-any.whl" \
  "$work/mcstatus-12.0.2-py3-none-any.whl"
cat > /usr/local/bin/mcstatus <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec python3 -m mcstatus "$@"
SH
chmod 0755 /usr/local/bin/mcstatus
python3 - "$MCSTATUS_VERSION" "$ASYNCIO_DGRAM_VERSION" "$DNSPYTHON_VERSION" <<'PY'
import importlib.metadata, sys
expected = {"mcstatus": sys.argv[1], "asyncio-dgram": sys.argv[2], "dnspython": sys.argv[3]}
actual = {name: importlib.metadata.version(name) for name in expected}
if actual != expected:
    raise SystemExit(f"installed Python versions do not match reviewed pins: {actual}")
PY
/usr/local/bin/rclone version | grep -Fq "rclone v${RCLONE_VERSION}" || fail "installed rclone version is wrong"

install -d -o root -g root -m 0755 /var/lib/mc-aws
{
  printf 'pins %s\n' "$MC_BOOTSTRAP_PINS_SHA256"
  printf 'paper %s\n' "$(sha256sum /opt/minecraft/server/paper.jar | cut -d ' ' -f 1)"
  printf 'rclone %s\n' "$(sha256sum /usr/local/bin/rclone | cut -d ' ' -f 1)"
  printf 'mc-wait-ready %s\n' "$(sha256sum /usr/local/bin/mc-wait-ready.sh | cut -d ' ' -f 1)"
  printf 'mc-runtime-rollout %s\n' "$(sha256sum /usr/local/bin/mc-runtime-rollout.sh | cut -d ' ' -f 1)"
} > "$work/runtime-hashes"
grep -Fxq "paper $PAPER_SHA256" "$work/runtime-hashes" || fail "installed Paper hash is wrong"
install -o root -g root -m 0644 "$work/runtime-hashes" /var/lib/mc-aws/runtime-hashes.sha256

if (( was_active == 1 )); then
  systemctl start minecraft.service
  stopped=0
  /usr/local/bin/mc-wait-ready.sh "${MC_DNS_MODE:-raw_ip}" "${MC_DNS_HOSTNAME:-}" "${MC_EXPECTED_PUBLIC_IP:-}"
fi
trap cleanup EXIT HUP INT TERM
printf 'Runtime rollout verified: pins=%s\n' "$MC_BOOTSTRAP_PINS_SHA256"
