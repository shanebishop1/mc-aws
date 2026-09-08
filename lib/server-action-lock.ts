import { randomUUID } from "node:crypto";
import { getParameter } from "@/lib/aws";
import {
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  getDynamoDbClient,
} from "@/lib/aws/dynamodb-client";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { LIFECYCLE_LOCK_LEASE_MS } from "@/lib/lifecycle-runtime-budget";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const lockKey = "minecraft-server-lifecycle";
const protocolMetadataKey = "protocol#dual-v1";
const legacyLockParameter = "/minecraft/server-action";
const protocolVersion = "dual-v1";
// Lambda async events may remain valid for one hour and an invocation may run for 15 minutes.
// Keep ownership beyond both windows so delayed valid deliveries cannot execute unfenced.
const ambiguityRepairAttempts = 3;
const serverActions: ReadonlySet<ServerActionType> = new Set([
  "start",
  "stop",
  "resume",
  "hibernate",
  "backup",
  "restore",
  "allowlist",
  "destroy",
]);
const acquirableServerActions: ReadonlySet<Exclude<ServerActionType, "destroy">> = new Set([
  "start",
  "stop",
  "resume",
  "hibernate",
  "backup",
  "restore",
  "allowlist",
]);

export type ServerActionType =
  | "start"
  | "stop"
  | "resume"
  | "hibernate"
  | "backup"
  | "restore"
  | "allowlist"
  | "destroy";

export interface ServerActionLock {
  lockId: string;
  fencingToken: number;
  /** Monotonic generation for renewals of one fencing-token owner. */
  leaseGeneration?: number;
  /** An executor effect can still commit; expiry must not permit takeover. */
  agentFenceActive?: boolean;
  action: ServerActionType;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string;
  /** Present when lock ownership was atomically bound to a durable operation. */
  operationId?: string;
  operationOwnerId?: string;
  /** Stable proof token used by serialized mock/legacy compatibility records. */
  claimToken?: string;
}

export interface AtomicOperationRecordInput {
  operationId: string;
  ownerId: string;
  expectedVersion: number;
  payload: (lock: ServerActionLock) => string;
  status: string;
  phase: string;
  updatedAt: string;
  ttlEpochSeconds: number;
  /** Protects a durable host operation from generic expiry takeover. */
  retainForAgentEffect?: boolean;
}

export interface AtomicReplacementTakeoverInput extends AtomicOperationRecordInput {
  previousLockId: string;
  previousFencingToken: number;
  previousLeaseGeneration: number;
  previousOperationOwnerId: string;
}

export interface AtomicServerActionLockResult {
  lock: ServerActionLock;
  ownership: "acquired" | "attached";
}

export interface AtomicOperationFenceRenewalInput {
  operationId: string;
  operationOwnerId: string;
  expectedOperationVersion: number;
  expectedLeaseGeneration: number;
  updatedAt: string;
  ttlEpochSeconds: number;
  payload: (lock: ServerActionLock, nextOperationVersion: number) => string | Promise<string>;
  reconcile: (payload: string, lock: ServerActionLock, operationVersion: number) => boolean;
  /** Top-level durable operation projection written in the same transaction. */
  status?: string;
  phase?: string;
  /** Defaults true for executor effects; host orchestration uses an expiring renewable lease. */
  retainForAgentEffect?: boolean;
}

export interface AtomicOperationFenceRenewalResult {
  lock: ServerActionLock;
  operationPayload: string;
  operationVersion: number;
  ownership: "renewed" | "reconciled";
}

export interface ReleaseServerActionLockOptions {
  action?: ServerActionType;
  ownerEmail?: string;
  fencingToken?: number;
  leaseGeneration?: number;
}

export interface RenewServerActionLockOptions {
  expectedLeaseGeneration?: number;
  retainForAgentEffect?: boolean;
}

export interface ReleaseServerActionLockIfOwnedInput {
  lockId: string;
  action: ServerActionType;
  ownerEmail: string;
  fencingToken: number;
}

export interface AtomicOperationFenceFinalizationInput {
  operationId: string;
  operationOwnerId: string;
  expectedOperationVersion: number;
  lockId: string;
  fencingToken: number;
  expectedLeaseGeneration: number;
  ownerEmail: string;
  action: ServerActionType;
  payload: string;
  status: string;
  phase: string;
  updatedAt: string;
  ttlEpochSeconds: number;
  expectedStatus?: string;
  expectedPhase?: string;
  expectedAgentFenceActive?: boolean;
}

export interface AtomicOperationFenceFinalizationResult {
  operationPayload: string;
  operationVersion: number;
}

export class ServerActionLockConflictError extends Error {
  existingLock: ServerActionLock | null;

  constructor(existingLock: ServerActionLock | null) {
    super("Another operation is already in progress. Please wait for it to complete.");
    this.name = "ServerActionLockConflictError";
    this.existingLock = existingLock;
  }
}

function operationStateUpdateExpression(status: string): string {
  const base =
    "SET payload = :payload, #version = :nextVersion, #status = :status, phase = :phase, updatedAt = :updatedAt";
  return status === "completed" || status === "failed"
    ? `${base}, ttlEpochSeconds = :ttl`
    : `${base} REMOVE ttlEpochSeconds`;
}

function operationStateTtlValue(status: string, ttlEpochSeconds: number): Record<string, { N: string }> {
  return status === "completed" || status === "failed" ? { ":ttl": { N: String(ttlEpochSeconds) } } : {};
}

function isMockBackendMode(): boolean {
  return process.env.MC_BACKEND_MODE?.trim().toLowerCase() === "mock";
}

function tableName(): string {
  const value = process.env.MC_LIFECYCLE_LOCK_TABLE_NAME?.trim();
  if (!value) throw new Error("MC_LIFECYCLE_LOCK_TABLE_NAME is required for lifecycle locking");
  return value;
}

function isConditionalFailure(error: unknown): boolean {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}

function readString(
  item: Record<string, { S?: string; N?: string; BOOL?: boolean }> | undefined,
  name: string
): string {
  return item?.[name]?.S ?? "";
}

