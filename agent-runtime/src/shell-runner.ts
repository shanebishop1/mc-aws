import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ShellCommand } from "../../lib/agent/contracts";
import { MAX_SHELL_COMMAND_BYTES, MAX_SHELL_TIMEOUT_MS, parseShellCommand } from "../../lib/agent/executor/guards";
import type { UntrustedStagedResult } from "../../lib/agent/executor/types";
import type { ShellRunnerRunMountDiagnostic, ShellRunnerSandboxPhaseReporter } from "./shell-runner-startup";

export const MAX_SHELL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SHELL_RESULT_BYTES = 1024 * 1024;
export const SHELL_WORKSPACE_ROOT = "/workspace";
export const SHELL_CHANGES_ROOT = "/changes";

export interface ShellRunnerRequest extends ShellCommand {
  maxOutputBytes: number;
}

export interface ShellRunnerResponse {
  schemaVersion: 1;
  exitCode: number;
  output: string;
  outputBytes: number;
  outputSha256: string;
  truncated: boolean;
  stagedResult?: UntrustedStagedResult;
}

export interface ChildSpawnOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  onOutput(chunk: Buffer): void;
}

export interface ChildExecutionResult {
  exitCode: number;
  cleanupVerified: boolean;
}

export type ChildSpawn = (
  shellPath: string,
  command: string,
  options: ChildSpawnOptions
) => Promise<ChildExecutionResult>;

export interface ProcessStateReader {
  cgroupPath(): Promise<string>;
  cgroupPids(cgroupPath: string): Promise<readonly number[]>;
  processStartTime(pid: number): Promise<string>;
}

export interface ShellRunnerPaths {
  workspaceRoot: string;
  changesRoot: string;
}

const DEFAULT_PATHS: ShellRunnerPaths = {
  workspaceRoot: SHELL_WORKSPACE_ROOT,
  changesRoot: SHELL_CHANGES_ROOT,
};

function assertAbsolutePath(value: string, name: string): void {
  if (!path.posix.isAbsolute(value) || value.includes("\0") || path.posix.normalize(value) !== value)
    throw new Error(`${name} is invalid.`);
}

type CgroupSnapshot = Map<number, string>;

async function cgroupProcsPath(): Promise<string> {
  const cgroup = await readFile("/proc/self/cgroup", "utf8");
  const unified = cgroup
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (unified === undefined || !unified.startsWith("/") || unified.includes(".."))
    throw new Error("Unified cgroup membership is unavailable.");
  return `/sys/fs/cgroup${unified}/cgroup.procs`;
}

async function processStartTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = value.lastIndexOf(")");
  if (end < 0) throw new Error("Process identity is unavailable.");
  const fields = value
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  if (!start) throw new Error("Process identity is unavailable.");
  return start;
}

const defaultProcessStateReader: ProcessStateReader = {
  cgroupPath: cgroupProcsPath,
  async cgroupPids(cgroupPath) {
    const values = (await readFile(cgroupPath, "utf8")).trim().split(/\s+/).filter(Boolean);
    const pids: number[] = [];
    for (const value of values) {
      if (!/^\d+$/.test(value)) throw new Error("Cgroup process membership is invalid.");
      pids.push(Number(value));
    }
    return pids;
  },
  processStartTime,
};

