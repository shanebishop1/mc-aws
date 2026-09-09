import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { canonicalJson } from "../../lib/agent/canonical-json";
import { contained } from "../../lib/agent/executor/guards";
import type {
  CanonicalPath,
  DirectLiveHostEffects,
  DownloadRequest,
  ExecutorEntryKind,
  HostEffectResult,
  ProcessRequest,
} from "../../lib/agent/executor/types";
import { IndeterminateHostEffectError } from "../../lib/agent/executor/types";
import { isImmutableAgentAssetDirectory, isImmutableAgentAssetPath } from "../../lib/agent/immutable-assets";
import type {
  ConsoleBridgeRequest,
  HostBrokerRequest,
  MaintenanceApplyRequest,
  MaintenanceInvocationIdentity,
} from "../../lib/agent/maintenance";
import type { GatewayDownloadRelayClient } from "./download-relay";
import { EXECUTOR_JOURNAL_CREDENTIAL_PATH, assertExecutorJournalCredentialNamespace } from "./protected-input";
import { type ShellRunnerClient, UnixShellRunnerClient } from "./shell-client";
import { MAX_SHELL_OUTPUT_BYTES } from "./shell-runner";

interface ResolvedParent {
  parent: FileHandle;
  leaf: string;
  normalized: string;
  kind: ExecutorEntryKind;
}

const ROOTS = ["/workspace", "/scratch"] as const;
const MAX_CONSOLE_BYTES = 4096;
const SESSION_DIRECTORY_MODE = 0o700;
const MAX_WORKSPACE_COMMAND_ENTRIES = 10_000;
const MAX_RECURSIVE_DELETE_DEPTH = 64;
const MAX_RECURSIVE_DELETE_MS = 30_000;
const MAX_WORKSPACE_SEARCH_BYTES = 16 * 1024 * 1024;
const ATOMIC_RENAME_COMMIT = Object.freeze({ committed: true as const, point: "atomic-rename" as const });
const CONSOLE_DISPATCH_COMMIT = Object.freeze({ committed: true as const, point: "console-dispatch" as const });
const SERVER_PROPERTIES_TRANSACTION_COMMIT = Object.freeze({
  committed: true as const,
  point: "server-properties-root-generation" as const,
});
const MAINTENANCE_EDIT_COMMIT = Object.freeze({ committed: true as const, point: "maintenance-edit" as const });
const SERVER_PROPERTIES_PATH = "/workspace/server.properties";
const WORLD_ROOT_TRANSACTION_SOCKET = "/run/mc-agent-world-roots/transaction.sock";
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function safeResult(
  summary: string,
  output: Record<string, string | number | boolean>,
  mutationCommit?: HostEffectResult["mutationCommit"]
): HostEffectResult {
  return { summary, output, evidence: [], ...(mutationCommit ? { mutationCommit } : {}) };
}

function committedPoint(commit: NonNullable<HostEffectResult["mutationCommit"]>): string {
  if (commit.committed !== true || !commit.point) throw new Error("Host commit evidence is incomplete.");
  return commit.point;
}

function kindFromMode(mode: number): ExecutorEntryKind {
  const type = mode & constants.S_IFMT;
  if (type === constants.S_IFREG) return "file";
  if (type === constants.S_IFDIR) return "directory";
  if (type === constants.S_IFLNK) return "symlink";
  return "special";
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
}

function monotonicNow(): number {
  return performance.now();
}

interface DeletionBudget {
  entries: number;
  deadline: number;
  immutablePaths: string[];
}

interface DeletionIdentity {
  dev: bigint;
  ino: bigint;
  type: bigint;
}

interface DeletionPlanNode {
  name: string;
  path: string;
  kind: ExecutorEntryKind;
  identity: DeletionIdentity;
  immutable: boolean;
  children: DeletionPlanNode[];
}

function deletionIdentity(metadata: { dev: bigint; ino: bigint; mode: bigint }): DeletionIdentity {
  return { dev: metadata.dev, ino: metadata.ino, type: metadata.mode & BigInt(constants.S_IFMT) };
}

