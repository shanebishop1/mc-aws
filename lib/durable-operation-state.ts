import type { BackupFenceAuthorization, BackupTerminalReceipt } from "@/lib/agent/contracts";
import { parseBackupFenceAuthorization, parseBackupTerminalReceipt } from "@/lib/agent/runtime/backup-fence";
import * as aws from "@/lib/aws";
import {
  isOperationConditionalFailure,
  readVersionedOperationRecord,
  writeVersionedOperationRecord,
} from "@/lib/aws/dynamodb-operation-store";
import { LIFECYCLE_LOCK_LEASE_MS, LIFECYCLE_OPERATION_MAX_DURATION_MS } from "@/lib/lifecycle-runtime-budget";
import {
  type ServerActionLock,
  ServerActionLockConflictError,
  acquireServerActionLockWithOperation,
  finalizeServerActionLockWithOperation,
  isAuthoritativeLifecycleLockOwned,
  renewServerActionLockWithOperation,
} from "@/lib/server-action-lock";
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
  "allowlist",
]);
const apiOperationTypes: ReadonlySet<OperationType> = new Set([
  "start",
  "stop",
  "backup",
  "restore",
  "hibernate",
  "resume",
]);
const emailOperationTypes: ReadonlySet<OperationType> = new Set([
  "start",
  "backup",
  "restore",
  "hibernate",
  "resume",
  "allowlist",
]);
const operationStatusPriority: Record<OperationStatus, number> = {
  accepted: 1,
  running: 2,
  completed: 3,
  failed: 3,
};
export type OperationPhase = "validating" | "dispatching" | "dispatched" | "executing" | "terminal";
const operationPhasePriority: Record<OperationPhase, number> = {
  validating: 1,
  dispatching: 2,
  dispatched: 3,
  executing: 4,
  terminal: 5,
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
  schemaVersion: 1;
  id: string;
  type: OperationType;
  route: string;
  status: OperationStatus;
  requestedAt: string;
  updatedAt: string;
  requestedBy?: string;
  lockId?: string;
  fencingToken?: number;
  lockLeaseGeneration?: number;
  lockLeaseExpiresAt?: string;
  instanceId?: string;
  lastError?: string;
  code?: string;
  phase?: OperationPhase;
  version?: number;
  deadlineAt?: string;
  maxDurationMs?: number;
  executionToken?: string;
  executionAttempt?: number;
  executionClaimedAt?: string;
  executionLeaseExpiresAt?: string;
  remoteCommandId?: string;
  /** Lambda-owned recovery metadata retained across Worker CAS writes. */
  remoteCommandIdentity?: string;
  remoteCommandInstanceId?: string;
  remoteCommandStep?: string;
  remoteCommandFinal?: boolean;
  remoteCommandStatus?: string;
  managedVolumeId?: string;
  managedVolumeDevice?: string;
  hibernatePhase?: string;
  hibernateOriginalInstanceId?: string;
  hibernateSourceImageId?: string;
  hibernateReconstructionSnapshotId?: string;
  hibernateBackupId?: string;
  hibernateBackupDigest?: string;
  hibernateBackupSize?: number;
  hibernateBackupGeneration?: number;
  hibernateBackupCreatedAt?: string;
  hibernateBackupOperationKey?: string;
  hibernateBackupInstanceId?: string;
  hibernateBackupServerId?: string;
  hibernateBackupArchiveName?: string;
  hibernateBackupAuthenticationKeyId?: string;
  hibernateQuiescenceEvidence?: Record<string, unknown>;
  resumeVolumeClientToken?: string;
  resumeVolumeId?: string;
  resumeSnapshotId?: string;
  resumeIntent?: { mode: "fresh" | "latest" | "named" | "replacement-convergence"; backupArchiveName?: string | null };
  sideEffectCompletedAt?: string;
  sideEffectKey?: string;
  agentEffectReconciliationStatus?: "awaiting-executor" | "active" | "needed" | "resolved";
  agentEffectReconciliationUpdatedAt?: string;
  agentEffectSafetyExpiresAt?: string;
  agentFenceAuthorization?: BackupFenceAuthorization;
  agentTerminalReceipt?: BackupTerminalReceipt;
  agentRuntimeId?: string;
  agentSessionId?: string;
  agentTaskId?: string;
  agentLeaseId?: string;
  agentLeaseGeneration?: number;
  agentInvocationId?: string;
  agentInvocationDigest?: string;
  requestIdempotencyKey?: string;
  dispatchOwnerId?: string;
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
  fencingToken?: number;
  lockLeaseGeneration?: number;
  lockLeaseExpiresAt?: string;
  instanceId?: string;
  error?: string;
  code?: string;
  timestamp?: string;
  phase?: OperationPhase;
  remoteCommandIdentity?: string;
  hibernateOriginalInstanceId?: string;
  hibernateSourceImageId?: string;
  hibernateReconstructionSnapshotId?: string;
  hibernateBackupId?: string;
  hibernateBackupDigest?: string;
  hibernateBackupSize?: number;
  hibernateBackupGeneration?: number;
  hibernateBackupCreatedAt?: string;
  hibernateBackupOperationKey?: string;
  hibernateBackupInstanceId?: string;
  hibernateBackupServerId?: string;
  hibernateBackupArchiveName?: string;
  hibernateBackupAuthenticationKeyId?: string;
  hibernateQuiescenceEvidence?: Record<string, unknown>;
  resumeVolumeClientToken?: string;
  resumeVolumeId?: string;
  resumeSnapshotId?: string;
  resumeIntent?: { mode: "fresh" | "latest" | "named" | "replacement-convergence"; backupArchiveName?: string | null };
  agentEffectReconciliationStatus?: "awaiting-executor" | "active" | "needed" | "resolved";
  agentEffectSafetyExpiresAt?: string;
  agentFenceAuthorization?: BackupFenceAuthorization;
  agentTerminalReceipt?: BackupTerminalReceipt;
  agentRuntimeId?: string;
  agentSessionId?: string;
  agentTaskId?: string;
  agentLeaseId?: string;
  agentLeaseGeneration?: number;
  agentInvocationId?: string;
  agentInvocationDigest?: string;
  requestIdempotencyKey?: string;
  dispatchOwnerId?: string;
}

