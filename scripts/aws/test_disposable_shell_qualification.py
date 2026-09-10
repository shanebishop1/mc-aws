#!/usr/bin/env python3
"""Deterministic stdlib-only tests for the disposable shell probe helpers."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import signal
import socket
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from typing import Any
from unittest import mock


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("disposable_shell_qualification", ROOT / "disposable_shell_qualification.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LocalUnixRunnerFixture:
    """Real AF_UNIX fixture with a local subprocess, never used by qualification itself."""

    def __init__(self, root: Path, workspace: Path, changes: Path) -> None:
        self.socket_path = root / "runner.sock"
        self.workspace = workspace
        self.changes = changes
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(self.socket_path))
        self.server.listen()
        self.server.settimeout(0.1)
        self.stopping = threading.Event()
        self.errors: list[BaseException] = []
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while not self.stopping.is_set():
            try:
                connection, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                with connection:
                    connection.settimeout(2)
                    request_bytes = bytearray()
                    while True:
                        chunk = connection.recv(64 * 1024)
                        if not chunk:
                            break
                        request_bytes.extend(chunk)
                    if not request_bytes.endswith(b"\n") or request_bytes.count(b"\n") != 1:
                        raise ValueError("fixture request framing")
                    request = json.loads(bytes(request_bytes[:-1]).decode("utf-8"))
                    response = self._run(request)
                    connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))
                    connection.shutdown(socket.SHUT_WR)
            except BaseException as error:
                self.errors.append(error)

    def _run(self, request: dict[str, Any]) -> dict[str, Any]:
        environment = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "TMPDIR": str(self.changes), "LC_ALL": "C"}
        child = subprocess.Popen(
            ["/bin/sh", "-c", request["command"]],
            cwd=self.workspace,
            env=environment,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        try:
            output, _ = child.communicate(timeout=request["timeoutMs"] / 1000)
        except subprocess.TimeoutExpired:
            if child.pid is not None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            if child.stdout is not None:
                child.stdout.close()
            return {
                "schemaVersion": 1,
                "exitCode": 126,
                "output": "",
                "outputBytes": 0,
                "outputSha256": "0" * 64,
                "truncated": False,
            }
        if child.stdout is not None:
            child.stdout.close()
        if len(output) > request["maxOutputBytes"]:
            return {
                "schemaVersion": 1,
                "exitCode": 126,
                "output": "",
                "outputBytes": 0,
                "outputSha256": "0" * 64,
                "truncated": False,
            }
        output_text = output.decode("utf-8")
        response: dict[str, Any] = {
            "schemaVersion": 1,
            "exitCode": child.returncode,
            "output": output_text,
            "outputBytes": len(output),
            "outputSha256": hashlib.sha256(output).hexdigest(),
            "truncated": False,
        }
        change = request.get("change")
        if request["mode"] == "staged-write" and change["operation"] == "replace" and child.returncode == 0:
            result = self.changes / "result"
            metadata = result.lstat()
            if not result.is_file() or result.is_symlink() or metadata.st_nlink != 1 or metadata.st_size > 1024 * 1024:
                raise ValueError("fixture staged result metadata")
            staged = result.read_bytes()
            response["stagedResult"] = {
                "regularFile": True,
                "noLink": True,
                "bytes": base64.b64encode(staged).decode("ascii"),
                "sha256": hashlib.sha256(staged).hexdigest(),
            }
        return response

    def close(self) -> None:
        self.stopping.set()
        self.server.close()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise AssertionError("local Unix fixture did not stop")
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        if self.errors:
            raise AssertionError(f"local Unix fixture failed: {self.errors[0]}")


class OneResponseUnixServer:
    """Real Unix stream server for malformed response and framing cases."""

    def __init__(self, root: Path, response: bytes) -> None:
        self.socket_path = root / "malformed.sock"
        self.response = response
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(self.socket_path))
        self.server.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        connection, _ = self.server.accept()
        with connection:
            while connection.recv(64 * 1024):
                pass
            connection.sendall(self.response)
            connection.shutdown(socket.SHUT_WR)
        self.server.close()

    def close(self) -> None:
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise AssertionError("one-response Unix fixture did not stop")
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass


class TimedUnixServer:
    """Real Unix stream server that intentionally never responds or drips bytes."""

    def __init__(self, root: Path, response: bytes | None = None, byte_delay: float = 0.0) -> None:
        self.socket_path = root / "timed.sock"
        self.response = response
        self.byte_delay = byte_delay
        self.release = threading.Event()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(self.socket_path))
        self.server.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        try:
            connection, _ = self.server.accept()
            with connection:
                while connection.recv(64 * 1024):
                    pass
                if self.response is None:
                    self.release.wait(3)
                else:
                    for byte in self.response:
                        try:
                            connection.send(bytes((byte,)))
                        except OSError:
                            break
                        if self.byte_delay:
                            time.sleep(self.byte_delay)
        finally:
            self.server.close()

    def close(self) -> None:
        self.release.set()
        self.server.close()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise AssertionError("timed Unix fixture did not stop")
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass


class DisposableShellQualificationTests(unittest.TestCase):
    def test_trusted_installer_command_uses_host_bash_without_shell_substitution(self) -> None:
        command = MODULE.trusted_installer_command(
            Path("/var/tmp/host-release/host/mc-agent-install.sh"),
            Path("/var/tmp/host-release/toolchain"),
            "a" * 64,
            123,
        )
        self.assertEqual(
            command,
            [
                "/usr/bin/bash",
                "/var/tmp/host-release/host/mc-agent-install.sh",
                "install-toolchain",
                "/var/tmp/host-release/toolchain",
                "a" * 64,
                "123",
            ],
        )
        self.assertNotEqual(command[0], "/var/tmp/host-release/toolchain/bin/sh")

    def test_run_process_records_bounded_oserror_without_output(self) -> None:
        events: list[dict[str, object]] = []
        with self.assertRaises(MODULE.QualificationError):
            MODULE.run_process("missing trusted command", ["/var/tmp/does-not-exist"], events)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["label"], "missing trusted command")
        self.assertEqual(events[0]["returnCode"], None)
        self.assertEqual(events[0]["exceptionClass"], "FileNotFoundError")
        self.assertIsInstance(events[0]["errno"], int)
        self.assertNotIn("stdout", events[0])
        self.assertNotIn("stderr", events[0])

    def test_safe_relative_rejects_absolute_and_parent_paths(self) -> None:
        for value in ("/absolute", "../parent", "nested/../parent", "", "./dot"):
            with self.subTest(value=value), self.assertRaises(MODULE.QualificationError):
                MODULE.safe_relative(value)

    def test_normalized_tar_member_name_accepts_only_directory_trailing_slash(self) -> None:
        directory = tarfile.TarInfo("node-v22.19.0-linux-arm64/include/node/prov/")
        directory.type = tarfile.DIRTYPE
        self.assertEqual(
            MODULE.normalized_tar_member_name(directory),
            "node-v22.19.0-linux-arm64/include/node/prov",
        )
        regular = tarfile.TarInfo("node-v22.19.0-linux-arm64/bin/node")
        regular.type = tarfile.REGTYPE
        self.assertEqual(MODULE.normalized_tar_member_name(regular), regular.name)
        linked = tarfile.TarInfo("node-v22.19.0-linux-arm64/bin/node")
        linked.type = tarfile.SYMTYPE
        self.assertFalse(linked.isfile())
        self.assertEqual(MODULE.normalized_tar_member_name(linked), linked.name)

    def test_static_verify_parser_allows_only_exact_expected_diagnostics(self) -> None:
        diagnostics = "\n".join(MODULE.STATIC_VERIFY_EXPECTED_DIAGNOSTICS) + "\n"
        self.assertEqual(
            MODULE.parse_static_verify_result(1, "", diagnostics),
            {"owned": MODULE.STATIC_VERIFY_EXPECTED_DIAGNOSTICS, "advisory": []},
        )
        with self.assertRaises(MODULE.QualificationError):
            MODULE.parse_static_verify_result(1, "", diagnostics + "mc-agent-tool-read.service: unexpected diagnostic\n")
        with self.assertRaises(MODULE.QualificationError):
            MODULE.parse_static_verify_result(1, "", diagnostics + "/var/lib/systemd/unknown: unclassified diagnostic\n")

    def test_static_verify_parser_records_ami_acpid_warning_as_advisory(self) -> None:
        expected = "\n".join(MODULE.STATIC_VERIFY_EXPECTED_DIAGNOSTICS)
        result = MODULE.parse_static_verify_result(
            1,
            "",
            expected
            + "\n/usr/lib/systemd/system/acpid.socket:6: ListenStream= references legacy /var/run/acpid.socket\n",
        )
        self.assertEqual(result["owned"], MODULE.STATIC_VERIFY_EXPECTED_DIAGNOSTICS)
        self.assertEqual(
            result["advisory"],
            ["/usr/lib/systemd/system/acpid.socket:6: ListenStream= references legacy /var/run/acpid.socket"],
        )
        with self.assertRaises(MODULE.QualificationError):
            MODULE.parse_static_verify_result(1, "", expected + "\nmc-agent-executor.service: unexpected diagnostic\n")

    def test_checked_in_service_sources_match_exact_node_and_bind_contract(self) -> None:
        for name in ("mc-agent-tool-read.service", "mc-agent-tool-write.service"):
            MODULE.validate_shell_unit_source(ROOT.parent.parent / "infra/src/ec2" / name, name)

    def test_checked_regular_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-test-") as directory:
            root = Path(directory)
            source = root / "source"
            source.write_bytes(b"fixture")
            link = root / "link"
            link.symlink_to(source)
            with self.assertRaises(MODULE.QualificationError):
                MODULE.checked_regular(link, "fixture")

    def test_validate_toolchain_layout_requires_exact_prebuilt_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-toolchain-") as directory:
            root = Path(directory)
            payload = root / "payload"
            for relative in MODULE.TOOLCHAIN_FILES:
                path = payload / relative
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                path.write_bytes(b"fixture-manifest" if relative == "shell-toolchain.json" else b"fixture")
                path.chmod(0o755 if relative in {"bin/sh", "build/build-shell-toolchain.sh"} else 0o644)
            manifest = payload / "shell-toolchain.json"
            lock = {
                "schemaVersion": 1,
                "manifest": {"bytes": manifest.stat().st_size, "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()},
                "executable": {"path": "bin/sh", "bytes": 7, "sha256": hashlib.sha256(b"fixture").hexdigest()},
            }
            lock_path = payload / "build/shell-toolchain-lock.json"
            lock_path.write_text(json.dumps(lock, separators=(",", ":")), encoding="ascii")
            with mock.patch.multiple(
                MODULE,
                REVIEWED_TOOLCHAIN_MANIFEST_BYTES=manifest.stat().st_size,
                REVIEWED_TOOLCHAIN_MANIFEST_SHA256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
                REVIEWED_TOOLCHAIN_LOCK_BYTES=lock_path.stat().st_size,
                REVIEWED_TOOLCHAIN_LOCK_SHA256=hashlib.sha256(lock_path.read_bytes()).hexdigest(),
                REVIEWED_TOOLCHAIN_LOCK=lock,
            ):
                MODULE.validate_toolchain_layout(payload)
                archive = root / "local-disposable-toolchain.zip"
                with zipfile.ZipFile(archive, "w") as package:
                    for relative in MODULE.TOOLCHAIN_FILES:
                        info = zipfile.ZipInfo(f"toolchain/{relative}")
                        info.external_attr = (stat.S_IFREG | (0o755 if relative in {"bin/sh", "build/build-shell-toolchain.sh"} else 0o644)) << 16
                        package.writestr(info, (payload / relative).read_bytes())
                extracted = root / "extracted"
                MODULE.extract_host_archive(archive, extracted)
                MODULE.validate_toolchain_layout(extracted / "toolchain")
                extra = payload / "unexpected"
                extra.write_bytes(b"not reviewed")
                with self.assertRaises(MODULE.QualificationError):
                    MODULE.validate_toolchain_layout(payload)
            with self.assertRaises(MODULE.QualificationError):
                manifest.write_bytes(b"not the reviewed manifest")
                MODULE.validate_toolchain_layout(payload)

    def test_reviewed_toolchain_lock_is_the_repo_pinned_lock(self) -> None:
        lock_path = ROOT.parent.parent / "agent-runtime/shell-toolchain-lock.json"
        self.assertEqual(json.loads(lock_path.read_text(encoding="ascii")), MODULE.REVIEWED_TOOLCHAIN_LOCK)
        self.assertEqual(lock_path.stat().st_size, MODULE.REVIEWED_TOOLCHAIN_LOCK_BYTES)
        self.assertEqual(hashlib.sha256(lock_path.read_bytes()).hexdigest(), MODULE.REVIEWED_TOOLCHAIN_LOCK_SHA256)

    def test_host_release_requires_exact_local_disposable_packaging_mode(self) -> None:
        base = {
            "schemaVersion": 1,
            "release": "mc-aws-host-runtime",
            "releaseVersion": 1,
            "packagingMode": "qualified",
            "bootstrapPins": {},
            "files": [],
            "agentRuntime": {},
            "shellToolchain": {},
        }
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-release-") as directory:
            stage = Path(directory)
            with self.assertRaisesRegex(MODULE.QualificationError, "manifest identity"):
                MODULE.validate_host_release(stage, base)
            base["packagingMode"] = "local-disposable"
            with self.assertRaisesRegex(MODULE.QualificationError, "file inventory"):
                MODULE.validate_host_release(stage, base)
            base["unexpected"] = True
            with self.assertRaisesRegex(MODULE.QualificationError, "manifest fields"):
                MODULE.validate_host_release(stage, base)

    def test_socket_request_uses_a_real_unix_stream_and_consumes_framed_eof(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-socket-") as directory:
            root = Path(directory)
            response = {"schemaVersion": 1, "exitCode": 0, "output": "fixture\n", "outputBytes": 8, "outputSha256": hashlib.sha256(b"fixture\n").hexdigest(), "truncated": False}
            server = OneResponseUnixServer(root, (json.dumps(response) + "\n").encode("utf-8"))
            try:
                self.assertEqual(MODULE.socket_request(str(server.socket_path), {"request": "fixture"}), response)
            finally:
                server.close()

    def test_socket_request_rejects_malformed_and_invalid_staged_frames_from_a_real_server(self) -> None:
        malformed = [
            b'{"schemaVersion":1,"exitCode":0,"output":"ok","outputBytes":2,"outputSha256":"bad","truncated":false}\n',
            b'{"schemaVersion":1,"exitCode":0,"output":"ok","outputBytes":2,"outputSha256":"' + b"0" * 64 + b'","truncated":false}\n',
            b'{"schemaVersion":1,"exitCode":0,"output":"ok","outputBytes":2,"outputSha256":"' + hashlib.sha256(b"ok").hexdigest().encode("ascii") + b'","truncated":false,"stagedResult":{"bytes":"!","noLink":true,"regularFile":true,"sha256":"' + b"0" * 64 + b'"}}\n',
            b'{"schemaVersion":1,"exitCode":0,"output":"ok","outputBytes":2,"outputSha256":"' + hashlib.sha256(b"ok").hexdigest().encode("ascii") + b'","truncated":false,"stagedResult":{"bytes":"ZGF0YQ==","noLink":true,"regularFile":true,"sha256":"' + b"0" * 64 + b'"}}\n',
            b'{"schemaVersion":1,"exitCode":0,"output":"ok","outputBytes":2,"outputSha256":"' + hashlib.sha256(b"ok").hexdigest().encode("ascii") + b'","truncated":false}\nextra\n',
        ]
        for payload in malformed:
            with self.subTest(payload=payload[:40]), tempfile.TemporaryDirectory(prefix="mc-aws-probe-malformed-") as directory:
                server = OneResponseUnixServer(Path(directory), payload)
                try:
                    with self.assertRaises(MODULE.QualificationError):
                        MODULE.socket_request(str(server.socket_path), {"request": "fixture"})
                finally:
                    server.close()

    def test_socket_request_has_a_monotonic_deadline_for_a_server_that_never_responds(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-hung-") as directory:
            server = TimedUnixServer(Path(directory))
            events: list[dict[str, Any]] = []
            started = time.monotonic()
            try:
                with self.assertRaises(MODULE.QualificationError):
                    MODULE.probe_runner(
                        "00000000-0000-4000-8000-000000000000",
                        events,
                        [0],
                        str(server.socket_path),
                        "read-only",
                        ":",
                        deadline=MODULE.ProbeDeadline(0.15),
                    )
            finally:
                server.close()
            self.assertLess(time.monotonic() - started, 0.8)
            self.assertEqual(events[-1]["status"], "failed")
            self.assertEqual(events[-1]["exceptionClass"], "QualificationError")

    def test_socket_request_deadline_covers_slow_partial_response_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-slow-") as directory:
            response = b"{" + b"a" * 63
            server = TimedUnixServer(Path(directory), response, byte_delay=0.03)
            started = time.monotonic()
            try:
                with self.assertRaises(MODULE.QualificationError):
                    MODULE.socket_request(str(server.socket_path), {"request": "fixture"}, timeout=0.15)
            finally:
                server.close()
            self.assertLess(time.monotonic() - started, 0.8)

    def test_cleanup_timeout_is_bounded_and_recorded_without_running_systemd(self) -> None:
        events: list[dict[str, Any]] = []

        def timeout(*_arguments: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise subprocess.TimeoutExpired("systemctl", float(kwargs["timeout"]))

        with mock.patch.object(MODULE.subprocess, "run", side_effect=timeout):
            self.assertFalse(MODULE.cleanup_units(True, events, MODULE.ProbeDeadline(1)))
        self.assertTrue(events)
        self.assertTrue(all(event["exceptionClass"] == "TimeoutExpired" for event in events))
        self.assertTrue(all("stderr" not in event and "stdout" not in event for event in events))

    def test_process_timeout_is_capped_by_the_probe_wallclock_deadline(self) -> None:
        observed: dict[str, object] = {}

        def completed(*_arguments: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            observed["timeout"] = kwargs["timeout"]
            return subprocess.CompletedProcess([], 0, stdout="", stderr="")

        with mock.patch.object(MODULE.subprocess, "run", side_effect=completed):
            MODULE.run_process("bounded fixture process", ["/bin/true"], [], timeout=30, deadline=MODULE.ProbeDeadline(1))
        self.assertIsInstance(observed["timeout"], float)
        self.assertLessEqual(observed["timeout"], 1)

    def test_all_downstream_contract_probes_use_a_real_unix_server_and_local_subprocess_fixture(self) -> None:
        run_id = "00000000-0000-4000-8000-000000000000"
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-contract-") as directory:
            root = Path(directory)
            workspace = root / "workspace"
            changes = root / "changes"
            workspace.mkdir()
            changes.mkdir()
            server = LocalUnixRunnerFixture(root, workspace, changes)
            try:
                events: list[dict[str, Any]] = []
                counter = [0]
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "read-only",
                    "printf 'read_only_pipeline_ok\\n' | tr a-z A-Z",
                    expected_output="READ_ONLY_PIPELINE_OK\n",
                )
                workspace.chmod(0o555)
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "read-only",
                    "if touch qualification-read-only-sentinel 2>/dev/null; then printf 'READ_ONLY_WRITE_ALLOWED\\n'; else printf 'READ_ONLY_WRITE_DENIED\\n'; fi",
                    expected_output="READ_ONLY_WRITE_DENIED\n",
                )
                sentinel = root / "missing-sentinel"
                sentinel_command = "if cat '%s' >/dev/null 2>&1; then printf 'SENTINEL_READ_ALLOWED\\n'; exit 41; fi; if env | grep -E '^(AWS_|MC_AGENT_|NODE_AUTH_TOKEN)=' >/dev/null 2>&1; then printf 'CREDENTIAL_ENV_VISIBLE\\n'; exit 42; fi; printf 'SENTINELS_DENIED\\n'" % sentinel
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "read-only",
                    sentinel_command,
                    expected_output="SENTINELS_DENIED\n",
                )
                workspace.chmod(0o755)
                staged = b"STAGED_RESULT_fixture\n"
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "staged-write",
                    "printf 'STAGED_RESULT_fixture\\n' > \"$TMPDIR/result\"",
                    change={"operation": "replace", "path": "qualification-output.txt"},
                    expected_staged=staged,
                )
                # Local fixture evidence deliberately avoids opening a network socket. The
                # qualified target still runs the real AF/network-denial probe.
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "read-only",
                    "printf 'NETWORK_DENIED\\n'",
                    expected_output="NETWORK_DENIED\n",
                    timeout_ms=5_000,
                )
                MODULE.probe_runner(
                    run_id,
                    events,
                    counter,
                    str(server.socket_path),
                    "read-only",
                    "sleep 120 & wait",
                    timeout_ms=100,
                    expected_exit=126,
                )
                self.assertEqual(counter, [6])
                self.assertEqual([event["exitCode"] for event in events], [0, 0, 0, 0, 0, 126])
                self.assertEqual(events[3]["stagedBytes"], len(staged))
                self.assertEqual(events[5]["outputSha256"], "0" * 64)
                self.assertFalse((workspace / "qualification-read-only-sentinel").exists())
            finally:
                server.close()

    def test_service_stop_accepts_empty_systemctl_cgroup_and_proves_fixed_unit_cgroup_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-cgroup-") as directory:
            root = Path(directory) / "system.slice"
            cgroup = root / "mc-agent-tool-read.service"
            cgroup.mkdir(parents=True)
            (cgroup / "cgroup.events").write_text("populated 0\n", encoding="ascii")
            (cgroup / "cgroup.procs").write_text("", encoding="ascii")
            with mock.patch.object(MODULE, "SERVICE_CGROUP_ROOT", root), mock.patch.object(
                MODULE, "run_system_capture", return_value="ActiveState=inactive\nMainPID=0\nControlGroup=\n"
            ):
                evidence = MODULE.assert_service_stopped("mc-agent-tool-read.service")
            self.assertEqual(evidence["cgroup"], "populated=0")
            self.assertEqual(evidence["cgroupProcs"], "empty")

    def test_service_stop_accepts_absent_fixed_unit_cgroup_without_controlgroup_text(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mc-aws-probe-cgroup-absent-") as directory:
            root = Path(directory) / "system.slice"
            root.mkdir()
            with mock.patch.object(MODULE, "SERVICE_CGROUP_ROOT", root), mock.patch.object(
                MODULE, "run_system_capture", return_value="ActiveState=inactive\nMainPID=0\nControlGroup=\n"
            ):
                evidence = MODULE.assert_service_stopped("mc-agent-tool-read.service")
            self.assertEqual(evidence["cgroup"], "absent")


if __name__ == "__main__":
    unittest.main()
