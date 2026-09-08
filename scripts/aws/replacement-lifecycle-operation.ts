import { createHash, randomUUID } from "node:crypto";
import {
  isOperationConditionalFailure,
  readVersionedOperationRecord,
  writeVersionedOperationRecord,
} from "../../lib/aws/dynamodb-operation-store";
import { getDurableOperationStateRetentionMs } from "../../lib/durable-operation-state";
import {
  type AtomicServerActionLockResult,
  type ServerActionLock,
  acquireServerActionLockWithOperation,
  finalizeServerActionLockWithOperation,
  renewServerActionLockWithOperation,
  takeOverProtectedServerActionLockWithOperation,
} from "../../lib/server-action-lock";
import type { HostIdentity, LifecycleFenceIdentity } from "./existing-host-upgrade";

export const REPLACEMENT_FENCE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ReplacementOperationPhase =
  | "preparing"
  | "backup-requested"
  | "backup-verified"
  | "quiesce-requested"
  | "quiesced"
  | "stop-requested"
  | "old-host-safe"
  | "snapshot-requested"
  | "snapshot-complete"
  | "change-set-requested"
  | "prepared"
  | "execution-requested"
  | "execution-complete"
  | "executing"
  | "restoring"
  | "recovery-required"
  | "committed"
  | "rolled-back";

export type ReplacementOperationStatus = "running" | "completed" | "failed";

export interface ReplacementLifecycleOperation {
  schemaVersion: 1;
  kind: "mc-aws-host-replacement";
  operationId: string;
  operationOwnerId: string;
  version: number;
  status: ReplacementOperationStatus;
  phase: ReplacementOperationPhase;
  stackId: string;
  oldInstanceId: string;
  rootVolumeId: string;
  currentAmiId: string;
  targetAmiId: string;
  updatedAt: string;
  lockId?: string;
  fencingToken?: number;
  lockLeaseGeneration?: number;
  lockLeaseExpiresAt?: string;
  oldHostAgentDrained: boolean;
  oldHostMasked: boolean;
  oldHostStopped: boolean;
  backupName?: string;
  backupRequestedAt?: string;
  restoreFloor?: { generation: number; backupId: string };
  backupProof?: {
    name: string;
    size: number;
    modifiedAt: string;
    backupId: string;
    generation: number;
    sourceInstanceId: string;
    operationKey: string;
    rootVolumeId: string;
    bootId: string;
    maintenanceOwner: string;
    quiescenceEpoch: string;
    terminalMode: "terminal-replacement";
  };
  quiesceRequestedAt?: string;
  stopRequestedAt?: string;
  oldHostDisposition?: "stopped" | "terminated" | "absent";
  oldHostSafetyInvalidatedAt?: string;
  oldHostSafetyCheckPending?: boolean;
  snapshotRequestToken?: string;
  snapshotId?: string;
  changeSetName?: string;
  changeSetId?: string;
  changeKind?: "replacement" | "in-place";
  executionClientToken?: string;
  executionRequestedAt?: string;
  changeSetStatus?: string;
  changeSetExecutionStatus?: string;
  executionCompletedAt?: string;
  newInstanceVerified?: boolean;
  newInstanceId?: string;
  hostMaintenanceReleaseRequested?: boolean;
  hostMaintenanceReleased?: boolean;
  receiptVerifierRotated?: boolean;
  resumeIntent?:
    | {
        operationId: string;
        mode: "replacement-convergence";
        backupArchiveName: string;
        backupId: string;
        generation: number;
        maintenanceOwner?: string;
        operationKey?: string;
        quiescenceEpoch?: string;
      }
    | { operationId: string; mode: "named"; backupArchiveName: string };
  fenceReleasedAt?: string;
}

export interface ReplacementFenceContext {
  operation: ReplacementLifecycleOperation;
  fence: LifecycleFenceIdentity;
}

