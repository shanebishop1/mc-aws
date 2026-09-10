#!/usr/bin/env bash
# Build the reviewed, static ARM64 BusyBox shell from already-acquired inputs.
# This recipe never downloads inputs and never installs into a host namespace.
set -euo pipefail
umask 077

readonly VERSION=1.38.0
readonly SOURCE_SHA256=34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2
readonly SIGNER_FINGERPRINT=C9E9416F76E610DBD09D040F47B70C55ACC9965B
readonly SOURCE_URL=https://busybox.net/downloads/busybox-1.38.0.tar.bz2
readonly SIGNATURE_URL=https://busybox.net/downloads/busybox-1.38.0.tar.bz2.sig
readonly PUBLIC_KEY_URL=https://busybox.net/~vda/vda_pubkey.gpg
readonly SOURCE_NAME=busybox-1.38.0.tar.bz2
readonly SIGNATURE_NAME=busybox-1.38.0.tar.bz2.sig
readonly PUBLIC_KEY_NAME=vda_pubkey.gpg
readonly CONFIG_FRAGMENT_NAME=busybox-1.38.0.config.fragment
readonly CONFIG_NAME=busybox-1.38.0.config
readonly RECIPE_NAME=build-shell-toolchain.sh
readonly TOOLCHAIN_LOCK_NAME=shell-toolchain-lock.json
readonly MAX_SOURCE_BYTES=$((64 * 1024 * 1024))
readonly MAX_BINARY_BYTES=$((16 * 1024 * 1024))
readonly MAX_CONFIG_BYTES=$((256 * 1024))
readonly MAX_RECIPE_BYTES=$((256 * 1024))
readonly EXPECTED_APPLETS="$(printf '%s\n' ash awk basename cat chmod chown cmp cp cut date dd df dirname echo env expr false find grep head id kill ln ls mkdir mktemp mv printenv printf pwd readlink realpath rm rmdir sed seq sh sleep sort stat tail tee test touch tr true uname uniq wc which xargs)"
readonly TOOLCHAIN_METADATA_MAX_BYTES=$((256 * 1024))
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() { fail "Usage: build-shell-toolchain.sh --source-archive <file> --signature <file> --public-key <file> --output <directory>"; }

