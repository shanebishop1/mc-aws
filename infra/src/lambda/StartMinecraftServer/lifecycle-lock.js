import { randomUUID } from "node:crypto";
import { GetItemCommand, UpdateItemCommand, dynamodb } from "./clients.js";
import { deleteParameter, getParameter, putParameter } from "./ssm.js";

const LOCK_KEY = "minecraft-server-lifecycle";
const PROTOCOL_METADATA_KEY = "protocol#dual-v1";
const LEGACY_LOCK_PARAMETER = "/minecraft/server-action";
const LEGACY_DELETE_CLAIM_PREFIX = "/minecraft/server-action-delete-claim";
const PROTOCOL_VERSION = "dual-v1";
const LOCK_LEASE_MS = 90 * 60 * 1000;
const DELETE_CLAIM_LEASE_MS = 60 * 1000;
const AMBIGUITY_REPAIR_ATTEMPTS = 3;
const ACTIONS = new Set(["start", "stop", "resume", "hibernate", "backup", "restore", "allowlist"]);

class LifecycleLockConflictError extends Error {
  constructor(existingLock) {
    super("Another lifecycle operation is already in progress");
    this.name = "LifecycleLockConflictError";
    this.existingLock = existingLock;
  }
}

function tableName() {
  const value = process.env.MC_LIFECYCLE_LOCK_TABLE_NAME?.trim();
  if (!value) throw new Error("MC_LIFECYCLE_LOCK_TABLE_NAME is required for lifecycle locking");
  return value;
}

function isConditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

function isParameterAlreadyExists(error) {
  return error?.name === "ParameterAlreadyExists" || error?.message?.includes("ParameterAlreadyExists") === true;
}

function isParameterNotFound(error) {
  return error?.name === "ParameterNotFound" || error?.message?.includes("ParameterNotFound") === true;
}

function parseLockItem(item) {
  if (!item || item.released?.BOOL === true) return null;
  const lockId = item.lockId?.S;
  const action = item.action?.S;
  const ownerEmail = item.ownerEmail?.S;
  const createdAt = item.createdAt?.S;
  const leaseExpiresAt = Number(item.leaseExpiresAt?.N ?? Number.NaN);
  const fencingToken = Number(item.fencingToken?.N ?? Number.NaN);
  if (
    !lockId ||
    !ACTIONS.has(action) ||
    !ownerEmail ||
    !createdAt ||
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

async function assertBridgeMetadata() {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: PROTOCOL_METADATA_KEY } },
      ConsistentRead: true,
    })
  );
  if (response.Item?.protocolVersion?.S !== PROTOCOL_VERSION) {
    throw new Error("Lifecycle lock dual-protocol metadata is missing");
  }
}

function parseLegacyLock(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value?.lockId ||
      !ACTIONS.has(value.action) ||
      !value.ownerEmail ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function parseLegacyDeleteClaim(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value?.claimId || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    return { claimId: value.claimId, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Claim lease takeover and ownership-safe cleanup form one SSM transaction boundary.
async function deleteLegacyBridgeLockIfExpected(lockId, requireExpired) {
  const claimParameter = `${LEGACY_DELETE_CLAIM_PREFIX}/${lockId}`;
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
          expiresAt: new Date(now + DELETE_CLAIM_LEASE_MS).toISOString(),
        }),
        "String",
        false
      );
      claimOwned = true;
      claimExpiresAt = now + DELETE_CLAIM_LEASE_MS;
    } catch (error) {
      if (!isParameterAlreadyExists(error)) throw error;
      const existingClaim = parseLegacyDeleteClaim(await getParameter(claimParameter));
      if (existingClaim && Date.parse(existingClaim.expiresAt) > now) return false;
      try {
        await deleteParameter(claimParameter);
      } catch (deleteError) {
        if (!isParameterNotFound(deleteError)) throw deleteError;
      }
    }
  }
  if (!claimOwned) return false;
  try {
    const current = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
    if (!current || current.lockId !== lockId || (requireExpired && Date.parse(current.expiresAt) > Date.now())) {
      return false;
    }
    try {
      await deleteParameter(LEGACY_LOCK_PARAMETER);
      return true;
    } catch (error) {
      if (isParameterNotFound(error)) return false;
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
      if (!isParameterNotFound(error)) console.error("Failed to clean legacy lifecycle delete claim");
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Atomic SSM acquisition, orphan repair, and stale takeover remain one bridge boundary.
async function acquireLegacyBridgeLock(action, ownerEmail) {
  const now = Date.now();
  const lock = {
    lockId: randomUUID(),
    action,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOCK_LEASE_MS).toISOString(),
  };
  try {
    await putParameter(LEGACY_LOCK_PARAMETER, JSON.stringify(lock), "String", false);
    return lock;
  } catch (error) {
    if (!isParameterAlreadyExists(error)) throw error;
  }
  const existing = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
  if (existing && Date.parse(existing.expiresAt) > now) {
    const currentItem = await getCurrentLifecycleLockItem();
    if (currentItem?.released?.BOOL === true && currentItem.lockId?.S === existing.lockId) {
      const cleaned = await releaseLegacyBridgeLockWithRetry(existing.lockId);
      if (!cleaned) throw new Error("Lifecycle lock bridge reconciliation did not converge");
      try {
        await putParameter(LEGACY_LOCK_PARAMETER, JSON.stringify(lock), "String", false);
        return lock;
      } catch (error) {
        if (!isParameterAlreadyExists(error)) throw error;
      }
    }
    throw new LifecycleLockConflictError(existing);
  }
  if (!existing) throw new LifecycleLockConflictError(existing);
  await deleteLegacyBridgeLockIfExpected(existing.lockId, true);
  try {
    await putParameter(LEGACY_LOCK_PARAMETER, JSON.stringify(lock), "String", false);
    return lock;
  } catch (error) {
    if (!isParameterAlreadyExists(error)) throw error;
    throw new LifecycleLockConflictError(parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER)));
  }
}

