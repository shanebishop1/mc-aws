#!/usr/bin/env python3
"""A deliberately separate, disposable EC2 qualification lifecycle.

This module is intentionally not used by the production deployment or teardown
paths.  It is a small AWS CLI wrapper for one approved AL2023 ARM64 runner.
All AWS subprocesses use argv (never a shell), and their output is parsed or
discarded; credentials are never copied to the local ownership record or log.

Typical use (the wrapper prints the exact confirmation strings):

    python3 scripts/aws/disposable_qualification.py prepare --ssh-cidr A.B.C.D/32
    python3 scripts/aws/disposable_qualification.py launch --run-id RUN_ID --confirm '...'
    python3 scripts/aws/disposable_qualification.py status --run-id RUN_ID
    python3 scripts/aws/disposable_qualification.py terminate --run-id RUN_ID --confirm '...'
    python3 scripts/aws/disposable_qualification.py cleanup --run-id RUN_ID --confirm '...'

``prepare`` performs only read-only AWS checks and writes a local record.  The
temporary security group, key pair, Scheduler group, and IAM role are created
by ``launch`` immediately before ``run-instances``.  The role has no policy
until the exact instance exists.  A failed schedule creation is fail-closed:
the exact, tag-verified instance is terminated and the operator is directed to
``cleanup``.

There is necessarily a small launch-before-schedule crash window: Scheduler
cannot target an instance ARN that does not yet exist.  The guest's absolute
deadline shutdown is the independent fallback, while the durable client token
record permits immediate reconciliation.  If reconciliation itself is
unavailable, the wrapper reports a residual instead of claiming zero resources.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote


ACCOUNT_ID = "096541555712"
REGION = "us-west-1"
PROFILE = "default"
EXPECTED_CALLER_ARN = f"arn:aws:iam::{ACCOUNT_ID}:user/shane"
AMI_ID = "ami-0ab418c4e47896df2"
AMI_OWNER_ID = "137112412989"
AMI_VERSION = "2023.12.20260831.0"
INSTANCE_TYPE = "t4g.medium"
VOLUME_SIZE_GIB = 8
DEADLINE_SECONDS = 30 * 60
OWNER_TAG = "mc-aws-disposable-qualification"
QUALIFICATION_TAG_KEY = "McAwsDisposableQualification"
RUN_TAG_KEY = "McAwsRunId"
APPROVAL_TAG_KEY = "McAwsApprovalDigest"
AWS_CLI_DEFAULT = "/tmp/opencode/aws-cli-arm64-prep/bin/aws"
DEFAULT_STATE_DIR = ".local-artifacts/disposable-qualification"
RUN_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ARN_RE = re.compile(r"^arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:.+$")


class QualificationError(RuntimeError):
    """An operator-actionable, deliberately redacted failure."""


class AwsFailure(QualificationError):
    def __init__(
        self,
        operation: str,
        reason: str = "AWS CLI request failed",
        *,
        not_found: bool = False,
        retryable: bool = False,
        aws_code: str | None = None,
    ) -> None:
        safe_reason = f"AWS error code {aws_code}" if aws_code else reason
        super().__init__(f"{operation}: {safe_reason}")
        self.operation = operation
        self.not_found = not_found
        self.retryable = retryable
        self.aws_code = aws_code


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _run_id() -> str:
    return str(uuid.uuid4())


def _hex_id(run_id: str) -> str:
    return run_id.replace("-", "")[:20]


def _validate_run_id(run_id: str) -> None:
    if not RUN_ID_RE.fullmatch(run_id):
        raise QualificationError("run id is not a UUIDv4")


def _validate_cidr(value: str) -> str:
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise QualificationError("SSH source must be one explicit IPv4 /32") from error
    if network.version != 4 or network.prefixlen != 32:
        raise QualificationError("SSH source must be one explicit IPv4 /32")
    return str(network)


def _schedule_expression(deadline: int) -> str:
    return f"at({dt.datetime.fromtimestamp(deadline, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')})"


def _approval(run_id: str, ssh_cidr: str) -> str:
    return (
        f"LAUNCH MC-AWS DISPOSABLE QUALIFICATION RUN_ID={run_id} "
        f"ACCOUNT={ACCOUNT_ID} REGION={REGION} AMI={AMI_ID} INSTANCE={INSTANCE_TYPE} "
        f"ROOT={VOLUME_SIZE_GIB}GiB-gp3-encrypted-delete-on-termination "
        f"SSH={ssh_cidr} NO-MC-INGRESS NO-INSTANCE-PROFILE NO-PRODUCTION-SECRETS"
    )


def _terminate_approval(run_id: str) -> str:
    return f"TERMINATE MC-AWS DISPOSABLE QUALIFICATION RUN_ID={run_id} ACCOUNT={ACCOUNT_ID} REGION={REGION}"


def _cleanup_approval(run_id: str) -> str:
    return f"CLEANUP MC-AWS DISPOSABLE QUALIFICATION RUN_ID={run_id} ACCOUNT={ACCOUNT_ID} REGION={REGION}"


def _approval_digest(approval: str) -> str:
    return hashlib.sha256(approval.encode("ascii")).hexdigest()


def _tags(state: dict[str, Any]) -> dict[str, str]:
    return {
        QUALIFICATION_TAG_KEY: "true",
        RUN_TAG_KEY: state["runId"],
        APPROVAL_TAG_KEY: state["approvalDigest"],
        "McAwsOwner": OWNER_TAG,
    }


def _tag_list(state: dict[str, Any]) -> list[dict[str, str]]:
    return [{"Key": key, "Value": value} for key, value in sorted(_tags(state).items())]


def _tag_map(value: Any) -> dict[str, str]:
    if not isinstance(value, list):
        return {}
    return {
        item.get("Key"): item.get("Value")
        for item in value
        if isinstance(item, dict) and isinstance(item.get("Key"), str) and isinstance(item.get("Value"), str)
    }


def _assert_tags(actual: Any, state: dict[str, Any], resource: str) -> None:
    expected = _tags(state)
    got = _tag_map(actual)
    if any(got.get(key) != value for key, value in expected.items()):
        raise QualificationError(f"{resource} does not carry the exact disposable ownership tags")


def _ensure_private_directory(path: Path) -> None:
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir():
            raise QualificationError(f"state directory is not a directory: {path}")
    else:
        path.mkdir(parents=True, mode=0o700)
    os.chmod(path, 0o700)
    metadata = path.stat()
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise QualificationError("state directory ownership or mode is unsafe")


def _state_path(state_dir: Path, run_id: str) -> Path:
    _validate_run_id(run_id)
    return state_dir / f"{run_id}.json"


def _write_state(state_dir: Path, state: dict[str, Any]) -> None:
    _ensure_private_directory(state_dir)
    destination = _state_path(state_dir, state["runId"])
    if destination.is_symlink():
        raise QualificationError("state file is a symlink")
    state = dict(state)
    state["updatedAt"] = _utc_now()
    fd, temporary = __import__("tempfile").mkstemp(prefix=".ownership.", suffix=".json", dir=state_dir)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as output:
            json.dump(state, output, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        directory_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _load_state(state_dir: Path, run_id: str) -> dict[str, Any]:
    _ensure_private_directory(state_dir)
    path = _state_path(state_dir, run_id)
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise QualificationError("ownership record metadata is unsafe")
        with path.open("r", encoding="ascii") as source:
            state = json.load(source)
    except FileNotFoundError as error:
        raise QualificationError(f"no ownership record for run {run_id}") from error
    except (OSError, ValueError, UnicodeError) as error:
        raise QualificationError("ownership record is unreadable or malformed") from error
    if not isinstance(state, dict) or state.get("schemaVersion") != 1 or state.get("runId") != run_id:
        raise QualificationError("ownership record schema or run identity is invalid")
    _validate_run_state(state)
    return state


def _validate_resource_name(value: Any, prefix: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(rf"{re.escape(prefix)}-[0-9a-f]{{20}}", value):
        raise QualificationError("ownership record resource name is invalid")


def _validate_run_state(state: dict[str, Any]) -> None:
    _validate_run_id(state.get("runId", ""))
    if state.get("account") != ACCOUNT_ID or state.get("region") != REGION or state.get("profile") != PROFILE:
        raise QualificationError("ownership record target identity does not match the approved target")
    if state.get("amiId") != AMI_ID or state.get("instanceType") != INSTANCE_TYPE:
        raise QualificationError("ownership record image or instance type changed")
    if state.get("volumeSizeGiB") != VOLUME_SIZE_GIB or state.get("volumeEncrypted") is not True:
        raise QualificationError("ownership record root volume policy changed")
    if state.get("instanceInitiatedShutdownBehavior") != "terminate" or state.get("cpuCredits") != "unlimited":
        raise QualificationError("ownership record lifecycle or CPU credit policy changed")
    approval = _approval(state["runId"], state["sshCidr"])
    if state.get("approvalDigest") != _approval_digest(approval):
        raise QualificationError("ownership record approval binding changed")
    if _validate_cidr(state.get("sshCidr", "")) != state["sshCidr"]:
        raise QualificationError("ownership record SSH source is invalid")
    if not isinstance(state.get("clientToken"), str) or not re.fullmatch(r"[0-9a-f]{64}", state["clientToken"]):
        raise QualificationError("ownership record client token is invalid")
    if not isinstance(state.get("scheduleClientToken"), str) or not re.fullmatch(r"[0-9a-f]{64}", state["scheduleClientToken"]):
        raise QualificationError("ownership record scheduler client token is invalid")
    for field, prefix in (
        ("securityGroupName", "mcaws-dq-sg"),
        ("keyName", "mcaws-dq-key"),
        ("schedulerGroupName", "mcaws-dq-group"),
        ("roleName", "mcaws-dq-role"),
        ("scheduleName", "mcaws-dq-terminate"),
    ):
        _validate_resource_name(state.get(field), prefix)
    if state.get("roleArn") is not None and not ARN_RE.fullmatch(state["roleArn"]):
        raise QualificationError("ownership record role ARN is invalid")
    if state.get("schedulerGroupArn") is not None and not ARN_RE.fullmatch(state["schedulerGroupArn"]):
        raise QualificationError("ownership record scheduler group ARN is invalid")
    if state.get("instanceId") is not None and not re.fullmatch(r"i-[0-9a-f]{8,17}", state["instanceId"]):
        raise QualificationError("ownership record instance ID is invalid")
    failure = state.get("lastFailure")
    if failure is not None:
        if (
            not isinstance(failure, dict)
            or set(failure) != {"operation", "awsCode"}
            or not isinstance(failure["operation"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .:_-]{0,95}", failure["operation"])
            or not isinstance(failure["awsCode"], str)
            or not re.fullmatch(r"(?:[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}|unavailable)", failure["awsCode"])
        ):
            raise QualificationError("ownership record failure detail is invalid")
    key_path = state.get("keyPath")
    expected_key_path = str(Path.home() / ".mc-aws-disposable" / f"mc-aws-disposable-{state['runId']}")
    if key_path not in (expected_key_path, "removed"):
        raise QualificationError("ownership record workstation key path is invalid")


class Aws:
    def __init__(self, executable: str) -> None:
        self.executable = executable
        if not os.path.isfile(executable) or not os.access(executable, os.X_OK):
            raise QualificationError(f"AWS CLI is not an executable file: {executable}")

    def call(self, operation: str, service: str, action: str, *arguments: str) -> dict[str, Any]:
        command = [self.executable, "--cli-binary-format", "raw-in-base64-out", "--profile", PROFILE, "--region", REGION, service, action, *arguments, "--output", "json"]
        environment = os.environ.copy()
        environment.update({"AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"})
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=45, env=environment)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AwsFailure(operation) from error
        if result.returncode != 0:
            # Do not expose AWS CLI stderr: it can contain credential-provider or
            # request details.  The operation label is a fixed local string.
            not_found_markers = ("NotFound", "not found", "NoSuchEntity", "InvalidInstanceID")
            retry_markers = ("ValidationException", "not found", "NoSuchEntity", "cannot assume", "not yet propagated")
            code_match = re.search(r"An error occurred \(([A-Za-z0-9][A-Za-z0-9_.:-]{0,95})\)", result.stderr)
            raise AwsFailure(
                operation,
                not_found=any(marker in result.stderr for marker in not_found_markers),
                retryable=any(marker.lower() in result.stderr.lower() for marker in retry_markers),
                aws_code=code_match.group(1) if code_match else None,
            )
        try:
            parsed = json.loads(result.stdout or "{}")
        except (ValueError, TypeError) as error:
            raise AwsFailure(operation, "returned invalid JSON") from error
        if not isinstance(parsed, dict):
            raise AwsFailure(operation, "returned a non-object JSON value")
        return parsed


def _find_instances(response: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for reservation in response.get("Reservations", []):
        if isinstance(reservation, dict):
            result.extend(item for item in reservation.get("Instances", []) if isinstance(item, dict))
    return result


def _instance(state: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    instances = [item for item in _find_instances(response) if item.get("InstanceId") == state.get("instanceId")]
    if len(instances) != 1:
        raise QualificationError("exact owned instance was not returned by EC2")
    item = instances[0]
    _assert_tags(item.get("Tags"), state, "instance")
    if (
        item.get("ImageId") != AMI_ID
        or item.get("InstanceType") != INSTANCE_TYPE
        or item.get("SubnetId") != state.get("subnetId")
        or item.get("KeyName") != state.get("keyName")
        or item.get("IamInstanceProfile") is not None
    ):
        raise QualificationError("instance configuration is not the exact disposable proposal")
    groups = item.get("SecurityGroups", [])
    if len(groups) != 1 or groups[0].get("GroupId") != state.get("securityGroupId"):
        raise QualificationError("instance security group is not the exact disposable group")
    roots = [mapping for mapping in item.get("BlockDeviceMappings", []) if mapping.get("DeviceName") in ("/dev/xvda", "/dev/sda1")]
    if len(roots) != 1 or roots[0].get("Ebs", {}).get("DeleteOnTermination") is not True:
        raise QualificationError("root volume is not configured for encrypted delete-on-termination")
    return item


def _verify_instance(aws: Aws, state: dict[str, Any]) -> dict[str, Any]:
    if not state.get("instanceId"):
        raise QualificationError("the run has no recorded instance")
    response = aws.call("describe exact instance", "ec2", "describe-instances", "--instance-ids", state["instanceId"])
    item = _instance(state, response)
    credit = aws.call(
        "describe exact CPU credit policy", "ec2", "describe-instance-credit-specifications", "--instance-ids", state["instanceId"]
    )
    specifications = credit.get("InstanceCreditSpecifications", [])
    if len(specifications) != 1 or specifications[0].get("InstanceId") != state["instanceId"] or specifications[0].get("CpuCredits") != "unlimited":
        raise QualificationError("instance CPU credit policy is not unlimited")
    behavior = aws.call(
        "describe shutdown behavior", "ec2", "describe-instance-attribute", "--instance-id", state["instanceId"], "--attribute", "instanceInitiatedShutdownBehavior"
    )
    if behavior.get("InstanceInitiatedShutdownBehavior", {}).get("Value") != "terminate":
        raise QualificationError("instance shutdown behavior is not terminate")
    root_volume_id = next(
        (mapping.get("Ebs", {}).get("VolumeId") for mapping in item.get("BlockDeviceMappings", []) if mapping.get("DeviceName") in ("/dev/xvda", "/dev/sda1")),
        None,
    )
    if not isinstance(root_volume_id, str):
        raise QualificationError("exact instance has no identifiable root volume")
    volume_response = aws.call("verify exact root volume", "ec2", "describe-volumes", "--volume-ids", root_volume_id)
    volumes = volume_response.get("Volumes", [])
    if len(volumes) != 1:
        raise QualificationError("exact root volume was not uniquely returned")
    volume = volumes[0]
    _assert_tags(volume.get("Tags"), state, "root volume")
    if volume.get("Size") != VOLUME_SIZE_GIB or volume.get("VolumeType") != "gp3" or volume.get("Encrypted") is not True:
        raise QualificationError("root volume is not the exact encrypted 8 GiB gp3 proposal")
    return item


def _verify_caller(aws: Aws) -> None:
    identity = aws.call("verify caller identity", "sts", "get-caller-identity")
    if identity.get("Account") != ACCOUNT_ID or identity.get("Arn") != EXPECTED_CALLER_ARN:
        raise QualificationError("STS identity is not the approved account user/shane")


def _image_and_network_preflight(aws: Aws) -> tuple[str, str]:
    _verify_caller(aws)
    image = aws.call("verify approved AMI", "ec2", "describe-images", "--owners", AMI_OWNER_ID, "--image-ids", AMI_ID)
    images = image.get("Images", [])
    if len(images) != 1:
        raise QualificationError("approved AMI was not uniquely returned")
    candidate = images[0]
    name = str(candidate.get("Name", ""))
    if (
        candidate.get("ImageId") != AMI_ID
        or candidate.get("OwnerId") != AMI_OWNER_ID
        or candidate.get("Architecture") != "arm64"
        or candidate.get("RootDeviceType") != "ebs"
        or candidate.get("VirtualizationType") != "hvm"
        or AMI_VERSION not in name
        or "kernel-6.1" not in name
    ):
        raise QualificationError("returned AMI does not match AL2023 version, ARM64, and kernel 6.1")
    vpcs = aws.call(
        "find default VPC", "ec2", "describe-vpcs", "--filters", _json([{"Name": "isDefault", "Values": ["true"]}, {"Name": "state", "Values": ["available"]}])
    ).get("Vpcs", [])
    if len(vpcs) != 1 or not isinstance(vpcs[0].get("VpcId"), str):
        raise QualificationError("default VPC was not uniquely returned")
    vpc_id = vpcs[0]["VpcId"]
    subnets = aws.call(
        "find default subnet", "ec2", "describe-subnets", "--filters", _json([{"Name": "vpc-id", "Values": [vpc_id]}, {"Name": "default-for-az", "Values": ["true"]}, {"Name": "state", "Values": ["available"]}])
    ).get("Subnets", [])
    candidates = sorted(
        (subnet for subnet in subnets if isinstance(subnet, dict) and isinstance(subnet.get("SubnetId"), str)),
        key=lambda subnet: subnet["SubnetId"],
    )
    if not candidates:
        raise QualificationError("no available default subnet was returned")
    subnet = candidates[0]
    if subnet.get("VpcId") != vpc_id or subnet.get("MapPublicIpOnLaunch") is not True:
        raise QualificationError("selected default subnet is not a public launch subnet")
    return vpc_id, subnet["SubnetId"]


def _verify_security_group(aws: Aws, state: dict[str, Any]) -> None:
    response = aws.call("verify exact security group", "ec2", "describe-security-groups", "--group-ids", state["securityGroupId"])
    groups = response.get("SecurityGroups", [])
    if len(groups) != 1:
        raise QualificationError("exact disposable security group was not returned")
    group = groups[0]
    _assert_tags(group.get("Tags"), state, "security group")
    if group.get("IpPermissionsEgress") != []:
        raise QualificationError("security group has unexpected egress; disposable runner must have no egress")
    permissions = group.get("IpPermissions", [])
    if len(permissions) != 1:
        raise QualificationError("security group has unexpected ingress; MC ingress is forbidden")
    permission = permissions[0]
    ranges = permission.get("IpRanges", [])
    if (
        permission.get("IpProtocol") != "tcp"
        or permission.get("FromPort") != 22
        or permission.get("ToPort") != 22
        or len(ranges) != 1
        or ranges[0].get("CidrIp") != state["sshCidr"]
        or permission.get("UserIdGroupPairs")
        or permission.get("Ipv6Ranges")
        or permission.get("PrefixListIds")
    ):
        raise QualificationError("security group ingress is not the exact workstation /32 SSH rule")


def _remove_security_group_egress(aws: Aws, state: dict[str, Any]) -> None:
    response = aws.call("read disposable security group egress", "ec2", "describe-security-groups", "--group-ids", state["securityGroupId"])
    groups = response.get("SecurityGroups", [])
    if len(groups) != 1:
        raise QualificationError("exact disposable security group was not returned")
    group = groups[0]
    _assert_tags(group.get("Tags"), state, "security group")
    if group.get("VpcId") != state["vpcId"]:
        raise QualificationError("security group VPC changed")
    for permission in group.get("IpPermissionsEgress", []):
        aws.call(
            "remove disposable security group egress",
            "ec2",
            "revoke-security-group-egress",
            "--group-id",
            state["securityGroupId"],
            "--ip-permissions",
            _json([permission]),
        )
    after = aws.call("verify no disposable security group egress", "ec2", "describe-security-groups", "--group-ids", state["securityGroupId"])
    remaining = after.get("SecurityGroups", [])
    if len(remaining) != 1 or remaining[0].get("IpPermissionsEgress") != []:
        raise QualificationError("could not remove all disposable security group egress")


def _has_exact_ssh_ingress(group: dict[str, Any], state: dict[str, Any]) -> bool:
    permissions = group.get("IpPermissions", [])
    if len(permissions) != 1:
        return False
    permission = permissions[0]
    ranges = permission.get("IpRanges", [])
    return (
        permission.get("IpProtocol") == "tcp"
        and permission.get("FromPort") == 22
        and permission.get("ToPort") == 22
        and len(ranges) == 1
        and ranges[0].get("CidrIp") == state["sshCidr"]
        and not permission.get("UserIdGroupPairs")
        and not permission.get("Ipv6Ranges")
        and not permission.get("PrefixListIds")
    )


def _generate_ssh_key(run_id: str) -> tuple[str, str]:
    # Keep the private key outside the JSON ownership records and in a
    # dedicated directory whose permissions this wrapper owns.
    ssh_dir = Path.home() / ".mc-aws-disposable"
    _ensure_private_directory(ssh_dir)
    key_path = ssh_dir / f"mc-aws-disposable-{run_id}"
    if key_path.exists() or key_path.is_symlink():
        raise QualificationError("refusing to overwrite an existing temporary SSH key")
    try:
        created = subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise QualificationError("ssh-keygen could not create the workstation key") from error
    if created.returncode != 0 or not key_path.is_file():
        raise QualificationError("ssh-keygen could not create the workstation key")
    os.chmod(key_path, 0o600)
    try:
        public = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(key_path)], capture_output=True, text=True, check=False, timeout=15
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise QualificationError("ssh-keygen could not derive the public key") from error
    if public.returncode != 0 or not public.stdout.startswith("ssh-ed25519 "):
        raise QualificationError("generated workstation key has an unexpected public format")
    return str(key_path), public.stdout.strip()


def _lock(state_dir: Path):
    _ensure_private_directory(state_dir)
    lock_path = state_dir / ".lifecycle.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.fchmod(descriptor, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def _base_state(run_id: str, ssh_cidr: str, vpc_id: str, subnet_id: str, key_path: str) -> dict[str, Any]:
    approval = _approval(run_id, ssh_cidr)
    return {
        "schemaVersion": 1,
        "phase": "prepared",
        "runId": run_id,
        "account": ACCOUNT_ID,
        "region": REGION,
        "profile": PROFILE,
        "amiId": AMI_ID,
        "amiOwnerId": AMI_OWNER_ID,
        "instanceType": INSTANCE_TYPE,
        "volumeSizeGiB": VOLUME_SIZE_GIB,
        "volumeType": "gp3",
        "volumeEncrypted": True,
        "deleteRootOnTermination": True,
        "instanceInitiatedShutdownBehavior": "terminate",
        "cpuCredits": "unlimited",
        "sshCidr": ssh_cidr,
        "vpcId": vpc_id,
        "subnetId": subnet_id,
        "approvalDigest": _approval_digest(approval),
        "clientToken": secrets.token_hex(32),
        "scheduleClientToken": secrets.token_hex(32),
        "keyPath": key_path,
        "securityGroupName": f"mcaws-dq-sg-{_hex_id(run_id)}",
        "keyName": f"mcaws-dq-key-{_hex_id(run_id)}",
        "schedulerGroupName": f"mcaws-dq-group-{_hex_id(run_id)}",
        "roleName": f"mcaws-dq-role-{_hex_id(run_id)}",
        "scheduleName": f"mcaws-dq-terminate-{_hex_id(run_id)}",
        "createdAt": _utc_now(),
    }


def prepare(args: argparse.Namespace, aws: Aws, state_dir: Path) -> None:
    ssh_cidr = _validate_cidr(args.ssh_cidr)
    vpc_id, subnet_id = _image_and_network_preflight(aws)
    run_id = _run_id()
    key_path, _public_key = _generate_ssh_key(run_id)
    state = _base_state(run_id, ssh_cidr, vpc_id, subnet_id, key_path)
    _write_state(state_dir, state)
    print(f"RunId: {run_id}")
    print(f"Ownership record: {_state_path(state_dir, run_id)}")
    print(f"Approval: {_approval(run_id, ssh_cidr)}")
    print(f"Terminate approval: {_terminate_approval(run_id)}")
    print(f"Cleanup approval: {_cleanup_approval(run_id)}")


def _lookup(operation: str, aws: Aws, service: str, action: str, *arguments: str) -> dict[str, Any] | None:
    try:
        return aws.call(operation, service, action, *arguments)
    except AwsFailure as error:
        if error.not_found:
            return None
        raise


def _retry_aws(aws: Aws, operation: str, service: str, action: str, *arguments: str) -> dict[str, Any]:
    """Bound retries for IAM/Scheduler eventual consistency only."""
    for attempt in range(5):
        try:
            return aws.call(operation, service, action, *arguments)
        except AwsFailure as error:
            if not error.retryable or attempt == 4:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def _failure_detail(error: Exception) -> dict[str, str]:
    if isinstance(error, AwsFailure):
        return {"operation": error.operation, "awsCode": error.aws_code or "unavailable"}
    return {"operation": "local-wrapper", "awsCode": "unavailable"}


def _ensure_security_group(aws: Aws, state: dict[str, Any]) -> None:
    response = _lookup("find exact security group", aws, "ec2", "describe-security-groups", "--group-ids", state.get("securityGroupId", "")) if state.get("securityGroupId") else None
    if not response:
        response = _lookup("find exact security group by name", aws, "ec2", "describe-security-groups", "--filters", _json([{"Name": "group-name", "Values": [state["securityGroupName"]]}]))
    if response and response.get("SecurityGroups"):
        group = response["SecurityGroups"][0]
        if len(response["SecurityGroups"]) != 1 or group.get("GroupId") != state.get("securityGroupId", group.get("GroupId")):
            raise QualificationError("security group name does not identify one exact resource")
        state["securityGroupId"] = group["GroupId"]
        _assert_tags(group.get("Tags"), state, "security group")
        if not _has_exact_ssh_ingress(group, state) and group.get("IpPermissions"):
            raise QualificationError("security group has unexpected ingress; MC ingress is forbidden")
        _remove_security_group_egress(aws, state)
        if not _has_exact_ssh_ingress(group, state):
            aws.call(
                "authorize workstation SSH only",
                "ec2",
                "authorize-security-group-ingress",
                "--group-id",
                state["securityGroupId"],
                "--ip-permissions",
                _json([{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": state["sshCidr"], "Description": "temporary workstation SSH"}]}]),
            )
        _verify_security_group(aws, state)
        return
    try:
        response = aws.call(
            "create disposable security group",
            "ec2",
            "create-security-group",
            "--group-name",
            state["securityGroupName"],
            "--description",
            "mc-aws disposable qualification SSH only",
            "--vpc-id",
            state["vpcId"],
            "--tag-specifications",
            _json([{"ResourceType": "security-group", "Tags": _tag_list(state)}]),
        )
    except AwsFailure:
        response = _lookup("recover disposable security group", aws, "ec2", "describe-security-groups", "--filters", _json([{"Name": "group-name", "Values": [state["securityGroupName"]]}]))
        if not response or len(response.get("SecurityGroups", [])) != 1:
            raise
        group = response["SecurityGroups"][0]
        _assert_tags(group.get("Tags"), state, "security group")
        state["securityGroupId"] = group["GroupId"]
        _write_state(CURRENT_STATE_DIR, state)
        if not _has_exact_ssh_ingress(group, state) and group.get("IpPermissions"):
            raise QualificationError("security group has unexpected ingress; MC ingress is forbidden")
        _remove_security_group_egress(aws, state)
        if not _has_exact_ssh_ingress(group, state):
            aws.call(
                "authorize workstation SSH only",
                "ec2",
                "authorize-security-group-ingress",
                "--group-id",
                state["securityGroupId"],
                "--ip-permissions",
                _json([{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": state["sshCidr"], "Description": "temporary workstation SSH"}]}]),
            )
        _verify_security_group(aws, state)
        return
    state["securityGroupId"] = response.get("GroupId")
    if not isinstance(state["securityGroupId"], str):
        raise QualificationError("security group creation returned no ID")
    _write_state(CURRENT_STATE_DIR, state)
    _remove_security_group_egress(aws, state)
    aws.call(
        "authorize workstation SSH only",
        "ec2",
        "authorize-security-group-ingress",
        "--group-id",
        state["securityGroupId"],
        "--ip-permissions",
        _json([{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": state["sshCidr"], "Description": "temporary workstation SSH"}]}]),
    )
    _verify_security_group(aws, state)


def _ensure_key_pair(aws: Aws, state: dict[str, Any]) -> None:
    response = _lookup("find exact key pair", aws, "ec2", "describe-key-pairs", "--key-names", state["keyName"])
    if response and response.get("KeyPairs"):
        _assert_tags(response["KeyPairs"][0].get("Tags"), state, "key pair")
        return
    key_path = Path(state["keyPath"])
    if key_path.is_symlink() or not key_path.is_file() or stat.S_IMODE(key_path.stat().st_mode) != 0o600:
        raise QualificationError("temporary workstation private key is missing or unsafe")
    public = subprocess.run(["ssh-keygen", "-y", "-f", str(key_path)], capture_output=True, text=True, check=False, timeout=15)
    if public.returncode != 0 or not public.stdout.startswith("ssh-ed25519 "):
        raise QualificationError("temporary workstation private key is invalid")
    try:
        response = aws.call(
            "import disposable key pair",
            "ec2",
            "import-key-pair",
            "--key-name",
            state["keyName"],
            "--public-key-material",
            public.stdout.strip(),
            "--tag-specifications",
            _json([{"ResourceType": "key-pair", "Tags": _tag_list(state)}]),
        )
    except AwsFailure:
        response = _lookup("recover disposable key pair", aws, "ec2", "describe-key-pairs", "--key-names", state["keyName"])
        if not response or len(response.get("KeyPairs", [])) != 1:
            raise
        _assert_tags(response["KeyPairs"][0].get("Tags"), state, "key pair")
        return
    if response.get("KeyName") not in (None, state["keyName"]):
        raise QualificationError("key pair creation returned a different name")
    _write_state(CURRENT_STATE_DIR, state)


def _ensure_scheduler_group(aws: Aws, state: dict[str, Any]) -> None:
    expected_arn = f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule-group/{state['schedulerGroupName']}"
    response = _lookup("find exact scheduler group", aws, "scheduler", "get-schedule-group", "--name", state["schedulerGroupName"])
    if response and response.get("Arn"):
        if response["Arn"] != expected_arn:
            raise QualificationError("scheduler group ARN changed")
        tags = aws.call("read scheduler group ownership tags", "scheduler", "list-tags-for-resource", "--resource-arn", expected_arn).get("Tags")
        _assert_tags(tags, state, "scheduler group")
        state["schedulerGroupArn"] = expected_arn
        _write_state(CURRENT_STATE_DIR, state)
        return
    try:
        response = aws.call(
            "create disposable scheduler group",
            "scheduler",
            "create-schedule-group",
            "--name",
            state["schedulerGroupName"],
            "--tags",
            _json(_tag_list(state)),
        )
    except AwsFailure:
        response = _lookup("recover disposable scheduler group", aws, "scheduler", "get-schedule-group", "--name", state["schedulerGroupName"])
        if not response or response.get("Arn") != expected_arn:
            raise
        tags = aws.call("verify recovered scheduler group tags", "scheduler", "list-tags-for-resource", "--resource-arn", expected_arn).get("Tags")
        _assert_tags(tags, state, "scheduler group")
        state["schedulerGroupArn"] = expected_arn
        _write_state(CURRENT_STATE_DIR, state)
        return
    if response.get("ScheduleGroupArn") not in (None, expected_arn):
        raise QualificationError("scheduler group creation returned a different ARN")
    state["schedulerGroupArn"] = expected_arn
    tags = aws.call("verify scheduler group ownership tags", "scheduler", "list-tags-for-resource", "--resource-arn", expected_arn).get("Tags")
    _assert_tags(tags, state, "scheduler group")
    _write_state(CURRENT_STATE_DIR, state)


def _trust_policy(state: dict[str, Any]) -> dict[str, Any]:
    # AWS Scheduler's documented SourceArn for this trust condition is the
    # schedule-group ARN, not an individual schedule ARN.
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "scheduler.amazonaws.com"},
                "Action": "sts:AssumeRole",
                "Condition": {"StringEquals": {"aws:SourceAccount": ACCOUNT_ID, "aws:SourceArn": state["schedulerGroupArn"]}},
            }
        ],
    }


def _decoded_document(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise QualificationError("IAM returned no policy document")
    try:
        document = json.loads(unquote(value))
    except (ValueError, TypeError) as error:
        raise QualificationError("IAM policy document is malformed") from error
    if not isinstance(document, dict):
        raise QualificationError("IAM policy document is not an object")
    return document


def _verify_scheduler_role(aws: Aws, state: dict[str, Any]) -> None:
    response = aws.call("verify scheduler role trust", "iam", "get-role", "--role-name", state["roleName"])
    role = response.get("Role", {})
    expected_arn = f"arn:aws:iam::{ACCOUNT_ID}:role/{state['roleName']}"
    if role.get("Arn") != expected_arn:
        raise QualificationError("scheduler role ARN changed")
    if role.get("MaxSessionDuration") != 3600:
        raise QualificationError("scheduler role session duration is not the approved 3600 seconds")
    _assert_tags(role.get("Tags"), state, "scheduler role")
    if _json(_decoded_document(role.get("AssumeRolePolicyDocument"))) != _json(_trust_policy(state)):
        raise QualificationError("scheduler role trust is not scoped to this exact schedule group")
    inline_names = aws.call("list scheduler role inline policies", "iam", "list-role-policies", "--role-name", state["roleName"]).get("PolicyNames", [])
    if any(name != "TerminateExactQualifiedInstance" for name in inline_names):
        raise QualificationError("scheduler role has an unexpected inline policy")
    if "TerminateExactQualifiedInstance" in inline_names:
        if not state.get("instanceArn"):
            raise QualificationError("scheduler role has an instance policy before an instance exists")
        policy = aws.call(
            "verify existing exact scheduler policy",
            "iam",
            "get-role-policy",
            "--role-name",
            state["roleName"],
            "--policy-name",
            "TerminateExactQualifiedInstance",
        )
        if _json(_decoded_document(policy.get("PolicyDocument"))) != _json(_instance_policy(state)):
            raise QualificationError("scheduler role inline policy is not exact")
    attached = aws.call("list scheduler role attached policies", "iam", "list-attached-role-policies", "--role-name", state["roleName"]).get("AttachedPolicies", [])
    if attached:
        raise QualificationError("scheduler role has an unexpected attached policy")


def _ensure_role(aws: Aws, state: dict[str, Any]) -> None:
    response = _lookup("find exact scheduler role", aws, "iam", "get-role", "--role-name", state["roleName"])
    expected_arn = f"arn:aws:iam::{ACCOUNT_ID}:role/{state['roleName']}"
    if response and response.get("Role"):
        role = response["Role"]
        if role.get("Arn") != expected_arn:
            raise QualificationError("scheduler role ARN changed")
        _assert_tags(role.get("Tags"), state, "scheduler role")
        state["roleArn"] = expected_arn
        _write_state(CURRENT_STATE_DIR, state)
        _verify_scheduler_role(aws, state)
        return
    try:
        response = aws.call(
            "create disposable scheduler role",
            "iam",
            "create-role",
            "--role-name",
            state["roleName"],
            "--description",
            "Temporary exact-instance EC2 termination role",
            "--assume-role-policy-document",
            _json(_trust_policy(state)),
        "--max-session-duration",
        "3600",
            "--tags",
            _json(_tag_list(state)),
        )
    except AwsFailure:
        response = _lookup("recover disposable scheduler role", aws, "iam", "get-role", "--role-name", state["roleName"])
        if not response or not response.get("Role"):
            raise
        role = response["Role"]
        if role.get("Arn") != expected_arn:
            raise QualificationError("recovered scheduler role ARN changed")
        _assert_tags(role.get("Tags"), state, "scheduler role")
        state["roleArn"] = expected_arn
        _write_state(CURRENT_STATE_DIR, state)
        _verify_scheduler_role(aws, state)
        return
    role = response.get("Role", {})
    if role.get("Arn") not in (None, expected_arn):
        raise QualificationError("scheduler role creation returned a different ARN")
    state["roleArn"] = expected_arn
    _write_state(CURRENT_STATE_DIR, state)
    _verify_scheduler_role(aws, state)


def _user_data(deadline: int) -> str:
    # This is intentionally self-contained: no package manager, download,
    # metadata credential, AWS CLI, or external endpoint is used in the guest.
    calendar_deadline = dt.datetime.fromtimestamp(deadline, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return f"""#!/usr/bin/env bash