type OperationPatch = Partial<
  Omit<
    ReplacementLifecycleOperation,
    | "schemaVersion"
    | "kind"
    | "operationId"
    | "operationOwnerId"
    | "version"
    | "stackId"
    | "oldInstanceId"
    | "rootVolumeId"
    | "currentAmiId"
    | "targetAmiId"
    | "updatedAt"
    | "lockId"
    | "fencingToken"
    | "lockLeaseGeneration"
    | "lockLeaseExpiresAt"
    | "fenceReleasedAt"
  >
>;

function ttlEpochSeconds(): number {
  return Math.floor((Date.now() + getDurableOperationStateRetentionMs()) / 1000);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "operationId",
    "operationOwnerId",
    "version",
    "status",
    "phase",
    "stackId",
    "oldInstanceId",
    "rootVolumeId",
    "currentAmiId",
    "targetAmiId",
    "updatedAt",
    "lockId",
    "fencingToken",
    "lockLeaseGeneration",
    "lockLeaseExpiresAt",
    "oldHostAgentDrained",
    "oldHostMasked",
    "oldHostStopped",
    "backupName",
    "backupRequestedAt",
    "restoreFloor",
    "backupProof",
    "quiesceRequestedAt",
    "stopRequestedAt",
    "oldHostDisposition",
    "oldHostSafetyInvalidatedAt",
    "oldHostSafetyCheckPending",
    "snapshotRequestToken",
    "snapshotId",
    "changeSetName",
    "changeSetId",
    "changeKind",
    "executionClientToken",
    "executionRequestedAt",
    "changeSetStatus",
    "changeSetExecutionStatus",
    "executionCompletedAt",
    "newInstanceVerified",
    "newInstanceId",
    "hostMaintenanceReleaseRequested",
    "hostMaintenanceReleased",
    "receiptVerifierRotated",
    "resumeIntent",
    "fenceReleasedAt",
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One strict parser validates the complete takeover authority envelope.
export function parseReplacementLifecycleOperation(raw: string): ReplacementLifecycleOperation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Replacement lifecycle operation state is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value as Record<string, unknown>)) {
    throw new Error("Replacement lifecycle operation state has an invalid schema");
  }
  const item = value as Record<string, unknown>;
  const phases = new Set<ReplacementOperationPhase>([
    "preparing",
    "backup-requested",
    "backup-verified",
    "quiesce-requested",
    "quiesced",
    "stop-requested",
    "old-host-safe",
    "snapshot-requested",
    "snapshot-complete",
    "change-set-requested",
    "prepared",
    "execution-requested",
    "execution-complete",
    "executing",
    "restoring",
    "recovery-required",
    "committed",
    "rolled-back",
  ]);
  const statuses = new Set<ReplacementOperationStatus>(["running", "completed", "failed"]);
  if (
    item.schemaVersion !== 1 ||
    item.kind !== "mc-aws-host-replacement" ||
    typeof item.operationId !== "string" ||
    !UUID.test(item.operationId) ||
    typeof item.operationOwnerId !== "string" ||
    !UUID.test(item.operationOwnerId) ||
    !Number.isSafeInteger(item.version) ||
    Number(item.version) < 1 ||
    !statuses.has(item.status as ReplacementOperationStatus) ||
    !phases.has(item.phase as ReplacementOperationPhase) ||
    typeof item.stackId !== "string" ||
    typeof item.oldInstanceId !== "string" ||
    typeof item.rootVolumeId !== "string" ||
    typeof item.currentAmiId !== "string" ||
    typeof item.targetAmiId !== "string" ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.updatedAt)) ||
    typeof item.oldHostAgentDrained !== "boolean" ||
    typeof item.oldHostMasked !== "boolean" ||
    typeof item.oldHostStopped !== "boolean"
  ) {
    throw new Error("Replacement lifecycle operation state has an invalid identity");
  }
  if (item.resumeIntent !== undefined) {
    const intent = item.resumeIntent as Record<string, unknown>;
    const replacementIntent = intent.mode === "replacement-convergence";
    const namedIntent = intent.mode === "named";
    if (
      !intent ||
      intent.operationId !== item.operationId ||
      !["replacement-convergence", "named"].includes(String(intent.mode)) ||
      typeof intent.backupArchiveName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(intent.backupArchiveName) ||
      (replacementIntent &&
        (!/^[a-f0-9]{32}$/.test(String(intent.backupId)) ||
          !Number.isSafeInteger(intent.generation) ||
          Number(intent.generation) < 1)) ||
      (namedIntent && Object.keys(intent).some((key) => !["operationId", "mode", "backupArchiveName"].includes(key)))
    ) {
      throw new Error("Replacement lifecycle resume intent is malformed");
    }
  }
  for (const name of ["fencingToken", "lockLeaseGeneration"] as const) {
    if (item[name] !== undefined && (!Number.isSafeInteger(item[name]) || Number(item[name]) < 1)) {
      throw new Error("Replacement lifecycle operation fence state is malformed");
    }
  }
  if (
    (item.lockId !== undefined && typeof item.lockId !== "string") ||
    (item.lockLeaseExpiresAt !== undefined &&
      (typeof item.lockLeaseExpiresAt !== "string" || !Number.isFinite(Date.parse(item.lockLeaseExpiresAt)))) ||
    (item.newInstanceId !== undefined && typeof item.newInstanceId !== "string") ||
    (item.fenceReleasedAt !== undefined &&
      (typeof item.fenceReleasedAt !== "string" || !Number.isFinite(Date.parse(item.fenceReleasedAt))))
  ) {
    throw new Error("Replacement lifecycle operation fence state is malformed");
  }
  for (const name of [
    "backupRequestedAt",
    "quiesceRequestedAt",
    "stopRequestedAt",
    "executionRequestedAt",
    "executionCompletedAt",
    "oldHostSafetyInvalidatedAt",
  ] as const) {
    if (item[name] !== undefined && (typeof item[name] !== "string" || !Number.isFinite(Date.parse(item[name])))) {
      throw new Error("Replacement lifecycle operation journal timestamp is malformed");
    }
  }
  for (const name of [
    "backupName",
    "snapshotRequestToken",
    "snapshotId",
    "changeSetName",
    "changeSetId",
    "executionClientToken",
    "changeSetStatus",
    "changeSetExecutionStatus",
  ] as const) {
    if (item[name] !== undefined && (typeof item[name] !== "string" || item[name].length === 0)) {
      throw new Error("Replacement lifecycle operation journal identity is malformed");
    }
  }
  if (
    (item.oldHostDisposition !== undefined &&
      !new Set(["stopped", "terminated", "absent"]).has(String(item.oldHostDisposition))) ||
    (item.changeKind !== undefined && !new Set(["replacement", "in-place"]).has(String(item.changeKind))) ||
    (item.oldHostSafetyCheckPending !== undefined && typeof item.oldHostSafetyCheckPending !== "boolean") ||
    (item.newInstanceVerified !== undefined && typeof item.newInstanceVerified !== "boolean") ||
    (item.hostMaintenanceReleaseRequested !== undefined && typeof item.hostMaintenanceReleaseRequested !== "boolean") ||
    (item.hostMaintenanceReleased !== undefined && typeof item.hostMaintenanceReleased !== "boolean") ||
    (item.receiptVerifierRotated !== undefined && typeof item.receiptVerifierRotated !== "boolean")
  ) {
    throw new Error("Replacement lifecycle operation journal state is malformed");
  }
  if (item.backupProof !== undefined) {
    const proof = item.backupProof as Record<string, unknown>;
    if (
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      Object.keys(proof).sort().join(",") !==
        "backupId,bootId,generation,maintenanceOwner,modifiedAt,name,operationKey,quiescenceEpoch,rootVolumeId,size,sourceInstanceId,terminalMode" ||
      typeof proof.name !== "string" ||
      !Number.isSafeInteger(proof.size) ||
      Number(proof.size) < 1 ||
      typeof proof.modifiedAt !== "string" ||
      !Number.isFinite(Date.parse(proof.modifiedAt)) ||
      typeof proof.backupId !== "string" ||
      !Number.isSafeInteger(proof.generation) ||
      Number(proof.generation) < 1 ||
      typeof proof.sourceInstanceId !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(proof.operationKey ?? "")) ||
      !/^vol-[a-f0-9]{8,17}$/.test(String(proof.rootVolumeId ?? "")) ||
      typeof proof.bootId !== "string" ||
      !proof.bootId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(proof.maintenanceOwner ?? "")) ||
      !/^[a-f0-9]{32}$/.test(String(proof.quiescenceEpoch ?? "")) ||
      proof.terminalMode !== "terminal-replacement"
    ) {
      throw new Error("Replacement lifecycle operation backup proof is malformed");
    }
    const expectedOperationKey = createHash("sha256")
      .update(`${String(item.operationId)}\0replacement-backup`)
      .digest("hex");
    if (
      proof.operationKey !== expectedOperationKey ||
      proof.rootVolumeId !== item.rootVolumeId ||
      proof.sourceInstanceId !== item.oldInstanceId
    ) {
      throw new Error("Replacement lifecycle operation backup proof identity changed");
    }
  }
  if (item.restoreFloor !== undefined) {
    const floor = item.restoreFloor as Record<string, unknown>;
    if (
      !floor ||
      typeof floor !== "object" ||
      Array.isArray(floor) ||
      Object.keys(floor).sort().join(",") !== "backupId,generation" ||
      !Number.isSafeInteger(floor.generation) ||
      Number(floor.generation) < 0 ||
      (floor.generation === 0
        ? floor.backupId !== ""
        : typeof floor.backupId !== "string" || !/^[a-f0-9]{32}$/.test(floor.backupId))
    ) {
      throw new Error("Replacement lifecycle operation restore floor is malformed");
    }
  }
  const proofRequiredPhases = new Set<ReplacementOperationPhase>([
    "backup-verified",
    "quiesce-requested",
    "quiesced",
    "stop-requested",
    "old-host-safe",
    "snapshot-requested",
    "snapshot-complete",
    "change-set-requested",
    "prepared",
    "execution-requested",
    "execution-complete",
    "executing",
    "restoring",
    "recovery-required",
    "committed",
    "rolled-back",
  ]);
  if (proofRequiredPhases.has(item.phase as ReplacementOperationPhase) && item.backupProof === undefined) {
    throw new Error("Replacement lifecycle operation lost terminal backup proof");
  }
  if (item.phase !== "preparing" && item.restoreFloor === undefined) {
    throw new Error("Replacement lifecycle operation lost restore-floor proof");
  }
  return item as unknown as ReplacementLifecycleOperation;
}