async function releaseLegacyBridgeLock(lockId) {
  return deleteLegacyBridgeLockIfExpected(lockId, false);
}

async function releaseLegacyBridgeLockWithRetry(lockId) {
  for (let attempt = 0; attempt < AMBIGUITY_REPAIR_ATTEMPTS; attempt++) {
    if (await releaseLegacyBridgeLock(lockId)) return true;
    const current = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
    if (!current) return true;
    if (current.lockId !== lockId) return false;
  }
  return false;
}

async function getCurrentLifecycleLock() {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: LOCK_KEY } },
      ConsistentRead: true,
    })
  );
  const lock = parseLockItem(response.Item);
  return lock && Date.parse(lock.expiresAt) > Date.now() ? lock : null;
}

async function getCurrentLifecycleLockItem() {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { lockKey: { S: LOCK_KEY } },
      ConsistentRead: true,
    })
  );
  return response.Item;
}

async function reconcileAmbiguousAcquisition(lockId) {
  let lastError;
  for (let attempt = 0; attempt < AMBIGUITY_REPAIR_ATTEMPTS; attempt++) {
    try {
      const response = await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName(),
          Key: { lockKey: { S: LOCK_KEY } },
          ConditionExpression: "lockId = :lockId AND released = :false",
          UpdateExpression: "SET protocolVersion = :protocol",
          ExpressionAttributeValues: {
            ":lockId": { S: lockId },
            ":false": { BOOL: false },
            ":protocol": { S: PROTOCOL_VERSION },
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
  if (lastError && typeof lastError === "object") lastError.retainLegacyBridge = true;
  throw lastError;
}

function isMatchingReleasedItem(item, lockId, fencingToken) {
  return item?.released?.BOOL === true && item.lockId?.S === lockId && Number(item.fencingToken?.N) === fencingToken;
}

async function acquireDynamoLifecycleLock(legacyLock) {
  const now = Date.now();
  const expiresAt = Date.parse(legacyLock.expiresAt);
  try {
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: LOCK_KEY } },
        ConditionExpression: "attribute_not_exists(lockId) OR released = :true OR leaseExpiresAt < :now",
        UpdateExpression:
          "SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, released = :false, protocolVersion = :protocol, fencingToken = if_not_exists(fencingToken, :zero) + :one REMOVE ttlEpochSeconds",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: {
          ":lockId": { S: legacyLock.lockId },
          ":action": { S: legacyLock.action },
          ":ownerEmail": { S: legacyLock.ownerEmail },
          ":createdAt": { S: legacyLock.createdAt },
          ":lease": { N: String(expiresAt) },
          ":protocol": { S: PROTOCOL_VERSION },
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
    const lock = parseLockItem(response.Attributes);
    if (!lock) throw new Error("DynamoDB returned an invalid lifecycle lock record");
    return lock;
  } catch (error) {
    const reconciled = await getCurrentLifecycleLock().catch(() => null);
    if (reconciled?.lockId === legacyLock.lockId) return reconciled;
    if (!isConditionalFailure(error)) {
      const repaired = await reconcileAmbiguousAcquisition(legacyLock.lockId);
      if (repaired?.lockId === legacyLock.lockId) return repaired;
      throw error;
    }
    throw new LifecycleLockConflictError(parseLockItem(error.Item) ?? reconciled);
  }
}

async function acquireLifecycleLock(action, ownerEmail) {
  if (!ACTIONS.has(action)) throw new Error(`Unsupported lifecycle lock action: ${action}`);
  await assertBridgeMetadata();
  const legacyLock = await acquireLegacyBridgeLock(action, ownerEmail);
  try {
    return await acquireDynamoLifecycleLock(legacyLock);
  } catch (error) {
    if (error?.retainLegacyBridge !== true) {
      await releaseLegacyBridgeLockWithRetry(legacyLock.lockId).catch(() =>
        console.error("Failed to compensate legacy lifecycle bridge lock")
      );
    }
    throw error;
  }
}

async function bridgeLegacyLifecycleLock(lockId, action, ownerEmail) {
  await assertBridgeMetadata();
  const legacyLock = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
  if (
    !legacyLock ||
    legacyLock.lockId !== lockId ||
    legacyLock.action !== action ||
    legacyLock.ownerEmail.trim().toLowerCase() !== ownerEmail.trim().toLowerCase() ||
    Date.parse(legacyLock.expiresAt) <= Date.now()
  ) {
    throw new LifecycleLockConflictError(null);
  }
  const existing = await getCurrentLifecycleLock();
  if (existing?.lockId === lockId && existing.action === action && existing.ownerEmail === legacyLock.ownerEmail) {
    return existing;
  }
  return await acquireDynamoLifecycleLock(legacyLock);
}

async function assertLifecycleLockOwned(lockId, fencingToken, action) {
  await assertBridgeMetadata();
  const legacy = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
  const current = await getCurrentLifecycleLock();
  if (!current || current.lockId !== lockId || current.fencingToken !== fencingToken || current.action !== action) {
    throw new LifecycleLockConflictError(current);
  }
  if (!legacy) {
    try {
      await putParameter(
        LEGACY_LOCK_PARAMETER,
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
      if (!isParameterAlreadyExists(error)) throw error;
    }
  } else if (legacy.lockId !== lockId || legacy.action !== action) {
    throw new LifecycleLockConflictError(current);
  }
  return current;
}

async function renewLifecycleLock(lockId, fencingToken) {
  await assertBridgeMetadata();
  const now = Date.now();
  const expiresAt = now + LOCK_LEASE_MS;
  const legacy = parseLegacyLock(await getParameter(LEGACY_LOCK_PARAMETER));
  if (!legacy || legacy.lockId !== lockId || Date.parse(legacy.expiresAt) < now) {
    throw new LifecycleLockConflictError(await getCurrentLifecycleLock());
  }
  await putParameter(
    LEGACY_LOCK_PARAMETER,
    JSON.stringify({ ...legacy, expiresAt: new Date(expiresAt).toISOString() }),
    "String",
    true
  );
  try {
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: LOCK_KEY } },
        ConditionExpression:
          "lockId = :lockId AND fencingToken = :token AND released = :false AND leaseExpiresAt >= :now",
        UpdateExpression: "SET leaseExpiresAt = :lease REMOVE ttlEpochSeconds",
        ExpressionAttributeValues: {
          ":lockId": { S: lockId },
          ":token": { N: String(fencingToken) },
          ":false": { BOOL: false },
          ":now": { N: String(now) },
          ":lease": { N: String(expiresAt) },
        },
        ReturnValues: "ALL_NEW",
      })
    );
    const lock = parseLockItem(response.Attributes);
    if (!lock) throw new Error("DynamoDB returned an invalid renewed lifecycle lock record");
    return lock;
  } catch (error) {
    if (isConditionalFailure(error)) throw new LifecycleLockConflictError(await getCurrentLifecycleLock());
    throw error;
  }
}

