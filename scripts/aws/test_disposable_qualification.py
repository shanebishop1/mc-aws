#!/usr/bin/env python3
"""Deterministic, cloud-free tests for disposable_qualification.py.

The child executable below is the only AWS CLI used by these tests.  No AWS
SDK, credentials, network, or real cloud command is available to the test.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("disposable_qualification", ROOT / "disposable_qualification.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


FAKE_CLI = r'''#!/usr/bin/env python3
import base64, json, os, pathlib, sys

args = sys.argv[1:]
log = pathlib.Path(os.environ["FAKE_LOG"])
with log.open("a", encoding="utf-8") as output:
    json.dump(args, output, sort_keys=False)
    output.write("\n")

def value(name):
    return args[args.index(name) + 1]

service, action = args[6], args[7]
fixture = pathlib.Path(os.environ["FAKE_FIXTURE"])
def write_fixture(value):
    fixture.write_text(json.dumps(value), encoding="utf-8")

def read_fixture():
    return json.loads(fixture.read_text(encoding="utf-8")) if fixture.exists() else {}

if service == "sts" and action == "get-caller-identity":
    result = {"Account": "096541555712", "Arn": "arn:aws:iam::096541555712:user/shane"}
elif service == "ec2" and action == "describe-images":
    result = {"Images": [{"ImageId": "ami-0ab418c4e47896df2", "OwnerId": "137112412989", "Architecture": "arm64", "RootDeviceType": "ebs", "VirtualizationType": "hvm", "Name": "al2023-ami-2023.12.20260831.0-kernel-6.1-arm64"}]}
elif service == "ec2" and action == "describe-vpcs":
    result = {"Vpcs": [{"VpcId": "vpc-0123456789abcdef0"}]}
elif service == "ec2" and action == "describe-subnets":
    result = {"Subnets": [{"SubnetId": "subnet-0123456789abcdef0", "VpcId": "vpc-0123456789abcdef0", "MapPublicIpOnLaunch": True}]}
elif service == "ec2" and action == "describe-security-groups":
    fixture_value = read_fixture()
    result = {"SecurityGroups": [fixture_value["securityGroup"]]} if fixture_value.get("securityGroup") else {"SecurityGroups": []}
elif service == "ec2" and action == "create-security-group":
    group = {"GroupId": "sg-0123456789abcdef0", "VpcId": "vpc-0123456789abcdef0", "Tags": json.loads(value("--tag-specifications"))[0]["Tags"], "IpPermissions": [], "IpPermissionsEgress": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "Ipv6Ranges": [{"CidrIpv6": "::/0"}]}]}
    write_fixture({**read_fixture(), "securityGroup": group})
    result = {"GroupId": group["GroupId"]}
elif service == "ec2" and action == "authorize-security-group-ingress":
    fixture_value = read_fixture()
    fixture_value["securityGroup"]["IpPermissions"] = json.loads(value("--ip-permissions"))
    write_fixture(fixture_value)
    result = {}
elif service == "ec2" and action == "revoke-security-group-egress":
    fixture_value = read_fixture()
    fixture_value["securityGroup"]["IpPermissionsEgress"] = []
    write_fixture(fixture_value)
    result = {}
elif service == "ec2" and action == "describe-key-pairs":
    result = {"KeyPairs": []} if not read_fixture().get("keyPair") else {"KeyPairs": [read_fixture()["keyPair"]]}
elif service == "ec2" and action == "import-key-pair":
    key = {"KeyName": value("--key-name"), "Tags": json.loads(value("--tag-specifications"))[0]["Tags"]}
    write_fixture({**read_fixture(), "keyPair": key})
    result = key
elif service == "scheduler" and action == "get-schedule-group":
    result = read_fixture().get("scheduleGroup", {})
elif service == "scheduler" and action == "create-schedule-group":
    group = {"Arn": "arn:aws:scheduler:us-west-1:096541555712:schedule-group/" + value("--name")}
    write_fixture({**read_fixture(), "scheduleGroup": group, "scheduleGroupTags": json.loads(value("--tags"))})
    result = {"ScheduleGroupArn": group["Arn"]}
elif service == "iam" and action == "get-role":
    result = read_fixture().get("role", {})
elif service == "iam" and action == "create-role":
    name = value("--role-name")
    role = {"Role": {"Arn": "arn:aws:iam::096541555712:role/" + name, "RoleName": name, "Tags": json.loads(value("--tags")), "AssumeRolePolicyDocument": json.loads(value("--assume-role-policy-document")), "MaxSessionDuration": 3600}}
    write_fixture({**read_fixture(), "role": role})
    result = role
elif service == "ec2" and action == "run-instances":
    if "--min-count" in args or "--max-count" in args or "--count" not in args or value("--count") != "1":
        print("Unknown options: --min-count/--max-count; expected --count 1", file=sys.stderr)
        sys.exit(64)
    group_id = value("--security-group-ids")
    key_name = value("--key-name")
    tags = json.loads(value("--tag-specifications"))[0]["Tags"]
    instance = {"InstanceId": "i-0123456789abcdef0", "ImageId": value("--image-id"), "InstanceType": value("--instance-type"), "SubnetId": value("--subnet-id"), "KeyName": key_name, "SecurityGroups": [{"GroupId": group_id}], "Tags": tags, "State": {"Name": "running"}, "BlockDeviceMappings": [{"DeviceName": "/dev/xvda", "Ebs": {"VolumeId": "vol-0123456789abcdef0", "DeleteOnTermination": True}}], "NetworkInterfaces": [{"NetworkInterfaceId": "eni-0123456789abcdef0", "Attachment": {"DeviceIndex": 0}}]}
    write_fixture({**read_fixture(), "instance": instance})
    if os.environ.get("FAKE_RUN_FAILURE") == "1":
        print("An error occurred (UnauthorizedOperation) when calling the RunInstances operation: secret-redacted", file=sys.stderr)
        sys.exit(74)
    result = {"Instances": [instance]}
elif service == "ec2" and action == "describe-instances":
    fixture_value = read_fixture()
    result = {"Reservations": [{"Instances": [fixture_value["instance"]]}]} if fixture_value.get("instance") else {"Reservations": []}
elif service == "ec2" and action == "describe-instance-credit-specifications":
    result = {"InstanceCreditSpecifications": [{"InstanceId": "i-0123456789abcdef0", "CpuCredits": "standard" if os.environ.get("FAKE_BAD_CPU") == "1" else "unlimited"}]}
elif service == "ec2" and action == "describe-instance-attribute":
    result = {"InstanceInitiatedShutdownBehavior": {"Value": "terminate"}}
elif service == "ec2" and action == "describe-volumes":
    fixture_value = read_fixture()
    result = {"Volumes": [{"VolumeId": "vol-0123456789abcdef0", "Size": 8, "VolumeType": "gp3", "Encrypted": True, "Tags": fixture_value.get("instance", {}).get("Tags", [])}]} if "--volume-ids" in args and fixture_value.get("instance") else {"Volumes": []}
elif service == "iam" and action == "put-role-policy":
    write_fixture({**read_fixture(), "policy": json.loads(value("--policy-document"))})
    result = {}
elif service == "iam" and action == "get-role-policy":
    result = {"PolicyDocument": read_fixture().get("policy", {})}
elif service == "scheduler" and action == "create-schedule":
    if os.environ.get("FAKE_SCHEDULE_FAIL") == "1":
        sys.exit(73)
    target = json.loads(value("--target"))
    schedule = {"ScheduleExpression": value("--schedule-expression"), "State": "ENABLED", "Target": target}
    write_fixture({**read_fixture(), "schedule": schedule, "scheduleName": value("--name")})
    result = {"ScheduleArn": "arn:aws:scheduler:us-west-1:096541555712:schedule/" + value("--group-name") + "/" + value("--name")}
elif service == "scheduler" and action == "get-schedule":
    result = read_fixture().get("schedule", {})
elif service == "scheduler" and action == "delete-schedule":
    fixture_value = read_fixture()
    fixture_value.pop("schedule", None)
    write_fixture(fixture_value)
    result = {}
elif service == "scheduler" and action == "list-tags-for-resource":
    result = {"Tags": read_fixture().get("scheduleGroupTags", [])}
elif service == "scheduler" and action == "list-schedules":
    result = {"Schedules": []} if "schedule" not in read_fixture() else {"Schedules": [{"Name": read_fixture()["scheduleName"]}]}
elif service == "scheduler" and action == "delete-schedule-group":
    fixture_value = read_fixture()
    fixture_value.pop("scheduleGroup", None)
    write_fixture(fixture_value)
    result = {}
elif service == "ec2" and action == "get-console-output":
    output = "MC_AWS_DISPOSABLE_SSH_HOST_FINGERPRINT=SHA256:knownprovenance\n"
    result = {"Output": base64.b64encode(output.encode()).decode() if os.environ.get("FAKE_CONSOLE_BASE64") == "1" else output}
elif service == "ec2" and action == "terminate-instances":
    fixture_value = read_fixture()
    if fixture_value.get("instance"):
        fixture_value["instance"]["State"] = {"Name": "terminated"}
        write_fixture(fixture_value)
    result = {}
elif service == "iam" and action == "list-role-policies":
    result = {"PolicyNames": ["TerminateExactQualifiedInstance"]} if read_fixture().get("policy") else {"PolicyNames": []}
elif service == "iam" and action == "delete-role-policy":
    fixture_value = read_fixture()
    fixture_value.pop("policy", None)
    write_fixture(fixture_value)
    result = {}
elif service == "iam" and action == "list-attached-role-policies":
    result = {"AttachedPolicies": []}
elif service == "iam" and action == "delete-role":
    fixture_value = read_fixture()
    fixture_value.pop("role", None)
    write_fixture(fixture_value)
    result = {}
elif service == "ec2" and action == "delete-security-group":
    fixture_value = read_fixture()
    fixture_value.pop("securityGroup", None)
    write_fixture(fixture_value)
    result = {}
elif service == "ec2" and action == "delete-key-pair":
    fixture_value = read_fixture()
    fixture_value.pop("keyPair", None)
    write_fixture(fixture_value)
    result = {}
else:
    result = {}
print(json.dumps(result, separators=(",", ":")))
'''


class DisposableQualificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.state = self.root / "state"
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.cli = self.root / "fake-aws.py"
        self.cli.write_text(FAKE_CLI, encoding="utf-8")
        self.cli.chmod(0o700)
        self.log = self.root / "aws.log"
        self.fixture = self.root / "fixture.json"
        self.environment = {**os.environ, "HOME": str(self.home), "FAKE_LOG": str(self.log), "FAKE_FIXTURE": str(self.fixture), "AWS_SECRET_ACCESS_KEY": "sentinel-not-for-state"}

    def tearDown(self) -> None:
        self.directory.cleanup()

    def invoke(self, *arguments: str, extra_environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        environment = {**self.environment, **(extra_environment or {})}
        return subprocess.run(
            ["python3", str(ROOT / "disposable_qualification.py"), "--state-dir", str(self.state), "--aws-cli", str(self.cli), *arguments],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def cli_calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def prepare_and_launch(self) -> dict[str, object]:
        prepared = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        run_id = next(line.split(": ", 1)[1] for line in prepared.stdout.splitlines() if line.startswith("RunId: "))
        state_path = self.state / f"{run_id}.json"
        state = json.loads(state_path.read_text(encoding="ascii"))
        launched = self.invoke("launch", "--run-id", run_id, "--confirm", MODULE._approval(run_id, state["sshCidr"]))
        self.assertEqual(launched.returncode, 0, launched.stderr)
        return {"runId": run_id, "state": json.loads(state_path.read_text(encoding="ascii")), "stateBefore": state}

    def test_prepare_binds_durable_token_without_copying_credentials(self) -> None:
        result = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SSH=198.51.100.42/32", result.stdout)
        run_id = next(line.split(": ", 1)[1] for line in result.stdout.splitlines() if line.startswith("RunId: "))
        state = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        self.assertRegex(state["clientToken"], r"^[0-9a-f]{64}$")
        self.assertEqual(state["sshCidr"], "198.51.100.42/32")
        self.assertEqual(state["approvalDigest"], MODULE._approval_digest(MODULE._approval(run_id, state["sshCidr"])))
        self.assertNotIn("sentinel-not-for-state", json.dumps(state))
        self.assertEqual(stat.S_IMODE((self.state / f"{run_id}.json").stat().st_mode), 0o600)
        self.assertTrue(Path(state["keyPath"]).is_file())

    def test_launch_orders_temp_authority_before_ec2_and_pins_every_boundary(self) -> None:
        result = self.prepare_and_launch()
        state = result["state"]
        self.assertEqual(json.loads(self.fixture.read_text(encoding="utf-8"))["securityGroup"]["IpPermissionsEgress"], [])
        calls = self.cli_calls()
        services_actions = [(call[6], call[7]) for call in calls]
        run_position = services_actions.index(("ec2", "run-instances"))
        self.assertLess(services_actions.index(("scheduler", "create-schedule-group")), run_position)
        self.assertLess(services_actions.index(("iam", "create-role")), run_position)
        run_call = calls[run_position]
        self.assertNotIn("--iam-instance-profile", run_call)
        tags = json.loads(run_call[run_call.index("--tag-specifications") + 1])
        self.assertEqual({tag["Key"]: tag["Value"] for tag in tags[0]["Tags"]}[MODULE.RUN_TAG_KEY], result["runId"])
        self.assertEqual({item["ResourceType"] for item in tags}, {"instance", "volume", "network-interface"})
        block = json.loads(run_call[run_call.index("--block-device-mappings") + 1])[0]["Ebs"]
        self.assertEqual(block, {"VolumeSize": 8, "VolumeType": "gp3", "Encrypted": True, "DeleteOnTermination": True})
        self.assertEqual(run_call[run_call.index("--instance-initiated-shutdown-behavior") + 1], "terminate")
        self.assertEqual(run_call[run_call.index("--count") + 1], "1")
        self.assertNotIn("--min-count", run_call)
        self.assertNotIn("--max-count", run_call)
        self.assertEqual(json.loads(run_call[run_call.index("--credit-specification") + 1]), {"CpuCredits": "unlimited"})
        user_data = run_call[run_call.index("--user-data") + 1]
        self.assertIn("Persistent=true", user_data)
        self.assertIn("OnCalendar=", user_data)
        self.assertNotIn("OnBootSec=", user_data)
        self.assertIn("/dev/console", user_data)
        self.assertIn("ssh-keygen", user_data)
        for forbidden in ("curl ", "wget ", "dnf ", "pip ", "npm ", "http://", "https://"):
            self.assertNotIn(forbidden, user_data)
        role_call = calls[services_actions.index(("iam", "create-role"))]
        self.assertEqual(role_call[role_call.index("--max-session-duration") + 1], "3600")
        trust = json.loads(role_call[role_call.index("--assume-role-policy-document") + 1])
        source_arn = trust["Statement"][0]["Condition"]["StringEquals"]["aws:SourceArn"]
        self.assertEqual(source_arn, state["schedulerGroupArn"])
        self.assertIn("schedule-group/", source_arn)
        policy = json.loads(self.fixture.read_text(encoding="utf-8"))["policy"]
        self.assertEqual(policy["Statement"][0]["Resource"], state["instanceArn"])
        self.assertEqual(policy["Statement"][0]["Condition"]["StringEquals"]["ec2:ResourceTag/McAwsRunId"], result["runId"])
        schedule_call = calls[services_actions.index(("scheduler", "create-schedule"))]
        target = json.loads(schedule_call[schedule_call.index("--target") + 1])
        self.assertEqual(target["Arn"], "arn:aws:scheduler:::aws-sdk:ec2:terminateInstances")
        self.assertEqual(json.loads(target["Input"]), {"InstanceIds": [state["instanceId"]]})
        self.assertIn("--cli-binary-format", run_call)
        self.assertEqual(run_call[run_call.index("--cli-binary-format") + 1], "raw-in-base64-out")

    def test_relaunch_validates_recovered_role_trust_and_exact_existing_policy(self) -> None:
        prepared = self.prepare_and_launch()
        run_id = prepared["runId"]
        confirmation = MODULE._approval(run_id, prepared["state"]["sshCidr"])
        relaunch = self.invoke("launch", "--run-id", run_id, "--confirm", confirmation)
        self.assertEqual(relaunch.returncode, 0, relaunch.stderr)
        calls = self.cli_calls()
        actions = [(call[6], call[7]) for call in calls]
        self.assertGreaterEqual(actions.count(("iam", "get-role-policy")), 1)
        self.assertEqual(actions.count(("ec2", "run-instances")), 1)

    def test_schedule_failure_requests_only_exact_fail_closed_termination(self) -> None:
        prepared = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        run_id = next(line.split(": ", 1)[1] for line in prepared.stdout.splitlines() if line.startswith("RunId: "))
        state = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        result = self.invoke("launch", "--run-id", run_id, "--confirm", MODULE._approval(run_id, state["sshCidr"]), extra_environment={"FAKE_SCHEDULE_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        calls = self.cli_calls()
        terminate_calls = [call for call in calls if len(call) > 7 and call[6:8] == ["ec2", "terminate-instances"]]
        self.assertEqual(len(terminate_calls), 1)
        self.assertEqual(terminate_calls[0][terminate_calls[0].index("--instance-ids") + 1], "i-0123456789abcdef0")
        self.assertNotIn("sentinel-not-for-state", self.log.read_text(encoding="utf-8"))

    def test_run_error_code_is_recorded_without_raw_stderr(self) -> None:
        prepared = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        run_id = next(line.split(": ", 1)[1] for line in prepared.stdout.splitlines() if line.startswith("RunId: "))
        state = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        result = self.invoke(
            "launch",
            "--run-id",
            run_id,
            "--confirm",
            MODULE._approval(run_id, state["sshCidr"]),
            extra_environment={"FAKE_RUN_FAILURE": "1"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("awsCode=UnauthorizedOperation", result.stderr)
        self.assertNotIn("secret-redacted", result.stderr)
        saved = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        self.assertEqual(saved["lastFailure"], {"operation": "launch exact disposable instance", "awsCode": "UnauthorizedOperation"})

    def test_readiness_failure_still_uses_identity_only_for_emergency_termination(self) -> None:
        prepared = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        run_id = next(line.split(": ", 1)[1] for line in prepared.stdout.splitlines() if line.startswith("RunId: "))
        state = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        result = self.invoke("launch", "--run-id", run_id, "--confirm", MODULE._approval(run_id, state["sshCidr"]), extra_environment={"FAKE_BAD_CPU": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(1 for call in self.cli_calls() if call[6:8] == ["ec2", "terminate-instances"]), 1)

    def test_wrong_confirmation_is_rejected_before_mutation(self) -> None:
        prepared = self.invoke("prepare", "--ssh-cidr", "198.51.100.42/32")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        run_id = next(line.split(": ", 1)[1] for line in prepared.stdout.splitlines() if line.startswith("RunId: "))
        calls_before = len(self.cli_calls())
        result = self.invoke("launch", "--run-id", run_id, "--confirm", "yes")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.cli_calls()), calls_before)

    def test_terminate_then_cleanup_checks_and_removes_only_recorded_resources(self) -> None:
        prepared = self.prepare_and_launch()
        run_id = prepared["runId"]
        status = self.invoke("status", "--run-id", run_id, extra_environment={"FAKE_CONSOLE_BASE64": "1"})
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(json.loads(status.stdout)["sshHostFingerprint"], "SHA256:knownprovenance")
        terminated = self.invoke("terminate", "--run-id", run_id, "--confirm", MODULE._terminate_approval(run_id))
        self.assertEqual(terminated.returncode, 0, terminated.stderr)
        cleaned = self.invoke("cleanup", "--run-id", run_id, "--confirm", MODULE._cleanup_approval(run_id))
        self.assertEqual(cleaned.returncode, 0, cleaned.stderr)
        state = json.loads((self.state / f"{run_id}.json").read_text(encoding="ascii"))
        self.assertEqual(state["phase"], "cleaned")
        self.assertEqual(state["keyPath"], "removed")
        self.assertFalse(Path(prepared["state"]["keyPath"]).exists())
        actions = [(call[6], call[7]) for call in self.cli_calls()]
        self.assertIn(("scheduler", "delete-schedule"), actions)
        self.assertIn(("iam", "delete-role"), actions)
        self.assertIn(("ec2", "delete-security-group"), actions)
        self.assertIn(("ec2", "delete-key-pair"), actions)

    def test_cleanup_reconciles_missing_instance_id_by_client_token_and_exact_tags(self) -> None:
        prepared = self.prepare_and_launch()
        run_id = prepared["runId"]
        terminated = self.invoke("terminate", "--run-id", run_id, "--confirm", MODULE._terminate_approval(run_id))
        self.assertEqual(terminated.returncode, 0, terminated.stderr)
        state_path = self.state / f"{run_id}.json"
        state = json.loads(state_path.read_text(encoding="ascii"))
        state.pop("instanceId")
        state_path.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="ascii")
        state_path.chmod(0o600)
        cleaned = self.invoke("cleanup", "--run-id", run_id, "--confirm", MODULE._cleanup_approval(run_id))
        self.assertEqual(cleaned.returncode, 0, cleaned.stderr)
        calls = self.cli_calls()
        filtered_describes = [json.loads(call[call.index("--filters") + 1]) for call in calls if call[6:8] == ["ec2", "describe-instances"] and "--filters" in call]
        self.assertTrue(any({item["Name"] for item in filters} == {"client-token"} for filters in filtered_describes))
        self.assertTrue(any({item["Name"] for item in filters} == {"tag:McAwsDisposableQualification", "tag:McAwsRunId"} for filters in filtered_describes))


if __name__ == "__main__":
    unittest.main()
