#!/usr/bin/env python3
"""Run the bounded, shell-only G2 composition probe on one disposable target.

This is deliberately not an EC2 or lifecycle client.  It performs no AWS,
SSH, package-manager, download, or namespace setup operation.  The caller
transfers already reviewed artifacts to a disposable AL2023 ARM64 host and
invokes this program as root with a pre-created, run-id-bound target marker.

Only the two real socket-activated shell units are started.  Gateway,
executor, Minecraft, host-broker, and world-root services are not installed or
started by this probe.  A missing boundary is an error; this program never
falls back to a host shell, a mock runner, systemd-run, or a weaker unit.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import pwd
import grp
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


RUN_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
NODE_VERSION = "22.19.0"
NODE_PLATFORM = "linux-arm64"
TOOLCHAIN_FILES = {
    "bin/sh",
    "src/busybox-1.38.0.tar.bz2",
    "src/busybox-1.38.0.tar.bz2.sig",
    "src/vda_pubkey.gpg",
    "build/busybox-1.38.0.config",
    "build/busybox-1.38.0.config.fragment",
    "build/build-shell-toolchain.sh",
    "build/shell-toolchain-lock.json",
    "shell-toolchain.json",
}
REVIEWED_TOOLCHAIN_MANIFEST_BYTES = 2_678
REVIEWED_TOOLCHAIN_MANIFEST_SHA256 = "42995aec9022b04e5c11809347acbaa8b7150d9bd0d4da35a95ee3be8c2d312a"
REVIEWED_TOOLCHAIN_LOCK_BYTES = 294
REVIEWED_TOOLCHAIN_LOCK_SHA256 = "0abf0af10e87923383055304fdd167664e5a2dbab887db491e0c3e34ee5a3ffc"
REVIEWED_TOOLCHAIN_LOCK = {
    "schemaVersion": 1,
    "manifest": {"bytes": REVIEWED_TOOLCHAIN_MANIFEST_BYTES, "sha256": REVIEWED_TOOLCHAIN_MANIFEST_SHA256},
    "executable": {"path": "bin/sh", "bytes": 1_127_576, "sha256": "a00157aada30be47277accd8f4ee8e93bbc55f3ac9722dd5e7008114d86a21c2"},
}
MAX_HOST_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_RUNTIME_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_RUNTIME_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_NODE_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_NODE_MEMBERS = 10_000
MAX_SHELL_OUTPUT_BYTES = 1024 * 1024
MAX_FILES = 512
PROBE_WALLCLOCK_SECONDS = 120.0
TRUSTED_HOST_BASH = "/usr/bin/bash"
READ_SOCKET = "/run/mc-agent/shell-read.sock"
WRITE_SOCKET = "/run/mc-agent/shell-write.sock"
SERVICE_NAMES = (
    "mc-agent-tool-read.service",
    "mc-agent-tool-read.socket",
    "mc-agent-tool-write.service",
    "mc-agent-tool-write.socket",
)
SERVICE_CGROUP_ROOT = Path("/sys/fs/cgroup/system.slice")
STATIC_VERIFY_SERVICE_NAMES = ("mc-agent-tool-read.service", "mc-agent-tool-write.service")
STATIC_VERIFY_EXPECTED_DIAGNOSTICS = [
    f"{name}: Command /runtime/node-current/bin/node is not executable: No such file or directory"
    for name in STATIC_VERIFY_SERVICE_NAMES
]
STATIC_VERIFY_UNIT_RE = re.compile(r"^[A-Za-z0-9_.@:-]+\.(?:service|socket|target|mount|path|timer|slice)$")


class QualificationError(RuntimeError):
    pass


class ProbeDeadline:
    def __init__(self, seconds: float = PROBE_WALLCLOCK_SECONDS) -> None:
        if seconds <= 0:
            raise ValueError("probe wallclock bound must be positive")
        self.expires_at = time.monotonic() + seconds

    def remaining(self, label: str) -> float:
        remaining = self.expires_at - time.monotonic()
        if remaining <= 0:
            raise QualificationError(f"probe wallclock deadline exceeded during {label}")
        return remaining

    def timeout(self, requested: float, label: str) -> float:
        return min(requested, self.remaining(label))


def fixed_error_event(label: str, error: BaseException, started: float | None = None) -> dict[str, Any]:
    return {
        "label": label,
        "status": "failed",
        "exceptionClass": type(error).__name__[:64],
        "errno": error.errno if isinstance(error, OSError) else None,
        **({"elapsedMs": int((time.monotonic() - started) * 1000)} if started is not None else {}),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked_regular(path: Path, label: str, *, max_bytes: int | None = None) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise QualificationError(f"{label} is unavailable") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or path.is_symlink():
        raise QualificationError(f"{label} is not a regular, non-linked file")
    if max_bytes is not None and metadata.st_size > max_bytes:
        raise QualificationError(f"{label} exceeds its bound")
    return metadata


def checked_digest(path: Path, expected: str, expected_bytes: int, label: str, maximum: int) -> None:
    if not SHA256_RE.fullmatch(expected) or not isinstance(expected_bytes, int) or expected_bytes < 1 or expected_bytes > maximum:
        raise QualificationError(f"{label} identity arguments are invalid")
    metadata = checked_regular(path, label, max_bytes=maximum)
    if metadata.st_size != expected_bytes or sha256_file(path) != expected:
        raise QualificationError(f"{label} size or SHA-256 does not match the approved identity")


def safe_relative(name: str) -> tuple[str, ...]:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or any(part in ("", ".", "..") for part in name.split("/")):
        raise QualificationError("archive contains an unsafe path")
    return path.parts


def write_bytes(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, mode)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    os.chmod(path, mode)


def extract_host_archive(archive: Path, destination: Path) -> None:
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > 128:
            raise QualificationError("host release archive limits are exceeded")
        for entry in entries:
            parts = safe_relative(entry.filename)
            mode = entry.external_attr >> 16
            if not stat.S_ISREG(mode) or entry.is_dir():
                raise QualificationError("host release contains a directory, link, or special file")
            if entry.file_size > MAX_RUNTIME_ARCHIVE_BYTES:
                raise QualificationError("host release member is oversized")
            target = destination.joinpath(*parts)
            write_bytes(target, source.read(entry), 0o600)
            os.chmod(target, 0o755 if mode & 0o111 else 0o644)


def validate_host_release(stage: Path, manifest: dict[str, Any]) -> None:
    if set(manifest) != {"schemaVersion", "release", "releaseVersion", "packagingMode", "bootstrapPins", "files", "agentRuntime", "shellToolchain"}:
        raise QualificationError("host release manifest fields are invalid")
    if (
        manifest["schemaVersion"] != 1
        or manifest["release"] != "mc-aws-host-runtime"
        or manifest["releaseVersion"] != 1
        or manifest["packagingMode"] != "local-disposable"
    ):
        raise QualificationError("host release manifest identity is invalid")
    files = manifest["files"]
    if not isinstance(files, list) or not files:
        raise QualificationError("host release file inventory is empty")
    expected: set[str] = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "destination", "bytes", "sha256", "mode"}:
            raise QualificationError("host release member record is invalid")
        relative = item["path"]
        safe_relative(relative)
        if not (relative.startswith("host/") or relative.startswith("toolchain/")) or relative in expected:
            raise QualificationError("host release member path is outside the reviewed roots")
        if item["mode"] not in ("0644", "0755") or not isinstance(item["bytes"], int) or not SHA256_RE.fullmatch(item["sha256"]):
            raise QualificationError("host release member identity is invalid")
        path = stage.joinpath(*PurePosixPath(relative).parts)
        checked_digest(path, item["sha256"], item["bytes"], f"host release member {relative}", MAX_RUNTIME_ARCHIVE_BYTES)
        expected.add(relative)
    actual = {str(path.relative_to(stage)).replace(os.sep, "/") for path in stage.rglob("*") if path.is_file()}
    if actual != expected | {"release-manifest.json", "agent-runtime.zip"}:
        raise QualificationError("host release contains an omitted or unmanifested member")
    runtime = manifest["agentRuntime"]
    if not isinstance(runtime, dict) or set(runtime) != {"path", "bytes", "sha256", "bundleManifestSha256", "bundleManifestBytes"}:
        raise QualificationError("host release runtime identity is invalid")
    if runtime["path"] != "agent-runtime.zip":
        raise QualificationError("host release runtime path is invalid")
    checked_digest(stage / "agent-runtime.zip", runtime["sha256"], runtime["bytes"], "agent runtime archive", MAX_RUNTIME_ARCHIVE_BYTES)
    toolchain = manifest["shellToolchain"]
    if not isinstance(toolchain, dict) or set(toolchain) != {"path", "bytes", "sha256"} or toolchain["path"] != "toolchain/shell-toolchain.json":
        raise QualificationError("host release toolchain identity is invalid")
    checked_digest(stage / "toolchain/shell-toolchain.json", toolchain["sha256"], toolchain["bytes"], "shell toolchain manifest", 64 * 1024)


def validate_toolchain_layout(payload: Path) -> None:
    """Validate the prebuilt payload consumed by install-toolchain; never build it here."""
    if not payload.is_dir() or payload.is_symlink():
        raise QualificationError("shell toolchain payload is not a real directory")
    actual: set[str] = set()
    for current, directories, files in os.walk(payload, followlinks=False):
        current_path = Path(current)
        for name in directories + files:
            path = current_path / name
            relative = path.relative_to(payload).as_posix()
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise QualificationError(f"shell toolchain payload contains a link or special file: {relative}")
        actual.update((current_path / name).relative_to(payload).as_posix() for name in files)
    if actual != TOOLCHAIN_FILES:
        raise QualificationError("shell toolchain payload contains an unreviewed or missing file")
    for relative in TOOLCHAIN_FILES:
        checked_regular(payload / relative, f"shell toolchain payload member {relative}", max_bytes=64 * 1024 * 1024)
    checked_digest(
        payload / "shell-toolchain.json",
        REVIEWED_TOOLCHAIN_MANIFEST_SHA256,
        REVIEWED_TOOLCHAIN_MANIFEST_BYTES,
        "shell toolchain manifest",
        256 * 1024,
    )
    checked_digest(
        payload / "build/shell-toolchain-lock.json",
        REVIEWED_TOOLCHAIN_LOCK_SHA256,
        REVIEWED_TOOLCHAIN_LOCK_BYTES,
        "shell toolchain lock",
        256 * 1024,
    )
    try:
        lock = json.loads((payload / "build/shell-toolchain-lock.json").read_text(encoding="ascii"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise QualificationError("shell toolchain lock is malformed") from error
    if lock != REVIEWED_TOOLCHAIN_LOCK:
        raise QualificationError("shell toolchain lock is not the reviewed repository pin")
    executable = lock["executable"]
    checked_digest(payload / "bin/sh", executable["sha256"], executable["bytes"], "shell toolchain executable", 16 * 1024 * 1024)
    if not stat.S_IMODE((payload / "bin/sh").stat().st_mode) & 0o111:
        raise QualificationError("prebuilt shell tool is not executable")
    if not stat.S_IMODE((payload / "build/build-shell-toolchain.sh").stat().st_mode) & 0o111:
        raise QualificationError("prebuilt shell recipe is not executable")


def normalized_tar_member_name(member: tarfile.TarInfo) -> str:
    if member.isdir() and member.name.endswith("/"):
        return member.name[:-1]
    return member.name


def runtime_manifest_from_archive(archive: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > MAX_FILES or sum(item.file_size for item in entries) > MAX_RUNTIME_EXPANDED_BYTES:
            raise QualificationError("runtime archive limits are exceeded")
        names = {entry.filename for entry in entries}
        if "runtime-manifest.json" not in names or "bundle-manifest.json" not in names:
            raise QualificationError("runtime archive manifests are missing")
        runtime = json.loads(source.read("runtime-manifest.json"))
        bundle = json.loads(source.read("bundle-manifest.json"))
    node = runtime.get("node") if isinstance(runtime, dict) else None
    if not isinstance(runtime, dict) or not isinstance(node, dict) or runtime.get("schemaVersion") != 1 or node.get("version") != NODE_VERSION or node.get("platform") != NODE_PLATFORM:
        raise QualificationError("packaged runtime Node pin is not the approved exact ARM64 pin")
    if node.get("url") != "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz" or not SHA256_RE.fullmatch(node.get("sha256", "")):
        raise QualificationError("packaged runtime Node source or digest is invalid")
    if not isinstance(bundle, dict) or set(bundle) != {"schemaVersion", "nodeVersion", "piVersion", "files"} or bundle.get("schemaVersion") != 1 or bundle.get("nodeVersion") != NODE_VERSION:
        raise QualificationError("runtime bundle manifest identity is invalid")
    if not isinstance(bundle["files"], list) or len(bundle["files"]) != len(entries) - 1:
        raise QualificationError("runtime bundle file inventory does not match the archive")
    return runtime, bundle


def install_runtime_archive(archive: Path, destination: Path, expected_manifest_sha: str, expected_manifest_bytes: int) -> None:
    if not SHA256_RE.fullmatch(expected_manifest_sha):
        raise QualificationError("runtime bundle manifest digest is invalid")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        bundle_bytes = source.read("bundle-manifest.json")
        if len(bundle_bytes) != expected_manifest_bytes or hashlib.sha256(bundle_bytes).hexdigest() != expected_manifest_sha:
            raise QualificationError("runtime bundle manifest digest or size does not match the release")
        bundle = json.loads(bundle_bytes)
        by_name = {entry.filename: entry for entry in entries}
        for entry in entries:
            mode = entry.external_attr >> 16
            safe_relative(entry.filename)
            if entry.is_dir() or not stat.S_ISREG(mode):
                raise QualificationError("runtime archive contains a link or special file")
        expected_names: set[str] = set()
        for item in bundle["files"]:
            if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256", "mode"} or item["mode"] not in ("0644", "0755"):
                raise QualificationError("runtime bundle member record is invalid")
            relative = item["path"]
            safe_relative(relative)
            if relative in expected_names or relative not in by_name:
                raise QualificationError("runtime bundle member inventory is inconsistent")
            entry = by_name[relative]
            if entry.file_size != item["bytes"] or hashlib.sha256(source.read(entry)).hexdigest() != item["sha256"]:
                raise QualificationError("runtime bundle member digest or size mismatch")
            expected_names.add(relative)
        if set(by_name) != expected_names | {"runtime-manifest.json", "bundle-manifest.json"}:
            raise QualificationError("runtime bundle contains an unmanifested file")
        destination.mkdir(mode=0o755, parents=True, exist_ok=False)
        for relative in sorted(expected_names | {"runtime-manifest.json"}):
            entry = by_name[relative]
            write_bytes(destination.joinpath(*PurePosixPath(relative).parts), source.read(entry), 0o755 if relative.endswith("-cli.mjs") else 0o644)
        write_bytes(destination / "bundle-manifest.json", bundle_bytes, 0o644)


def install_node_archive(
    archive: Path,
    destination: Path,
    expected_sha: str,
    expected_bytes: int,
    deadline: ProbeDeadline | None = None,
) -> None:
    checked_digest(archive, expected_sha, expected_bytes, "Node archive", MAX_NODE_ARCHIVE_BYTES)
    destination.mkdir(mode=0o755, parents=True, exist_ok=False)
    member_name = f"node-v{NODE_VERSION}-linux-arm64/bin/node"
    license_name = f"node-v{NODE_VERSION}-linux-arm64/LICENSE"
    found = False
    license_found = False
    with tarfile.open(archive, mode="r:xz") as source:
        members = source.getmembers()
        if not members or len(members) > MAX_NODE_MEMBERS:
            raise QualificationError("Node archive limits are exceeded")
        for member in members:
            member_name_on_disk = normalized_tar_member_name(member)
            safe_relative(member_name_on_disk)
            if member_name_on_disk != member_name:
                if member_name_on_disk == license_name:
                    if not member.isfile() or member.size < 1 or member.size > 1024 * 1024:
                        raise QualificationError("Node LICENSE member is invalid")
                    incoming = source.extractfile(member)
                    if incoming is None:
                        raise QualificationError("Node LICENSE member is missing")
                    write_bytes(destination / "LICENSE", incoming.read(), 0o644)
                    license_found = True
                continue
            if not member.isfile() or member.size < 1 or member.size > 128 * 1024 * 1024:
                raise QualificationError("Node binary member is invalid")
            incoming = source.extractfile(member)
            if incoming is None:
                raise QualificationError("Node binary member is missing")
            write_bytes(destination / "bin" / "node", incoming.read(), 0o755)
            found = True
    if not found or not license_found:
        raise QualificationError("exact Node ARM64 binary member is missing")
    try:
        version = subprocess.run(
            [str(destination / "bin" / "node"), "--version"],
            capture_output=True,
            text=True,
            timeout=deadline.timeout(10, "Node version verification") if deadline else 10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise QualificationError("staged Node version verification could not complete") from error
    if version.returncode != 0 or version.stdout.strip() != f"v{NODE_VERSION}":
        raise QualificationError("staged Node binary did not report the exact approved version")


def trusted_installer_command(installer: Path, payload: Path, manifest_sha256: str, manifest_bytes: int) -> list[str]:
    return [TRUSTED_HOST_BASH, str(installer), "install-toolchain", str(payload), manifest_sha256, str(manifest_bytes)]


def run_process(
    label: str,
    arguments: list[str],
    events: list[dict[str, Any]],
    *,
    timeout: float = 30.0,
    deadline: ProbeDeadline | None = None,
) -> str:
    started = time.monotonic()
    try:
        result = subprocess.run(
            arguments,
            capture_output=True,
            text=True,
            timeout=deadline.timeout(timeout, label) if deadline else timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
        events.append({**fixed_error_event(label, error, started), "returnCode": None})
        raise QualificationError(f"{label} could not complete") from error
    events.append({"label": label, "returnCode": result.returncode, "elapsedMs": int((time.monotonic() - started) * 1000)})
    if result.returncode != 0:
        raise QualificationError(f"{label} failed")
    return result.stdout


def ensure_user_layout() -> None:
    required_users = {"mc-agent-tool"}
    required_groups = {"mc-agent-tool", "mc-agent-workspace", "mc-agent-executor-client"}
    for name in required_groups:
        try:
            group = grp.getgrnam(name)
        except KeyError as error:
            raise QualificationError(f"required target group is missing: {name}") from error
        if group.gr_gid == 0:
            raise QualificationError(f"required target group is root: {name}")
    for name in required_users:
        try:
            user = pwd.getpwnam(name)
        except KeyError as error:
            raise QualificationError(f"required target user is missing: {name}") from error
        if user.pw_uid == 0 or user.pw_gid == 0:
            raise QualificationError("shell runner target identity is root")
    tool = pwd.getpwnam("mc-agent-tool")
    workspace = grp.getgrnam("mc-agent-workspace")
    groups = os.getgrouplist("mc-agent-tool", tool.pw_gid)
    if workspace.gr_gid not in groups:
        raise QualificationError("mc-agent-tool is not a member of mc-agent-workspace")


def install_workspace(run_id: str) -> Path:
    workspace = Path("/opt/minecraft/server")
    if workspace.exists() or workspace.is_symlink():
        raise QualificationError("disposable workspace already exists")
    workspace.mkdir(mode=0o2770, parents=True, exist_ok=True)
    os.chown(workspace, 0, grp.getgrnam("mc-agent-workspace").gr_gid)
    fixture = workspace / f"qualification-read-{run_id}"
    write_bytes(fixture, f"READ_FIXTURE_{run_id}\n".encode("ascii"), 0o640)
    os.chown(fixture, 0, grp.getgrnam("mc-agent-workspace").gr_gid)
    return workspace


def install_unit(stage: Path, host_manifest: dict[str, Any], name: str) -> None:
    source = stage / "host" / name
    destination = Path("/etc/systemd/system") / name
    checked_regular(source, f"unit {name}")
    matching = [item for item in host_manifest["files"] if item["path"] == f"host/{name}"]
    if len(matching) != 1 or matching[0]["destination"] != str(destination):
        raise QualificationError(f"unit {name} is not bound to its original installed path")
    checked_digest(source, matching[0]["sha256"], matching[0]["bytes"], f"unit {name}", 1024 * 1024)
    validate_shell_unit_source(source, name)
    for dropin in (destination.parent / f"{name}.d", Path("/run/systemd/system") / f"{name}.d"):
        if dropin.exists() or dropin.is_symlink():
            raise QualificationError(f"unit {name} has an unreviewed drop-in")
    if destination.exists() or destination.is_symlink():
        raise QualificationError(f"installed unit already exists: {name}")
    shutil.copyfile(source, destination)
    os.chown(destination, 0, 0)
    os.chmod(destination, 0o644)


def validate_shell_unit_source(source: Path, name: str) -> None:
    if name not in STATIC_VERIFY_SERVICE_NAMES:
        return
    expected_mode = "read-only" if name == "mc-agent-tool-read.service" else "staged-write"
    expected_root = "/opt/mc-agent/tool-read-root" if expected_mode == "read-only" else "/opt/mc-agent/tool-write-root"
    expected_exec = f"ExecStart=/runtime/node-current/bin/node --disallow-code-generation-from-strings /runtime/current/shell-runner-cli.mjs --{expected_mode}"
    expected_binds = {
        "BindReadOnlyPaths=/opt/minecraft/server:/workspace",
        "BindReadOnlyPaths=/opt/mc-agent/current:/runtime/current",
        "BindReadOnlyPaths=/opt/mc-agent/node-current:/runtime/node-current",
        "BindReadOnlyPaths=/opt/mc-agent/toolchain:/toolchain",
        "BindReadOnlyPaths=/usr/lib:/usr/lib",
        "BindReadOnlyPaths=/usr/lib64:/usr/lib64",
        "BindReadOnlyPaths=/lib64:/lib64",
        "BindReadOnlyPaths=-/etc/mc-agent/shell-toolchain.json:/config/shell-toolchain.json",
    }
    lines = source.read_text(encoding="utf-8").splitlines()
    required = {f"RootDirectory={expected_root}", expected_exec, *expected_binds}
    if any(lines.count(line) != 1 for line in required):
        raise QualificationError(f"{name} source does not carry the exact Node root/bind contract")


def static_diagnostic_unit(line: str) -> str | None:
    candidate = PurePosixPath(line.split(":", 1)[0]).name
    return candidate if STATIC_VERIFY_UNIT_RE.fullmatch(candidate) else None


def parse_static_verify_result(return_code: int, stdout: str, stderr: str) -> dict[str, list[str]]:
    diagnostics = [line.strip() for line in (stdout + stderr).splitlines() if line.strip()]
    if any(len(line) > 1024 for line in diagnostics):
        raise QualificationError("static shell unit verification emitted an oversized diagnostic")
    owned: list[str] = []
    advisory: list[str] = []
    for line in diagnostics:
        unit = static_diagnostic_unit(line)
        if unit in SERVICE_NAMES:
            owned.append(line)
        elif unit is not None and unit.startswith("mc-agent-"):
            raise QualificationError("static shell unit verification emitted an unrelated mc-agent diagnostic")
        elif unit is not None:
            advisory.append(line)
        else:
            raise QualificationError("static shell unit verification emitted an unclassified diagnostic")
    if owned and owned != STATIC_VERIFY_EXPECTED_DIAGNOSTICS:
        raise QualificationError("static shell unit verification emitted an unexpected requested-unit diagnostic")
    if return_code != 0 and not owned and not advisory:
        raise QualificationError("static shell unit verification failed without a classified diagnostic")
    return {"owned": owned, "advisory": advisory}


def verify_shell_units_static(events: list[dict[str, Any]], deadline: ProbeDeadline | None = None) -> None:
    started = time.monotonic()
    try:
        result = subprocess.run(
            ["systemd-analyze", "verify", "--recursive-errors=no", *[f"/etc/systemd/system/{name}" for name in SERVICE_NAMES]],
            capture_output=True,
            text=True,
            timeout=deadline.timeout(30, "static shell unit verification") if deadline else 30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
        events.append({**fixed_error_event("static shell unit verification", error, started), "returnCode": None})
        raise QualificationError("static shell unit verification could not complete") from error
    classified = parse_static_verify_result(result.returncode, result.stdout, result.stderr)
    events.append(
        {
            "label": "static shell unit verification",
            "returnCode": result.returncode,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "staticOnly": True,
            "diagnostics": classified["owned"],
            "advisoryDiagnostics": classified["advisory"],
        }
    )


def marker_identity(run_id: str, marker: Path) -> None:
    if not RUN_ID_RE.fullmatch(run_id):
        raise QualificationError("run id must be a UUIDv4")
    if marker != Path(f"/etc/mc-agent/disposable-qualification/{run_id}.marker"):
        raise QualificationError("target identity marker path is not the exact run-id marker")
    parent = marker.parent
    parent_metadata = parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent.is_symlink() or parent_metadata.st_uid != 0 or stat.S_IMODE(parent_metadata.st_mode) != 0o700:
        raise QualificationError("target identity marker directory is unsafe")
    metadata = checked_regular(marker, "target identity marker")
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) not in (0o400, 0o444):
        raise QualificationError("target identity marker ownership or mode is unsafe")
    if marker.read_text(encoding="ascii") != f"mc-aws-disposable-qualification:{run_id}\n":
        raise QualificationError("target identity marker is not bound to this run id")


def target_identity(run_id: str, marker: Path, deadline: ProbeDeadline | None = None) -> None:
    marker_identity(run_id, marker)
    if os.geteuid() != 0 or os.uname().machine != "aarch64":
        raise QualificationError("target is not a privileged native ARM64 host")
    os_release = {}
    for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    if os_release.get("ID") != "amzn" or os_release.get("VERSION_ID") != "2023":
        raise QualificationError("target is not Amazon Linux 2023")
    if Path("/proc/1/comm").read_text(encoding="ascii").strip() != "systemd":
        raise QualificationError("target PID 1 is not systemd")
    state = run_system_capture(
        "target systemd state",
        ["systemctl", "show", "--property=SystemState", "--value"],
        deadline=deadline,
    )
    if not state.strip():
        raise QualificationError("target systemd state could not be verified")


def fresh_target_guard() -> None:
    absent = [
        Path("/opt/mc-agent"),
        Path("/opt/minecraft/server"),
        Path("/var/lib/mc-agent-executor"),
        Path("/var/lib/mc-agent-gateway"),
        Path("/run/mc-agent"),
    ]
    for path in absent:
        if path.exists() or path.is_symlink():
            raise QualificationError(f"fresh disposable target already has live state: {path}")
    config_root = Path("/etc/mc-agent")
    if not config_root.is_dir() or config_root.is_symlink() or sorted(item.name for item in config_root.iterdir()) != ["disposable-qualification"]:
        raise QualificationError("/etc/mc-agent contains state other than the required target marker")
    unit_roots = (Path("/etc/systemd/system"), Path("/run/systemd/system"), Path("/usr/lib/systemd/system"))
    for root in unit_roots:
        for name in SERVICE_NAMES:
            if (root / name).exists() or (root / name).is_symlink() or (root / f"{name}.d").exists() or (root / f"{name}.d").is_symlink():
                raise QualificationError(f"fresh disposable target already has shell unit state: {root / name}")
    for name in ("mc-agent", "mc-agent-gateway", "mc-agent-executor", "mc-agent-tool", "mc-agent-executor-client", "mc-agent-gateway-client", "mc-agent-world-root-client", "mc-agent-workspace"):
        try:
            grp.getgrnam(name)
        except KeyError:
            continue
        raise QualificationError(f"fresh disposable target already has agent group: {name}")
    for name in ("mc-agent-gateway", "mc-agent-executor", "mc-agent-tool"):
        try:
            pwd.getpwnam(name)
        except KeyError:
            continue
        raise QualificationError(f"fresh disposable target already has agent user: {name}")


def socket_request(
    path: str,
    request: dict[str, Any],
    timeout: float = 15.0,
    deadline: ProbeDeadline | None = None,
) -> dict[str, Any]:
    payload = (json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8")
    if len(payload) > 2 * 1024 * 1024:
        raise QualificationError("probe request is oversized")
    received = bytearray()
    socket_deadline = time.monotonic() + timeout
    if deadline is not None:
        socket_deadline = min(socket_deadline, deadline.expires_at)

    def arm_timeout() -> None:
        remaining = socket_deadline - time.monotonic()
        if remaining <= 0:
            raise QualificationError("runner socket I/O deadline exceeded")
        connection.settimeout(remaining)

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            arm_timeout()
            connection.connect(path)
            arm_timeout()
            connection.sendall(payload)
            arm_timeout()
            connection.shutdown(socket.SHUT_WR)
            while True:
                arm_timeout()
                chunk = connection.recv(1024 * 1024)
                if not chunk:
                    break
                received.extend(chunk)
                if len(received) > 8 * 1024 * 1024:
                    raise QualificationError("runner response is oversized")
    except (socket.timeout, TimeoutError) as error:
        raise QualificationError("runner socket I/O deadline exceeded") from error
    try:
        value = json.loads(bytes(received).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise QualificationError("runner response is not one JSON frame") from error
    if not isinstance(value, dict):
        raise QualificationError("runner response is not an object")
    required = {"schemaVersion", "exitCode", "output", "outputBytes", "outputSha256", "truncated"}
    allowed = required | {"stagedResult"}
    if set(value) - allowed or not required <= set(value) or value["schemaVersion"] != 1:
        raise QualificationError("runner response schema is invalid")
    if (
        not isinstance(value["exitCode"], int)
        or isinstance(value["exitCode"], bool)
        or not -(2**53 - 1) <= value["exitCode"] <= 2**53 - 1
        or not isinstance(value["output"], str)
        or not isinstance(value["outputBytes"], int)
        or isinstance(value["outputBytes"], bool)
        or value["outputBytes"] < 0
        or value["outputBytes"] > MAX_SHELL_OUTPUT_BYTES * 2
        or len(value["output"].encode("utf-8")) > MAX_SHELL_OUTPUT_BYTES
        or value["outputBytes"] != len(value["output"].encode("utf-8"))
        or not isinstance(value["outputSha256"], str)
        or not SHA256_RE.fullmatch(value["outputSha256"])
        or not isinstance(value["truncated"], bool)
    ):
        raise QualificationError("runner response output fields are invalid")
    output_digest = hashlib.sha256(value["output"].encode("utf-8")).hexdigest()
    failure_fallback = (
        value["exitCode"] == 126
        and value["output"] == ""
        and value["outputBytes"] == 0
        and value["outputSha256"] == "0" * 64
    )
    if value["outputSha256"] != output_digest and not failure_fallback:
        raise QualificationError("runner response output accounting is invalid")
    staged = value.get("stagedResult")
    if "stagedResult" in value:
        if (
            not isinstance(staged, dict)
            or set(staged) != {"bytes", "noLink", "regularFile", "sha256"}
            or not isinstance(staged["regularFile"], bool)
            or not isinstance(staged["noLink"], bool)
            or not isinstance(staged["bytes"], str)
            or not SHA256_RE.fullmatch(staged["sha256"])
        ):
            raise QualificationError("runner staged result schema is invalid")
        try:
            staged_bytes = base64.b64decode(staged["bytes"], validate=True)
        except (ValueError, binascii.Error) as error:
            raise QualificationError("runner staged result encoding is invalid") from error
        if base64.b64encode(staged_bytes).decode("ascii") != staged["bytes"] or len(staged_bytes) > 1024 * 1024:
            raise QualificationError("runner staged result encoding or size is invalid")
        if staged["sha256"] != hashlib.sha256(staged_bytes).hexdigest():
            raise QualificationError("runner staged result digest is invalid")
    return value


def probe_runner(
    run_id: str,
    events: list[dict[str, Any]],
    counter: list[int],
    path: str,
    mode: str,
    command: str,
    *,
    change: dict[str, str] | None = None,
    timeout_ms: int = 10_000,
    expected_output: str | None = None,
    expected_exit: int = 0,
    expected_staged: bytes | None = None,
    deadline: ProbeDeadline | None = None,
) -> None:
    counter[0] += 1
    label = f"{mode}:{counter[0]}"
    started = time.monotonic()
    request: dict[str, Any] = {
        "schemaVersion": 1,
        "requestId": f"{run_id}:probe:{counter[0]}",
        "mode": mode,
        "command": command,
        "timeoutMs": timeout_ms,
        "maxOutputBytes": 64 * 1024,
    }
    if change is not None:
        request["change"] = change
    try:
        response = socket_request(
            path,
            request,
            timeout=max(15.0, timeout_ms / 1000 + 10),
            deadline=deadline,
        )
        if response.get("schemaVersion") != 1 or not all(
            key in response for key in ("exitCode", "output", "outputBytes", "outputSha256", "truncated")
        ):
            raise QualificationError("runner response schema is invalid")
        output = response.get("output")
        if response.get("truncated") is not False or not isinstance(output, str) or response.get("outputBytes") != len(output.encode()):
            raise QualificationError("runner response output accounting is invalid")
        expected_digest = hashlib.sha256(output.encode()).hexdigest()
        failure_fallback = (
            expected_exit == 126
            and response.get("exitCode") == 126
            and output == ""
            and response.get("outputBytes") == 0
            and response.get("outputSha256") == "0" * 64
        )
        if response.get("outputSha256") != expected_digest and not failure_fallback:
            raise QualificationError("runner response output accounting is invalid")
        event: dict[str, Any] = {
            "label": label,
            "mode": mode,
            "socket": path,
            "exitCode": response.get("exitCode"),
            "outputBytes": response.get("outputBytes"),
            "outputSha256": response.get("outputSha256"),
            "truncated": response.get("truncated"),
            "elapsedMs": int((time.monotonic() - started) * 1000),
        }
        if expected_output is not None:
            event["expectedOutputBytes"] = len(expected_output.encode())
            event["expectedOutputSha256"] = hashlib.sha256(expected_output.encode()).hexdigest()
        if response.get("exitCode") != expected_exit:
            raise QualificationError(f"{mode} runner returned an unexpected exit code")
        if expected_output is not None and output != expected_output:
            raise QualificationError(f"{mode} runner returned unexpected pipeline output")
        if expected_staged is not None:
            staged = response.get("stagedResult")
            if not isinstance(staged, dict) or staged.get("regularFile") is not True or staged.get("noLink") is not True:
                raise QualificationError("staged result did not carry regular-file/no-link evidence")
            try:
                staged_bytes = base64.b64decode(staged["bytes"], validate=True)
            except (KeyError, ValueError, binascii.Error) as error:
                raise QualificationError("staged result encoding is invalid") from error
            if staged_bytes != expected_staged or staged.get("sha256") != hashlib.sha256(expected_staged).hexdigest():
                raise QualificationError("staged result bytes or digest are not exact")
            event["stagedBytes"] = len(staged_bytes)
            event["stagedSha256"] = staged["sha256"]
        events.append(event)
    except (QualificationError, OSError, ValueError) as error:
        events.append({**fixed_error_event(label, error, started), "mode": mode, "socket": path})
        raise


def assert_socket_state(unit: str, socket_path: str, deadline: ProbeDeadline | None = None) -> None:
    show = run_system_capture(
        f"inspect {unit}",
        ["systemctl", "show", unit, "--property=LoadState", "--property=ActiveState", "--property=FragmentPath", "--property=DropInPaths"],
        deadline=deadline,
    )
    values = dict(line.split("=", 1) for line in show.splitlines() if "=" in line)
    if values.get("LoadState") != "loaded" or values.get("ActiveState") != "active" or values.get("FragmentPath") != f"/etc/systemd/system/{unit}" or values.get("DropInPaths", ""):
        raise QualificationError(f"{unit} does not use the original unit without drop-ins")
    metadata = os.stat(socket_path)
    if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o660:
        raise QualificationError(f"{unit} socket metadata is unsafe")
    if metadata.st_gid != grp.getgrnam("mc-agent-executor-client").gr_gid:
        raise QualificationError(f"{unit} socket group is not mc-agent-executor-client")


def assert_unit_state(unit: str, deadline: ProbeDeadline | None = None) -> None:
    show = run_system_capture(
        f"inspect {unit}",
        ["systemctl", "show", unit, "--property=LoadState", "--property=FragmentPath", "--property=DropInPaths"],
        deadline=deadline,
    )
    values = dict(line.split("=", 1) for line in show.splitlines() if "=" in line)
    if values.get("LoadState") != "loaded" or values.get("FragmentPath") != f"/etc/systemd/system/{unit}" or values.get("DropInPaths", ""):
        raise QualificationError(f"{unit} does not use the original unit without drop-ins")


def assert_service_stopped(unit: str, deadline: ProbeDeadline | None = None) -> dict[str, Any]:
    if unit not in STATIC_VERIFY_SERVICE_NAMES:
        raise QualificationError(f"service is outside the qualified shell units: {unit}")
    cgroup = SERVICE_CGROUP_ROOT / unit
    for _ in range(30):
        show = run_system_capture(
            f"check stopped {unit}",
            ["systemctl", "show", unit, "--property=ActiveState", "--property=MainPID"],
            deadline=deadline,
        )
        values = dict(line.split("=", 1) for line in show.splitlines() if "=" in line)
        if values.get("ActiveState") == "inactive" and values.get("MainPID") == "0":
            try:
                metadata = cgroup.lstat()
            except FileNotFoundError:
                return {"activeState": "inactive", "mainPid": 0, "cgroupPath": str(cgroup), "cgroup": "absent"}
            if cgroup.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                raise QualificationError(f"{unit} canonical cgroup path is not a real directory")
            events = cgroup / "cgroup.events"
            metadata = events.lstat()
            if events.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                raise QualificationError(f"{unit} cgroup.events is not a regular file")
            populated = dict(line.split(None, 1) for line in events.read_text(encoding="ascii").splitlines() if line.strip())
            if populated.get("populated") != "0":
                raise QualificationError(f"{unit} cgroup is still populated")
            processes = cgroup / "cgroup.procs"
            metadata = processes.lstat()
            if processes.is_symlink() or not stat.S_ISREG(metadata.st_mode) or processes.read_text(encoding="ascii").strip():
                raise QualificationError(f"{unit} canonical cgroup still contains processes")
            return {
                "activeState": "inactive",
                "mainPid": 0,
                "cgroupPath": str(cgroup),
                "cgroup": "populated=0",
                "cgroupProcs": "empty",
            }
        time.sleep(min(0.1, deadline.remaining(f"check stopped {unit}") if deadline else 0.1))
    raise QualificationError(f"{unit} service and child cgroup did not become empty after the bounded timeout")


def run_system_capture(
    label: str,
    arguments: list[str],
    timeout: float = 15.0,
    deadline: ProbeDeadline | None = None,
) -> str:
    try:
        result = subprocess.run(
            arguments,
            capture_output=True,
            text=True,
            timeout=deadline.timeout(timeout, label) if deadline else timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
        raise QualificationError(f"{label} could not complete") from error
    if result.returncode != 0:
        raise QualificationError(f"{label} failed")
    return result.stdout


def cleanup_units(started: bool, events: list[dict[str, Any]], deadline: ProbeDeadline | None = None) -> bool:
    if not started:
        return True
    success = True
    for unit in ("mc-agent-tool-read.socket", "mc-agent-tool-write.socket"):
        failure: dict[str, Any] | None = None
        try:
            result = subprocess.run(
                ["systemctl", "disable", "--now", unit],
                capture_output=True,
                text=True,
                timeout=deadline.timeout(15, f"cleanup {unit}") if deadline else 15,
                check=False,
            )
            return_code = result.returncode
        except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
            return_code = -1
            failure = fixed_error_event(f"cleanup:{unit}", error)
        events.append({"label": f"cleanup:{unit}", "returnCode": return_code, **(failure or {})})
        if return_code != 0:
            success = False
    for unit in SERVICE_NAMES:
        failure = None
        try:
            state = subprocess.run(
                ["systemctl", "is-active", unit],
                capture_output=True,
                text=True,
                timeout=deadline.timeout(10, f"cleanup state {unit}") if deadline else 10,
                check=False,
            )
            active_state = state.stdout.strip()
        except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
            active_state = "cleanup-error"
            failure = fixed_error_event(f"cleanup state:{unit}", error)
        if active_state not in ("inactive", "failed", "unknown"):
            success = False
        if failure is not None:
            events.append(failure)
    return success


def systemctl_active_state(unit: str, deadline: ProbeDeadline | None = None) -> str:
    try:
        result = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True,
            text=True,
            timeout=deadline.timeout(10, f"check active state {unit}") if deadline else 10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, QualificationError) as error:
        raise QualificationError(f"check active state {unit} could not complete") from error
    return result.stdout.strip()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--run-id", required=True)
    result.add_argument("--target-marker", required=True, type=Path)
    result.add_argument("--host-release-archive", required=True, type=Path)
    result.add_argument("--host-release-sha256", required=True)
    result.add_argument("--host-release-bytes", required=True, type=int)
    result.add_argument("--node-archive", required=True, type=Path)
    result.add_argument("--node-bytes", required=True, type=int)
    result.add_argument("--evidence-dir", type=Path)
    return result


def main(arguments: argparse.Namespace) -> int:
    run_id = arguments.run_id
    deadline = ProbeDeadline()
    target_identity(run_id, arguments.target_marker, deadline)
    fresh_target_guard()
    evidence_dir = arguments.evidence_dir or Path(f"/var/lib/mc-agent-executor/disposable-qualification-{run_id}")
    expected_evidence_dir = Path(f"/var/lib/mc-agent-executor/disposable-qualification-{run_id}")
    if evidence_dir != expected_evidence_dir or evidence_dir != Path(os.path.abspath(evidence_dir)):
        raise QualificationError("evidence directory must be a run-id-bound executor-state child")
    if evidence_dir.parent.exists() or evidence_dir.parent.is_symlink():
        raise QualificationError("executor state directory was created after the fresh-target guard")
    evidence_dir.parent.mkdir(mode=0o700)
    os.chown(evidence_dir.parent, 0, 0)
    parent_metadata = evidence_dir.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or evidence_dir.parent.is_symlink() or stat.S_IMODE(parent_metadata.st_mode) != 0o700:
        raise QualificationError("executor state fixture directory is not root-owned and private")
    if evidence_dir.exists() or evidence_dir.is_symlink():
        raise QualificationError("evidence directory already exists")
    evidence_dir.mkdir(mode=0o700)
    os.chown(evidence_dir, 0, 0)
    lock_descriptor = os.open(evidence_dir / ".lock", os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    events: list[dict[str, Any]] = []
    started = False
    status = "failed"
    staging: Path | None = None
    failure: dict[str, Any] | None = None
    try:
        checked_digest(arguments.host_release_archive, arguments.host_release_sha256, arguments.host_release_bytes, "host release archive", MAX_HOST_ARCHIVE_BYTES)
        checked_regular(arguments.node_archive, "Node archive", max_bytes=MAX_NODE_ARCHIVE_BYTES)
        if arguments.host_release_archive.name != f"{arguments.host_release_sha256}.zip" or arguments.node_archive.name != f"node-v{NODE_VERSION}-linux-arm64.tar.xz":
            raise QualificationError("artifact filenames are not bound to their reviewed identities")
        staging = Path(tempfile.mkdtemp(prefix=f"mc-aws-qualification-{run_id}-", dir="/var/tmp"))
        stage = staging / "host-release"
        extract_host_archive(arguments.host_release_archive, stage)
        release_manifest = json.loads((stage / "release-manifest.json").read_text(encoding="utf-8"))
        validate_host_release(stage, release_manifest)
        runtime_manifest, _bundle_manifest = runtime_manifest_from_archive(stage / "agent-runtime.zip")
        validate_toolchain_layout(stage / "toolchain")
        node_sha = runtime_manifest["node"]["sha256"]
        checked_digest(arguments.node_archive, node_sha, arguments.node_bytes, "Node archive", MAX_NODE_ARCHIVE_BYTES)
        runtime_identity = release_manifest["agentRuntime"]
        runtime_sha = runtime_identity["sha256"]
        toolchain_identity = release_manifest["shellToolchain"]
        installer = stage / "host" / "mc-agent-install.sh"
        checked_regular(installer, "original agent installer")
        if not stat.S_IMODE(checked_regular(Path(TRUSTED_HOST_BASH), "trusted host bash").st_mode) & 0o111:
            raise QualificationError("trusted host bash is not executable")
        run_process(
            "original install-toolchain",
            trusted_installer_command(installer, stage / "toolchain", toolchain_identity["sha256"], toolchain_identity["bytes"]),
            events,
            timeout=60,
            deadline=deadline,
        )
        ensure_user_layout()
        workspace = install_workspace(run_id)
        node_release = Path("/opt/mc-agent/node-releases") / node_sha
        runtime_release = Path("/opt/mc-agent/releases") / runtime_sha
        if node_release.exists() or runtime_release.exists():
            raise QualificationError("content-addressed target release already exists")
        install_node_archive(arguments.node_archive, node_release, node_sha, arguments.node_bytes, deadline)
        install_runtime_archive(
            stage / "agent-runtime.zip",
            runtime_release,
            runtime_identity["bundleManifestSha256"],
            runtime_identity["bundleManifestBytes"],
        )
        for link_name, target in (("node-current", f"node-releases/{node_sha}"), ("current", f"releases/{runtime_sha}")):
            link_path = Path("/opt/mc-agent") / link_name
            temporary = link_path.with_name(f".{link_name}.{run_id}")
            if link_path.exists() or link_path.is_symlink() or temporary.exists() or temporary.is_symlink():
                raise QualificationError(f"content-addressed runtime pointer already exists: {link_name}")
            os.symlink(target, temporary)
            os.replace(temporary, link_path)
        for name in SERVICE_NAMES:
            install_unit(stage, release_manifest, name)
        run_process("systemd daemon-reload", ["systemctl", "daemon-reload"], events, deadline=deadline)
        verify_shell_units_static(events, deadline)
        for unit in SERVICE_NAMES:
            state = systemctl_active_state(unit, deadline)
            if state not in ("inactive", "unknown"):
                raise QualificationError(f"{unit} was active before the probe")
        run_process(
            "socket activation start",
            ["systemctl", "enable", "--now", "mc-agent-tool-read.socket", "mc-agent-tool-write.socket"],
            events,
            deadline=deadline,
        )
        started = True
        for socket_path in (READ_SOCKET, WRITE_SOCKET):
            for _ in range(20):
                if Path(socket_path).exists():
                    break
                time.sleep(min(0.1, deadline.remaining(f"wait for {socket_path}")))
            if not Path(socket_path).exists():
                raise QualificationError(f"socket did not appear: {socket_path}")
        assert_socket_state("mc-agent-tool-read.socket", READ_SOCKET, deadline)
        assert_socket_state("mc-agent-tool-write.socket", WRITE_SOCKET, deadline)
        for unit in ("mc-agent-tool-read.service", "mc-agent-tool-write.service"):
            assert_unit_state(unit, deadline)
        counter = [0]
        probe_runner(run_id, events, counter, READ_SOCKET, "read-only", "printf 'read_only_pipeline_ok\\n' | tr a-z A-Z", expected_output="READ_ONLY_PIPELINE_OK\n", deadline=deadline)
        readonly_name = f"qualification-must-not-write-{run_id}"
        probe_runner(run_id, events, counter, READ_SOCKET, "read-only", f"if touch '/workspace/{readonly_name}' 2>/dev/null; then printf 'READ_ONLY_WRITE_ALLOWED\\n'; else printf 'READ_ONLY_WRITE_DENIED\\n'; fi", expected_output="READ_ONLY_WRITE_DENIED\n", deadline=deadline)
        if (workspace / readonly_name).exists():
            raise QualificationError("read-only workspace sentinel was created")
        sentinel_command = "for p in /etc/mc-agent/disposable-secret-%s /var/lib/mc-agent-executor/disposable-evidence-%s /run/mc-agent/disposable-control-%s; do if cat \"$p\" >/dev/null 2>&1; then printf 'SENTINEL_READ_ALLOWED\\n'; exit 41; fi; done; if env | grep -E '^(AWS_|MC_AGENT_|NODE_AUTH_TOKEN)=' >/dev/null 2>&1; then printf 'CREDENTIAL_ENV_VISIBLE\\n'; exit 42; fi; printf 'SENTINELS_DENIED\\n'" % (run_id, run_id, run_id)
        secret = Path(f"/etc/mc-agent/disposable-secret-{run_id}")
        evidence_sentinel = Path(f"/var/lib/mc-agent-executor/disposable-evidence-{run_id}")
        control_sentinel = Path(f"/run/mc-agent/disposable-control-{run_id}")
        for sentinel in (secret, evidence_sentinel, control_sentinel):
            write_bytes(sentinel, b"FIXED_CANARY_NOT_A_SECRET\n", 0o600)
            os.chown(sentinel, 0, 0)
        probe_runner(run_id, events, counter, READ_SOCKET, "read-only", sentinel_command, expected_output="SENTINELS_DENIED\n", deadline=deadline)
        staged = f"STAGED_RESULT_{run_id}\n".encode("ascii")
        probe_runner(run_id, events, counter, WRITE_SOCKET, "staged-write", "printf 'STAGED_RESULT_%s\\n' > \"$TMPDIR/result\"" % run_id, change={"operation": "replace", "path": "qualification-output.txt"}, expected_staged=staged, deadline=deadline)
        network_command = "/runtime/node-current/bin/node --eval 'const net=require(\"node:net\");const s=net.createConnection({host:\"198.51.100.1\",port:80});s.setTimeout(500);s.on(\"connect\",()=>{console.log(\"NETWORK_ALLOWED\");process.exit(41)});s.on(\"timeout\",()=>{console.log(\"NETWORK_TIMEOUT\");s.destroy();process.exit(42)});s.on(\"error\",e=>{const denied=[\"EACCES\",\"EPERM\",\"EAFNOSUPPORT\",\"ENETUNREACH\",\"EHOSTUNREACH\"].includes(e.code);console.log(denied?\"NETWORK_DENIED\":\"NETWORK_ERROR\");process.exit(denied?0:43)});'"
        probe_runner(run_id, events, counter, READ_SOCKET, "read-only", network_command, expected_output="NETWORK_DENIED\n", timeout_ms=5_000, deadline=deadline)
        probe_runner(run_id, events, counter, READ_SOCKET, "read-only", "sleep 120 & wait", timeout_ms=250, expected_exit=126, deadline=deadline)
        cgroup_evidence = assert_service_stopped("mc-agent-tool-read.service", deadline)
        events.append({"label": "timeout-child-cgroup-cleanup", "service": "mc-agent-tool-read.service", **cgroup_evidence})
        status = "passed"
    except (QualificationError, OSError, ValueError, json.JSONDecodeError) as error:
        failure = fixed_error_event("qualification", error)
        events.append(failure)
        raise
    finally:
        cleanup_ok = cleanup_units(started, events, deadline)
        if not cleanup_ok:
            status = "failed"
        record = {
            "schemaVersion": 1,
            "status": status,
            "runId": run_id,
            "target": {"os": "amzn2023", "architecture": "aarch64", "pid1": "systemd", "privileged": True},
            "scope": {"gateway": False, "executor": False, "minecraft": False, "hostBroker": False, "worldRoots": False, "shellUnits": True},
            "artifacts": {
                "hostRelease": {"sha256": arguments.host_release_sha256, "bytes": arguments.host_release_bytes},
                "node": {"version": NODE_VERSION, "platform": NODE_PLATFORM, "url": "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz", "checksumSource": "https://nodejs.org/dist/v22.19.0/SHASUMS256.txt", "sha256": locals().get("node_sha"), "bytes": arguments.node_bytes},
                "runtime": {"sha256": locals().get("runtime_sha"), "bundleManifestSha256": locals().get("runtime_identity", {}).get("bundleManifestSha256")},
                "toolchainManifest": {"sha256": locals().get("toolchain_identity", {}).get("sha256"), "bytes": locals().get("toolchain_identity", {}).get("bytes")},
            },
            "events": events,
            "shellUnitCleanupVerified": cleanup_ok,
            "generatedCredentials": "fixture-only installer initialization; no credential bytes were read or recorded",
        }
        if failure is not None:
            record["failure"] = failure
        evidence = evidence_dir / "evidence.json"
        temporary = evidence.with_name(".evidence.json.tmp")
        write_bytes(temporary, (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("ascii"), 0o644)
        os.replace(temporary, evidence)
        os.close(lock_descriptor)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
    print(json.dumps({"status": status, "runId": run_id, "evidence": str(evidence_dir / "evidence.json")}, sort_keys=True))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(parser().parse_args()))
    except (QualificationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