function parseLockItem(
  item: Record<string, { S?: string; N?: string; BOOL?: boolean }> | undefined
): ServerActionLock | null {
  if (!item || item.released?.BOOL === true) return null;
  const action = readString(item, "action") as ServerActionType;
  const lockId = readString(item, "lockId");
  const ownerEmail = readString(item, "ownerEmail");
  const createdAt = readString(item, "createdAt");
  const leaseExpiresAt = Number(item.leaseExpiresAt?.N ?? Number.NaN);
  const fencingToken = Number(item.fencingToken?.N ?? Number.NaN);
  const leaseGeneration = Number(item.leaseGeneration?.N ?? "1");
  const agentFenceActive = item.agentFenceActive?.BOOL === true;
  if (
    !lockId ||
    !ownerEmail ||
    !createdAt ||
    !serverActions.has(action) ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1 ||
    !Number.isSafeInteger(leaseGeneration) ||
    leaseGeneration < 1 ||
    !Number.isFinite(leaseExpiresAt) ||
    !Number.isFinite(new Date(leaseExpiresAt).getTime())
  ) {
    return null;
  }
  return {
    lockId,
    fencingToken,
    leaseGeneration,
    agentFenceActive,
    action,
    ownerEmail,
    createdAt,
    expiresAt: new Date(leaseExpiresAt).toISOString(),
    operationId: readString(item, "operationId") || undefined,
    operationOwnerId: readString(item, "operationOwnerId") || undefined,
  };
}

function operationTableName(): string {
  const value = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for atomic lifecycle ownership");
  return value;
}

async function assertBridgeMetadata(): Promise<void> {
  if (isMockBackendMode()) return;
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: protocolMetadataKey } },
      ConsistentRead: true,
    })
  );
  if (
    response.Item?.protocolVersion?.S !== protocolVersion ||
    response.Item?.cutoverState?.S !== "provider-authoritative" ||
    response.Item?.legacyBridgeState?.S !== "absent"
  ) {
    throw new Error("Lifecycle lock provider-authoritative cutover barrier is missing");
  }
}

function parseLegacyLock(raw: string | null): Omit<ServerActionLock, "fencingToken"> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ServerActionLock>;
    if (
      !value.lockId ||
      !value.action ||
      !serverActions.has(value.action) ||
      !value.ownerEmail ||
      !value.createdAt ||
      !value.expiresAt ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      return null;
    }
    return {
      lockId: value.lockId,
      action: value.action,
      ownerEmail: value.ownerEmail,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      leaseGeneration:
        Number.isSafeInteger(value.leaseGeneration) && (value.leaseGeneration ?? 0) >= 1
          ? (value.leaseGeneration as number)
          : 1,
      agentFenceActive: value.agentFenceActive === true,
      operationId: typeof value.operationId === "string" ? value.operationId : undefined,
      operationOwnerId: typeof value.operationOwnerId === "string" ? value.operationOwnerId : undefined,
      claimToken: typeof value.claimToken === "string" && value.claimToken ? value.claimToken : undefined,
    };
  } catch {
    return null;
  }
}

interface RawOperationRecord {
  payload: string;
  version: number;
}

function parseMockLock(raw: string | null): ServerActionLock | null {
  const legacy = parseLegacyLock(raw);
  if (!legacy || !raw) return null;

  try {
    const fencingToken = (JSON.parse(raw) as { fencingToken?: unknown }).fencingToken;
    if (!Number.isSafeInteger(fencingToken) || (fencingToken as number) < 1) return null;
    return { ...legacy, fencingToken: fencingToken as number };
  } catch {
    return null;
  }
}

async function acquireMockLock(action: ServerActionType, ownerEmail: string): Promise<ServerActionLock> {
  const now = Date.now();
  const candidate = {
    lockId: randomUUID(),
    action,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
    leaseGeneration: 1,
    agentFenceActive: false,
  };
  const result = await getMockStateStore().acquireLifecycleLock(candidate, now);
  if (!result.acquired || !result.lock) throw new ServerActionLockConflictError(result.lock as ServerActionLock | null);
  return result.lock as ServerActionLock;
}

async function releaseMockLock(
  lockId: string,
  fencingToken: number,
  options?: ReleaseServerActionLockOptions
): Promise<boolean> {
  return await getMockStateStore().releaseLifecycleLock({
    lockId,
    fencingToken,
    action: options?.action,
    ownerEmail: options?.ownerEmail,
    leaseGeneration: options?.leaseGeneration,
  });
}

async function acquireLegacyBridgeLock(
  action: ServerActionType,
  ownerEmail: string,
  protectedFence = false,
  operationIdentity?: { operationId: string; operationOwnerId: string }
) {
  const now = Date.now();
  return {
    lockId: randomUUID(),
    action,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
    leaseGeneration: 1,
    agentFenceActive: protectedFence,
    operationId: operationIdentity?.operationId,
    operationOwnerId: operationIdentity?.operationOwnerId,
    claimToken: randomUUID(),
  };
}

async function releaseLegacyBridgeLock(lockId: string): Promise<boolean> {
  void lockId;
  return true;
}

async function releaseLegacyBridgeLockWithRetry(lockId: string): Promise<boolean> {
  return releaseLegacyBridgeLock(lockId);
}

async function getCurrentLock(): Promise<ServerActionLock | null> {
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: lockKey } },
      ConsistentRead: true,
    })
  );
  const lock = parseLockItem(response.Item);
  return lock && (lock.agentFenceActive || Date.parse(lock.expiresAt) > Date.now()) ? lock : null;
}

async function getCurrentLockItem(): Promise<Record<string, { S?: string; N?: string; BOOL?: boolean }> | undefined> {
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: lockKey } },
      ConsistentRead: true,
    })
  );
  return response.Item;
}

export async function isAuthoritativeLifecycleLockOwned(input: {
  operationId: string;
  lockId: string;
  fencingToken: number;
  action: ServerActionType;
}): Promise<boolean> {
  const lock = isMockBackendMode()
    ? parseMockLock(await getParameter(legacyLockParameter))
    : parseLockItem(await getCurrentLockItem());
  return Boolean(
    lock &&
      lock.lockId === input.lockId &&
      lock.fencingToken === input.fencingToken &&
      lock.action === input.action &&
      lock.operationId === input.operationId &&
      (lock.agentFenceActive === true || Date.parse(lock.expiresAt) > Date.now())
  );
}

