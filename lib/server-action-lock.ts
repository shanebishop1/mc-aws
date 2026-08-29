import { randomUUID } from "node:crypto";
import { deleteParameter, getParameter, putParameter } from "@/lib/aws";
import { GetItemCommand, UpdateItemCommand, getDynamoDbClient } from "@/lib/aws/dynamodb-client";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { LIFECYCLE_LOCK_LEASE_MS } from "@/lib/lifecycle-runtime-budget";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

const lockKey = "minecraft-server-lifecycle";
const protocolMetadataKey = "protocol#dual-v1";
const legacyLockParameter = "/minecraft/server-action";
const legacyDeleteClaimPrefix = "/minecraft/server-action-delete-claim";
const protocolVersion = "dual-v1";
// Lambda async events may remain valid for one hour and an invocation may run for 15 minutes.
// Keep ownership beyond both windows so delayed valid deliveries cannot execute unfenced.
const deleteClaimLeaseMs = 60 * 1000;
const ambiguityRepairAttempts = 3;
const serverActions: ReadonlySet<ServerActionType> = new Set([
  "start",
  "stop",
  "resume",
  "hibernate",
  "backup",
  "restore",
  "allowlist",
]);

export type ServerActionType = "start" | "stop" | "resume" | "hibernate" | "backup" | "restore" | "allowlist";

export interface ServerActionLock {
  lockId: string;
  fencingToken: number;
  action: ServerActionType;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string;
}

export interface ReleaseServerActionLockOptions {
  action?: ServerActionType;
  ownerEmail?: string;
  fencingToken?: number;
}

export interface ReleaseServerActionLockIfOwnedInput {
  lockId: string;
  action: ServerActionType;
  ownerEmail: string;
  fencingToken: number;
}

export class ServerActionLockConflictError extends Error {
  existingLock: ServerActionLock | null;

  constructor(existingLock: ServerActionLock | null) {
    super("Another operation is already in progress. Please wait for it to complete.");
    this.name = "ServerActionLockConflictError";
    this.existingLock = existingLock;
  }
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
  if (
    !lockId ||
    !ownerEmail ||
    !createdAt ||
    !serverActions.has(action) ||
    !Number.isSafeInteger(fencingToken) ||
    !Number.isFinite(leaseExpiresAt)
  ) {
    return null;
  }
  return {
    lockId,
    fencingToken,
    action,
    ownerEmail,
    createdAt,
    expiresAt: new Date(leaseExpiresAt).toISOString(),
  };
}

async function assertBridgeMetadata(): Promise<void> {
  if (process.env.MC_BACKEND_MODE === "mock") return;
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: protocolMetadataKey } },
      ConsistentRead: true,
    })
  );
  if (response.Item?.protocolVersion?.S !== protocolVersion) {
    throw new Error("Lifecycle lock dual-protocol metadata is missing");
  }
}

function isParameterAlreadyExistsError(error: unknown): boolean {
  const named = error as { name?: string; message?: string };
  return named.name === "ParameterAlreadyExists" || named.message?.includes("ParameterAlreadyExists") === true;
}

function isParameterNotFoundError(error: unknown): boolean {
  const named = error as { name?: string; message?: string };
  return named.name === "ParameterNotFound" || named.message?.includes("ParameterNotFound") === true;
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
    };
  } catch {
    return null;
  }
}

interface LegacyDeleteClaim {
  claimId: string;
  expiresAt: string;
}