export interface DurableOperationStateParameterRecord {
  name: string;
  value: string;
  version?: number;
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

export interface ExpireAcceptedDispatchResult {
  operation: DurableOperationState | null;
  shouldReleaseLock: boolean;
}

export interface ClaimDurableOperationLockInput extends PersistDurableOperationStateTransitionInput {
  ownerId: string;
  action: "backup";
  ownerEmail: string;
}

export interface ClaimDurableOperationLockResult {
  ownership: "acquired" | "attached" | "conflict";
  operation: DurableOperationState;
  lock?: ServerActionLock;
}

export interface RenewDurableOperationFenceInput {
  operationId: string;
  ownerEmail: string;
  expectedAuthorization?: BackupFenceAuthorization;
  createAuthorization: (lock: ServerActionLock) => Promise<BackupFenceAuthorization>;
  timestamp?: string;
}

export interface RenewDurableOperationFenceResult {
  operation: DurableOperationState;
  lock: ServerActionLock;
  authorization: BackupFenceAuthorization;
  ownership: "renewed" | "reconciled";
}

export interface FinalizeDurableOperationFenceInput {
  operation: DurableOperationState;
  ownerEmail: string;
  receipt: BackupTerminalReceipt;
  timestamp?: string;
}

/**
 * Finalizes only the operation version and lifecycle generation that produced
 * the receipt. The lock and operation updates are one conditional transaction.
 */
export async function finalizeDurableOperationFence(
  input: FinalizeDurableOperationFenceInput
): Promise<DurableOperationState> {
  const operation = input.operation;
  const timestamp = input.timestamp ?? new Date().toISOString();
  if (
    !Number.isSafeInteger(operation.version) ||
    !operation.lockId ||
    !Number.isSafeInteger(operation.fencingToken) ||
    !Number.isSafeInteger(operation.lockLeaseGeneration) ||
    !operation.dispatchOwnerId
  ) {
    throw new ServerActionLockConflictError(null);
  }
  const operationVersion = operation.version as number;
  const lockId = operation.lockId;
  const fencingToken = operation.fencingToken as number;
  const lockLeaseGeneration = operation.lockLeaseGeneration as number;
  const operationOwnerId = operation.dispatchOwnerId;
  const next = buildNextOperationState(
    operation,
    {
      operationId: operation.id,
      type: "backup",
      route: operation.route,
      status: "completed",
      source: "api",
      phase: "terminal",
      timestamp,
      agentEffectReconciliationStatus: "resolved",
      agentTerminalReceipt: input.receipt,
    },
    timestamp
  );
  const committed = await finalizeServerActionLockWithOperation({
    operationId: operation.id,
    operationOwnerId,
    expectedOperationVersion: operationVersion,
    lockId,
    fencingToken,
    expectedLeaseGeneration: lockLeaseGeneration,
    ownerEmail: input.ownerEmail,
    action: "backup",
    payload: JSON.stringify({ ...next, version: operationVersion + 1 }),
    status: "completed",
    phase: "terminal",
    updatedAt: timestamp,
    ttlEpochSeconds: Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000),
  });
  const parsed = parseDurableOperationState(committed.operationPayload);
  if (
    !parsed ||
    parsed.version !== committed.operationVersion ||
    parsed.agentEffectReconciliationStatus !== "resolved"
  ) {
    throw new Error("Atomic lifecycle finalization returned malformed durable authority");
  }
  return { ...parsed, version: committed.operationVersion };
}

const acceptedDispatchExpiredCode = "dispatch_expired";
const acceptedDispatchExpiredMessage = "The operation was not executed before its dispatch lease expired";

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

function parseOperationHistory(value: unknown): DurableOperationStateTransition[] | null {
  if (!Array.isArray(value)) return value === undefined ? [] : null;
  const history: DurableOperationStateTransition[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const { status, at, source } = entry;
    if (
      typeof status !== "string" ||
      !operationStatuses.has(status as OperationStatus) ||
      typeof at !== "string" ||
      !Number.isFinite(Date.parse(at)) ||
      typeof source !== "string" ||
      !transitionSources.has(source as OperationStateTransitionSource)
    ) {
      return null;
    }
    if (entry.error !== undefined && typeof entry.error !== "string") return null;
    if (entry.code !== undefined && typeof entry.code !== "string") return null;
    history.push({
      status: status as OperationStatus,
      at,
      source: source as OperationStateTransitionSource,
      error: normalizeOptionalText(entry.error),
      code: normalizeOptionalText(entry.code),
    });
  }
  return history.slice(-50);
}

function parseRetentionDays(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3650) {
    return null;
  }

  return parsed;
}