function operationMatchesIdentity(operation: ReplacementLifecycleOperation, identity: HostIdentity): boolean {
  return (
    operation.stackId === identity.stackId &&
    operation.oldInstanceId === identity.instanceId &&
    operation.rootVolumeId === identity.rootVolumeId &&
    operation.currentAmiId === identity.currentAmiId &&
    operation.targetAmiId === identity.targetAmiId
  );
}

function withFence(
  operation: ReplacementLifecycleOperation,
  lock: ServerActionLock,
  version: number,
  patch: OperationPatch = {}
): ReplacementLifecycleOperation {
  return {
    ...operation,
    ...patch,
    operationOwnerId: lock.operationOwnerId ?? operation.operationOwnerId,
    version,
    updatedAt: new Date().toISOString(),
    lockId: lock.lockId,
    fencingToken: lock.fencingToken,
    lockLeaseGeneration: lock.leaseGeneration,
    lockLeaseExpiresAt: lock.expiresAt,
  };
}

function fenceIdentity(lock: ServerActionLock): LifecycleFenceIdentity {
  if (!Number.isSafeInteger(lock.leaseGeneration) || (lock.leaseGeneration ?? 0) < 1) {
    throw new Error("Replacement lifecycle lock has no valid generation");
  }
  return {
    lockId: lock.lockId,
    fencingToken: lock.fencingToken,
    leaseGeneration: lock.leaseGeneration as number,
    action: "backup",
    ownerEmail: lock.ownerEmail,
  };
}