function parseLegacyDeleteClaim(raw: string | null): LegacyDeleteClaim | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LegacyDeleteClaim>;
    if (!value.claimId || !value.expiresAt || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    return { claimId: value.claimId, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
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
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Claim lease takeover and ownership-safe cleanup form one SSM transaction boundary.
async function deleteLegacyBridgeLockIfExpected(lockId: string, requireExpired: boolean): Promise<boolean> {
  const claimParameter = `${legacyDeleteClaimPrefix}/${lockId}`;
  const claimId = randomUUID();
  let claimOwned = false;
  let claimExpiresAt = 0;
  for (let attempt = 0; attempt < 3 && !claimOwned; attempt++) {
    const now = Date.now();
    try {
      await putParameter(
        claimParameter,
        JSON.stringify({
          claimId,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + deleteClaimLeaseMs).toISOString(),
        }),
        "String",
        false
      );
      claimOwned = true;
      claimExpiresAt = now + deleteClaimLeaseMs;
    } catch (error) {
      if (!isParameterAlreadyExistsError(error)) throw error;
      const existingClaim = parseLegacyDeleteClaim(await getParameter(claimParameter));
      if (existingClaim && Date.parse(existingClaim.expiresAt) > now) return false;
      try {
        await deleteParameter(claimParameter);
      } catch (deleteError) {
        if (!isParameterNotFoundError(deleteError)) throw deleteError;
      }
    }
  }
  if (!claimOwned) return false;

  try {
    const current = parseLegacyLock(await getParameter(legacyLockParameter));
    if (!current || current.lockId !== lockId || (requireExpired && Date.parse(current.expiresAt) > Date.now())) {
      return false;
    }
    try {
      await deleteParameter(legacyLockParameter);
      return true;
    } catch (error) {
      if (isParameterNotFoundError(error)) return false;
      throw error;
    }
  } finally {
    try {
      if (Date.now() < claimExpiresAt) {
        await deleteParameter(claimParameter);
      } else {
        const currentClaim = parseLegacyDeleteClaim(await getParameter(claimParameter));
        if (currentClaim?.claimId === claimId) await deleteParameter(claimParameter);
      }
    } catch (error) {
      if (!isParameterNotFoundError(error)) {
        console.warn(`[LOCK] Failed to clean legacy delete claim for lockId=${lockId}`);
      }
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Atomic SSM acquisition, orphan repair, and stale takeover remain one bridge boundary.
async function acquireLegacyBridgeLock(action: ServerActionType, ownerEmail: string) {
  const now = Date.now();
  const lock = {
    lockId: randomUUID(),
    action,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
  };
  try {
    await putParameter(legacyLockParameter, JSON.stringify(lock), "String", false);
    return lock;
  } catch (error) {
    if (!isParameterAlreadyExistsError(error)) throw error;
  }

  const existing = parseLegacyLock(await getParameter(legacyLockParameter));
  if (existing && Date.parse(existing.expiresAt) > now) {
    const currentItem = await getCurrentLockItem();
    if (currentItem?.released?.BOOL === true && currentItem.lockId?.S === existing.lockId) {
      const cleaned = await releaseLegacyBridgeLockWithRetry(existing.lockId);
      if (!cleaned) throw new Error("Lifecycle lock bridge reconciliation did not converge");
      try {
        await putParameter(legacyLockParameter, JSON.stringify(lock), "String", false);
        return lock;
      } catch (error) {
        if (!isParameterAlreadyExistsError(error)) throw error;
      }
    }
    throw new ServerActionLockConflictError(null);
  }
  if (!existing) {
    throw new ServerActionLockConflictError(null);
  }
  await deleteLegacyBridgeLockIfExpected(existing.lockId, true);
  try {
    await putParameter(legacyLockParameter, JSON.stringify(lock), "String", false);
    return lock;
  } catch (error) {
    if (!isParameterAlreadyExistsError(error)) throw error;
    throw new ServerActionLockConflictError(null);
  }
}

async function releaseLegacyBridgeLock(lockId: string): Promise<boolean> {
  return deleteLegacyBridgeLockIfExpected(lockId, false);
}

async function releaseLegacyBridgeLockWithRetry(lockId: string): Promise<boolean> {
  for (let attempt = 0; attempt < ambiguityRepairAttempts; attempt++) {
    if (await releaseLegacyBridgeLock(lockId)) return true;
    const current = parseLegacyLock(await getParameter(legacyLockParameter));
    if (!current) return true;
    if (current.lockId !== lockId) return false;
  }
  return false;
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
  return lock && Date.parse(lock.expiresAt) > Date.now() ? lock : null;
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

export async function acquireServerActionLock(action: ServerActionType, ownerEmail: string): Promise<ServerActionLock> {
  if (!serverActions.has(action)) throw new Error(`Unsupported lifecycle action: ${action}`);
  if (process.env.MC_BACKEND_MODE === "mock") {
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
        ConditionExpression: "attribute_not_exists(lockId) OR released = :true OR leaseExpiresAt < :now",
        UpdateExpression:
          "SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, released = :false, protocolVersion = :protocol, fencingToken = if_not_exists(fencingToken, :zero) + :one REMOVE ttlEpochSeconds",
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

export async function assertServerActionLockOwned(
  lockId: string,
  fencingToken: number,
  action: ServerActionType
): Promise<ServerActionLock> {
  if (process.env.MC_BACKEND_MODE === "mock") {
    const mockLock = parseMockLock(await getParameter(legacyLockParameter));
    if (
      !mockLock ||
      mockLock.lockId !== lockId ||
      mockLock.fencingToken !== fencingToken ||
      mockLock.action !== action
    ) {
      throw new ServerActionLockConflictError(mockLock);
    }
    return mockLock;
  }
  await assertBridgeMetadata();
  const legacy = parseLegacyLock(await getParameter(legacyLockParameter));
  const current = await getCurrentLock();
  if (!current || current.lockId !== lockId || current.fencingToken !== fencingToken || current.action !== action) {
    throw new ServerActionLockConflictError(current);
  }
  if (!legacy) {
    try {
      await putParameter(
        legacyLockParameter,
        JSON.stringify({
          lockId: current.lockId,
          action: current.action,
          ownerEmail: current.ownerEmail,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
        }),
        "String",
        false
      );
    } catch (error) {
      if (!isParameterAlreadyExistsError(error)) throw error;
    }
  } else if (legacy.lockId !== lockId || legacy.action !== action) {
    throw new ServerActionLockConflictError(current);
  }
  return current;
}

export async function renewServerActionLock(lockId: string, fencingToken: number): Promise<ServerActionLock> {
  if (process.env.MC_BACKEND_MODE === "mock") {
    const now = Date.now();
    const renewed = await getMockStateStore().renewLifecycleLock(
      lockId,
      fencingToken,
      new Date(now + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
      now
    );
    if (!renewed) throw new ServerActionLockConflictError(parseMockLock(await getParameter(legacyLockParameter)));
    return renewed as ServerActionLock;
  }
  await assertBridgeMetadata();
  const now = Date.now();
  const expiresAtMs = now + LIFECYCLE_LOCK_LEASE_MS;
  const legacy = parseLegacyLock(await getParameter(legacyLockParameter));
  if (!legacy || legacy.lockId !== lockId || Date.parse(legacy.expiresAt) < now) {
    throw new ServerActionLockConflictError(await getCurrentLock());
  }
  await putParameter(
    legacyLockParameter,
    JSON.stringify({ ...legacy, expiresAt: new Date(expiresAtMs).toISOString() }),
    "String",
    true
  );
  try {
    const response = await getDynamoDbClient().send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: lockKey } },
        ConditionExpression:
          "lockId = :lockId AND fencingToken = :token AND released = :false AND leaseExpiresAt >= :now",
        UpdateExpression: "SET leaseExpiresAt = :lease REMOVE ttlEpochSeconds",
        ExpressionAttributeValues: {
          ":lockId": { S: lockId },
          ":token": { N: String(fencingToken) },
          ":false": { BOOL: false },
          ":now": { N: String(now) },
          ":lease": { N: String(expiresAtMs) },
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

export async function releaseServerActionLock(
  lockId: string,
  options?: ReleaseServerActionLockOptions
): Promise<boolean> {
  const fencingToken = options?.fencingToken;
  if (!Number.isSafeInteger(fencingToken)) return false;
  if (process.env.MC_BACKEND_MODE === "mock") {
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
      throw new Error("Lifecycle lock release committed but bridge cleanup did not converge");
    }
    return true;
  } catch (error) {
    const failedItem = (error as { Item?: Record<string, { S?: string; N?: string; BOOL?: boolean }> }).Item;
    const currentItem = failedItem ?? (await getCurrentLockItem().catch(() => undefined));
    if (isMatchingReleasedItem(currentItem, lockId, fencingToken as number)) {
      if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
        throw new Error("Lifecycle lock release reconciliation could not clean the bridge");
      }
      return true;
    }
    if (isConditionalFailure(error)) return false;
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
