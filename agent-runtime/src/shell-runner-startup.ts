export const SHELL_RUNNER_STARTUP_PHASES = [
  "mode-validation",
  "sandbox-validation",
  "toolchain-validation",
  "server-initialization",
  "socket-activation",
  "socket-listen",
  "request-serving",
] as const;

export type ShellRunnerStartupPhase = (typeof SHELL_RUNNER_STARTUP_PHASES)[number];

export const SHELL_RUNNER_SANDBOX_PHASES = [
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
] as const;

export type ShellRunnerSandboxPhase = (typeof SHELL_RUNNER_SANDBOX_PHASES)[number];

export const SHELL_RUNNER_RUN_MOUNT_ROOTS = [
  "systemd-inaccessible",
  "filesystem-root",
  "other",
  "not-mountpoint",
  "missing",
  "malformed",
  "unresolved",
] as const;
export type ShellRunnerRunMountRoot = (typeof SHELL_RUNNER_RUN_MOUNT_ROOTS)[number];

export const SHELL_RUNNER_RUN_MOUNT_FILESYSTEMS = ["tmpfs", "other", "unknown"] as const;
export type ShellRunnerRunMountFilesystem = (typeof SHELL_RUNNER_RUN_MOUNT_FILESYSTEMS)[number];

export const SHELL_RUNNER_RUN_MOUNT_ACCESS = ["rw", "ro", "unknown"] as const;
export type ShellRunnerRunMountAccess = (typeof SHELL_RUNNER_RUN_MOUNT_ACCESS)[number];

export const SHELL_RUNNER_RUN_MOUNT_SUID = ["nosuid", "suid", "unknown"] as const;
export type ShellRunnerRunMountSuid = (typeof SHELL_RUNNER_RUN_MOUNT_SUID)[number];

export const SHELL_RUNNER_RUN_MOUNT_DEVICES = ["nodev", "dev", "unknown"] as const;
export type ShellRunnerRunMountDevices = (typeof SHELL_RUNNER_RUN_MOUNT_DEVICES)[number];

export const SHELL_RUNNER_RUN_MOUNT_EXECUTION = ["noexec", "exec", "unknown"] as const;
export type ShellRunnerRunMountExecution = (typeof SHELL_RUNNER_RUN_MOUNT_EXECUTION)[number];

export interface ShellRunnerRunMountDiagnostic {
  root: ShellRunnerRunMountRoot;
  filesystem: ShellRunnerRunMountFilesystem;
  access: ShellRunnerRunMountAccess;
  suid: ShellRunnerRunMountSuid;
  devices: ShellRunnerRunMountDevices;
  execution: ShellRunnerRunMountExecution;
}

export type ShellRunnerSandboxPhaseReporter = (
  phase: ShellRunnerSandboxPhase,
  runMount?: ShellRunnerRunMountDiagnostic
) => void;

export const SHELL_RUNNER_SAFE_ERRNOS = [
  "none",
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EPERM",
  "EIO",
  "other",
] as const;
export type ShellRunnerSafeErrno = (typeof SHELL_RUNNER_SAFE_ERRNOS)[number];

export function shellRunnerSafeErrno(error: unknown): ShellRunnerSafeErrno {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return SHELL_RUNNER_SAFE_ERRNOS.includes(code as ShellRunnerSafeErrno) && code !== "none" && code !== "other"
    ? (code as ShellRunnerSafeErrno)
    : code === undefined
      ? "none"
      : "other";
}

/** Returns only compiled identifiers; raw exceptions, paths, environment, and credentials are never accepted. */
export function shellRunnerUnavailableMessage(
  phase: ShellRunnerStartupPhase,
  sandboxPhase?: ShellRunnerSandboxPhase,
  errno: ShellRunnerSafeErrno = "none",
  runMount?: ShellRunnerRunMountDiagnostic
): string {
  const sandbox = phase === "sandbox-validation" && sandboxPhase ? `; sandbox=${sandboxPhase}; errno=${errno}` : "";
  const mount =
    phase === "sandbox-validation" && sandboxPhase === "inaccessible-run" && runMount
      ? `; run-root=${runMount.root}; run-fs=${runMount.filesystem}; run-access=${runMount.access}; run-suid=${runMount.suid}; run-devices=${runMount.devices}; run-execution=${runMount.execution}`
      : "";
  return `mc-agent shell runner unavailable (${phase}${sandbox}${mount}).\n`;
}