export function isValidDurableOperationRoute(route: string, type: OperationType): boolean {
  if (route === "/api/agent/runtime/backups") return type === "backup";
  if (route === `/api/${type}`) return apiOperationTypes.has(type);
  if (route === `/email/${type}`) return emailOperationTypes.has(type);
  return route === "/scheduled/backup" && type === "backup";
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

function isAcceptedDispatchAwaitingExecutor(operation: DurableOperationState): boolean {
  return operation.status === "accepted" && (operation.phase === "dispatching" || operation.phase === "dispatched");
}

export function getAcceptedDispatchExpiryAt(operation: DurableOperationState): string | null {
  if (!isAcceptedDispatchAwaitingExecutor(operation)) return null;
  return new Date(Date.parse(operation.updatedAt) + LIFECYCLE_LOCK_LEASE_MS).toISOString();
}

function isDispatchExpiryFailure(operation: DurableOperationState): boolean {
  return operation.status === "failed" && operation.code === acceptedDispatchExpiredCode;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One strict parser validates legacy SSM and current DynamoDB payloads identically.
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

    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
      return null;
    }

    if (
      !Number.isFinite(Date.parse(parsed.requestedAt)) ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      !isValidDurableOperationRoute(parsed.route, parsed.type)
    ) {
      return null;
    }

    const history = parseOperationHistory(parsed.history);
    if (!history) return null;

    const phase = operationPhasePriority[parsed.phase as OperationPhase]
      ? (parsed.phase as OperationPhase)
      : parsed.status === "completed" || parsed.status === "failed"
        ? "terminal"
        : parsed.status === "running"
          ? "executing"
          : "validating";
    const maxDurationMs =
      typeof parsed.maxDurationMs === "number" && Number.isSafeInteger(parsed.maxDurationMs) && parsed.maxDurationMs > 0
        ? parsed.maxDurationMs
        : LIFECYCLE_OPERATION_MAX_DURATION_MS;
    const deadlineAt = normalizeOptionalText(parsed.deadlineAt);
    if (deadlineAt && !Number.isFinite(Date.parse(deadlineAt))) return null;
    if (parsed.version !== undefined && (!Number.isSafeInteger(parsed.version) || parsed.version < 1)) return null;
    const executionClaimedAt = normalizeOptionalText(parsed.executionClaimedAt);
    const executionLeaseExpiresAt = normalizeOptionalText(parsed.executionLeaseExpiresAt);
    const sideEffectCompletedAt = normalizeOptionalText(parsed.sideEffectCompletedAt);
    const agentEffectReconciliationUpdatedAt = normalizeOptionalText(parsed.agentEffectReconciliationUpdatedAt);
    const agentEffectSafetyExpiresAt = normalizeOptionalText(parsed.agentEffectSafetyExpiresAt);
    const lockLeaseExpiresAt = normalizeOptionalText(parsed.lockLeaseExpiresAt);
    if (executionClaimedAt && !Number.isFinite(Date.parse(executionClaimedAt))) return null;
    if (executionLeaseExpiresAt && !Number.isFinite(Date.parse(executionLeaseExpiresAt))) return null;
    if (sideEffectCompletedAt && !Number.isFinite(Date.parse(sideEffectCompletedAt))) return null;
    if (agentEffectReconciliationUpdatedAt && !Number.isFinite(Date.parse(agentEffectReconciliationUpdatedAt)))
      return null;
    if (agentEffectSafetyExpiresAt && !Number.isFinite(Date.parse(agentEffectSafetyExpiresAt))) return null;
    if (lockLeaseExpiresAt && !Number.isFinite(Date.parse(lockLeaseExpiresAt))) return null;
    if (
      parsed.agentEffectReconciliationStatus !== undefined &&
      parsed.agentEffectReconciliationStatus !== "awaiting-executor" &&
      parsed.agentEffectReconciliationStatus !== "active" &&
      parsed.agentEffectReconciliationStatus !== "needed" &&
      parsed.agentEffectReconciliationStatus !== "resolved"
    ) {
      return null;
    }
    const agentFenceAuthorization = parsed.agentFenceAuthorization;
    if (agentFenceAuthorization !== undefined) {
      try {
        parseBackupFenceAuthorization(agentFenceAuthorization);
      } catch {
        return null;
      }
    }
    const agentTerminalReceipt = parsed.agentTerminalReceipt;
    if (agentTerminalReceipt !== undefined) {
      try {
        parseBackupTerminalReceipt(agentTerminalReceipt);
      } catch {
        return null;
      }
    }
    const agentBinding = [
      parsed.agentRuntimeId,
      parsed.agentSessionId,
      parsed.agentTaskId,
      parsed.agentLeaseId,
      parsed.agentLeaseGeneration,
      parsed.agentInvocationId,
      parsed.agentInvocationDigest,
    ];
    const hasAgentBinding = agentBinding.some((value) => value !== undefined);
    if (
      hasAgentBinding &&
      (!agentBinding
        .slice(0, 4)
        .every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) ||
        !Number.isSafeInteger(parsed.agentLeaseGeneration) ||
        (parsed.agentLeaseGeneration ?? 0) < 1 ||
        typeof parsed.agentInvocationId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed.agentInvocationId) ||
        typeof parsed.agentInvocationDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.agentInvocationDigest))
    ) {
      return null;
    }
    if (
      parsed.executionAttempt !== undefined &&
      (!Number.isSafeInteger(parsed.executionAttempt) || parsed.executionAttempt < 1)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
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
      phase,
      version: parsed.version,
      deadlineAt: deadlineAt ?? new Date(Date.parse(parsed.requestedAt) + maxDurationMs).toISOString(),
      maxDurationMs,
      fencingToken: Number.isSafeInteger(parsed.fencingToken) ? parsed.fencingToken : undefined,
      lockLeaseGeneration:
        Number.isSafeInteger(parsed.lockLeaseGeneration) && (parsed.lockLeaseGeneration ?? 0) >= 1
          ? parsed.lockLeaseGeneration
          : undefined,
      lockLeaseExpiresAt,
      executionToken: normalizeOptionalText(parsed.executionToken),
      executionAttempt: Number.isSafeInteger(parsed.executionAttempt) ? parsed.executionAttempt : undefined,
      executionClaimedAt,
      executionLeaseExpiresAt,
      remoteCommandId: normalizeOptionalText(parsed.remoteCommandId),
      remoteCommandIdentity: normalizeOptionalText(parsed.remoteCommandIdentity),
      remoteCommandInstanceId: normalizeOptionalText(parsed.remoteCommandInstanceId),
      remoteCommandStep: normalizeOptionalText(parsed.remoteCommandStep),
      remoteCommandFinal: typeof parsed.remoteCommandFinal === "boolean" ? parsed.remoteCommandFinal : undefined,
      remoteCommandStatus: normalizeOptionalText(parsed.remoteCommandStatus),
      managedVolumeId: normalizeOptionalText(parsed.managedVolumeId),
      managedVolumeDevice: normalizeOptionalText(parsed.managedVolumeDevice),
      hibernatePhase: normalizeOptionalText(parsed.hibernatePhase),
      hibernateOriginalInstanceId: normalizeOptionalText(parsed.hibernateOriginalInstanceId),
      hibernateSourceImageId: normalizeOptionalText(parsed.hibernateSourceImageId),
      hibernateReconstructionSnapshotId: normalizeOptionalText(parsed.hibernateReconstructionSnapshotId),
      hibernateBackupId: normalizeOptionalText(parsed.hibernateBackupId),
      hibernateBackupDigest: normalizeOptionalText(parsed.hibernateBackupDigest),
      hibernateBackupSize:
        Number.isSafeInteger(parsed.hibernateBackupSize) && (parsed.hibernateBackupSize ?? 0) >= 1
          ? parsed.hibernateBackupSize
          : undefined,
      hibernateBackupGeneration:
        Number.isSafeInteger(parsed.hibernateBackupGeneration) && (parsed.hibernateBackupGeneration ?? 0) >= 1
          ? parsed.hibernateBackupGeneration
          : undefined,
      hibernateBackupCreatedAt: normalizeOptionalText(parsed.hibernateBackupCreatedAt),
      hibernateBackupOperationKey: normalizeOptionalText(parsed.hibernateBackupOperationKey),
      hibernateBackupInstanceId: normalizeOptionalText(parsed.hibernateBackupInstanceId),
      hibernateBackupServerId: normalizeOptionalText(parsed.hibernateBackupServerId),
      hibernateBackupArchiveName: normalizeOptionalText(parsed.hibernateBackupArchiveName),
      hibernateBackupAuthenticationKeyId: normalizeOptionalText(parsed.hibernateBackupAuthenticationKeyId),
      hibernateQuiescenceEvidence: isObject(parsed.hibernateQuiescenceEvidence)
        ? parsed.hibernateQuiescenceEvidence
        : undefined,
      resumeVolumeClientToken: normalizeOptionalText(parsed.resumeVolumeClientToken),
      resumeVolumeId: normalizeOptionalText(parsed.resumeVolumeId),
      resumeSnapshotId: normalizeOptionalText(parsed.resumeSnapshotId),
      resumeIntent: isObject(parsed.resumeIntent)
        ? (parsed.resumeIntent as DurableOperationState["resumeIntent"])
        : undefined,
      sideEffectCompletedAt,
      sideEffectKey: normalizeOptionalText(parsed.sideEffectKey),
      agentEffectReconciliationStatus: parsed.agentEffectReconciliationStatus,
      agentEffectReconciliationUpdatedAt,
      agentEffectSafetyExpiresAt,
      agentFenceAuthorization: agentFenceAuthorization as BackupFenceAuthorization | undefined,
      agentTerminalReceipt: agentTerminalReceipt as BackupTerminalReceipt | undefined,
      agentRuntimeId: normalizeOptionalText(parsed.agentRuntimeId),
      agentSessionId: normalizeOptionalText(parsed.agentSessionId),
      agentTaskId: normalizeOptionalText(parsed.agentTaskId),
      agentLeaseId: normalizeOptionalText(parsed.agentLeaseId),
      agentLeaseGeneration: Number.isSafeInteger(parsed.agentLeaseGeneration) ? parsed.agentLeaseGeneration : undefined,
      agentInvocationId: normalizeOptionalText(parsed.agentInvocationId),
      agentInvocationDigest: normalizeOptionalText(parsed.agentInvocationDigest),
      requestIdempotencyKey: normalizeOptionalText(parsed.requestIdempotencyKey),
      dispatchOwnerId: normalizeOptionalText(parsed.dispatchOwnerId),
      history,
    };
  } catch {
    return null;
  }
}