async function readRawOperationRecord(operationId: string): Promise<RawOperationRecord | null> {
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: operationTableName(),
      Key: { operationId: { S: operationId } },
      ConsistentRead: true,
    })
  );
  const payload = response.Item?.payload?.S;
  const version = Number(response.Item?.version?.N ?? Number.NaN);
  return payload && Number.isSafeInteger(version) && version >= 1 ? { payload, version } : null;
}

function exactOperationLockIdentity(
  payload: string,
  lock: ServerActionLock,
  operationId: string,
  operationOwnerId: string
): boolean {
  try {
    const operation = JSON.parse(payload) as Record<string, unknown>;
    return (
      (operation.id === operationId || operation.operationId === operationId) &&
      operation.lockId === lock.lockId &&
      operation.fencingToken === lock.fencingToken &&
      (operation.dispatchOwnerId === operationOwnerId || operation.operationOwnerId === operationOwnerId) &&
      operation.lockLeaseGeneration === lock.leaseGeneration &&
      lock.operationId === operationId &&
      lock.operationOwnerId === operationOwnerId
    );
  } catch {
    return false;
  }
}

async function reconcileAtomicFenceRenewal(
  lockId: string,
  fencingToken: number,
  input: AtomicOperationFenceRenewalInput
): Promise<AtomicOperationFenceRenewalResult | null> {
  const [lockItem, operation] = await Promise.all([getCurrentLockItem(), readRawOperationRecord(input.operationId)]);
  const lock = parseLockItem(lockItem);
  if (
    !lock ||
    lock.lockId !== lockId ||
    lock.fencingToken !== fencingToken ||
    lock.action !== "backup" ||
    lock.agentFenceActive !== (input.retainForAgentEffect ?? true) ||
    lock.operationId !== input.operationId ||
    lock.operationOwnerId !== input.operationOwnerId ||
    (lock.leaseGeneration ?? 1) <= input.expectedLeaseGeneration ||
    !operation ||
    !exactOperationLockIdentity(operation.payload, lock, input.operationId, input.operationOwnerId) ||
    !input.reconcile(operation.payload, lock, operation.version)
  ) {
    return null;
  }
  return {
    lock,
    operationPayload: operation.payload,
    operationVersion: operation.version,
    ownership: "reconciled",
  };
}

async function mirrorLegacyLockForward(lock: ServerActionLock): Promise<void> {
  void lock;
}

async function mirrorProtectedTakeoverForward(
  lock: ServerActionLock,
  previousLockId: string,
  operationId: string
): Promise<void> {
  void lock;
  void previousLockId;
  void operationId;
}

async function reconcileAmbiguousAcquisition(lockId: string): Promise<ServerActionLock | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ambiguityRepairAttempts; attempt++) {
    try {
      const response = await getDynamoDbClient().send(
        new UpdateItemCommand({
          TableName: tableName(),
          Key: { lockKey: { S: lockKey } },
          ConditionExpression: "lockId = :lockId AND released = :false",
          UpdateExpression: "SET protocolVersion = :protocol",
          ExpressionAttributeValues: {
            ":lockId": { S: lockId },
            ":false": { BOOL: false },
            ":protocol": { S: protocolVersion },
          },
          ReturnValues: "ALL_NEW",
        })
      );
      return parseLockItem(response.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) return null;
      lastError = error;
    }
  }
  if (lastError && typeof lastError === "object") {
    Object.assign(lastError, { retainLegacyBridge: true });
  }
  throw lastError;
}

function isMatchingReleasedItem(
  item: Record<string, { S?: string; N?: string; BOOL?: boolean }> | undefined,
  lockId: string,
  fencingToken: number
): boolean {
  return item?.released?.BOOL === true && item.lockId?.S === lockId && Number(item.fencingToken?.N) === fencingToken;
}

async function readAtomicOperationBinding(operationId: string): Promise<{
  lockId: string;
  fencingToken: number;
  dispatchOwnerId: string;
  payload: string;
  version: number;
} | null> {
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: operationTableName(),
      Key: { operationId: { S: operationId } },
      ConsistentRead: true,
    })
  );
  const raw = response.Item?.payload?.S;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lockId = typeof parsed.lockId === "string" ? parsed.lockId : "";
    const fencingToken = typeof parsed.fencingToken === "number" ? parsed.fencingToken : Number.NaN;
    const dispatchOwnerId =
      typeof parsed.dispatchOwnerId === "string"
        ? parsed.dispatchOwnerId
        : typeof parsed.operationOwnerId === "string"
          ? parsed.operationOwnerId
          : "";
    const version = Number(response.Item?.version?.N ?? Number.NaN);
    if (
      !lockId ||
      !Number.isSafeInteger(fencingToken) ||
      fencingToken < 1 ||
      !dispatchOwnerId ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      return null;
    return { lockId, fencingToken, dispatchOwnerId, payload: raw, version };
  } catch {
    return null;
  }
}

async function reconcileAtomicOperationLock(
  operation: AtomicOperationRecordInput
): Promise<AtomicServerActionLockResult | null> {
  const [lock, binding] = await Promise.all([getCurrentLock(), readAtomicOperationBinding(operation.operationId)]);
  if (
    !lock ||
    lock.operationId !== operation.operationId ||
    !binding ||
    binding.lockId !== lock.lockId ||
    binding.fencingToken !== lock.fencingToken ||
    lock.operationOwnerId !== binding.dispatchOwnerId
  ) {
    return null;
  }
  return {
    lock,
    ownership: binding.dispatchOwnerId === operation.ownerId ? "acquired" : "attached",
  };
}

