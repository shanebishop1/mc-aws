#!/usr/bin/env python3
"""Durable boot inhibition for host release activation."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path


SCHEMA_VERSION = 1
OPERATION_PHASES = {
    "host-replacement": {
        "prepared", "quiescing", "quiesced", "uploading", "archive-uploaded",
        "publishing-manifest", "uploaded", "terminal-quiesced", "restoring-services",
        "stopped", "recovery",
    },
    "runtime-rollout": {"fencing", "prepared", "recovering", "validating"},
    "restore": {
        "prepared", "quiescing", "runtime-quiesced", "profile-staged", "roots-review-recorded", "moving-previous",
        "previous-moved", "installing", "installed", "roots-published", "retention-planned",
        "retained", "commit-pending", "committed", "restoring-services", "rollback-started",
        "rollback-files-restored", "rollback-roots-restored", "rollback-restoring-services",
    },
    "backup": {
        "prepared", "quiescing", "quiesced", "uploading", "archive-uploaded",
        "publishing-manifest", "uploaded", "restoring-services",
    },
    "hibernate": {
        "prepared", "quiescing", "quiesced", "uploading", "archive-uploaded",
        "publishing-manifest", "uploaded", "terminal-quiesced", "restoring-services",
    },
    "destroy": {
        "prepared", "quiescing", "quiesced", "uploading", "archive-uploaded",
        "publishing-manifest", "uploaded", "terminal-quiesced", "restoring-services",
    },
    "replacement": {
        "prepared", "quiescing", "quiesced", "uploading", "archive-uploaded",
        "publishing-manifest", "uploaded", "terminal-quiesced", "restoring-services",
    },
    "agent-maintenance": {
        "prepared", "quiescing", "quiesced", "editing", "restarting", "verified", "restoring-services",
        "effect-unknown", "verification-unresolved", "restoration-unresolved", "recovery",
    },
}


def fail(message: str) -> None:
    raise SystemExit(message)


def canonical(value: object) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, value: bytes, mode: int = 0o644, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if exclusive:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
    else:
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            os.fchmod(descriptor, mode)
            with os.fdopen(descriptor, "wb") as output:
                output.write(value)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    fsync_directory(path.parent)


def read_marker(path: Path) -> dict[str, object]:
    metadata = path.lstat()
    expected_uid = os.geteuid()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != expected_uid
        or stat.S_IMODE(metadata.st_mode) != 0o644
    ):
        fail("maintenance boot hold has unsafe metadata")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        value = json.loads(os.read(descriptor, 16384))
    except (OSError, ValueError):
        fail("maintenance boot hold is malformed")
    finally:
        os.close(descriptor)
    if (
        not isinstance(value, dict)
        or set(value) not in (
            {"schemaVersion", "operation", "owner", "attempt", "phase", "bootId"},
            {"schemaVersion", "operation", "owner", "attempt", "phase", "bootId", "details"},
        )
        or value.get("schemaVersion") != SCHEMA_VERSION
        or value.get("operation") not in OPERATION_PHASES
        or not isinstance(value.get("owner"), str)
        or not value["owner"]
        or not isinstance(value.get("attempt"), str)
        or not isinstance(value.get("phase"), str)
        or value["phase"] not in OPERATION_PHASES[value["operation"]]
        or not isinstance(value.get("bootId"), str)
        or not value["bootId"]
        or ("details" in value and (
            value["operation"] != "agent-maintenance"
            or not isinstance(value["details"], dict)
            or len(json.dumps(value["details"], ensure_ascii=True, separators=(",", ":"))) > 32768
        ))
    ):
        fail("maintenance boot hold has an invalid schema")
    return value


def boot_id(path: Path) -> str:
    value = path.read_text(encoding="ascii").strip()
    if not value:
        fail("boot ID is unavailable")
    return value


def parsed_details(raw: str | None, operation: str) -> dict[str, object] | None:
    if raw is None:
        return None
    if operation != "agent-maintenance":
        fail("maintenance boot hold details are reserved for agent maintenance")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        fail("maintenance boot hold details are malformed")
    if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=True, separators=(",", ":"))) > 32768:
        fail("maintenance boot hold details must be one bounded object")
    return value


def create(args: argparse.Namespace) -> None:
    path = Path(args.marker)
    if args.phase not in OPERATION_PHASES[args.operation]:
        fail("maintenance boot hold phase is invalid for its operation")
    details = parsed_details(args.details_json, args.operation)
    value = {
        "schemaVersion": SCHEMA_VERSION,
        "operation": args.operation,
        "owner": args.owner,
        "attempt": args.attempt,
        "phase": args.phase,
        "bootId": boot_id(Path(args.boot_id_file)),
        **({"details": details} if details is not None else {}),
    }
    atomic_write(path, canonical(value), exclusive=True)


def inspect(args: argparse.Namespace) -> None:
    print(json.dumps(read_marker(Path(args.marker)), separators=(",", ":"), sort_keys=True))


def assert_owned(args: argparse.Namespace) -> None:
    value = read_marker(Path(args.marker))
    if value["owner"] != args.owner:
        fail("maintenance boot hold ownership changed")


def update(args: argparse.Namespace) -> None:
    path = Path(args.marker)
    value = read_marker(path)
    if value["owner"] != args.owner:
        fail("maintenance boot hold ownership changed")
    if args.phase not in OPERATION_PHASES[value["operation"]]:
        fail("maintenance boot hold phase is invalid for its operation")
    value["phase"] = args.phase
    value["bootId"] = boot_id(Path(args.boot_id_file))
    if args.attempt is not None:
        value["attempt"] = args.attempt
    if args.details_json is not None:
        value["details"] = parsed_details(args.details_json, str(value["operation"]))
    atomic_write(path, canonical(value))


def clear(args: argparse.Namespace) -> None:
    path = Path(args.marker)
    value = read_marker(path)
    if value["owner"] != args.owner:
        fail("maintenance boot hold ownership changed; retaining hold")
    path.unlink()
    fsync_directory(path.parent)


def reassert(args: argparse.Namespace) -> None:
    value = read_marker(Path(args.marker))
    fence = Path(args.fence)
    expected = canonical({
        "schemaVersion": 1,
        "owner": value["owner"],
        "operation": value["operation"],
        "phase": "boot-inhibited",
    })
    try:
        current = fence.read_bytes()
    except FileNotFoundError:
        atomic_write(fence, expected, exclusive=True)
        return
    if current != expected:
        fail("volatile maintenance fence conflicts with durable boot hold")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--marker", default="/var/lib/mc-aws/maintenance-boot-hold.json")
    result.add_argument("--boot-id-file", default="/proc/sys/kernel/random/boot_id")
    commands = result.add_subparsers(dest="command", required=True)
    start = commands.add_parser("create")
    start.add_argument("--owner", required=True)
    start.add_argument("--operation", choices=tuple(OPERATION_PHASES), default="runtime-rollout")
    start.add_argument("--attempt", default="")
    start.add_argument("--phase", default="fencing")
    start.add_argument("--details-json")
    start.set_defaults(handler=create)
    show = commands.add_parser("inspect")
    show.set_defaults(handler=inspect)
    owned = commands.add_parser("assert-owned")
    owned.add_argument("--owner", required=True)
    owned.set_defaults(handler=assert_owned)
    phase = commands.add_parser("phase")
    phase.add_argument("--owner", required=True)
    phase.add_argument("--phase", required=True)
    phase.add_argument("--attempt")
    phase.add_argument("--details-json")
    phase.set_defaults(handler=update)
    remove = commands.add_parser("clear")
    remove.add_argument("--owner", required=True)
    remove.set_defaults(handler=clear)
    repair = commands.add_parser("reassert")
    repair.add_argument("--fence", default="/run/mc-agent/maintenance-state.json")
    repair.set_defaults(handler=reassert)
    return result


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