function isMockBackendMode(): boolean {
  return process.env.MC_BACKEND_MODE?.trim().toLowerCase() === "mock";
}

function shouldUseInMemoryStore(): boolean {
  // Unit route tests intentionally mock the public AWS facade. Global mock
  // mode must not leak through the test runner and bypass that isolated store.
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  // Mock mode uses the provider-backed SSM store so API routes and simulated
  // Lambda completions observe the same operation record across module reloads.
  if (isMockBackendMode()) {
    return false;
  }

  const awsModule = aws as {
    getParameter?: unknown;
    getParameterRecord?: unknown;
    putParameter?: unknown;
    deleteParameter?: unknown;
    listParametersByPath?: unknown;
  };

  return (
    typeof awsModule.getParameter !== "function" ||
    typeof awsModule.getParameterRecord !== "function" ||
    typeof awsModule.putParameter !== "function" ||
    typeof awsModule.deleteParameter !== "function" ||
    typeof awsModule.listParametersByPath !== "function"
  );
}

function shouldUseVersionedOperationStore(): boolean {
  // Local mock mode must keep operation records beside its lifecycle lock in
  // the mock SSM store. Next dev loads deployment table names from .env even
  // when MC_BACKEND_MODE=mock; honoring those names splits the operation and
  // lock identities across stores, so the simulated Lambda rejects a fresh
  // delivery as stale. AWS mode retains the versioned DynamoDB path.
  return !isMockBackendMode() && Boolean(process.env.MC_OPERATION_STATE_TABLE_NAME?.trim());
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

async function deleteRawOperationState(record: DurableOperationStateParameterRecord): Promise<boolean> {
  if (shouldUseInMemoryStore()) {
    if (!inMemoryOperationStateStore.has(record.name)) return false;
    inMemoryOperationStateStore.delete(record.name);
    return true;
  }

  // SSM has no conditional DeleteParameter API. Do not create a claim and
  // then perform a read/delete sequence: the target can be replaced between
  // those operations. The durable record is retained for explicit cleanup by
  // a backend with an atomic conditional mutation primitive.
  void record;
  return false;
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
    version: record.version,
    lastModifiedAt: record.lastModifiedAt,
  }));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Centralized merge rules keep optimistic writers monotonic and consistent.
