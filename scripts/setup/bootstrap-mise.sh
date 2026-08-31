#!/usr/bin/env bash
# Install only the repository-reviewed mise binary. This must run before loading
# any deployment environment file so a remote installer never receives secrets.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PINS_FILE="${MC_AWS_MISE_PINS_FILE:-$ROOT_DIR/config/mise-pins.json}"
INSTALL_DIR="${MISE_INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_PATH="$INSTALL_DIR/mise"

fail() { printf 'mise bootstrap refused: %s\n' "$*" >&2; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is required"
  fi
}

platform_key() {
  local os architecture
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  architecture="$(uname -m)"
  case "$os:$architecture" in
    darwin:arm64) printf '%s\n' darwin-arm64 ;;
    darwin:x86_64) printf '%s\n' darwin-x64 ;;
    linux:aarch64|linux:arm64) printf '%s\n' linux-arm64 ;;
    linux:x86_64|linux:amd64) printf '%s\n' linux-x64 ;;
    *) fail "unsupported platform $os/$architecture" ;;
  esac
}

read_pin() {
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to validate the mise pin"
  python3 - "$PINS_FILE" "$1" <<'PY'
import json, re, sys, urllib.parse
path, platform = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    value = json.load(source)
if set(value) != {"schemaVersion", "version", "releaseTag", "reviewedAt", "assets", "checksumSource"}:
    raise SystemExit("mise pin has unexpected fields")
if value["schemaVersion"] != 1 or not re.fullmatch(r"\d{4}\.\d{1,2}\.\d{1,2}", value["version"]):
    raise SystemExit("mise version pin is malformed")
if value["releaseTag"] != "v" + value["version"] or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["reviewedAt"]):
    raise SystemExit("mise release identity is inconsistent")
if set(value["assets"]) != {"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"}:
    raise SystemExit("mise platform pin set is incomplete")
asset = value["assets"].get(platform)
if not isinstance(asset, dict) or set(asset) != {"url", "sha256"}:
    raise SystemExit("mise platform pin is malformed")
expected_name = {"darwin-arm64": "macos-arm64", "darwin-x64": "macos-x64", "linux-arm64": "linux-arm64", "linux-x64": "linux-x64"}[platform]
expected_url = f"https://github.com/jdx/mise/releases/download/{value['releaseTag']}/mise-{value['releaseTag']}-{expected_name}"
if asset["url"] != expected_url or not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
    raise SystemExit("mise URL/checksum pin is not exact")
checksum_url = f"https://github.com/jdx/mise/releases/download/{value['releaseTag']}/SHASUMS256.txt"
if value["checksumSource"] != checksum_url:
    raise SystemExit("mise checksum source does not match the exact release")
print("\t".join((value["version"], asset["url"], asset["sha256"])))
PY
}

config_fingerprint() { sha256_file "$PINS_FILE"; }

review() {
  local version url expected
  IFS=$'\t' read -r version url expected < <(read_pin "$(platform_key)")
  [[ -n "$version" ]] || fail "could not read mise pin"
  printf 'mise=%s config-sha256=%s\n' "$version" "$(config_fingerprint)"
}

install_pinned() {
  local version version_pattern version_output url expected actual temporary temporary_dir
  IFS=$'\t' read -r version url expected < <(read_pin "$(platform_key)")
  [[ -n "$version" && -n "$url" && -n "$expected" ]] || fail "could not read complete mise pin"
  version_pattern="${version//./\\.}"

  [[ ! -L "$INSTALL_PATH" ]] || fail "$INSTALL_PATH must not be a symlink"

  if [[ -f "$INSTALL_PATH" && ! -L "$INSTALL_PATH" ]] && [[ "$(sha256_file "$INSTALL_PATH")" == "$expected" ]]; then
    version_output="$("$INSTALL_PATH" --version 2>/dev/null)" || fail "installed mise checksum matches but version command failed"
    grep -Eq "(^|[[:space:]])${version_pattern}([[:space:]]|$)" <<< "$version_output" || fail "installed mise checksum matches but version output does not"
    export PATH="$INSTALL_DIR:$PATH"
    return
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  mkdir -p -- "$INSTALL_DIR"
  temporary_dir="$(mktemp -d "$INSTALL_DIR/.mise.download.XXXXXX")"
  temporary="$temporary_dir/mise"
  trap 'rm -rf -- "$temporary_dir"' EXIT HUP INT TERM
  curl --disable --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$temporary" "$url"
  actual="$(sha256_file "$temporary")"
  [[ "$actual" == "$expected" ]] || fail "checksum mismatch for $url (expected $expected, got $actual)"
  chmod 0755 "$temporary"
  version_output="$("$temporary" --version 2>/dev/null)" || fail "downloaded mise $version version command failed"
  grep -Eq "(^|[[:space:]])${version_pattern}([[:space:]]|$)" <<< "$version_output" || fail "downloaded binary did not report mise $version"
  mv -f -- "$temporary" "$INSTALL_PATH"
  rmdir -- "$temporary_dir"
  trap - EXIT HUP INT TERM
  export PATH="$INSTALL_DIR:$PATH"
}

command="${1:-install}"
case "$command" in
  install) install_pinned ;;
  review) review ;;
  upgrade)
    [[ "${2:-}" == "--confirm" && -n "${3:-}" && -z "${4:-}" ]] || fail "usage: $0 upgrade --confirm <mise=version config-sha256=digest>"
    expected_confirmation="$(review)"
    [[ "$3" == "$expected_confirmation" ]] || fail "confirmation mismatch; review and pass: --confirm '$expected_confirmation'"
    install_pinned
    printf 'Installed reviewed %s\n' "$expected_confirmation"
    ;;
  *) fail "usage: $0 [install|review|upgrade --confirm <review-output>]" ;;
esac
