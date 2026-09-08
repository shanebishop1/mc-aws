#!/usr/bin/env python3
"""Root-owned, content-addressed host-release activation journal."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path


SCHEMA_VERSION = 2
SERVICE_UNITS = (
    "minecraft-dns.service",
    "minecraft.service",
    "mc-agent-world-roots.service",
    "mc-agent-executor.socket",
    "mc-agent-executor.service",
    "mc-agent-gateway.service",
)


def fail(message: str) -> None:
    raise SystemExit(message)


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_mkdir(path: Path, mode: int = 0o700) -> None:
    missing: list[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=mode)
        fsync_directory(directory.parent)
        fsync_directory(directory)


def atomic_write(path: Path, value: bytes, mode: int = 0o600) -> None:
    durable_mkdir(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def safe_regular(path: Path) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        fail(f"unsafe journal file {path}: {error}")
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            fail(f"unsafe journal file: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            return source.read()
    finally:
        os.close(descriptor)


def read_content(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NOATIME", 0)
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            return source.read()
    finally:
        os.close(descriptor)


def fsync_path(path: Path) -> None:
    """Flush one snapshot source without following a mutable symlink."""
    metadata = path.lstat()
    if stat.S_ISREG(metadata.st_mode):
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    elif stat.S_ISDIR(metadata.st_mode):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    else:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_tree(path: Path, excluded: set[str]) -> None:
    """Flush the complete captured tree before any snapshot record is read."""
    if str(path) in excluded:
        return
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISREG(metadata.st_mode):
        fsync_path(path)
        return
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        return
    fsync_path(path)
    with os.scandir(path) as entries:
        for entry in sorted(entries, key=lambda item: item.name):
            fsync_tree(path / entry.name, excluded)
    fsync_path(path)


def reject_symlinked_ancestors(path: Path) -> None:
    current = path.parent
    while current != current.parent:
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            current = current.parent
            continue
        if stat.S_ISLNK(metadata.st_mode):
            fail(f"release destination has a symlinked ancestor: {path}")
        if not stat.S_ISDIR(metadata.st_mode):
            fail(f"release destination has a non-directory ancestor: {path}")
        current = current.parent


def load_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(safe_regular(path))
    except (OSError, ValueError) as error:
        fail(f"invalid release journal {path}: {error}")
    if not isinstance(value, dict):
        fail(f"invalid release journal object: {path}")
    return value


def validate_root(root: Path) -> None:
    metadata = root.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or root.is_symlink()
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        fail("release journal root must be one current-owner 0700 directory")


def validate_service_state(data: bytes) -> None:
    try:
        rows = [line.split("\t") for line in data.decode("utf-8").splitlines()]
    except UnicodeDecodeError:
        fail("release service-state evidence is not UTF-8")
    if len(rows) != len(SERVICE_UNITS) or [row[0] for row in rows if len(row) == 3] != list(SERVICE_UNITS):
        fail("release service-state evidence has an invalid unit inventory")
    for row in rows:
        if len(row) != 3 or row[1] not in {"active", "inactive"} or row[2] not in {
            "enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "not-found"
        }:
            fail("release service-state evidence has an invalid state")


def load_snapshot(attempt: Path) -> tuple[dict[str, object], dict[str, object]]:
    envelope = load_json(attempt / "snapshot.json")
    payload = envelope.get("payload")
    digest = envelope.get("payloadSha256")
    if envelope.get("schemaVersion") != SCHEMA_VERSION or not isinstance(payload, dict) or not isinstance(digest, str):
        fail("invalid release snapshot envelope")
    if hashlib.sha256(canonical(payload)).hexdigest() != digest:
        fail("release snapshot payload digest mismatch")
    records = payload.get("records")
    if payload.get("schemaVersion") != SCHEMA_VERSION or not isinstance(records, list):
        fail("invalid release snapshot")
    return envelope, payload


def write_snapshot(attempt: Path, payload: dict[str, object]) -> None:
    envelope = {
        "schemaVersion": SCHEMA_VERSION,
        "payload": payload,
        "payloadSha256": hashlib.sha256(canonical(payload)).hexdigest(),
    }
    atomic_write(attempt / "snapshot.json", canonical(envelope))


def attempt_from_active(root: Path) -> Path:
    validate_root(root)
    active = safe_regular(root / "active").decode().strip()
    if not active or not all(character in "0123456789abcdef" for character in active) or len(active) != 64:
        fail("invalid active release attempt")
    attempt = root / "attempts" / active
    if not attempt.is_dir() or attempt.is_symlink():
        fail("active release attempt directory is missing or unsafe")
    descriptor = safe_regular(attempt / "descriptor.json")
    if hashlib.sha256(descriptor).hexdigest() != active:
        fail("active release attempt descriptor digest mismatch")
    return attempt


def record_for(path: Path, objects: Path, recursive: bool, excluded: set[str]) -> dict[str, object] | None:
    if str(path) in excluded:
        return None
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return {"path": str(path), "type": "missing"}
    common: dict[str, object] = {
        "path": str(path),
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mtimeNs": metadata.st_mtime_ns,
    }
    if stat.S_ISLNK(metadata.st_mode):
        return {**common, "type": "symlink", "target": os.readlink(path)}
    if stat.S_ISREG(metadata.st_mode):
        data = read_content(path)
        digest = hashlib.sha256(data).hexdigest()
        object_path = objects / digest
        if object_path.exists():
            if safe_regular(object_path) != data:
                fail("content-addressed release journal object collision")
        else:
            atomic_write(object_path, data)
        return {**common, "type": "file", "sha256": digest, "bytes": len(data)}
    if stat.S_ISDIR(metadata.st_mode):
        result = {**common, "type": "directory", "recursive": recursive}
        if recursive:
            children: list[dict[str, object]] = []
            with os.scandir(path) as entries:
                for entry in sorted(entries, key=lambda item: item.name):
                    child = record_for(path / entry.name, objects, True, excluded)
                    if child is not None:
                        children.append(child)
            result["children"] = children
        return result
    fail(f"unsupported release destination type: {path}")


def validate_record(record: dict[str, object], objects: Path) -> None:
    path = record.get("path")
    kind = record.get("type")
    if not isinstance(path, str) or not path.startswith("/") or kind not in {"missing", "file", "symlink", "directory"}:
        fail("invalid release snapshot record")
    if kind == "file":
        digest, size = record.get("sha256"), record.get("bytes")
        if not isinstance(digest, str) or len(digest) != 64 or not isinstance(size, int) or size < 0:
            fail("invalid release snapshot file record")
        data = safe_regular(objects / digest)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            fail("release snapshot object digest mismatch")
    if kind == "symlink" and not isinstance(record.get("target"), str):
        fail("invalid release snapshot symlink record")
    if kind == "directory" and record.get("recursive"):
        children = record.get("children")
        if not isinstance(children, list):
            fail("invalid recursive release snapshot")
        for child in children:
            if not isinstance(child, dict):
                fail("invalid release snapshot child")
            validate_record(child, objects)


def is_preserved(path: Path, preserved: set[str]) -> bool:
    value = str(path)
    return any(item == value or value.startswith(f"{item}/") for item in preserved)


def is_parent_of_preserved(path: Path, preserved: set[str]) -> bool:
    value = str(path)
    return any(item.startswith(f"{value}/") for item in preserved)


def remove_path(path: Path, preserved: set[str] | None = None) -> None:
    preserved = preserved or set()
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if is_preserved(path, preserved):
        return
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        if not is_parent_of_preserved(path, preserved):
            shutil.rmtree(path)
            return
        with os.scandir(path) as entries:
            for entry in entries:
                child = path / entry.name
                if is_parent_of_preserved(child, preserved):
                    remove_path(child, preserved)
                elif is_preserved(child, preserved):
                    continue
                else:
                    shutil.rmtree(child) if entry.is_dir(follow_symlinks=False) else child.unlink()
    else:
        path.unlink()


def restore_record(record: dict[str, object], objects: Path, preserved: set[str] | None = None) -> None:
    preserved = preserved or set()
    validate_record(record, objects)
    path = Path(str(record["path"]))
    reject_symlinked_ancestors(path)
    kind = record["type"]
    if kind == "missing":
        remove_path(path, preserved)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "directory":
        if record.get("recursive"):
            remove_path(path, preserved)
        elif path.exists() and (path.is_symlink() or not path.is_dir()):
            remove_path(path)
        path.mkdir(exist_ok=True)
        for child in record.get("children", []):
            restore_record(child, objects, preserved)
    elif kind == "symlink":
        remove_path(path)
        path.symlink_to(str(record["target"]))
    else:
        remove_path(path)
        data = safe_regular(objects / str(record["sha256"]))
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    os.chown(path, int(record["uid"]), int(record["gid"]), follow_symlinks=False)
    if kind != "symlink":
        os.chmod(path, int(record["mode"]), follow_symlinks=False)
    os.utime(path, ns=(path.lstat().st_atime_ns, int(record["mtimeNs"])), follow_symlinks=False)


def durability_barrier(records: list[dict[str, object]]) -> None:
    paths: set[Path] = set()
    for record in records:
        path = Path(str(record["path"]))
        paths.add(path)
        paths.add(path.parent)
    for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
        try:
            fsync_path(path)
        except FileNotFoundError:
            pass


def flatten(records: list[dict[str, object]]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for record in records:
        result.append(record)
        children = record.get("children")
        if isinstance(children, list):
            result.extend(flatten([item for item in children if isinstance(item, dict)]))
    return result


def inspect_matches(record: dict[str, object], objects: Path, excluded: set[str] | None = None) -> bool:
    path = Path(str(record["path"]))
    try:
        current = record_for(path, objects, bool(record.get("recursive")), excluded or set())
    except (OSError, SystemExit):
        return False
    return current == record


def begin(args: argparse.Namespace) -> None:
    root = Path(args.root)
    durable_mkdir(root)
    validate_root(root)
    if (
        not args.nonce
        or len(args.nonce) > 128
        or any(len(value) != 64 or any(character not in "0123456789abcdef" for character in value) for value in (
            args.release_sha256,
            args.profile_sha256,
            args.service_state_sha256,
        ))
    ):
        fail("release attempt identity is invalid")
    if (root / "active").exists() or (root / "active").is_symlink():
        fail("an unresolved release attempt already exists")
    descriptor = {
        "schemaVersion": SCHEMA_VERSION,
        "attemptNonce": args.nonce,
        "hostReleaseSha256": args.release_sha256,
        "profileSha256": args.profile_sha256,
        "serviceStateSha256": args.service_state_sha256,
        "runtimeBefore": args.runtime_before,
        "nodeBefore": args.node_before,
        "targetRuntime": args.target_runtime,
        "enableAgent": args.enable_agent,
    }
    encoded = canonical(descriptor)
    digest = hashlib.sha256(encoded).hexdigest()
    attempt = root / "attempts" / digest
    durable_mkdir(root / "attempts")
    attempt.mkdir(mode=0o700)
    fsync_directory(attempt.parent)
    (attempt / "objects").mkdir(mode=0o700)
    fsync_directory(attempt)
    atomic_write(attempt / "descriptor.json", encoded)
    write_snapshot(attempt, {"schemaVersion": SCHEMA_VERSION, "records": [], "excludedPaths": []})
    service_state = safe_regular(Path(args.service_state_file))
    validate_service_state(service_state)
    if hashlib.sha256(service_state).hexdigest() != args.service_state_sha256:
        fail("release service-state evidence digest mismatch")
    atomic_write(attempt / "service-state.tsv", service_state)
    atomic_write(attempt / "state.json", canonical({"schemaVersion": SCHEMA_VERSION, "phase": "prepared"}))
    fsync_directory(attempt)
    atomic_write(root / "active", f"{digest}\n".encode("ascii"))
    print(str(attempt))


def capture(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    _, snapshot = load_snapshot(attempt)
    records = snapshot.get("records")
    assert isinstance(records, list)
    existing = {item.get("path") for item in records if isinstance(item, dict)}
    recursive_roots = {
        str(item.get("path")) for item in records if isinstance(item, dict) and item.get("recursive") is True
    }
    recursive = set(args.recursive)
    excluded = set(args.exclude_path)
    if any(not raw.startswith("/") or ".." in Path(raw).parts for raw in excluded):
        fail("release snapshot exclusion paths must be absolute and normalized")
    previous_exclusions = snapshot.get("excludedPaths", [])
    if not isinstance(previous_exclusions, list) or any(
        not isinstance(raw, str) or not raw.startswith("/") or ".." in Path(raw).parts
        for raw in previous_exclusions
    ):
        fail("release snapshot exclusions are invalid")
    excluded.update(previous_exclusions)
    snapshot["excludedPaths"] = sorted(excluded)
    paths = list(args.path)
    for paths_file in args.paths_file:
        value = json.loads(safe_regular(Path(paths_file)))
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            fail("release snapshot path file is invalid")
        paths.extend(value)
    for raw in paths:
        path = Path(raw)
        if not path.is_absolute() or ".." in path.parts:
            fail("release snapshot paths must be absolute and normalized")
        if raw in excluded:
            continue
        if any(str(path).startswith(f"{root}/") for root in recursive_roots):
            continue
        if str(path) in existing:
            continue
        reject_symlinked_ancestors(path)
        if str(path) in recursive:
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                metadata = None
            if metadata is not None and (stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode)):
                fail(f"recursive release destination is not a real directory: {path}")
        fsync_tree(path, excluded)
        record = record_for(path, attempt / "objects", str(path) in recursive, excluded)
        if record is not None:
            records.append(record)
        existing.add(str(path))
    write_snapshot(attempt, snapshot)


def phase(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    state = load_json(attempt / "state.json")
    current = state.get("phase")
    transitions = {
        "prepared": {"quiesced", "pre-snapshot-rolling-back", "rolling-back"},
        "quiesced": {"snapshotted", "pre-snapshot-rolling-back", "rolling-back"},
        "snapshotted": {"profile-installed", "rolling-back"},
        "profile-installed": {"runtime-installed", "rolling-back"},
        "runtime-installed": {"services-restored", "rolling-back"},
        "services-restored": {"readiness-passed", "rolling-back"},
        "readiness-passed": {"committed", "rolling-back"},
        "rolling-back": {"filesystem-restored"},
        "pre-snapshot-rolling-back": {"filesystem-restored"},
        "filesystem-restored": {"rolled-back"},
        "committed": set(),
        "rolled-back": set(),
    }
    if current not in transitions or args.phase not in transitions[current]:
        fail(f"illegal release journal phase transition: {current} -> {args.phase}")
    atomic_write(attempt / "state.json", canonical({"schemaVersion": SCHEMA_VERSION, "phase": args.phase}))


def status(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    state = load_json(attempt / "state.json")
    if state.get("schemaVersion") != SCHEMA_VERSION or not isinstance(state.get("phase"), str):
        fail("invalid release attempt state")
    print(state["phase"])


def describe(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    descriptor = load_json(attempt / "descriptor.json")
    state = load_json(attempt / "state.json")
    service_state = safe_regular(attempt / "service-state.tsv")
    validate_service_state(service_state)
    if hashlib.sha256(service_state).hexdigest() != descriptor.get("serviceStateSha256"):
        fail("release service-state evidence digest mismatch")
    print(json.dumps({"attempt": str(attempt), "descriptor": descriptor, "phase": state.get("phase")}, separators=(",", ":"), sort_keys=True))


def restore(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    _, snapshot = load_snapshot(attempt)
    records = snapshot.get("records")
    if snapshot.get("schemaVersion") != SCHEMA_VERSION or not isinstance(records, list):
        fail("invalid release snapshot")
    parsed = [record for record in records if isinstance(record, dict)]
    if len(parsed) != len(records):
        fail("invalid release snapshot record")
    skipped = set(args.skip_path)
    excluded = snapshot.get("excludedPaths", [])
    if not isinstance(excluded, list) or any(
        not isinstance(raw, str) or not raw.startswith("/") or ".." in Path(raw).parts for raw in excluded
    ):
        fail("release snapshot exclusions are invalid")
    excluded_paths = set(excluded)
    if any(
        not inspect_matches(record, attempt / "objects", excluded_paths)
        for record in parsed
        if record.get("path") in skipped
    ):
        fail("a skipped release destination changed outside this attempt")
    restored = [record for record in parsed if record.get("path") not in skipped]
    state = load_json(attempt / "state.json")
    if state.get("phase") in {"filesystem-restored", "rolled-back"}:
        if not all(inspect_matches(record, attempt / "objects", excluded_paths) for record in parsed):
            fail("release rollback verification failed after its durable restore checkpoint")
        durability_barrier(flatten(restored))
        return
    if state.get("phase") != "rolling-back":
        phase(argparse.Namespace(root=args.root, phase="rolling-back"))
    for record in sorted(restored, key=lambda item: str(item.get("path", "")).count("/"), reverse=True):
        restore_record(record, attempt / "objects", excluded_paths)
    durability_barrier(flatten(restored))
    if not all(inspect_matches(record, attempt / "objects", excluded_paths) for record in parsed):
        fail("release rollback verification failed")
    phase(argparse.Namespace(root=args.root, phase="filesystem-restored"))


def barrier(args: argparse.Namespace) -> None:
    attempt = attempt_from_active(Path(args.root))
    _, snapshot = load_snapshot(attempt)
    records = snapshot.get("records")
    if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
        fail("invalid release snapshot record")
    paths = [Path(str(record["path"])) for record in flatten(records)]
    for raw in args.extra_path:
        candidate = Path(raw)
        if not candidate.is_absolute() or ".." in candidate.parts:
            fail("release durability barrier paths must be absolute and normalized")
        paths.append(candidate)
    for path in sorted(set(paths), key=lambda item: len(item.parts), reverse=True):
        reject_symlinked_ancestors(path)
        try:
            fsync_tree(path, set())
        except FileNotFoundError:
            pass
        try:
            fsync_path(path.parent)
        except FileNotFoundError:
            pass
    fsync_directory(attempt)


def finish(args: argparse.Namespace) -> None:
    root = Path(args.root)
    attempt = attempt_from_active(root)
    state = load_json(attempt / "state.json")
    allowed = {"committed"} if args.outcome == "committed" else {"rolled-back"}
    if state.get("phase") not in allowed:
        fail("release attempt cannot be cleaned before its terminal phase")
    (root / "active").unlink()
    fsync_directory(root)
    shutil.rmtree(attempt)
    fsync_directory(root / "attempts")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--root", required=True)
    commands = result.add_subparsers(dest="command", required=True)
    start = commands.add_parser("begin")
    start.add_argument("--nonce", required=True)
    start.add_argument("--release-sha256", required=True)
    start.add_argument("--profile-sha256", required=True)
    start.add_argument("--service-state-sha256", required=True)
    start.add_argument("--service-state-file", required=True)
    start.add_argument("--runtime-before", default="")
    start.add_argument("--node-before", default="")
    start.add_argument("--target-runtime", required=True)
    start.add_argument("--enable-agent", action="store_true")
    start.set_defaults(handler=begin)
    snapshot = commands.add_parser("capture")
    snapshot.add_argument("--path", action="append", default=[])
    snapshot.add_argument("--paths-file", action="append", default=[])
    snapshot.add_argument("--recursive", action="append", default=[])
    snapshot.add_argument("--exclude-path", action="append", default=[])
    snapshot.set_defaults(handler=capture)
    checkpoint = commands.add_parser("phase")
    checkpoint.add_argument("phase")
    checkpoint.set_defaults(handler=phase)
    inspect = commands.add_parser("status")
    inspect.set_defaults(handler=status)
    details = commands.add_parser("describe")
    details.set_defaults(handler=describe)
    rollback = commands.add_parser("restore")
    rollback.add_argument("--skip-path", action="append", default=[])
    rollback.set_defaults(handler=restore)
    durable = commands.add_parser("barrier")
    durable.add_argument("--extra-path", action="append", default=[])
    durable.set_defaults(handler=barrier)
    complete = commands.add_parser("finish")
    complete.add_argument("outcome", choices=("committed", "rolled-back"))
    complete.set_defaults(handler=finish)
    return result


def main() -> None:
    arguments = parser().parse_args()
    arguments.handler(arguments)


if __name__ == "__main__":
    main()
