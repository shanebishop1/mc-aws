#!/usr/bin/env python3
"""Root-owned broker for one MOTD maintenance edit and a namespaced console bridge."""

from __future__ import annotations

import base64
import datetime as dt
import grp
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import selectors
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SOCKET = Path(os.environ.get("MC_HOST_BROKER_SOCKET", "/run/mc-agent/host-broker.sock"))
KEY = Path(os.environ.get("MC_HOST_BROKER_KEY", "/etc/mc-agent/executor-journal-hmac.key"))
SERVER = Path(os.environ.get("MC_SERVER_ROOT", "/opt/minecraft/server"))
PROPERTIES = SERVER / "server.properties"
WORLD_ROOTS = Path(os.environ.get("MC_WORLD_ROOTS_HELPER", "/usr/local/bin/mc-agent-world-roots.py"))
JAVA_PROPERTIES = Path(os.environ.get("MC_JAVA_PROPERTIES_HELPER", str(WORLD_ROOTS)))
WORLD_ROOTS_SOCKET = Path(os.environ.get("MC_WORLD_ROOTS_SOCKET", "/run/mc-agent-world-roots/transaction.sock"))
HOST_OPERATION = Path(os.environ.get("MC_HOST_OPERATION_HELPER", "/usr/local/bin/mc-host-operation.py"))
HOST_OPERATION_CONTRACT = Path(os.environ.get("MC_HOST_OPERATION_CONTRACT", "/etc/mc-agent/host-operation-contract.json"))
EXECUTOR_JOURNAL = Path(os.environ.get("MC_EXECUTOR_JOURNAL", "/var/lib/mc-agent-executor/executor-effect-journal.json"))
GATEWAY_JOURNAL = Path(os.environ.get("MC_GATEWAY_JOURNAL", "/var/lib/mc-agent-gateway/executor-reconciliations.json"))
BACKUP_PUBLIC_KEY = Path(os.environ.get("MC_BACKUP_FENCE_PUBLIC_KEY", "/etc/mc-agent/backup-fence-public.pem"))
BOOT_HELPER = Path(os.environ.get("MC_MAINTENANCE_BOOT_HELPER", "/usr/local/bin/mc-maintenance-boot.py"))
BOOT_MARKER = Path(os.environ.get("MC_MAINTENANCE_BOOT_HOLD", "/var/lib/mc-aws/maintenance-boot-hold.json"))
BOOT_ID_FILE = Path(os.environ.get("MC_BOOT_ID_FILE", "/proc/sys/kernel/random/boot_id"))
FENCE = Path(os.environ.get("MC_MAINTENANCE_LOCK", "/run/mc-agent/maintenance-state.json"))
OPERATION_LOCK = Path(os.environ.get("MC_OPERATION_LOCK", "/run/mc-agent/host-operation.lock"))
SYSTEMCTL = os.environ.get("MC_SYSTEMCTL_BIN", "/usr/bin/systemctl")
RUNUSER = os.environ.get("MC_RUNUSER_BIN", "/usr/sbin/runuser")
SCREEN = os.environ.get("MC_SCREEN_BIN", "/usr/bin/screen")
MCSTATUS = Path(os.environ.get("MC_STATUS_BIN", "/usr/local/bin/mcstatus"))
OPENSSL = os.environ.get("MC_OPENSSL_BIN", "/usr/bin/openssl")
MAX_CONFIG_BYTES = 1024 * 1024
MAX_PROCESS_OUTPUT = 64 * 1024
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
SIGNATURE = re.compile(r"^[A-Za-z0-9_-]{86}$")
USERNAME = re.compile(r"^[A-Za-z0-9_]{1,16}$")
SUPPORTED_CONFIG_KEY = "motd"
RECOVERY_COMMAND = "sudo /usr/local/bin/mc-agent-host-broker.py --reconcile-agent-maintenance"


class BrokerError(ValueError):
    pass


def fail(message: str) -> None:
    raise BrokerError(message)


def strict_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON field")
        result[key] = value
    return result


def parse_json(raw: bytes, label: str) -> object:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=strict_object,
                          parse_constant=lambda _value: fail("non-finite JSON number"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BrokerError(f"{label} is not strict JSON") from error


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def exact(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} schema is invalid")
    return value


def read_key(allow_fixture: bool = False) -> bytes:
    metadata = KEY.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
            or (metadata.st_uid != 0 and not allow_fixture) or stat.S_IMODE(metadata.st_mode) != 0o400):
        fail("host broker authentication key metadata is unsafe")
    value = KEY.read_bytes()
    if len(value) != 32:
        fail("host broker authentication key is invalid")
    return value