async function releaseLifecycleLock(lockId, fencingToken, action, ownerEmail) {
  if (!Number.isSafeInteger(fencingToken)) return false;
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: LOCK_KEY } },
        ConditionExpression:
          "lockId = :lockId AND fencingToken = :token AND #action = :action AND ownerEmail = :ownerEmail AND released = :false",
        UpdateExpression: "SET released = :true REMOVE ttlEpochSeconds",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: {
          ":lockId": { S: lockId },
          ":token": { N: String(fencingToken) },
          ":action": { S: action },
          ":ownerEmail": { S: ownerEmail.trim().toLowerCase() },
          ":false": { BOOL: false },
          ":true": { BOOL: true },
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
    if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
      throw new Error("Lifecycle lock release committed but bridge cleanup did not converge");
    }
    return true;
  } catch (error) {
    const currentItem = error?.Item ?? (await getCurrentLifecycleLockItem().catch(() => undefined));
    if (isMatchingReleasedItem(currentItem, lockId, fencingToken)) {
      if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
        throw new Error("Lifecycle lock release reconciliation could not clean the bridge");
      }
      return true;
    }
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

export {
  LifecycleLockConflictError,
  acquireLifecycleLock,
  bridgeLegacyLifecycleLock,
  assertLifecycleLockOwned,
  getCurrentLifecycleLock,
  releaseLifecycleLock,
  renewLifecycleLock,
};
