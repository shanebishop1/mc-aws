#!/usr/bin/env python3
"""Create and verify canonical authenticated Minecraft Drive backup manifests.

The HMAC keyring is fetched into this root process from SSM and is never written
to disk, passed in argv/environment, or included in output.  The detached
manifest is public metadata and is the commit marker for a completed upload.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import secrets
from contextlib import contextmanager
from pathlib import Path
from typing import Any


KEYRING_PARAMETER = "/minecraft/backup-auth-keyring"
SERVER_ID_PARAMETER = "/minecraft/backup-server-identity"
DEFAULT_INSTANCE_ID_FILE = "/var/lib/cloud/data/instance-id"
FORMAT = "mc-aws-drive-backup"
SCHEMA_VERSION = 3
CAPSULE_FORMAT = "mc-aws-recovery-capsule"
CAPSULE_SCHEMA_VERSION = 3
TRANSFER_OFFER_FORMAT = "mc-aws-backup-transfer-offer"
TRANSFER_FORMAT = "mc-aws-backup-transfer"
TRANSFER_SCHEMA_VERSION = 1
TRANSFER_PARAMETER = "/minecraft/backup-transfer-authorization"
REPLACEMENT_OPERATION_ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
STATE_FORMAT = "mc-aws-backup-state"
STATE_SCHEMA_VERSION = 3
GENERATION_PARAMETER = "/minecraft/backup-generation-checkpoint"
RESTORE_FLOOR_PARAMETER = "/minecraft/restore-generation-floor"
RESTORE_FLOOR_OPERATION_ID = "mc-aws-restore-generation-floor"
UNINITIALIZED_STATE = "UNINITIALIZED"
MAX_MANIFEST_BYTES = 16 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024 * 1024
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
BACKUP_ID = re.compile(r"[a-f0-9]{32}")
KEY_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
INSTANCE_ID = re.compile(r"i-[a-f0-9]{8,17}")
SERVER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}")
SHA256 = re.compile(r"[a-f0-9]{64}")
ISO_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
MAX_GENERATION = 9_007_199_254_740_991


class BackupAuthenticationError(ValueError):
    """A deliberately non-secret authentication or schema failure."""


def fail(message: str) -> None:
    raise BackupAuthenticationError(message)


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate JSON field")
        result[key] = value
    return result


def parse_json(raw: str, label: str) -> Any:
    try:
        return json.loads(raw, object_pairs_hook=strict_object)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise BackupAuthenticationError(f"{label} is not strict JSON") from error


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} has an invalid schema")
    return value


def fetch_parameter(name: str, decrypt: bool) -> str:
    command = [os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "ssm", "get-parameter", "--name", name]
    if decrypt:
        command.append("--with-decryption")
    command.extend(["--query", "Parameter.Value", "--output", "text"])
    try:
        result = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError(f"could not retrieve required parameter {name}") from error
    value = result.stdout.rstrip("\r\n")
    if not value:
        fail(f"required parameter {name} is empty")
    return value


def remove_local_file(test_file_environment: str, missing_message: str) -> None:
    test_file = os.environ.get(test_file_environment)
    if test_file:
        try:
            os.unlink(test_file)
            directory = os.open(str(Path(test_file).parent), os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except FileNotFoundError:
            fail(missing_message)
        except OSError as error:
            raise BackupAuthenticationError("could not consume one-time transfer authorization") from error
        return
    fail("one-time authorization consumption requires the authoritative DynamoDB nonce store")


def consume_authorization_nonce(transfer_id: str, test_file_environment: str) -> None:
    """Consume a transfer exactly once without deleting its SSM evidence."""
    table = os.environ.get("MC_OPERATION_STATE_TABLE_NAME", "").strip()
    if not table and os.environ.get(test_file_environment):
        remove_local_file(test_file_environment, "one-time transfer authorization is missing or already consumed")
        return
    if not table or not re.fullmatch(r"[A-Za-z0-9_.:-]{3,255}", table):
        fail("one-time authorization nonce store is unavailable")
    if not re.fullmatch(r"[a-f0-9]{32}", transfer_id):
        fail("one-time authorization identity is invalid")
    item = json.dumps(
        {
            "operationId": {"S": f"backup-transfer-consumed-{transfer_id}"},
            "payload": {"S": json.dumps({"transferId": transfer_id, "consumedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")}, separators=(",", ":"), sort_keys=True)},
            "version": {"N": "1"},
        },
        separators=(",", ":"),
    )
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
        "dynamodb",
        "put-item",
        "--table-name",
        table,
        "--item",
        item,
        "--condition-expression",
        "attribute_not_exists(operationId)",
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.CalledProcessError as error:
        if "ConditionalCheckFailedException" in (error.stderr or ""):
            fail("one-time transfer authorization is missing or already consumed")
        raise BackupAuthenticationError("could not consume one-time transfer authorization") from error


def read_transfer_renewal(transfer_id: str) -> tuple[str, str] | None:
    table = operation_table_name()
    if not table:
        return None
    if not BACKUP_ID.fullmatch(transfer_id):
        fail("transfer renewal identity is invalid")
    key = {"operationId": {"S": f"backup-transfer-renewal-{transfer_id}"}}
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
        "dynamodb",
        "get-item",
        "--table-name",
        table,
        "--consistent-read",
        "--key",
        json.dumps(key, separators=(",", ":")),
        "--output",
        "json",
    ]
    try:
        result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        item = json.loads(result.stdout).get("Item") or {}
        owner = item.get("authorizationOwner", {}).get("S")
        payload = item.get("payload", {}).get("S")
        if not owner and not payload:
            return None
        if not isinstance(owner, str) or not isinstance(payload, str) or payload != canonical(parse_json(payload, "stored transfer renewal")).decode("ascii"):
            fail("stored transfer renewal is malformed")
        return owner, payload
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise BackupAuthenticationError("could not retrieve stored transfer renewal") from error


def persist_transfer_renewal(transfer_id: str, operation_id: str, offer: dict[str, Any]) -> str:
    table = operation_table_name()
    if not table:
        fail("transfer renewal requires the authoritative DynamoDB store")
    if not BACKUP_ID.fullmatch(transfer_id):
        fail("transfer renewal identity is invalid")
    payload = canonical(offer).decode("ascii")
    item = {
        "operationId": {"S": f"backup-transfer-renewal-{transfer_id}"},
        "kind": {"S": "backup-transfer-renewal"},
        "authorizationOwner": {"S": operation_id},
        "priorTransferId": {"S": transfer_id},
        "payload": {"S": payload},
    }
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
        "dynamodb",
        "put-item",
        "--table-name",
        table,
        "--item",
        json.dumps(item, separators=(",", ":")),
        "--condition-expression",
        "attribute_not_exists(operationId)",
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
        return payload
    except subprocess.CalledProcessError as error:
        if "ConditionalCheckFailedException" not in (error.stderr or ""):
            raise BackupAuthenticationError("could not persist transfer renewal") from error
        existing = read_transfer_renewal(transfer_id)
        if existing is None:
            fail("transfer renewal result was lost during a concurrent create")
        if existing[0] != operation_id:
            fail("transfer renewal is already owned by another operation")
        return existing[1]
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not persist transfer renewal") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not consume one-time transfer authorization") from error


def fetch_optional_parameter(name: str, test_file_environment: str) -> str | None:
    test_file = os.environ.get(test_file_environment)
    if test_file:
        try:
            return Path(test_file).read_text(encoding="ascii").strip()
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError) as error:
            raise BackupAuthenticationError("could not read durable backup state replica") from error
    command = [os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "ssm", "get-parameter", "--name", name, "--query", "Parameter.Value", "--output", "text"]
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not retrieve durable backup state") from error
    if result.returncode != 0:
        if "ParameterNotFound" in result.stderr:
            return None
        fail("could not retrieve durable backup state")
    value = result.stdout.rstrip("\r\n")
    if not value:
        fail("durable backup state is empty")
    return value


def write_parameter(name: str, value: str, test_file_environment: str) -> None:
    test_file = os.environ.get(test_file_environment)
    if test_file:
        write_atomic(Path(test_file), value.encode("ascii") + b"\n")
        return
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "ssm", "put-parameter", "--name", name, "--type", "String", "--overwrite", "--value", value,
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not persist durable backup state") from error


def operation_table_name() -> str | None:
    table = os.environ.get("MC_OPERATION_STATE_TABLE_NAME", "").strip()
    if table and re.fullmatch(r"[A-Za-z0-9_.:-]{3,255}", table):
        return table
    return None


def dynamo_floor_record(arguments: argparse.Namespace) -> tuple[str, int] | None:
    table = operation_table_name()
    if not table:
        return None
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "dynamodb", "get-item", "--table-name", table,
        "--consistent-read", "--key", json.dumps({"operationId": {"S": RESTORE_FLOOR_OPERATION_ID}}, separators=(",", ":")),
        "--output", "json",
    ]
    try:
        result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", timeout=30)
        item = json.loads(result.stdout).get("Item") or {}
        raw = item.get("payload", {}).get("S")
        version = int(item.get("version", {}).get("N", "0"))
        if not raw:
            return None
        if version < 1:
            fail("authoritative restore floor version is invalid")
        return raw, version
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise BackupAuthenticationError("could not retrieve authoritative restore floor") from error


def seed_dynamo_floor(arguments: argparse.Namespace, encoded: str, provenance: dict[str, Any]) -> tuple[str, int]:
    table = operation_table_name()
    if not table:
        fail("authoritative restore floor table is unavailable")
    item = {
        "operationId": {"S": RESTORE_FLOOR_OPERATION_ID},
        "kind": {"S": "restore-floor"},
        "payload": {"S": encoded},
        "version": {"N": "1"},
        "provenance": {"S": json.dumps(provenance, separators=(",", ":"), sort_keys=True)},
    }
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "dynamodb", "put-item", "--table-name", table,
        "--item", json.dumps(item, separators=(",", ":")), "--condition-expression", "attribute_not_exists(operationId)",
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.CalledProcessError as error:
        if "ConditionalCheckFailedException" not in (error.stderr or ""):
            raise BackupAuthenticationError("could not initialize authoritative restore floor") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not initialize authoritative restore floor") from error
    record = dynamo_floor_record(arguments)
    if not record:
        fail("authoritative restore floor initialization did not converge")
    return record


def reserve_transfer_nonce(
    transfer_id: str,
    operation_id: str,
    floor_version: int,
    floor_generation: int,
    floor_backup_id: str,
    backup_generation: int,
    backup_id: str,
) -> None:
    table = operation_table_name()
    if not table:
        fail("transfer authorization reservation requires the authoritative DynamoDB store")
    key = f"backup-transfer-consumed-{transfer_id}"
    item = {
        "operationId": {"S": key}, "kind": {"S": "backup-transfer-nonce"}, "status": {"S": "reserved"},
        "authorizationOwner": {"S": operation_id},
        "transferId": {"S": transfer_id}, "floorVersion": {"N": str(floor_version)},
        "floorGeneration": {"N": str(floor_generation)}, "floorBackupId": {"S": floor_backup_id},
        "backupGeneration": {"N": str(backup_generation)}, "backupId": {"S": backup_id},
        "reservedAt": {"S": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")},
    }
    command = [os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "dynamodb", "put-item", "--table-name", table,
               "--item", json.dumps(item, separators=(",", ":")), "--condition-expression", "attribute_not_exists(operationId)"]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.CalledProcessError as error:
        if "ConditionalCheckFailedException" in (error.stderr or ""):
            try:
                current = subprocess.run(
                    [
                        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
                        "dynamodb",
                        "get-item",
                        "--table-name",
                        table,
                        "--consistent-read",
                        "--key",
                        json.dumps({"operationId": {"S": key}}, separators=(",", ":")),
                        "--output",
                        "json",
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=30,
                )
                existing = json.loads(current.stdout).get("Item") or {}
            except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as read_error:
                raise BackupAuthenticationError("could not verify one-time transfer authorization ownership") from read_error
            if (
                existing.get("status", {}).get("S") == "reserved"
                and existing.get("authorizationOwner", {}).get("S") == operation_id
                and existing.get("transferId", {}).get("S") == transfer_id
                and existing.get("floorVersion", {}).get("N") == str(floor_version)
                and existing.get("floorGeneration", {}).get("N") == str(floor_generation)
                and existing.get("floorBackupId", {}).get("S") == floor_backup_id
                and existing.get("backupGeneration", {}).get("N") == str(backup_generation)
                and existing.get("backupId", {}).get("S") == backup_id
            ):
                return
            fail("one-time transfer authorization is already reserved or consumed by another owner")
        raise BackupAuthenticationError("could not reserve one-time transfer authorization") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not reserve one-time transfer authorization") from error


def commit_transfer_floor(arguments: argparse.Namespace, encoded: str, expected_version: int, transfer_id: str) -> None:
    table = operation_table_name()
    if not table:
        fail("transfer restore-floor commit requires the authoritative DynamoDB store")
    next_version = expected_version + 1
    floor_item = {"operationId": {"S": RESTORE_FLOOR_OPERATION_ID}, "kind": {"S": "restore-floor"}, "payload": {"S": encoded}, "version": {"N": str(next_version)}}
    nonce_key = {"operationId": {"S": f"backup-transfer-consumed-{transfer_id}"}}
    values = {
        ":expected": {"N": str(expected_version)}, ":reserved": {"S": "reserved"}, ":consumed": {"S": "consumed"},
        ":floorGeneration": {"N": str(arguments.generation)}, ":floorBackupId": {"S": arguments.backup_id},
        ":payload": {"S": encoded}, ":next": {"N": str(next_version)}, ":kind": {"S": "restore-floor"},
        ":now": {"S": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")},
    }
    if expected_version == 0:
        floor_action = {"Put": {"TableName": table, "Item": floor_item, "ConditionExpression": "attribute_not_exists(operationId)"}}
    else:
        floor_action = {"Update": {"TableName": table, "Key": {"operationId": {"S": RESTORE_FLOOR_OPERATION_ID}},
            "ConditionExpression": "#version = :expected", "UpdateExpression": "SET payload = :payload, #version = :next, #kind = :kind",
            "ExpressionAttributeNames": {"#version": "version", "#kind": "kind"}, "ExpressionAttributeValues": {
                ":expected": values[":expected"], ":next": values[":next"], ":payload": values[":payload"], ":kind": values[":kind"]
            }}}
    nonce_action = {"Update": {"TableName": table, "Key": nonce_key,
        "ConditionExpression": "#status = :reserved AND floorVersion = :expected",
        "UpdateExpression": "SET #status = :consumed, committedFloorGeneration = :floorGeneration, committedFloorBackupId = :floorBackupId, consumedAt = :now",
        "ExpressionAttributeNames": {"#status": "status"}, "ExpressionAttributeValues": {
            ":expected": values[":expected"], ":reserved": values[":reserved"], ":consumed": values[":consumed"],
            ":floorGeneration": values[":floorGeneration"], ":floorBackupId": values[":floorBackupId"], ":now": values[":now"]
        }}}
    command = [os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "dynamodb", "transact-write-items", "--client-request-token", transfer_id,
               "--transact-items", json.dumps([floor_action, nonce_action], separators=(",", ":"))]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.CalledProcessError as error:
        record = dynamo_floor_record(arguments)
        if record and record[1] == next_version and record[0] == encoded:
            return
        if "ConditionalCheckFailedException" in (error.stderr or "") or "TransactionCanceledException" in (error.stderr or ""):
            fail("restore-floor or transfer authorization became stale; authorization was not consumed")
        raise BackupAuthenticationError("could not atomically commit restore floor and transfer authorization") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not atomically commit restore floor and transfer authorization") from error


def acquire_dynamo_migration_lock(value: str) -> str:
    table = os.environ.get("MC_OPERATION_STATE_TABLE_NAME", "").strip()
    if not table or not re.fullmatch(r"[A-Za-z0-9_.:-]{3,255}", table):
        fail("backup recovery migration lock authority is unavailable")
    key = "mc-aws-backup-recovery-migration"
    lease = int(dt.datetime.now(dt.timezone.utc).timestamp()) + 900
    item = json.dumps(
        {
            "operationId": {"S": key},
            "payload": {"S": value},
            "lockOwner": {"S": value},
            "leaseExpiresAt": {"N": str(lease)},
        },
        separators=(",", ":"),
    )
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
        "dynamodb",
        "put-item",
        "--table-name",
        table,
        "--item",
        item,
        "--condition-expression",
        "attribute_not_exists(operationId) OR leaseExpiresAt < :now",
        "--expression-attribute-values",
        json.dumps({":now": {"N": str(int(dt.datetime.now(dt.timezone.utc).timestamp()))}}, separators=(",", ":")),
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
    except subprocess.CalledProcessError as error:
        if "ConditionalCheckFailedException" in (error.stderr or ""):
            raise BackupAuthenticationError("backup recovery migration is busy; retry after the active writer exits") from error
        raise BackupAuthenticationError("backup recovery migration lock authority is unavailable") from error
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("backup recovery migration lock authority is unavailable") from error
    return key


def release_dynamo_migration_lock(key: str, value: str) -> None:
    table = os.environ.get("MC_OPERATION_STATE_TABLE_NAME", "").strip()
    if not table:
        raise BackupAuthenticationError("backup recovery migration lock authority is unavailable")
    command = [
        os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"),
        "dynamodb",
        "update-item",
        "--table-name",
        table,
        "--key",
        json.dumps({"operationId": {"S": key}}, separators=(",", ":")),
        "--update-expression",
        "SET leaseExpiresAt = :expired",
        "--condition-expression",
        "lockOwner = :owner",
        "--expression-attribute-values",
        json.dumps({":expired": {"N": "0"}, ":owner": {"S": value}}, separators=(",", ":")),
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not release backup recovery migration lock") from error


def _migration_lock_value(operation: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", operation):
        fail("migration lock operation is invalid")
    return canonical({
        "format": "mc-aws-backup-recovery-migration-lock",
        "operation": operation,
        "owner": secrets.token_hex(16),
        "schemaVersion": 1,
    }).decode("ascii")


@contextmanager
def migration_lock(operation: str):
    """Serialize every writer which can change the recovery lineage.

    SSM has no conditional PutParameter version argument.  The retained lock is
    therefore the linearization point: acquisition is an atomic no-overwrite
    create, and the owner verifies the exact value before and after the state
    operation.  Test runs use the same O_EXCL protocol rather than a process
    mutex so the race remains observable.
    """
    value = _migration_lock_value(operation)
    test_file = os.environ.get("MC_BACKUP_MIGRATION_LOCK_FILE")
    if test_file:
        path = Path(test_file)
        descriptor: int | None = None
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="ascii") as output:
                descriptor = None
                output.write(value + "\n")
                output.flush()
                os.fsync(output.fileno())
            yield
        except FileExistsError as error:
            raise BackupAuthenticationError("backup recovery migration is busy; retry after the active writer exits") from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                if path.read_text(encoding="ascii").strip() == value:
                    path.unlink()
            except FileNotFoundError:
                pass
            except (OSError, UnicodeError) as error:
                raise BackupAuthenticationError("could not release backup recovery migration lock") from error
        return

    key = acquire_dynamo_migration_lock(value)
    try:
        yield
    finally:
        release_dynamo_migration_lock(key, value)


def parse_keyring(raw: str) -> tuple[dict[str, Any], str, dict[str, bytes]]:
    value = exact_keys(parse_json(raw, "backup authentication keyring"), {"schemaVersion", "currentKeyId", "keys"}, "backup authentication keyring")
    if value["schemaVersion"] != 1 or not isinstance(value["currentKeyId"], str) or not KEY_ID.fullmatch(value["currentKeyId"]):
        fail("backup authentication keyring identity is invalid")
    if not isinstance(value["keys"], list) or not 1 <= len(value["keys"]) <= 8:
        fail("backup authentication keyring keys are invalid")
    keys: dict[str, bytes] = {}
    statuses: dict[str, str] = {}
    for candidate in value["keys"]:
        item = exact_keys(candidate, {"keyId", "secretBase64", "status"}, "backup authentication key")
        key_id, encoded, status_value = item["keyId"], item["secretBase64"], item["status"]
        if not isinstance(key_id, str) or not KEY_ID.fullmatch(key_id) or key_id in keys:
            fail("backup authentication key ID is invalid or duplicated")
        if status_value not in ("active", "verify-only") or not isinstance(encoded, str):
            fail("backup authentication key status or material is invalid")
        try:
            material = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise BackupAuthenticationError("backup authentication key material is invalid") from error
        if not 32 <= len(material) <= 64 or base64.b64encode(material).decode("ascii") != encoded:
            fail("backup authentication key material is invalid")
        keys[key_id] = material
        statuses[key_id] = status_value
    current = value["currentKeyId"]
    if statuses.get(current) != "active" or list(statuses.values()).count("active") != 1:
        fail("backup authentication keyring must have one matching active key")
    return value, current, keys


def load_keyring() -> tuple[str, dict[str, bytes]]:
    raw = fetch_parameter(os.environ.get("MC_BACKUP_AUTH_KEYRING_PARAMETER", KEYRING_PARAMETER), True)
    _, current, keys = parse_keyring(raw)
    return current, keys


def load_server_identity() -> str:
    value = fetch_parameter(os.environ.get("MC_BACKUP_SERVER_ID_PARAMETER", SERVER_ID_PARAMETER), False)
    if not SERVER_ID.fullmatch(value):
        fail("backup server identity is invalid")
    return value


def load_instance_identity() -> str:
    path = Path(os.environ.get("MC_BACKUP_INSTANCE_ID_FILE", DEFAULT_INSTANCE_ID_FILE))
    try:
        value = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        raise BackupAuthenticationError("could not read instance identity") from error
    if not INSTANCE_ID.fullmatch(value):
        fail("instance identity is invalid")
    return value


def regular_file(path: Path, label: str, max_bytes: int) -> tuple[int, str]:
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size < 1 or before.st_size > max_bytes:
            fail(f"{label} is not one bounded regular file")
        digest = hashlib.sha256()
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        after = path.lstat()
    except OSError as error:
        raise BackupAuthenticationError(f"could not inspect {label}") from error
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_after:
        fail(f"{label} changed while hashing")
    return before.st_size, digest.hexdigest()


def validate_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not ISO_UTC.fullmatch(value):
        fail("manifest creation time is invalid")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise BackupAuthenticationError("manifest creation time is invalid") from error
    if parsed > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
        fail("manifest creation time is in the future")
    return value


def validate_unsigned(
    value: Any,
    expected_archive_name: str,
    expected_server_id: str,
    expected_instance_id: str | None = None,
) -> dict[str, Any]:
    manifest = exact_keys(value, {"archive", "backup", "format", "schemaVersion", "source"}, "manifest payload")
    if manifest["schemaVersion"] != SCHEMA_VERSION or manifest["format"] != FORMAT:
        fail("manifest format or version is unsupported")
    archive = exact_keys(manifest["archive"], {"format", "name", "sha256", "size"}, "manifest archive")
    backup = exact_keys(manifest["backup"], {"createdAt", "generation", "id", "name", "operationKey"}, "manifest backup")
    source = exact_keys(manifest["source"], {"instanceId", "serverId"}, "manifest source")
    if archive["format"] != "tar+gzip" or archive["name"] != expected_archive_name:
        fail("manifest archive name or format does not match the exact request")
    if not isinstance(archive["sha256"], str) or not SHA256.fullmatch(archive["sha256"]):
        fail("manifest archive digest is invalid")
    if not isinstance(archive["size"], int) or isinstance(archive["size"], bool) or not 1 <= archive["size"] <= MAX_ARCHIVE_BYTES:
        fail("manifest archive size is invalid")
    if not isinstance(backup["name"], str) or not NAME.fullmatch(backup["name"]):
        fail("manifest backup name is invalid")
    if expected_archive_name != f"{backup['name']}.tar.gz":
        fail("manifest backup and archive names are not exactly bound")
    if not isinstance(backup["id"], str) or not BACKUP_ID.fullmatch(backup["id"]):
        fail("manifest backup ID is invalid")
    if not isinstance(backup["generation"], int) or isinstance(backup["generation"], bool) or not 1 <= backup["generation"] <= MAX_GENERATION:
        fail("manifest backup generation is invalid")
    validate_timestamp(backup["createdAt"])
    if not isinstance(source["instanceId"], str) or not INSTANCE_ID.fullmatch(source["instanceId"]):
        fail("manifest source instance identity is invalid")
    if expected_instance_id is not None and source["instanceId"] != expected_instance_id:
        fail("manifest belongs to another instance")
    if source["serverId"] != expected_server_id:
        fail("manifest belongs to another server")
    if backup["operationKey"] is not None and (not isinstance(backup["operationKey"], str) or not re.fullmatch(r"[a-f0-9]{64}", backup["operationKey"])):
        fail("manifest operation identity is invalid")
    return manifest


def validate_generation(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_GENERATION:
        fail("backup generation is invalid")
    return value


def build_payload(
    archive_path: Path,
    archive_name: str,
    backup_name: str,
    backup_id: str,
    created_at: str,
    generation: int,
    operation_key: str | None = None,
) -> dict[str, Any]:
    if not NAME.fullmatch(backup_name) or archive_name != f"{backup_name}.tar.gz":
        fail("backup and archive names must be exact and canonical")
    if not BACKUP_ID.fullmatch(backup_id):
        fail("backup ID is invalid")
    if operation_key is not None and not re.fullmatch(r"[a-f0-9]{64}", operation_key):
        fail("backup operation identity is invalid")
    validate_timestamp(created_at)
    validate_generation(generation)
    size, digest = regular_file(archive_path, "backup archive", MAX_ARCHIVE_BYTES)
    return {
        "archive": {"format": "tar+gzip", "name": archive_name, "sha256": digest, "size": size},
        "backup": {
            "createdAt": created_at,
            "generation": generation,
            "id": backup_id,
            "name": backup_name,
            "operationKey": operation_key,
        },
        "format": FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "source": {"instanceId": load_instance_identity(), "serverId": load_server_identity()},
    }


def create_manifest(arguments: argparse.Namespace) -> None:
    archive_path, manifest_path = Path(arguments.archive), Path(arguments.manifest)
    payload = build_payload(
        archive_path,
        arguments.archive_name,
        arguments.backup_name,
        arguments.backup_id,
        arguments.created_at,
        arguments.generation,
        arguments.operation_key,
    )
    current_key_id, keys = load_keyring()
    tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
    manifest = {**payload, "authentication": {"algorithm": "HMAC-SHA256", "keyId": current_key_id, "tag": tag}}
    encoded = canonical(manifest) + b"\n"
    if len(encoded) > MAX_MANIFEST_BYTES:
        fail("manifest exceeds its size limit")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(manifest_path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
    except OSError as error:
        raise BackupAuthenticationError("could not write backup manifest") from error


def authenticate_manifest_bytes(raw: bytes, archive_name: str, expected_instance_id: str | None = None) -> tuple[dict[str, Any], str]:
    if not 1 <= len(raw) <= MAX_MANIFEST_BYTES or b"\x00" in raw:
        fail("manifest size or encoding is invalid")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise BackupAuthenticationError("manifest is not canonical ASCII JSON") from error
    value = parse_json(text, "backup manifest")
    if raw != canonical(value) + b"\n":
        fail("backup manifest is not in strict canonical form")
    manifest = exact_keys(value, {"archive", "authentication", "backup", "format", "schemaVersion", "source"}, "backup manifest")
    authentication = exact_keys(manifest["authentication"], {"algorithm", "keyId", "tag"}, "manifest authentication")
    if authentication["algorithm"] != "HMAC-SHA256" or not isinstance(authentication["keyId"], str) or not KEY_ID.fullmatch(authentication["keyId"]):
        fail("manifest authentication metadata is invalid")
    if not isinstance(authentication["tag"], str) or not SHA256.fullmatch(authentication["tag"]):
        fail("manifest authentication tag is invalid")
    payload = {key: manifest[key] for key in ("archive", "backup", "format", "schemaVersion", "source")}
    expected_server_id = load_server_identity()
    if expected_instance_id is not None and not INSTANCE_ID.fullmatch(expected_instance_id):
        fail("expected instance identity is invalid")
    validate_unsigned(payload, archive_name, expected_server_id, expected_instance_id)
    _, keys = load_keyring()
    key = keys.get(authentication["keyId"])
    if key is None:
        fail("manifest uses an unknown or retired authentication key")
    expected_tag = hmac.new(key, canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_tag, authentication["tag"]):
        fail("backup manifest authentication failed")
    return payload, authentication["keyId"]


def authenticate_manifest(manifest_path: Path, archive_name: str, expected_instance_id: str | None = None) -> tuple[dict[str, Any], str]:
    try:
        raw = manifest_path.read_bytes()
    except OSError as error:
        raise BackupAuthenticationError("could not read backup manifest") from error
    return authenticate_manifest_bytes(raw, archive_name, expected_instance_id)


def manifest_result(payload: dict[str, Any], key_id: str) -> str:
    return "\t".join((
        payload["backup"]["id"],
        payload["backup"]["createdAt"],
        key_id,
        str(payload["backup"]["generation"]),
        payload["archive"]["name"],
    ))


def manifest_json(payload: dict[str, Any], key_id: str) -> str:
    return json.dumps(
        {
            "archiveName": payload["archive"]["name"],
            "archiveSha256": payload["archive"]["sha256"],
            "archiveSize": payload["archive"]["size"],
            "authenticationKeyId": key_id,
            "backupId": payload["backup"]["id"],
            "createdAt": payload["backup"]["createdAt"],
            "generation": payload["backup"]["generation"],
            "instanceId": payload["source"]["instanceId"],
            "operationKey": payload["backup"]["operationKey"],
            "serverId": payload["source"]["serverId"],
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


def inspect_manifest(arguments: argparse.Namespace) -> None:
    payload, key_id = authenticate_manifest(Path(arguments.manifest), arguments.archive_name)
    if arguments.output == "json":
        print(manifest_json(payload, key_id))
    else:
        print(manifest_result(payload, key_id))


def verify_manifest(arguments: argparse.Namespace) -> None:
    archive_path = Path(arguments.archive)
    payload, key_id = authenticate_manifest(Path(arguments.manifest), arguments.archive_name, arguments.expected_instance_id)
    size, digest = regular_file(archive_path, "backup archive", MAX_ARCHIVE_BYTES)
    if size != payload["archive"]["size"] or not hmac.compare_digest(digest, payload["archive"]["sha256"]):
        fail("backup archive digest or size does not match its authenticated manifest")
    if arguments.expected_backup_id and payload["backup"]["id"] != arguments.expected_backup_id:
        fail("backup ID does not match the pinned restore request")
    if arguments.expected_generation is not None and payload["backup"]["generation"] != arguments.expected_generation:
        fail("backup generation does not match the pinned restore request")
    if arguments.expected_operation_key is not None and payload["backup"]["operationKey"] != arguments.expected_operation_key:
        fail("backup operation identity does not match the pinned request")
    print(manifest_json(payload, key_id) if arguments.output == "json" else manifest_result(payload, key_id))


def stream_remote(arguments: argparse.Namespace, name: str, limit: int, collect: bool) -> tuple[int, str, bytes]:
    remote_path = f"{arguments.remote}:{arguments.root}/{name}"
    try:
        process = subprocess.Popen(
            [arguments.rclone, "cat", remote_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "RCLONE_CONFIG": arguments.config},
        )
    except OSError as error:
        raise BackupAuthenticationError("could not read authenticated remote backup") from error
    digest = hashlib.sha256()
    size = 0
    chunks: list[bytes] = []
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while True:
            ready = selector.select(timeout=120)
            if not ready:
                process.kill()
                fail("remote backup verification timed out")
            chunk = os.read(process.stdout.fileno(), 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                process.kill()
                fail("remote backup object exceeds its size limit")
            digest.update(chunk)
            if collect:
                chunks.append(chunk)
        if process.wait(timeout=5) != 0:
            fail("could not read authenticated remote backup")
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    return size, digest.hexdigest(), b"".join(chunks)


def remote_verify(arguments: argparse.Namespace) -> None:
    archive_name = arguments.archive_name
    manifest_name = f"{archive_name}.manifest.json"
    _, _, manifest_bytes = stream_remote(arguments, manifest_name, MAX_MANIFEST_BYTES, True)
    payload, key_id = authenticate_manifest_bytes(manifest_bytes, archive_name, arguments.expected_instance_id)
    size, digest, _ = stream_remote(arguments, archive_name, MAX_ARCHIVE_BYTES, False)
    if size != payload["archive"]["size"] or not hmac.compare_digest(digest, payload["archive"]["sha256"]):
        fail("remote backup archive digest or size does not match its authenticated manifest")
    if arguments.expected_backup_id and payload["backup"]["id"] != arguments.expected_backup_id:
        fail("backup ID does not match the pinned remote request")
    if arguments.expected_generation is not None and payload["backup"]["generation"] != arguments.expected_generation:
        fail("backup generation does not match the pinned remote request")
    if arguments.expected_operation_key is not None and payload["backup"]["operationKey"] != arguments.expected_operation_key:
        fail("backup operation identity does not match the pinned remote request")
    print(manifest_json(payload, key_id) if arguments.output == "json" else manifest_result(payload, key_id))


def remote_list(arguments: argparse.Namespace) -> None:
    remote_path = f"{arguments.remote}:{arguments.root}/"
    try:
        listing = subprocess.run(
            [
                arguments.rclone,
                "lsf",
                remote_path,
                "--max-depth",
                "1",
                "--files-only",
                "--format",
                "p",
                "--filter",
                "+ *.tar.gz",
                "--filter",
                "+ *.tar.gz.manifest.json",
                "--filter",
                "- *",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            timeout=120,
            env={**os.environ, "RCLONE_CONFIG": arguments.config},
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:
        raise BackupAuthenticationError("could not list configured backup storage") from error

    names = [line.strip() for line in listing.splitlines() if line.strip()]
    allowed = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz(?:\.manifest\.json)?")
    files = {name for name in names if allowed.fullmatch(name)}
    archives = sorted(name for name in files if name.endswith(".tar.gz"))
    manifests = {name for name in files if name.endswith(".tar.gz.manifest.json")}
    orphaned = manifests - {f"{name}.manifest.json" for name in archives}
    if orphaned:
        fail("backup storage contains an orphaned authenticated manifest")

    records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="mc-backup-list-") as directory:
        for archive_name in archives:
            manifest_name = f"{archive_name}.manifest.json"
            if manifest_name not in manifests:
                # An archive without its detached manifest is not a backup. It
                # is deliberately ignored so an old/plain archive can never
                # become a hibernation success proof.
                continue
            archive_path = Path(directory) / archive_name
            manifest_path = Path(directory) / manifest_name
            for name, destination in ((archive_name, archive_path), (manifest_name, manifest_path)):
                try:
                    subprocess.run(
                        [arguments.rclone, "copyto", f"{remote_path}{name}", str(destination)],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=120,
                        env={**os.environ, "RCLONE_CONFIG": arguments.config},
                    )
                except (OSError, subprocess.SubprocessError) as error:
                    raise BackupAuthenticationError("could not download every backup pair for authentication") from error
            payload, key_id = authenticate_manifest(manifest_path, archive_name)
            size, digest = regular_file(archive_path, "backup archive", MAX_ARCHIVE_BYTES)
            if size != payload["archive"]["size"] or not hmac.compare_digest(digest, payload["archive"]["sha256"]):
                fail("backup archive digest or size does not match its authenticated manifest")
            records.append(json.loads(manifest_json(payload, key_id)))
    print(json.dumps(records, ensure_ascii=True, separators=(",", ":"), sort_keys=True))


def write_atomic(path: Path, encoded: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.new.{os.getpid()}")
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        raise BackupAuthenticationError("could not persist local backup state") from error
    finally:
        if descriptor != -1:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def build_state(kind: str, generation: int, backup_id: str, updated_at: str) -> dict[str, Any]:
    validate_generation(generation)
    if kind not in ("backup-generation", "restore-floor"):
        fail("backup state kind is invalid")
    if not BACKUP_ID.fullmatch(backup_id):
        fail("backup state ID is invalid")
    validate_timestamp(updated_at)
    payload = {
        "format": STATE_FORMAT,
        "schemaVersion": STATE_SCHEMA_VERSION,
        "source": {"serverId": load_server_identity()},
        "state": {"backupId": backup_id, "generation": generation, "kind": kind, "updatedAt": updated_at},
    }
    current_key_id, keys = load_keyring()
    tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
    return {**payload, "authentication": {"algorithm": "HMAC-SHA256", "keyId": current_key_id, "tag": tag}}


def validate_state(
    raw: str,
    kind: str,
    expected_server_id: str | None = None,
    verification_keys: dict[str, bytes] | None = None,
) -> dict[str, Any]:
    value = parse_json(raw, "backup state")
    state_document = exact_keys(value, {"authentication", "format", "schemaVersion", "source", "state"}, "backup state")
    authentication = exact_keys(state_document["authentication"], {"algorithm", "keyId", "tag"}, "backup state authentication")
    source = exact_keys(state_document["source"], {"serverId"}, "backup state source")
    state_value = exact_keys(state_document["state"], {"backupId", "generation", "kind", "updatedAt"}, "backup state value")
    if state_document["format"] != STATE_FORMAT or state_document["schemaVersion"] != STATE_SCHEMA_VERSION:
        fail("backup state format or version is unsupported")
    if source["serverId"] != (expected_server_id if expected_server_id is not None else load_server_identity()):
        fail("backup state belongs to another server")
    if state_value["kind"] != kind:
        fail("backup state kind does not match")
    validate_generation(state_value["generation"])
    if not isinstance(state_value["backupId"], str) or not BACKUP_ID.fullmatch(state_value["backupId"]):
        fail("backup state ID is invalid")
    validate_timestamp(state_value["updatedAt"])
    if authentication["algorithm"] != "HMAC-SHA256" or not isinstance(authentication["keyId"], str) or not KEY_ID.fullmatch(authentication["keyId"]):
        fail("backup state authentication metadata is invalid")
    if not isinstance(authentication["tag"], str) or not SHA256.fullmatch(authentication["tag"]):
        fail("backup state authentication tag is invalid")
    payload = {key: state_document[key] for key in ("format", "schemaVersion", "source", "state")}
    keys = verification_keys
    if keys is None:
        _, keys = load_keyring()
    key = keys.get(authentication["keyId"])
    if key is None or not hmac.compare_digest(hmac.new(key, canonical(payload), hashlib.sha256).hexdigest(), authentication["tag"]):
        fail("backup state authentication failed")
    return state_document


def server_account_id(server_id: str) -> str:
    match = re.fullmatch(r"arn:aws(?:-[a-z]+)?:cloudformation:[a-z0-9-]+:(\d{12}):stack/[A-Za-z][A-Za-z0-9-]{0,127}/[A-Za-z0-9-]+", server_id)
    if not match:
        fail("stable server identity does not contain an AWS account")
    return match.group(1)


def validate_transfer_fence(value: Any) -> dict[str, Any]:
    fence = exact_keys(value, {"fencingToken", "leaseGeneration", "lockId"}, "transfer lifecycle fence")
    if (
        not isinstance(fence["lockId"], str)
        or not fence["lockId"]
        or not isinstance(fence["fencingToken"], int)
        or isinstance(fence["fencingToken"], bool)
        or not 1 <= fence["fencingToken"] <= MAX_GENERATION
        or not isinstance(fence["leaseGeneration"], int)
        or isinstance(fence["leaseGeneration"], bool)
        or not 1 <= fence["leaseGeneration"] <= MAX_GENERATION
    ):
        fail("transfer lifecycle fence is invalid")
    return fence


def validate_transfer_offer(
    value: Any,
    verification_keys: dict[str, bytes],
    *,
    allow_expired: bool = False,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    offer = exact_keys(
        value,
        {"authentication", "backup", "delegation", "format", "lifecycle", "operationId", "restoreFloor", "schemaVersion", "source", "validity"},
        "transfer authorization offer",
    )
    if offer["format"] != TRANSFER_OFFER_FORMAT or offer["schemaVersion"] != TRANSFER_SCHEMA_VERSION:
        fail("transfer authorization offer format or version is unsupported")
    if not isinstance(offer["operationId"], str) or not REPLACEMENT_OPERATION_ID.fullmatch(offer["operationId"]):
        fail("transfer replacement operation identity is invalid")
    backup = exact_keys(offer["backup"], {"archiveName", "backupId", "generation"}, "transfer backup")
    if (
        not isinstance(backup["archiveName"], str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz", backup["archiveName"])
        or not isinstance(backup["backupId"], str)
        or not BACKUP_ID.fullmatch(backup["backupId"])
    ):
        fail("transfer backup identity is invalid")
    validate_generation(backup["generation"])
    delegation = exact_keys(offer["delegation"], {"keyBase64"}, "transfer delegation")
    if not isinstance(delegation["keyBase64"], str):
        fail("transfer delegation key is invalid")
    try:
        delegated_key = base64.b64decode(delegation["keyBase64"], validate=True)
    except (ValueError, binascii.Error) as error:
        raise BackupAuthenticationError("transfer delegation key is invalid") from error
    if not 32 <= len(delegated_key) <= 64 or base64.b64encode(delegated_key).decode("ascii") != delegation["keyBase64"]:
        fail("transfer delegation key is invalid")
    validate_transfer_fence(offer["lifecycle"])
    floor = exact_keys(offer["restoreFloor"], {"backupId", "generation"}, "transfer restore floor")
    if not isinstance(floor["generation"], int) or isinstance(floor["generation"], bool) or not 0 <= floor["generation"] <= MAX_GENERATION:
        fail("transfer restore floor generation is invalid")
    if floor["generation"] == 0:
        if floor["backupId"] != "":
            fail("uninitialized transfer restore floor has an ID")
    elif not isinstance(floor["backupId"], str) or not BACKUP_ID.fullmatch(floor["backupId"]):
        fail("transfer restore floor ID is invalid")
    source = exact_keys(offer["source"], {"accountId", "instanceId", "serverId"}, "transfer source")
    if (
        not isinstance(source["accountId"], str)
        or not re.fullmatch(r"\d{12}", source["accountId"])
        or not isinstance(source["instanceId"], str)
        or not INSTANCE_ID.fullmatch(source["instanceId"])
        or not isinstance(source["serverId"], str)
        or not SERVER_ID.fullmatch(source["serverId"])
        or source["accountId"] != server_account_id(source["serverId"])
    ):
        fail("transfer source identity is invalid")
    validity = exact_keys(offer["validity"], {"expiresAt", "issuedAt", "transferId"}, "transfer validity")
    validate_timestamp(validity["issuedAt"])
    if not isinstance(validity["expiresAt"], str) or not ISO_UTC.fullmatch(validity["expiresAt"]):
        fail("transfer expiration time is invalid")
    if not isinstance(validity["transferId"], str) or not re.fullmatch(r"[a-f0-9]{32}", validity["transferId"]):
        fail("transfer identity is invalid")
    try:
        issued = dt.datetime.strptime(validity["issuedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        expires = dt.datetime.strptime(validity["expiresAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise BackupAuthenticationError("transfer validity timestamp is invalid") from error
    if expires <= issued or expires > issued + dt.timedelta(hours=24) or (not allow_expired and dt.datetime.now(dt.timezone.utc) > expires):
        fail("transfer authorization offer is expired or has an invalid lifetime")
    authentication = exact_keys(offer["authentication"], {"algorithm", "keyId", "tag"}, "transfer offer authentication")
    if (
        authentication["algorithm"] != "HMAC-SHA256"
        or not isinstance(authentication["keyId"], str)
        or not KEY_ID.fullmatch(authentication["keyId"])
        or not isinstance(authentication["tag"], str)
        or not SHA256.fullmatch(authentication["tag"])
    ):
        fail("transfer offer authentication metadata is invalid")
    key = verification_keys.get(authentication["keyId"])
    if key is None or not hmac.compare_digest(
        hmac.new(key, canonical({key: offer[key] for key in ("backup", "delegation", "format", "lifecycle", "operationId", "restoreFloor", "schemaVersion", "source", "validity")} ), hashlib.sha256).hexdigest(),
        authentication["tag"],
    ):
        fail("transfer offer authentication failed")
    return offer, {"delegated": delegated_key}


def read_transfer_offer(path: Path | None, raw_value: str | None = None) -> dict[str, Any]:
    """Read a source offer without accepting key material from the caller.

    The offer is public metadata, but it is still required to be canonical so
    that a renewal cannot silently change an unsigned representation of its
    lineage.  The keyring is deliberately loaded separately by the caller.
    """
    if raw_value is not None:
        raw = raw_value
    elif path is not None:
        try:
            raw = path.read_text(encoding="ascii")
        except (OSError, UnicodeError) as error:
            raise BackupAuthenticationError("could not read transfer authorization offer") from error
    else:
        raw = sys.stdin.read()
    if not 1 <= len(raw.encode("utf-8")) <= MAX_MANIFEST_BYTES * 2:
        fail("transfer authorization offer size is invalid")
    value = parse_json(raw, "transfer authorization offer")
    if raw.rstrip("\r\n") != canonical(value).decode("ascii"):
        fail("transfer authorization offer is not in strict canonical form")
    return value


def transfer_create(arguments: argparse.Namespace) -> None:
    server_id = load_server_identity()
    source = {
        "accountId": server_account_id(server_id),
        "instanceId": load_instance_identity(),
        "serverId": server_id,
    }
    validate_generation(arguments.generation)
    if arguments.floor_generation == 0:
        if arguments.floor_backup_id:
            fail("uninitialized transfer restore floor has an ID")
    elif not BACKUP_ID.fullmatch(arguments.floor_backup_id):
        fail("transfer restore floor ID is invalid")
    payload = {
        "backup": {"archiveName": arguments.archive_name, "backupId": arguments.backup_id, "generation": arguments.generation},
        "delegation": {"keyBase64": base64.b64encode(secrets.token_bytes(32)).decode("ascii")},
        "format": TRANSFER_OFFER_FORMAT,
        "lifecycle": {
            "fencingToken": arguments.fencing_token,
            "leaseGeneration": arguments.lease_generation,
            "lockId": arguments.lock_id,
        },
        "operationId": arguments.operation_id,
        "restoreFloor": {"backupId": arguments.floor_backup_id, "generation": arguments.floor_generation},
        "schemaVersion": TRANSFER_SCHEMA_VERSION,
        "source": source,
        "validity": {
            "expiresAt": arguments.expires_at,
            "issuedAt": arguments.issued_at,
            "transferId": secrets.token_hex(16),
        },
    }
    current_key_id, keys = load_keyring()
    tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
    offer = {**payload, "authentication": {"algorithm": "HMAC-SHA256", "keyId": current_key_id, "tag": tag}}
    validate_transfer_offer(offer, keys)
    print(canonical(offer).decode("ascii"))


def transfer_renew(arguments: argparse.Namespace) -> None:
    """Renew a source offer using the retained/adopted root keyring authority.

    This operation intentionally does not read the current instance identity.
    It is used after the source host has disappeared, while the stable server
    identity and its adopted keyring remain authoritative.  The old offer is
    authenticated even after its freshness window has elapsed; the newly
    issued offer is validated with the normal current-time rules below.
    """
    authorization = None
    if arguments.authorization_parameter and not operation_table_name():
        fail("transfer renewal requires the authoritative DynamoDB store")
    if arguments.authorization_parameter:
        authorization = exact_keys(
            parse_json(fetch_parameter(arguments.authorization_parameter, False), "transfer renewal authorization"),
            {"authentication", "format", "lifecycle", "offer", "operationId", "schemaVersion", "target"},
            "transfer renewal authorization",
        )
        if authorization["format"] != TRANSFER_FORMAT or authorization["schemaVersion"] != TRANSFER_SCHEMA_VERSION:
            fail("transfer renewal authorization format or version is unsupported")
        authorization_fence = validate_transfer_fence(authorization["lifecycle"])
        target = exact_keys(authorization["target"], {"accountId", "instanceId"}, "transfer renewal target")
        current_instance = load_instance_identity()
        current_server_id = load_server_identity()
        if target["instanceId"] != current_instance or target["accountId"] != server_account_id(current_server_id):
            fail("transfer renewal authorization is bound to another target instance or account")
        value = authorization["offer"]
    else:
        value = read_transfer_offer(Path(arguments.offer_file) if arguments.offer_file else None, arguments.offer_json)
        current_server_id = load_server_identity()
    current_key_id, keys = load_keyring()
    old_offer, delegated = validate_transfer_offer(value, keys, allow_expired=authorization is not None)

    if authorization is not None:
        if authorization["operationId"] != arguments.operation_id:
            fail("transfer renewal authorization belongs to another replacement operation")
        if (
            authorization_fence["lockId"] != arguments.lock_id
            or authorization_fence["fencingToken"] != arguments.fencing_token
            or authorization_fence["leaseGeneration"] != arguments.lease_generation
        ):
            fail("transfer renewal authorization lifecycle fence does not match the active replacement")
        authentication = exact_keys(
            authorization["authentication"], {"algorithm", "keyId", "tag"}, "transfer renewal authentication"
        )
        if (
            authentication["algorithm"] != "HMAC-SHA256"
            or authentication["keyId"] != "transfer-delegated"
            or not SHA256.fullmatch(authentication["tag"])
        ):
            fail("transfer renewal authentication metadata is invalid")
        authorization_payload = {
            "format": authorization["format"],
            "lifecycle": authorization["lifecycle"],
            "offer": authorization["offer"],
            "operationId": authorization["operationId"],
            "schemaVersion": authorization["schemaVersion"],
            "target": authorization["target"],
        }
        expected_tag = hmac.new(delegated["delegated"], canonical(authorization_payload), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_tag, authentication["tag"]):
            fail("transfer renewal authorization authentication failed")

    if old_offer["operationId"] != arguments.operation_id:
        fail("transfer authorization belongs to another replacement operation")
    if old_offer["source"]["serverId"] != current_server_id:
        fail("transfer authorization belongs to another server")
    if old_offer["source"]["accountId"] != server_account_id(current_server_id):
        fail("transfer authorization source account is not the stable server account")
    if (
        old_offer["backup"]["archiveName"] != arguments.archive_name
        or old_offer["backup"]["backupId"] != arguments.backup_id
        or old_offer["backup"]["generation"] != arguments.generation
    ):
        fail("transfer authorization is bound to another exact backup")
    if (
        old_offer["restoreFloor"]["generation"] != arguments.floor_generation
        or old_offer["restoreFloor"]["backupId"] != arguments.floor_backup_id
    ):
        fail("transfer authorization restore floor lineage does not match the requested operation")
    prior_transfer_id = old_offer["validity"]["transferId"]
    if authorization is not None:
        existing_renewal = read_transfer_renewal(prior_transfer_id)
        if existing_renewal is not None:
            if existing_renewal[0] != arguments.operation_id:
                fail("transfer renewal is already owned by another operation")
            print(existing_renewal[1])
            return

    payload = {
        "backup": old_offer["backup"],
        "delegation": {"keyBase64": base64.b64encode(secrets.token_bytes(32)).decode("ascii")},
        "format": TRANSFER_OFFER_FORMAT,
        "lifecycle": {
            "fencingToken": arguments.fencing_token,
            "leaseGeneration": arguments.lease_generation,
            "lockId": arguments.lock_id,
        },
        "operationId": old_offer["operationId"],
        "restoreFloor": old_offer["restoreFloor"],
        "schemaVersion": TRANSFER_SCHEMA_VERSION,
        "source": old_offer["source"],
        "validity": {
            "expiresAt": arguments.expires_at,
            "issuedAt": arguments.issued_at,
            "transferId": secrets.token_hex(16),
        },
    }
    tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
    offer = {**payload, "authentication": {"algorithm": "HMAC-SHA256", "keyId": current_key_id, "tag": tag}}
    validate_transfer_offer(offer, keys)
    if authorization is not None:
        renewed_payload = persist_transfer_renewal(prior_transfer_id, arguments.operation_id, offer)
        consume_authorization_nonce(prior_transfer_id, "MC_BACKUP_TRANSFER_AUTH_FILE")
        print(renewed_payload)
        return
    print(canonical(offer).decode("ascii"))


def transfer_consume(arguments: argparse.Namespace) -> None:
    test_file = os.environ.get("MC_BACKUP_TRANSFER_AUTH_FILE")
    if test_file:
        try:
            raw = Path(test_file).read_text(encoding="ascii").strip()
        except (OSError, UnicodeError) as error:
            raise BackupAuthenticationError("could not read one-time transfer authorization") from error
    else:
        raw = fetch_parameter(os.environ.get("MC_BACKUP_TRANSFER_AUTH_PARAMETER", TRANSFER_PARAMETER), False)
    value = parse_json(raw, "transfer authorization")
    transfer = exact_keys(value, {"authentication", "format", "lifecycle", "offer", "operationId", "schemaVersion", "target"}, "transfer authorization")
    if transfer["format"] != TRANSFER_FORMAT or transfer["schemaVersion"] != TRANSFER_SCHEMA_VERSION:
        fail("transfer authorization format or version is unsupported")
    transfer_fence = validate_transfer_fence(transfer["lifecycle"])
    current_key_id, keys = load_keyring()
    offer, delegated = validate_transfer_offer(transfer["offer"], keys)
    if transfer["operationId"] != arguments.expected_operation_id or offer["operationId"] != arguments.expected_operation_id:
        fail("transfer authorization belongs to another replacement operation")
    target = exact_keys(transfer["target"], {"accountId", "instanceId"}, "transfer target")
    current_server = load_server_identity()
    current_instance = load_instance_identity()
    if target["accountId"] != server_account_id(current_server) or target["instanceId"] != current_instance:
        fail("transfer authorization is bound to another replacement instance or account")
    if offer["source"]["serverId"] != current_server:
        fail("transfer authorization belongs to another server")
    if offer["source"]["instanceId"] != arguments.expected_source_instance_id:
        fail("transfer source instance does not match the authenticated backup")
    if offer["backup"]["archiveName"] != arguments.archive_name or offer["backup"]["backupId"] != arguments.expected_backup_id or offer["backup"]["generation"] != arguments.expected_generation:
        fail("transfer authorization is bound to another exact backup")
    fence = offer["lifecycle"]
    if (
        transfer_fence["lockId"] != arguments.expected_lock_id
        or transfer_fence["fencingToken"] != arguments.expected_fencing_token
        or transfer_fence["leaseGeneration"] != arguments.expected_lease_generation
    ):
        fail("transfer authorization lifecycle fence does not match the active replacement")
    authentication = exact_keys(transfer["authentication"], {"algorithm", "keyId", "tag"}, "transfer authentication")
    if authentication["algorithm"] != "HMAC-SHA256" or authentication["keyId"] != "transfer-delegated" or not SHA256.fullmatch(authentication["tag"]):
        fail("transfer authentication metadata is invalid")
    final_payload = {"format": transfer["format"], "lifecycle": transfer["lifecycle"], "offer": transfer["offer"], "operationId": transfer["operationId"], "schemaVersion": transfer["schemaVersion"], "target": transfer["target"]}
    if not hmac.compare_digest(hmac.new(delegated["delegated"], canonical(final_payload), hashlib.sha256).hexdigest(), authentication["tag"]):
        fail("transfer authorization authentication failed")
    floor_args = argparse.Namespace(
        state_file=arguments.floor_state,
        parameter=arguments.floor_parameter,
        test_cloud_file_env=arguments.floor_cloud_environment,
    )
    current_floor, _, _ = state_replica(floor_args, "restore-floor")
    floor_record = dynamo_floor_record(floor_args)
    floor_version = 0 if floor_record is None else floor_record[1]
    floor_generation = 0 if current_floor is None else current_floor["state"]["generation"]
    floor_backup_id = "" if current_floor is None else current_floor["state"]["backupId"]
    offer_floor = offer["restoreFloor"]
    if floor_generation < offer_floor["generation"] or (floor_generation == offer_floor["generation"] and floor_backup_id != offer_floor["backupId"]):
        fail("transfer authorization restore floor is stale")
    if offer["backup"]["generation"] <= floor_generation:
        fail("transfer authorization backup is at or below the accepted restore floor")
    transfer_id = offer["validity"]["transferId"]
    if operation_table_name():
        reserve_transfer_nonce(
            transfer_id,
            arguments.expected_operation_id,
            floor_version,
            floor_generation,
            floor_backup_id,
            offer["backup"]["generation"],
            offer["backup"]["backupId"],
        )
    else:
        consume_authorization_nonce(transfer_id, "MC_BACKUP_TRANSFER_AUTH_FILE")
    print("\t".join((transfer_id, offer["source"]["instanceId"], target["instanceId"], str(offer["backup"]["generation"]), offer["backup"]["archiveName"], str(floor_version))))


def local_state_value(path: Path, kind: str) -> tuple[dict[str, Any] | None, str]:
    try:
        raw = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return None, UNINITIALIZED_STATE
    except (OSError, UnicodeError) as error:
        raise BackupAuthenticationError("could not read local backup state") from error
    if raw in ("", UNINITIALIZED_STATE):
        return None, UNINITIALIZED_STATE
    return validate_state(raw, kind), raw


def restore_floor_import_candidates(arguments: argparse.Namespace) -> tuple[dict[str, Any] | None, str, str, dict[str, Any]]:
    local_floor, local_raw = local_state_value(Path(arguments.state_file), "restore-floor")
    cloud_raw = fetch_optional_parameter(arguments.parameter, arguments.test_cloud_file_env)
    cloud_floor = None if cloud_raw in (None, UNINITIALIZED_STATE) else validate_state(cloud_raw, "restore-floor")
    candidates = [("local", local_floor), ("ssm", cloud_floor)]
    present = [(provenance, state) for provenance, state in candidates if state is not None]
    if not present:
        return None, local_raw, cloud_raw or UNINITIALIZED_STATE, {"floorSources": [], "checkpointSources": []}
    selected = max(present, key=lambda item: item[1]["state"]["generation"])
    for _, candidate in present:
        if candidate["state"]["generation"] == selected[1]["state"]["generation"] and candidate["state"]["backupId"] != selected[1]["state"]["backupId"]:
            fail("restore floor replicas conflict at the same generation")

    checkpoint_path = Path(os.environ.get("MC_BACKUP_GENERATION_STATE", "/var/lib/mc-aws/backup-generation.json"))
    checkpoint_local, checkpoint_local_raw = local_state_value(checkpoint_path, "backup-generation")
    checkpoint_cloud_raw = fetch_optional_parameter(
        GENERATION_PARAMETER,
        os.environ.get("MC_BACKUP_GENERATION_CLOUD_FILE_ENV", "MC_BACKUP_GENERATION_CLOUD_FILE"),
    )
    checkpoint_cloud = (
        None if checkpoint_cloud_raw in (None, UNINITIALIZED_STATE) else validate_state(checkpoint_cloud_raw, "backup-generation")
    )
    checkpoint_candidates = [("local", checkpoint_local), ("ssm", checkpoint_cloud)]
    checkpoint_present = [(provenance, state) for provenance, state in checkpoint_candidates if state is not None]
    if checkpoint_present:
        checkpoint_max = max(checkpoint_present, key=lambda item: item[1]["state"]["generation"])[1]
        if selected[1]["state"]["generation"] > checkpoint_max["state"]["generation"]:
            fail("restore floor exceeds the authenticated generation checkpoint")
        if (
            selected[1]["state"]["generation"] == checkpoint_max["state"]["generation"]
            and selected[1]["state"]["backupId"] != checkpoint_max["state"]["backupId"]
        ):
            fail("restore floor and generation checkpoint conflict at the same generation")
    provenance = {
        "floorSources": [source for source, _ in present],
        "checkpointSources": [source for source, _ in checkpoint_present],
        "selectedFloorSource": selected[0],
    }
    return selected[1], local_raw, cloud_raw or UNINITIALIZED_STATE, provenance


def state_replica(arguments: argparse.Namespace, kind: str) -> tuple[dict[str, Any] | None, str, str]:
    if kind == "restore-floor" and not operation_table_name() and not os.environ.get(arguments.test_cloud_file_env):
        fail("authoritative restore floor table is unavailable")
    if kind == "restore-floor" and operation_table_name():
        authoritative = dynamo_floor_record(arguments)
        if authoritative is None:
            selected, _, _, provenance = restore_floor_import_candidates(arguments)
            if selected is not None:
                authoritative = seed_dynamo_floor(arguments, canonical(selected).decode("ascii"), provenance)
        if authoritative is None:
            return None, UNINITIALIZED_STATE, UNINITIALIZED_STATE
        raw, _ = authoritative
        selected = validate_state(raw, kind)
        local_path = Path(arguments.state_file)
        local_raw = local_path.read_text(encoding="ascii").strip() if local_path.exists() else None
        if local_raw != raw:
            write_atomic(local_path, raw.encode("ascii") + b"\n")
        return selected, raw, raw
    local_path = Path(arguments.state_file)
    local_raw: str | None
    try:
        local_raw = local_path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        local_raw = None
    except (OSError, UnicodeError) as error:
        raise BackupAuthenticationError("could not read local backup state") from error
    cloud_raw = fetch_optional_parameter(arguments.parameter, arguments.test_cloud_file_env)
    local_state = None if local_raw in (None, UNINITIALIZED_STATE) else validate_state(local_raw, kind)
    cloud_state = None if cloud_raw in (None, UNINITIALIZED_STATE) else validate_state(cloud_raw, kind)
    if local_raw is None and cloud_raw is None:
        fail("both durable backup state replicas are missing")
    candidates = [candidate for candidate in (local_state, cloud_state) if candidate is not None]
    if not candidates:
        return None, local_raw or UNINITIALIZED_STATE, cloud_raw or UNINITIALIZED_STATE
    selected = max(candidates, key=lambda item: item["state"]["generation"])
    for candidate in candidates:
        if candidate["state"]["generation"] == selected["state"]["generation"] and candidate["state"]["backupId"] != selected["state"]["backupId"]:
            fail("durable backup state replicas conflict")
    encoded = canonical(selected).decode("ascii")
    if local_raw != encoded:
        write_atomic(local_path, encoded.encode("ascii") + b"\n")
    # DynamoDB is authoritative for restore-floor. The older checkpoint path
    # retains its authenticated SSM replica healing until its own coordinator
    # is migrated; it is intentionally excluded above for restore-floor.
    if kind != "restore-floor" and cloud_raw != encoded:
        write_parameter(arguments.parameter, encoded, arguments.test_cloud_file_env)
    return selected, encoded, encoded


def read_secure_capsule(path: Path) -> dict[str, Any]:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_mode & 0o077) != 0:
            fail("recovery capsule must be a private regular file")
        raw = path.read_bytes()
    except OSError as error:
        raise BackupAuthenticationError("could not read recovery capsule") from error
    if not 1 <= len(raw) <= MAX_MANIFEST_BYTES * 2 or b"\x00" in raw:
        fail("recovery capsule size or encoding is invalid")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as error:
        raise BackupAuthenticationError("recovery capsule is not canonical ASCII JSON") from error
    value = parse_json(text, "recovery capsule")
    if raw != canonical(value) + b"\n":
        fail("recovery capsule is not in strict canonical form")
    return value


def validate_capsule(value: Any) -> tuple[dict[str, Any], str, dict[str, bytes]]:
    capsule = exact_keys(
        value,
        {"authentication", "checkpoint", "format", "keyring", "restoreFloor", "schemaVersion", "serverId", "verifier"},
        "recovery capsule",
    )
    if capsule["format"] != CAPSULE_FORMAT or capsule["schemaVersion"] != CAPSULE_SCHEMA_VERSION:
        fail("recovery capsule format or version is unsupported")
    server_id = capsule["serverId"]
    if not isinstance(server_id, str) or not SERVER_ID.fullmatch(server_id):
        fail("recovery capsule server identity is invalid")
    keyring, current_key_id, keys = parse_keyring(json.dumps(capsule["keyring"], separators=(",", ":"), sort_keys=True))
    verifier = exact_keys(
        capsule["verifier"],
        {"algorithm", "keyIds", "manifestFormat", "manifestSchemaVersion", "stateFormat", "stateSchemaVersion"},
        "recovery capsule verifier",
    )
    if (
        verifier["algorithm"] != "HMAC-SHA256"
        or verifier["manifestFormat"] != FORMAT
        or verifier["manifestSchemaVersion"] != SCHEMA_VERSION
        or verifier["stateFormat"] != STATE_FORMAT
        or verifier["stateSchemaVersion"] != STATE_SCHEMA_VERSION
        or verifier["keyIds"] != list(keyring_item["keyId"] for keyring_item in capsule["keyring"]["keys"])
    ):
        fail("recovery capsule verifier metadata is invalid")
    authentication = exact_keys(capsule["authentication"], {"algorithm", "keyId", "tag"}, "recovery capsule authentication")
    if authentication["algorithm"] != "HMAC-SHA256" or authentication["keyId"] != current_key_id or not SHA256.fullmatch(authentication["tag"]):
        fail("recovery capsule authentication metadata is invalid")
    payload = {key: capsule[key] for key in ("checkpoint", "format", "keyring", "restoreFloor", "schemaVersion", "serverId", "verifier")}
    expected_tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_tag, authentication["tag"]):
        fail("recovery capsule authentication failed")

    for state_name, kind in (("checkpoint", "backup-generation"), ("restoreFloor", "restore-floor")):
        raw = capsule[state_name]
        if raw == UNINITIALIZED_STATE:
            continue
        if not isinstance(raw, str):
            fail("recovery capsule state is invalid")
        validate_state(raw, kind, server_id, keys)
    checkpoint = capsule["checkpoint"]
    floor = capsule["restoreFloor"]
    checkpoint_generation = 0 if checkpoint == UNINITIALIZED_STATE else json.loads(checkpoint)["state"]["generation"]
    floor_generation = 0 if floor == UNINITIALIZED_STATE else json.loads(floor)["state"]["generation"]
    if floor_generation > checkpoint_generation:
        fail("recovery capsule restore floor exceeds its generation checkpoint")
    return capsule, current_key_id, keys


def write_secure_capsule(path: Path, value: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(value) + b"\n")
            output.flush()
            os.fsync(output.fileno())
    except OSError as error:
        raise BackupAuthenticationError("could not write recovery capsule") from error


def capsule_export(arguments: argparse.Namespace) -> None:
    with migration_lock("capsule-export"):
        current_key_id, keys = load_keyring()
        keyring_raw = fetch_parameter(os.environ.get("MC_BACKUP_AUTH_KEYRING_PARAMETER", KEYRING_PARAMETER), True)
        keyring, _, _ = parse_keyring(keyring_raw)
        server_id = load_server_identity()
        checkpoint_args = argparse.Namespace(
            state_file=arguments.checkpoint_state,
            parameter=arguments.checkpoint_parameter,
            test_cloud_file_env=arguments.checkpoint_cloud_environment,
        )
        floor_args = argparse.Namespace(
            state_file=arguments.floor_state,
            parameter=arguments.floor_parameter,
            test_cloud_file_env=arguments.floor_cloud_environment,
        )
        checkpoint, checkpoint_raw, _ = state_replica(checkpoint_args, "backup-generation")
        floor, floor_raw, _ = state_replica(floor_args, "restore-floor")

        # Re-read the complete authoritative set while the migration lock is
        # still held.  The capsule is not allowed to claim a state that was
        # only observed before the final read.
        final_keyring_raw = fetch_parameter(os.environ.get("MC_BACKUP_AUTH_KEYRING_PARAMETER", KEYRING_PARAMETER), True)
        final_server_id = load_server_identity()
        final_checkpoint, final_checkpoint_raw, _ = state_replica(checkpoint_args, "backup-generation")
        final_floor, final_floor_raw, _ = state_replica(floor_args, "restore-floor")
        if final_keyring_raw != keyring_raw or final_server_id != server_id:
            fail("authoritative recovery identity changed during capsule export")
        if final_checkpoint_raw != checkpoint_raw or final_floor_raw != floor_raw:
            fail("authoritative recovery state changed during capsule export")
        if final_checkpoint is not None and final_floor is not None and final_floor["state"]["generation"] > final_checkpoint["state"]["generation"]:
            fail("authoritative restore floor exceeds checkpoint")
        payload = {
            "checkpoint": final_checkpoint_raw if final_checkpoint is not None else UNINITIALIZED_STATE,
            "format": CAPSULE_FORMAT,
            "keyring": keyring,
            "restoreFloor": final_floor_raw if final_floor is not None else UNINITIALIZED_STATE,
            "schemaVersion": CAPSULE_SCHEMA_VERSION,
            "serverId": final_server_id,
            "verifier": {
                "algorithm": "HMAC-SHA256",
                "keyIds": [item["keyId"] for item in keyring["keys"]],
                "manifestFormat": FORMAT,
                "manifestSchemaVersion": SCHEMA_VERSION,
                "stateFormat": STATE_FORMAT,
                "stateSchemaVersion": STATE_SCHEMA_VERSION,
            },
        }
        tag = hmac.new(keys[current_key_id], canonical(payload), hashlib.sha256).hexdigest()
        write_secure_capsule(Path(arguments.output), {**payload, "authentication": {"algorithm": "HMAC-SHA256", "keyId": current_key_id, "tag": tag}})


def capsule_inspect(arguments: argparse.Namespace) -> None:
    capsule, _, _ = validate_capsule(read_secure_capsule(Path(arguments.capsule)))
    checkpoint = capsule["checkpoint"]
    floor = capsule["restoreFloor"]
    checkpoint_generation = 0 if checkpoint == UNINITIALIZED_STATE else json.loads(checkpoint)["state"]["generation"]
    floor_generation = 0 if floor == UNINITIALIZED_STATE else json.loads(floor)["state"]["generation"]
    capsule_digest = hashlib.sha256(canonical(capsule)).hexdigest()
    print("\t".join((capsule["serverId"], str(checkpoint_generation), str(floor_generation), ",".join(capsule["verifier"]["keyIds"]), capsule_digest)))


def checkpoint_allocate(arguments: argparse.Namespace) -> None:
    with migration_lock("checkpoint-allocate"):
        current, _, _ = state_replica(arguments, "backup-generation")
        generation = 1 if current is None else current["state"]["generation"] + 1
        validate_generation(generation)
        document = build_state("backup-generation", generation, arguments.backup_id, arguments.updated_at)
        encoded = canonical(document).decode("ascii")
        write_parameter(arguments.parameter, encoded, arguments.test_cloud_file_env)
        # A write followed by an authoritative read is the version-aware CAS
        # confirmation.  A concurrent/bypassing writer can never be silently
        # healed into the local replica.
        if fetch_optional_parameter(arguments.parameter, arguments.test_cloud_file_env) != encoded:
            fail("backup checkpoint CAS did not commit the requested generation")
        write_atomic(Path(arguments.state_file), encoded.encode("ascii") + b"\n")
        print(generation)


def floor_read(arguments: argparse.Namespace) -> None:
    current, _, _ = state_replica(arguments, "restore-floor")
    if current is None:
        print("0\t")
    else:
        print(f"{current['state']['generation']}\t{current['state']['backupId']}")


def state_verify_parameter(arguments: argparse.Namespace) -> None:
    raw = fetch_parameter(arguments.parameter, False)
    if raw == UNINITIALIZED_STATE:
        print("0")
        return
    state = validate_state(raw, arguments.kind)
    print(state["state"]["generation"])


def floor_commit(arguments: argparse.Namespace) -> None:
    with migration_lock("floor-commit"):
        current, _, _ = state_replica(arguments, "restore-floor")
        generation = validate_generation(arguments.generation)
        if current is not None:
            floor_generation = current["state"]["generation"]
            if generation < floor_generation or (generation == floor_generation and arguments.backup_id != current["state"]["backupId"]):
                fail("restore generation would downgrade or conflict with the accepted floor")
            if generation == floor_generation:
                print(f"{generation}\t{arguments.backup_id}")
                return
        document = build_state("restore-floor", generation, arguments.backup_id, arguments.updated_at)
        encoded = canonical(document).decode("ascii")
        if operation_table_name():
            authoritative = dynamo_floor_record(arguments)
            expected_version = 0 if authoritative is None else authoritative[1]
            if arguments.transfer_id:
                commit_transfer_floor(arguments, encoded, expected_version, arguments.transfer_id)
            else:
                table = operation_table_name()
                command = [os.environ.get("MC_BACKUP_AUTH_AWS_CLI", "aws"), "dynamodb", "update-item", "--table-name", table,
                           "--key", json.dumps({"operationId": {"S": RESTORE_FLOOR_OPERATION_ID}}, separators=(",", ":")),
                           "--condition-expression", "attribute_not_exists(operationId) OR #version = :expected",
                           "--update-expression", "SET payload = :payload, #version = :next, #kind = :kind",
                           "--expression-attribute-names", json.dumps({"#version": "version", "#kind": "kind"}, separators=(",", ":")),
                           "--expression-attribute-values", json.dumps({":expected": {"N": str(expected_version)}, ":next": {"N": str(expected_version + 1)}, ":payload": {"S": encoded}, ":kind": {"S": "restore-floor"}}, separators=(",", ":"))]
                try:
                    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=30)
                except subprocess.CalledProcessError as error:
                    fail("restore floor changed concurrently; retry with fresh authoritative state")
                except (OSError, subprocess.SubprocessError) as error:
                    raise BackupAuthenticationError("could not durably commit authoritative restore floor") from error
            final = dynamo_floor_record(arguments)
            if not final or final[0] != encoded:
                fail("authoritative restore floor commit did not converge")
            write_atomic(Path(arguments.state_file), encoded.encode("ascii") + b"\n")
            print(f"{generation}\t{arguments.backup_id}")
            return
        test_file = os.environ.get(arguments.test_cloud_file_env)
        if not test_file:
            fail("authoritative restore floor table is unavailable")
        write_atomic(Path(test_file), encoded.encode("ascii") + b"\n")
        if fetch_optional_parameter(arguments.parameter, arguments.test_cloud_file_env) != encoded:
            fail("restore floor CAS did not commit the requested generation")
        write_atomic(Path(arguments.state_file), encoded.encode("ascii") + b"\n")
        print(f"{generation}\t{arguments.backup_id}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    subparsers = result.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--archive", required=True)
    create.add_argument("--manifest", required=True)
    create.add_argument("--archive-name", required=True)
    create.add_argument("--backup-name", required=True)
    create.add_argument("--backup-id", required=True)
    create.add_argument("--created-at", required=True)
    create.add_argument("--generation", required=True, type=int)
    create.add_argument("--operation-key")
    inspect = subparsers.add_parser("inspect")
    inspect.add_argument("--manifest", required=True)
    inspect.add_argument("--archive-name", required=True)
    inspect.add_argument("--output", choices=("tsv", "json"), default="tsv")
    verify = subparsers.add_parser("verify")
    verify.add_argument("--archive", required=True)
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--archive-name", required=True)
    verify.add_argument("--expected-backup-id")
    verify.add_argument("--expected-generation", type=int)
    verify.add_argument("--expected-operation-key")
    verify.add_argument("--expected-instance-id")
    verify.add_argument("--output", choices=("tsv", "json"), default="tsv")
    remote = subparsers.add_parser("list")
    remote.add_argument("--remote", required=True)
    remote.add_argument("--root", required=True)
    remote.add_argument("--config", required=True)
    remote.add_argument("--rclone", default="rclone")
    remote_verify_parser = subparsers.add_parser("remote-verify")
    remote_verify_parser.add_argument("--remote", required=True)
    remote_verify_parser.add_argument("--root", required=True)
    remote_verify_parser.add_argument("--config", required=True)
    remote_verify_parser.add_argument("--rclone", default="rclone")
    remote_verify_parser.add_argument("--archive-name", required=True)
    remote_verify_parser.add_argument("--expected-backup-id")
    remote_verify_parser.add_argument("--expected-generation", type=int)
    remote_verify_parser.add_argument("--expected-operation-key")
    remote_verify_parser.add_argument("--expected-instance-id")
    remote_verify_parser.add_argument("--output", choices=("tsv", "json"), default="tsv")
    checkpoint = subparsers.add_parser("checkpoint-allocate")
    checkpoint.add_argument("--state-file", required=True)
    checkpoint.add_argument("--parameter", default=os.environ.get("MC_BACKUP_GENERATION_PARAMETER", GENERATION_PARAMETER))
    checkpoint.add_argument("--test-cloud-file-env", default="MC_BACKUP_GENERATION_CLOUD_FILE")
    checkpoint.add_argument("--backup-id", required=True)
    checkpoint.add_argument("--updated-at", required=True)
    floor = subparsers.add_parser("floor-read")
    floor.add_argument("--state-file", required=True)
    floor.add_argument("--parameter", default=os.environ.get("MC_RESTORE_FLOOR_PARAMETER", RESTORE_FLOOR_PARAMETER))
    floor.add_argument("--test-cloud-file-env", default="MC_RESTORE_FLOOR_CLOUD_FILE")
    state_verify = subparsers.add_parser("state-verify")
    state_verify.add_argument("--parameter", required=True)
    state_verify.add_argument("--kind", choices=("backup-generation", "restore-floor"), required=True)
    floor_commit_parser = subparsers.add_parser("floor-commit")
    floor_commit_parser.add_argument("--state-file", required=True)
    floor_commit_parser.add_argument("--parameter", default=os.environ.get("MC_RESTORE_FLOOR_PARAMETER", RESTORE_FLOOR_PARAMETER))
    floor_commit_parser.add_argument("--test-cloud-file-env", default="MC_RESTORE_FLOOR_CLOUD_FILE")
    floor_commit_parser.add_argument("--generation", required=True, type=int)
    floor_commit_parser.add_argument("--backup-id", required=True)
    floor_commit_parser.add_argument("--updated-at", required=True)
    floor_commit_parser.add_argument("--transfer-id")
    capsule_export_parser = subparsers.add_parser("capsule-export")
    capsule_export_parser.add_argument("--output", required=True)
    capsule_export_parser.add_argument("--checkpoint-state", default="/var/lib/mc-aws/backup-generation.json")
    capsule_export_parser.add_argument("--floor-state", default="/var/lib/mc-aws/restore-generation-floor.json")
    capsule_export_parser.add_argument("--checkpoint-parameter", default=GENERATION_PARAMETER)
    capsule_export_parser.add_argument("--floor-parameter", default=RESTORE_FLOOR_PARAMETER)
    capsule_export_parser.add_argument("--checkpoint-cloud-environment", default="MC_BACKUP_GENERATION_CLOUD_FILE")
    capsule_export_parser.add_argument("--floor-cloud-environment", default="MC_RESTORE_FLOOR_CLOUD_FILE")
    capsule_inspect_parser = subparsers.add_parser("capsule-inspect")
    capsule_inspect_parser.add_argument("--capsule", required=True)
    transfer_create_parser = subparsers.add_parser("transfer-create")
    transfer_create_parser.add_argument("--operation-id", required=True)
    transfer_create_parser.add_argument("--archive-name", required=True)
    transfer_create_parser.add_argument("--backup-id", required=True)
    transfer_create_parser.add_argument("--generation", required=True, type=int)
    transfer_create_parser.add_argument("--floor-generation", required=True, type=int)
    transfer_create_parser.add_argument("--floor-backup-id", required=True)
    transfer_create_parser.add_argument("--lock-id", required=True)
    transfer_create_parser.add_argument("--fencing-token", required=True, type=int)
    transfer_create_parser.add_argument("--lease-generation", required=True, type=int)
    transfer_create_parser.add_argument("--issued-at", required=True)
    transfer_create_parser.add_argument("--expires-at", required=True)
    transfer_renew_parser = subparsers.add_parser("transfer-renew")
    transfer_renew_parser.add_argument("--offer-file", "--offer", dest="offer_file")
    transfer_renew_parser.add_argument("--offer-json")
    transfer_renew_parser.add_argument("--authorization-parameter")
    transfer_renew_parser.add_argument("--operation-id", required=True)
    transfer_renew_parser.add_argument("--archive-name", required=True)
    transfer_renew_parser.add_argument("--backup-id", required=True)
    transfer_renew_parser.add_argument("--generation", required=True, type=int)
    transfer_renew_parser.add_argument("--floor-generation", required=True, type=int)
    transfer_renew_parser.add_argument("--floor-backup-id", required=True)
    transfer_renew_parser.add_argument("--lock-id", required=True)
    transfer_renew_parser.add_argument("--fencing-token", required=True, type=int)
    transfer_renew_parser.add_argument("--lease-generation", required=True, type=int)
    transfer_renew_parser.add_argument("--issued-at", required=True)
    transfer_renew_parser.add_argument("--expires-at", required=True)
    transfer_consume_parser = subparsers.add_parser("transfer-consume")
    transfer_consume_parser.add_argument("--expected-operation-id", required=True)
    transfer_consume_parser.add_argument("--archive-name", required=True)
    transfer_consume_parser.add_argument("--expected-backup-id", required=True)
    transfer_consume_parser.add_argument("--expected-generation", required=True, type=int)
    transfer_consume_parser.add_argument("--expected-source-instance-id", required=True)
    transfer_consume_parser.add_argument("--expected-lock-id", required=True)
    transfer_consume_parser.add_argument("--expected-fencing-token", required=True, type=int)
    transfer_consume_parser.add_argument("--expected-lease-generation", required=True, type=int)
    transfer_consume_parser.add_argument("--floor-state", required=True)
    transfer_consume_parser.add_argument("--floor-parameter", default=RESTORE_FLOOR_PARAMETER)
    transfer_consume_parser.add_argument("--floor-cloud-environment", default="MC_RESTORE_FLOOR_CLOUD_FILE")
    return result


def main() -> int:
    try:
        arguments = parser().parse_args()
        if arguments.command == "create":
            create_manifest(arguments)
        elif arguments.command == "inspect":
            inspect_manifest(arguments)
        elif arguments.command == "verify":
            verify_manifest(arguments)
        elif arguments.command == "list":
            remote_list(arguments)
        elif arguments.command == "remote-verify":
            remote_verify(arguments)
        elif arguments.command == "checkpoint-allocate":
            checkpoint_allocate(arguments)
        elif arguments.command == "floor-read":
            floor_read(arguments)
        elif arguments.command == "capsule-export":
            capsule_export(arguments)
        elif arguments.command == "capsule-inspect":
            capsule_inspect(arguments)
        elif arguments.command == "state-verify":
            state_verify_parameter(arguments)
        elif arguments.command == "transfer-create":
            transfer_create(arguments)
        elif arguments.command == "transfer-renew":
            sources = sum(bool(value) for value in (arguments.offer_file, arguments.offer_json, arguments.authorization_parameter))
            if sources != 1:
                fail("transfer renewal requires exactly one of --offer-file, --offer-json, or --authorization-parameter")
            transfer_renew(arguments)
        elif arguments.command == "transfer-consume":
            transfer_consume(arguments)
        else:
            floor_commit(arguments)
        return 0
    except BackupAuthenticationError as error:
        print(f"Backup authentication failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