def verify_mac(request: dict[str, object], key: bytes) -> None:
    supplied = request.pop("mac", None)
    if not isinstance(supplied, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", supplied):
        fail("host broker authentication is invalid")
    expected = base64.urlsafe_b64encode(
        hmac.new(key, b"mc-aws-host-broker:v1\n" + canonical(request), hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(supplied, expected):
        fail("host broker authentication is invalid")


def validate_identity(value: object) -> dict[str, object]:
    item = exact(value, {"schemaVersion", "runtimeId", "leaseId", "leaseGeneration", "taskId", "sessionId",
                         "invocationId", "invocationDigest"}, "invocation")
    if (item["schemaVersion"] != 1
            or any(not isinstance(item[name], str) or not ID.fullmatch(item[name])
                   for name in ("runtimeId", "leaseId", "taskId", "sessionId", "invocationId"))
            or type(item["leaseGeneration"]) is not int or item["leaseGeneration"] < 1
            or not isinstance(item["invocationDigest"], str) or not DIGEST.fullmatch(item["invocationDigest"])):
        fail("invocation identity is invalid")
    return item


def run_bounded(arguments: list[str], timeout: float, *, capture: bool = False, check: bool = False,
                cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run one fixed argv while bounding elapsed time and captured output."""
    if not capture:
        try:
            return subprocess.run(arguments, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  timeout=timeout, cwd=cwd, env=env)
        except (OSError, subprocess.SubprocessError) as error:
            raise BrokerError(f"host helper failed: {Path(arguments[0]).name}") from error
    try:
        process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd, env=env)
    except OSError as error:
        raise BrokerError(f"host helper failed: {Path(arguments[0]).name}") from error
    assert process.stdout is not None
    descriptor = process.stdout.fileno()
    os.set_blocking(descriptor, False)
    selector = selectors.DefaultSelector()
    selector.register(descriptor, selectors.EVENT_READ)
    output = bytearray()
    deadline = time.monotonic() + timeout
    eof = False
    try:
        while process.poll() is None or not eof:
            if time.monotonic() >= deadline:
                process.kill()
                process.wait(timeout=5)
                fail(f"host helper timed out: {Path(arguments[0]).name}")
            for _key, _events in selector.select(0.1):
                chunk = os.read(descriptor, 8192)
                if not chunk:
                    eof = True
                    selector.unregister(descriptor)
                    break
                output.extend(chunk)
                if len(output) > MAX_PROCESS_OUTPUT:
                    process.kill()
                    process.wait(timeout=5)
                    fail(f"host helper output exceeded its bound: {Path(arguments[0]).name}")
        returncode = process.wait(timeout=1)
    finally:
        selector.close()
        process.stdout.close()
    result = subprocess.CompletedProcess(arguments, returncode, bytes(output), b"")
    if check and returncode != 0:
        fail(f"host helper rejected the operation: {Path(arguments[0]).name}")
    return result


def parse_time(value: object, label: str) -> dt.datetime:
    if not isinstance(value, str) or len(value) > 64:
        fail(f"{label} is invalid")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise BrokerError(f"{label} is invalid") from error
    if parsed.tzinfo is None:
        fail(f"{label} is invalid")
    return parsed


def validate_backup(value: object, identity: dict[str, object]) -> tuple[dict[str, object], str]:
    required = {"schemaVersion", "status", "authorizationId", "runtimeId", "leaseId", "leaseGeneration",
                "sessionId", "taskId", "invocationId", "invocationDigest", "backupId", "lifecycleLockId",
                "lifecycleFencingToken", "lifecycleLeaseGeneration", "lifecycleLeaseExpiresAt", "issuedAt",
                "expiresAt", "signature"}
    optional = {"executorKeyId", "executorKeyEpoch"}
    if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - optional:
        fail("backup authorization schema is invalid")
    item = value
    if (item["schemaVersion"] != 1 or item["status"] != "succeeded"
            or any(not isinstance(item[name], str) or not ID.fullmatch(item[name]) for name in (
                "authorizationId", "runtimeId", "leaseId", "sessionId", "taskId", "invocationId", "backupId",
                "lifecycleLockId",
            ))
            or type(item["leaseGeneration"]) is not int or item["leaseGeneration"] < 1
            or type(item["lifecycleFencingToken"]) is not int or item["lifecycleFencingToken"] < 1
            or type(item["lifecycleLeaseGeneration"]) is not int or item["lifecycleLeaseGeneration"] < 1
            or not isinstance(item["invocationDigest"], str) or not DIGEST.fullmatch(item["invocationDigest"])
            or not isinstance(item["signature"], str) or not SIGNATURE.fullmatch(item["signature"])):
        fail("backup authorization is invalid")
    for field in ("runtimeId", "leaseId", "leaseGeneration", "sessionId", "taskId", "invocationId", "invocationDigest"):
        if item[field] != identity[field]:
            fail("backup authorization is bound to another invocation")
    now = dt.datetime.now(dt.timezone.utc)
    issued = parse_time(item["issuedAt"], "backup authorization issuance")
    expires = parse_time(item["expiresAt"], "backup authorization expiry")
    lease_expires = parse_time(item["lifecycleLeaseExpiresAt"], "backup lifecycle lease expiry")
    if expires <= issued or expires <= now or lease_expires <= now or expires > lease_expires:
        fail("backup authorization is expired or outside its lifecycle lease")
    if (("executorKeyId" in item) != ("executorKeyEpoch" in item)
            or ("executorKeyId" in item and (not isinstance(item["executorKeyId"], str)
                or not ID.fullmatch(item["executorKeyId"])
                or type(item["executorKeyEpoch"]) is not int or item["executorKeyEpoch"] < 1))):
        fail("backup authorization executor key binding is invalid")
    metadata = BACKUP_PUBLIC_KEY.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_mode & 0o022
            or (metadata.st_uid != 0 and os.environ.get("MC_HOST_BROKER_TEST_MODE") != "1")):
        fail("backup authorization public key metadata is unsafe")
    signature = base64.urlsafe_b64decode(str(item["signature"]) + "==")
    unsigned = {name: child for name, child in item.items() if name != "signature"}
    content = canonical(unsigned)
    content_fd, content_name = tempfile.mkstemp(prefix=".backup-fence-content-", dir=SOCKET.parent)
    signature_fd, signature_name = tempfile.mkstemp(prefix=".backup-fence-signature-", dir=SOCKET.parent)
    try:
        os.write(content_fd, content)
        os.write(signature_fd, signature)
        os.fsync(content_fd)
        os.fsync(signature_fd)
        os.close(content_fd)
        os.close(signature_fd)
        content_fd = signature_fd = -1
        run_bounded([OPENSSL, "pkeyutl", "-verify", "-pubin", "-inkey", str(BACKUP_PUBLIC_KEY), "-rawin",
                     "-in", content_name, "-sigfile", signature_name], 10, check=True)
    finally:
        if content_fd >= 0:
            os.close(content_fd)
        if signature_fd >= 0:
            os.close(signature_fd)
        Path(content_name).unlink(missing_ok=True)
        Path(signature_name).unlink(missing_ok=True)
    stable = {name: child for name, child in item.items() if name not in {
        "issuedAt", "expiresAt", "signature", "lifecycleLeaseGeneration", "lifecycleLeaseExpiresAt",
        "executorKeyId", "executorKeyEpoch",
    }}
    return item, hashlib.sha256(canonical(stable)).hexdigest()


def verify_active_effect(identity: dict[str, object], backup_fingerprint: str | None = None) -> dict[str, object]:
    arguments = [str(HOST_OPERATION), "--contract", str(HOST_OPERATION_CONTRACT), "executor-active-effect",
                 "--journal", str(EXECUTOR_JOURNAL), "--credential", str(KEY),
                 "--gateway-journal", str(GATEWAY_JOURNAL), "--runtime-id", str(identity["runtimeId"]),
                 "--session-id", str(identity["sessionId"]), "--task-id", str(identity["taskId"]),
                 "--lease-id", str(identity["leaseId"]), "--lease-generation", str(identity["leaseGeneration"]),
                 "--invocation-id", str(identity["invocationId"]),
                 "--invocation-digest", str(identity["invocationDigest"])]
    if backup_fingerprint is not None:
        arguments.extend(["--backup-authorization-fingerprint", backup_fingerprint])
    result = run_bounded(arguments, 15, capture=True, check=True)
    observed = parse_json(result.stdout.strip(), "active executor authority")
    if (not isinstance(observed, dict) or observed.get("schemaVersion") != 1
            or type(observed.get("generation")) is not int or observed["generation"] < 1
            or type(observed.get("recordSequence")) is not int or observed["recordSequence"] < 1
            or not isinstance(observed.get("effectFingerprint"), str)
            or not DIGEST.fullmatch(observed["effectFingerprint"])
            or (backup_fingerprint is not None
                and observed.get("backupAuthorizationFingerprint") != backup_fingerprint)):
        fail("active executor authority evidence is invalid")
    return observed


def commit_world_root_transaction(staged: str, result: bytes, key: bytes) -> str:
    request = {
        "schemaVersion": 1,
        "action": "replace",
        "stageName": Path(staged).name,
        "bytes": len(result),
        "sha256": hashlib.sha256(result).hexdigest(),
        "issuedAt": int(time.time() * 1000),
        "nonce": secrets.token_hex(16),
    }
    request["mac"] = base64.urlsafe_b64encode(
        hmac.new(key, b"mc-aws-world-root-transaction:v1\n" + canonical(request), hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(35)
    received = bytearray()
    try:
        client.connect(str(WORLD_ROOTS_SOCKET))
        client.sendall(canonical(request) + b"\n")
        client.shutdown(socket.SHUT_WR)
        while b"\n" not in received:
            chunk = client.recv(8192)
            if not chunk:
                fail("world-root transaction response was lost")
            received.extend(chunk)
            if len(received) > 8192:
                fail("world-root transaction response exceeded its bound")
    except (OSError, TimeoutError) as error:
        raise BrokerError("world-root transaction transport is unresolved") from error
    finally:
        client.close()
    if received.count(b"\n") != 1 or not received.endswith(b"\n"):
        fail("world-root transaction response framing is invalid")
    response = parse_json(bytes(received[:-1]), "world-root transaction response")
    if not isinstance(response, dict) or response.get("schemaVersion") != 1:
        fail("world-root transaction response is invalid")
    if response.get("committed") is not True:
        fail("world-root transaction did not report a commit")
    generation = response.get("generation")
    if not isinstance(generation, str) or not DIGEST.fullmatch(generation):
        fail("world-root transaction generation is invalid")
    return generation


def write_json(path: Path, value: object, mode: int = 0o644) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(value) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)


def fence_for(identity: dict[str, object]) -> dict[str, object]:
    return {"schemaVersion": 1, "owner": f"agent-maintenance:{identity['invocationId']}",
            "operation": "agent-maintenance", "phase": "applying", "activeInvocation": identity}


def acquire_fence(identity: dict[str, object]) -> None:
    expected = fence_for(identity)
    if FENCE.exists() or FENCE.is_symlink():
        if FENCE.is_symlink():
            fail("maintenance fence is unsafe")
        try:
            current = parse_json(FENCE.read_bytes(), "maintenance fence")
        except OSError as error:
            raise BrokerError("maintenance fence is unreadable") from error
        recovered = {"schemaVersion": 1, "owner": expected["owner"], "operation": "agent-maintenance",
                     "phase": "boot-inhibited"}
        if current not in (expected, recovered):
            fail("another maintenance owner holds the host fence")
        if current == recovered:
            write_json(FENCE, expected)
        return
    write_json(FENCE, expected)


def clear_fence(identity: dict[str, object]) -> None:
    if not FENCE.exists():
        return
    current = parse_json(FENCE.read_bytes(), "maintenance fence")
    expected = fence_for(identity)
    recovered = {"schemaVersion": 1, "owner": expected["owner"], "operation": "agent-maintenance",
                 "phase": "boot-inhibited"}
    if current not in (expected, recovered):
        fail("maintenance fence ownership changed; retaining exclusion")
    FENCE.unlink()
    descriptor = os.open(FENCE.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def marker_owner(identity: dict[str, object]) -> str:
    return f"agent-maintenance:{identity['invocationId']}"


def marker_command(identity: dict[str, object], command: str, *arguments: str) -> None:
    run_bounded([str(BOOT_HELPER), "--marker", str(BOOT_MARKER), "--boot-id-file", str(BOOT_ID_FILE),
                 command, "--owner", marker_owner(identity), *arguments], 10, check=True)


def create_marker(identity: dict[str, object], details: dict[str, object]) -> None:
    run_bounded([str(BOOT_HELPER), "--marker", str(BOOT_MARKER), "--boot-id-file", str(BOOT_ID_FILE), "create",
                 "--owner", marker_owner(identity), "--operation", "agent-maintenance",
                 "--attempt", str(identity["invocationDigest"]), "--phase", "prepared",
                 "--details-json", canonical(details).decode("utf-8")], 10, check=True)


def update_marker(identity: dict[str, object], phase: str, details: dict[str, object]) -> None:
    marker_command(identity, "phase", "--phase", phase, "--details-json", canonical(details).decode("utf-8"))


def read_marker() -> dict[str, object]:
    marker = parse_json(BOOT_MARKER.read_bytes(), "maintenance boot hold")
    if not isinstance(marker, dict):
        fail("maintenance boot hold is invalid")
    return marker


def service_active() -> bool:
    return run_bounded([SYSTEMCTL, "is-active", "--quiet", "minecraft.service"], 10).returncode == 0


def service_enablement() -> str:
    result = run_bounded([SYSTEMCTL, "is-enabled", "minecraft.service"], 10, capture=True)
    value = result.stdout.decode("utf-8", "strict").strip() or ("disabled" if result.returncode else "enabled")
    if value not in {"enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "not-found"}:
        fail("Minecraft service enablement is unsupported")
    return value


def quiesce_service() -> None:
    run_bounded([SYSTEMCTL, "mask", "--runtime", "minecraft.service"], 15, check=True)
    run_bounded([SYSTEMCTL, "stop", "minecraft.service"], 30, check=True)
    if service_active():
        fail("Minecraft service did not quiesce")


def restore_service(identity: dict[str, object], details: dict[str, object]) -> None:
    before = details.get("serviceBefore")
    if not isinstance(before, dict) or set(before) != {"active", "enablement"} or type(before["active"]) is not bool:
        fail("retained Minecraft service state is unavailable")
    update_marker(identity, "restoring-services", details)
    enablement = before["enablement"]
    if before["active"] and enablement == "masked":
        run_bounded([SYSTEMCTL, "unmask", "minecraft.service"], 15, check=True)
    elif before["active"] and enablement == "masked-runtime":
        run_bounded([SYSTEMCTL, "unmask", "--runtime", "minecraft.service"], 15, check=True)
    elif enablement != "masked-runtime":
        run_bounded([SYSTEMCTL, "unmask", "--runtime", "minecraft.service"], 15, check=True)
    run_bounded([SYSTEMCTL, "start" if before["active"] else "stop", "minecraft.service"], 45, check=True)
    if before["active"] and enablement == "masked":
        run_bounded([SYSTEMCTL, "mask", "minecraft.service"], 15, check=True)
    elif before["active"] and enablement == "masked-runtime":
        run_bounded([SYSTEMCTL, "mask", "--runtime", "minecraft.service"], 15, check=True)
    if service_active() != before["active"] or service_enablement() != enablement:
        fail("Minecraft service intent was not restored exactly")


_PROPERTIES_MODULE = None


def properties_module():
    global _PROPERTIES_MODULE
    if _PROPERTIES_MODULE is None:
        # The installed helper tree is immutable and the broker must not create
        # import artifacts beside reviewed root-owned source.
        sys.dont_write_bytecode = True
        specification = importlib.util.spec_from_file_location("mc_agent_java_properties", JAVA_PROPERTIES)
        if specification is None or specification.loader is None:
            fail("Java properties parser is unavailable")
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        for name in ("logical_property_lines", "parse_property_line"):
            if not callable(getattr(module, name, None)):
                fail("Java properties parser contract is unavailable")
        _PROPERTIES_MODULE = module
    return _PROPERTIES_MODULE


def physical_lines(text: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    start = 0
    index = 0
    while index < len(text):
        if text[index] not in "\r\n":
            index += 1
            continue
        ending = text[index]
        if ending == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
            ending = "\r\n"
        result.append((text[start:index], ending))
        index += len(ending)
        start = index
    if start < len(text):
        result.append((text[start:], ""))
    return result


def logical_groups(text: str) -> list[tuple[str, list[tuple[str, str]]]]:
    groups: list[tuple[str, list[tuple[str, str]]]] = []
    current = ""
    members: list[tuple[str, str]] = []
    continuing = False
    for content, ending in physical_lines(text):
        logical = content.lstrip(" \t\f") if continuing else content
        slash_count = len(logical) - len(logical.rstrip("\\"))
        members.append((content, ending))
        if slash_count % 2:
            current += logical[:-1]
            continuing = True
        else:
            current += logical
            groups.append((current, members))
            current, members, continuing = "", [], False
    if current or continuing:
        groups.append((current, members))
    module = properties_module()
    if [logical for logical, _members in groups] != module.logical_property_lines(text):
        fail("Java properties parser boundary mismatch")
    return groups


def encode_property_value(value: str) -> str:
    result = []
    for index, character in enumerate(value):
        if character == "\\":
            result.append("\\\\")
        elif index == 0 and character == " ":
            result.append("\\ ")
        else:
            result.append(character)
    return "".join(result)


def parsed_properties(text: str) -> list[tuple[str, str]]:
    module = properties_module()
    result = []
    for logical in module.logical_property_lines(text):
        parsed = module.parse_property_line(logical)
        if parsed is not None:
            result.append(parsed)
    return result


def edit_properties(data: bytes, key: str, value: str) -> bytes:
    if key != SUPPORTED_CONFIG_KEY:
        fail("only the independently observable motd setting is supported")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BrokerError("server.properties is not UTF-8") from error
    if "\x00" in text:
        fail("server.properties contains NUL")
    groups = logical_groups(text)
    module = properties_module()
    matches = [index for index, (logical, _members) in enumerate(groups)
               if (module.parse_property_line(logical) or (None, None))[0] == key]
    if len(matches) > 1:
        fail("duplicate decoded motd properties require operator reconciliation")
    rendered = f"motd={encode_property_value(value)}"
    output: list[str] = []
    for index, (_logical, members) in enumerate(groups):
        if index == (matches[0] if matches else -1):
            output.append(rendered + (members[0][1] or "\n"))
        else:
            output.extend(content + ending for content, ending in members)
    if not matches:
        if text and not text.endswith(("\r", "\n")):
            output.append("\n")
        output.append(rendered + "\n")
    result = "".join(output)
    before_semantics = [item for item in parsed_properties(text) if item[0] != key]
    after = parsed_properties(result)
    if [item for item in after if item[0] != key] != before_semantics or [item for item in after if item[0] == key] != [(key, value)]:
        fail("server.properties edit changed unapproved property semantics")
    return result.encode("utf-8")


def protocol_status(expected_motd: str) -> dict[str, object]:
    result = run_bounded([str(MCSTATUS), "127.0.0.1:25565", "status"], 8, capture=True,
                         env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
    if result.returncode != 0:
        fail("Minecraft protocol observation failed")
    observed = None
    for raw in result.stdout.decode("utf-8", "strict").splitlines():
        if ":" in raw:
            name, content = raw.split(":", 1)
            if name.strip().lower() in ("motd", "description"):
                observed = content.strip()
    if observed != expected_motd:
        fail("Minecraft protocol observation did not match the approved MOTD")
    return {"protocol": "minecraft-status", "host": "127.0.0.1", "port": 25565,
            "motd": observed, "independentlyObserved": True}


def query_players() -> list[str]:
    result = run_bounded([str(MCSTATUS), "127.0.0.1:25565", "query"], 8, capture=True,
                         env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
    if result.returncode != 0:
        fail("Minecraft query observation failed")
    for raw in result.stdout.decode("utf-8", "strict").splitlines():
        if ":" not in raw:
            continue
        name, content = raw.split(":", 1)
        if name.strip().lower() != "players":
            continue
        match = re.fullmatch(r"(\d+)/(\d+)(?:\s+(.+))?", content.strip())
        if not match:
            break
        online = int(match.group(1))
        players = [] if match.group(3) is None else re.split(r"[\s,]+", match.group(3).strip())
        if len(players) != online or any(not USERNAME.fullmatch(player) for player in players):
            break
        return players
    fail("exact Minecraft player observation is unavailable")


def acquire_lock() -> int:
    import fcntl
    descriptor = os.open(OPERATION_LOCK, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(descriptor)
        fail("another host lifecycle operation is active")
    return descriptor


def validate_config_request(request: dict[str, object], identity: dict[str, object]) -> tuple[dict[str, object], dict[str, object], str]:
    if request.get("schemaVersion") != 1 or request.get("operation") != "maintenance.apply" or request.get("serviceIntent") != "restore-prior":
        fail("maintenance request is invalid")
    config = exact(request.get("config"), {"schemaVersion", "path", "key", "value", "expectedSha256",
                                           "expectedBytes", "resultSha256", "resultBytes"}, "maintenance config")
    value = config.get("value")
    if (config["schemaVersion"] != 1 or config["path"] != "server.properties" or config["key"] != SUPPORTED_CONFIG_KEY
            or not isinstance(value, str) or not value or len(value) > 1024 or value != value.strip()
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)):
        fail("maintenance supports only one canonical, independently observable MOTD value")
    for name in ("expectedSha256", "resultSha256"):
        if not isinstance(config[name], str) or not DIGEST.fullmatch(config[name]):
            fail("maintenance digest is invalid")
    for name in ("expectedBytes", "resultBytes"):
        if type(config[name]) is not int or not 1 <= config[name] <= MAX_CONFIG_BYTES:
            fail("maintenance byte identity is invalid")
    expected = exact(request.get("expectedProtocol"), {"schemaVersion", "host", "port", "motd"}, "expected protocol")
    if expected != {"schemaVersion": 1, "host": "127.0.0.1", "port": 25565, "motd": value}:
        fail("expected protocol must exactly observe the approved MOTD")
    backup, backup_fingerprint = validate_backup(request.get("backup"), identity)
    return config, backup, backup_fingerprint


def base_details(identity: dict[str, object], config: dict[str, object], expected: dict[str, object],
                 backup_fingerprint: str) -> dict[str, object]:
    binding = {"invocation": identity, "config": config, "serviceIntent": "restore-prior",
               "expectedProtocol": expected, "backupAuthorizationFingerprint": backup_fingerprint}
    return {"schemaVersion": 1, "requestBindingSha256": hashlib.sha256(canonical(binding)).hexdigest(),
            **binding, "serviceBefore": None, "effectState": "not-entered"}


def recovery_response(effect_state: str, message: str, invocation_id: str, verification: str = "unresolved") -> dict[str, object]:
    return {"schemaVersion": 1, "ok": False, "effectState": effect_state, "verification": verification,
            "error": message[:256], "summary": message[:512],
            "output": {"verification": verification, "noAutoRetry": True,
                        "operatorAction": f"{RECOVERY_COMMAND} {invocation_id}"}}


def retain_unknown(identity: dict[str, object], details: dict[str, object], message: str) -> dict[str, object]:
    """Best-effort durable uncertainty publication; never erase the retained exclusion."""
    details["effectState"] = "unknown"
    try:
        update_marker(identity, "effect-unknown", details)
    except Exception:
        # The existing marker and volatile fence are safer than allowing an
        # error while publishing uncertainty to become a false no-effect.
        pass
    return recovery_response("unknown", message, str(identity["invocationId"]))


def exact_file_identity(config: dict[str, object], which: str) -> bool:
    try:
        data = PROPERTIES.read_bytes()
    except OSError:
        return False
    return len(data) == config[f"{which}Bytes"] and hashlib.sha256(data).hexdigest() == config[f"{which}Sha256"]


def clear_maintenance(identity: dict[str, object]) -> None:
    # Clearing the volatile fence first is safe only after verified restoration;
    # a crash before durable-marker removal causes boot recovery to reassert it.
    clear_fence(identity)
    marker_command(identity, "clear")


def finish_committed(identity: dict[str, object], config: dict[str, object], expected: dict[str, object],
                     details: dict[str, object]) -> dict[str, object]:
    if not exact_file_identity(config, "result"):
        details["effectState"] = "unknown"
        update_marker(identity, "effect-unknown", details)
        return recovery_response("unknown", "Retained maintenance result identity no longer matches the live file.",
                                 str(identity["invocationId"]))
    details["effectState"] = "committed"
    try:
        restore_service(identity, details)
    except Exception as error:
        update_marker(identity, "restoration-unresolved", details)
        return recovery_response("committed", f"MOTD committed, but exact service restoration is unresolved: {error}",
                                 str(identity["invocationId"]))
    try:
        observed = protocol_status(str(expected["motd"]))
    except Exception as error:
        update_marker(identity, "verification-unresolved", details)
        return recovery_response("committed", f"MOTD committed, but protocol verification is unresolved: {error}",
                                 str(identity["invocationId"]))
    update_marker(identity, "verified", details)
    clear_maintenance(identity)
    return {"schemaVersion": 1, "ok": True, "effectState": "committed", "committed": True,
            "verification": "observed", "summary": "Approved MOTD committed and independently observed.",
            "output": {"committed": True, "verification": "observed", "configSha256": config["resultSha256"],
                       "configBytes": config["resultBytes"], "protocol": observed}}


def reconcile_retained(identity: dict[str, object], expected_details: dict[str, object] | None = None) -> dict[str, object]:
    marker = read_marker()
    details = marker.get("details")
    if (marker.get("operation") != "agent-maintenance" or marker.get("owner") != marker_owner(identity)
            or marker.get("attempt") != identity["invocationDigest"] or not isinstance(details, dict)):
        fail("retained maintenance operation belongs to another identity")
    if expected_details is not None and details.get("requestBindingSha256") != expected_details["requestBindingSha256"]:
        fail("retained maintenance request binding changed")
    config = details.get("config")
    expected = details.get("expectedProtocol")
    if not isinstance(config, dict) or not isinstance(expected, dict):
        fail("retained maintenance intent is malformed")
    state = details.get("effectState")
    if state in ("entering", "unknown"):
        if exact_file_identity(config, "result"):
            details["effectState"] = "committed"
            update_marker(identity, "restarting", details)
            return finish_committed(identity, config, expected, details)
        update_marker(identity, "effect-unknown", details)
        return recovery_response("unknown", "Effect entry was recorded, but the exact MOTD transaction result is not present; inspect the retained marker and live world-root generation without retrying.", str(identity["invocationId"]))
    if state == "not-entered":
        if details.get("serviceBefore") is not None:
            try:
                restore_service(identity, details)
            except Exception as error:
                update_marker(identity, "restoration-unresolved", details)
                return recovery_response("unknown", f"No configuration effect entered, but service restoration is unresolved: {error}", str(identity["invocationId"]))
        clear_maintenance(identity)
        return {"schemaVersion": 1, "ok": False, "effectState": "not-entered", "verification": "not-required",
                "error": "Retained operation had not entered the configuration effect and was safely closed.", "output": {}}
    if state == "committed":
        return finish_committed(identity, config, expected, details)
    fail("retained maintenance effect state is invalid")


def apply_maintenance(request: dict[str, object]) -> dict[str, object]:
    identity = validate_identity(request.get("invocation"))
    config, _backup, backup_fingerprint = validate_config_request(request, identity)
    expected = request["expectedProtocol"]
    assert isinstance(expected, dict)
    details = base_details(identity, config, expected, backup_fingerprint)
    lock = acquire_lock()
    marker_created = False
    fence_acquired = False
    retained_marker = False
    try:
        if BOOT_MARKER.exists() or BOOT_MARKER.is_symlink():
            retained = read_marker()
            if retained.get("owner") != marker_owner(identity):
                fail("another durable maintenance owner holds the host")
            retained_marker = True
        acquire_fence(identity)
        fence_acquired = True
        if retained_marker:
            return reconcile_retained(identity, details)
        create_marker(identity, details)
        marker_created = True
        before = PROPERTIES.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_CONFIG_BYTES:
            fail("server.properties is unsafe")
        original = PROPERTIES.read_bytes()
        if len(original) != config["expectedBytes"] or hashlib.sha256(original).hexdigest() != config["expectedSha256"]:
            fail("server.properties changed since approval")
        result = edit_properties(original, str(config["key"]), str(config["value"]))
        if len(result) != config["resultBytes"] or hashlib.sha256(result).hexdigest() != config["resultSha256"]:
            fail("approved result identity does not match the canonical MOTD edit")
        details["serviceBefore"] = {"active": service_active(), "enablement": service_enablement()}
        if details["serviceBefore"]["active"] is not True:
            fail("maintenance requires the Minecraft service to be active")
        update_marker(identity, "quiescing", details)
        quiesce_service()
        update_marker(identity, "quiesced", details)
        # This is the last pre-entry check: signed renewable authority and the
        # exact HMAC journal/gateway dispatch must agree with this request.
        _current_backup, current_backup_fingerprint = validate_backup(request.get("backup"), identity)
        if current_backup_fingerprint != backup_fingerprint:
            fail("backup authorization binding changed before effect entry")
        verify_active_effect(identity, backup_fingerprint)
        details["effectState"] = "entering"
        update_marker(identity, "editing", details)
        descriptor, staged = tempfile.mkstemp(prefix=".mc-agent-maintenance-", dir=SERVER)
        try:
            os.fchmod(descriptor, stat.S_IMODE(before.st_mode))
            offset = 0
            while offset < len(result):
                written = os.write(descriptor, result[offset:])
                if written < 1:
                    fail("staged MOTD edit made no progress")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            generation = commit_world_root_transaction(staged, result, read_key(
                os.environ.get("MC_HOST_BROKER_TEST_MODE") == "1"
            ))
        finally:
            Path(staged).unlink(missing_ok=True)
        details["effectState"] = "committed"
        details["worldRootGeneration"] = generation
        update_marker(identity, "restarting", details)
        return finish_committed(identity, config, expected, details)
    except Exception as error:
        if retained_marker:
            return retain_unknown(identity, details, f"Retained maintenance reconciliation remains unresolved: {error}")
        if marker_created:
            if details["effectState"] in ("entering", "committed", "unknown"):
                return retain_unknown(identity, details, f"MOTD transaction outcome is unknown: {error}")
            if details.get("serviceBefore") is not None:
                try:
                    restore_service(identity, details)
                except Exception as restore_error:
                    return retain_unknown(
                        identity,
                        details,
                        f"Configuration effect did not enter, but service restoration failed: {restore_error}",
                    )
            try:
                clear_maintenance(identity)
            except Exception as clear_error:
                return retain_unknown(
                    identity,
                    details,
                    f"No configuration effect entered, but maintenance barrier release is unresolved: {clear_error}",
                )
            return {"schemaVersion": 1, "ok": False, "effectState": "not-entered", "verification": "not-required",
                    "error": str(error)[:256], "output": {}}
        if fence_acquired:
            try:
                clear_fence(identity)
            except Exception as clear_error:
                return recovery_response(
                    "unknown",
                    f"Pre-entry maintenance barrier release is unresolved: {clear_error}",
                    str(identity["invocationId"]),
                )
        raise
    finally:
        try:
            os.close(lock)
        except OSError:
            pass


def parse_console_command(command: str) -> tuple[str, str | None]:
    if command == "minecraft:list":
        return "list", None
    match = re.fullmatch(r"minecraft:kick ([A-Za-z0-9_]{1,16})(?: ([^\x00-\x1f\x7f]{1,128}))?", command)
    if match:
        return "kick", match.group(1)
    fail("console bridge supports only minecraft:list or minecraft:kick <exact-player> [reason]")


def execute_console(request: dict[str, object]) -> dict[str, object]:
    identity = validate_identity(request.get("invocation"))
    if (request.get("schemaVersion") != 1 or request.get("operation") != "console.execute"
            or not isinstance(request.get("command"), str) or not 1 <= len(request["command"]) <= 256
            or request["command"] != request["command"].strip()
            or any(character in request["command"] for character in "\r\n\x00")):
        fail("console request is invalid")
    timeout_ms = request.get("timeoutMs")
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 30_000:
        fail("console timeout is invalid")
    verb, player = parse_console_command(request["command"])
    verify_active_effect(identity)
    if not service_active():
        fail("Minecraft is not active")
    before = query_players()
    if verb == "list":
        return {"schemaVersion": 1, "ok": True, "effectState": "not-entered", "committed": False,
                "verification": "observed", "summary": "Independently observed the exact online player list.",
                "output": {"players": before, "independentlyObserved": True}}
    assert player is not None
    if player not in before:
        fail("requested player was not independently observed online before dispatch")
    try:
        result = run_bounded([RUNUSER, "--user", "minecraft", "--", SCREEN, "-S", "mc-server", "-p", "0", "-X",
                              "stuff", f"{request['command']}\r"], timeout_ms / 1000, cwd=SERVER,
                             env={"PATH": "/usr/bin:/bin", "HOME": str(SERVER), "USER": "minecraft", "LOGNAME": "minecraft"})
    except Exception as error:
        return recovery_response("unknown", f"Console transport outcome is unknown: {error}", str(identity["invocationId"]))
    if result.returncode != 0:
        return recovery_response("unknown", "Console transport started but did not prove command acceptance.",
                                 str(identity["invocationId"]))
    deadline = time.monotonic() + min(8, timeout_ms / 1000)
    while time.monotonic() < deadline:
        try:
            after = query_players()
            if player not in after:
                return {"schemaVersion": 1, "ok": True, "effectState": "committed", "committed": True,
                        "verification": "observed", "summary": "Namespaced kick dispatched and the exact player absence was independently observed.",
                        "output": {"dispatched": True, "player": player, "playersBefore": before, "playersAfter": after,
                                   "independentlyObserved": True}}
        except Exception:
            break
        time.sleep(0.25)
    return recovery_response("committed", "Namespaced kick was accepted, but exact player absence could not be independently observed.",
                             str(identity["invocationId"]))


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(5)
        try:
            raw = self.rfile.readline(65_537)
            response = process_raw(raw, self.server.authentication_key)  # type: ignore[attr-defined]
            self.wfile.write(canonical(response) + b"\n")
            self.wfile.flush()
        except (OSError, TimeoutError):
            return


def process_raw(raw: bytes, key: bytes) -> dict[str, object]:
    request: dict[str, object] | None = None
    authenticated = False
    try:
        if not raw.endswith(b"\n") or len(raw) > 65_536:
            fail("host broker request exceeds its bound")
        request = parse_json(raw[:-1], "host broker request")
        if not isinstance(request, dict):
            fail("host broker request is invalid")
        verify_mac(request, key)
        authenticated = True
        if request.get("operation") == "maintenance.apply":
            return apply_maintenance(request)
        if request.get("operation") == "console.execute":
            return execute_console(request)
        fail("host broker operation is invalid")
    except BrokerError as error:
        return {"schemaVersion": 1, "ok": False, "effectState": "not-entered", "verification": "not-required",
                "error": str(error)[:256], "output": {}}
    except Exception as error:
        invocation = request.get("invocation") if authenticated and request is not None else None
        invocation_id = invocation.get("invocationId") if isinstance(invocation, dict) else None
        if (request is not None and request.get("operation") in ("maintenance.apply", "console.execute")
                and isinstance(invocation_id, str) and ID.fullmatch(invocation_id)):
            return recovery_response("unknown", f"Host effect outcome is unknown: {error}", invocation_id)
        return {"schemaVersion": 1, "ok": False, "effectState": "not-entered", "verification": "not-required",
                "error": str(error)[:256], "output": {}}


class Server(socketserver.UnixStreamServer):
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, address: str, key: bytes, activated_fd: int | None = None):
        self.authentication_key = key
        if activated_fd is None:
            super().__init__(address, Handler)
            return
        super().__init__(address, Handler, bind_and_activate=False)
        self.socket.close()
        self.socket = socket.socket(fileno=os.dup(activated_fd))
        self.server_address = self.socket.getsockname()


def activated_fd() -> int | None:
    if os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
        return None
    return 3


def serve() -> None:
    key = read_key()
    fd = activated_fd()
    SOCKET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if fd is None and (SOCKET.exists() or SOCKET.is_symlink()):
        SOCKET.unlink()
    with Server(str(SOCKET), key, fd) as server:
        if fd is None:
            os.chown(SOCKET, 0, grp.getgrnam("mc-agent-executor-client").gr_gid)
            os.chmod(SOCKET, 0o660)
        server.serve_forever(poll_interval=0.25)


def reconcile_from_cli(invocation_id: str) -> None:
    if os.geteuid() != 0 and os.environ.get("MC_HOST_BROKER_TEST_MODE") != "1":
        fail("maintenance reconciliation requires root")
    marker = read_marker()
    details = marker.get("details")
    if not isinstance(details, dict) or not isinstance(details.get("invocation"), dict):
        fail("retained maintenance identity is unavailable")
    identity = validate_identity(details["invocation"])
    if identity["invocationId"] != invocation_id:
        fail("requested reconciliation identity does not own the retained operation")
    lock = acquire_lock()
    try:
        acquire_fence(identity)
        print(canonical(reconcile_retained(identity)).decode("utf-8"))
    finally:
        os.close(lock)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--once":
        print(canonical(process_raw(sys.stdin.buffer.readline(65_537),
                                    read_key(os.environ.get("MC_HOST_BROKER_TEST_MODE") == "1"))).decode("utf-8"))
    elif len(sys.argv) == 3 and sys.argv[1] == "--reconcile-agent-maintenance":
        reconcile_from_cli(sys.argv[2])
    elif len(sys.argv) == 1:
        serve()
    else:
        raise SystemExit("Usage: mc-agent-host-broker.py [--once|--reconcile-agent-maintenance <invocation-id>]")