function sameDeletionIdentity(left: DeletionIdentity, right: DeletionIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

function assertDeletionBudget(signal: AbortSignal, budget: DeletionBudget, depth: number): void {
  assertNotCancelled(signal);
  if (monotonicNow() > budget.deadline) throw new Error("Recursive deletion traversal time bound exceeded.");
  if (depth > MAX_RECURSIVE_DELETE_DEPTH) throw new Error("Recursive deletion depth bound exceeded.");
  if (++budget.entries > MAX_WORKSPACE_COMMAND_ENTRIES) throw new Error("Recursive deletion entry bound exceeded.");
}

/** Classifies the exact canonical workspace path, never a suffix or lookalike. */
export function classifyDescriptorDeletionPath(
  value: string,
  immutableWorkspaceRoot = "/workspace"
): "immutable" | "mutable" {
  const normalized = path.posix.normalize(value);
  if (!contained(immutableWorkspaceRoot, normalized) || normalized === immutableWorkspaceRoot) return "mutable";
  const relative = path.posix.relative(immutableWorkspaceRoot, normalized);
  return isImmutableAgentAssetPath(relative) || isImmutableAgentAssetDirectory(relative) ? "immutable" : "mutable";
}

export interface AtomicRenameCommitHooks {
  /** Test seam invoked before the final cancellation check immediately adjacent to rename. */
  beforeCommit?(): void | Promise<void>;
  /** Authoritative renewable fence check immediately adjacent to rename. */
  assertFenceOwned?(): void | Promise<void>;
  /** Best-effort observer invoked only after rename has irreversibly committed. */
  afterCommit?(): void | Promise<void>;
}

/** The successful rename plus parent-directory fsync is the durable mutation commit point. */
export async function commitAtomicRename(
  source: string,
  destination: string,
  signal: AbortSignal,
  hooks: AtomicRenameCommitHooks = {}
): Promise<NonNullable<HostEffectResult["mutationCommit"]>> {
  await hooks.beforeCommit?.();
  assertNotCancelled(signal);
  await hooks.assertFenceOwned?.();
  assertNotCancelled(signal);
  await rename(source, destination);
  try {
    for (const directoryPath of new Set([path.dirname(source), path.dirname(destination)])) {
      const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
  } catch {
    throw new IndeterminateHostEffectError();
  }
  try {
    await hooks.afterCommit?.();
  } catch {
    // Observability after the commit point cannot change the committed outcome.
  }
  return ATOMIC_RENAME_COMMIT;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (written.bytesWritten < 1) throw new Error("Download destination write made no progress.");
    offset += written.bytesWritten;
  }
}

function normalizedConfiguredTarget(value: string, roots: readonly string[]): { normalized: string; root: string } {
  if (
    !path.posix.isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error("Path is outside configured roots.");
  }
  const normalized = path.posix.normalize(value);
  const root = roots.find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (!root) throw new Error("Path is outside configured roots.");
  return { normalized, root };
}

async function descriptorPath(handle: FileHandle, expected: string, root: string): Promise<string> {
  const observed = await readlink(`/proc/self/fd/${handle.fd}`);
  if (observed !== expected || !contained(root, observed)) {
    throw new Error("Opened descriptor failed configured-root confinement verification.");
  }
  return observed;
}

async function openVerifiedDirectory(openPath: string, expected: string, root: string): Promise<FileHandle> {
  const handle = await open(openPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Configured path is not a directory.");
    await descriptorPath(handle, expected, root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function withVerifiedParent<T>(
  value: string,
  roots: readonly string[],
  allowMissing: boolean,
  operation: (resolved: ResolvedParent) => Promise<T>
): Promise<T> {
  const { normalized, root } = normalizedConfiguredTarget(value, roots);
  if (normalized === root) throw new Error("Configured root does not have a parent inside itself.");
  const parts = path.posix.relative(root, normalized).split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Path contains an unsafe component.");
  let directory = await openVerifiedDirectory(root, root, root);
  try {
    let expectedDirectory = root;
    for (const component of parts.slice(0, -1)) {
      expectedDirectory = path.posix.join(expectedDirectory, component);
      const next = await openVerifiedDirectory(`/proc/self/fd/${directory.fd}/${component}`, expectedDirectory, root);
      await directory.close();
      directory = next;
    }
    const leaf = parts.at(-1) as string;
    let kind: ExecutorEntryKind;
    try {
      const metadata = await lstat(`/proc/self/fd/${directory.fd}/${leaf}`, { bigint: false });
      kind = kindFromMode(metadata.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error;
      kind = "missing";
    }
    return await operation({ parent: directory, leaf, normalized, kind });
  } finally {
    await directory.close();
  }
}

function sortedNames(entries: readonly { name: string }[]): string[] {
  return entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function recordDeletionClassification(
  normalized: string,
  immutableWorkspaceRoot: string,
  budget: DeletionBudget
): boolean {
  const immutable = classifyDescriptorDeletionPath(normalized, immutableWorkspaceRoot) === "immutable";
  if (immutable) budget.immutablePaths.push(normalized);
  return immutable;
}

async function openAndVerifyDeletionEntry(
  parent: FileHandle,
  name: string,
  expectedPath: string | undefined,
  expectedKind: "file" | "directory"
): Promise<{ handle: FileHandle; identity: DeletionIdentity }> {
  const target = `/proc/self/fd/${parent.fd}/${name}`;
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | (expectedKind === "directory" ? constants.O_DIRECTORY : 0)
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    const identity = deletionIdentity(metadata);
    if (kindFromMode(Number(metadata.mode)) !== expectedKind)
      throw new Error("Deletion entry changed type during traversal.");
    if (expectedPath !== undefined) {
      const descriptor = await readlink(`/proc/self/fd/${handle.fd}`);
      if (descriptor !== expectedPath) throw new Error("Deletion entry escaped descriptor confinement.");
    }
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function buildDeletionPlan(
  parent: FileHandle,
  name: string,
  normalized: string,
  immutableWorkspaceRoot: string,
  signal: AbortSignal,
  budget: DeletionBudget,
  depth: number
): Promise<DeletionPlanNode> {
  assertDeletionBudget(signal, budget, depth);
  const target = `/proc/self/fd/${parent.fd}/${name}`;
  const metadata = await lstat(target, { bigint: true });
  const kind = kindFromMode(Number(metadata.mode));
  const identity = deletionIdentity(metadata);
  const immutable = recordDeletionClassification(normalized, immutableWorkspaceRoot, budget);
  const node: DeletionPlanNode = { name, path: normalized, kind, identity, immutable, children: [] };

  if (kind === "symlink" || kind === "special") return node;
  if (kind === "file") {
    const opened = await openAndVerifyDeletionEntry(parent, name, normalized, "file");
    try {
      if (!sameDeletionIdentity(identity, opened.identity)) throw new Error("Deletion file changed during traversal.");
    } finally {
      await opened.handle.close();
    }
    return node;
  }
  if (kind !== "directory") throw new Error("Deletion target has an unsupported file type.");

  const opened = await openAndVerifyDeletionEntry(parent, name, normalized, "directory");
  try {
    if (!sameDeletionIdentity(identity, opened.identity))
      throw new Error("Deletion directory changed during traversal.");
    const names = sortedNames(await readdir(`/proc/self/fd/${opened.handle.fd}`, { withFileTypes: true }));
    for (const childName of names) {
      const childPath = path.posix.join(normalized, childName);
      node.children.push(
        await buildDeletionPlan(opened.handle, childName, childPath, immutableWorkspaceRoot, signal, budget, depth + 1)
      );
    }
    const afterNames = sortedNames(await readdir(`/proc/self/fd/${opened.handle.fd}`, { withFileTypes: true }));
    if (!sameNames(names, afterNames)) throw new Error("Deletion tree changed during descriptor traversal.");
    const afterIdentity = deletionIdentity(await opened.handle.stat({ bigint: true }));
    if (!sameDeletionIdentity(identity, afterIdentity)) throw new Error("Deletion directory changed during traversal.");
  } finally {
    await opened.handle.close();
  }
  return node;
}

function assertDeletionPlanSafe(budget: DeletionBudget): void {
  if (budget.immutablePaths.length > 0) {
    throw new Error(`Recursive deletion contains immutable asset: ${budget.immutablePaths[0]}`);
  }
}

async function verifyDeletionPlanAt(
  parent: FileHandle,
  node: DeletionPlanNode,
  signal: AbortSignal,
  budget: DeletionBudget,
  depth: number
): Promise<void> {
  assertDeletionBudget(signal, budget, depth);
  const target = `/proc/self/fd/${parent.fd}/${node.name}`;
  const metadata = await lstat(target, { bigint: true });
  const kind = kindFromMode(Number(metadata.mode));
  if (kind !== node.kind || !sameDeletionIdentity(node.identity, deletionIdentity(metadata))) {
    throw new Error("Deletion tree changed during descriptor verification.");
  }
  if (kind === "symlink" || kind === "special") throw new Error("Deletion tree contains an unsafe entry.");
  const opened = await openAndVerifyDeletionEntry(parent, node.name, node.path, kind as "file" | "directory");
  try {
    if (!sameDeletionIdentity(node.identity, opened.identity))
      throw new Error("Deletion entry changed during verification.");
    if (kind !== "directory") return;
    const names = sortedNames(await readdir(`/proc/self/fd/${opened.handle.fd}`, { withFileTypes: true }));
    const expectedNames = node.children.map((child) => child.name);
    if (!sameNames(names, expectedNames)) throw new Error("Deletion tree changed during descriptor verification.");
    for (const child of node.children) await verifyDeletionPlanAt(opened.handle, child, signal, budget, depth + 1);
    const afterNames = sortedNames(await readdir(`/proc/self/fd/${opened.handle.fd}`, { withFileTypes: true }));
    if (!sameNames(names, afterNames)) throw new Error("Deletion tree changed during descriptor verification.");
  } finally {
    await opened.handle.close();
  }
}

function newDeletionBudget(): DeletionBudget {
  return { entries: 0, deadline: monotonicNow() + MAX_RECURSIVE_DELETE_MS, immutablePaths: [] };
}

/** Runs the complete no-side-effect recursive-delete preflight for tests and host callers. */
export async function validateDescriptorConfinedDeletion(
  value: string,
  roots: readonly string[] = ROOTS,
  signal: AbortSignal = new AbortController().signal,
  immutableWorkspaceRoot = "/workspace"
): Promise<void> {
  const { normalized } = normalizedConfiguredTarget(value, roots);
  await withVerifiedParent(normalized, roots, false, async ({ parent, leaf, kind }) => {
    const budget = newDeletionBudget();
    const immutable = recordDeletionClassification(normalized, immutableWorkspaceRoot, budget);
    if (kind !== "directory") {
      if (kind === "symlink" || kind === "special") throw new Error("Delete target is unsafe.");
      if (immutable) assertDeletionPlanSafe(budget);
      return;
    }
    const plan = await buildDeletionPlan(parent, leaf, normalized, immutableWorkspaceRoot, signal, budget, 0);
    await verifyDeletionPlanAt(parent, plan, signal, newDeletionBudget(), 0);
    assertDeletionPlanSafe(budget);
  });
}

/** Descriptor-verifies configured roots and every existing regular descendant without following symlinks. */
export async function canonicalizeDescriptorConfinedPath(
  value: string,
  roots: readonly string[] = ROOTS
): Promise<CanonicalPath> {
  const { normalized, root } = normalizedConfiguredTarget(value, roots);
  if (normalized === root) {
    const handle = await openVerifiedDirectory(root, root, root);
    try {
      return { path: await descriptorPath(handle, root, root), kind: "directory" };
    } finally {
      await handle.close();
    }
  }
  return await withVerifiedParent(normalized, roots, true, async ({ parent, leaf, kind }) => {
    if (kind === "missing" || kind === "symlink" || kind === "special") return { path: normalized, kind };
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "directory" ? constants.O_DIRECTORY : 0);
    const handle = await open(`/proc/self/fd/${parent.fd}/${leaf}`, flags);
    try {
      const verifiedKind = kindFromMode((await handle.stat()).mode);
      if (verifiedKind !== kind) throw new Error("Canonical target changed during descriptor verification.");
      return { path: await descriptorPath(handle, normalized, root), kind: verifiedKind };
    } finally {
      await handle.close();
    }
  });
}

interface ConsoleProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  env: Readonly<Record<string, string>>;
  onProgress(bytesProduced: number): void;
}

async function processOutput(request: ConsoleProcessRequest): Promise<HostEffectResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...request.env, NODE_ENV: "production" },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    const outputDigest = createHash("sha256");
    let settled = false;
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else
        resolve(
          safeResult("Command completed inside the executor namespace.", {
            exitCode: code ?? -1,
            output: Buffer.concat(chunks).toString("utf8"),
            truncated: bytes > request.maxOutputBytes,
            outputBytes: bytes,
            outputSha256: outputDigest.digest("hex"),
          })
        );
    };
    const append = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      outputDigest.update(chunk);
      request.onProgress(bytes);
      const retained = chunks.reduce((sum, item) => sum + item.byteLength, 0);
      if (retained < request.maxOutputBytes) chunks.push(chunk.subarray(0, request.maxOutputBytes - retained));
      if (bytes > request.maxOutputBytes * 2) stop();
    };
    const abort = () => {
      stop();
      finish(new DOMException("Invocation cancelled", "AbortError"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error: Error) => finish(error));
    child.once("close", (code: number | null) => finish(undefined, code));
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      stop();
      finish(new Error("Command exceeded its timeout."));
    }, request.timeoutMs);
    timer.unref();
    if (request.signal.aborted) abort();
  });
}

