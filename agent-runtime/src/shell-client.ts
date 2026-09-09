import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { ShellCommand } from "../../lib/agent/contracts";
import type { UntrustedStagedResult } from "../../lib/agent/executor/types";
import { MAX_SHELL_OUTPUT_BYTES, type ShellRunnerResponse } from "./shell-runner";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ShellRunnerClient {
  execute(request: ShellCommand & { maxOutputBytes: number }, signal: AbortSignal): Promise<ShellRunnerResponse>;
}

export interface UnixShellRunnerClientOptions {
  /** Test-only seam; production callers must use the fixed systemd socket roots. */
  allowNonProductionSocketPath?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The response parser keeps the Unix socket trust boundary fail-closed in one place.
function parseResponse(value: unknown): ShellRunnerResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shell runner response is invalid.");
  const item = value as Record<string, unknown>;
  const keys = ["schemaVersion", "exitCode", "output", "outputBytes", "outputSha256", "truncated", "stagedResult"];
  if (
    Object.keys(item).some((key) => !keys.includes(key)) ||
    !["schemaVersion", "exitCode", "output", "outputBytes", "outputSha256", "truncated"].every((key) => key in item)
  )
    throw new Error("Shell runner response fields are invalid.");
  const outputBytes = item.outputBytes;
  if (
    item.schemaVersion !== 1 ||
    !Number.isSafeInteger(item.exitCode) ||
    typeof item.output !== "string" ||
    !Number.isSafeInteger(outputBytes) ||
    (outputBytes as number) < 0 ||
    (outputBytes as number) > MAX_SHELL_OUTPUT_BYTES * 2 ||
    typeof item.outputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.outputSha256) ||
    typeof item.truncated !== "boolean" ||
    Buffer.byteLength(item.output as string, "utf8") > MAX_SHELL_OUTPUT_BYTES ||
    (outputBytes as number) !== Buffer.byteLength(item.output as string, "utf8")
  )
    throw new Error("Shell runner response values are invalid.");
  let stagedResult: UntrustedStagedResult | undefined;
  if (item.stagedResult !== undefined) {
    const result = item.stagedResult;
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new Error("Shell staged result is invalid.");
    const raw = result as Record<string, unknown>;
    if (
      Object.keys(raw).sort().join(",") !== "bytes,noLink,regularFile,sha256" ||
      typeof raw.regularFile !== "boolean" ||
      typeof raw.noLink !== "boolean" ||
      typeof raw.bytes !== "string" ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.sha256)
    )
      throw new Error("Shell staged result fields are invalid.");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.bytes))
      throw new Error("Shell staged result encoding is invalid.");
    const bytes = Buffer.from(raw.bytes, "base64");
    if (bytes.toString("base64") !== raw.bytes) throw new Error("Shell staged result encoding is non-canonical.");
    if (bytes.byteLength > 1024 * 1024) throw new Error("Shell staged result exceeds its bound.");
    stagedResult = { regularFile: raw.regularFile, noLink: raw.noLink, bytes, sha256: raw.sha256 };
  }
  return {
    schemaVersion: 1,
    exitCode: item.exitCode as number,
    output: item.output,
    outputBytes: outputBytes as number,
    outputSha256: item.outputSha256 as string,
    truncated: item.truncated as boolean,
    ...(stagedResult ? { stagedResult } : {}),
  };
}

export class UnixShellRunnerClient implements ShellRunnerClient {
  constructor(
    private readonly socketPath: string,
    options: UnixShellRunnerClientOptions = {}
  ) {
    if (!socketPath.startsWith("/run/mc-agent/") && !options.allowNonProductionSocketPath)
      throw new TypeError("Shell runner socket path is invalid.");
  }

  async execute(request: ShellCommand & { maxOutputBytes: number }, signal: AbortSignal): Promise<ShellRunnerResponse> {
    if (request.maxOutputBytes < 1 || request.maxOutputBytes > MAX_SHELL_OUTPUT_BYTES)
      throw new Error("Shell output bound is invalid.");
    return await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      const line = `${JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), ...request })}\n`;
      let received = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Shell runner timed out.")), request.timeoutMs + 5_000);
      timer.unref?.();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else {
          try {
            resolve(parseResponse(JSON.parse(received.toString("utf8")) as unknown));
          } catch (parseError) {
            reject(parseError);
          }
        }
      };
      const abort = () => finish(new DOMException("Shell runner cancelled", "AbortError"));
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > MAX_RESPONSE_BYTES) finish(new Error("Shell runner response exceeded its bound."));
      });
      socket.once("connect", () => socket.write(line));
      socket.once("error", (error) => finish(error));
      socket.once("end", () => finish());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
