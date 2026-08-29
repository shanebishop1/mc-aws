import { ClientApiError, fetchOperationStatus, fetchStatusWithSignal } from "@/lib/client-api";
import { LIFECYCLE_LOCK_LEASE_MS } from "@/lib/lifecycle-runtime-budget";
import { type OperationStatusData, ServerState, type ServerStatusResponse } from "@/lib/types";

const DEFAULT_INTERVAL_MS = 1500;
export const OPERATION_TIMEOUT_MS = 17 * 60 * 1000;
const MAX_INTERVAL_MS = 10_000;
export const DISPATCH_RECOVERY_RETRY_GRACE_MS = 30_000;

interface OperationStatusResponse {
  data?: OperationStatusData;
  timestamp?: string;
}

interface PollOperationOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  fetchStatus?: (operationId: string, signal?: AbortSignal) => Promise<OperationStatusResponse>;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface PollStopOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  fetchStatus?: (signal?: AbortSignal) => Promise<{ data?: ServerStatusResponse }>;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortError(): DOMException {
  return new DOMException("Operation polling was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const handleAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function authenticationError(status: number): ClientApiError {
  return new ClientApiError(
    status === 401
      ? "Your session expired. Please sign in again."
      : "Your account no longer has permission to view this operation.",
    status
  );
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof ClientApiError)) return error instanceof TypeError;
  return (
    error.status === 404 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status ?? 0) >= 500
  );
}

function throwIfAuthenticationError(error: unknown): void {
  if (error instanceof ClientApiError && (error.status === 401 || error.status === 403)) {
    throw authenticationError(error.status);
  }
}

function nextInterval(baseIntervalMs: number, transientFailures: number): number {
  return Math.min(MAX_INTERVAL_MS, baseIntervalMs * 2 ** Math.min(transientFailures, 4));
}

async function loadWithTransientRetry<T>(load: () => Promise<T>): Promise<{ value?: T; transient: boolean }> {
  try {
    return { value: await load(), transient: false };
  } catch (error) {
    throwIfAuthenticationError(error);
    if (!isTransientError(error)) throw error;
    return { transient: true };
  }
}

function resolveOperationTerminal(operation?: OperationStatusData): OperationStatusData | undefined {
  if (operation?.status === "completed") return operation;
  if (operation?.status === "failed") {
    throw new Error(operation.lastError || `${operation.type} operation failed`);
  }
  return undefined;
}

function isAcceptedDispatchAwaitingExecutor(operation: OperationStatusData): boolean {
  return operation.status === "accepted" && (operation.phase === "dispatching" || operation.phase === "dispatched");
}

function resolveStoppedTerminal(status?: ServerStatusResponse): ServerStatusResponse | undefined {
  if (status?.state === ServerState.Stopped) return status;
  if (status?.state === ServerState.Terminated) {
    throw new Error("The server instance terminated while stopping");
  }
  return undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Polling keeps terminal, transient, server-clock, recovery-grace, and cancellation decisions together.
export async function pollOperationUntilTerminal(
  operationId: string,
  options: PollOperationOptions = {}
): Promise<OperationStatusData> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const getStatus = options.fetchStatus ?? fetchOperationStatus;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const startedAt = now();
  const executionPollingDeadline = startedAt + timeoutMs;
  const maximumRecoveryDeadline = executionPollingDeadline + LIFECYCLE_LOCK_LEASE_MS + DISPATCH_RECOVERY_RETRY_GRACE_MS;
  let pollingDeadline = executionPollingDeadline;
  let transientFailures = 0;

  while (now() <= pollingDeadline) {
    throwIfAborted(options.signal);

    const attempt = await loadWithTransientRetry(async () => {
      const response = await getStatus(operationId, options.signal);
      const operation = response.data;
      if (!operation) throw new ClientApiError("Operation status was unavailable", 503);
      return { operation, serverTimestamp: response.timestamp };
    });

    const terminalOperation = resolveOperationTerminal(attempt.value?.operation);
    if (terminalOperation) return terminalOperation;
    if (attempt.value && isAcceptedDispatchAwaitingExecutor(attempt.value.operation)) {
      const dispatchExpiresAt = Date.parse(attempt.value.operation.dispatchExpiresAt ?? "");
      const serverTimestamp = Date.parse(attempt.value.serverTimestamp ?? "");
      if (Number.isFinite(dispatchExpiresAt) && Number.isFinite(serverTimestamp)) {
        const serverToClientClockOffsetMs = now() - serverTimestamp;
        pollingDeadline = Math.max(
          pollingDeadline,
          Math.min(
            dispatchExpiresAt + serverToClientClockOffsetMs + DISPATCH_RECOVERY_RETRY_GRACE_MS,
            maximumRecoveryDeadline
          )
        );
      }
    } else if (attempt.value?.operation.status === "running" || attempt.value?.operation.phase === "executing") {
      pollingDeadline = executionPollingDeadline;
    }
    transientFailures = attempt.transient ? transientFailures + 1 : 0;

    const remainingMs = pollingDeadline - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(nextInterval(intervalMs, transientFailures), remainingMs), options.signal);
  }

  throw new Error("Operation timed out while waiting for completion");
}

export async function pollServerUntilStopped(options: PollStopOptions = {}): Promise<ServerStatusResponse> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  const getStatus = options.fetchStatus ?? fetchStatusWithSignal;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const startedAt = now();
  let transientFailures = 0;

  while (now() - startedAt <= timeoutMs) {
    throwIfAborted(options.signal);

    const attempt = await loadWithTransientRetry(async () => {
      const response = await getStatus(options.signal);
      const status = response.data;
      if (!status) throw new ClientApiError("Server status was unavailable", 503);
      return status;
    });

    const terminalStatus = resolveStoppedTerminal(attempt.value);
    if (terminalStatus) return terminalStatus;
    transientFailures = attempt.transient ? transientFailures + 1 : 0;

    await delay(nextInterval(intervalMs, transientFailures), options.signal);
  }

  throw new Error("Stop timed out while waiting for the server to reach the stopped state");
}
