import { describe, expect, it } from "vitest";
import {
  SHELL_RUNNER_RUN_MOUNT_ACCESS,
  SHELL_RUNNER_RUN_MOUNT_DEVICES,
  SHELL_RUNNER_RUN_MOUNT_EXECUTION,
  SHELL_RUNNER_RUN_MOUNT_FILESYSTEMS,
  SHELL_RUNNER_RUN_MOUNT_ROOTS,
  SHELL_RUNNER_RUN_MOUNT_SUID,
  SHELL_RUNNER_SAFE_ERRNOS,
  SHELL_RUNNER_SANDBOX_PHASES,
  SHELL_RUNNER_STARTUP_PHASES,
  shellRunnerSafeErrno,
  shellRunnerUnavailableMessage,
} from "./shell-runner-startup";

describe("shell runner startup diagnostics", () => {
  it("emits only fixed startup phase identifiers", () => {
    expect(SHELL_RUNNER_STARTUP_PHASES).toEqual([
      "mode-validation",
      "sandbox-validation",
      "toolchain-validation",
      "server-initialization",
      "socket-activation",
      "socket-listen",
      "request-serving",
    ]);
    expect(SHELL_RUNNER_STARTUP_PHASES.map((phase) => shellRunnerUnavailableMessage(phase))).toEqual(
      SHELL_RUNNER_STARTUP_PHASES.map((phase) => `mc-agent shell runner unavailable (${phase}).\n`)
    );
  });

  it("keeps sandbox diagnostics finite and path-free", () => {
    expect(SHELL_RUNNER_SANDBOX_PHASES).toEqual([
      "principal-platform",
      "principal-user",
      "principal-groups",
      "cgroup-path",
      "cgroup-membership",
      "cgroup-memory",
      "cgroup-tasks",
      "mount-table",
      "workspace-metadata",
      "workspace-mount",
      "toolchain-mount",
      "runtime-current-mount",
      "runtime-node-mount",
      "inaccessible-run",
      "inaccessible-credentials",
      "inaccessible-config",
      "inaccessible-executor-state",
      "inaccessible-executor-root",
      "inaccessible-read-root",
      "inaccessible-write-root",
      "changes-metadata",
      "changes-mount",
      "changes-inaccessible",
    ]);
    expect(SHELL_RUNNER_SANDBOX_PHASES.every((phase) => !phase.includes("/"))).toBe(true);
  });

  it("maps exceptions to an allowlisted errno without emitting exception data", () => {
    expect(SHELL_RUNNER_SAFE_ERRNOS).toEqual(["none", "EACCES", "ENOENT", "ENOTDIR", "ELOOP", "EPERM", "EIO", "other"]);
    const secret = Object.assign(new Error("credential=must-not-appear"), {
      code: "ENOENT",
      path: "/credential/path/must-not-appear",
    });
    const message = shellRunnerUnavailableMessage(
      "sandbox-validation",
      "cgroup-membership",
      shellRunnerSafeErrno(secret)
    );
    expect(message).toBe(
      "mc-agent shell runner unavailable (sandbox-validation; sandbox=cgroup-membership; errno=ENOENT).\n"
    );
    expect(message).not.toMatch(/credential|must-not-appear|\/credential\/path/);
    expect(shellRunnerSafeErrno(Object.assign(new Error("private"), { code: "SECRET_VALUE" }))).toBe("other");
    expect(shellRunnerSafeErrno(new Error("private"))).toBe("none");
  });

  it("emits /run metadata only through finite identifiers", () => {
    expect(SHELL_RUNNER_RUN_MOUNT_ROOTS).toEqual([
      "systemd-inaccessible",
      "filesystem-root",
      "other",
      "not-mountpoint",
      "missing",
      "malformed",
      "unresolved",
    ]);
    expect(SHELL_RUNNER_RUN_MOUNT_FILESYSTEMS).toEqual(["tmpfs", "other", "unknown"]);
    expect(SHELL_RUNNER_RUN_MOUNT_ACCESS).toEqual(["rw", "ro", "unknown"]);
    expect(SHELL_RUNNER_RUN_MOUNT_SUID).toEqual(["nosuid", "suid", "unknown"]);
    expect(SHELL_RUNNER_RUN_MOUNT_DEVICES).toEqual(["nodev", "dev", "unknown"]);
    expect(SHELL_RUNNER_RUN_MOUNT_EXECUTION).toEqual(["noexec", "exec", "unknown"]);

    const diagnostic = Object.assign(
      {
        root: "filesystem-root" as const,
        filesystem: "tmpfs" as const,
        access: "rw" as const,
        suid: "nosuid" as const,
        devices: "nodev" as const,
        execution: "exec" as const,
      },
      { rawSource: "/run/private/credential=must-not-appear" }
    );
    const message = shellRunnerUnavailableMessage("sandbox-validation", "inaccessible-run", "none", diagnostic);
    expect(message).toBe(
      "mc-agent shell runner unavailable (sandbox-validation; sandbox=inaccessible-run; errno=none; run-root=filesystem-root; run-fs=tmpfs; run-access=rw; run-suid=nosuid; run-devices=nodev; run-execution=exec).\n"
    );
    expect(message).not.toMatch(/credential|must-not-appear|\/run\/private/);
  });
});
