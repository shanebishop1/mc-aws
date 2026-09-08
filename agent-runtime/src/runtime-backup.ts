import { parseBackupFenceAuthorization } from "@/lib/agent/runtime/backup-fence";
import type {
  RuntimeBackupAvailabilityResult,
  RuntimeBackupCreateRequest,
  RuntimeBackupFinalizeRequest,
  RuntimeBackupFinalizeResult,
  RuntimeBackupRenewRequest,
  RuntimeBackupRenewResult,
  RuntimeBackupResult,
} from "@/lib/agent/runtime/contracts";
import type { RuntimeGatewayBackupAdapter } from "./gateway";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_WAIT_MS = 17 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class RuntimeBackupHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean
  ) {
    super("Runtime backup endpoint failed closed.");
    this.name = "RuntimeBackupHttpError";
  }
}

class RuntimeBackupResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBackupResponseError";
  }
}

export interface RuntimeBackupHttpTransport {
  fetch(input: string | URL, init: RequestInit): Promise<Response>;
}

export interface HttpRuntimeBackupAdapterOptions {
  baseUrl: string | URL;
  runtimeBearer: string;
  transport: RuntimeBackupHttpTransport;
  backupPath?: "/api/agent/runtime/backups";
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxWaitMs?: number;
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new RuntimeBackupResponseError("Runtime backup response exceeded its bound.");
  }
  if (!response.body) throw new RuntimeBackupResponseError("Runtime backup response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > MAX_RESPONSE_BYTES)
        throw new RuntimeBackupResponseError("Runtime backup response exceeded its bound.");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RuntimeBackupResponseError("Runtime backup response JSON is invalid.");
  }
}

function parseEnvelope(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  if (!envelope || envelope.success !== true || !("data" in envelope)) {
    throw new RuntimeBackupHttpError(502, false);
  }
  const data = record(envelope.data);
  if (!data) throw new RuntimeBackupResponseError("Runtime backup endpoint returned an invalid response.");
  return data;
}

function parseAvailability(value: Record<string, unknown>): RuntimeBackupAvailabilityResult {
  if (
    !exact(value, ["schemaVersion", "availability"]) ||
    value.schemaVersion !== 1 ||
    (value.availability !== "available" && value.availability !== "unavailable")
  ) {
    throw new RuntimeBackupResponseError("Runtime backup availability response is invalid.");
  }
  return value as unknown as RuntimeBackupAvailabilityResult;
}

function parseResult(value: Record<string, unknown>): RuntimeBackupResult {
  const required = [
    "schemaVersion",
    "status",
    "leaseId",
    "leaseGeneration",
    "sessionId",
    "taskId",
    "invocationId",
    "invocationDigest",
  ];
  const allowed = [...required, "backupId", "createdAt", "fenceAuthorization"];
  if (
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    !required.every((key) => key in value) ||
    value.schemaVersion !== 1 ||
    !["pending", "succeeded", "failed", "unavailable", "cancelled", "ambiguous"].includes(String(value.status)) ||
    ![value.leaseId, value.sessionId, value.taskId, value.invocationId].every(
      (item) => typeof item === "string" && ID.test(item)
    ) ||
    typeof value.leaseGeneration !== "number" ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    value.leaseGeneration < 1 ||
    typeof value.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.invocationDigest) ||
    (value.backupId !== undefined && (typeof value.backupId !== "string" || !ID.test(value.backupId))) ||
    (value.createdAt !== undefined &&
      (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))))
  ) {
    throw new RuntimeBackupResponseError("Runtime backup result is invalid.");
  }
  if (value.status === "succeeded" && (!value.backupId || !value.createdAt || !value.fenceAuthorization)) {
    throw new RuntimeBackupResponseError("Runtime backup success is incomplete.");
  }
  if (value.status === "succeeded") parseBackupFenceAuthorization(value.fenceAuthorization);
  if (
    value.status !== "succeeded" &&
    (value.backupId !== undefined || value.createdAt !== undefined || value.fenceAuthorization !== undefined)
  ) {
    throw new RuntimeBackupResponseError("Runtime backup non-success result contains terminal success metadata.");
  }
  return value as unknown as RuntimeBackupResult;
}

function assertResultBinding(result: RuntimeBackupResult, input: RuntimeBackupCreateRequest): void {
  if (
    result.leaseId !== input.leaseId ||
    result.leaseGeneration !== input.leaseGeneration ||
    result.sessionId !== input.sessionId ||
    result.taskId !== input.taskId ||
    result.invocationId !== input.invocationId ||
    result.invocationDigest !== input.invocationDigest
  ) {
    throw new RuntimeBackupResponseError("Runtime backup result did not match its request binding.");
  }
}

function parseFinalizeResult(value: Record<string, unknown>): RuntimeBackupFinalizeResult {
  if (
    !exact(value, ["schemaVersion", "authorizationId", "status", "released"]) ||
    value.schemaVersion !== 1 ||
    typeof value.authorizationId !== "string" ||
    !ID.test(value.authorizationId) ||
    !["finalized", "expired", "reconciliation-needed"].includes(String(value.status)) ||
    typeof value.released !== "boolean"
  ) {
    throw new RuntimeBackupResponseError("Runtime backup finalization response is invalid.");
  }
  return value as unknown as RuntimeBackupFinalizeResult;
}