set -euo pipefail
umask 077
readonly DEADLINE_EPOCH={deadline}
fail_closed() {{
  trap - EXIT
  /sbin/shutdown -h now || /sbin/poweroff || true
  exit 1
}}
trap fail_closed ERR

install -d -o root -g root -m 0755 /usr/local/sbin /etc/systemd/system
cat > /usr/local/sbin/mc-aws-disposable-deadline <<'SHUTDOWN'
#!/usr/bin/env bash
set -euo pipefail
deadline={deadline}
now="$(date +%s)"
if (( now < deadline )); then
  sleep "$((deadline - now))"
fi
/sbin/shutdown -h now
SHUTDOWN
chmod 0755 /usr/local/sbin/mc-aws-disposable-deadline
cat > /etc/systemd/system/mc-aws-disposable-deadline.service <<'SERVICE'
[Unit]
Description=Terminate the disposable mc-aws qualification runner at its deadline
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/mc-aws-disposable-deadline
SERVICE
cat > /etc/systemd/system/mc-aws-disposable-deadline.timer <<'TIMER'
[Unit]
Description=Persistent deadline for the disposable mc-aws qualification runner

[Timer]
OnCalendar={calendar_deadline}
Persistent=true
AccuracySec=1s
Unit=mc-aws-disposable-deadline.service

