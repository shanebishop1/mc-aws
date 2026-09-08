#!/usr/bin/env python3
"""Root-only host-operation contract verifier and backup journal handoff helper."""

from __future__ import annotations

import argparse
import base64
import binascii
import copy
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_CONTRACT = "/etc/mc-agent/host-operation-contract.json"
DEFAULT_EXECUTOR_JOURNAL = "/var/lib/mc-agent-executor/executor-effect-journal.json"
DEFAULT_EXECUTOR_KEY = "/etc/mc-agent/executor-journal-hmac.key"
DEFAULT_GATEWAY_JOURNAL = "/var/lib/mc-agent-gateway/executor-reconciliations.json"
DEFAULT_BACKUP_JOURNAL = "/var/lib/mc-aws/mc-backup-journal.json"
MAX_JOURNAL_BYTES = 64 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
DIGEST = re.compile(r"[a-f0-9]{64}")
BACKUP_ID = re.compile(r"[a-f0-9]{32}")
BACKUP_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
OPERATION_KEY = re.compile(r"[a-f0-9]{64}")
MAC = re.compile(r"[A-Za-z0-9_-]{43}")
ISO_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z")
MAX_GENERATION = 9_007_199_254_740_991


class HostOperationError(ValueError):
    pass


def fail(message: str) -> None:
    raise HostOperationError(message)


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON field")
        result[key] = value
    return result


def parse_json(raw: bytes, label: str) -> Any:
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=strict_object,
            parse_constant=lambda _value: fail("non-finite JSON number"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HostOperationError(f"{label} is not strict JSON") from error


def exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} has an invalid schema")
    return value


def canonical_number(value: int | float) -> str:
    if isinstance(value, int):
        if abs(value) <= MAX_GENERATION:
            return str(value)
        try:
            value = float(value)
        except OverflowError as error:
            raise HostOperationError("non-finite canonical JSON number") from error
    if not math.isfinite(value):
        fail("non-finite canonical JSON number")
    if value == 0:
        return "0"
    rendered = repr(value).lower()
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        if "e" in rendered:
            coefficient, exponent = rendered.split("e")
            negative = coefficient.startswith("-")
            digits = coefficient.lstrip("-").replace(".", "")
            decimal_places = len(coefficient.lstrip("-").partition(".")[2])
            point = len(digits) - decimal_places + int(exponent)
            if point <= 0:
                rendered = f"0.{('0' * -point)}{digits}"
            elif point >= len(digits):
                rendered = f"{digits}{'0' * (point - len(digits))}"
            else:
                rendered = f"{digits[:point]}.{digits[point:]}"
            return f"-{rendered}" if negative else rendered
        if rendered.endswith(".0"):
            return rendered[:-2]
        return rendered
    if "e" not in rendered:
        return rendered
    coefficient, exponent = rendered.split("e")
    exponent_value = int(exponent)
    return f"{coefficient}e{'+' if exponent_value >= 0 else ''}{exponent_value}"


