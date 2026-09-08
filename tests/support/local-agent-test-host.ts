import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { EvidenceReference, JsonObject } from "@/lib/agent/contracts";
import type {
  CanonicalPath,
  DirectLiveHostEffects,
  DownloadRequest,
  HostEffectResult,
  ProcessRequest,
} from "@/lib/agent/executor";
import { contained } from "@/lib/agent/executor";

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Test host operation cancelled", "AbortError");
}

function kind(stats: Awaited<ReturnType<typeof lstat>>): CanonicalPath["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "special";
}

/**
 * Linux-only local test adapter. It never starts a child process or network
 * request. File effects are serialized, reject every symlink component, use
 * O_NOFOLLOW, and verify the opened descriptor via /proc/self/fd before I/O.
 * This models race-safe confinement for a single-process temporary fixture;
 * production confinement remains the systemd/OS adapter's responsibility.
 */
export class LocalAgentTestHost implements DirectLiveHostEffects {
  readonly securityCapabilities = {
    descriptorRelativeWorkspaceConfinement: true,
    workspaceRootedCommandBoundary: true,
    pinnedDnsRedirectEgressEnforcement: true,
  } as const;
  readonly effects: Array<{ kind: string; detail: string }> = [];
  readonly consoleCommands: string[] = [];
  readonly processRequests: Array<Pick<ProcessRequest, "executable" | "args" | "cwd" | "timeoutMs">> = [];
  networkAttempts = 0;
  private operation = Promise.resolve();
  private evidenceSequence = 0;

  constructor(private readonly roots: readonly string[]) {
    if (roots.length === 0 || roots.some((root) => !path.isAbsolute(root))) {
      throw new TypeError("Local test host roots must be absolute.");
    }
  }

  async canonicalize(candidate: string): Promise<CanonicalPath> {
    if (!path.isAbsolute(candidate)) throw new Error("Test host paths must be absolute.");
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) return { path: await realpath(candidate), kind: "symlink" };
      return { path: await realpath(candidate), kind: kind(stats) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await realpath(path.dirname(candidate));
      return { path: path.join(parent, path.basename(candidate)), kind: "missing" };
    }
  }

  async readFile(candidate: string, maxBytes: number, signal: AbortSignal): Promise<HostEffectResult> {
    return await this.serial(async () => {
      aborted(signal);
      const handle = await this.openVerified(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > maxBytes) throw new Error("Test read is outside its byte bound.");
        const content = await handle.readFile("utf8");
        aborted(signal);
        this.effects.push({ kind: "read", detail: this.relative(candidate) });
        return this.result("Inspected confined workspace file.", { content }, "file", "read");
      } finally {
        await handle.close();
      }
    });
  }

  async writeFile(candidate: string, content: Uint8Array, signal: AbortSignal): Promise<HostEffectResult> {
    return await this.serial(async () => {
      aborted(signal);
      const temporary = path.join(path.dirname(candidate), `.mc-agent-local-${process.pid}-${crypto.randomUUID()}`);
      const handle = await this.openVerified(
        temporary,
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
        aborted(signal);
        await rename(temporary, candidate);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.effects.push({ kind: "write", detail: this.relative(candidate) });
      return {
        ...this.result(
          "Edited confined workspace file atomically.",
          { changed: true, committed: true, commitPoint: "atomic-rename" },
          "diff",
          "write"
        ),
        mutationCommit: { committed: true, point: "atomic-rename" },
      };
    });
  }

  async deletePath(): Promise<HostEffectResult> {
    throw new Error("Deletion is intentionally disabled in the local vertical-slice host.");
  }

  async executeProcess(request: ProcessRequest): Promise<HostEffectResult> {
    aborted(request.signal);
    if (request.timeoutMs > 1_000 || request.maxOutputBytes > 64 * 1024) {
      throw new Error("Fake process exceeded its test bound.");
    }
    this.processRequests.push({
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
    });
    this.effects.push({ kind: "process", detail: path.basename(request.executable) });
    return this.result("Executed bounded fake process action.", { exitCode: 0 }, "command-output", "process");
  }

  async executeConsole(command: string, timeoutMs: number, signal: AbortSignal): Promise<HostEffectResult> {
    aborted(signal);
    if (timeoutMs > 1_000 || /[\r\n\0]/.test(command)) throw new Error("Fake console request exceeded its bound.");
    this.consoleCommands.push(command);
    this.effects.push({ kind: "console", detail: command });
    return {
      ...this.result(
        "Executed bounded fake console action.",
        { response: "There are 0 players online.", committed: true, commitPoint: "console-dispatch" },
        "console-output",
        "console"
      ),
      mutationCommit: { committed: true, point: "console-dispatch" },
    };
  }

  async download(_request: DownloadRequest): Promise<HostEffectResult> {
    this.networkAttempts++;
    throw new Error("Network is disabled in the local test host.");
  }

  async requestBackup(): Promise<HostEffectResult> {
    throw new Error("The typed gateway backup adapter owns backups in this fixture.");
  }

  async loadExtension(candidate: string, signal: AbortSignal): Promise<HostEffectResult> {
    return await this.readFile(candidate, 64 * 1024, signal);
  }

  private async openVerified(candidate: string, flags: number, mode?: number) {
    const root = this.rootFor(candidate);
    await this.assertParents(root, path.dirname(candidate));
    const handle = await open(candidate, flags, mode);
    try {
      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!contained(root, descriptorPath)) throw new Error("Opened descriptor escaped the temporary root.");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async assertParents(root: string, parent: string): Promise<void> {
    const relative = path.relative(root, parent);
    if (relative === "" || relative === ".") return;
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Parent escaped the temporary root.");
    let cursor = root;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      const stats = await lstat(cursor);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Parent contains an unsafe entry.");
    }
  }

  private rootFor(candidate: string): string {
    const root = this.roots.find((item) => contained(item, candidate));
    if (!root) throw new Error("Path is outside every temporary test root.");
    return root;
  }

  private relative(candidate: string): string {
    const root = this.rootFor(candidate);
    return path.relative(root, candidate) || ".";
  }

  private result(
    summary: string,
    output: JsonObject,
    evidenceKind: EvidenceReference["kind"],
    label: string
  ): HostEffectResult {
    const evidence: EvidenceReference = {
      schemaVersion: 1,
      evidenceId: `local-${label}-${++this.evidenceSequence}`,
      kind: evidenceKind,
      uri: `agent-evidence://local-test/${label}/${this.evidenceSequence}`,
      description: `${label} evidence from the confined local fixture`,
    };
    return { summary, output, evidence: [evidence] };
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operation.then(operation);
    this.operation = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }
}
