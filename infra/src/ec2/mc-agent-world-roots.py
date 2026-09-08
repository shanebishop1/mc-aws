#!/usr/bin/env python3
"""Publish and verify the immutable world-root configuration generation.

The active symlink is the only commit point.  A generation is completely
written, hashed, and fsynced before that symlink is replaced, so a crash can
leave either the previous generation or the new generation visible, never a
mixture of their files.
"""

import argparse
import base64
import grp
import hashlib
import hmac
import json
import os
import pwd
import re
import secrets
import socket
import socketserver
import stat
import struct
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath

DEFAULT_ROOTS = ["world", "world_nether", "world_the_end"]
GENERATION_FILES = ("world-roots.json", "gateway.json", "executor.json")
TRANSACTION_SOCKET = Path("/run/mc-agent-world-roots/transaction.sock")
TRANSACTION_KEY = Path("/etc/mc-agent/executor-journal-hmac.key")
TRANSACTION_SERVER_ROOT = Path("/opt/minecraft/server")
TRANSACTION_MAX_BYTES = 4 * 1024 * 1024


def fail(message):
    raise ValueError(message)


def validate_roots(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 64:
        fail("persistent world roots are invalid")
    roots = []
    for root in value:
        if not isinstance(root, str) or not root or len(root) > 4096 or "\x00" in root or "\\" in root:
            fail("persistent world roots must be canonical workspace-relative paths")
        path = PurePosixPath(root)
        if path.is_absolute() or root in (".", "..") or any(part in ("", ".", "..") for part in root.split("/")):
            fail("persistent world roots must be canonical workspace-relative paths")
        if str(path) != root:
            fail("persistent world roots must be canonical workspace-relative paths")
        roots.append(root)
    if len(set(roots)) != len(roots):
        fail("persistent world roots must be unique")
    return roots


def read_json(path, label, required=True):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        fail(f"{label} is not a safe regular file")
    try:
        with path.open(encoding="utf-8") as source:
            value = json.load(source)
    except FileNotFoundError:
        if not required:
            return None
        fail(f"{label} is missing")
    except (OSError, json.JSONDecodeError) as error:
        fail(f"{label} is malformed: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def config_roots(path, label, required=True):
    value = read_json(path, label, required)
    if value is None:
        return None, None
    if "persistentWorldRoots" not in value:
        fail(f"{label} has no persistentWorldRoots")
    return value, validate_roots(value["persistentWorldRoots"])


def explicit_roots(path):
    value = read_json(path, "canonical world-roots config", required=False)
    if value is None:
        return None
    if set(value) != {"schemaVersion", "persistentWorldRoots"} or value["schemaVersion"] != 1:
        fail("canonical world-roots config has an invalid schema")
    return validate_roots(value["persistentWorldRoots"])


PROPERTY_WHITESPACE = " \t\f"


def decode_property_escapes(value):
    """Decode the escapes used by java.util.Properties.load(Reader)."""
    result = []
    index = 0
    while index < len(value):
        character = value[index]
        if character != "\\":
            result.append(character)
            index += 1
            continue
        index += 1
        if index == len(value):
            # A terminal continuation marker is removed while logical lines
            # are assembled, but retaining this check prevents an accidental
            # permissive fallback if that invariant is ever changed.
            fail("server.properties has a dangling escape")
        escaped = value[index]
        if escaped == "u":
            digits = value[index + 1 : index + 5]
            if len(digits) != 4 or any(digit not in "0123456789abcdefABCDEF" for digit in digits):
                fail("server.properties has an invalid unicode escape")
            result.append(chr(int(digits, 16)))
            index += 5
        else:
            result.append({"t": "\t", "n": "\n", "r": "\r", "f": "\f"}.get(escaped, escaped))
            index += 1
    return "".join(result)


def physical_property_lines(text):
    """Split only on Java Reader natural line terminators: LF, CR, or CRLF.

    str.splitlines() is intentionally not used: it also treats form-feed,
    vertical-tab, NEL, and Unicode line/paragraph separators as line endings,
    while java.util.Properties treats those as whitespace or ordinary value
    characters.
    """
    physical = []
    start = 0
    index = 0
    while index < len(text):
        if text[index] not in "\r\n":
            index += 1
            continue
        physical.append(text[start:index])
        if text[index] == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
            index += 1
        index += 1
        start = index
    if start < len(text):
        physical.append(text[start:])
    return physical


def logical_property_lines(text):
    physical = physical_property_lines(text)
    logical = []
    current = ""
    continuing = False
    for line in physical:
        if continuing:
            line = line.lstrip(PROPERTY_WHITESPACE)
        slash_count = 0
        for character in reversed(line):
            if character != "\\":
                break
            slash_count += 1
        if slash_count % 2:
            current += line[:-1]
            continuing = True
        else:
            current += line
            logical.append(current)
            current = ""
            continuing = False
    if current or continuing:
        # java.util.Properties accepts a final continued line at EOF; the
        # continuation marker itself has already been removed above.
        logical.append(current)
    return logical


def parse_property_line(line):
    start = 0
    while start < len(line) and line[start] in PROPERTY_WHITESPACE:
        start += 1
    if start == len(line) or line[start] in "#!":
        return None

    separator = None
    escaped = False
    for index in range(start, len(line)):
        character = line[index]
        if escaped:
            escaped = False
        elif character == "\\":
            escaped = True
        elif character in "=:" or character in PROPERTY_WHITESPACE:
            separator = index
            break
    if separator is None:
        key_raw, value_raw = line[start:], ""
    else:
        key_raw = line[start:separator]
        value_start = separator
        while value_start < len(line) and line[value_start] in PROPERTY_WHITESPACE:
            value_start += 1
        if value_start < len(line) and line[value_start] in "=:":
            value_start += 1
            while value_start < len(line) and line[value_start] in PROPERTY_WHITESPACE:
                value_start += 1
        value_raw = line[value_start:]
    return decode_property_escapes(key_raw), decode_property_escapes(value_raw)


def level_name_from_server_properties(path):
    try:
        # Read bytes first so Python's universal-newline layer cannot rewrite
        # CR/CRLF before the exact Java Properties line grammar sees them.
        text = path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return "world"
    except (OSError, UnicodeError) as error:
        fail(f"server.properties is malformed: {error}")
    level_name = None
    try:
        for line in logical_property_lines(text):
            property_value = parse_property_line(line)
            if property_value is not None and property_value[0] == "level-name":
                # java.util.Properties uses the last value for duplicate keys.
                level_name = property_value[1]
    except (ValueError, TypeError) as error:
        fail(f"server.properties is malformed: {error}")
    return "world" if level_name is None else level_name


def roots_from_server_properties(path):
    level_name = level_name_from_server_properties(path)
    return validate_roots([level_name, f"{level_name}_nether", f"{level_name}_the_end"])


def roots_with_reviewed_additions(level_name, reviewed, previous_level=None):
    dimensions = [level_name, f"{level_name}_nether", f"{level_name}_the_end"]
    if previous_level is None:
        # Direct reconciliation has no old properties snapshot. Canonical
        # generations put the old level's three derived roots first; only
        # those exact entries are discarded when they can be identified.
        old_level = reviewed[0] if reviewed else None
        old_dimensions = ([old_level, f"{old_level}_nether", f"{old_level}_the_end"] if old_level else [])
    else:
        old_dimensions = [previous_level, f"{previous_level}_nether", f"{previous_level}_the_end"]
    additions = [root for root in reviewed if root not in old_dimensions]
    return validate_roots(list(dict.fromkeys(dimensions + additions)))


def layout(args):
    parent = args.roots_config.parent
    # The installed member path is normally
    # /etc/mc-agent/world-roots-current/world-roots.json, while the generation
    # directory and publication symlink are siblings of world-roots-current.
    if parent.name == "world-roots-current":
        parent = parent.parent
    return parent / "world-roots-generations", parent / "world-roots-current"


def installed_path(path, name, generations, current):
    """Use the current generation, with a one-time legacy migration fallback."""
    if path.exists() or path.is_symlink():
        return path
    current_member = current / name
    if path == current_member:
        legacy = path.parent.parent / name
        if legacy.exists() or legacy.is_symlink():
            return legacy
    return path


def canonical_roots(args):
    generations, current = layout(args)
    roots_path = installed_path(args.roots_config, "world-roots.json", generations, current)
    gateway_path = installed_path(args.gateway_config, "gateway.json", generations, current)
    executor_path = installed_path(args.executor_config, "executor.json", generations, current)
    restored = explicit_roots(args.restored_roots_file) if args.restored_roots_file is not None else None
    explicit = explicit_roots(roots_path)
    gateway, gateway_roots = config_roots(gateway_path, "installed gateway config", required=False)
    executor, executor_roots = config_roots(executor_path, "installed executor config", required=False)
    if gateway_roots is not None and executor_roots is not None and gateway_roots != executor_roots:
        fail("installed gateway and executor persistent world roots mismatch")
    existing = restored if restored is not None else (explicit if explicit is not None else (gateway_roots if gateway_roots is not None else executor_roots))
    intended = roots_from_server_properties(args.server_properties)
    current_level = level_name_from_server_properties(args.server_properties)
    previous_level = None
    if args.previous_server_properties is not None and args.previous_server_properties.exists():
        previous_level = level_name_from_server_properties(args.previous_server_properties)
    if restored is not None:
        # The restore manifest is authenticated, reviewed metadata from the
        # backup.  It is authoritative even when the current reviewed profile
        # overlays a different level-name: deriving replacement dimensions in
        # that case would silently discard exact custom roots from the backup.
        return restored, gateway, executor
    if existing is None:
        return intended, gateway, executor

    # A profile's server.properties is the explicit source of a level-name
    # transition. Do not let the previous generation silently win: publish a
    # complete new generation below. A custom allowlist remains authoritative
    # when a profile is reapplied without changing its level name.
    if previous_level is not None and previous_level != current_level:
        return roots_with_reviewed_additions(current_level, existing, previous_level), gateway, executor
    if args.server_properties.exists() and existing != intended:
        # Without an old properties snapshot the transition is ambiguous. Do
        # not silently discard the reviewed allowlist or fall back to derived
        # defaults; profile reconciliation supplies the snapshot when a
        # transition is explicit.
        return existing, gateway, executor
    return existing, gateway, executor


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_write(path, data, mode=0o600, uid=None, gid=None):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        offset = 0
        while offset < len(data):
            written = os.write(descriptor, data[offset:])
            if written < 1:
                fail("durable write made no progress")
            offset += written
        if uid is not None or gid is not None:
            os.fchown(descriptor, -1 if uid is None else uid, -1 if gid is None else gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def validate_generation(generation_dir, expected_generation=None):
    if generation_dir.is_symlink() or not generation_dir.is_dir():
        fail("world-root generation is incomplete")
    if (generation_dir.stat().st_mode & 0o777) != 0o755:
        fail("world-root generation permissions are unsafe")
    manifest_path = generation_dir / "generation.json"
    manifest = read_json(manifest_path, "world-root generation manifest")
    if set(manifest) != {"schemaVersion", "generation", "files"} or manifest["schemaVersion"] != 1:
        fail("world-root generation manifest is invalid")
    generation = manifest["generation"]
    if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{64}", generation):
        fail("world-root generation identifier is invalid")
    if expected_generation is not None and generation != expected_generation:
        fail("active world-root generation does not match its manifest")
    files = manifest["files"]
    if not isinstance(files, dict) or set(files) != set(GENERATION_FILES):
        fail("world-root generation file inventory is incomplete")
    contents = {}
    for name in (*GENERATION_FILES, "generation.json"):
        path = generation_dir / name
        if path.is_symlink() or not path.is_file():
            fail("world-root generation contains an incomplete or unsafe file")
        if (path.stat().st_mode & 0o777) != 0o644:
            fail("world-root generation file permissions are unsafe")
    for name in GENERATION_FILES:
        path = generation_dir / name
        data = path.read_bytes()
        record = files[name]
        if (
            not isinstance(record, dict)
            or set(record) != {"bytes", "sha256"}
            or record["bytes"] != len(data)
            or not isinstance(record["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
            or record["sha256"] != digest(data)
        ):
            fail("world-root generation digest or size mismatch")
        contents[name] = json.loads(data)
    if digest(b"".join((generation_dir / name).read_bytes() for name in GENERATION_FILES)) != generation:
        fail("world-root generation identifier does not match its contents")
    roots = validate_roots(contents["world-roots.json"].get("persistentWorldRoots"))
    if contents["world-roots.json"].keys() != {"schemaVersion", "persistentWorldRoots"} or contents["world-roots.json"]["schemaVersion"] != 1:
        fail("world-root generation canonical config is invalid")
    for name in ("gateway.json", "executor.json"):
        if validate_roots(contents[name].get("persistentWorldRoots")) != roots:
            fail("canonical, gateway, and executor persistent world roots mismatch")
    return roots, contents


def active_generation(args):
    generations, current = layout(args)
    if current.is_symlink():
        target = os.readlink(current)
        expected_prefix = "world-roots-generations/"
        if not target.startswith(expected_prefix) or "/" in target[len(expected_prefix) :] or target.endswith("/"):
            fail("active world-root generation link is unsafe")
        generation = target[len(expected_prefix) :]
        return generations / generation, current, generation
    if current.exists():
        fail("active world-root generation link is unsafe")
    fail("active world-root generation is missing")


def publish_generation(args, values):
    generations, current = layout(args)
    generations.mkdir(mode=0o755, parents=True, exist_ok=True)
    if (
        generations.is_symlink()
        or not generations.is_dir()
        or (generations.stat().st_mode & 0o777) != 0o755
        or current.is_dir() and not current.is_symlink()
    ):
        fail("world-root generation layout is unsafe")
    files = {name: encoded(values[name]) for name in GENERATION_FILES}
    generation = digest(b"".join(files[name] for name in GENERATION_FILES))
    generation_dir = generations / generation
    if generation_dir.exists() or generation_dir.is_symlink():
        validate_generation(generation_dir, generation)
    else:
        temporary = Path(tempfile.mkdtemp(prefix=f".{generation}.", dir=generations))
        try:
            for name, data in files.items():
                path = temporary / name
                path.write_bytes(data)
                os.chmod(path, 0o644)
                descriptor = os.open(path, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            manifest = {
                "schemaVersion": 1,
                "generation": generation,
                "files": {name: {"bytes": len(data), "sha256": digest(data)} for name, data in files.items()},
            }
            manifest_path = temporary / "generation.json"
            manifest_path.write_bytes(encoded(manifest))
            os.chmod(manifest_path, 0o644)
            descriptor = os.open(manifest_path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.chmod(temporary, 0o755)
            fsync_directory(temporary)
            os.replace(temporary, generation_dir)
            fsync_directory(generations)
        finally:
            if temporary.exists():
                for item in temporary.iterdir():
                    item.unlink()
                temporary.rmdir()
    # This is the single commit point.  If it is interrupted, the old link is
    # untouched; after it succeeds, the target is already a complete set.
    link = generations.name + "/" + generation
    temporary_link = current.parent / f".{current.name}.{secrets.token_hex(8)}"
    try:
        os.symlink(link, temporary_link)
        os.replace(temporary_link, current)
        fsync_directory(current.parent)
    finally:
        temporary_link.unlink(missing_ok=True)


def reconcile(args):
    roots, installed_gateway, _installed_executor = canonical_roots(args)
    gateway_template, _ = config_roots(args.gateway_template, "gateway template")
    executor_template, _ = config_roots(args.executor_template, "executor template")
    gateway = dict(installed_gateway) if installed_gateway is not None else dict(gateway_template)
    gateway["persistentWorldRoots"] = roots
    executor_template = dict(executor_template)
    executor_template["persistentWorldRoots"] = roots
    publish_generation(
        args,
        {"world-roots.json": {"schemaVersion": 1, "persistentWorldRoots": roots}, "gateway.json": gateway, "executor.json": executor_template},
    )
    verify(args)


def verify(args):
    if args.generation_dir is not None:
        # In the executor chroot systemd bind-mounts the already-resolved
        # current generation at /config. Validate that complete generation
        # without requiring access to the host's /etc tree.
        validate_generation(args.generation_dir)
    else:
        generation_dir, _current, generation = active_generation(args)
        validate_generation(generation_dir, generation)


def inspect(args):
    generation_dir, _current, generation = active_generation(args)
    roots, _contents = validate_generation(generation_dir, generation)
    if args.output == "generation":
        print(generation)
    else:
        print(json.dumps({"schemaVersion": 1, "persistentWorldRoots": roots}, separators=(",", ":"), sort_keys=True))


def activate(args, generation=None):
    generations, current = layout(args)
    generation = generation or args.generation
    generation_dir = generations / generation
    validate_generation(generation_dir, generation)
    temporary_link = current.parent / f".{current.name}.{secrets.token_hex(8)}"
    try:
        os.symlink(generations.name + "/" + generation, temporary_link)
        os.replace(temporary_link, current)
        fsync_directory(current.parent)
    finally:
        temporary_link.unlink(missing_ok=True)
    verify(args)


def transaction(args):
    """Commit server.properties and its derived root generation as one recovery unit.

    The file rename is the first irreversible filesystem change.  If generation
    publication or verification fails, both the prior file bytes and the prior
    generation link are restored before the error is returned to the caller.
    The caller fences concurrent configuration transitions until this function
    and its postcondition verification have completed.
    """
    source = args.staged_server_properties
    destination = args.server_properties
    deleting = getattr(args, "delete_server_properties", False)
    if deleting and source is not None:
        fail("server.properties transaction cannot replace and delete together")
    if not deleting and (source is None or source.is_symlink() or not source.is_file()):
        fail("staged server.properties is not a regular file")
    if destination.is_symlink() or (destination.exists() and not destination.is_file()):
        fail("server.properties destination is unsafe")
    _generations, current = layout(args)
    previous_target = os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        fail("active world-root generation path is unsafe")
    previous_bytes = destination.read_bytes() if destination.exists() else None
    previous_metadata = destination.stat() if destination.exists() else None
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = destination.parent / f".{destination.name}.{secrets.token_hex(8)}.transaction"
    reconcile_previous = None
    try:
        if args.previous_server_properties is None:
            reconcile_previous = destination.parent / f".{destination.name}.{secrets.token_hex(8)}.previous"
            durable_write(reconcile_previous, previous_bytes or b"")
            args.previous_server_properties = reconcile_previous
        if deleting:
            destination.unlink(missing_ok=True)
        else:
            source_metadata = source.stat()
            owner_name = getattr(args, "server_properties_owner", None)
            group_name = getattr(args, "server_properties_group", None)
            owner_uid = pwd.getpwnam(owner_name).pw_uid if owner_name else (
                previous_metadata.st_uid if previous_metadata is not None else source_metadata.st_uid
            )
            owner_gid = grp.getgrnam(group_name).gr_gid if group_name else (
                previous_metadata.st_gid if previous_metadata is not None else source_metadata.st_gid
            )
            mode = previous_metadata.st_mode & 0o777 if previous_metadata is not None else source_metadata.st_mode & 0o777
            data = source.read_bytes()
            durable_write(temporary, data, mode=mode, uid=owner_uid, gid=owner_gid)
            os.replace(temporary, destination)
        fsync_directory(destination.parent)
        reconcile(args)
    except Exception:
        try:
            if previous_bytes is None:
                destination.unlink(missing_ok=True)
                fsync_directory(destination.parent)
            else:
                rollback = destination.parent / f".{destination.name}.{secrets.token_hex(8)}.rollback"
                durable_write(
                    rollback,
                    previous_bytes,
                    mode=previous_metadata.st_mode & 0o777,
                    uid=previous_metadata.st_uid,
                    gid=previous_metadata.st_gid,
                )
                os.replace(rollback, destination)
                fsync_directory(destination.parent)
            if previous_target is None:
                current.unlink(missing_ok=True)
                fsync_directory(current.parent)
            else:
                generation = previous_target.removeprefix("world-roots-generations/")
                if not re.fullmatch(r"[a-f0-9]{64}", generation):
                    raise ValueError("previous world-root generation link is unsafe")
                activate(args, generation)
        except Exception as rollback_error:
            raise ValueError(f"server.properties/root generation rollback failed: {rollback_error}") from rollback_error
        raise
    finally:
        temporary.unlink(missing_ok=True)
        if reconcile_previous is not None:
            reconcile_previous.unlink(missing_ok=True)


def canonical_transaction_request(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def broker_arguments(source, deleting):
    return argparse.Namespace(
        roots_config=Path("/etc/mc-agent/world-roots-current/world-roots.json"),
        gateway_config=Path("/etc/mc-agent/world-roots-current/gateway.json"),
        executor_config=Path("/etc/mc-agent/world-roots-current/executor.json"),
        gateway_template=Path("/opt/setup/runtime/mc-agent-gateway.json"),
        executor_template=Path("/opt/setup/runtime/mc-agent-executor.json"),
        server_properties=TRANSACTION_SERVER_ROOT / "server.properties",
        staged_server_properties=source,
        previous_server_properties=None,
        restored_roots_file=None,
        generation=None,
        generation_dir=None,
        delete_server_properties=deleting,
        server_properties_owner="minecraft",
        server_properties_group="minecraft",
    )


def copy_broker_candidate(stage_name, expected_bytes, expected_digest):
    if not isinstance(stage_name, str) or re.fullmatch(r"\.mc-agent-(?:download-)?[A-Za-z0-9-]{1,128}", stage_name) is None:
        fail("world-root transaction staging name is invalid")
    stage = TRANSACTION_SERVER_ROOT / stage_name
    descriptor = os.open(stage, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size != expected_bytes:
            fail("world-root transaction staging file is unsafe")
        data = b""
        while len(data) <= TRANSACTION_MAX_BYTES:
            chunk = os.read(descriptor, min(65536, TRANSACTION_MAX_BYTES + 1 - len(data)))
            if not chunk:
                break
            data += chunk
    finally:
        os.close(descriptor)
    if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_digest:
        fail("world-root transaction staging evidence changed")
    state = Path("/var/lib/mc-agent-world-roots")
    candidate = state / f".server.properties.{secrets.token_hex(16)}"
    durable_write(candidate, data, mode=0o600)
    fsync_directory(state)
    return candidate, stage


def process_broker_request(raw, key, peer_uid, peer_gid):
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("world-root transaction request is malformed") from error
    required = {"schemaVersion", "action", "stageName", "bytes", "sha256", "issuedAt", "nonce", "mac"}
    if not isinstance(request, dict) or set(request) != required or request.get("schemaVersion") != 1:
        fail("world-root transaction request schema is invalid")
    # Filesystem mode root:mc-agent:0660 gates connection establishment. The
    # domain-separated HMAC below authenticates the confined executor even when
    # PrivateUsers maps SO_PEERCRED IDs differently in the broker namespace.
    del peer_uid, peer_gid
    action = request["action"]
    expected_bytes = request["bytes"]
    expected_digest = request["sha256"]
    if action not in ("replace", "delete") or type(expected_bytes) is not int or not 0 <= expected_bytes <= TRANSACTION_MAX_BYTES:
        fail("world-root transaction action is invalid")
    if type(request["issuedAt"]) is not int or abs(int(time.time() * 1000) - request["issuedAt"]) > 30000:
        fail("world-root transaction request expired")
    if not isinstance(request["nonce"], str) or re.fullmatch(r"[a-f0-9]{32}", request["nonce"]) is None:
        fail("world-root transaction nonce is invalid")
    if not isinstance(request["mac"], str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", request["mac"]) is None:
        fail("world-root transaction authentication is invalid")
    unsigned = dict(request)
    supplied_mac = unsigned.pop("mac")
    expected_mac = base64.urlsafe_b64encode(
        hmac.new(key, b"mc-aws-world-root-transaction:v1\n" + canonical_transaction_request(unsigned), hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(supplied_mac, expected_mac):
        fail("world-root transaction authentication is invalid")
    if action == "delete":
        if request["stageName"] is not None or expected_bytes != 0 or expected_digest != hashlib.sha256(b"").hexdigest():
            fail("world-root deletion request is invalid")
        transaction(broker_arguments(None, True))
    else:
        if not isinstance(expected_digest, str) or re.fullmatch(r"[a-f0-9]{64}", expected_digest) is None:
            fail("world-root transaction digest is invalid")
        candidate, stage = copy_broker_candidate(request["stageName"], expected_bytes, expected_digest)
        try:
            transaction(broker_arguments(candidate, False))
            try:
                stage.unlink()
                fsync_directory(stage.parent)
            except OSError:
                pass
        finally:
            candidate.unlink(missing_ok=True)
            fsync_directory(candidate.parent)
    _generation_dir, _current, generation = active_generation(broker_arguments(None, False))
    return {"schemaVersion": 1, "committed": True, "generation": generation}


class WorldRootTransactionHandler(socketserver.StreamRequestHandler):
    def handle(self):
        peer_pid, peer_uid, peer_gid = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        del peer_pid
        raw = self.rfile.readline(8193)
        try:
            if not raw.endswith(b"\n") or len(raw) > 8192:
                fail("world-root transaction request exceeds its bound")
            response = process_broker_request(raw[:-1], self.server.authentication_key, peer_uid, peer_gid)
        except (OSError, ValueError, KeyError) as error:
            response = {"schemaVersion": 1, "committed": False, "error": str(error)}
        self.wfile.write(canonical_transaction_request(response) + b"\n")
        self.wfile.flush()


class WorldRootTransactionServer(socketserver.UnixStreamServer):
    def __init__(self, address, handler, authentication_key):
        self.authentication_key = authentication_key
        super().__init__(address, handler)


def serve(_args):
    key_metadata = TRANSACTION_KEY.lstat()
    if not stat.S_ISREG(key_metadata.st_mode) or key_metadata.st_nlink != 1 or key_metadata.st_uid != 0 or key_metadata.st_mode & 0o077:
        fail("world-root transaction authentication key is unsafe")
    key = TRANSACTION_KEY.read_bytes()
    if len(key) < 32 or len(key) > 1024:
        fail("world-root transaction authentication key is invalid")
    TRANSACTION_SOCKET.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    socket_parent = TRANSACTION_SOCKET.parent.lstat()
    expected_group = grp.getgrnam("mc-agent").gr_gid
    if (
        not stat.S_ISDIR(socket_parent.st_mode)
        or socket_parent.st_uid != 0
        or socket_parent.st_gid != expected_group
        or stat.S_IMODE(socket_parent.st_mode) != 0o750
    ):
        fail("world-root transaction socket directory is unsafe")
    state = Path("/var/lib/mc-agent-world-roots")
    state_metadata = state.lstat()
    if not stat.S_ISDIR(state_metadata.st_mode) or state_metadata.st_uid != 0 or stat.S_IMODE(state_metadata.st_mode) != 0o700:
        fail("world-root transaction state directory is unsafe")
    if TRANSACTION_SOCKET.exists() or TRANSACTION_SOCKET.is_symlink():
        TRANSACTION_SOCKET.unlink()
    with WorldRootTransactionServer(str(TRANSACTION_SOCKET), WorldRootTransactionHandler, key) as server:
        os.chown(TRANSACTION_SOCKET, 0, expected_group)
        os.chmod(TRANSACTION_SOCKET, 0o660)
        fsync_directory(TRANSACTION_SOCKET.parent)
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            TRANSACTION_SOCKET.unlink(missing_ok=True)


def parser():
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("reconcile", "transaction", "verify", "inspect", "activate", "serve"))
    result.add_argument("--generation")
    result.add_argument("--output", choices=("generation", "roots-json"), default="generation")
    result.add_argument("--restored-roots-file", type=Path)
    result.add_argument("--gateway-template", type=Path)
    result.add_argument("--executor-template", type=Path)
    result.add_argument("--gateway-config", type=Path, default=Path("/etc/mc-agent/world-roots-current/gateway.json"))
    result.add_argument("--executor-config", type=Path, default=Path("/etc/mc-agent/world-roots-current/executor.json"))
    result.add_argument("--roots-config", type=Path, default=Path("/etc/mc-agent/world-roots-current/world-roots.json"))
    result.add_argument("--server-properties", type=Path, default=Path("/opt/minecraft/server/server.properties"))
    result.add_argument("--staged-server-properties", type=Path)
    result.add_argument("--delete-server-properties", action="store_true")
    result.add_argument("--server-properties-owner")
    result.add_argument("--server-properties-group")
    result.add_argument("--previous-server-properties", type=Path)
    result.add_argument("--generation-dir", type=Path)
    return result


def main():
    args = parser().parse_args()
    if args.command == "reconcile":
        if args.gateway_template is None or args.executor_template is None:
            fail("reconcile requires both config templates")
        reconcile(args)
    elif args.command == "transaction":
        if args.gateway_template is None or args.executor_template is None or (args.staged_server_properties is None) == (not args.delete_server_properties):
            fail("transaction requires both config templates and exactly one replace/delete operation")
        transaction(args)
    elif args.command == "serve":
        serve(args)
    elif args.command == "activate":
        if args.generation is None or re.fullmatch(r"[a-f0-9]{64}", args.generation) is None:
            fail("activate requires one exact generation")
        activate(args)
    elif args.command == "inspect":
        inspect(args)
    else:
        verify(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