[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now mc-aws-disposable-deadline.timer

# Regenerate the host key in the guest and expose only its public fingerprint
# on the EC2 console.  The operator must compare this known-provenance marker
# before accepting the first SSH connection; this wrapper never TOFUs it.
install -d -o root -g root -m 0755 /etc/ssh
rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
chmod 0600 /etc/ssh/ssh_host_ed25519_key
chmod 0644 /etc/ssh/ssh_host_ed25519_key.pub
systemctl reload sshd || systemctl restart sshd
fingerprint="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{{print $2}}')"
printf 'MC_AWS_DISPOSABLE_SSH_HOST_FINGERPRINT=%s\\n' "$fingerprint" > /dev/console
trap - ERR
"""


def _instance_policy(state: dict[str, Any]) -> dict[str, Any]:
    instance_arn = state["instanceArn"]
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "TerminateOnlyThisQualifiedInstance",
                "Effect": "Allow",
                "Action": "ec2:TerminateInstances",
                "Resource": instance_arn,
                "Condition": {"StringEquals": {f"ec2:ResourceTag/{QUALIFICATION_TAG_KEY}": "true", f"ec2:ResourceTag/{RUN_TAG_KEY}": state["runId"]}},
            }
        ],
    }


def _finish_launch(aws: Aws, state_dir: Path, state: dict[str, Any]) -> None:
    global CURRENT_STATE_DIR
    CURRENT_STATE_DIR = state_dir
    if not state.get("instanceId"):
        raise QualificationError("launch recovery has no exact instance")
    item = _verify_instance(aws, state)
    state["instanceArn"] = f"arn:aws:ec2:{REGION}:{ACCOUNT_ID}:instance/{state['instanceId']}"
    state["rootVolumeId"] = next(
        (mapping.get("Ebs", {}).get("VolumeId") for mapping in item.get("BlockDeviceMappings", []) if mapping.get("DeviceName") in ("/dev/xvda", "/dev/sda1")),
        None,
    )
    state["networkInterfaceId"] = next(
        (interface.get("NetworkInterfaceId") for interface in item.get("NetworkInterfaces", []) if interface.get("Attachment", {}).get("DeviceIndex") == 0), None
    )
    _write_state(state_dir, state)
    policy_name = "TerminateExactQualifiedInstance"
    _retry_aws(
        aws,
        "put exact scheduler termination policy",
        "iam",
        "put-role-policy",
        "--role-name",
        state["roleName"],
        "--policy-name",
        policy_name,
        "--policy-document",
        _json(_instance_policy(state)),
    )
    schedule_expression = _schedule_expression(state["deadlineEpoch"])
    target = {
        "Arn": "arn:aws:scheduler:::aws-sdk:ec2:terminateInstances",
        "RoleArn": state["roleArn"],
        "Input": _json({"InstanceIds": [state["instanceId"]]}),
    }
    expected_schedule_arn = f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule/{state['schedulerGroupName']}/{state['scheduleName']}"
    schedule: dict[str, Any] | None = None
    existing = _lookup("recover exact termination schedule", aws, "scheduler", "get-schedule", "--name", state["scheduleName"], "--group-name", state["schedulerGroupName"])
    if existing:
        response = {"ScheduleArn": expected_schedule_arn}
        schedule = existing
    else:
        try:
            response = _retry_aws(
                aws,
                "create exact termination schedule",
                "scheduler",
                "create-schedule",
                "--name",
                state["scheduleName"],
                "--group-name",
                state["schedulerGroupName"],
                "--schedule-expression",
                schedule_expression,
                "--schedule-expression-timezone",
                "UTC",
                "--flexible-time-window",
                _json({"Mode": "OFF"}),
                "--action-after-completion",
                "DELETE",
                "--state",
                "ENABLED",
                "--client-token",
                state["scheduleClientToken"],
                "--target",
                _json(target),
            )
        except AwsFailure:
            schedule = _lookup("recover created termination schedule", aws, "scheduler", "get-schedule", "--name", state["scheduleName"], "--group-name", state["schedulerGroupName"])
            if not schedule:
                raise
            response = {"ScheduleArn": expected_schedule_arn}
    if schedule is None:
        schedule = aws.call(
            "verify exact termination schedule",
            "scheduler",
            "get-schedule",
            "--name",
            state["scheduleName"],
            "--group-name",
            state["schedulerGroupName"],
        )
    if response.get("ScheduleArn") not in (None, expected_schedule_arn):
        raise QualificationError("termination schedule returned a different ARN")
    if (
        schedule.get("ScheduleExpression") != schedule_expression
        or schedule.get("State") != "ENABLED"
        or schedule.get("Target", {}).get("Arn") != target["Arn"]
        or schedule.get("Target", {}).get("RoleArn") != state["roleArn"]
        or schedule.get("Target", {}).get("Input") != target["Input"]
    ):
        raise QualificationError("termination schedule is not bound to the exact instance and deadline")
    state["scheduleArn"] = expected_schedule_arn
    state["phase"] = "launched"
    _write_state(state_dir, state)


def _discover_instance(aws: Aws, state: dict[str, Any]) -> str | None:
    response = _lookup("recover by EC2 client token", aws, "ec2", "describe-instances", "--filters", _json([{"Name": "client-token", "Values": [state["clientToken"]]}]))
    if not response:
        return None
    instances = _find_instances(response)
    if len(instances) != 1:
        if instances:
            raise QualificationError("client token matched more than one instance")
        return None
    instance_id = instances[0].get("InstanceId")
    if not isinstance(instance_id, str) or not re.fullmatch(r"i-[0-9a-f]{8,17}", instance_id):
        raise QualificationError("client token recovery returned no instance ID")
    _assert_tags(instances[0].get("Tags"), state, "client-token recovered instance")
    state["instanceId"] = instance_id
    return instance_id


def _reconcile_missing_instance(aws: Aws, state: dict[str, Any]) -> str | None:
    """Require client-token and exact tag inventories to identify one instance."""
    by_token = _lookup(
        "reconcile instance by client token",
        aws,
        "ec2",
        "describe-instances",
        "--filters",
        _json([{"Name": "client-token", "Values": [state["clientToken"]]}]),
    )
    by_tags = _lookup(
        "reconcile instance by exact ownership tags",
        aws,
        "ec2",
        "describe-instances",
        "--filters",
        _json([{"Name": f"tag:{QUALIFICATION_TAG_KEY}", "Values": ["true"]}, {"Name": f"tag:{RUN_TAG_KEY}", "Values": [state["runId"]]}]),
    )
    token_instances = _find_instances(by_token or {})
    tagged_instances = _find_instances(by_tags or {})
    if not token_instances and not tagged_instances:
        return None
    if len(token_instances) != 1 or len(tagged_instances) != 1:
        raise QualificationError("client-token or tag-scoped instance inventory is not unique")
    token_id = token_instances[0].get("InstanceId")
    tagged_id = tagged_instances[0].get("InstanceId")
    if token_id != tagged_id or not isinstance(token_id, str) or not re.fullmatch(r"i-[0-9a-f]{8,17}", token_id):
        raise QualificationError("client-token and tag-scoped instance inventories disagree")
    _assert_tags(tagged_instances[0].get("Tags"), state, "tag-scoped recovered instance")
    state["instanceId"] = token_id
    return token_id


def _verify_destructive_identity(aws: Aws, state: dict[str, Any], *, require_client_token: bool) -> dict[str, Any]:
    """Verify termination authority without requiring launch-readiness fields."""
    if not state.get("instanceId"):
        raise QualificationError("no exact instance ID is available")
    response = aws.call("read exact instance ownership", "ec2", "describe-instances", "--instance-ids", state["instanceId"])
    instances = _find_instances(response)
    if len(instances) != 1 or instances[0].get("InstanceId") != state["instanceId"]:
        raise QualificationError("exact instance ownership could not be verified")
    item = instances[0]
    _assert_tags(item.get("Tags"), state, "instance ownership")
    if require_client_token:
        recovered = _lookup(
            "verify instance client-token ownership",
            aws,
            "ec2",
            "describe-instances",
            "--filters",
            _json([{"Name": "client-token", "Values": [state["clientToken"]]}]),
        )
        candidates = _find_instances(recovered or {})
        if len(candidates) != 1 or candidates[0].get("InstanceId") != state["instanceId"]:
            raise QualificationError("instance client-token ownership could not be verified")
        _assert_tags(candidates[0].get("Tags"), state, "client-token instance ownership")
    return item


def _emergency_terminate(aws: Aws, state: dict[str, Any]) -> None:
    if not state.get("instanceId"):
        raise QualificationError("no exact instance ID is available for fail-closed termination")
    item = _verify_destructive_identity(aws, state, require_client_token=True)
    if item.get("State", {}).get("Name") != "terminated":
        aws.call("fail-closed exact instance termination", "ec2", "terminate-instances", "--instance-ids", state["instanceId"])
    state["phase"] = "termination-requested"
    _write_state(CURRENT_STATE_DIR, state)


def launch(args: argparse.Namespace, aws: Aws, state_dir: Path) -> None:
    global CURRENT_STATE_DIR
    CURRENT_STATE_DIR = state_dir
    state = _load_state(state_dir, args.run_id)
    if args.confirm != _approval(args.run_id, state["sshCidr"]):
        raise QualificationError("launch confirmation does not exactly match this RunId and proposal")
    if state["phase"] in {"cleaned", "termination-requested", "cleanup-incomplete"}:
        raise QualificationError(f"run cannot be launched from phase {state['phase']}")
    _verify_caller(aws)
    discovery_failed = False
    try:
        _ensure_scheduler_group(aws, state)
        _ensure_role(aws, state)
        _ensure_security_group(aws, state)
        _ensure_key_pair(aws, state)
        if not state.get("deadlineEpoch"):
            state["deadlineEpoch"] = int(time.time()) + DEADLINE_SECONDS
            state["phase"] = "launching"
            _write_state(state_dir, state)
        if not state.get("instanceId"):
            recovered = _discover_instance(aws, state)
            if recovered:
                _write_state(state_dir, state)
            else:
                if int(time.time()) >= state["deadlineEpoch"]:
                    raise QualificationError("launch deadline elapsed before EC2 request; no instance was started")
                response = aws.call(
                    "launch exact disposable instance",
                    "ec2",
                    "run-instances",
                    "--image-id",
                    AMI_ID,
                    "--instance-type",
                    INSTANCE_TYPE,
                    "--count",
                    "1",
                    "--subnet-id",
                    state["subnetId"],
                    "--associate-public-ip-address",
                    "--metadata-options",
                    _json({"HttpTokens": "required", "HttpEndpoint": "enabled", "HttpProtocolIpv6": "disabled", "InstanceMetadataTags": "disabled", "HttpPutResponseHopLimit": 1}),
                    "--security-group-ids",
                    state["securityGroupId"],
                    "--key-name",
                    state["keyName"],
                    "--user-data",
                    _user_data(state["deadlineEpoch"]),
                    "--client-token",
                    state["clientToken"],
                    "--instance-initiated-shutdown-behavior",
                    "terminate",
                    "--credit-specification",
                    _json({"CpuCredits": "unlimited"}),
                    "--block-device-mappings",
                    _json([{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": VOLUME_SIZE_GIB, "VolumeType": "gp3", "Encrypted": True, "DeleteOnTermination": True}}]),
                    "--tag-specifications",
                    _json([
                        {"ResourceType": resource, "Tags": _tag_list(state)}
                        for resource in ("instance", "volume", "network-interface")
                    ]),
                )
                instances = response.get("Instances", [])
                if len(instances) != 1 or not isinstance(instances[0].get("InstanceId"), str):
                    raise QualificationError("EC2 launch returned no unique instance")
                state["instanceId"] = instances[0]["InstanceId"]
                _write_state(state_dir, state)
        _finish_launch(aws, state_dir, state)
        print(f"Launched exact disposable instance {state['instanceId']}; deadline {_schedule_expression(state['deadlineEpoch'])}")
    except Exception as error:
        state["phase"] = "launch-recovery-required"
        state["lastFailure"] = _failure_detail(error)
        try:
            _write_state(state_dir, state)
        except Exception:
            # A local write failure must not suppress cloud-side client-token
            # reconciliation or the exact fail-closed termination attempt.
            pass
        if not state.get("instanceId"):
            try:
                if _discover_instance(aws, state):
                    _write_state(state_dir, state)
            except Exception:
                # The instance may still be in an eventually consistent
                # window.  Do not guess an ID or issue a broad termination.
                discovery_failed = True
        if state.get("instanceId"):
            try:
                _emergency_terminate(aws, state)
            except Exception:
                raise QualificationError(
                    f"launch failed ({state['lastFailure']['operation']}; awsCode={state['lastFailure']['awsCode']}) and exact termination could not be verified/requested; run cleanup after manual reconciliation"
                ) from error
        if discovery_failed:
            raise QualificationError(
                f"launch failed ({state['lastFailure']['operation']}; awsCode={state['lastFailure']['awsCode']}) and client-token reconciliation was unavailable; treat the run as residual until manually reconciled"
            ) from error
        raise QualificationError(
            f"launch failed ({state['lastFailure']['operation']}; awsCode={state['lastFailure']['awsCode']}); run cleanup for recorded disposable resources"
        ) from error


def _console_fingerprint(aws: Aws, state: dict[str, Any]) -> str | None:
    if not state.get("instanceId"):
        return None
    response = _lookup("read guest console fingerprint", aws, "ec2", "get-console-output", "--instance-id", state["instanceId"], "--latest")
    if not response:
        return None
    output = response.get("Output")
    if not isinstance(output, str):
        return None
    marker = re.compile(r"MC_AWS_DISPOSABLE_SSH_HOST_FINGERPRINT=(SHA256:[A-Za-z0-9+/=]+)")
    match = marker.search(output)
    if match:
        return match.group(1)
    # Treat the field as either the CLI-decoded console text or a base64 blob;
    # only a successfully decoded, known marker is accepted.
    try:
        decoded = base64.b64decode(output, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    match = marker.search(decoded)
    return match.group(1) if match else None


def status(args: argparse.Namespace, aws: Aws, state_dir: Path) -> None:
    state = _load_state(state_dir, args.run_id)
    _verify_caller(aws)
    result: dict[str, Any] = {"runId": state["runId"], "phase": state["phase"], "deadline": state.get("deadlineEpoch")}
    if state.get("instanceId"):
        observed = aws.call("read exact instance status", "ec2", "describe-instances", "--instance-ids", state["instanceId"])
        if _find_instances(observed) and _find_instances(observed)[0].get("State", {}).get("Name") == "terminated":
            item = _verify_destructive_identity(aws, state, require_client_token=False)
        else:
            item = _verify_instance(aws, state)
        result["instanceId"] = state["instanceId"]
        result["instanceState"] = item.get("State", {}).get("Name")
        result["sshHostFingerprint"] = _console_fingerprint(aws, state)
    print(_json(result))


def _wait_terminated(aws: Aws, state: dict[str, Any], timeout_seconds: int = 120) -> None:
    end = time.monotonic() + timeout_seconds
    while True:
        response = _lookup("observe exact instance termination", aws, "ec2", "describe-instances", "--instance-ids", state["instanceId"])
        if response is None:
            # A recently terminated instance can disappear from DescribeInstances.
            return
        instances = _find_instances(response)
        if not instances:
            return
        item = _verify_destructive_identity(aws, state, require_client_token=False)
        if item.get("State", {}).get("Name") == "terminated":
            return
        if time.monotonic() >= end:
            raise QualificationError("exact instance did not reach terminated state before cleanup deadline")
        time.sleep(2)


def terminate(args: argparse.Namespace, aws: Aws, state_dir: Path) -> None:
    global CURRENT_STATE_DIR
    CURRENT_STATE_DIR = state_dir
    state = _load_state(state_dir, args.run_id)
    if args.confirm != _terminate_approval(args.run_id):
        raise QualificationError("termination confirmation does not exactly match this RunId")
    _verify_caller(aws)
    if not state.get("instanceId"):
        _discover_instance(aws, state)
    if not state.get("instanceId"):
        state["phase"] = "no-instance"
        _write_state(state_dir, state)
        print("No instance was found for this client token; use cleanup for temporary resources")
        return
    item = _verify_destructive_identity(aws, state, require_client_token=True)
    if item.get("State", {}).get("Name") != "terminated":
        _verify_instance(aws, state)
        aws.call("terminate exact disposable instance", "ec2", "terminate-instances", "--instance-ids", state["instanceId"])
    state["phase"] = "termination-requested"
    _write_state(state_dir, state)
    print(f"Termination requested for exact instance {state['instanceId']}; run cleanup after it reaches terminated")


def _delete_if_owned(aws: Aws, state: dict[str, Any], kind: str) -> None:
    if kind == "schedule":
        response = _lookup("read exact termination schedule", aws, "scheduler", "get-schedule", "--name", state["scheduleName"], "--group-name", state["schedulerGroupName"])
        if response:
            target = response.get("Target", {})
            if target.get("RoleArn") != state.get("roleArn") or target.get("Input") != _json({"InstanceIds": [state["instanceId"]]}):
                raise QualificationError("termination schedule ownership changed; refusing delete")
            aws.call("delete exact termination schedule", "scheduler", "delete-schedule", "--name", state["scheduleName"], "--group-name", state["schedulerGroupName"])
    elif kind == "role":
        response = _lookup("read exact scheduler role", aws, "iam", "get-role", "--role-name", state["roleName"])
        if response:
            role = response.get("Role", {})
            if role.get("Arn") != state.get("roleArn"):
                raise QualificationError("scheduler role ownership changed; refusing delete")
            _assert_tags(role.get("Tags"), state, "scheduler role")
            policies = aws.call("list exact role policies", "iam", "list-role-policies", "--role-name", state["roleName"]).get("PolicyNames", [])
            if any(name != "TerminateExactQualifiedInstance" for name in policies):
                raise QualificationError("scheduler role has an unexpected inline policy; refusing delete")
            if "TerminateExactQualifiedInstance" in policies:
                aws.call("delete exact role policy", "iam", "delete-role-policy", "--role-name", state["roleName"], "--policy-name", "TerminateExactQualifiedInstance")
            attached = aws.call("list attached scheduler role policies", "iam", "list-attached-role-policies", "--role-name", state["roleName"]).get("AttachedPolicies", [])
            if attached:
                raise QualificationError("scheduler role has an unexpected attached policy; refusing delete")
            aws.call("delete exact scheduler role", "iam", "delete-role", "--role-name", state["roleName"])
    elif kind == "group":
        response = _lookup("read exact scheduler group", aws, "scheduler", "get-schedule-group", "--name", state["schedulerGroupName"])
        if response:
            if response.get("Arn") != state.get("schedulerGroupArn"):
                raise QualificationError("scheduler group ownership changed; refusing delete")
            tags = aws.call("read scheduler group tags", "scheduler", "list-tags-for-resource", "--resource-arn", state["schedulerGroupArn"]).get("Tags")
            _assert_tags(tags, state, "scheduler group")
            schedules = aws.call("list scheduler group schedules", "scheduler", "list-schedules", "--group-name", state["schedulerGroupName"]).get("Schedules", [])
            if any(item.get("Name") != state["scheduleName"] for item in schedules if isinstance(item, dict)):
                raise QualificationError("scheduler group contains an unexpected schedule; refusing delete")
            aws.call("delete exact scheduler group", "scheduler", "delete-schedule-group", "--name", state["schedulerGroupName"])
    elif kind == "security-group":
        response = _lookup("read exact security group before delete", aws, "ec2", "describe-security-groups", "--group-ids", state.get("securityGroupId", ""))
        if response and response.get("SecurityGroups"):
            group = response["SecurityGroups"][0]
            _assert_tags(group.get("Tags"), state, "security group")
            if group.get("VpcId") != state["vpcId"]:
                raise QualificationError("security group VPC changed; refusing delete")
            aws.call("delete exact security group", "ec2", "delete-security-group", "--group-id", state["securityGroupId"])
    elif kind == "key-pair":
        response = _lookup("read exact key pair before delete", aws, "ec2", "describe-key-pairs", "--key-names", state["keyName"])
        if response and response.get("KeyPairs"):
            _assert_tags(response["KeyPairs"][0].get("Tags"), state, "key pair")
            aws.call("delete exact key pair", "ec2", "delete-key-pair", "--key-name", state["keyName"])


def _residuals(aws: Aws, state: dict[str, Any]) -> list[str]:
    residuals: list[str] = []
    for label, service, action, arguments, collection in (
        ("volume", "ec2", "describe-volumes", ("--filters", _json([{"Name": f"tag:{RUN_TAG_KEY}", "Values": [state["runId"]]}])), "Volumes"),
        ("network interface", "ec2", "describe-network-interfaces", ("--filters", _json([{"Name": f"tag:{RUN_TAG_KEY}", "Values": [state["runId"]]}])), "NetworkInterfaces"),
    ):
        response = _lookup(f"check residual {label}", aws, service, action, *arguments)
        if response and response.get(collection):
            residuals.append(label)
    security_group = _lookup("check residual security group", aws, "ec2", "describe-security-groups", "--group-ids", state["securityGroupId"]) if state.get("securityGroupId") else None
    if security_group and security_group.get("SecurityGroups"):
        residuals.append("security group")
    key_pair = _lookup("check residual key pair", aws, "ec2", "describe-key-pairs", "--key-names", state["keyName"])
    if key_pair and key_pair.get("KeyPairs"):
        residuals.append("key pair")
    if state.get("scheduleName") and _lookup("check residual termination schedule", aws, "scheduler", "get-schedule", "--name", state["scheduleName"], "--group-name", state["schedulerGroupName"]):
        residuals.append("termination schedule")
    if state.get("roleName") and _lookup("check residual scheduler role", aws, "iam", "get-role", "--role-name", state["roleName"]):
        residuals.append("scheduler role")
    if state.get("schedulerGroupName") and _lookup("check residual scheduler group", aws, "scheduler", "get-schedule-group", "--name", state["schedulerGroupName"]):
        residuals.append("scheduler group")
    return residuals


def cleanup(args: argparse.Namespace, aws: Aws, state_dir: Path) -> None:
    global CURRENT_STATE_DIR
    CURRENT_STATE_DIR = state_dir
    state = _load_state(state_dir, args.run_id)
    if args.confirm != _cleanup_approval(args.run_id):
        raise QualificationError("cleanup confirmation does not exactly match this RunId")
    if state["phase"] == "cleaned":
        print(f"Run {state['runId']} is already cleaned")
        return
    _verify_caller(aws)
    # Resource-create responses can be lost after AWS commits them.  Resolve
    # only the names already bound to this RunId; never search by a broad tag
    # or delete a same-looking production resource.
    if not state.get("roleArn"):
        state["roleArn"] = f"arn:aws:iam::{ACCOUNT_ID}:role/{state['roleName']}"
    if not state.get("schedulerGroupArn"):
        state["schedulerGroupArn"] = f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule-group/{state['schedulerGroupName']}"
    if not state.get("securityGroupId"):
        response = _lookup("recover exact security group for cleanup", aws, "ec2", "describe-security-groups", "--filters", _json([{"Name": "group-name", "Values": [state["securityGroupName"]]}]))
        if response and len(response.get("SecurityGroups", [])) == 1:
            group = response["SecurityGroups"][0]
            _assert_tags(group.get("Tags"), state, "security group")
            if group.get("VpcId") != state["vpcId"]:
                raise QualificationError("security group VPC changed; refusing cleanup")
            state["securityGroupId"] = group.get("GroupId")
            if not isinstance(state["securityGroupId"], str):
                raise QualificationError("recovered security group has no ID")
    if not state.get("instanceId"):
        _reconcile_missing_instance(aws, state)
    _write_state(state_dir, state)
    if state.get("instanceId"):
        response = _lookup("check exact instance before cleanup", aws, "ec2", "describe-instances", "--instance-ids", state["instanceId"])
        if response and _find_instances(response):
            item = _verify_destructive_identity(aws, state, require_client_token=False)
            if item.get("State", {}).get("Name") != "terminated":
                raise QualificationError("instance is not terminated; run terminate first")
            _wait_terminated(aws, state)
    for kind in ("schedule", "role", "group", "security-group", "key-pair"):
        _delete_if_owned(aws, state, kind)
    residuals = _residuals(aws, state)
    if residuals:
        state["phase"] = "cleanup-incomplete"
        _write_state(state_dir, state)
        raise QualificationError("cleanup left exact run-owned residuals: " + ", ".join(sorted(set(residuals))))
    key_path = Path(state["keyPath"])
    if key_path.exists() or key_path.is_symlink():
        if key_path.is_symlink() or not key_path.is_file() or key_path.stat().st_uid != os.geteuid() or stat.S_IMODE(key_path.stat().st_mode) != 0o600:
            raise QualificationError("temporary private key has unsafe metadata; refusing local delete")
        key_path.unlink()
    state["phase"] = "cleaned"
    state["keyPath"] = "removed"
    _write_state(state_dir, state)
    print(f"Cleaned exact disposable resources for {state['runId']}; no checked residuals remain")


CURRENT_STATE_DIR = Path(DEFAULT_STATE_DIR)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--aws-cli", default=os.environ.get("MC_AWS_DISPOSABLE_AWS_CLI", AWS_CLI_DEFAULT))
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--ssh-cidr", required=True)
    for name in ("launch", "status", "terminate", "cleanup"):
        command_parser = subparsers.add_parser(name)
        command_parser.add_argument("--run-id", required=True)
        if name == "launch":
            command_parser.add_argument("--confirm", required=True)
        elif name == "terminate":
            command_parser.add_argument("--confirm", required=True)
        elif name == "cleanup":
            command_parser.add_argument("--confirm", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    state_dir = Path(args.state_dir).expanduser()
    descriptor = _lock(state_dir)
    try:
        aws = Aws(args.aws_cli)
        if args.command == "prepare":
            prepare(args, aws, state_dir)
        elif args.command == "launch":
            launch(args, aws, state_dir)
        elif args.command == "status":
            status(args, aws, state_dir)
        elif args.command == "terminate":
            terminate(args, aws, state_dir)
        elif args.command == "cleanup":
            cleanup(args, aws, state_dir)
        return 0
    except QualificationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
