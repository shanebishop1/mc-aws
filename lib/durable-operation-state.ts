import * as aws from "@/lib/aws";
import type { OperationStatus, OperationType } from "@/lib/types";

const operationStateParamPrefix = "/minecraft/operations";
const operationStatuses: ReadonlySet<OperationStatus> = new Set(["accepted", "running", "completed", "failed"]);
const operationTypes: ReadonlySet<OperationType> = new Set(["start", "stop", "backup", "restore", "hibernate", "resume"]);
const operationStatusPriority: Record<OperationStatus, number> = {
  accepted: 1,
  running: 2,
  completed: 3,
  failed: 3,
};
const transitionSources = new Set<OperationStateTransitionSource>(["api", "lambda"]);
const inMemoryOperationStateStore = new Map<string, string>();

export type OperationStateTransitionSource = "api" | "lambda";

export interface DurableOperationStateTransition {
  status: OperationStatus;
  at: string;
  source: OperationStateTransitionSource;
  error?: string;
  code?: string;
}

export interface DurableOperationState {
  id: string;
  type: OperationType;
  route: string;
  status: OperationStatus;
  requestedAt: string;
  updatedAt: string;
  requestedBy?: string;
  lockId?: string;
  instanceId?: string;
  lastError?: string;
  code?: string;
  history: DurableOperationStateTransition[];
}

export interface PersistDurableOperationStateTransitionInput {
  operationId: string;
  type: OperationType;
  status: OperationStatus;
  source: OperationStateTransitionSource;
  route?: string;
  requestedAt?: string;
  requestedBy?: string;
  lockId?: string;
  instanceId?: string;
  error?: string;
  code?: string;
  timestamp?: string;
}