export function initializeReplacementLifecycleOperation(
  identity: HostIdentity,
  operationId: string = randomUUID(),
  operationOwnerId: string = randomUUID(),
  backupName?: string,
  timestamp = new Date().toISOString()
): ReplacementLifecycleOperation {
  return {
    schemaVersion: 1,
    kind: "mc-aws-host-replacement",
    operationId,
    operationOwnerId,
    version: 1,
    status: "running",
    phase: "preparing",
    stackId: identity.stackId,
    oldInstanceId: identity.instanceId,
    rootVolumeId: identity.rootVolumeId,
    currentAmiId: identity.currentAmiId,
    targetAmiId: identity.targetAmiId,
    updatedAt: timestamp,
    oldHostAgentDrained: false,
    oldHostMasked: false,
    oldHostStopped: false,
    ...(backupName ? { backupName } : {}),
  };
}

export async function createReplacementLifecycleOperation(
  identity: HostIdentity,
  operationId: string = randomUUID(),
  operationOwnerId: string = randomUUID(),
  backupName?: string,
  timestamp = new Date().toISOString()
): Promise<ReplacementLifecycleOperation> {
  const candidate = initializeReplacementLifecycleOperation(
    identity,
    operationId,
    operationOwnerId,
    backupName,
    timestamp
  );
  try {
    await writeVersionedOperationRecord({
      operationId,
      expectedVersion: 0,
      payload: JSON.stringify(candidate),
      status: candidate.status,
      phase: candidate.phase,
      updatedAt: timestamp,
      ttlEpochSeconds: ttlEpochSeconds(),
    });
    return candidate;
  } catch (error) {
    const existing = await readReplacementLifecycleOperation(operationId).catch(() => null);
    if (existing && operationMatchesIdentity(existing, identity) && existing.operationOwnerId === operationOwnerId) {
      return existing;
    }
    if (isOperationConditionalFailure(error)) throw new Error("Replacement lifecycle operation already exists");
    throw error;
  }
}

