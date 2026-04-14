import * as aws from "@/lib/aws";
import type { OperationStatus, OperationType } from "@/lib/types";

const operationStateParamPrefix = "/minecraft/operations";
const defaultOperationStateRetentionDays = 30;
const operationStateRetentionDaysEnvName = "MC_OPERATION_STATE_RETENTION_DAYS";
const oneDayMs = 24 * 60 * 60 * 1000;
const opportunisticCleanupIntervalMs = 15 * 60 * 1000;
const opportunisticCleanupDeletionLimit = 25;
const operationStatuses: ReadonlySet<OperationStatus> = new Set(["accepted", "running", "completed", "failed"]);
const operationTypes: ReadonlySet<OperationType> = new Set([
  "start",
  "stop",
  "backup",
  "restore",
  "hibernate",
  "resume",
]);
const operationStatusPriority: Record<OperationStatus, number> = {
  accepted: 1,
  running: 2,
  completed: 3,
  failed: 3,
};
const transitionSources = new Set<OperationStateTransitionSource>(["api", "lambda"]);
const inMemoryOperationStateStore = new Map<string, string>();
let hasLoggedInvalidRetentionConfig = false;
let lastOpportunisticCleanupStartedAt = 0;
let opportunisticCleanupInFlight: Promise<void> | null = null;

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

export interface DurableOperationStateParameterRecord {
  name: string;
  value: string;
  lastModifiedAt?: string;
}

export interface SelectExpiredDurableOperationStateParameterNamesInput {
  records: DurableOperationStateParameterRecord[];
  retentionMs: number;
  now?: Date;
  limit?: number;
  excludeParameterNames?: readonly string[];
}

export interface CleanupExpiredDurableOperationStatesInput {
  retentionMs?: number;
  now?: Date;
  maxDeletions?: number;
  dryRun?: boolean;
  excludeParameterNames?: readonly string[];
}