function buildNextOperationState(
  existing: DurableOperationState | null,
  input: PersistDurableOperationStateTransitionInput,
  now: string
): DurableOperationState {
  const route = existing?.route ?? input.route ?? `/api/${input.type}`;
  const requestedAt = existing?.requestedAt ?? input.requestedAt ?? now;
  const requestedBy = normalizeOptionalText(input.requestedBy) ?? existing?.requestedBy;
  const lockId = existing?.lockId ?? normalizeOptionalText(input.lockId);
  const fencingToken =
    existing?.fencingToken ??
    (typeof input.fencingToken === "number" && Number.isSafeInteger(input.fencingToken) && input.fencingToken > 0
      ? input.fencingToken
      : undefined);
  const instanceId = normalizeOptionalText(input.instanceId) ?? existing?.instanceId;
  const incomingLockLeaseGeneration =
    Number.isSafeInteger(input.lockLeaseGeneration) && (input.lockLeaseGeneration ?? 0) >= 1
      ? input.lockLeaseGeneration
      : undefined;
  const lockLeaseGeneration =
    Math.max(existing?.lockLeaseGeneration ?? 0, incomingLockLeaseGeneration ?? 0) || undefined;
  const lockLeaseExpiresAt =
    lockLeaseGeneration === incomingLockLeaseGeneration
      ? (normalizeOptionalText(input.lockLeaseExpiresAt) ?? existing?.lockLeaseExpiresAt)
      : existing?.lockLeaseExpiresAt;
  const requestedAtMs = Date.parse(requestedAt);
  const maxDurationMs = existing?.maxDurationMs ?? LIFECYCLE_OPERATION_MAX_DURATION_MS;
  const requestedPhase =
    input.phase ??
    (input.status === "completed" || input.status === "failed"
      ? "terminal"
      : input.status === "running"
        ? "executing"
        : "validating");
  const phase =
    existing && operationPhasePriority[existing.phase ?? "validating"] > operationPhasePriority[requestedPhase]
      ? existing.phase
      : requestedPhase;

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
    schemaVersion: 1,
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
    phase,
    deadlineAt: existing?.deadlineAt ?? new Date(requestedAtMs + maxDurationMs).toISOString(),
    maxDurationMs,
    fencingToken,
    lockLeaseGeneration,
    lockLeaseExpiresAt,
    executionToken: existing?.executionToken,
    executionAttempt: existing?.executionAttempt,
    executionClaimedAt: existing?.executionClaimedAt,
    executionLeaseExpiresAt: existing?.executionLeaseExpiresAt,
    remoteCommandId: existing?.remoteCommandId,
    remoteCommandIdentity: normalizeOptionalText(input.remoteCommandIdentity) ?? existing?.remoteCommandIdentity,
    remoteCommandInstanceId: existing?.remoteCommandInstanceId,
    remoteCommandStep: existing?.remoteCommandStep,
    remoteCommandFinal: existing?.remoteCommandFinal,
    remoteCommandStatus: existing?.remoteCommandStatus,
    managedVolumeId: existing?.managedVolumeId,
    managedVolumeDevice: existing?.managedVolumeDevice,
    hibernatePhase: existing?.hibernatePhase,
    hibernateOriginalInstanceId:
      normalizeOptionalText(input.hibernateOriginalInstanceId) ?? existing?.hibernateOriginalInstanceId,
    hibernateSourceImageId: normalizeOptionalText(input.hibernateSourceImageId) ?? existing?.hibernateSourceImageId,
    hibernateReconstructionSnapshotId:
      normalizeOptionalText(input.hibernateReconstructionSnapshotId) ?? existing?.hibernateReconstructionSnapshotId,
    hibernateBackupId: normalizeOptionalText(input.hibernateBackupId) ?? existing?.hibernateBackupId,
    hibernateBackupDigest: normalizeOptionalText(input.hibernateBackupDigest) ?? existing?.hibernateBackupDigest,
    hibernateBackupSize:
      Number.isSafeInteger(input.hibernateBackupSize) && (input.hibernateBackupSize ?? 0) >= 1
        ? input.hibernateBackupSize
        : existing?.hibernateBackupSize,
    hibernateBackupGeneration:
      Number.isSafeInteger(input.hibernateBackupGeneration) && (input.hibernateBackupGeneration ?? 0) >= 1
        ? input.hibernateBackupGeneration
        : existing?.hibernateBackupGeneration,
    hibernateBackupCreatedAt:
      normalizeOptionalText(input.hibernateBackupCreatedAt) ?? existing?.hibernateBackupCreatedAt,
    hibernateBackupOperationKey:
      normalizeOptionalText(input.hibernateBackupOperationKey) ?? existing?.hibernateBackupOperationKey,
    hibernateBackupInstanceId:
      normalizeOptionalText(input.hibernateBackupInstanceId) ?? existing?.hibernateBackupInstanceId,
    hibernateBackupServerId: normalizeOptionalText(input.hibernateBackupServerId) ?? existing?.hibernateBackupServerId,
    hibernateBackupArchiveName:
      normalizeOptionalText(input.hibernateBackupArchiveName) ?? existing?.hibernateBackupArchiveName,
    hibernateBackupAuthenticationKeyId:
      normalizeOptionalText(input.hibernateBackupAuthenticationKeyId) ?? existing?.hibernateBackupAuthenticationKeyId,
    hibernateQuiescenceEvidence: input.hibernateQuiescenceEvidence ?? existing?.hibernateQuiescenceEvidence,
    resumeVolumeClientToken: normalizeOptionalText(input.resumeVolumeClientToken) ?? existing?.resumeVolumeClientToken,
    resumeVolumeId: normalizeOptionalText(input.resumeVolumeId) ?? existing?.resumeVolumeId,
    resumeSnapshotId: normalizeOptionalText(input.resumeSnapshotId) ?? existing?.resumeSnapshotId,
    resumeIntent: input.resumeIntent ?? existing?.resumeIntent,
    sideEffectCompletedAt: existing?.sideEffectCompletedAt,
    sideEffectKey: existing?.sideEffectKey,
    agentEffectReconciliationStatus: input.agentEffectReconciliationStatus ?? existing?.agentEffectReconciliationStatus,
    agentEffectReconciliationUpdatedAt: input.agentEffectReconciliationStatus
      ? now
      : existing?.agentEffectReconciliationUpdatedAt,
    agentEffectSafetyExpiresAt:
      normalizeOptionalText(input.agentEffectSafetyExpiresAt) ?? existing?.agentEffectSafetyExpiresAt,
    agentFenceAuthorization:
      !existing?.agentFenceAuthorization ||
      (input.agentFenceAuthorization?.lifecycleLeaseGeneration ?? 0) >=
        existing.agentFenceAuthorization.lifecycleLeaseGeneration
        ? (input.agentFenceAuthorization ?? existing?.agentFenceAuthorization)
        : existing.agentFenceAuthorization,
    agentTerminalReceipt: input.agentTerminalReceipt ?? existing?.agentTerminalReceipt,
    agentRuntimeId: existing?.agentRuntimeId ?? normalizeOptionalText(input.agentRuntimeId),
    agentSessionId: existing?.agentSessionId ?? normalizeOptionalText(input.agentSessionId),
    agentTaskId: existing?.agentTaskId ?? normalizeOptionalText(input.agentTaskId),
    agentLeaseId: existing?.agentLeaseId ?? normalizeOptionalText(input.agentLeaseId),
    agentLeaseGeneration:
      existing?.agentLeaseGeneration ??
      (Number.isSafeInteger(input.agentLeaseGeneration) && (input.agentLeaseGeneration ?? 0) >= 1
        ? input.agentLeaseGeneration
        : undefined),
    agentInvocationId: existing?.agentInvocationId ?? normalizeOptionalText(input.agentInvocationId),
    agentInvocationDigest: existing?.agentInvocationDigest ?? normalizeOptionalText(input.agentInvocationDigest),
    requestIdempotencyKey: existing?.requestIdempotencyKey ?? normalizeOptionalText(input.requestIdempotencyKey),
    dispatchOwnerId: existing?.dispatchOwnerId ?? normalizeOptionalText(input.dispatchOwnerId),
    history: history.slice(-50),
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

    // Retention cleanup is not migration. Invalid, legacy, and proof-less
    // records have no trustworthy lifecycle identity and must be preserved.
    if (!parseDurableOperationState(record.value)) return [];
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

async function hasOwnedLifecycleLock(record: DurableOperationStateParameterRecord | undefined): Promise<boolean> {
  const state = parseDurableOperationState(record?.value ?? "");
  if (!state) return false;
  if (state.status !== "completed" && state.status !== "failed") return true;
  if (!state.lockId || !Number.isSafeInteger(state.fencingToken)) return false;
  return isAuthoritativeLifecycleLockOwned({
    operationId: state.id,
    lockId: state.lockId,
    fencingToken: state.fencingToken as number,
    action: state.type,
  });
}

export async function isDurableOperationStateCleanupProtected(raw: string): Promise<boolean> {
  const state = parseDurableOperationState(raw);
  if (!state) return true;
  if (state.status !== "completed" && state.status !== "failed") return true;
  if (!state.lockId || !Number.isSafeInteger(state.fencingToken)) return false;
  return isAuthoritativeLifecycleLockOwned({
    operationId: state.id,
    lockId: state.lockId,
    fencingToken: state.fencingToken as number,
    action: state.type,
  });
}

async function excludeProtectedOperationStates(
  names: string[],
  records: DurableOperationStateParameterRecord[]
): Promise<string[]> {
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const deletable: string[] = [];
  for (const name of names) {
    if (!(await hasOwnedLifecycleLock(recordsByName.get(name)))) deletable.push(name);
  }
  return deletable;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cleanup selection and fail-closed deletion are one auditable lifecycle boundary.
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
  const deletableParameterNames = await excludeProtectedOperationStates(expiredParameterNames, records);
  const selectedParameterNames = deletableParameterNames.slice(0, maxDeletions);
  const deletedParameterNames: string[] = [];

  if (!input.dryRun) {
    const recordsByName = new Map(records.map((record) => [record.name, record]));
    for (const parameterName of selectedParameterNames) {
      try {
        if (await deleteRawOperationState(recordsByName.get(parameterName) as DurableOperationStateParameterRecord)) {
          deletedParameterNames.push(parameterName);
        }
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
    } catch {
      console.error("[OPERATIONS] Failed to run operation-state retention cleanup");
    } finally {
      opportunisticCleanupInFlight = null;
    }
  })();

  await opportunisticCleanupInFlight;
}

async function persistInMemoryOperationStateTransition(
  input: PersistDurableOperationStateTransitionInput,
  parameterName: string,
  now: string
): Promise<DurableOperationState> {
  const existing = parseDurableOperationState(await readRawOperationState(parameterName));
  const nextState = { ...buildNextOperationState(existing, input, now), version: (existing?.version ?? 0) + 1 };
  await writeRawOperationState(parameterName, JSON.stringify(nextState));
  await runOpportunisticOperationStateCleanup(parameterName);
  return nextState;
}

function assertInMemoryOperationStateWritesAllowed(): void {
  if (!shouldUseInMemoryStore() && !isMockBackendMode()) {
    throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for durable operation state writes");
  }
}

export async function persistDurableOperationStateTransition(
  input: PersistDurableOperationStateTransitionInput
): Promise<DurableOperationState> {
  const now = input.timestamp ?? new Date().toISOString();
  const parameterName = getOperationStateParameterName(input.operationId);
  if (!shouldUseVersionedOperationStore()) {
    assertInMemoryOperationStateWritesAllowed();
    return await persistInMemoryOperationStateTransition(input, parameterName, now);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await readVersionedOperationRecord(input.operationId);
    const legacy = record ? null : parseDurableOperationState(await readRawOperationState(parameterName));
    const existing = parseDurableOperationState(record?.payload ?? null) ?? legacy;
    const nextState = buildNextOperationState(existing, input, now);
    const expectedVersion = record?.version ?? 0;
    try {
      const version = await writeVersionedOperationRecord({
        operationId: input.operationId,
        expectedVersion,
        payload: JSON.stringify({ ...nextState, version: expectedVersion + 1 }),
        status: nextState.status,
        phase: nextState.phase ?? "validating",
        updatedAt: nextState.updatedAt,
        ttlEpochSeconds: Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000),
      });
      return { ...nextState, version };
    } catch (error) {
      if (!isOperationConditionalFailure(error)) throw error;
    }
  }
  throw new Error(`Operation state contention exceeded retry budget for ${input.operationId}`);
}