function parseRenewResult(value: Record<string, unknown>): RuntimeBackupRenewResult {
  const allowed = ["schemaVersion", "authorizationId", "status", "authorization"];
  if (
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    !["schemaVersion", "authorizationId", "status"].every((key) => key in value) ||
    value.schemaVersion !== 1 ||
    typeof value.authorizationId !== "string" ||
    !ID.test(value.authorizationId) ||
    (value.status !== "renewed" && value.status !== "lost")
  ) {
    throw new RuntimeBackupResponseError("Runtime backup renewal response is invalid.");
  }
  if (value.status === "renewed") parseBackupFenceAuthorization(value.authorization);
  if (value.status === "lost" && value.authorization !== undefined) {
    throw new RuntimeBackupResponseError("Lost runtime backup ownership included an authorization.");
  }
  return value as unknown as RuntimeBackupRenewResult;
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof RuntimeBackupHttpError) return error.retryable;
  if (error instanceof RuntimeBackupResponseError) return false;
  return !(error instanceof DOMException && error.name === "AbortError");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Runtime backup request cancelled", "AbortError");
}

export class HttpRuntimeBackupAdapter implements RuntimeGatewayBackupAdapter {
  private readonly baseUrl: URL;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly backupPath: string;

  constructor(private readonly options: HttpRuntimeBackupAdapterOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (
      this.baseUrl.protocol !== "https:" ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new TypeError("Runtime backup control URL is invalid.");
    }
    if (options.runtimeBearer.length < 32 || options.runtimeBearer.length > 512 || /\s/.test(options.runtimeBearer)) {
      throw new TypeError("Runtime backup bearer is invalid.");
    }
    this.backupPath = options.backupPath ?? "/api/agent/runtime/backups";
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? pause;
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    if (!Number.isSafeInteger(this.maxWaitMs) || this.maxWaitMs < 1 || this.maxWaitMs > MAX_WAIT_MS) {
      throw new TypeError("Runtime backup wait bound is invalid.");
    }
  }

  async evaluateAvailability(signal?: AbortSignal): Promise<"available" | "unavailable"> {
    const data = await this.call({ schemaVersion: 1, action: "availability" }, signal);
    return parseAvailability(data).availability;
  }

  async create(input: RuntimeBackupCreateRequest, signal?: AbortSignal): Promise<RuntimeBackupResult> {
    const deadline = this.now().getTime() + this.maxWaitMs;
    const maxAttempts = Math.ceil(this.maxWaitMs / POLL_INTERVAL_MS) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      assertNotCancelled(signal);
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) break;
      try {
        const result = parseResult(await this.call(input, signal, Math.min(HTTP_REQUEST_TIMEOUT_MS, remaining)));
        assertResultBinding(result, input);
        if (result.status !== "pending") return result;
      } catch (error) {
        if (!shouldRetry(error)) throw error;
      }
      if (this.now().getTime() >= deadline) throw new Error("Runtime backup did not complete within its bound.");
      await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - this.now().getTime())), signal);
    }
    assertNotCancelled(signal);
    throw new Error("Runtime backup did not complete within its bound.");
  }

  async finalize(input: RuntimeBackupFinalizeRequest, signal?: AbortSignal): Promise<RuntimeBackupFinalizeResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      assertNotCancelled(signal);
      try {
        const result = parseFinalizeResult(await this.call(input, signal));
        if (result.authorizationId !== input.authorization.authorizationId) {
          throw new RuntimeBackupResponseError("Runtime backup finalization did not match its authorization.");
        }
        return result;
      } catch (error) {
        if (!shouldRetry(error) || attempt === 4) throw error;
        await this.sleep(POLL_INTERVAL_MS * 2 ** attempt, signal);
      }
    }
    throw new Error("Runtime backup finalization did not complete within its bound.");
  }

  async renew(input: RuntimeBackupRenewRequest, signal?: AbortSignal): Promise<RuntimeBackupRenewResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      assertNotCancelled(signal);
      try {
        const result = parseRenewResult(await this.call(input, signal));
        if (result.authorizationId !== input.authorization.authorizationId) {
          throw new RuntimeBackupResponseError("Runtime backup renewal did not match its authorization.");
        }
        if (result.status === "renewed") {
          const renewed = result.authorization;
          if (
            !renewed ||
            renewed.lifecycleLockId !== input.authorization.lifecycleLockId ||
            renewed.lifecycleFencingToken !== input.authorization.lifecycleFencingToken ||
            renewed.lifecycleLeaseGeneration <= input.authorization.lifecycleLeaseGeneration ||
            renewed.invocationDigest !== input.authorization.invocationDigest
          ) {
            throw new RuntimeBackupResponseError("Runtime backup renewal changed its fence binding.");
          }
        }
        return result;
      } catch (error) {
        if (!shouldRetry(error) || attempt === 2) throw error;
        await this.sleep(POLL_INTERVAL_MS * 2 ** attempt, signal);
      }
    }
    throw new Error("Runtime backup renewal did not complete within its bound.");
  }

  private async call(
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.backupPath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || url.pathname !== this.backupPath || url.search || url.hash) {
      throw new RuntimeBackupResponseError("Runtime backup endpoint changed origin or path.");
    }
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.options.transport.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.runtimeBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RuntimeBackupHttpError(response.status, response.status === 429 || response.status >= 500);
    }
    return parseEnvelope(await readBoundedJson(response));
  }
}