async function cgroupSnapshot(cgroupPath: string, reader: ProcessStateReader): Promise<CgroupSnapshot> {
  const result = new Map<number, string>();
  const pids = await reader.cgroupPids(cgroupPath);
  for (const pid of pids) {
    try {
      result.set(pid, await reader.processStartTime(pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const reconciledPids = await reader.cgroupPids(cgroupPath);
      if (reconciledPids.includes(pid)) throw new Error(`Process identity disappeared while still in ${cgroupPath}.`);
    }
  }
  return result;
}

export async function assertCurrentRunnerCgroup(
  reportPhase: ShellRunnerSandboxPhaseReporter = () => {}
): Promise<void> {
  reportPhase("cgroup-path");
  const cgroupPath = await cgroupProcsPath();
  reportPhase("cgroup-membership");
  const members = await cgroupSnapshot(cgroupPath, defaultProcessStateReader);
  if (!members.has(process.pid)) throw new Error("Runner is not in its service cgroup.");
  reportPhase("cgroup-memory");
  const memory = (await readFile(cgroupPath.replace(/cgroup\.procs$/, "memory.max"), "utf8")).trim();
  if (!/^\d+$/.test(memory) || Number(memory) < 1 || Number(memory) > 96 * 1024 * 1024)
    throw new Error("Runner memory cgroup bound is unavailable.");
  reportPhase("cgroup-tasks");
  const pids = (await readFile(cgroupPath.replace(/cgroup\.procs$/, "pids.max"), "utf8")).trim();
  if (!/^\d+$/.test(pids) || Number(pids) < 1 || Number(pids) > 32)
    throw new Error("Runner process cgroup bound is unavailable.");
}

async function waitForCgroupCleanup(
  cgroupPath: string,
  baseline: CgroupSnapshot,
  reader: ProcessStateReader
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await cgroupSnapshot(cgroupPath, reader);
    const unexpected = [...current].some(([pid, start]) => baseline.get(pid) !== start);
    if (!unexpected) return true;
    await sleep(50);
  }
  return false;
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createChildSpawn(
  processStateReader: ProcessStateReader = defaultProcessStateReader,
  spawnProcess: typeof nodeSpawn = nodeSpawn
): ChildSpawn {
  return async (shellPath, command, options) => {
    const cgroupPath = await processStateReader.cgroupPath();
    const baseline = await cgroupSnapshot(cgroupPath, processStateReader);
    if (!baseline.has(process.pid)) throw new Error("Runner is not in its service cgroup.");
    return await new Promise<ChildExecutionResult>((resolve, reject) => {
      const child: ChildProcess = spawnProcess(shellPath, ["-c", command], {
        cwd: options.cwd,
        env: { ...options.env, NODE_ENV: "production" },
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let finished = false;
      let cleanupStarted = false;
      let terminationError: Error | undefined;
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Child completion must serialize termination, cleanup proof, and error propagation.
      const finish = async (error?: Error, code = -1): Promise<void> => {
        if (finished || cleanupStarted) return;
        cleanupStarted = true;
        try {
          const cleanupVerified = await waitForCgroupCleanup(cgroupPath, baseline, processStateReader);
          if (!cleanupVerified) reject(new Error("Shell child cgroup cleanup could not be proven."));
          else if (error) reject(error);
          else resolve({ exitCode: code, cleanupVerified });
        } catch (cleanupError) {
          reject(cleanupError);
        } finally {
          finished = true;
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
        }
      };
      const abort = (): void => {
        terminationError = new DOMException("Shell runner cancelled", "AbortError");
        killProcessGroup(child);
        void finish(terminationError);
      };
      child.stdout?.on("data", options.onOutput);
      child.stderr?.on("data", options.onOutput);
      child.once("error", (error) => void finish(error));
      child.once("close", (code) => void finish(terminationError, code ?? -1));
      options.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        terminationError = new Error("Shell command exceeded its timeout.");
        killProcessGroup(child);
        void finish(terminationError);
      }, options.timeoutMs);
      timer.unref?.();
      if (options.signal.aborted) abort();
    });
  };
}

const defaultSpawn: ChildSpawn = createChildSpawn();

async function readStagedResult(changesRoot: string): Promise<UntrustedStagedResult> {
  const handle = await open(`${changesRoot}/result`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o111) !== 0 ||
      metadata.size > MAX_SHELL_RESULT_BYTES
    )
      throw new Error("Shell staged result is not a bounded regular file.");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new Error("Shell staged result changed during read.");
    return {
      regularFile: true,
      noLink: true,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

/** Runs only after the caller supplies an explicit test child adapter or a proven service cgroup. */
export async function runShellCommand(
  shellPath: string,
  request: ShellRunnerRequest,
  spawnChild: ChildSpawn = defaultSpawn,
  changesRoot = SHELL_CHANGES_ROOT,
  signal = new AbortController().signal,
  paths: ShellRunnerPaths = { ...DEFAULT_PATHS, changesRoot }
): Promise<ShellRunnerResponse> {
  const { maxOutputBytes, ...contractRequest } = request;
  const command = parseShellCommand(contractRequest);
  if (
    shellPath.length === 0 ||
    command.timeoutMs > MAX_SHELL_TIMEOUT_MS ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_SHELL_OUTPUT_BYTES
  )
    throw new Error("Shell runner configuration or output bound is invalid.");
  assertAbsolutePath(paths.workspaceRoot, "Shell workspace root");
  assertAbsolutePath(paths.changesRoot, "Shell changes root");
  if (changesRoot !== paths.changesRoot) throw new Error("Shell changes root is inconsistent.");

  const outputChunks: Buffer[] = [];
  let outputBytes = 0;
  let retainedBytes = 0;
  let overflow = false;
  const digest = createHash("sha256");
  const childController = new AbortController();
  const onAbort = (): void => childController.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const onOutput = (chunk: Buffer): void => {
    if (overflow) return;
    if (chunk.byteLength > maxOutputBytes - outputBytes) {
      overflow = true;
      childController.abort();
      return;
    }
    outputBytes += chunk.byteLength;
    digest.update(chunk);
    if (retainedBytes < maxOutputBytes) {
      const retained = chunk.subarray(0, maxOutputBytes - retainedBytes);
      outputChunks.push(retained);
      retainedBytes += retained.byteLength;
    }
  };
  try {
    if (command.mode === "staged-write") await rm(`${paths.changesRoot}/result`, { force: true });
    const execution = await spawnChild(shellPath, command.command, {
      cwd: paths.workspaceRoot,
      env: Object.freeze({
        PATH: "/toolchain/bin",
        HOME: "/nonexistent",
        TMPDIR: command.mode === "staged-write" ? paths.changesRoot : "/tmp",
        LC_ALL: "C",
      }),
      signal: childController.signal,
      timeoutMs: command.timeoutMs,
      maxOutputBytes,
      onOutput,
    });
    if (overflow) throw new Error("Shell output exceeded its bound.");
    if (!execution.cleanupVerified) throw new Error("Shell child cleanup was not proven.");
    const response: ShellRunnerResponse = {
      schemaVersion: 1,
      exitCode: execution.exitCode,
      output: Buffer.concat(outputChunks).toString("utf8"),
      outputBytes,
      outputSha256: digest.digest("hex"),
      truncated: false,
    };
    if (command.mode === "staged-write" && command.change?.operation === "replace" && execution.exitCode === 0)
      response.stagedResult = await readStagedResult(paths.changesRoot);
    return response;
  } catch (error) {
    if (overflow) throw new Error("Shell output exceeded its bound.");
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface MountInfo {
  mountId: string;
  root: string;
  mountPoint: string;
  options: string[];
  filesystem: string;
}

function parseMountInfoLine(line: string, mountPoint: string): MountInfo {
  const [left, right] = line.split(" - ");
  const leftFields = left.split(" ");
  const rightFields = right?.split(" ");
  if (!rightFields?.[0] || !leftFields[0] || !leftFields[3] || !leftFields[4] || !leftFields[5] || !rightFields[2])
    throw new Error(`Mount metadata is invalid: ${mountPoint}`);
  return {
    mountId: leftFields[0],
    root: leftFields[3],
    mountPoint: leftFields[4],
    options: leftFields[5].split(","),
    filesystem: rightFields[0],
  };
}

function mountInfo(mounts: string, mountPoint: string): MountInfo {
  const line = mounts.split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === mountPoint);
  if (!line) throw new Error(`Required mount is unavailable: ${mountPoint}`);
  return parseMountInfoLine(line, mountPoint);
}

const UNKNOWN_RUN_MOUNT: Omit<ShellRunnerRunMountDiagnostic, "root"> = {
  filesystem: "unknown",
  access: "unknown",
  suid: "unknown",
  devices: "unknown",
  execution: "unknown",
};

function classifyRunMountRoot(mount: MountInfo): ShellRunnerRunMountDiagnostic["root"] {
  if (mount.mountPoint !== "/run") return "not-mountpoint";
  if (mount.root === "/systemd/inaccessible/dir") return "systemd-inaccessible";
  return mount.root === "/" ? "filesystem-root" : "other";
}

/** Reduces the exact mount reached by an open /run fd to fixed identifiers without disclosing paths or sources. */
export function classifyRunMount(mounts: string, mountId?: string): ShellRunnerRunMountDiagnostic {
  if (!mountId) return { root: "unresolved", ...UNKNOWN_RUN_MOUNT };
  const line = mounts.split("\n").find((candidate) => candidate.split(" ")[0] === mountId);
  if (!line) return { root: "missing", ...UNKNOWN_RUN_MOUNT };

  let mount: MountInfo;
  try {
    mount = parseMountInfoLine(line, "/run");
  } catch {
    return { root: "malformed", ...UNKNOWN_RUN_MOUNT };
  }

  return {
    root: classifyRunMountRoot(mount),
    filesystem: mount.filesystem === "tmpfs" ? "tmpfs" : "other",
    access: mount.options.includes("rw") ? "rw" : mount.options.includes("ro") ? "ro" : "unknown",
    suid: mount.options.includes("nosuid") ? "nosuid" : "suid",
    devices: mount.options.includes("nodev") ? "nodev" : "dev",
    execution: mount.options.includes("noexec") ? "noexec" : "exec",
  };
}

async function mountIdForFileDescriptor(fd: number): Promise<string | undefined> {
  try {
    const fdinfo = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
    return fdinfo.match(/^mnt_id:\s+(\d+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

function assertMount(mounts: string, mountPoint: string, required: readonly string[]): void {
  const mount = mountInfo(mounts, mountPoint);
  if (required.some((option) => !mount.options.includes(option)))
    throw new Error(`Mount options are unsafe: ${mountPoint}`);
}

/** Validates tmpfs identity and the per-mount VFS flags reported in mountinfo field 6. */
export function assertStagedChangesMount(mounts: string): void {
  const mount = mountInfo(mounts, SHELL_CHANGES_ROOT);
  if (
    mount.filesystem !== "tmpfs" ||
    ["rw", "nosuid", "nodev", "noexec"].some((option) => !mount.options.includes(option))
  )
    throw new Error("Shell runner changes mount is unsafe.");
}

export interface InaccessiblePathHandle {
  close(): Promise<void>;
}

export type InaccessiblePathOpener = (value: string, flags: number) => Promise<InaccessiblePathHandle>;

/** Proves that a path cannot be opened; stat alone can see a systemd mode-000 inaccessible mount point. */
export async function assertInaccessible(value: string, openPath: InaccessiblePathOpener = open): Promise<void> {
  let handle: InaccessiblePathHandle;
  try {
    handle = await openPath(value, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return;
    throw error;
  }
  try {
    throw new Error(`Runner namespace exposes ${value}.`);
  } finally {
    await handle.close();
  }
}

/** Proves the installed service namespace, not a caller-selected environment flag. */
export async function assertShellRunnerSandbox(
  mode: ShellCommand["mode"],
  reportPhase: ShellRunnerSandboxPhaseReporter = () => {}
): Promise<void> {
  reportPhase("principal-platform");
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw new Error("Shell runner must run as an unprivileged Linux ARM64 user.");
  reportPhase("principal-user");
  if (process.getuid?.() === 0) throw new Error("Shell runner must run as an unprivileged Linux ARM64 user.");
  reportPhase("principal-groups");
  const groups = process.getgroups?.() ?? [];
  if (process.getgid?.() === 0 || groups.includes(0)) throw new Error("Shell runner group isolation failed.");
  await assertCurrentRunnerCgroup(reportPhase);
  reportPhase("mount-table");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  reportPhase("workspace-metadata");
  const workspace = await stat(SHELL_WORKSPACE_ROOT);
  if (!workspace.isDirectory()) throw new Error("Shell runner workspace mount is unavailable.");
  reportPhase("workspace-mount");
  assertMount(mounts, SHELL_WORKSPACE_ROOT, ["ro"]);
  reportPhase("toolchain-mount");
  assertMount(mounts, "/toolchain", ["ro"]);
  reportPhase("runtime-current-mount");
  assertMount(mounts, "/runtime/current", ["ro"]);
  reportPhase("runtime-node-mount");
  assertMount(mounts, "/runtime/node-current", ["ro"]);
  reportPhase("inaccessible-run");
  await assertInaccessible("/run", async (value, flags) => {
    const handle = await open(value, flags);
    reportPhase("inaccessible-run", classifyRunMount(mounts, await mountIdForFileDescriptor(handle.fd)));
    return handle;
  });
  reportPhase("inaccessible-credentials");
  await assertInaccessible("/run/credentials");
  reportPhase("inaccessible-config");
  await assertInaccessible("/etc/mc-agent");
  reportPhase("inaccessible-executor-state");
  await assertInaccessible("/var/lib/mc-agent-executor");
  reportPhase("inaccessible-executor-root");
  await assertInaccessible("/runtime/executor-root");
  reportPhase("inaccessible-read-root");
  await assertInaccessible("/runtime/tool-read-root");
  reportPhase("inaccessible-write-root");
  await assertInaccessible("/runtime/tool-write-root");
  if (mode === "staged-write") {
    reportPhase("changes-metadata");
    const changes = await stat(SHELL_CHANGES_ROOT);
    if (
      !changes.isDirectory() ||
      changes.uid !== process.getuid?.() ||
      changes.gid !== process.getgid?.() ||
      (changes.mode & 0o777) !== 0o700
    )
      throw new Error("Shell runner changes mount ownership or mode is unsafe.");
    reportPhase("changes-mount");
    assertStagedChangesMount(mounts);
  } else {
    reportPhase("changes-inaccessible");
    await assertInaccessible(SHELL_CHANGES_ROOT);
  }
}