/**
 * Establishes the idempotency record before touching the legacy global fence,
 * then atomically binds the DynamoDB fence and operation owner. Duplicate
 * callers attach to the resulting operation and never become dispatch owners.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Initial durability, atomic lock binding, and ambiguity reconciliation are one ownership protocol.
export async function claimDurableOperationLock(
  input: ClaimDurableOperationLockInput
): Promise<ClaimDurableOperationLockResult> {
  if (!shouldUseVersionedOperationStore()) {
    throw new Error("Atomic operation-bound lifecycle acquisition requires versioned operation state");
  }
  const timestamp = input.timestamp ?? new Date().toISOString();
  let operation: DurableOperationState | null = null;
  try {
    operation = await persistDurableOperationStateTransition({
      ...input,
      status: "accepted",
      phase: "validating",
      timestamp,
      requestIdempotencyKey: input.requestIdempotencyKey ?? input.operationId,
      dispatchOwnerId: undefined,
    });
  } catch (error) {
    operation = await getDurableOperationState(input.operationId).catch(() => null);
    if (!operation) throw error;
  }
  if (
    operation.type !== input.type ||
    operation.route !== input.route ||
    operation.requestedBy?.toLowerCase() !== input.ownerEmail.trim().toLowerCase() ||
    operation.requestIdempotencyKey !== (input.requestIdempotencyKey ?? input.operationId)
  ) {
    throw new Error("Durable lifecycle operation idempotency ownership does not match");
  }
  if (operation.lockId || operation.status !== "accepted" || operation.phase !== "validating") {
    return { ownership: "attached", operation };
  }
  if (!Number.isSafeInteger(operation.version) || (operation.version ?? 0) < 1) {
    throw new Error("Durable lifecycle operation is missing its version");
  }

  const expectedVersion = operation.version as number;
  let candidate: DurableOperationState | undefined;
  try {
    const claimed = await acquireServerActionLockWithOperation(input.action, input.ownerEmail, {
      operationId: operation.id,
      ownerId: input.ownerId,
      expectedVersion,
      status: "accepted",
      phase: "dispatching",
      updatedAt: timestamp,
      ttlEpochSeconds: Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000),
      payload: (lock) => {
        candidate = buildNextOperationState(
          operation,
          {
            ...input,
            status: "accepted",
            phase: "dispatching",
            timestamp,
            lockId: lock.lockId,
            fencingToken: lock.fencingToken,
            lockLeaseGeneration: lock.leaseGeneration,
            lockLeaseExpiresAt: lock.expiresAt,
            dispatchOwnerId: input.ownerId,
          },
          timestamp
        );
        return JSON.stringify({ ...candidate, version: expectedVersion + 1 });
      },
    });
    const reconciled = await getDurableOperationState(operation.id);
    if (!reconciled?.lockId || reconciled.lockId !== claimed.lock.lockId) {
      throw new Error("Atomic lifecycle ownership committed without a matching durable operation");
    }
    return { ownership: claimed.ownership, operation: reconciled, lock: claimed.lock };
  } catch (error) {
    const reconciled = await getDurableOperationState(operation.id).catch(() => null);
    if (reconciled?.lockId && reconciled.dispatchOwnerId) {
      return {
        ownership: reconciled.dispatchOwnerId === input.ownerId ? "acquired" : "attached",
        operation: reconciled,
      };
    }
    if (error instanceof ServerActionLockConflictError) {
      return { ownership: "conflict", operation: reconciled ?? operation };
    }
    throw error;
  }
}

function sameFenceBinding(left: BackupFenceAuthorization, right: BackupFenceAuthorization): boolean {
  return (
    left.authorizationId === right.authorizationId &&
    left.runtimeId === right.runtimeId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.invocationId === right.invocationId &&
    left.invocationDigest === right.invocationDigest &&
    left.backupId === right.backupId &&
    left.lifecycleLockId === right.lifecycleLockId &&
    left.lifecycleFencingToken === right.lifecycleFencingToken
  );
}

function exactFenceOperationIdentity(
  operation: DurableOperationState,
  lock: ServerActionLock,
  ownerEmail: string,
  expectedAuthorization?: BackupFenceAuthorization
): boolean {
  const authorization = operation.agentFenceAuthorization;
  return (
    operation.type === "backup" &&
    operation.route === "/api/agent/runtime/backups" &&
    operation.status === "completed" &&
    operation.phase === "terminal" &&
    operation.requestedBy?.toLowerCase() === ownerEmail.trim().toLowerCase() &&
    operation.lockId === lock.lockId &&
    operation.fencingToken === lock.fencingToken &&
    operation.lockLeaseGeneration === lock.leaseGeneration &&
    operation.dispatchOwnerId === lock.operationOwnerId &&
    operation.agentEffectReconciliationStatus !== "resolved" &&
    Boolean(authorization) &&
    authorization?.backupId === operation.id &&
    authorization.lifecycleLockId === lock.lockId &&
    authorization.lifecycleFencingToken === lock.fencingToken &&
    authorization.lifecycleLeaseGeneration === lock.leaseGeneration &&
    (!expectedAuthorization ||
      (authorization.lifecycleLeaseGeneration >= expectedAuthorization.lifecycleLeaseGeneration &&
        sameFenceBinding(authorization, expectedAuthorization)))
  );
}

/**
 * Atomically publishes the next lifecycle generation and the exact signed
 * authorization in the operation record. A duplicate or response-loss retry
 * may attach only after strongly consistent reads prove the complete identity
 * of both records.
 */