export interface CleanupExpiredDurableOperationStatesResult {
  retentionMs: number;
  cutoffAt: string;
  scannedCount: number;
  expiredCount: number;
  selectedParameterNames: string[];
  deletedCount: number;
  deletedParameterNames: string[];
  dryRun: boolean;
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

function parseRetentionDays(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getDurableOperationStateRetentionMs(): number {
  const configuredDays = parseRetentionDays(process.env[operationStateRetentionDaysEnvName]);
  if (configuredDays === null) {
    if (process.env[operationStateRetentionDaysEnvName] && !hasLoggedInvalidRetentionConfig) {
      hasLoggedInvalidRetentionConfig = true;
      console.warn(
        `[OPERATIONS] Invalid ${operationStateRetentionDaysEnvName} value \"${process.env[operationStateRetentionDaysEnvName]}\". Falling back to ${defaultOperationStateRetentionDays} days.`
      );
    }

    return defaultOperationStateRetentionDays * oneDayMs;
  }

  return configuredDays * oneDayMs;
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

          if (
            !operationStatuses.has(status as OperationStatus) ||
            !transitionSources.has(source as OperationStateTransitionSource)
          ) {
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
    deleteParameter?: unknown;
    listParametersByPath?: unknown;
  };

  return (
    typeof awsModule.getParameter !== "function" ||
    typeof awsModule.putParameter !== "function" ||
    typeof awsModule.deleteParameter !== "function" ||
    typeof awsModule.listParametersByPath !== "function"
  );
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

async function deleteRawOperationState(parameterName: string): Promise<void> {
  if (shouldUseInMemoryStore()) {
    inMemoryOperationStateStore.delete(parameterName);
    return;
  }

  await aws.deleteParameter(parameterName);
}

async function listRawOperationStateRecords(): Promise<DurableOperationStateParameterRecord[]> {
  if (shouldUseInMemoryStore()) {
    return [...inMemoryOperationStateStore.entries()]
      .filter(([name]) => name === operationStateParamPrefix || name.startsWith(`${operationStateParamPrefix}/`))
      .map(([name, value]) => ({
        name,
        value,
      }));
  }

  const records = await aws.listParametersByPath(operationStateParamPrefix);
  return records.map((record) => ({
    name: record.name,
    value: record.value,
    lastModifiedAt: record.lastModifiedAt,
  }));
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

function toTimestampMillis(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function resolveRecordTimestampMillis(record: DurableOperationStateParameterRecord): number | null {
  const parsedState = parseDurableOperationState(record.value);
  if (parsedState) {
    const operationUpdatedAt = toTimestampMillis(parsedState.updatedAt);
    if (operationUpdatedAt !== null) {
      return operationUpdatedAt;
    }

    const operationRequestedAt = toTimestampMillis(parsedState.requestedAt);
    if (operationRequestedAt !== null) {
      return operationRequestedAt;
    }
  }

  return toTimestampMillis(record.lastModifiedAt);
}

function buildExpiredOperationStateCandidates(input: {
  records: DurableOperationStateParameterRecord[];
  retentionMs: number;
  now: Date;
  excludeParameterNames?: readonly string[];
}): Array<{ name: string; timestampMs: number }> {
  if (input.retentionMs <= 0) {
    return [];
  }

  const cutoffMs = input.now.getTime() - input.retentionMs;
  const excludedNames = new Set(input.excludeParameterNames ?? []);

  const candidates = input.records.flatMap((record) => {
    if (excludedNames.has(record.name)) {
      return [];
    }

    const timestampMs = resolveRecordTimestampMillis(record);
    if (timestampMs === null || timestampMs > cutoffMs) {
      return [];
    }

    return [
      {
        name: record.name,
        timestampMs,
      },
    ];
  });

  candidates.sort((a, b) => {
    if (a.timestampMs === b.timestampMs) {
      return a.name.localeCompare(b.name);
    }

    return a.timestampMs - b.timestampMs;
  });

  return candidates;
}

export function selectExpiredDurableOperationStateParameterNames(
  input: SelectExpiredDurableOperationStateParameterNamesInput
): string[] {
  const now = input.now ?? new Date();
  const candidates = buildExpiredOperationStateCandidates({
    records: input.records,
    retentionMs: input.retentionMs,
    now,
    excludeParameterNames: input.excludeParameterNames,
  });

  if (typeof input.limit !== "number") {
    return candidates.map((candidate) => candidate.name);
  }

  const normalizedLimit = Math.max(0, Math.floor(input.limit));
  return candidates.slice(0, normalizedLimit).map((candidate) => candidate.name);
}

function isParameterNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name?: unknown }).name === "string" &&
    (error as { name: string }).name === "ParameterNotFound"
  );
}

export async function cleanupExpiredDurableOperationStates(
  input: CleanupExpiredDurableOperationStatesInput = {}
): Promise<CleanupExpiredDurableOperationStatesResult> {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? getDurableOperationStateRetentionMs();
  const maxDeletions =
    typeof input.maxDeletions === "number" ? Math.max(0, Math.floor(input.maxDeletions)) : Number.POSITIVE_INFINITY;
  const records = await listRawOperationStateRecords();
  const expiredParameterNames = selectExpiredDurableOperationStateParameterNames({
    records,
    retentionMs,
    now,
    excludeParameterNames: input.excludeParameterNames,
  });
  const selectedParameterNames = expiredParameterNames.slice(0, maxDeletions);
  const deletedParameterNames: string[] = [];

  if (!input.dryRun) {
    for (const parameterName of selectedParameterNames) {
      try {
        await deleteRawOperationState(parameterName);
        deletedParameterNames.push(parameterName);
      } catch (error) {
        if (!isParameterNotFoundError(error)) {
          throw error;
        }
      }
    }
  }

  return {
    retentionMs,
    cutoffAt: new Date(now.getTime() - retentionMs).toISOString(),
    scannedCount: records.length,
    expiredCount: expiredParameterNames.length,
    selectedParameterNames,
    deletedCount: deletedParameterNames.length,
    deletedParameterNames,
    dryRun: input.dryRun ?? false,
  };
}

async function runOpportunisticOperationStateCleanup(currentParameterName: string): Promise<void> {
  if (shouldUseInMemoryStore()) {
    return;
  }

  if (opportunisticCleanupInFlight) {
    return;
  }

  const nowMs = Date.now();
  if (nowMs - lastOpportunisticCleanupStartedAt < opportunisticCleanupIntervalMs) {
    return;
  }

  lastOpportunisticCleanupStartedAt = nowMs;
  opportunisticCleanupInFlight = (async () => {
    try {
      const cleanupResult = await cleanupExpiredDurableOperationStates({
        maxDeletions: opportunisticCleanupDeletionLimit,
        excludeParameterNames: [currentParameterName],
      });

      if (cleanupResult.deletedCount > 0) {
        console.log(
          `[OPERATIONS] Retention cleanup deleted ${cleanupResult.deletedCount} stale operation state record(s) older than ${Math.floor(cleanupResult.retentionMs / oneDayMs)} days.`
        );
      }
    } catch (error) {
      console.error("[OPERATIONS] Failed to run operation-state retention cleanup:", error);
    } finally {
      opportunisticCleanupInFlight = null;
    }
  })();

  await opportunisticCleanupInFlight;
}

export async function persistDurableOperationStateTransition(
  input: PersistDurableOperationStateTransitionInput
): Promise<DurableOperationState> {
  const now = input.timestamp ?? new Date().toISOString();
  const parameterName = getOperationStateParameterName(input.operationId);
  const existing = parseDurableOperationState(await readRawOperationState(parameterName));
  const nextState = buildNextOperationState(existing, input, now);

  await writeRawOperationState(parameterName, JSON.stringify(nextState));
  await runOpportunisticOperationStateCleanup(parameterName);
  return nextState;
}

export async function getDurableOperationState(operationId: string): Promise<DurableOperationState | null> {
  const parameterName = getOperationStateParameterName(operationId);
  return parseDurableOperationState(await readRawOperationState(parameterName));
}

export function resetDurableOperationStateStoreForTests(): void {
  inMemoryOperationStateStore.clear();
  hasLoggedInvalidRetentionConfig = false;
  lastOpportunisticCleanupStartedAt = 0;
  opportunisticCleanupInFlight = null;
}
