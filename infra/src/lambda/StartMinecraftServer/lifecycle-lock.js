import { randomUUID } from "node:crypto";
import { GetItemCommand, UpdateItemCommand, dynamodb } from "./clients.js";

const LOCK_KEY = "minecraft-server-lifecycle";
const PROTOCOL_METADATA_KEY = "protocol#dual-v1";
const PROTOCOL_VERSION = "dual-v1";
const LOCK_LEASE_MS = 90 * 60 * 1000;
const AMBIGUITY_REPAIR_ATTEMPTS = 3;
// `destroy` is an operator-owned, non-expiring barrier. Lambda never acquires
// it, but must parse it as active authority so delayed lifecycle deliveries
// cannot treat the lock record as malformed or absent.
const ACTIONS = new Set(["start", "stop", "resume", "hibernate", "backup", "restore", "allowlist", "destroy"]);
const ACQUIRABLE_ACTIONS = new Set(["start", "stop", "resume", "hibernate", "backup", "restore", "allowlist"]);

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

function parseLockItem(item) {
  if (!item || item.released?.BOOL === true) return null;
  const lockId = item.lockId?.S;
  const action = item.action?.S;
  const ownerEmail = item.ownerEmail?.S;
  const createdAt = item.createdAt?.S;
  const leaseExpiresAt = Number(item.leaseExpiresAt?.N ?? Number.NaN);
  const fencingToken = Number(item.fencingToken?.N ?? Number.NaN);
  const leaseGeneration = Number(item.leaseGeneration?.N ?? "1");
  const agentFenceActive = item.agentFenceActive?.BOOL === true;
  if (
    !lockId ||
    !ACTIONS.has(action) ||
    !ownerEmail ||
    !createdAt ||
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
    operationId: item.operationId?.S,
    operationOwnerId: item.operationOwnerId?.S,
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

async function acquireLegacyBridgeLock(action, ownerEmail) {
  const now = Date.now();
  // SSM has no conditional mutation. This is only a candidate for the
  // authoritative DynamoDB conditional write; never bootstrap a legacy mirror
  // before ownership exists.
  return {
    lockId: randomUUID(),
    action,
    ownerEmail: ownerEmail.trim().toLowerCase(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOCK_LEASE_MS).toISOString(),
    leaseGeneration: 1,
    agentFenceActive: false,
    claimToken: randomUUID(),
  };
}

async function releaseLegacyBridgeLock(lockId) {
  void lockId;
  return true;
}

async function releaseLegacyBridgeLockWithRetry(lockId) {
  return releaseLegacyBridgeLock(lockId);
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
  return lock && (lock.agentFenceActive || Date.parse(lock.expiresAt) > Date.now()) ? lock : null;
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
        ConditionExpression:
          "attribute_not_exists(lockId) OR released = :true OR (leaseExpiresAt < :now AND (attribute_not_exists(agentFenceActive) OR agentFenceActive = :false))",
        UpdateExpression:
          "SET lockId = :lockId, #action = :action, ownerEmail = :ownerEmail, createdAt = :createdAt, leaseExpiresAt = :lease, leaseGeneration = :leaseGeneration, agentFenceActive = :false, released = :false, protocolVersion = :protocol, fencingToken = if_not_exists(fencingToken, :zero) + :one REMOVE ttlEpochSeconds",
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
          ":leaseGeneration": { N: "1" },
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
  if (!ACQUIRABLE_ACTIONS.has(action)) throw new Error(`Unsupported lifecycle lock action: ${action}`);
  await assertBridgeMetadata();
  const legacyLock = await acquireLegacyBridgeLock(action, ownerEmail);
  try {
    return await acquireDynamoLifecycleLock(legacyLock);
  } catch (error) {
    if (error?.retainLegacyBridge !== true) {
      await releaseLegacyBridgeLockWithRetry(legacyLock.lockId).catch(() =>
        console.error("Failed to reconcile lifecycle acquisition after an ambiguous DynamoDB result")
      );
    }
    throw error;
  }
}

async function bridgeLegacyLifecycleLock(lockId, action, ownerEmail) {
  await assertBridgeMetadata();
  const existing = await getCurrentLifecycleLock();
  if (
    existing?.lockId === lockId &&
    existing.action === action &&
    existing.ownerEmail === ownerEmail.trim().toLowerCase()
  ) {
    return existing;
  }
  // Legacy-first bootstrap is intentionally removed. An old payload without
  // an authoritative DynamoDB owner/version cannot be adopted safely.
  throw new LifecycleLockConflictError(existing);
}

async function assertLifecycleLockOwned(lockId, fencingToken, action) {
  await assertBridgeMetadata();
  const current = await getCurrentLifecycleLock();
  if (!current || current.lockId !== lockId || current.fencingToken !== fencingToken || current.action !== action) {
    throw new LifecycleLockConflictError(current);
  }
  return current;
}

async function renewLifecycleLock(lockId, fencingToken, options = {}) {
  await assertBridgeMetadata();
  const now = Date.now();
  const expiresAt = now + LOCK_LEASE_MS;
  const current = await getCurrentLifecycleLock();
  const expectedLeaseGeneration = options.expectedLeaseGeneration ?? current?.leaseGeneration;
  if (
    !current ||
    current.lockId !== lockId ||
    current.fencingToken !== fencingToken ||
    !Number.isSafeInteger(expectedLeaseGeneration) ||
    expectedLeaseGeneration < 1 ||
    current.leaseGeneration !== expectedLeaseGeneration ||
    (!current.agentFenceActive && Date.parse(current.expiresAt) < now)
  ) {
    throw new LifecycleLockConflictError(await getCurrentLifecycleLock());
  }
  try {
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: LOCK_KEY } },
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
          ":lease": { N: String(expiresAt) },
          ":generation": { N: String(expectedLeaseGeneration) },
          ":nextGeneration": { N: String(expectedLeaseGeneration + 1) },
          ":true": { BOOL: true },
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

/** Release only the exact current lease; agent fences require durable terminal proof. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conditional release identity is one auditable boundary.
async function releaseLifecycleLock(lockId, fencingToken, action, ownerEmail, options = {}) {
  if (!Number.isSafeInteger(fencingToken)) return false;
  try {
    const conditions = [
      "lockId = :lockId",
      "fencingToken = :token",
      "#action = :action",
      "ownerEmail = :ownerEmail",
      "released = :false",
    ];
    const values = {
      ":lockId": { S: lockId },
      ":token": { N: String(fencingToken) },
      ":action": { S: action },
      ":ownerEmail": { S: ownerEmail.trim().toLowerCase() },
      ":false": { BOOL: false },
      ":true": { BOOL: true },
    };
    if (options.expectedLeaseGeneration !== undefined) {
      if (!Number.isSafeInteger(options.expectedLeaseGeneration) || options.expectedLeaseGeneration < 1) return false;
      conditions.push("leaseGeneration = :generation");
      values[":generation"] = { N: String(options.expectedLeaseGeneration) };
    }
    if (options.requireAgentFenceActive === true) {
      if (!options.operationId || !options.operationOwnerId) return false;
      conditions.push(
        "agentFenceActive = :agentFenceActive",
        "operationId = :operationId",
        "operationOwnerId = :operationOwnerId"
      );
      values[":agentFenceActive"] = { BOOL: true };
      values[":operationId"] = { S: options.operationId };
      values[":operationOwnerId"] = { S: options.operationOwnerId };
    }
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { lockKey: { S: LOCK_KEY } },
        ConditionExpression: conditions.join(" AND "),
        UpdateExpression: "SET released = :true REMOVE ttlEpochSeconds",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: values,
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
    if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
      throw new Error("Lifecycle lock release committed but reconciliation did not converge");
    }
    return true;
  } catch (error) {
    const currentItem = error?.Item ?? (await getCurrentLifecycleLockItem().catch(() => undefined));
    if (isMatchingReleasedItem(currentItem, lockId, fencingToken)) {
      if (!(await releaseLegacyBridgeLockWithRetry(lockId))) {
        throw new Error("Lifecycle lock release reconciliation did not converge");
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