export interface ConsoleDispatchHooks {
  /** Test seam immediately before the final pre-dispatch cancellation fence. */
  beforeDispatch?(): void | Promise<void>;
  assertFenceOwned?(): void | Promise<void>;
}

/**
 * Cancellation is definitive only before dispatch starts. Once screen (or a future RCON transport) is invoked,
 * delivery failures are indeterminate because Minecraft may already have accepted the command.
 */
export async function dispatchMinecraftConsole(
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
  dispatch: (request: ConsoleProcessRequest) => Promise<HostEffectResult> = processOutput,
  hooks: ConsoleDispatchHooks = {}
): Promise<HostEffectResult> {
  if (!command || Buffer.byteLength(command) > MAX_CONSOLE_BYTES || /[\r\n\0]/.test(command)) {
    throw new Error("Console command is invalid.");
  }
  const request: ConsoleProcessRequest = {
    executable: "/usr/bin/screen",
    args: ["-S", "mc-server", "-p", "0", "-X", "stuff", `${command}\r`],
    cwd: "/workspace",
    timeoutMs,
    maxOutputBytes: 8192,
    signal,
    env: Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/workspace", TMPDIR: "/workspace" }),
    onProgress: () => undefined,
  };
  await hooks.beforeDispatch?.();
  assertNotCancelled(signal);
  await hooks.assertFenceOwned?.();
  assertNotCancelled(signal);
  let result: HostEffectResult;
  try {
    // Calling dispatch is the irreversible boundary: screen/RCON delivery can occur before its response is observed.
    result = await dispatch(request);
  } catch {
    throw new IndeterminateHostEffectError("console-dispatch");
  }
  if ((result.output as { exitCode?: unknown }).exitCode !== 0) {
    throw new IndeterminateHostEffectError("console-dispatch");
  }
  return safeResult(
    "Sent one bounded command through the credential-less console bridge.",
    { accepted: true, committed: true, commitPoint: CONSOLE_DISPATCH_COMMIT.point },
    CONSOLE_DISPATCH_COMMIT
  );
}