export async function renewDurableOperationFence(
  input: RenewDurableOperationFenceInput
): Promise<RenewDurableOperationFenceResult> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const operation = await getDurableOperationState(input.operationId);
  if (
    !operation ||
    operation.type !== "backup" ||
    operation.route !== "/api/agent/runtime/backups" ||
    operation.status !== "completed" ||
    operation.phase !== "terminal" ||
    operation.requestedBy?.toLowerCase() !== input.ownerEmail.trim().toLowerCase() ||
    !operation.lockId ||
    !Number.isSafeInteger(operation.fencingToken) ||
    !Number.isSafeInteger(operation.lockLeaseGeneration) ||
    !Number.isSafeInteger(operation.version) ||
    !operation.dispatchOwnerId ||
    operation.agentEffectReconciliationStatus === "resolved"
  ) {
    throw new ServerActionLockConflictError(null);
  }
  if (
    input.expectedAuthorization &&
    (input.expectedAuthorization.backupId !== operation.id ||
      input.expectedAuthorization.lifecycleLockId !== operation.lockId ||
      input.expectedAuthorization.lifecycleFencingToken !== operation.fencingToken ||
      input.expectedAuthorization.lifecycleLeaseGeneration > (operation.lockLeaseGeneration as number) ||
      (operation.agentFenceAuthorization &&
        !sameFenceBinding(operation.agentFenceAuthorization, input.expectedAuthorization)))
  ) {
    throw new ServerActionLockConflictError(null);
  }
  if (!input.expectedAuthorization && operation.agentFenceAuthorization) {
    throw new ServerActionLockConflictError(null);
  }

  let candidateAuthorization: BackupFenceAuthorization | undefined;
  const renewed = await renewServerActionLockWithOperation(operation.lockId, operation.fencingToken as number, {
    operationId: operation.id,
    operationOwnerId: operation.dispatchOwnerId,
    expectedOperationVersion: operation.version as number,
    expectedLeaseGeneration:
      input.expectedAuthorization?.lifecycleLeaseGeneration ?? (operation.lockLeaseGeneration as number),
    updatedAt: timestamp,
    ttlEpochSeconds: Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000),
    payload: async (lock, nextOperationVersion) => {
      candidateAuthorization = await input.createAuthorization(lock);
      if (
        candidateAuthorization.lifecycleLockId !== lock.lockId ||
        candidateAuthorization.lifecycleFencingToken !== lock.fencingToken ||
        candidateAuthorization.lifecycleLeaseGeneration !== lock.leaseGeneration ||
        candidateAuthorization.backupId !== operation.id
      ) {
        throw new Error("Renewed lifecycle authorization did not match its atomic lock generation");
      }
      const next = buildNextOperationState(
        operation,
        {
          operationId: operation.id,
          type: "backup",
          route: operation.route,
          status: "completed",
          source: "api",
          phase: "terminal",
          timestamp,
          lockLeaseGeneration: lock.leaseGeneration,
          lockLeaseExpiresAt: lock.expiresAt,
          agentEffectReconciliationStatus:
            operation.agentEffectReconciliationStatus === "needed"
              ? "needed"
              : input.expectedAuthorization
                ? "active"
                : "awaiting-executor",
          agentFenceAuthorization: candidateAuthorization,
        },
        timestamp
      );
      return JSON.stringify({ ...next, version: nextOperationVersion });
    },
    reconcile: (payload, lock, operationVersion) => {
      const current = parseDurableOperationState(payload);
      return Boolean(
        current &&
          current.version === operationVersion &&
          exactFenceOperationIdentity(current, lock, input.ownerEmail, input.expectedAuthorization)
      );
    },
  });
  const current = parseDurableOperationState(renewed.operationPayload);
  if (
    !current ||
    current.version !== renewed.operationVersion ||
    !exactFenceOperationIdentity(current, renewed.lock, input.ownerEmail, input.expectedAuthorization) ||
    !current.agentFenceAuthorization
  ) {
    throw new Error("Atomic lifecycle renewal returned malformed durable authority");
  }
  return {
    operation: current,
    lock: renewed.lock,
    authorization: current.agentFenceAuthorization,
    ownership: renewed.ownership,
  };
}