/**
 * Acquires the global lifecycle fence and binds it to an existing durable
 * operation in one DynamoDB transaction. The caller must create the operation
 * before entering this boundary. DynamoDB is the only production authority;
 * SSM compatibility state is never bootstrapped or mutated here.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Dual-protocol bridge acquisition and the two-table transaction are one atomic ownership boundary.
export async function acquireServerActionLockWithOperation(
  action: ServerActionType,
  ownerEmail: string,
  operation: AtomicOperationRecordInput
): Promise<AtomicServerActionLockResult> {
  if (!acquirableServerActions.has(action as Exclude<ServerActionType, "destroy">)) {
    throw new Error(`Unsupported lifecycle action: ${action}`);
  }
  if (isMockBackendMode()) {
    throw new Error("Atomic operation-bound lifecycle acquisition requires the DynamoDB state backend");
  }
  if (!operation.operationId || !operation.ownerId || !Number.isSafeInteger(operation.expectedVersion)) {
    throw new TypeError("Atomic lifecycle operation ownership is invalid");
  }
  await assertBridgeMetadata();

  const legacyLock = await acquireLegacyBridgeLock(action, ownerEmail, operation.retainForAgentEffect === true, {
    operationId: operation.operationId,
    operationOwnerId: operation.ownerId,
  });

  const currentItem = await getCurrentLockItem();
  const previousToken = Number(currentItem?.fencingToken?.N ?? 0);
  if (!Number.isSafeInteger(previousToken) || previousToken < 0 || previousToken >= Number.MAX_SAFE_INTEGER) {
    await releaseLegacyBridgeLockWithRetry(legacyLock.lockId).catch(() => undefined);
    throw new Error("Lifecycle fencing token is invalid");
  }
  const lock: ServerActionLock = {
    ...legacyLock,
    fencingToken: previousToken + 1,
    operationId: operation.operationId,
    operationOwnerId: operation.ownerId,
  };
  const nextVersion = operation.expectedVersion + 1;
  try {
    await getDynamoDbClient().send(
      new TransactWriteItemsCommand({
        ClientRequestToken: operation.ownerId,
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: { lockKey: { S: lockKey } },
              ConditionExpression:
                "(attribute_not_exists(lockId) OR released = :true OR (leaseExpiresAt < :now AND (attribute_not_exists(agentFenceActive) OR agentFenceActive = :false))) AND (attribute_not_exists(fencingToken) OR fencingToken = :previousToken)",
              UpdateExpression:
                "SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, leaseGeneration = :leaseGeneration, agentFenceActive = :agentFenceActive, released = :false, protocolVersion = :protocol, fencingToken = :nextToken, operationId = :operationId, operationOwnerId = :operationOwnerId REMOVE ttlEpochSeconds",
              ExpressionAttributeNames: { "#action": "action" },
              ExpressionAttributeValues: {
                ":lockId": { S: lock.lockId },
                ":action": { S: action },
                ":ownerEmail": { S: ownerEmail.trim().toLowerCase() },
                ":createdAt": { S: lock.createdAt },
                ":lease": { N: String(Date.parse(lock.expiresAt)) },
                ":protocol": { S: protocolVersion },
                ":now": { N: String(Date.now()) },
                ":true": { BOOL: true },
                ":false": { BOOL: false },
                ":agentFenceActive": { BOOL: operation.retainForAgentEffect === true },
                ":previousToken": { N: String(previousToken) },
                ":nextToken": { N: String(lock.fencingToken) },
                ":leaseGeneration": { N: String(lock.leaseGeneration) },
                ":operationId": { S: operation.operationId },
                ":operationOwnerId": { S: operation.ownerId },
              },
            },
          },
          {
            Update: {
              TableName: operationTableName(),
              Key: { operationId: { S: operation.operationId } },
              ConditionExpression: "#version = :expectedVersion",
              UpdateExpression: operationStateUpdateExpression("running"),
              ExpressionAttributeNames: { "#version": "version", "#status": "status" },
              ExpressionAttributeValues: {
                ":expectedVersion": { N: String(operation.expectedVersion) },
                ":nextVersion": { N: String(nextVersion) },
                ":payload": { S: operation.payload(lock) },
                ":status": { S: operation.status },
                ":phase": { S: operation.phase },
                ":updatedAt": { S: operation.updatedAt },
              },
            },
          },
        ],
      })
    );
    return { lock, ownership: "acquired" };
  } catch (error) {
    for (let attempt = 0; attempt < ambiguityRepairAttempts; attempt++) {
      const reconciled = await reconcileAtomicOperationLock(operation).catch(() => null);
      if (reconciled) return reconciled;
    }
    if ((error as { name?: string })?.name !== "TransactionCanceledException") {
      if (error && typeof error === "object") Object.assign(error, { retainLegacyBridge: true });
      throw error;
    }
    await releaseLegacyBridgeLockWithRetry(lock.lockId).catch(() =>
      console.error("[LOCK] Failed to compensate atomic lifecycle bridge lock")
    );
    const active = await getCurrentLock().catch(() => null);
    if (active) throw new ServerActionLockConflictError(active);
    throw error;
  }
}

/**
 * Rotates an expired protected replacement owner only when the complete prior
 * lock identity and durable operation version still match. Generic lifecycle
 * acquisition cannot cross the protected agentFenceActive boundary.
 */