/** Creates or verifies one descriptor-anchored session directory without trusting an EEXIST path entry. */
export async function ensureOwnedSessionDirectory(scratchRoot: string, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) throw new Error("Session ID is invalid.");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("Session scratch ownership cannot be verified.");
  const root = await open(scratchRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rootPath = await readlink(`/proc/self/fd/${root.fd}`);
    const candidate = `/proc/self/fd/${root.fd}/${sessionId}`;
    try {
      await mkdir(candidate, { mode: SESSION_DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const session = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const metadata = await session.stat();
      const sessionPath = await readlink(`/proc/self/fd/${session.fd}`);
      if (
        !metadata.isDirectory() ||
        metadata.uid !== uid ||
        metadata.gid !== gid ||
        (metadata.mode & 0o777) !== SESSION_DIRECTORY_MODE ||
        path.posix.dirname(sessionPath) !== rootPath ||
        !contained(rootPath, sessionPath)
      ) {
        throw new Error("Session scratch failed ownership, mode, or confinement verification.");
      }
    } finally {
      await session.close();
    }
  } finally {
    await root.close();
  }
}

export interface ProductionSandboxOptions {
  /** Exact credential path read before the sandbox assertion. */
  journalCredentialPath?: string;
  /** Domain-separated authentication for the root-owned world-root transaction broker. */
  worldRootTransactionAuthenticationKey?: Uint8Array;
  shellReadSocketPath?: string;
  shellWriteSocketPath?: string;
  hostBrokerSocketPath?: string;
}

interface WorldRootTransactionInput {
  action: "replace" | "delete";
  stageName: string | null;
  bytes: number;
  sha256: string;
}

class WorldRootTransactionClient {
  readonly #authenticationKey: Buffer;

  constructor(
    authenticationKey: Uint8Array,
    private readonly socketPath = WORLD_ROOT_TRANSACTION_SOCKET
  ) {
    if (authenticationKey.byteLength < 32 || authenticationKey.byteLength > 1024) {
      throw new Error("World-root transaction authentication is invalid.");
    }
    this.#authenticationKey = Buffer.from(authenticationKey);
  }

  async commit(
    input: WorldRootTransactionInput,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<{ generation: string }> {
    assertNotCancelled(signal);
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let dispatched = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const finish = (error?: Error, generation?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error)
          reject(dispatched ? new IndeterminateHostEffectError(SERVER_PROPERTIES_TRANSACTION_COMMIT.point) : error);
        else resolve({ generation: generation as string });
      };
      socket.once("connect", () => {
        void (async () => {
          await assertCommitAllowed?.();
          assertNotCancelled(signal);
          const unsigned = {
            schemaVersion: 1,
            action: input.action,
            stageName: input.stageName,
            bytes: input.bytes,
            sha256: input.sha256,
            issuedAt: Date.now(),
            nonce: randomBytes(16).toString("hex"),
          };
          const mac = createHmac("sha256", this.#authenticationKey)
            .update(`mc-aws-world-root-transaction:v1\n${canonicalJson(unsigned)}`)
            .digest("base64url");
          dispatched = true;
          socket.end(`${canonicalJson({ ...unsigned, mac })}\n`);
        })().catch((error: Error) => finish(error));
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > 4096) return finish(new Error("World-root transaction response exceeded its bound."));
      });
      socket.once("end", () => {
        try {
          const response = JSON.parse(received.toString("utf8")) as Record<string, unknown>;
          if (
            Object.keys(response).sort().join(",") !== "committed,generation,schemaVersion" ||
            response.schemaVersion !== 1 ||
            response.committed !== true ||
            typeof response.generation !== "string" ||
            !/^[a-f0-9]{64}$/.test(response.generation)
          ) {
            throw new Error("World-root transaction broker rejected the mutation.");
          }
          finish(undefined, response.generation);
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.once("error", (error) => finish(error));
      const timer = setTimeout(() => finish(new Error("World-root transaction broker timed out.")), 30_000);
      timer.unref();
    });
  }
}

export class HostBrokerClient {
  readonly #authenticationKey: Buffer;

  constructor(
    authenticationKey: Uint8Array,
    private readonly socketPath: string,
    private readonly responseTimeoutMs = 120_000
  ) {
    if (authenticationKey.byteLength < 32 || authenticationKey.byteLength > 1024)
      throw new Error("Host broker authentication is invalid.");
    this.#authenticationKey = Buffer.from(authenticationKey);
  }

  async execute(
    request: HostBrokerRequest,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult> {
    assertNotCancelled(signal);
    await assertCommitAllowed?.();
    const unsigned = { ...request };
    const mac = createHmac("sha256", this.#authenticationKey)
      .update(`mc-aws-host-broker:v1\n${canonicalJson(unsigned as never)}`)
      .digest("base64url");
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let sent = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const point = request.operation === "maintenance.apply" ? "maintenance-edit" : "console-dispatch";
      const finish = (error?: Error, value?: HostEffectResult, effectMayHaveStarted = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(sent && effectMayHaveStarted ? new IndeterminateHostEffectError(point) : error);
        else resolve(value as HostEffectResult);
      };
      socket.once("connect", () => {
        void (async () => {
          assertNotCancelled(signal);
          sent = true;
          socket.end(`${canonicalJson({ ...unsigned, mac } as never)}\n`);
        })().catch((error: Error) => finish(error));
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > 64 * 1024) finish(new Error("Host broker response exceeded its bound."));
      });
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The bounded broker response is validated in one fail-closed transport boundary.
      socket.once("end", () => {
        try {
          const value = JSON.parse(received.toString("utf8")) as Record<string, unknown>;
          if (
            value.schemaVersion !== 1 ||
            typeof value.ok !== "boolean" ||
            !["not-entered", "committed", "unknown"].includes(String(value.effectState)) ||
            typeof value.output !== "object" ||
            value.output === null ||
            Array.isArray(value.output)
          ) {
            throw new Error("Host broker returned an invalid response.");
          }
          const committed = value.committed === true;
          if (
            (value.ok === true &&
              (value.verification !== "observed" ||
                value.effectState === "unknown" ||
                (value.effectState === "committed") !== committed)) ||
            (value.ok === false &&
              ((value.effectState === "not-entered" && value.verification !== "not-required") ||
                (value.effectState !== "not-entered" && value.verification !== "unresolved")))
          ) {
            throw new Error("Host broker returned inconsistent effect truth.");
          }
          if (value.effectState === "unknown" || value.verification === "unresolved") {
            throw new IndeterminateHostEffectError(point);
          }
          if (value.ok !== true) {
            finish(new Error("Host broker rejected the request before effect entry."), undefined, false);
            return;
          }
          finish(undefined, {
            summary:
              typeof value.summary === "string" ? value.summary : "Authenticated host broker operation completed.",
            output: value.output as HostEffectResult["output"],
            evidence: [],
            ...(value.committed === true
              ? { mutationCommit: point === "maintenance-edit" ? MAINTENANCE_EDIT_COMMIT : CONSOLE_DISPATCH_COMMIT }
              : {}),
          });
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.once("error", (error) => finish(error));
      const timer = setTimeout(() => finish(new Error("Host broker timed out.")), this.responseTimeoutMs);
      timer.unref();
      signal.addEventListener(
        "abort",
        () => {
          socket.destroy();
          finish(new DOMException("Invocation cancelled", "AbortError"));
        },
        { once: true }
      );
    });
  }
}

/** Linux-only production adapter; construction fails unless the systemd sandbox is observable. */
export class ProductionDirectLiveHostEffects implements DirectLiveHostEffects {
  readonly securityCapabilities = Object.freeze({
    descriptorRelativeWorkspaceConfinement: true as const,
    workspaceRootedCommandBoundary: true as const,
    pinnedDnsRedirectEgressEnforcement: true as const,
  });

  private constructor(
    private readonly downloadRelay: GatewayDownloadRelayClient,
    private readonly worldRootTransactions: WorldRootTransactionClient,
    private readonly shellReadRunner: ShellRunnerClient,
    private readonly shellWriteRunner: ShellRunnerClient,
    private readonly hostBroker: HostBrokerClient
  ) {}

  static async create(
    downloadRelay?: GatewayDownloadRelayClient,
    options?: ProductionSandboxOptions
  ): Promise<ProductionDirectLiveHostEffects> {
    await assertRuntimeSandbox(options?.journalCredentialPath);
    if (!downloadRelay) throw new Error("Executor requires the authenticated gateway download relay.");
    if (!options?.worldRootTransactionAuthenticationKey) {
      throw new Error("Executor requires world-root transaction authentication.");
    }
    const shellReadSocketPath = options.shellReadSocketPath ?? "/run/mc-agent/shell-read.sock";
    const shellWriteSocketPath = options.shellWriteSocketPath ?? "/run/mc-agent/shell-write.sock";
    return new ProductionDirectLiveHostEffects(
      downloadRelay,
      new WorldRootTransactionClient(options.worldRootTransactionAuthenticationKey),
      new UnixShellRunnerClient(shellReadSocketPath),
      new UnixShellRunnerClient(shellWriteSocketPath),
      new HostBrokerClient(
        options.worldRootTransactionAuthenticationKey,
        options.hostBrokerSocketPath ?? "/run/mc-agent/host-broker.sock"
      )
    );
  }

  async ensureSessionScratch(sessionId: string): Promise<void> {
    await ensureOwnedSessionDirectory("/scratch", sessionId);
  }

  async canonicalize(value: string): Promise<CanonicalPath> {
    return await canonicalizeDescriptorConfinedPath(value);
  }

  async readFile(value: string, maxBytes: number, signal: AbortSignal): Promise<HostEffectResult> {
    if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
    return await this.withParent(value, false, async ({ parent, leaf, kind }) => {
      if (kind !== "file") throw new Error("Read target is not a regular file.");
      const handle = await open(this.anchor(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new Error("Read target is not a regular file.");
        const retained = Buffer.alloc(Math.min(metadata.size, maxBytes));
        const read =
          retained.byteLength === 0 ? { bytesRead: 0 } : await handle.read(retained, 0, retained.byteLength, 0);
        const contentBytes = retained.subarray(0, read.bytesRead);
        const content = new TextDecoder().decode(contentBytes);
        return safeResult("Read a workspace file.", {
          content,
          bytes: metadata.size,
          contentSha256: createHash("sha256").update(contentBytes).digest("hex"),
          truncated: metadata.size > maxBytes,
        });
      } finally {
        await handle.close();
      }
    });
  }

  async writeFile(
    value: string,
    content: Uint8Array,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult> {
    if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
    return await this.withParent(value, true, async (resolved) => {
      const { parent, leaf, kind } = resolved;
      if (kind !== "file" && kind !== "missing") throw new Error("Write target is not a regular file.");
      const temporary = `.mc-agent-${process.pid}-${crypto.randomUUID()}`;
      const temporaryPath = this.anchor(parent, temporary);
      const targetPath = this.anchor(parent, leaf);
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const worldRootTransaction = resolved.normalized === SERVER_PROPERTIES_PATH;
        const transaction = worldRootTransaction
          ? await this.worldRootTransactions.commit(
              {
                action: "replace",
                stageName: temporary,
                bytes: content.byteLength,
                sha256: createHash("sha256").update(content).digest("hex"),
              },
              signal,
              assertCommitAllowed
            )
          : undefined;
        const mutationCommit = worldRootTransaction
          ? SERVER_PROPERTIES_TRANSACTION_COMMIT
          : await commitAtomicRename(temporaryPath, targetPath, signal, { assertFenceOwned: assertCommitAllowed });
        return safeResult(
          worldRootTransaction
            ? "Wrote server.properties and its canonical world-root generation transactionally."
            : "Wrote a workspace file atomically.",
          {
            bytes: content.byteLength,
            committed: true,
            commitPoint: committedPoint(mutationCommit),
            ...(transaction ? { worldRootGeneration: transaction.generation } : {}),
          },
          mutationCommit
        );
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
  }

  async deletePath(
    value: string,
    recursive: boolean,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult> {
    if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Descriptor-safe deletion and its transactional server.properties exception share one commit boundary.
    return await this.withParent(value, false, async (resolved) => {
      const { parent, leaf, kind } = resolved;
      if (kind === "directory" && !recursive) throw new Error("Directory deletion requires recursive=true.");
      if (kind === "symlink" || kind === "special" || kind === "missing") throw new Error("Delete target is unsafe.");
      const budget = newDeletionBudget();
      const plan = await buildDeletionPlan(parent, leaf, resolved.normalized, "/workspace", signal, budget, 0);
      // The approval/fence check is deliberately followed by a second complete descriptor walk.  A
      // preflight that observed a symlink or inode swap must never reach the quarantine rename.
      await assertCommitAllowed?.();
      await verifyDeletionPlanAt(parent, plan, signal, newDeletionBudget(), 0);
      assertDeletionPlanSafe(budget);
      const targetPath = this.anchor(parent, leaf);
      if (resolved.normalized === SERVER_PROPERTIES_PATH) {
        const transaction = await this.worldRootTransactions.commit(
          { action: "delete", stageName: null, bytes: 0, sha256: EMPTY_SHA256 },
          signal,
          assertCommitAllowed
        );
        return safeResult(
          "Deleted server.properties and published its canonical default world-root generation transactionally.",
          {
            recursive,
            committed: true,
            commitPoint: SERVER_PROPERTIES_TRANSACTION_COMMIT.point,
            worldRootGeneration: transaction.generation,
          },
          SERVER_PROPERTIES_TRANSACTION_COMMIT
        );
      }
      const quarantinePath = this.anchor(parent, `.mc-agent-delete-${process.pid}-${crypto.randomUUID()}`);
      await mkdir(quarantinePath, { mode: 0o700 });
      let quarantine: FileHandle;
      try {
        quarantine = await open(quarantinePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        await rmdir(quarantinePath).catch(() => undefined);
        throw error;
      }
      let mutationCommit: NonNullable<HostEffectResult["mutationCommit"]>;
      try {
        mutationCommit = await commitAtomicRename(targetPath, this.anchor(quarantine, "entry"), signal, {
          assertFenceOwned: assertCommitAllowed,
        });
      } catch (error) {
        await quarantine.close().catch(() => undefined);
        await rmdir(quarantinePath).catch(() => undefined);
        throw error;
      }
      await quarantine.close().catch(() => undefined);
      let cleanupPending = false;
      try {
        const cleanup = await open(quarantinePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (kind === "file") {
            const moved = await openAndVerifyDeletionEntry(cleanup, "entry", undefined, "file");
            try {
              if (!sameDeletionIdentity(plan.identity, moved.identity))
                throw new Error("Deletion target changed during quarantine.");
            } finally {
              await moved.handle.close().catch(() => undefined);
            }
            await unlink(this.anchor(cleanup, "entry"));
          } else {
            if (!plan) throw new Error("Recursive deletion plan is missing.");
            const moved = await openAndVerifyDeletionEntry(cleanup, "entry", undefined, "directory");
            try {
              if (!sameDeletionIdentity(plan.identity, moved.identity))
                throw new Error("Deletion target changed during quarantine.");
              await this.removeDeletionTree(moved.handle, plan, signal, newDeletionBudget(), 0);
            } finally {
              await moved.handle.close().catch(() => undefined);
            }
            await rmdir(this.anchor(cleanup, "entry"));
          }
        } finally {
          await cleanup.close().catch(() => undefined);
        }
        await rmdir(quarantinePath);
      } catch {
        cleanupPending = true;
      }
      return safeResult(
        "Deleted a workspace entry atomically.",
        { recursive, committed: true, commitPoint: committedPoint(mutationCommit), cleanupPending },
        mutationCommit
      );
    });
  }

  async executeProcess(request: ProcessRequest): Promise<HostEffectResult> {
    if (request.cwd !== "/workspace" || request.mode === undefined || request.command.length === 0) {
      throw new Error("Shell runner request is invalid.");
    }
    if (request.maxOutputBytes > MAX_SHELL_OUTPUT_BYTES)
      throw new Error("Shell output bound exceeds the runner limit.");
    const runner = request.mode === "read-only" ? this.shellReadRunner : this.shellWriteRunner;
    const response = await runner.execute(request, request.signal);
    return {
      summary: "Reviewed shell runner returned untrusted command data.",
      output: {
        exitCode: response.exitCode,
        output: response.output,
        outputBytes: response.outputBytes,
        outputSha256: response.outputSha256,
        truncated: response.truncated,
      },
      evidence: [],
      ...(response.stagedResult ? { stagedResult: response.stagedResult } : {}),
    };
  }

  async executeConsole(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>,
    invocation?: MaintenanceInvocationIdentity
  ): Promise<HostEffectResult> {
    if (!invocation) throw new Error("Minecraft console bridge is unavailable under the separated executor identity.");
    const request: ConsoleBridgeRequest = {
      schemaVersion: 1,
      operation: "console.execute",
      invocation,
      command,
      timeoutMs,
    };
    return await this.hostBroker.execute(request, signal, assertCommitAllowed);
  }

  async applyMaintenance(
    request: MaintenanceApplyRequest,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult> {
    return await this.hostBroker.execute(request, signal, assertCommitAllowed);
  }

  async download(request: DownloadRequest): Promise<HostEffectResult> {
    if (request.signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
    return await this.withParent(request.destination, true, async (resolved) => {
      const { parent, leaf, kind } = resolved;
      if (kind !== "file" && kind !== "missing") throw new Error("Download target is not a regular file.");
      const authorization = request.authorization;
      if (
        !authorization ||
        authorization.invocationId !== request.invocationId ||
        authorization.sessionId !== request.sessionId ||
        authorization.url !== request.url ||
        authorization.expectedSha256 !== request.expectedSha256 ||
        authorization.expectedBytes !== request.expectedBytes ||
        authorization.maxBytes !== request.maxBytes ||
        authorization.timeoutMs !== request.timeoutMs
      ) {
        throw new Error("Gateway download authorization did not match the invocation.");
      }
      const temporary = `.mc-agent-download-${process.pid}-${crypto.randomUUID()}`;
      const temporaryPath = this.anchor(parent, temporary);
      const targetPath = this.anchor(parent, leaf);
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        const relayed = await this.downloadRelay.download(authorization, request.signal, async (chunk, received) => {
          await writeAll(handle, chunk);
          request.onProgress(received);
        });
        await handle.sync();
        await handle.close();
        const worldRootTransaction = resolved.normalized === SERVER_PROPERTIES_PATH;
        const transaction = worldRootTransaction
          ? await this.worldRootTransactions.commit(
              {
                action: "replace",
                stageName: temporary,
                bytes: relayed.bytes,
                sha256: relayed.contentDigest,
              },
              request.signal,
              request.assertCommitAllowed
            )
          : undefined;
        const mutationCommit = worldRootTransaction
          ? SERVER_PROPERTIES_TRANSACTION_COMMIT
          : await commitAtomicRename(temporaryPath, targetPath, request.signal, {
              assertFenceOwned: request.assertCommitAllowed,
            });
        return safeResult(
          "Downloaded a gateway-validated HTTPS resource.",
          {
            bytes: relayed.bytes,
            contentType: relayed.contentType,
            sha256: relayed.contentDigest,
            finalUrl: relayed.finalUrl,
            committed: true,
            commitPoint: committedPoint(mutationCommit),
            ...(transaction ? { worldRootGeneration: transaction.generation } : {}),
          },
          mutationCommit
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
  }

  async requestBackup(_label: string, _signal: AbortSignal): Promise<HostEffectResult> {
    throw new Error("Backups are available only through the gateway typed backup adapter.");
  }

  async loadExtension(_value: string, _signal: AbortSignal): Promise<HostEffectResult> {
    throw new Error(
      "Workspace extension loading is unavailable; configured bundles load only from the immutable runtime release."
    );
  }

  private anchor(parent: FileHandle, leaf: string): string {
    return `/proc/self/fd/${parent.fd}/${leaf}`;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact command grammar and bounded read-only actions share one fail-closed dispatcher.
  private async executeWorkspaceCommand(request: ConsoleProcessRequest): Promise<HostEffectResult> {
    const [action, ...rawArgs] = request.args;
    if (!action) throw new Error("Workspace command requires an action.");
    const lines: string[] = [];
    let outputBytes = 0;
    let rawOutputBytes = 0;
    let truncated = false;
    const outputDigest = createHash("sha256");
    const append = (line: string) => {
      const encoded = Buffer.from(`${line}\n`);
      const bytes = encoded.byteLength;
      rawOutputBytes += bytes;
      outputDigest.update(encoded);
      if (outputBytes + bytes > request.maxOutputBytes) {
        truncated = true;
        return;
      }
      outputBytes += bytes;
      lines.push(line);
      request.onProgress(outputBytes);
    };
    if (action === "list") {
      const recursive = rawArgs.includes("--recursive");
      const targets = rawArgs.filter((value) => value !== "--recursive");
      if (targets.some((value) => value.startsWith("-"))) throw new Error("Unknown workspace list option.");
      for (const target of targets.length > 0 ? targets : ["."]) {
        await this.walkWorkspace(target, recursive, request.signal, ({ relative, kind }) =>
          append(`${kind}\t${relative}`)
        );
      }
    } else if (action === "stat") {
      if (rawArgs.length === 0 || rawArgs.some((value) => value.startsWith("-"))) {
        throw new Error("Workspace stat requires paths without options.");
      }
      for (const target of rawArgs) {
        const opened = await this.openWorkspaceTarget(target);
        try {
          const metadata = await opened.handle.stat();
          append(`${opened.kind}\t${opened.relative}\t${metadata.size}\t${(metadata.mode & 0o777).toString(8)}`);
        } finally {
          await opened.handle.close();
        }
      }
    } else if (action === "compare") {
      if (rawArgs.length !== 2 || rawArgs.some((value) => value.startsWith("-"))) {
        throw new Error("Workspace compare requires exactly two files.");
      }
      append((await this.compareWorkspaceFiles(rawArgs[0], rawArgs[1], request.signal)) ? "equal" : "different");
    } else if (action === "search") {
      const [needle, ...targets] = rawArgs;
      if (!needle || Buffer.byteLength(needle) > 4096 || needle.startsWith("-")) {
        throw new Error("Workspace search requires a bounded literal query.");
      }
      let scannedBytes = 0;
      for (const target of targets.length > 0 ? targets : ["."]) {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Search visitor enforces all file, byte, line, and output bounds before collecting a match.
        await this.walkWorkspace(target, true, request.signal, async ({ handle, relative, kind }) => {
          if (kind !== "file" || scannedBytes >= MAX_WORKSPACE_SEARCH_BYTES) return;
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > 1024 * 1024) return;
          scannedBytes += metadata.size;
          if (scannedBytes > MAX_WORKSPACE_SEARCH_BYTES) return;
          const content = await handle.readFile("utf8");
          for (const [index, line] of content.split(/\r?\n/).entries()) {
            if (line.includes(needle)) append(`${relative}:${index + 1}:${line}`);
          }
        });
      }
    } else {
      throw new Error("Unknown workspace command action.");
    }
    return safeResult("Workspace-rooted command completed without spawning a raw executable.", {
      exitCode: 0,
      output: lines.join("\n"),
      outputBytes: rawOutputBytes,
      outputSha256: outputDigest.digest("hex"),
      truncated,
    });
  }

  private async openWorkspaceTarget(value: string): Promise<{
    handle: FileHandle;
    relative: string;
    kind: "file" | "directory";
  }> {
    if (!value || value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) {
      throw new Error("Workspace command path is unsafe.");
    }
    const absolute = path.posix.isAbsolute(value)
      ? path.posix.normalize(value)
      : path.posix.resolve("/workspace", value);
    if (!contained("/workspace", absolute)) throw new Error("Workspace command path escaped its root.");
    const parts = path.posix.relative("/workspace", absolute).split("/").filter(Boolean);
    let handle = await open("/workspace", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const component of parts) {
        const next = await open(this.anchor(handle, component), constants.O_RDONLY | constants.O_NOFOLLOW);
        await handle.close();
        handle = next;
      }
      const metadata = await handle.stat();
      const kind = kindFromMode(metadata.mode);
      if (kind === "missing" || kind === "symlink" || kind === "special") {
        throw new Error("Workspace command target is unsafe.");
      }
      return { handle, relative: path.posix.relative("/workspace", absolute) || ".", kind };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async walkWorkspace(
    value: string,
    recursive: boolean,
    signal: AbortSignal,
    visit: (entry: { handle: FileHandle; relative: string; kind: "file" | "directory" }) => void | Promise<void>
  ): Promise<void> {
    const root = await this.openWorkspaceTarget(value);
    let entries = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Descriptor walk bounds cancellation, entries, file kinds, and recursion in one security-critical loop.
    const walk = async (handle: FileHandle, relative: string, kind: "file" | "directory"): Promise<void> => {
      if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
      if (++entries > MAX_WORKSPACE_COMMAND_ENTRIES) throw new Error("Workspace command entry bound exceeded.");
      await visit({ handle, relative, kind });
      if (kind !== "directory") return;
      const children = (await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const child of children) {
        const childHandle = await open(this.anchor(handle, child.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const childMode = (await childHandle.stat()).mode;
          const childKind = kindFromMode(childMode);
          if (childKind !== "file" && childKind !== "directory") continue;
          const childRelative = relative === "." ? child.name : path.posix.join(relative, child.name);
          if (childKind === "file" || recursive) await walk(childHandle, childRelative, childKind);
          else await visit({ handle: childHandle, relative: childRelative, kind: childKind });
        } finally {
          await childHandle.close();
        }
      }
    };
    try {
      await walk(root.handle, root.relative, root.kind);
    } finally {
      await root.handle.close();
    }
  }

  private async compareWorkspaceFiles(left: string, right: string, signal: AbortSignal): Promise<boolean> {
    const first = await this.openWorkspaceTarget(left);
    let second: Awaited<ReturnType<ProductionDirectLiveHostEffects["openWorkspaceTarget"]>>;
    try {
      second = await this.openWorkspaceTarget(right);
    } catch (error) {
      await first.handle.close();
      throw error;
    }
    try {
      if (first.kind !== "file" || second.kind !== "file") throw new Error("Workspace compare requires regular files.");
      const [firstMetadata, secondMetadata] = await Promise.all([first.handle.stat(), second.handle.stat()]);
      if (firstMetadata.size !== secondMetadata.size) return false;
      const firstBuffer = Buffer.allocUnsafe(64 * 1024);
      const secondBuffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < firstMetadata.size) {
        if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
        const length = Math.min(firstBuffer.byteLength, firstMetadata.size - position);
        const [firstRead, secondRead] = await Promise.all([
          first.handle.read(firstBuffer, 0, length, position),
          second.handle.read(secondBuffer, 0, length, position),
        ]);
        if (
          firstRead.bytesRead !== secondRead.bytesRead ||
          !firstBuffer.subarray(0, firstRead.bytesRead).equals(secondBuffer.subarray(0, secondRead.bytesRead))
        )
          return false;
        position += firstRead.bytesRead;
      }
      return true;
    } finally {
      await Promise.all([first.handle.close(), second.handle.close()]);
    }
  }

  private async withParent<T>(
    value: string,
    allowMissing: boolean,
    operation: (resolved: ResolvedParent) => Promise<T>
  ): Promise<T> {
    return await withVerifiedParent(value, ROOTS, allowMissing, operation);
  }

  private async removeDeletionTree(
    directory: FileHandle,
    expected: DeletionPlanNode,
    signal: AbortSignal,
    budget: DeletionBudget,
    depth: number
  ): Promise<void> {
    assertDeletionBudget(signal, budget, depth);
    const names = sortedNames(await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true }));
    const expectedNames = expected.children.map((child) => child.name);
    if (!sameNames(names, expectedNames)) throw new Error("Deletion tree changed during cleanup.");
    for (const childPlan of expected.children) {
      await this.removeDeletionTreeChild(directory, childPlan, signal, budget, depth + 1);
    }
    const afterNames = sortedNames(await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true }));
    if (afterNames.length !== 0) throw new Error("Deletion cleanup left unexpected entries.");
  }

  private async removeDeletionTreeChild(
    directory: FileHandle,
    childPlan: DeletionPlanNode,
    signal: AbortSignal,
    budget: DeletionBudget,
    depth: number
  ): Promise<void> {
    assertDeletionBudget(signal, budget, depth);
    const target = this.anchor(directory, childPlan.name);
    const metadata = await lstat(target, { bigint: true });
    const kind = kindFromMode(Number(metadata.mode));
    if (kind !== childPlan.kind || !sameDeletionIdentity(childPlan.identity, deletionIdentity(metadata))) {
      throw new Error("Deletion entry changed during cleanup.");
    }
    if (kind === "symlink" || kind === "special") throw new Error("Deletion tree contains an unsafe entry.");
    if (kind === "directory") {
      const child = await openAndVerifyDeletionEntry(directory, childPlan.name, undefined, "directory");
      try {
        if (!sameDeletionIdentity(childPlan.identity, child.identity))
          throw new Error("Deletion directory changed during cleanup.");
        await this.removeDeletionTree(child.handle, childPlan, signal, budget, depth);
      } finally {
        await child.handle.close().catch(() => undefined);
      }
      const beforeRmdir = deletionIdentity(await lstat(target, { bigint: true }));
      if (!sameDeletionIdentity(childPlan.identity, beforeRmdir))
        throw new Error("Deletion directory changed during cleanup.");
      await rmdir(target);
      return;
    }

    const file = await openAndVerifyDeletionEntry(directory, childPlan.name, undefined, "file");
    try {
      if (!sameDeletionIdentity(childPlan.identity, file.identity))
        throw new Error("Deletion file changed during cleanup.");
    } finally {
      await file.handle.close().catch(() => undefined);
    }
    await unlink(target);
  }
}

async function assertRuntimeCredential(journalCredentialPath: string | undefined): Promise<void> {
  if (journalCredentialPath === undefined) {
    try {
      await stat("/run/credentials");
      throw new Error("Executor namespace exposes a forbidden credential directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES")
        throw error;
    }
    return;
  }
  if (journalCredentialPath !== EXECUTOR_JOURNAL_CREDENTIAL_PATH) {
    throw new Error("Executor systemd credential path is invalid.");
  }
  await assertExecutorJournalCredentialNamespace();
}

export async function assertRuntimeSandbox(journalCredentialPath?: string): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() === 0)
    throw new Error("Executor must run as an unprivileged Linux user.");
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status)) {
    throw new Error("Executor requires NoNewPrivileges and an empty effective capability set.");
  }
  await assertRuntimeCredential(journalCredentialPath);
  for (const root of ROOTS)
    if (!(await stat(root)).isDirectory()) throw new Error("Executor namespace roots are unavailable.");
  for (const denied of ["/root", "/home", "/opt/setup", "/etc/minecraft", "/var/lib/amazon/ssm"]) {
    try {
      await stat(denied);
      throw new Error("Executor namespace exposes a forbidden host path.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES")
        throw error;
    }
  }
}