function buildAcceptedDispatchExpiryTransition(
  operation: DurableOperationState,
  timestamp: string
): DurableOperationState {
  return buildNextOperationState(
    operation,
    {
      operationId: operation.id,
      type: operation.type,
      status: "failed",
      source: "api",
      timestamp,
      error: acceptedDispatchExpiredMessage,
      code: acceptedDispatchExpiredCode,
      phase: "terminal",
    },
    timestamp
  );
}

function shouldExpireAcceptedDispatch(operation: DurableOperationState, nowMs: number): boolean {
  const expiresAt = getAcceptedDispatchExpiryAt(operation);
  return expiresAt !== null && nowMs >= Date.parse(expiresAt);
}

function getAcceptedDispatchResultWithoutWrite(
  operation: DurableOperationState | null,
  nowMs: number
): ExpireAcceptedDispatchResult | null {
  if (operation && shouldExpireAcceptedDispatch(operation, nowMs)) return null;
  return {
    operation,
    shouldReleaseLock: operation ? isDispatchExpiryFailure(operation) : false,
  };
}

async function expireAcceptedDispatchInMemory(input: {
  parameterName: string;
  nowMs: number;
  timestamp: string;
}): Promise<ExpireAcceptedDispatchResult> {
  assertInMemoryOperationStateWritesAllowed();
  const existing = parseDurableOperationState(await readRawOperationState(input.parameterName));
  const resultWithoutWrite = getAcceptedDispatchResultWithoutWrite(existing, input.nowMs);
  if (resultWithoutWrite) return resultWithoutWrite;

  const expired = buildAcceptedDispatchExpiryTransition(existing as DurableOperationState, input.timestamp);
  await writeRawOperationState(input.parameterName, JSON.stringify(expired));
  return { operation: expired, shouldReleaseLock: true };
}

async function readAcceptedDispatchExpiryCandidate(
  operationId: string,
  parameterName: string
): Promise<{
  operation: DurableOperationState | null;
  expectedVersion: number;
}> {
  const record = await readVersionedOperationRecord(operationId);
  const legacy = record ? null : parseDurableOperationState(await readRawOperationState(parameterName));
  return {
    operation: parseDurableOperationState(record?.payload ?? null) ?? legacy,
    expectedVersion: record?.version ?? 0,
  };
}

async function tryWriteAcceptedDispatchExpiry(input: {
  operationId: string;
  expectedVersion: number;
  expired: DurableOperationState;
}): Promise<ExpireAcceptedDispatchResult | null> {
  try {
    const version = await writeVersionedOperationRecord({
      operationId: input.operationId,
      expectedVersion: input.expectedVersion,
      payload: JSON.stringify({ ...input.expired, version: input.expectedVersion + 1 }),
      status: input.expired.status,
      phase: input.expired.phase ?? "terminal",
      updatedAt: input.expired.updatedAt,
      ttlEpochSeconds: Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000),
    });
    return { operation: { ...input.expired, version }, shouldReleaseLock: true };
  } catch (error) {
    if (isOperationConditionalFailure(error)) return null;
    throw error;
  }
}

async function expireAcceptedDispatchInDynamoDb(input: {
  operationId: string;
  parameterName: string;
  nowMs: number;
  timestamp: string;
}): Promise<ExpireAcceptedDispatchResult> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await readAcceptedDispatchExpiryCandidate(input.operationId, input.parameterName);
    const resultWithoutWrite = getAcceptedDispatchResultWithoutWrite(candidate.operation, input.nowMs);
    if (resultWithoutWrite) return resultWithoutWrite;

    const expired = buildAcceptedDispatchExpiryTransition(
      candidate.operation as DurableOperationState,
      input.timestamp
    );
    const written = await tryWriteAcceptedDispatchExpiry({
      operationId: input.operationId,
      expectedVersion: candidate.expectedVersion,
      expired,
    });
    if (written) return written;
  }
  throw new Error(`Operation expiry contention exceeded retry budget for ${input.operationId}`);
}

/**
 * Conditionally terminalizes an accepted dispatch after the lock lease
 * boundary. A concurrent Lambda transition wins through the version check and
 * is re-read rather than overwritten.
 */
export async function expireAcceptedDispatchIfDeadlineElapsed(
  operationId: string,
  now: Date = new Date()
): Promise<ExpireAcceptedDispatchResult> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Accepted dispatch expiry requires a valid timestamp");
  const timestamp = now.toISOString();
  const parameterName = getOperationStateParameterName(operationId);
  const input = { operationId, parameterName, nowMs, timestamp };
  return shouldUseVersionedOperationStore()
    ? await expireAcceptedDispatchInDynamoDb(input)
    : await expireAcceptedDispatchInMemory(input);
}

export async function getDurableOperationState(operationId: string): Promise<DurableOperationState | null> {
  const parameterName = getOperationStateParameterName(operationId);
  if (shouldUseVersionedOperationStore()) {
    const record = await readVersionedOperationRecord(operationId);
    if (record) {
      const parsed = parseDurableOperationState(record.payload);
      if (!parsed) throw new Error(`Durable operation record ${operationId} is malformed`);
      return { ...parsed, version: record.version };
    }
  }
  return parseDurableOperationState(await readRawOperationState(parameterName));
}

export function resetDurableOperationStateStoreForTests(): void {
  inMemoryOperationStateStore.clear();
  hasLoggedInvalidRetentionConfig = false;
  lastOpportunisticCleanupStartedAt = 0;
  opportunisticCleanupInFlight = null;
}
