import { type Server, type Socket, createServer } from "node:net";
import type { ShellCommand } from "../../lib/agent/contracts";
import { type ShellRunnerRequest, type ShellRunnerResponse, runShellCommand } from "./shell-runner";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 125_000;
const ZERO_SHA256 = "0".repeat(64);

export interface ShellRunnerServerOptions {
  mode: ShellCommand["mode"];
  shellPath: string;
  run?: (shellPath: string, request: ShellRunnerRequest, signal: AbortSignal) => Promise<ShellRunnerResponse>;
}

export interface ShellRunnerServer {
  server: Server;
  completion: Promise<void>;
  listen(options: Parameters<Server["listen"]>[0]): Promise<void>;
  stop(): Promise<void>;
}

function endSocket(socket: Socket, payload: string): Promise<void> {
  return new Promise((resolve) => socket.end(payload, resolve));
}

function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("request-timeout")), FRAME_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > MAX_REQUEST_BYTES) {
        finish(new Error("request-too-large"));
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.byteLength - 1) {
        finish(new Error("multiple-messages"));
        return;
      }
      try {
        finish(undefined, JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        finish(new Error("invalid-json"));
      }
    };
    const onEnd = (): void => finish(new Error("truncated-message"));
    const onError = (error: Error): void => finish(error);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function parseRequest(value: unknown, expectedMode: ShellCommand["mode"]): ShellRunnerRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-request");
  const item = value as Record<string, unknown>;
  const keys = ["schemaVersion", "requestId", "mode", "command", "timeoutMs", "maxOutputBytes", "change"];
  if (
    Object.keys(item).some((key) => !keys.includes(key)) ||
    item.schemaVersion !== 1 ||
    typeof item.requestId !== "string" ||
    item.requestId.length < 1 ||
    item.mode !== expectedMode
  )
    throw new Error("invalid-request");
  return {
    mode: item.mode,
    command: item.command,
    timeoutMs: item.timeoutMs,
    change: item.change,
    maxOutputBytes: item.maxOutputBytes,
  } as ShellRunnerRequest;
}

function responseJson(response: ShellRunnerResponse): string {
  return JSON.stringify({
    ...response,
    ...(response.stagedResult
      ? {
          stagedResult: {
            ...response.stagedResult,
            bytes: Buffer.from(response.stagedResult.bytes).toString("base64"),
          },
        }
      : {}),
  });
}

function failureJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    exitCode: 126,
    output: "",
    outputBytes: 0,
    outputSha256: ZERO_SHA256,
    truncated: false,
  });
}

export function createShellRunnerServer(options: ShellRunnerServerOptions): ShellRunnerServer {
  let claimed = false;
  let active: AbortController | undefined;
  let activeSocket: Socket | undefined;
  let completionResolve!: () => void;
  let completion = new Promise<void>((resolve) => {
    completionResolve = resolve;
  });
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    if (claimed) {
      socket.destroy();
      return;
    }
    claimed = true;
    active = new AbortController();
    activeSocket = socket;
    let finished = false;
    socket.once("close", () => {
      if (!finished) active?.abort();
    });
    void (async () => {
      try {
        const request = parseRequest(await readFrame(socket), options.mode);
        const run =
          options.run ??
          ((shellPath, value, signal) => runShellCommand(shellPath, value, undefined, undefined, signal));
        const response = await run(options.shellPath, request, active!.signal);
        if (!socket.destroyed) await endSocket(socket, `${responseJson(response)}\n`);
      } catch {
        if (!socket.destroyed) await endSocket(socket, `${failureJson()}\n`);
      } finally {
        finished = true;
        active = undefined;
        activeSocket = undefined;
        socket.destroy();
        await closeServer(server);
        completionResolve();
      }
    })();
  });
  completion = completion.then(() => undefined);
  const stop = async (): Promise<void> => {
    active?.abort();
    activeSocket?.destroy();
    await closeServer(server);
    completionResolve();
    await completion;
  };
  return {
    server,
    completion,
    listen: async (listenOptions) => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenOptions, resolve);
      });
    },
    stop,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  return await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