export async function readReplacementLifecycleOperation(
  operationId: string
): Promise<ReplacementLifecycleOperation | null> {
  const record = await readVersionedOperationRecord(operationId);
  if (!record) return null;
  const operation = parseReplacementLifecycleOperation(record.payload);
  if (operation.version !== record.version) throw new Error("Replacement lifecycle operation version diverged");
  return operation;
}

async function authoritativeClaim(
  operation: ReplacementLifecycleOperation,
  operationOwnerId: string
): Promise<{ claimed: AtomicServerActionLockResult; candidate?: ReplacementLifecycleOperation }> {
  let candidate: ReplacementLifecycleOperation | undefined;
  const claimed = await acquireServerActionLockWithOperation("backup", "host-upgrade@local.invalid", {
    operationId: operation.operationId,
    ownerId: operationOwnerId,
    expectedVersion: operation.version,
    status: "running",
    phase: operation.phase,
    updatedAt: new Date().toISOString(),
    ttlEpochSeconds: ttlEpochSeconds(),
    retainForAgentEffect: true,
    payload: (lock) => {
      candidate = withFence({ ...operation, operationOwnerId }, lock, operation.version + 1);
      return JSON.stringify(candidate);
    },
  });
  return { claimed, candidate };
}

export async function claimReplacementLifecycleFence(
  operation: ReplacementLifecycleOperation,
  operationOwnerId = operation.operationOwnerId
): Promise<ReplacementFenceContext> {
  const { claimed } = await authoritativeClaim(operation, operationOwnerId);
  const current = await readReplacementLifecycleOperation(operation.operationId);
  if (
    !current ||
    current.operationOwnerId !== operationOwnerId ||
    current.lockId !== claimed.lock.lockId ||
    current.fencingToken !== claimed.lock.fencingToken ||
    current.lockLeaseGeneration !== claimed.lock.leaseGeneration
  ) {
    throw new Error("Replacement fence acquisition did not reconcile exact operation ownership");
  }
  return { operation: current, fence: fenceIdentity(claimed.lock) };
}