export async function takeOverProtectedServerActionLockWithOperation(
  ownerEmail: string,
  operation: AtomicReplacementTakeoverInput
): Promise<AtomicServerActionLockResult> {
  if (
    isMockBackendMode() ||
    !operation.operationId ||
    !operation.ownerId ||
    !operation.previousLockId ||
    !operation.previousOperationOwnerId ||
    !Number.isSafeInteger(operation.expectedVersion) ||
    !Number.isSafeInteger(operation.previousFencingToken) ||
    !Number.isSafeInteger(operation.previousLeaseGeneration)
  ) {
    throw new TypeError("Protected replacement takeover identity is invalid");
  }
  await assertBridgeMetadata();
  const now = Date.now();
  const current = parseLockItem(await getCurrentLockItem());
  if (current?.operationId === operation.operationId && current.operationOwnerId === operation.ownerId) {
    const completed = await reconcileAtomicOperationLock(operation);
    if (completed?.ownership === "acquired") {
      await mirrorProtectedTakeoverForward(completed.lock, operation.previousLockId, operation.operationId);
      return { ...completed, ownership: "attached" };
    }
  }
  if (
    !current ||
    current.lockId !== operation.previousLockId ||
    current.fencingToken !== operation.previousFencingToken ||
    current.leaseGeneration !== operation.previousLeaseGeneration ||
    current.operationId !== operation.operationId ||
    current.operationOwnerId !== operation.previousOperationOwnerId ||
    current.action !== "backup" ||
    current.agentFenceActive !== true ||
    Date.parse(current.expiresAt) >= now
  ) {
    throw new ServerActionLockConflictError(current);
  }
  const lock: ServerActionLock = {
    lockId: randomUUID(),
    fencingToken: current.fencingToken + 1,
    leaseGeneration: 1,
    agentFenceActive: true,
    action: "backup",
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
    operationId: operation.operationId,
    operationOwnerId: operation.ownerId,
  };
  const nextVersion = operation.expectedVersion + 1;
  const payload = operation.payload(lock);
  try {
    await getDynamoDbClient().send(
      new TransactWriteItemsCommand({
        ClientRequestToken: operation.ownerId,
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: { lockKey: { S: lockKey } },
              ConditionExpression:
                "lockId = :previousLockId AND fencingToken = :previousToken AND leaseGeneration = :previousGeneration AND released = :false AND #action = :action AND operationId = :operationId AND operationOwnerId = :previousOwner AND agentFenceActive = :true AND leaseExpiresAt < :now",
              UpdateExpression:
                "SET lockId = :lockId, fencingToken = :token, leaseGeneration = :generation, leaseExpiresAt = :lease, agentFenceActive = :true, ownerEmail = :ownerEmail, createdAt = :createdAt, operationOwnerId = :owner, protocolVersion = :protocol REMOVE ttlEpochSeconds",
              ExpressionAttributeNames: { "#action": "action" },
              ExpressionAttributeValues: {
                ":previousLockId": { S: operation.previousLockId },
                ":previousToken": { N: String(operation.previousFencingToken) },
                ":previousGeneration": { N: String(operation.previousLeaseGeneration) },
                ":false": { BOOL: false },
                ":true": { BOOL: true },
                ":action": { S: "backup" },
                ":operationId": { S: operation.operationId },
                ":previousOwner": { S: operation.previousOperationOwnerId },
                ":now": { N: String(now) },
                ":lockId": { S: lock.lockId },
                ":token": { N: String(lock.fencingToken) },
                ":generation": { N: "1" },
                ":lease": { N: String(Date.parse(lock.expiresAt)) },
                ":ownerEmail": { S: lock.ownerEmail },
                ":createdAt": { S: lock.createdAt },
                ":owner": { S: operation.ownerId },
                ":protocol": { S: protocolVersion },
              },
            },
          },
          {
            Update: {
              TableName: operationTableName(),
              Key: { operationId: { S: operation.operationId } },
              ConditionExpression: "#version = :expectedVersion AND #status = :expectedStatus",
              UpdateExpression: operationStateUpdateExpression("running"),
              ExpressionAttributeNames: { "#version": "version", "#status": "status" },
              ExpressionAttributeValues: {
                ":expectedVersion": { N: String(operation.expectedVersion) },
                ":expectedStatus": { S: "running" },
                ":nextVersion": { N: String(nextVersion) },
                ":payload": { S: payload },
                ":status": { S: operation.status },
                ":phase": { S: operation.phase },
                ":updatedAt": { S: operation.updatedAt },
              },
            },
          },
        ],
      })
    );
  } catch (_error) {
    for (let attempt = 0; attempt < ambiguityRepairAttempts; attempt++) {
      const reconciled = await reconcileAtomicOperationLock(operation).catch(() => null);
      if (reconciled?.lock.operationOwnerId === operation.ownerId) {
        await mirrorProtectedTakeoverForward(reconciled.lock, operation.previousLockId, operation.operationId);
        return reconciled;
      }
    }
    throw new ServerActionLockConflictError(parseLockItem(await getCurrentLockItem()));
  }
  await mirrorProtectedTakeoverForward(lock, operation.previousLockId, operation.operationId);
  return { lock, ownership: "acquired" };
}

export async function acquireServerActionLock(action: ServerActionType, ownerEmail: string): Promise<ServerActionLock> {
  if (!acquirableServerActions.has(action as Exclude<ServerActionType, "destroy">)) {
    throw new Error(`Unsupported lifecycle action: ${action}`);
  }
  if (isMockBackendMode()) {
    return await acquireMockLock(action, ownerEmail);
  }
  await assertBridgeMetadata();
  const legacyLock = await acquireLegacyBridgeLock(action, ownerEmail);
  const now = Date.now();
  const lockId = legacyLock.lockId;
  const createdAt = legacyLock.createdAt;
  const expiresAtMs = Date.parse(legacyLock.expiresAt);
  try {
    const response = await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: lockKey } },
        ConditionExpression:
          "attribute_not_exists(lockId) OR released = :true OR (leaseExpiresAt < :now AND (attribute_not_exists(agentFenceActive) OR agentFenceActive = :false))",
        UpdateExpression:
          "SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, leaseGeneration = :leaseGeneration, agentFenceActive = :false, released = :false, protocolVersion = :protocol, fencingToken = if_not_exists(fencingToken, :zero) + :one REMOVE ttlEpochSeconds, operationId, operationOwnerId",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: {
          ":lockId": { S: lockId },
          ":action": { S: action },
          ":ownerEmail": { S: ownerEmail.trim().toLowerCase() },
          ":createdAt": { S: createdAt },
          ":lease": { N: String(expiresAtMs) },
          ":protocol": { S: protocolVersion },
          ":now": { N: String(now) },
          ":true": { BOOL: true },
          ":false": { BOOL: false },
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":leaseGeneration": { N: "1" },
        },
        ReturnValues: "ALL_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
    const acquired = parseLockItem(response.Attributes);
    if (!acquired) throw new Error("DynamoDB returned an invalid lifecycle lock record");
    return acquired;
  } catch (error) {
    const reconciled = await getCurrentLock().catch(() => null);
    if (reconciled?.lockId === lockId) return reconciled;
    if (!isConditionalFailure(error)) {
      const repaired = await reconcileAmbiguousAcquisition(lockId);
      if (repaired?.lockId === lockId) return repaired;
      await releaseLegacyBridgeLockWithRetry(lockId).catch(() =>
        console.error("[LOCK] Failed to compensate legacy bridge lock")
      );
      throw error;
    }
    await releaseLegacyBridgeLockWithRetry(lockId).catch(() =>
      console.error("[LOCK] Failed to compensate legacy bridge lock")
    );
    const existing = parseLockItem(
      (error as { Item?: Record<string, { S?: string; N?: string; BOOL?: boolean }> }).Item
    );
    throw new ServerActionLockConflictError(existing ?? (await getCurrentLock()));
  }
}