function getOperationStateParameterName(operationId: string): string {
  return `${operationStateParamPrefix}/${operationId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === "completed" || status === "failed";
}

function shouldApplyStatusTransition(
  existing: DurableOperationState | null,
  next: OperationStatus,
  source: OperationStateTransitionSource
): boolean {
  if (!existing) {
    return true;
  }

  const current = existing.status;

  if (current === next) {
    return true;
  }

  if (isTerminalOperationStatus(current)) {
    return false;
  }

  if (current === "running" && next === "accepted") {
    const latestSource = existing.history.at(-1)?.source;
    return latestSource === "api" && source === "api";
  }

  return operationStatusPriority[next] >= operationStatusPriority[current];
}

function parseDurableOperationState(raw: string | null): DurableOperationState | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<DurableOperationState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (!parsed.id || !parsed.type || !parsed.route || !parsed.status || !parsed.requestedAt || !parsed.updatedAt) {
      return null;
    }

    if (!operationTypes.has(parsed.type) || !operationStatuses.has(parsed.status)) {
      return null;
    }

    const history: DurableOperationStateTransition[] = Array.isArray(parsed.history)
      ? parsed.history.flatMap((entry) => {
          if (!isObject(entry)) {
            return [];
          }

          const status = entry.status;
          const at = entry.at;
          const source = entry.source;
          if (typeof status !== "string" || typeof at !== "string" || typeof source !== "string") {
            return [];
          }

          if (!operationStatuses.has(status as OperationStatus) || !transitionSources.has(source as OperationStateTransitionSource)) {
            return [];
          }

          return [
            {
              status: status as OperationStatus,
              at,
              source: source as OperationStateTransitionSource,
              error: normalizeOptionalText(entry.error),
              code: normalizeOptionalText(entry.code),
            },
          ];
        })
      : [];

    return {
      id: parsed.id,
      type: parsed.type,
      route: parsed.route,
      status: parsed.status,
      requestedAt: parsed.requestedAt,
      updatedAt: parsed.updatedAt,
      requestedBy: normalizeOptionalText(parsed.requestedBy),
      lockId: normalizeOptionalText(parsed.lockId),
      instanceId: normalizeOptionalText(parsed.instanceId),
      lastError: normalizeOptionalText(parsed.lastError),
      code: normalizeOptionalText(parsed.code),
      history,
    };
  } catch {
    return null;
  }
}

function shouldUseInMemoryStore(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const awsModule = aws as {
    getParameter?: unknown;
    putParameter?: unknown;
  };

  return typeof awsModule.getParameter !== "function" || typeof awsModule.putParameter !== "function";
}

async function readRawOperationState(parameterName: string): Promise<string | null> {
  if (shouldUseInMemoryStore()) {
    return inMemoryOperationStateStore.get(parameterName) ?? null;
  }

  return await aws.getParameter(parameterName);
}

async function writeRawOperationState(parameterName: string, value: string): Promise<void> {
  if (shouldUseInMemoryStore()) {
    inMemoryOperationStateStore.set(parameterName, value);
    return;
  }

  await aws.putParameter(parameterName, value, "String", true);
}

function buildNextOperationState(
  existing: DurableOperationState | null,
  input: PersistDurableOperationStateTransitionInput,
  now: string
): DurableOperationState {
  const route = existing?.route ?? input.route ?? `/api/${input.type}`;
  const requestedAt = existing?.requestedAt ?? input.requestedAt ?? now;
  const requestedBy = normalizeOptionalText(input.requestedBy) ?? existing?.requestedBy;
  const lockId = normalizeOptionalText(input.lockId) ?? existing?.lockId;
  const instanceId = normalizeOptionalText(input.instanceId) ?? existing?.instanceId;

  const { applyIncomingStatus, nextStatus } = resolveNextStatus(existing, input);
  const normalizedError = normalizeOptionalText(input.error);
  const normalizedCode = normalizeOptionalText(input.code);
  const history = buildNextTransitionHistory({
    existingHistory: existing?.history ?? [],
    applyIncomingStatus,
    nextStatus,
    source: input.source,
    now,
    error: normalizedError,
    code: normalizedCode,
  });
  const { lastError, code } = resolveLastErrorMetadata({
    existing,
    applyIncomingStatus,
    nextStatus,
    error: normalizedError,
    code: normalizedCode,
  });

  return {
    id: existing?.id ?? input.operationId,
    type: existing?.type ?? input.type,
    route,
    status: nextStatus,
    requestedAt,
    updatedAt: now,
    requestedBy,
    lockId,
    instanceId,
    lastError,
    code,
    history,
  };
}

function resolveNextStatus(
  existing: DurableOperationState | null,
  input: PersistDurableOperationStateTransitionInput
): {
  applyIncomingStatus: boolean;
  nextStatus: OperationStatus;
} {
  const currentStatus = existing?.status ?? input.status;
  const applyIncomingStatus = shouldApplyStatusTransition(existing, input.status, input.source);

  return {
    applyIncomingStatus,
    nextStatus: applyIncomingStatus ? input.status : currentStatus,
  };
}

function shouldAppendTransition(
  history: DurableOperationStateTransition[],
  nextStatus: OperationStatus,
  source: OperationStateTransitionSource,
  error?: string,
  code?: string
): boolean {
  const lastTransition = history.at(-1);
  if (!lastTransition) {
    return true;
  }

  return (
    lastTransition.status !== nextStatus ||
    lastTransition.source !== source ||
    lastTransition.error !== error ||
    lastTransition.code !== code
  );
}

function buildNextTransitionHistory(input: {
  existingHistory: DurableOperationStateTransition[];
  applyIncomingStatus: boolean;
  nextStatus: OperationStatus;
  source: OperationStateTransitionSource;
  now: string;
  error?: string;
  code?: string;
}): DurableOperationStateTransition[] {
  const history = [...input.existingHistory];
  if (!input.applyIncomingStatus) {
    return history;
  }

  if (!shouldAppendTransition(history, input.nextStatus, input.source, input.error, input.code)) {
    return history;
  }

  history.push({
    status: input.nextStatus,
    at: input.now,
    source: input.source,
    error: input.nextStatus === "failed" ? input.error : undefined,
    code: input.nextStatus === "failed" ? input.code : undefined,
  });

  return history;
}

function resolveLastErrorMetadata(input: {
  existing: DurableOperationState | null;
  applyIncomingStatus: boolean;
  nextStatus: OperationStatus;
  error?: string;
  code?: string;
}): {
  lastError?: string;
  code?: string;
} {
  if (!input.applyIncomingStatus) {
    return {
      lastError: input.existing?.lastError,
      code: input.existing?.code,
    };
  }

  if (input.nextStatus !== "failed") {
    return {
      lastError: undefined,
      code: undefined,
    };
  }

  return {
    lastError: input.error ?? input.existing?.lastError ?? "Operation failed",
    code: input.code ?? input.existing?.code,
  };
}

export async function persistDurableOperationStateTransition(
  input: PersistDurableOperationStateTransitionInput
): Promise<DurableOperationState> {
  const now = input.timestamp ?? new Date().toISOString();
  const parameterName = getOperationStateParameterName(input.operationId);
  const existing = parseDurableOperationState(await readRawOperationState(parameterName));
  const nextState = buildNextOperationState(existing, input, now);

  await writeRawOperationState(parameterName, JSON.stringify(nextState));
  return nextState;
}

export async function getDurableOperationState(operationId: string): Promise<DurableOperationState | null> {
  const parameterName = getOperationStateParameterName(operationId);
  return parseDurableOperationState(await readRawOperationState(parameterName));
}

export function resetDurableOperationStateStoreForTests(): void {
  inMemoryOperationStateStore.clear();
}