function exactRenewalIdentity(
  payload: string,
  lock: ServerActionLock,
  operationVersion: number,
  expected: ReplacementLifecycleOperation,
  patch: OperationPatch
): boolean {
  try {
    const current = parseReplacementLifecycleOperation(payload);
    return (
      current.operationId === expected.operationId &&
      current.operationOwnerId === expected.operationOwnerId &&
      current.version === operationVersion &&
      current.lockId === lock.lockId &&
      current.fencingToken === lock.fencingToken &&
      current.lockLeaseGeneration === lock.leaseGeneration &&
      Object.entries(patch).every(([key, value]) => current[key as keyof ReplacementLifecycleOperation] === value)
    );
  } catch {
    return false;
  }
}

export async function renewReplacementLifecycleFence(
  context: ReplacementFenceContext,
  patch: OperationPatch = {}
): Promise<ReplacementFenceContext> {
  const { operation, fence } = context;
  if (
    operation.lockId !== fence.lockId ||
    operation.fencingToken !== fence.fencingToken ||
    operation.lockLeaseGeneration !== fence.leaseGeneration
  ) {
    throw new Error("Local replacement operation and lifecycle generation diverged");
  }
  let candidate: ReplacementLifecycleOperation | undefined;
  const renewed = await renewServerActionLockWithOperation(fence.lockId, fence.fencingToken, {
    operationId: operation.operationId,
    operationOwnerId: operation.operationOwnerId,
    expectedOperationVersion: operation.version,
    expectedLeaseGeneration: fence.leaseGeneration,
    updatedAt: new Date().toISOString(),
    ttlEpochSeconds: ttlEpochSeconds(),
    status: patch.status ?? operation.status,
    phase: patch.phase ?? operation.phase,
    retainForAgentEffect: true,
    payload: (lock, nextVersion) => {
      candidate = withFence(operation, lock, nextVersion, patch);
      return JSON.stringify(candidate);
    },
    reconcile: (payload, lock, version) => exactRenewalIdentity(payload, lock, version, operation, patch),
  });
  const current = parseReplacementLifecycleOperation(renewed.operationPayload);
  return { operation: current, fence: fenceIdentity(renewed.lock) };
}

export function assertSafeExpiredReplacementTakeover(
  operation: ReplacementLifecycleOperation,
  oldInstanceState: unknown
): void {
  if (operation.status !== "running" || new Set(["committed", "rolled-back"]).has(operation.phase)) {
    throw new Error("Replacement takeover refused: operation is already terminal");
  }
  if (!operation.quiesceRequestedAt) {
    throw new Error("Replacement takeover refused: durable old-host quiescence intent is absent");
  }
  if (!new Set(["stopped", "terminated", "absent"]).has(String(oldInstanceState))) {
    throw new Error("Replacement takeover refused: old host is active or its stopped state is unproven");
  }
}