SOURCE_ARCHIVE=""
SIGNATURE=""
PUBLIC_KEY=""
OUTPUT=""
while (( $# > 0 )); do
  case "$1" in
    --source-archive) (( $# >= 2 )) || usage; SOURCE_ARCHIVE="$2"; shift 2 ;;
    --signature) (( $# >= 2 )) || usage; SIGNATURE="$2"; shift 2 ;;
    --public-key) (( $# >= 2 )) || usage; PUBLIC_KEY="$2"; shift 2 ;;
    --output) (( $# >= 2 )) || usage; OUTPUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$SOURCE_ARCHIVE" && -n "$SIGNATURE" && -n "$PUBLIC_KEY" && -n "$OUTPUT" ]] || usage

for command in awk bzip2 cp file gcc getconf gpg grep install ld make mkdir mv python3 readelf rm sha256sum stat tar uname; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
[[ "$(uname -m)" == "aarch64" ]] || fail "the reviewed build must run natively on ARM64"
[[ "$(gcc -dumpmachine)" == aarch64-linux-gnu ]] || fail "the reviewed compiler target is not aarch64-linux-gnu"
[[ "$(gcc -dumpfullversion -dumpversion)" == 13.3.0 ]] || fail "GCC 13.3.0 is required"
[[ "$(getconf GNU_LIBC_VERSION)" == 'glibc 2.39' ]] || fail "glibc 2.39 is required"
[[ "$(ld -v)" == *' 2.42'* ]] || fail "binutils 2.42 is required"

for input in "$SOURCE_ARCHIVE" "$SIGNATURE" "$PUBLIC_KEY"; do
  [[ -f "$input" && ! -L "$input" ]] || fail "input is not a regular file: $input"
done
[[ "$(stat -c '%s' -- "$SOURCE_ARCHIVE")" -gt 0 && "$(stat -c '%s' -- "$SOURCE_ARCHIVE")" -le "$MAX_SOURCE_BYTES" ]] || fail "source archive size is unsafe"
printf '%s  %s\n' "$SOURCE_SHA256" "$SOURCE_ARCHIVE" | sha256sum --check --status || fail "BusyBox source SHA-256 mismatch"

verification_home="$(mktemp -d "${TMPDIR:-/tmp}/mc-busybox-gpg.XXXXXX")"
build_work="$(mktemp -d "${TMPDIR:-/tmp}/mc-busybox-build.XXXXXX")"
cleanup() { rm -rf -- "$verification_home" "$build_work"; }
trap cleanup EXIT
chmod 700 "$verification_home"
GNUPGHOME="$verification_home" gpg --batch --import "$PUBLIC_KEY" >/dev/null 2>&1 || fail "BusyBox signing key import failed"
fingerprint="$(GNUPGHOME="$verification_home" gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" {print $10; exit}')"
[[ "$fingerprint" == "$SIGNER_FINGERPRINT" ]] || fail "BusyBox signing key fingerprint mismatch"
verification_status="$build_work/signature.status"
GNUPGHOME="$verification_home" gpg --batch --status-fd=1 --verify "$SIGNATURE" "$SOURCE_ARCHIVE" >"$verification_status" 2>/dev/null || fail "BusyBox detached signature verification failed"
grep -Fq "[GNUPG:] VALIDSIG $SIGNER_FINGERPRINT " "$verification_status" || fail "BusyBox signature signer mismatch"

source_root="$build_work/source"
mkdir "$source_root"
python3 - "$SOURCE_ARCHIVE" "$source_root" <<'PY'
import os, pathlib, stat, sys, tarfile
archive, destination = map(pathlib.Path, sys.argv[1:])
with tarfile.open(archive, "r:bz2") as source:
    members = source.getmembers()
    if len(members) < 1 or len(members) > 10000:
        raise SystemExit("BusyBox source archive member count is unsafe")
    top = None
    for member in members:
        parts = pathlib.PurePosixPath(member.name).parts
        if not parts or any(part in ("", ".", "..") for part in parts) or pathlib.PurePosixPath(member.name).is_absolute():
            raise SystemExit("BusyBox source archive contains an unsafe path")
        if top is None:
            top = parts[0]
        if parts[0] != top or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
            raise SystemExit("BusyBox source archive contains an unsupported entry")
    if top != "busybox-1.38.0":
        raise SystemExit("BusyBox source archive root is not busybox-1.38.0")
    source.extractall(destination, filter="data")
PY

fragment="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../config" && pwd -P)/$CONFIG_FRAGMENT_NAME"
[[ -f "$fragment" && ! -L "$fragment" ]] || fail "reviewed BusyBox config fragment is missing"
toolchain_lock="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../agent-runtime" && pwd -P)/$TOOLCHAIN_LOCK_NAME"
[[ -f "$toolchain_lock" && ! -L "$toolchain_lock" ]] || fail "reviewed BusyBox toolchain lock is missing"
[[ "$(stat -c '%s' -- "$fragment")" -le "$TOOLCHAIN_METADATA_MAX_BYTES" ]] || fail "reviewed BusyBox config fragment is oversized"
[[ "$(stat -c '%s' -- "${BASH_SOURCE[0]}")" -le "$TOOLCHAIN_METADATA_MAX_BYTES" ]] || fail "reviewed BusyBox build recipe is oversized"
mkdir "$build_work/out"
env -u MAKEFLAGS KCONFIG_NOTIMESTAMP=1 KBUILD_BUILD_USER=mc-aws KBUILD_BUILD_HOST=mc-aws \
  make -C "$source_root/busybox-$VERSION" O="$build_work/out" allnoconfig >/dev/null
python3 - "$build_work/out/.config" "$fragment" <<'PY'
from pathlib import Path
import sys
config, fragment = map(Path, sys.argv[1:])
values = {}
for raw in fragment.read_text(encoding="ascii").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    key, value = line.split("=", 1)
    if value not in ("y", "n"):
        raise SystemExit(f"unsupported config fragment value: {line}")
    values[key] = value
lines = config.read_text(encoding="ascii").splitlines()
seen = set()
output = []
for raw in lines:
    key = None
    if raw.startswith("CONFIG_") and "=" in raw:
        key = raw.split("=", 1)[0]
    elif raw.startswith("# CONFIG_") and raw.endswith(" is not set"):
        key = raw[2:-len(" is not set")]
    if key in values:
        value = values[key]
        output.append(f"{key}={value}" if value == "y" else f"# {key} is not set")
        seen.add(key)
    else:
        output.append(raw)
for key, value in values.items():
    if key not in seen:
        output.append(f"{key}={value}" if value == "y" else f"# {key} is not set")
config.write_text("\n".join(output) + "\n", encoding="ascii")
PY
printf '\n' | env -u MAKEFLAGS KCONFIG_NOTIMESTAMP=1 KBUILD_BUILD_USER=mc-aws KBUILD_BUILD_HOST=mc-aws \
  make -C "$source_root/busybox-$VERSION" O="$build_work/out" oldconfig >/dev/null
# BusyBox 1.38.0's out-of-tree build still includes this header from the
# source tree. Replace the generated source-tree copy with the timestamp-free
# reviewed header before compiling so repeated builds have identical bytes.
install -m 0644 "$build_work/out/include/autoconf.h" "$source_root/busybox-$VERSION/include/autoconf.h"
env -u MAKEFLAGS KCONFIG_NOTIMESTAMP=1 KBUILD_BUILD_USER=mc-aws KBUILD_BUILD_HOST=mc-aws \
  make -C "$source_root/busybox-$VERSION" O="$build_work/out" -j2 busybox >/dev/null

binary="$build_work/out/busybox"
[[ -f "$binary" && ! -L "$binary" ]] || fail "BusyBox ELF was not produced"
[[ "$(stat -c '%s' -- "$binary")" -le "$MAX_BINARY_BYTES" ]] || fail "BusyBox ELF is oversized"
file_output="$(file -b "$binary")"
[[ "$file_output" == *'ELF 64-bit LSB executable, ARM aarch64'* && "$file_output" == *'statically linked'* ]] || fail "BusyBox ELF is not static ARM64"
if readelf -lW "$binary" | grep -q ' INTERP '; then fail "static BusyBox ELF has PT_INTERP"; fi
if readelf -dW "$binary" | grep -q " (NEEDED) "; then fail "static BusyBox ELF has DT_NEEDED"; fi
applets="$($binary --list)"
[[ "$applets" == "$EXPECTED_APPLETS" ]] || fail "BusyBox applet inventory drifted"
install -d -m 0755 "$OUTPUT/bin" "$OUTPUT/src" "$OUTPUT/build"
install -m 0755 "$binary" "$OUTPUT/bin/sh"
install -m 0644 "$SOURCE_ARCHIVE" "$OUTPUT/src/$SOURCE_NAME"
install -m 0644 "$SIGNATURE" "$OUTPUT/src/$SIGNATURE_NAME"
install -m 0644 "$PUBLIC_KEY" "$OUTPUT/src/$PUBLIC_KEY_NAME"
[[ "$(stat -c '%s' -- "$build_work/out/.config")" -le "$TOOLCHAIN_METADATA_MAX_BYTES" ]] || fail "generated BusyBox config is oversized"
install -m 0644 "$build_work/out/.config" "$OUTPUT/build/$CONFIG_NAME"
install -m 0644 "$fragment" "$OUTPUT/build/$CONFIG_FRAGMENT_NAME"
install -m 0755 "${BASH_SOURCE[0]}" "$OUTPUT/build/$RECIPE_NAME"
install -m 0644 "$toolchain_lock" "$OUTPUT/build/$TOOLCHAIN_LOCK_NAME"
chmod 0755 "$OUTPUT" "$OUTPUT/bin" "$OUTPUT/src" "$OUTPUT/build"

payload_manifest="$OUTPUT/shell-toolchain.json"
python3 - "$payload_manifest" "$OUTPUT" "$SOURCE_URL" "$SIGNATURE_URL" "$PUBLIC_KEY_URL" "$SIGNER_FINGERPRINT" "$applets" <<'PY'
import hashlib, json, pathlib, stat, sys
manifest_path, root, source_url, signature_url, key_url, fingerprint, applets = sys.argv[1:]
manifest_path = pathlib.Path(manifest_path)
root = pathlib.Path(root)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
size = lambda path: path.stat().st_size
source = root / "src/busybox-1.38.0.tar.bz2"
signature = root / "src/busybox-1.38.0.tar.bz2.sig"
key = root / "src/vda_pubkey.gpg"
config = root / "build/busybox-1.38.0.config"
fragment = root / "build/busybox-1.38.0.config.fragment"
recipe = root / "build/build-shell-toolchain.sh"
binary = root / "bin/sh"
expected_applets = applets.splitlines()
manifest = {
    "schemaVersion": 1,
    "platform": "linux-arm64",
    "source": {
        "path": "/toolchain/src/busybox-1.38.0.tar.bz2",
        "bytes": size(source),
        "sha256": sha(source),
        "url": source_url,
        "signature": {
            "path": "/toolchain/src/busybox-1.38.0.tar.bz2.sig",
            "bytes": size(signature),
            "sha256": sha(signature),
            "url": signature_url,
            "signerFingerprint": fingerprint,
        },
        "publicKey": {
            "path": "/toolchain/src/vda_pubkey.gpg",
            "bytes": size(key),
            "sha256": sha(key),
            "url": key_url,
        },
        "license": "GPL-2.0-only",
    },
    "build": {
        "version": "1.38.0",
        "compiler": "gcc 13.3.0",
        "libc": "glibc 2.39",
        "binutils": "binutils 2.42",
        "configPath": "/toolchain/build/busybox-1.38.0.config",
        "configBytes": size(config),
        "configSha256": sha(config),
        "configFragmentPath": "/toolchain/build/busybox-1.38.0.config.fragment",
        "configFragmentBytes": size(fragment),
        "configFragmentSha256": sha(fragment),
        "recipePath": "/toolchain/build/build-shell-toolchain.sh",
        "recipeBytes": size(recipe),
        "recipeSha256": sha(recipe),
        "static": True,
        "standaloneApplets": True,
        "licenseStatus": "local-disposable-testing-only;-public-distribution-blocked",
        "licenseNote": "BusyBox source is retained; static glibc corresponding-source obligations are not staged.",
    },
    "applets": expected_applets,
    "executables": [{
        "name": "sh",
        "path": "/toolchain/bin/sh",
        "bytes": size(binary),
        "sha256": sha(binary),
        "mode": "0755",
    }],
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="ascii")
PY
chmod 0644 "$payload_manifest"
printf '%s\n' "$payload_manifest"