def canonical_text(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return canonical_number(value)
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise HostOperationError("canonical JSON contains an invalid Unicode scalar") from error
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return f"[{','.join(canonical_text(child) for child in value)}]"
    if isinstance(value, dict):
        try:
            fields = sorted(value, key=lambda field: field.encode("utf-16-be"))
        except (AttributeError, UnicodeEncodeError) as error:
            raise HostOperationError("canonical JSON object key is invalid") from error
        return "{" + ",".join(
            f"{canonical_text(field)}:{canonical_text(value[field])}" for field in fields
        ) + "}"
    fail("canonical JSON value is invalid")


def canonical(value: Any) -> bytes:
    return canonical_text(value).encode("utf-8")


def regular_file(path: Path, label: str, maximum: int) -> bytes:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size < 1 or metadata.st_size > maximum:
            fail(f"{label} is not one bounded regular file")
        with path.open("rb") as source:
            value = source.read(maximum + 1)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise HostOperationError(f"could not read {label}") from error
    if len(value) > maximum:
        fail(f"{label} exceeds its size limit")
    return value


def bounded_file(path: Path, label: str, maximum: int, allow_empty: bool = False) -> bytes:
    value = regular_file(path, label, maximum) if not allow_empty else None
    if value is not None:
        return value
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > maximum or metadata.st_mode & 0o077:
            fail(f"{label} is not one bounded regular file")
        value = path.read_bytes()
    except FileNotFoundError:
        raise
    except OSError as error:
        raise HostOperationError(f"could not read {label}") from error
    if len(value) > maximum:
        fail(f"{label} exceeds its size limit")
    return value


def sync_append_boundary(path: Path, boundary: int, maximum: int) -> None:
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size > maximum
            or metadata.st_mode & 0o077
            or boundary < 0
            or boundary > metadata.st_size
        ):
            fail("executor journal append file is unsafe to repair")
        if metadata.st_size != boundary:
            os.ftruncate(descriptor, boundary)
        os.fsync(descriptor)
    except OSError as error:
        raise HostOperationError("could not repair executor journal append boundary") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def load_contract(path: Path) -> dict[str, Any]:
    value = exact(
        parse_json(regular_file(path, "host-operation contract", 16 * 1024), "host-operation contract"),
        {"contract", "schemaVersion", "executorJournal", "gatewayReconciliationJournal", "backupJournal", "serviceState"},
        "host-operation contract",
    )
    if value["contract"] != "mc-aws-host-operation" or value["schemaVersion"] != 3:
        fail("host-operation contract version is unsupported")
    executor = exact(
        value["executorJournal"],
        {
            "schemaVersion", "path", "credentialPath", "macPrefix", "format", "checkpointSuffixes",
            "appendSuffixes", "floorSuffix", "manifestFields", "checkpointFields", "appendFields", "mutationFields",
            "mutationOperations", "floorFields", "evidenceFields", "replayFilterBytes", "replayFilterHashes",
            "acknowledgementFields", "statuses", "entryFields",
            "tombstoneFields", "maxEntries", "maxCancellationTombstones", "maxBytes", "maxGeneration",
        },
        "executor journal contract",
    )
    gateway = exact(
        value["gatewayReconciliationJournal"],
        {"schemaVersion", "path", "stateFields", "entryFields", "states", "maxEntries", "maxBytes"},
        "gateway reconciliation journal contract",
    )
    backup = exact(value["backupJournal"], {"version", "path", "phases", "modes", "maxGeneration"}, "backup journal contract")
    service_state = exact(value["serviceState"], {"units", "enablementStates"}, "service-state contract")
    if (
        executor["schemaVersion"] != 3
        or executor["path"] != DEFAULT_EXECUTOR_JOURNAL
        or executor["credentialPath"] != DEFAULT_EXECUTOR_KEY
        or executor["macPrefix"] != "mc-aws-executor-journal"
        or executor["format"] != "manifest-checkpoint-transaction-v1"
        or executor["checkpointSuffixes"] != [".checkpoint.0", ".checkpoint.1"]
        or executor["appendSuffixes"] != [".append.0", ".append.1"]
        or executor["floorSuffix"] != ".generation-floor"
        or executor["manifestFields"] != ["schemaVersion", "format", "generation", "checkpointGeneration", "appendGeneration", "generationFloor", "checkpointSlot", "appendSlot", "mac"]
        or executor["checkpointFields"] != ["schemaVersion", "format", "generation", "entries", "cancellationTombstones", "evidence", "mac"]
        or executor["appendFields"] != ["schemaVersion", "generation", "mutations", "mac"]
        or executor["mutationFields"] != ["operation", "key", "value"]
        or executor["mutationOperations"] != ["upsert-entry", "delete-entry", "upsert-tombstone", "delete-tombstone", "upsert-evidence", "delete-evidence"]
        or executor["floorFields"] != ["schemaVersion", "generationFloor", "mac"]
        or executor["evidenceFields"] != ["schemaVersion", "recordSequence", "acknowledgedCount", "latestTerminalSequence", "aggregateDigest", "replayFilter", "mac"]
        or executor["replayFilterBytes"] != 1_048_576 or executor["replayFilterHashes"] != 7
        or executor["acknowledgementFields"] != ["invocationId", "invocationDigest", "taskId", "leaseGeneration", "journalSequence", "resultDigest", "authorization", "acknowledgedAt"]
        or executor["statuses"] != ["reserved", "in-progress", "waiting", "committed"]
        or executor["entryFields"] != ["schemaVersion", "recordSequence", "invocationId", "invocationDigest", "effectFingerprint", "taskId", "leaseGeneration", "behaviorFingerprint", "approvalsFingerprint", "approvalsWithoutAuthorizationFingerprint", "approvalAuthorizationFingerprint", "backupAuthorizationFingerprint", "executorEpoch", "status", "updatedAt", "result", "terminalReceipt", "publicationAcknowledgement", "mac"]
        or executor["tombstoneFields"] != ["schemaVersion", "recordSequence", "invocationId", "taskId", "leaseGeneration", "requestedAt", "expiresAt", "mac"]
        or executor["maxEntries"] != 100_000 or executor["maxCancellationTombstones"] != 1_024
        or executor["maxBytes"] != MAX_JOURNAL_BYTES or executor["maxGeneration"] != MAX_GENERATION
        or gateway["schemaVersion"] != 1
        or gateway["path"] != DEFAULT_GATEWAY_JOURNAL
        or gateway["stateFields"] != ["schemaVersion", "entries"]
        or gateway["entryFields"] != [
            "schemaVersion", "key", "runtimeId", "sessionId", "taskId", "leaseId", "leaseGeneration",
            "invocationId", "invocationDigest", "state", "payload", "updatedAt", "expectedJournalSequence",
            "terminalJournalSequence", "terminalResult", "terminalReceipt",
        ]
        or gateway["states"] != ["awaiting-backup", "awaiting-executor", "dispatching"]
        or gateway["maxEntries"] != 128
        or gateway["maxBytes"] != 16 * 1024 * 1024
        or backup["version"] != 3
        or backup["path"] != DEFAULT_BACKUP_JOURNAL
        or backup["phases"] != ["prepared", "quiescing", "quiesced", "uploading", "archive-uploaded", "publishing-manifest", "uploaded", "restoring-services", "restart-complete"]
        or backup["modes"] != ["ordinary", "hibernate", "destroy", "replacement"]
        or backup["maxGeneration"] != MAX_GENERATION
        or service_state["units"] != ["minecraft-dns.service", "minecraft.service", "mc-agent-world-roots.service", "mc-agent-executor.socket", "mc-agent-executor.service", "mc-agent-gateway.service"]
        or service_state["enablementStates"] != ["enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "not-found"]
    ):
        fail("host-operation contract contents are invalid")
    return value


def read_key(path: Path) -> bytes:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size != 32 or metadata.st_mode & 0o077:
            fail("executor journal credential is not root-only")
        value = path.read_bytes()
    except OSError as error:
        raise HostOperationError("could not read executor journal credential") from error
    if len(value) != 32:
        fail("executor journal credential is not exactly 32 bytes")
    return value


def valid_mac(key: bytes, domain: str, value: dict[str, Any], prefix: str, version: int) -> bool:
    tag = value.get("mac")
    if not isinstance(tag, str) or not MAC.fullmatch(tag):
        return False
    try:
        actual = base64.urlsafe_b64decode(tag + "==")
    except (binascii.Error, ValueError):
        return False
    unsigned = {name: child for name, child in value.items() if name != "mac"}
    expected = hmac.new(key, f"{prefix}:{domain}:v{version}\n".encode("ascii") + canonical(unsigned), hashlib.sha256).digest()
    return hmac.compare_digest(expected, actual)


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not ISO_UTC.fullmatch(value):
        return False
    try:
        dt.datetime.strptime(value.rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f" if "." in value else "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return False
    return True


def validate_tool_result(value: Any, invocation_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {
        "schemaVersion", "invocationId", "status", "completedAt", "summary", "output", "evidence", "mutationCommit",
    } or not {"schemaVersion", "invocationId", "status", "completedAt", "summary", "output", "evidence"}.issubset(value):
        fail("executor journal result schema is invalid")
    if (
        value["schemaVersion"] != 1
        or value["invocationId"] != invocation_id
        or not ID.fullmatch(value["invocationId"])
        or value["status"] not in ("succeeded", "failed", "cancelled", "indeterminate")
        or not valid_timestamp(value["completedAt"])
        or not isinstance(value["summary"], str)
        or not isinstance(value["evidence"], list)
    ):
        fail("executor journal result is invalid")
    for evidence in value["evidence"]:
        evidence = exact(
            evidence,
            {"schemaVersion", "evidenceId", "kind", "uri", "description"},
            "executor journal result evidence",
        )
        if (
            evidence["schemaVersion"] != 1
            or not isinstance(evidence["evidenceId"], str)
            or not ID.fullmatch(evidence["evidenceId"])
            or evidence["kind"] not in ("file", "command-output", "console-output", "backup", "diff")
            or not isinstance(evidence["uri"], str)
            or not isinstance(evidence["description"], str)
        ):
            fail("executor journal result evidence is invalid")
    if "mutationCommit" in value:
        mutation_value = value["mutationCommit"]
        if not isinstance(mutation_value, dict) or set(mutation_value) - {"committed", "point"} or "committed" not in mutation_value:
            fail("executor journal mutation commit is invalid")
        mutation = mutation_value
        if not isinstance(mutation["committed"], bool):
            fail("executor journal mutation commit is invalid")
        if mutation["committed"]:
            if mutation.get("point") not in ("atomic-rename", "console-dispatch") or value["status"] == "indeterminate":
                fail("executor journal mutation commit is invalid")
        elif "point" in mutation or value["status"] == "succeeded":
            fail("executor journal mutation commit is invalid")
    return value


def is_waiting_result(value: dict[str, Any]) -> bool:
    output = value.get("output")
    return (
        value.get("status") == "failed"
        and isinstance(output, dict)
        and output.get("code") in (
            "approval-required", "backup-required", "invocation-authorization-required", "download-authorization-required",
        )
    )


def complete_terminal_receipt(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("source") == "executor-journal"
        and value.get("proofKind") in ("terminal", "clean-start-no-active")
        and isinstance(value.get("executorKeyId"), str)
        and isinstance(value.get("executorKeyEpoch"), int)
        and isinstance(value.get("signature"), str)
        and len(value["signature"]) == 86
        and isinstance(value.get("journalSequence"), int)
        and isinstance(value.get("resultDigest"), str)
    )


def unresolved_receipt_reference(value: Any, key_id: str, key_epoch: int) -> bool:
    """Return whether value can still require the retiring receipt signer."""
    if isinstance(value, list):
        return any(unresolved_receipt_reference(item, key_id, key_epoch) for item in value)
    if not isinstance(value, dict):
        return False
    # A complete terminal receipt is the durable boundary. Its old key ID is
    # intentionally not treated as a live private-key dependency.
    if complete_terminal_receipt(value) or complete_terminal_receipt(value.get("terminalReceipt")):
        return False
    if value.get("executorKeyId") == key_id and value.get("executorKeyEpoch") == key_epoch:
        return True
    if (
        value.get("status") == "committed"
        and ("result" in value or "terminalResult" in value)
        and "terminalReceipt" not in value
    ):
        return True
    if value.get("state") in ("awaiting-backup", "awaiting-executor", "dispatching") and "terminalReceipt" not in value:
        return True
    if (
        isinstance(value.get("backupId"), str)
        and isinstance(value.get("lifecycleLockId"), str)
        and "terminalReceipt" not in value
        and (value.get("status") == "succeeded" or "authorizationId" in value)
    ):
        return True
    if "publicationRevision" in value and "terminalReceipt" not in value:
        return True
    if "activeRuntimeInvocation" in value and "runtimeRecoveries" not in value:
        return True
    return any(
        unresolved_receipt_reference(child, key_id, key_epoch)
        for name, child in value.items()
        if name != "terminalReceipt"
    )


def print_receipt_reference_scan(
    entries: list[dict[str, Any]],
    gateway: list[dict[str, Any]] | None,
    key_id: str,
    key_epoch: int,
) -> None:
    references: list[dict[str, str]] = []
    for entry in entries:
        if unresolved_receipt_reference(entry, key_id, key_epoch):
            references.append({"source": "executor-journal", "invocationId": str(entry.get("invocationId", "unknown"))})
    for entry in gateway or []:
        if unresolved_receipt_reference(entry, key_id, key_epoch):
            references.append({"source": "gateway-handoff", "invocationId": str(entry.get("invocationId", "unknown"))})
    print(json.dumps({"references": references}, separators=(",", ":"), sort_keys=True))


def validate_gateway_journal(path: Path, contract: dict[str, Any]) -> list[dict[str, Any]]:
    gateway_contract = contract["gatewayReconciliationJournal"]
    state = exact(
        parse_json(regular_file(path, "gateway reconciliation journal", gateway_contract["maxBytes"]), "gateway reconciliation journal"),
        set(gateway_contract["stateFields"]),
        "gateway reconciliation journal",
    )
    if (
        state["schemaVersion"] != gateway_contract["schemaVersion"]
        or not isinstance(state["entries"], list)
        or len(state["entries"]) > gateway_contract["maxEntries"]
    ):
        fail("gateway reconciliation journal schema is invalid")
    entries: list[dict[str, Any]] = []
    keys: set[str] = set()
    for raw in state["entries"]:
        if (
            not isinstance(raw, dict)
            or set(raw) - set(gateway_contract["entryFields"])
            or not (
                set(gateway_contract["entryFields"])
                - {"expectedJournalSequence", "terminalJournalSequence", "terminalResult", "terminalReceipt"}
            ).issubset(raw)
        ):
            fail("gateway reconciliation entry has an invalid schema")
        entry = raw
        if (
            entry["schemaVersion"] != gateway_contract["schemaVersion"]
            or not isinstance(entry["key"], str) or not entry["key"] or entry["key"] in keys
            or any(not isinstance(entry[field], str) or not ID.fullmatch(entry[field]) for field in (
                "runtimeId", "sessionId", "taskId", "leaseId", "invocationId",
            ))
            or not isinstance(entry["leaseGeneration"], int) or isinstance(entry["leaseGeneration"], bool)
            or entry["leaseGeneration"] < 1
            or not isinstance(entry["invocationDigest"], str) or not DIGEST.fullmatch(entry["invocationDigest"])
            or entry["state"] not in gateway_contract["states"]
            or not isinstance(entry["payload"], dict)
            or not valid_timestamp(entry["updatedAt"])
            or (entry["state"] == "dispatching" and (
                not isinstance(entry.get("expectedJournalSequence"), int)
                or isinstance(entry["expectedJournalSequence"], bool)
                or entry["expectedJournalSequence"] < 0
            ))
            or (entry["state"] != "dispatching" and "expectedJournalSequence" in entry)
        ):
            fail("gateway reconciliation journal entry is invalid")
        invocation = entry["payload"].get("invocation")
        runtime_context = entry["payload"].get("runtimeContext")
        if (
            not isinstance(invocation, dict)
            or not isinstance(runtime_context, dict)
            or invocation.get("sessionId") != entry["sessionId"]
            or invocation.get("invocationId") != entry["invocationId"]
            or runtime_context.get("runtimeId") != entry["runtimeId"]
            or runtime_context.get("taskId") != entry["taskId"]
            or runtime_context.get("leaseId") != entry["leaseId"]
            or runtime_context.get("leaseGeneration") != entry["leaseGeneration"]
            or entry["key"] != f"{entry['runtimeId']}:{entry['taskId']}:{entry['leaseId']}:{entry['leaseGeneration']}:{entry['invocationId']}"
            or hashlib.sha256(canonical(invocation)).hexdigest() != entry["invocationDigest"]
        ):
            fail("gateway reconciliation journal binding is invalid")
        keys.add(entry["key"])
        entries.append(entry)
    return entries


def validate_executor_journal(path: Path, key_path: Path, contract_path: Path, gateway_path: Path,
                              handoff_state: str, checkpoint_sequence: int,
                              receipt_reference: tuple[str, int] | None = None) -> int:
    contract = load_contract(contract_path)
    executor_contract = contract["executorJournal"]
    if handoff_state not in ("auto", "never-used", "durable"):
        fail("executor handoff context is invalid")
    if not isinstance(checkpoint_sequence, int) or isinstance(checkpoint_sequence, bool) or checkpoint_sequence < 0:
        fail("executor journal checkpoint is invalid")
    key = read_key(key_path)
    gateway: list[dict[str, Any]] | None = None
    try:
        gateway = validate_gateway_journal(gateway_path, contract)
    except FileNotFoundError:
        if handoff_state == "durable" or checkpoint_sequence != 0:
            fail("gateway reconciliation journal is missing after a durable checkpoint")
    if handoff_state == "never-used" and (gateway or checkpoint_sequence != 0):
        fail("never-used executor handoff has durable dispatch context")
    dispatches = [entry["expectedJournalSequence"] for entry in (gateway or []) if entry["state"] == "dispatching"]
    if dispatches and checkpoint_sequence < max(dispatches):
        fail("executor journal checkpoint is behind the durable gateway dispatch")
    key_prefix = executor_contract["macPrefix"]
    if executor_contract["schemaVersion"] == 3:
        version = executor_contract["schemaVersion"]
        max_generation = executor_contract["maxGeneration"]
        try:
            manifest = exact(
                parse_json(regular_file(path, "executor journal manifest", 16 * 1024), "executor journal manifest"),
                set(executor_contract["manifestFields"]), "executor journal manifest",
            )
        except FileNotFoundError:
            sidecars = [
                Path(f"{path}{suffix}")
                for suffix in (
                    *executor_contract["checkpointSuffixes"],
                    *executor_contract["appendSuffixes"],
                    executor_contract["floorSuffix"],
                )
            ]
            if any(os.path.lexists(sidecar) for sidecar in sidecars):
                fail("executor journal sidecar exists without its authenticated manifest")
            if handoff_state == "never-used" or (handoff_state == "auto" and not gateway and checkpoint_sequence == 0):
                if receipt_reference:
                    print_receipt_reference_scan([], gateway, *receipt_reference)
                else:
                    print("idle\t0\tabsent-fresh")
                return 0
            if gateway is not None and not dispatches and checkpoint_sequence == 0:
                if receipt_reference:
                    print_receipt_reference_scan([], gateway, *receipt_reference)
                else:
                    print("idle\t0\tabsent-no-dispatch")
                return 0
            if receipt_reference:
                print_receipt_reference_scan([], gateway, *receipt_reference)
                return 0
            fail("executor journal is missing after a durable dispatch checkpoint")
        if (
            manifest["schemaVersion"] != version or manifest["format"] != executor_contract["format"]
            or not valid_mac(key, "manifest", manifest, key_prefix, version)
            or any(not isinstance(manifest[field], int) or isinstance(manifest[field], bool) or manifest[field] < 0
                   for field in ("generation", "checkpointGeneration", "appendGeneration", "generationFloor"))
            or manifest["generation"] < 1 or manifest["generation"] > max_generation
            or manifest["checkpointGeneration"] < 1 or manifest["checkpointGeneration"] > manifest["generation"]
            or manifest["appendGeneration"] != manifest["generation"]
            or manifest["generationFloor"] < 1 or manifest["generationFloor"] > manifest["generation"]
            or manifest["generationFloor"] != manifest["checkpointGeneration"]
            or manifest["checkpointSlot"] not in (0, 1) or manifest["appendSlot"] not in (0, 1)
        ):
            fail("executor journal manifest schema or authentication is invalid")
        floor_path = Path(f"{path}{executor_contract['floorSuffix']}")
        floor = exact(
            parse_json(regular_file(floor_path, "executor journal generation floor", 16 * 1024), "executor journal generation floor"),
            set(executor_contract["floorFields"]), "executor journal generation floor",
        )
        if (
            floor["schemaVersion"] != version or not isinstance(floor["generationFloor"], int)
            or isinstance(floor["generationFloor"], bool)
            or floor["generationFloor"] < 1
            or floor["generationFloor"] > max_generation
            or not valid_mac(key, "floor", floor, key_prefix, version)
        ):
            fail("executor journal generation floor authentication failed")
        entries: list[dict[str, Any]] = []
        tombstones: list[dict[str, Any]] = []
        evidence: list[dict[str, Any]] = []
        checkpoints: list[tuple[int, dict[str, Any]]] = []
        for slot in (0, 1):
            checkpoint_path = Path(f"{path}{executor_contract['checkpointSuffixes'][slot]}")
            try:
                checkpoint_raw = parse_json(regular_file(checkpoint_path, "executor journal checkpoint", executor_contract["maxBytes"]), "executor journal checkpoint")
            except FileNotFoundError:
                continue
            checkpoint = exact(
                checkpoint_raw,
                set(executor_contract["checkpointFields"]), "executor journal checkpoint",
            )
            if (
                checkpoint["schemaVersion"] != version or checkpoint["format"] != executor_contract["format"]
                or checkpoint["generation"] < 1 or checkpoint["generation"] > max_generation
                or not isinstance(checkpoint["entries"], list) or len(checkpoint["entries"]) > executor_contract["maxEntries"]
                or not isinstance(checkpoint["cancellationTombstones"], list)
                or len(checkpoint["cancellationTombstones"]) > executor_contract["maxCancellationTombstones"]
                or not isinstance(checkpoint["evidence"], list) or len(checkpoint["evidence"]) > 1
                or not valid_mac(key, "checkpoint", checkpoint, key_prefix, version)
            ):
                fail("executor journal checkpoint authentication failed")
            checkpoints.append((slot, checkpoint))
        if not checkpoints:
            fail("executor journal has no authenticated checkpoint")
        active_checkpoint = next((item for slot, item in checkpoints if slot == manifest["checkpointSlot"]), None)
        if active_checkpoint is None or active_checkpoint["generation"] != manifest["checkpointGeneration"]:
            fail("executor journal manifest checkpoint is missing, stale, or below its generation floor")
        append_logs: list[list[dict[str, Any]] | None] = []
        append_boundaries: list[int | None] = []
        append_sizes: list[int | None] = []
        for slot in (0, 1):
            append_path = Path(f"{path}{executor_contract['appendSuffixes'][slot]}")
            try:
                raw_append = bounded_file(append_path, "executor journal append log", executor_contract["maxBytes"], allow_empty=True)
            except FileNotFoundError:
                append_logs.append(None)
                append_boundaries.append(None)
                append_sizes.append(None)
                continue
            records: list[dict[str, Any]] = []
            complete_bytes = 0
            for framed in raw_append.splitlines(keepends=True):
                if not framed.endswith(b"\n"):
                    break
                raw = framed[:-1]
                append = exact(parse_json(raw, "executor journal transaction frame"), set(executor_contract["appendFields"]), "executor journal transaction frame")
                if (
                    append["schemaVersion"] != version or not isinstance(append["generation"], int)
                    or isinstance(append["generation"], bool) or append["generation"] < 1
                    or append["generation"] > max_generation
                    or not isinstance(append["mutations"], list) or not append["mutations"]
                    or not valid_mac(key, "transaction", append, key_prefix, version)
                ):
                    fail("executor journal transaction frame schema or authentication is invalid")
                for mutation in append["mutations"]:
                    mutation = exact(
                        mutation,
                        set(executor_contract["mutationFields"]),
                        "executor journal transaction mutation",
                    )
                    if (
                        mutation["operation"] not in executor_contract["mutationOperations"]
                        or not isinstance(mutation["key"], str) or not mutation["key"]
                        or (mutation["operation"].startswith("delete-") and mutation["value"] is not None)
                        or (mutation["operation"].startswith("upsert-") and not isinstance(mutation["value"], dict))
                    ):
                        fail("executor journal transaction mutation is invalid")
                records.append(append)
                complete_bytes += len(framed)
            append_logs.append(records)
            append_boundaries.append(complete_bytes)
            append_sizes.append(len(raw_append))
        if append_logs[manifest["appendSlot"]] is None:
            fail("executor journal manifest append log is missing")
        selected: dict[str, Any] | None = None
        selected_generation = 0
        selected_preference = -1
        selected_checkpoint_generation = 0
        selected_append_slot = manifest["appendSlot"]
        required_generation = max(floor["generationFloor"], manifest["generationFloor"])
        for checkpoint_slot, checkpoint in checkpoints:
            if checkpoint["generation"] < floor["generationFloor"]:
                continue
            candidate = {
                "entries": list(checkpoint["entries"]),
                "tombstones": list(checkpoint["cancellationTombstones"]),
                "evidence": list(checkpoint["evidence"]),
                "generation": checkpoint["generation"],
            }
            for append_slot, records in enumerate(append_logs):
                if records is None:
                    continue
                current_generation = candidate["generation"]
                trial = copy.deepcopy(candidate)
                valid = True
                for transaction in records:
                    if transaction["generation"] <= checkpoint["generation"]:
                        continue
                    if transaction["generation"] != current_generation + 1:
                        valid = False
                        break
                    next_trial = copy.deepcopy(trial)
                    for mutation in transaction["mutations"]:
                        operation = mutation["operation"]
                        collection = "entries" if operation.endswith("entry") else "tombstones" if operation.endswith("tombstone") else "evidence"
                        values = next_trial[collection]
                        if collection == "evidence" and mutation["key"] != "acknowledged-terminal-aggregate":
                            valid = False
                            break
                        if not operation.startswith("delete-") and collection != "evidence":
                            item = mutation["value"]
                            item_key = f"{item.get('taskId', 'legacy')}:{item.get('leaseGeneration', 0)}:{item.get('invocationId')}"
                            if item_key != mutation["key"]:
                                valid = False
                                break
                        if collection == "evidence":
                            index = 0 if values else -1
                        else:
                            index = next((
                                i for i, item in enumerate(values)
                                if f"{item.get('taskId', 'legacy')}:{item.get('leaseGeneration', 0)}:{item.get('invocationId')}" == mutation["key"]
                            ), -1)
                        if operation.startswith("delete-"):
                            if index < 0:
                                valid = False
                                break
                            values.pop(index)
                        elif index < 0:
                            values.append(mutation["value"])
                        else:
                            values[index] = mutation["value"]
                    if not valid:
                        break
                    next_trial["generation"] = transaction["generation"]
                    trial = next_trial
                    current_generation = transaction["generation"]
                preference = int(checkpoint_slot == manifest["checkpointSlot"]) * 2 + int(
                    append_slot == manifest["appendSlot"]
                )
                if valid and trial["generation"] >= required_generation and (
                    selected is None
                    or trial["generation"] > selected_generation
                    or (trial["generation"] == selected_generation and preference > selected_preference)
                ):
                    selected, selected_generation, selected_preference = trial, trial["generation"], preference
                    selected_checkpoint_generation = checkpoint["generation"]
                    selected_append_slot = append_slot
        if selected is None or selected_generation < required_generation:
            fail("executor journal recovery found no generation at or above its authenticated floor")
        entries, tombstones, evidence = selected["entries"], selected["tombstones"], selected["evidence"]
        scopes: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) - set(executor_contract["entryFields"]):
                fail("executor journal entry schema is invalid")
            if (
                not {"schemaVersion", "recordSequence", "invocationId", "invocationDigest", "effectFingerprint", "status", "updatedAt", "mac"}.issubset(entry)
                or entry["schemaVersion"] != version or not isinstance(entry["recordSequence"], int)
                or isinstance(entry["recordSequence"], bool) or not 1 <= entry["recordSequence"] <= selected_generation
                or not isinstance(entry["invocationId"], str) or not ID.fullmatch(entry["invocationId"])
                or not isinstance(entry["invocationDigest"], str) or not DIGEST.fullmatch(entry["invocationDigest"])
                or not isinstance(entry["effectFingerprint"], str) or not DIGEST.fullmatch(entry["effectFingerprint"])
                or entry["status"] not in executor_contract["statuses"] or not valid_timestamp(entry["updatedAt"])
                or not valid_mac(key, "entry", entry, key_prefix, version)
            ):
                fail("executor journal entry schema or authentication is invalid")
            if entry["status"] in ("reserved", "in-progress") and "result" in entry:
                fail("executor journal reserved or in-progress entry contains a result")
            if entry["status"] not in ("reserved", "in-progress") and "result" not in entry:
                fail("executor journal terminal entry is missing a result")
            scoped = "taskId" in entry or "leaseGeneration" in entry
            if scoped and (
                not isinstance(entry.get("taskId"), str)
                or not ID.fullmatch(entry["taskId"])
                or not isinstance(entry.get("leaseGeneration"), int)
                or isinstance(entry["leaseGeneration"], bool)
                or entry["leaseGeneration"] < 1
                or not isinstance(entry.get("behaviorFingerprint"), str)
                or not DIGEST.fullmatch(entry["behaviorFingerprint"])
                or not isinstance(entry.get("approvalsFingerprint"), str)
                or not DIGEST.fullmatch(entry["approvalsFingerprint"])
                or not isinstance(entry.get("approvalsWithoutAuthorizationFingerprint"), str)
                or not DIGEST.fullmatch(entry["approvalsWithoutAuthorizationFingerprint"])
            ):
                fail("executor journal entry scope is invalid")
            for fingerprint in ("behaviorFingerprint", "approvalsFingerprint", "approvalsWithoutAuthorizationFingerprint", "approvalAuthorizationFingerprint", "backupAuthorizationFingerprint"):
                if fingerprint in entry and (
                    not isinstance(entry[fingerprint], str) or not DIGEST.fullmatch(entry[fingerprint])
                ):
                    fail("executor journal entry fingerprint is invalid")
            result = validate_tool_result(entry["result"], entry["invocationId"]) if "result" in entry else None
            if result is not None and (
                (entry["status"] == "waiting" and not is_waiting_result(result))
                or (entry["status"] == "committed" and is_waiting_result(result))
            ):
                fail("executor journal result status is inconsistent")
            if "publicationAcknowledgement" in entry:
                acknowledgement = entry["publicationAcknowledgement"]
                if not isinstance(acknowledgement, dict) or set(acknowledgement) != set(executor_contract["acknowledgementFields"]):
                    fail("executor journal acknowledgement schema is invalid")
                if (
                    acknowledgement["invocationId"] != entry["invocationId"]
                    or acknowledgement["invocationDigest"] != entry["invocationDigest"]
                    or acknowledgement["taskId"] != entry.get("taskId")
                    or acknowledgement["leaseGeneration"] != entry.get("leaseGeneration")
                    or acknowledgement["journalSequence"] != entry["recordSequence"]
                    or not isinstance(acknowledgement["resultDigest"], str)
                    or not DIGEST.fullmatch(acknowledgement["resultDigest"])
                    or result is None
                    or acknowledgement["resultDigest"] != hashlib.sha256(canonical(result)).hexdigest()
                    or not valid_timestamp(acknowledgement["acknowledgedAt"])
                    or result["status"] == "indeterminate"
                    or is_waiting_result(result)
                ):
                    fail("executor journal acknowledgement binding is invalid")
            if "executorEpoch" in entry and (not isinstance(entry["executorEpoch"], str) or not ID.fullmatch(entry["executorEpoch"])):
                fail("executor journal entry epoch is invalid")
            scope = f"{entry.get('taskId', 'legacy')}:{entry.get('leaseGeneration', 0)}:{entry['invocationId']}"
            if scope in scopes:
                fail("executor journal contains a replayed entry")
            scopes.add(scope)
        tombstone_scopes: set[str] = set()
        for tombstone in tombstones:
            if not isinstance(tombstone, dict) or set(tombstone) - set(executor_contract["tombstoneFields"]):
                fail("executor journal cancellation tombstone schema is invalid")
            if (
                not {"schemaVersion", "recordSequence", "invocationId", "requestedAt", "expiresAt", "mac"}.issubset(tombstone)
                or tombstone["schemaVersion"] != version
                or not isinstance(tombstone["recordSequence"], int)
                or isinstance(tombstone["recordSequence"], bool)
                or not 1 <= tombstone["recordSequence"] <= selected_generation
                or not isinstance(tombstone["invocationId"], str)
                or not ID.fullmatch(tombstone["invocationId"])
                or not valid_timestamp(tombstone["requestedAt"])
                or not valid_timestamp(tombstone["expiresAt"])
                or not valid_mac(key, "tombstone", tombstone, key_prefix, version)
            ):
                fail("executor journal cancellation tombstone schema or authentication is invalid")
            scoped = "taskId" in tombstone or "leaseGeneration" in tombstone
            if scoped and (
                not isinstance(tombstone.get("taskId"), str)
                or not ID.fullmatch(tombstone["taskId"])
                or not isinstance(tombstone.get("leaseGeneration"), int)
                or isinstance(tombstone["leaseGeneration"], bool)
                or tombstone["leaseGeneration"] < 1
            ):
                fail("executor journal cancellation tombstone scope is invalid")
            scope = f"{tombstone.get('taskId', 'legacy')}:{tombstone.get('leaseGeneration', 0)}:{tombstone['invocationId']}"
            if scope in tombstone_scopes:
                fail("executor journal contains a replayed cancellation tombstone")
            tombstone_scopes.add(scope)
        for item in evidence:
            if not isinstance(item, dict) or set(item) != set(executor_contract["evidenceFields"]):
                fail("executor journal evidence schema is invalid")
            if item["schemaVersion"] != version or not isinstance(item["recordSequence"], int) or isinstance(item["recordSequence"], bool) or not 1 <= item["recordSequence"] <= selected_generation or not isinstance(item["acknowledgedCount"], int) or isinstance(item["acknowledgedCount"], bool) or not 1 <= item["acknowledgedCount"] <= MAX_GENERATION or not isinstance(item["latestTerminalSequence"], int) or isinstance(item["latestTerminalSequence"], bool) or not 1 <= item["latestTerminalSequence"] <= selected_generation or not isinstance(item["aggregateDigest"], str) or not DIGEST.fullmatch(item["aggregateDigest"]) or not isinstance(item["replayFilter"], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", item["replayFilter"]) or len(base64.urlsafe_b64decode(item["replayFilter"] + "==")) != executor_contract["replayFilterBytes"] or not valid_mac(key, "evidence", item, key_prefix, version):
                fail("executor journal evidence schema or authentication is invalid")
        selected_boundary = append_boundaries[selected_append_slot]
        selected_size = append_sizes[selected_append_slot]
        if selected_boundary is None or selected_size is None:
            fail("executor journal recovered append log is missing")
        if selected_checkpoint_generation == selected_generation:
            selected_boundary = 0
        sync_append_boundary(
            Path(f"{path}{executor_contract['appendSuffixes'][selected_append_slot]}"),
            selected_boundary,
            executor_contract["maxBytes"],
        )
        if selected_generation < checkpoint_sequence:
            fail("executor journal generation is behind the durable checkpoint")
        if receipt_reference:
            print_receipt_reference_scan(entries, gateway, *receipt_reference)
            return 0
        if gateway:
            fail("gateway reconciliation journal still owns an unpublished handoff")
        if any(
            entry["status"] in ("reserved", "in-progress")
            or (
                entry["status"] == "committed"
                and (
                    not isinstance(entry.get("result"), dict)
                    or entry["result"].get("status") == "indeterminate"
                    or (
                        entry["result"].get("mutationCommit") != {"committed": False}
                        and "publicationAcknowledgement" not in entry
                    )
                )
            )
            for entry in entries
        ):
            fail("executor journal is not authoritatively idle")
        print(f"idle\t{selected_generation}")
        return 0


def validate_service_state(value: Any, contract: dict[str, Any]) -> list[dict[str, Any]]:
    service_contract = contract["serviceState"]
    if not isinstance(value, list) or len(value) != len(service_contract["units"]):
        fail("service-state inventory is incomplete")
    for index, raw in enumerate(value):
        item = exact(raw, {"unit", "active", "enablement"}, "service state")
        if (
            item["unit"] != service_contract["units"][index]
            or not isinstance(item["active"], bool)
            or item["enablement"] not in service_contract["enablementStates"]
        ):
            fail("service state is invalid")
    return value


def systemctl_state(command: list[str]) -> tuple[int, str]:
    try:
        result = subprocess.run(["systemctl", *command], check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, encoding="utf-8", timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise HostOperationError("could not inspect service state") from error
    return result.returncode, result.stdout.strip()


def capture_service_state(contract: dict[str, Any]) -> list[dict[str, Any]]:
    states = []
    for unit in contract["serviceState"]["units"]:
        active_status, _ = systemctl_state(["is-active", "--quiet", unit])
        enabled_status, enablement = systemctl_state(["is-enabled", unit])
        if not enablement:
            enablement = "disabled" if enabled_status != 0 else "enabled"
        states.append({"unit": unit, "active": active_status == 0, "enablement": enablement})
    return validate_service_state(states, contract)


def run_systemctl(arguments: list[str]) -> None:
    try:
        subprocess.run(["systemctl", *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        raise HostOperationError(f"service-state restoration failed for {arguments[-1]}") from error


def restore_service_state(states: list[dict[str, Any]], contract: dict[str, Any]) -> None:
    states = validate_service_state(states, contract)
    for item in states:
        if item["enablement"] not in ("masked", "masked-runtime") or item["active"]:
            run_systemctl(["unmask", "--runtime", item["unit"]])
        if item["active"] and item["enablement"] == "masked":
            run_systemctl(["unmask", item["unit"]])
        if item["enablement"] == "enabled":
            run_systemctl(["enable", item["unit"]])
        elif item["enablement"] == "enabled-runtime":
            run_systemctl(["enable", "--runtime", item["unit"]])
        elif item["enablement"] == "disabled":
            run_systemctl(["disable", item["unit"]])
    run_systemctl(["daemon-reload"])
    for item in states:
        run_systemctl(["start" if item["active"] else "stop", item["unit"]])
    for item in states:
        if item["enablement"] == "masked":
            run_systemctl(["mask", item["unit"]])
        elif item["enablement"] == "masked-runtime":
            run_systemctl(["mask", "--runtime", item["unit"]])
    verify_service_state(states, contract)


def verify_service_state(states: list[dict[str, Any]], contract: dict[str, Any]) -> None:
    states = validate_service_state(states, contract)
    observed = capture_service_state(contract)
    if observed != states:
        fail("service state was not restored exactly")


def validate_backup(value: Any, contract: dict[str, Any]) -> dict[str, Any]:
    item = exact(value, {"version", "phase", "backupName", "mode", "operationKey", "backupId", "createdAt", "generation", "maintenanceOwner", "bootId", "volumeId", "volumeDevice", "quiescenceEpoch", "serviceStates"}, "backup journal")
    if (
        item["version"] != contract["backupJournal"]["version"] or item["phase"] not in contract["backupJournal"]["phases"]
        or item["mode"] not in contract["backupJournal"]["modes"] or not isinstance(item["backupName"], str)
        or not BACKUP_NAME.fullmatch(item["backupName"])
        or (item["operationKey"] is not None and (not isinstance(item["operationKey"], str) or not OPERATION_KEY.fullmatch(item["operationKey"])))
        or not isinstance(item["backupId"], str) or not BACKUP_ID.fullmatch(item["backupId"])
        or not isinstance(item["generation"], int) or isinstance(item["generation"], bool)
        or not 0 <= item["generation"] <= contract["backupJournal"]["maxGeneration"]
        or not valid_timestamp(item["createdAt"])
        or not isinstance(item["maintenanceOwner"], str) or not ID.fullmatch(item["maintenanceOwner"])
        or not isinstance(item["bootId"], str) or not 1 <= len(item["bootId"]) <= 128 or any(character in item["bootId"] for character in "\t\r\n")
        or (item["volumeId"] is not None and (not isinstance(item["volumeId"], str) or re.fullmatch(r"vol-[a-f0-9]{8,17}", item["volumeId"]) is None))
        or (item["volumeDevice"] is not None and (not isinstance(item["volumeDevice"], str) or re.fullmatch(r"/dev/[A-Za-z0-9._/-]{1,127}", item["volumeDevice"]) is None))
        or not isinstance(item["quiescenceEpoch"], str) or not BACKUP_ID.fullmatch(item["quiescenceEpoch"])
    ):
        fail("backup journal schema is invalid")
    validate_service_state(item["serviceStates"], contract)
    if item["phase"] not in ("prepared", "quiescing", "quiesced") and item["generation"] < 1:
        fail("backup journal generation is unavailable after quiescence")
    if item["mode"] in ("hibernate", "destroy") and (item["volumeId"] is None or item["volumeDevice"] is None):
        fail("terminal backup journal has no root-volume identity")
    return item


def backup_path(raw: str | None, contract: dict[str, Any]) -> Path:
    return Path(raw or contract["backupJournal"]["path"])


def read_backup(path: Path, contract: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return validate_backup(parse_json(regular_file(path, "backup journal", 16 * 1024), "backup journal"), contract)
    except FileNotFoundError:
        return None


def fsync_parent(path: Path) -> None:
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_backup(arguments: argparse.Namespace, contract: dict[str, Any]) -> None:
    path = backup_path(arguments.journal, contract)
    value = validate_backup({
        "version": contract["backupJournal"]["version"], "phase": arguments.phase,
        "backupName": arguments.backup_name, "mode": arguments.mode,
        "operationKey": arguments.operation_key or None, "backupId": arguments.backup_id,
        "createdAt": arguments.created_at, "generation": arguments.generation,
        "maintenanceOwner": arguments.maintenance_owner, "bootId": arguments.boot_id,
        "volumeId": arguments.volume_id or None, "volumeDevice": arguments.volume_device or None,
        "quiescenceEpoch": arguments.quiescence_epoch,
        "serviceStates": parse_json(arguments.service_states_json.encode("utf-8"), "service-state argument"),
    }, contract)
    temporary = path.with_name(f"{path.name}.new.{os.getpid()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            output.write(canonical(value) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_parent(path)
    finally:
        if descriptor != -1:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def clear_backup(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    fsync_parent(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--contract", default=os.environ.get("MC_HOST_OPERATION_CONTRACT", DEFAULT_CONTRACT))
    subparsers = result.add_subparsers(dest="command", required=True)
    executor = subparsers.add_parser("executor-idle")
    executor.add_argument("--journal", default=DEFAULT_EXECUTOR_JOURNAL)
    executor.add_argument("--credential", default=DEFAULT_EXECUTOR_KEY)
    executor.add_argument("--gateway-journal", default=DEFAULT_GATEWAY_JOURNAL)
    executor.add_argument("--handoff-state", choices=("auto", "never-used", "durable"), required=True)
    executor.add_argument("--checkpoint-sequence", required=True, type=int)
    references = subparsers.add_parser("executor-receipt-references")
    references.add_argument("--journal", default=DEFAULT_EXECUTOR_JOURNAL)
    references.add_argument("--credential", default=DEFAULT_EXECUTOR_KEY)
    references.add_argument("--gateway-journal", default=DEFAULT_GATEWAY_JOURNAL)
    references.add_argument("--key-id", required=True)
    references.add_argument("--key-epoch", required=True, type=int)
    service = subparsers.add_parser("service-state")
    service_children = service.add_subparsers(dest="service_command", required=True)
    service_children.add_parser("capture")
    for name in ("restore", "verify"):
        child = service_children.add_parser(name)
        child.add_argument("--state-json", required=True)
    backup = subparsers.add_parser("backup-journal")
    children = backup.add_subparsers(dest="backup_command", required=True)
    for name in ("inspect", "clear"):
        child = children.add_parser(name)
        child.add_argument("--journal", default=None)
        if name == "inspect":
            child.add_argument("--output", choices=("tsv", "json"), default="tsv")
    write = children.add_parser("write")
    write.add_argument("--journal", default=None)
    write.add_argument("--phase", required=True)
    write.add_argument("--backup-name", required=True)
    write.add_argument("--mode", required=True)
    write.add_argument("--operation-key", default="")
    write.add_argument("--backup-id", required=True)
    write.add_argument("--created-at", required=True)
    write.add_argument("--generation", required=True, type=int)
    write.add_argument("--maintenance-owner", required=True)
    write.add_argument("--boot-id", required=True)
    write.add_argument("--volume-id", default="")
    write.add_argument("--volume-device", default="")
    write.add_argument("--quiescence-epoch", required=True)
    write.add_argument("--service-states-json", required=True)
    acknowledge = children.add_parser("ack")
    acknowledge.add_argument("--journal", default=None)
    acknowledge.add_argument("--operation-key", required=True)
    return result


def main() -> int:
    try:
        arguments = parser().parse_args()
        contract = load_contract(Path(arguments.contract))
        if arguments.command == "executor-idle":
            return validate_executor_journal(
                Path(arguments.journal),
                Path(arguments.credential),
                Path(arguments.contract),
                Path(arguments.gateway_journal),
                arguments.handoff_state,
                arguments.checkpoint_sequence,
            )
        if arguments.command == "executor-receipt-references":
            if not ID.fullmatch(arguments.key_id) or arguments.key_epoch < 1:
                fail("receipt verifier identity is invalid")
            return validate_executor_journal(
                Path(arguments.journal),
                Path(arguments.credential),
                Path(arguments.contract),
                Path(arguments.gateway_journal),
                "auto",
                0,
                (arguments.key_id, arguments.key_epoch),
            )
        if arguments.command == "service-state":
            if arguments.service_command == "capture":
                print(canonical_text(capture_service_state(contract)))
            else:
                states = parse_json(arguments.state_json.encode("utf-8"), "service-state argument")
                if arguments.service_command == "restore":
                    restore_service_state(states, contract)
                else:
                    verify_service_state(states, contract)
            return 0
        path = backup_path(arguments.journal, contract)
        if arguments.backup_command == "inspect":
            value = read_backup(path, contract)
            if value is None:
                print("ABSENT")
            elif arguments.output == "json":
                print(canonical_text(value))
            else:
                print("\t".join((value["phase"], value["backupName"], value["mode"], value["operationKey"] or "", value["backupId"], value["createdAt"], str(value["generation"]), value["maintenanceOwner"], value["bootId"], value["volumeId"] or "", value["volumeDevice"] or "", value["quiescenceEpoch"], canonical_text(value["serviceStates"]))))
            return 0
        if arguments.backup_command == "clear":
            clear_backup(path)
            return 0
        if arguments.backup_command == "write":
            write_backup(arguments, contract)
            return 0
        value = read_backup(path, contract)
        if value is None:
            print("ABSENT")
        elif value["phase"] != "restart-complete" or value["operationKey"] != arguments.operation_key:
            print("SKIPPED")
        else:
            clear_backup(path)
            print("ACKED")
        return 0
    except HostOperationError as error:
        print(f"Host operation contract failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"Host operation contract failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