/**
 * Advances an agent-owned lifecycle fence and its durable backup authorization
 * in one transaction. DynamoDB (or the single mock transaction) is the only
 * authority. SSM compatibility state is intentionally not synchronized after
 * a committed renewal because SSM has no conditional mutation primitive.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Two-record ownership validation, transaction, and response-loss reconciliation are one security boundary.
export async function renewServerActionLockWithOperation(
  lockId: string,
  fencingToken: number,
  input: AtomicOperationFenceRenewalInput
): Promise<AtomicOperationFenceRenewalResult> {
  if (
    !lockId ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1 ||
    !input.operationId ||
    !input.operationOwnerId ||
    !Number.isSafeInteger(input.expectedOperationVersion) ||
    input.expectedOperationVersion < 1 ||
    !Number.isSafeInteger(input.expectedLeaseGeneration) ||
    input.expectedLeaseGeneration < 1
  ) {
    throw new TypeError("Atomic lifecycle fence renewal identity is invalid");
  }
  const operationStatus = input.status ?? "completed";
  const operationPhase = input.phase ?? "terminal";
  const retainForAgentEffect = input.retainForAgentEffect ?? true;

  if (isMockBackendMode()) {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The mock transaction mirrors the atomic durable renewal and reconciliation boundary.
    const result = await getMockStateStore().transact(async (state) => {
      const lockParameter = state.ssm.parameters[legacyLockParameter];
      const operationParameter = state.ssm.parameters[`/minecraft/operations/${input.operationId}`];
      const lock = parseMockLock(lockParameter?.value ?? null);
      if (!lock || !operationParameter) return null;
      let operationPayload: string;
      let operationVersion: number;
      try {
        const parsed = JSON.parse(operationParameter.value) as Record<string, unknown>;
        operationVersion = Number(parsed.version);
        operationPayload = operationParameter.value;
      } catch {
        return null;
      }
      if (
        lock.lockId !== lockId ||
        lock.fencingToken !== fencingToken ||
        lock.action !== "backup" ||
        lock.operationId !== input.operationId ||
        lock.operationOwnerId !== input.operationOwnerId ||
        !Number.isSafeInteger(operationVersion) ||
        !exactOperationLockIdentity(operationPayload, lock, input.operationId, input.operationOwnerId)
      ) {
        return null;
      }
      if ((lock.leaseGeneration ?? 1) !== input.expectedLeaseGeneration) {
        return (lock.leaseGeneration ?? 1) > input.expectedLeaseGeneration &&
          input.reconcile(operationPayload, lock, operationVersion)
          ? {
              lock,
              operationPayload,
              operationVersion,
              ownership: "reconciled" as const,
            }
          : null;
      }
      if (operationVersion !== input.expectedOperationVersion) return null;
      const now = Date.now();
      if (!lock.agentFenceActive && Date.parse(lock.expiresAt) < now) return null;
      const renewed: ServerActionLock = {
        ...lock,
        leaseGeneration: input.expectedLeaseGeneration + 1,
        expiresAt: new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
        agentFenceActive: retainForAgentEffect || lock.agentFenceActive === true,
      };
      const nextOperationVersion = operationVersion + 1;
      const nextPayload = await input.payload(renewed, nextOperationVersion);
      state.ssm.parameters[legacyLockParameter] = {
        value: JSON.stringify(renewed),
        type: "String",
        lastModified: input.updatedAt,
        version: (lockParameter.version ?? 0) + 1,
      };
      state.ssm.parameters[`/minecraft/operations/${input.operationId}`] = {
        value: nextPayload,
        type: "String",
        lastModified: input.updatedAt,
        version: (operationParameter.version ?? 0) + 1,
      };
      return {
        lock: renewed,
        operationPayload: nextPayload,
        operationVersion: nextOperationVersion,
        ownership: "renewed" as const,
      };
    });
    if (!result) throw new ServerActionLockConflictError(null);
    return result;
  }

  await assertBridgeMetadata();
  const currentItem = await getCurrentLockItem();
  const current = parseLockItem(currentItem);
  if (
    !current ||
    current.lockId !== lockId ||
    current.fencingToken !== fencingToken ||
    current.action !== "backup" ||
    current.operationId !== input.operationId ||
    current.operationOwnerId !== input.operationOwnerId ||
    (!current.agentFenceActive && Date.parse(current.expiresAt) < Date.now()) ||
    (current.leaseGeneration ?? 1) !== input.expectedLeaseGeneration
  ) {
    const reconciled = await reconcileAtomicFenceRenewal(lockId, fencingToken, input);
    if (!reconciled) throw new ServerActionLockConflictError(current);
    await mirrorLegacyLockForward(reconciled.lock);
    return reconciled;
  }

  const renewed: ServerActionLock = {
    ...current,
    leaseGeneration: input.expectedLeaseGeneration + 1,
    expiresAt: new Date(Date.now() + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
    agentFenceActive: retainForAgentEffect || current.agentFenceActive === true,
  };
  const nextOperationVersion = input.expectedOperationVersion + 1;
  const operationPayload = await input.payload(renewed, nextOperationVersion);
  try {
    await getDynamoDbClient().send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: { lockKey: { S: lockKey } },
              ConditionExpression:
                "lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND operationId = :operationId AND operationOwnerId = :operationOwnerId AND leaseGeneration = :generation AND (leaseExpiresAt >= :now OR agentFenceActive = :true)",
              UpdateExpression:
                "SET leaseExpiresAt = :lease, leaseGeneration = :nextGeneration, agentFenceActive = :agentFenceActive REMOVE ttlEpochSeconds",
              ExpressionAttributeNames: { "#action": "action" },
              ExpressionAttributeValues: {
                ":lockId": { S: lockId },
                ":token": { N: String(fencingToken) },
                ":false": { BOOL: false },
                ":true": { BOOL: true },
                ":agentFenceActive": { BOOL: renewed.agentFenceActive === true },
                ":action": { S: "backup" },
                ":operationId": { S: input.operationId },
                ":operationOwnerId": { S: input.operationOwnerId },
                ":generation": { N: String(input.expectedLeaseGeneration) },
                ":nextGeneration": { N: String(renewed.leaseGeneration) },
                ":lease": { N: String(Date.parse(renewed.expiresAt)) },
                ":now": { N: String(Date.now()) },
              },
            },
          },
          {
            Update: {
              TableName: operationTableName(),
              Key: { operationId: { S: input.operationId } },
              ConditionExpression: "#version = :expectedVersion",
              UpdateExpression: operationStateUpdateExpression("running"),
              ExpressionAttributeNames: { "#version": "version", "#status": "status" },
              ExpressionAttributeValues: {
                ":expectedVersion": { N: String(input.expectedOperationVersion) },
                ":nextVersion": { N: String(nextOperationVersion) },
                ":payload": { S: operationPayload },
                ":status": { S: operationStatus },
                ":phase": { S: operationPhase },
                ":updatedAt": { S: input.updatedAt },
              },
            },
          },
        ],
      })
    );
  } catch (error) {
    for (let attempt = 0; attempt < ambiguityRepairAttempts; attempt++) {
      const reconciled = await reconcileAtomicFenceRenewal(lockId, fencingToken, input).catch(() => null);
      if (reconciled) {
        await mirrorLegacyLockForward(reconciled.lock);
        return reconciled;
      }
    }
    if ((error as { name?: string })?.name === "TransactionCanceledException" || isConditionalFailure(error)) {
      throw new ServerActionLockConflictError(parseLockItem(await getCurrentLockItem()));
    }
    throw error;
  }

  await mirrorLegacyLockForward(renewed);
  return {
    lock: renewed,
    operationPayload,
    operationVersion: nextOperationVersion,
    ownership: "renewed",
  };
}

export async function assertServerActionLockOwned(
  lockId: string,
  fencingToken: number,
  action: ServerActionType,
  ownership?: { ownerEmail?: string; operationId?: string }
): Promise<ServerActionLock> {
  if (isMockBackendMode()) {
    const mockLock = parseMockLock(await getParameter(legacyLockParameter));
    if (
      !mockLock ||
      mockLock.lockId !== lockId ||
      mockLock.fencingToken !== fencingToken ||
      mockLock.action !== action ||
      (ownership?.ownerEmail !== undefined && mockLock.ownerEmail !== ownership.ownerEmail.trim().toLowerCase()) ||
      (ownership?.operationId !== undefined && mockLock.operationId !== ownership.operationId)
    ) {
      throw new ServerActionLockConflictError(mockLock);
    }
    return mockLock;
  }
  await assertBridgeMetadata();
  const current = await getCurrentLock();
  if (
    !current ||
    current.lockId !== lockId ||
    current.fencingToken !== fencingToken ||
    current.action !== action ||
    (ownership?.ownerEmail !== undefined && current.ownerEmail !== ownership.ownerEmail.trim().toLowerCase()) ||
    (ownership?.operationId !== undefined && current.operationId !== ownership.operationId)
  ) {
    throw new ServerActionLockConflictError(current);
  }
  return current;
}

export async function renewServerActionLock(
  lockId: string,
  fencingToken: number,
  options: RenewServerActionLockOptions = {}
): Promise<ServerActionLock> {
  if (isMockBackendMode()) {
    const now = Date.now();
    const renewed = await getMockStateStore().renewLifecycleLock(
      lockId,
      fencingToken,
      new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
      now,
      options.expectedLeaseGeneration,
      options.retainForAgentEffect === true
    );
    if (!renewed) throw new ServerActionLockConflictError(parseMockLock(await getParameter(legacyLockParameter)));
    return renewed as ServerActionLock;
  }
  await assertBridgeMetadata();
  const now = Date.now();
  const expiresAtMs = now + LIFECYCLE_LOCK_LEASE_MS;
  const current = await getCurrentLock();
  const expectedLeaseGeneration = options.expectedLeaseGeneration ?? current?.leaseGeneration;
  if (
    !current ||
    current.lockId !== lockId ||
    current.fencingToken !== fencingToken ||
    !Number.isSafeInteger(expectedLeaseGeneration) ||
    expectedLeaseGeneration! < 1 ||
    current.leaseGeneration !== expectedLeaseGeneration ||
    (!current.agentFenceActive && Date.parse(current.expiresAt) < now)
  ) {
    throw new ServerActionLockConflictError(await getCurrentLock());
  }
  try {
    const response = await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: lockKey } },
        ConditionExpression:
          "lockId = :lockId AND fencingToken = :token AND released = :false AND leaseGeneration = :generation AND (leaseExpiresAt >= :now OR agentFenceActive = :true)",
        UpdateExpression: `SET leaseExpiresAt = :lease, leaseGeneration = :nextGeneration${
          options.retainForAgentEffect === true ? ", agentFenceActive = :true" : ""
        } REMOVE ttlEpochSeconds`,
        ExpressionAttributeValues: {
          ":lockId": { S: lockId },
          ":token": { N: String(fencingToken) },
          ":false": { BOOL: false },
          ":now": { N: String(now) },
          ":lease": { N: String(expiresAtMs) },
          ":generation": { N: String(expectedLeaseGeneration) },
          ":nextGeneration": { N: String(expectedLeaseGeneration! + 1) },
          ":true": { BOOL: true },
        },
        ReturnValues: "ALL_NEW",
      })
    );
    const renewed = parseLockItem(response.Attributes);
    if (!renewed) throw new Error("DynamoDB returned an invalid renewed lifecycle lock record");
    return renewed;
  } catch (error) {
    if (isConditionalFailure(error)) throw new ServerActionLockConflictError(await getCurrentLock());
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conditional release and ambiguous bridge cleanup must remain one fenced operation.
export async function releaseServerActionLock(
  lockId: string,
  options?: ReleaseServerActionLockOptions
): Promise<boolean> {
  const fencingToken = options?.fencingToken;
  if (!Number.isSafeInteger(fencingToken)) return false;
  if (isMockBackendMode()) {
    return await releaseMockLock(lockId, fencingToken as number, options);
  }
  const values: Record<string, AttributeValue> = {
    ":lockId": { S: lockId },
    ":token": { N: String(fencingToken) },
    ":true": { BOOL: true },
  };
  const conditions = ["lockId = :lockId", "fencingToken = :token", "released = :false"];
  values[":false"] = { BOOL: false };
  if (options?.action) {
    conditions.push("#action = :action");
    values[":action"] = { S: options.action };
  }
  if (options?.ownerEmail) {
    conditions.push("ownerEmail = :ownerEmail");
    values[":ownerEmail"] = { S: options.ownerEmail.trim().toLowerCase() };
  }
  if (options?.leaseGeneration !== undefined) {
    if (!Number.isSafeInteger(options.leaseGeneration) || options.leaseGeneration < 1) return false;
    conditions.push("leaseGeneration = :leaseGeneration");
    values[":leaseGeneration"] = { N: String(options.leaseGeneration) };
  }
  try {
    await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: lockKey } },
        ConditionExpression: conditions.join(" AND "),
        UpdateExpression: "SET released = :true REMOVE ttlEpochSeconds",
        ExpressionAttributeNames: options?.action ? { "#action": "action" } : undefined,
        ExpressionAttributeValues: values,
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
    if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
      throw new Error("Lifecycle lock release committed but reconciliation did not converge");
    }
    return true;
  } catch (error) {
    const failedItem = (error as { Item?: Record<string, { S?: string; N?: string; BOOL?: boolean }> }).Item;
    const currentItem = failedItem ?? (await getCurrentLockItem().catch(() => undefined));
    if (isMatchingReleasedItem(currentItem, lockId, fencingToken as number)) {
      if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
        throw new Error("Lifecycle lock release reconciliation did not converge");
      }
      return true;
    }
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

/** Atomically marks the exact operation resolved and releases its exact lock generation. */
export async function finalizeServerActionLockWithOperation(
  input: AtomicOperationFenceFinalizationInput
): Promise<AtomicOperationFenceFinalizationResult> {
  if (
    isMockBackendMode() ||
    !input.operationId ||
    !input.operationOwnerId ||
    !Number.isSafeInteger(input.expectedOperationVersion) ||
    !Number.isSafeInteger(input.fencingToken) ||
    !Number.isSafeInteger(input.expectedLeaseGeneration)
  ) {
    throw new TypeError("Atomic lifecycle finalization identity is invalid");
  }
  const nextVersion = input.expectedOperationVersion + 1;
  const expectedStatus = input.expectedStatus ?? "completed";
  const expectedPhase = input.expectedPhase ?? "terminal";
  const expectedAgentFenceActive = input.expectedAgentFenceActive ?? true;
  try {
    await getDynamoDbClient().send(
      new TransactWriteItemsCommand({
        ClientRequestToken: `finalize-${input.operationId}-${input.expectedOperationVersion}`.slice(0, 36),
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: { lockKey: { S: lockKey } },
              ConditionExpression:
                "lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND ownerEmail = :ownerEmail AND leaseGeneration = :generation AND agentFenceActive = :agentFenceActive AND operationId = :operationId AND operationOwnerId = :operationOwnerId",
              UpdateExpression: "SET released = :true REMOVE ttlEpochSeconds",
              ExpressionAttributeNames: { "#action": "action" },
              ExpressionAttributeValues: {
                ":lockId": { S: input.lockId },
                ":token": { N: String(input.fencingToken) },
                ":false": { BOOL: false },
                ":true": { BOOL: true },
                ":agentFenceActive": { BOOL: expectedAgentFenceActive },
                ":action": { S: input.action },
                ":ownerEmail": { S: input.ownerEmail.trim().toLowerCase() },
                ":generation": { N: String(input.expectedLeaseGeneration) },
                ":operationId": { S: input.operationId },
                ":operationOwnerId": { S: input.operationOwnerId },
              },
            },
          },
          {
            Update: {
              TableName: operationTableName(),
              Key: { operationId: { S: input.operationId } },
              ConditionExpression:
                "#version = :expectedVersion AND #status = :expectedStatus AND phase = :expectedPhase",
              UpdateExpression: operationStateUpdateExpression(input.status),
              ExpressionAttributeNames: { "#version": "version", "#status": "status" },
              ExpressionAttributeValues: {
                ":expectedVersion": { N: String(input.expectedOperationVersion) },
                ":expectedStatus": { S: expectedStatus },
                ":expectedPhase": { S: expectedPhase },
                ":payload": { S: input.payload },
                ":nextVersion": { N: String(nextVersion) },
                ":status": { S: input.status },
                ":phase": { S: input.phase },
                ":updatedAt": { S: input.updatedAt },
                ...operationStateTtlValue(input.status, input.ttlEpochSeconds),
              },
            },
          },
        ],
      })
    );
    await releaseLegacyBridgeLockWithRetry(input.lockId);
    return { operationPayload: input.payload, operationVersion: nextVersion };
  } catch (error) {
    const [currentItem, binding] = await Promise.all([
      getCurrentLockItem().catch(() => undefined),
      readAtomicOperationBinding(input.operationId).catch(() => null),
    ]);
    if (
      isMatchingReleasedItem(currentItem, input.lockId, input.fencingToken) &&
      binding?.lockId === input.lockId &&
      binding.fencingToken === input.fencingToken &&
      binding.dispatchOwnerId === input.operationOwnerId &&
      binding.version === nextVersion &&
      binding.payload === input.payload
    ) {
      await releaseLegacyBridgeLockWithRetry(input.lockId);
      return { operationPayload: input.payload, operationVersion: nextVersion };
    }
    if (isConditionalFailure(error)) throw new ServerActionLockConflictError(null);
    throw error;
  }
}

/** Releases only the complete lock identity captured by the owning operation. */
export async function releaseServerActionLockIfOwned(input: ReleaseServerActionLockIfOwnedInput): Promise<boolean> {
  const normalizedLockId = input.lockId.trim();
  const normalizedOwnerEmail = input.ownerEmail.trim().toLowerCase();
  if (
    !normalizedLockId ||
    !normalizedOwnerEmail ||
    !Number.isSafeInteger(input.fencingToken) ||
    input.fencingToken < 1
  ) {
    return false;
  }

  return await releaseServerActionLock(normalizedLockId, {
    action: input.action,
    ownerEmail: normalizedOwnerEmail,
    fencingToken: input.fencingToken,
  });
}

export function isServerActionLockConflictError(error: unknown): error is ServerActionLockConflictError {
  return error instanceof ServerActionLockConflictError;
}