export function replacementTakeoverOwnerId(operation: ReplacementLifecycleOperation): string {
  const bytes = createHash("sha256")
    .update(`mc-aws-replacement-takeover\0${operation.operationId}\0${operation.operationOwnerId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function takeOverExpiredReplacementFence(
  operation: ReplacementLifecycleOperation,
  oldInstanceState: unknown,
  operationOwnerId = replacementTakeoverOwnerId(operation),
  invalidateBackupEvidence = false
): Promise<ReplacementFenceContext> {
  assertSafeExpiredReplacementTakeover(operation, oldInstanceState);
  if (
    !operation.lockId ||
    !Number.isSafeInteger(operation.fencingToken) ||
    !Number.isSafeInteger(operation.lockLeaseGeneration)
  ) {
    throw new Error("Replacement takeover refused: prior lifecycle identity is incomplete");
  }
  const stoppedAt = new Date().toISOString();
  const preparationPhase = new Set<ReplacementOperationPhase>(["quiesce-requested", "quiesced", "stop-requested"]).has(
    operation.phase
  )
    ? "old-host-safe"
    : operation.phase;
  const takeoverOperation: ReplacementLifecycleOperation = {
    ...operation,
    phase: invalidateBackupEvidence ? "recovery-required" : preparationPhase,
    stopRequestedAt: operation.stopRequestedAt ?? stoppedAt,
    oldHostStopped: true,
    oldHostDisposition: String(oldInstanceState) as "stopped" | "terminated" | "absent",
    oldHostSafetyCheckPending: true,
    oldHostSafetyInvalidatedAt: invalidateBackupEvidence
      ? (operation.oldHostSafetyInvalidatedAt ?? stoppedAt)
      : operation.oldHostSafetyInvalidatedAt,
  };
  const claimed = await takeOverProtectedServerActionLockWithOperation("host-upgrade@local.invalid", {
    operationId: operation.operationId,
    ownerId: operationOwnerId,
    expectedVersion: operation.version,
    previousLockId: operation.lockId,
    previousFencingToken: operation.fencingToken as number,
    previousLeaseGeneration: operation.lockLeaseGeneration as number,
    previousOperationOwnerId: operation.operationOwnerId,
    status: takeoverOperation.status,
    phase: takeoverOperation.phase,
    updatedAt: stoppedAt,
    ttlEpochSeconds: ttlEpochSeconds(),
    retainForAgentEffect: true,
    payload: (lock) =>
      JSON.stringify(withFence({ ...takeoverOperation, operationOwnerId }, lock, operation.version + 1)),
  });
  const current = await readReplacementLifecycleOperation(operation.operationId);
  if (
    !current ||
    current.operationOwnerId !== operationOwnerId ||
    current.lockId !== claimed.lock.lockId ||
    current.fencingToken !== claimed.lock.fencingToken ||
    current.lockLeaseGeneration !== claimed.lock.leaseGeneration
  ) {
    throw new Error("Replacement takeover did not reconcile exact operation ownership");
  }
  return { operation: current, fence: fenceIdentity(claimed.lock) };
}

export async function finalizeReplacementLifecycleFence(
  context: ReplacementFenceContext
): Promise<ReplacementLifecycleOperation> {
  const operation = context.operation;
  if (!new Set<ReplacementOperationPhase>(["committed", "rolled-back"]).has(operation.phase)) {
    throw new Error("Replacement lifecycle fence cannot stop before a terminal commit or rollback");
  }
  const releasedAt = new Date().toISOString();
  const next = { ...operation, version: operation.version + 1, updatedAt: releasedAt, fenceReleasedAt: releasedAt };
  const finalized = await finalizeServerActionLockWithOperation({
    operationId: operation.operationId,
    operationOwnerId: operation.operationOwnerId,
    expectedOperationVersion: operation.version,
    lockId: context.fence.lockId,
    fencingToken: context.fence.fencingToken,
    expectedLeaseGeneration: context.fence.leaseGeneration,
    ownerEmail: context.fence.ownerEmail,
    action: "backup",
    payload: JSON.stringify(next),
    status: operation.status,
    phase: operation.phase,
    expectedStatus: operation.status,
    expectedPhase: operation.phase,
    expectedAgentFenceActive: true,
    updatedAt: next.updatedAt,
    ttlEpochSeconds: ttlEpochSeconds(),
  });
  return parseReplacementLifecycleOperation(finalized.operationPayload);
}

export async function rollBackExpiredReplacementPreparation(
  operation: ReplacementLifecycleOperation
): Promise<ReplacementLifecycleOperation> {
  if (
    operation.status !== "running" ||
    operation.quiesceRequestedAt ||
    operation.oldHostAgentDrained ||
    operation.oldHostMasked ||
    operation.stopRequestedAt ||
    !operation.lockId ||
    !Number.isSafeInteger(operation.fencingToken) ||
    !Number.isSafeInteger(operation.lockLeaseGeneration) ||
    !operation.lockLeaseExpiresAt ||
    Date.parse(operation.lockLeaseExpiresAt) > Date.now()
  ) {
    throw new Error("Expired replacement preparation is not safe for automatic rollback");
  }
  const releasedAt = new Date().toISOString();
  const next: ReplacementLifecycleOperation = {
    ...operation,
    version: operation.version + 1,
    status: "failed",
    phase: "rolled-back",
    updatedAt: releasedAt,
    fenceReleasedAt: releasedAt,
  };
  const finalized = await finalizeServerActionLockWithOperation({
    operationId: operation.operationId,
    operationOwnerId: operation.operationOwnerId,
    expectedOperationVersion: operation.version,
    lockId: operation.lockId,
    fencingToken: operation.fencingToken as number,
    expectedLeaseGeneration: operation.lockLeaseGeneration as number,
    ownerEmail: "host-upgrade@local.invalid",
    action: "backup",
    payload: JSON.stringify(next),
    status: next.status,
    phase: next.phase,
    expectedStatus: operation.status,
    expectedPhase: operation.phase,
    expectedAgentFenceActive: true,
    updatedAt: releasedAt,
    ttlEpochSeconds: ttlEpochSeconds(),
  });
  return parseReplacementLifecycleOperation(finalized.operationPayload);
}

export interface ReplacementFenceHeartbeatDependencies {
  renew?: typeof renewReplacementLifecycleFence;
  persist: (context: ReplacementFenceContext) => void | Promise<void>;
  intervalMs?: number;
}

export class ReplacementFenceHeartbeat {
  #context: ReplacementFenceContext;
  #failure: unknown;
  #pending: Promise<void> = Promise.resolve();
  #timer?: ReturnType<typeof setInterval>;
  readonly #abortController = new AbortController();
  readonly #renew: typeof renewReplacementLifecycleFence;
  readonly #persist: ReplacementFenceHeartbeatDependencies["persist"];
  readonly #intervalMs: number;

  constructor(context: ReplacementFenceContext, dependencies: ReplacementFenceHeartbeatDependencies) {
    this.#context = context;
    this.#renew = dependencies.renew ?? renewReplacementLifecycleFence;
    this.#persist = dependencies.persist;
    this.#intervalMs = dependencies.intervalMs ?? REPLACEMENT_FENCE_RENEW_INTERVAL_MS;
  }

  get context(): ReplacementFenceContext {
    return this.#context;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.#enqueueRenewal().catch(() => undefined);
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  #enqueueRenewal(patch: OperationPatch = {}): Promise<ReplacementFenceContext> {
    const renewal = this.#pending.then(async () => {
      if (this.#failure) throw this.#failure;
      const renewed = await this.#renew(this.#context, patch);
      await this.#persist(renewed);
      this.#context = renewed;
      return renewed;
    });
    this.#pending = renewal.then(
      () => undefined,
      (error) => {
        if (!this.#failure) {
          this.#failure = error;
          this.#abortController.abort(error);
        }
      }
    );
    return renewal;
  }

  async checkpoint(patch: OperationPatch = {}): Promise<ReplacementFenceContext> {
    return await this.#enqueueRenewal(patch);
  }

  async assertHealthy(): Promise<void> {
    await this.#pending;
    if (this.#failure) throw this.#failure;
  }

  async stopAfterTerminal(): Promise<ReplacementFenceContext> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.assertHealthy();
    if (!new Set<ReplacementOperationPhase>(["committed", "rolled-back"]).has(this.#context.operation.phase)) {
      throw new Error("Replacement fence renewal cannot stop before a terminal phase");
    }
    return this.#context;
  }
}
