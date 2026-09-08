import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const dynamodb = new DynamoDBClient({});
const RECOVERY_LOCK_PARAMETER = "/minecraft/backup-recovery-adoption-lock";
const STACK_CLAIM_PARAMETER = "/minecraft/stack-ownership-claim";
const RECOVERY_SCHEMA_VERSION = 3;
const MIGRATION_LOCK_KEY = "mc-aws-backup-recovery-migration";
const localMigrationLocks = new Set();

function retainedParameterSpec(properties) {
  const parameterName = properties.ParameterName;
  if (typeof parameterName !== "string" || !parameterName.startsWith("/minecraft/")) {
    throw new Error("RETAINED_PARAMETER_NAME_INVALID");
  }
  const parameterType = properties.ParameterType || "SecureString";
  if (parameterType !== "SecureString" && parameterType !== "String") {
    throw new Error("RETAINED_PARAMETER_TYPE_INVALID");
  }
  const initialValue = properties.InitialValue;
  if (parameterType === "String" && initialValue !== "UNINITIALIZED") {
    throw new Error("RETAINED_PARAMETER_INITIAL_VALUE_INVALID");
  }
  if (parameterType === "SecureString" && initialValue !== undefined) {
    throw new Error("SECURE_PARAMETER_INITIAL_VALUE_FORBIDDEN");
  }
  return { parameterName, parameterType, initialValue };
}

async function verifyExisting(parameterName, parameterType) {
  const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
  if (response.Parameter?.Type !== parameterType) throw new Error("RETAINED_PARAMETER_TYPE_INVALID");
}

function stackClaimProperties(properties) {
  const claimToken = properties.ClaimToken;
  if (!/^[a-f0-9-]{36}$/.test(claimToken || "")) throw new Error("STACK_CLAIM_TOKEN_INVALID");
  const parameterName = properties.ClaimParameter || STACK_CLAIM_PARAMETER;
  if (parameterName !== STACK_CLAIM_PARAMETER) throw new Error("STACK_CLAIM_PARAMETER_INVALID");
  return { claimToken, parameterName };
}

async function readOptionalValue(parameterName) {
  try {
    return await readValue(parameterName);
  } catch (error) {
    if (error?.name === "ParameterNotFound") return undefined;
    throw new Error("STACK_CLAIM_READ_FAILED");
  }
}

async function createStackClaim(parameterName, claimToken) {
  try {
    await ssm.send(
      new PutParameterCommand({ Name: parameterName, Type: "String", Value: claimToken, Overwrite: false })
    );
  } catch (error) {
    if (error?.name !== "ParameterAlreadyExists") throw new Error("STACK_CLAIM_CREATE_FAILED");
  }
}

async function claimStackOwnership(properties) {
  const { claimToken, parameterName } = stackClaimProperties(properties);
  const existing = await readOptionalValue(parameterName);
  if (existing && (existing.type !== "String" || existing.value !== claimToken)) {
    throw new Error("STACK_CLAIM_CONFLICT");
  }
  if (!existing) await createStackClaim(parameterName, claimToken);
  const committed = await readValue(parameterName);
  if (committed.type !== "String" || committed.value !== claimToken) throw new Error("STACK_CLAIM_CONFLICT");
}

async function releaseStackOwnership(properties) {
  const parameterName = properties.ClaimParameter || STACK_CLAIM_PARAMETER;
  if (parameterName !== STACK_CLAIM_PARAMETER) throw new Error("STACK_CLAIM_PARAMETER_INVALID");
  const claimToken = properties.ClaimToken;
  if (!/^[a-f0-9-]{36}$/.test(claimToken || "")) return;
  const current = await readValue(parameterName).catch((error) => {
    if (error?.name === "ParameterNotFound") return undefined;
    throw error;
  });
  // SSM has no conditional delete. Ownership claims are retained as durable
  // evidence; a future authoritative CAS backend may expire them safely.
  void current;
}

async function readValue(parameterName, withDecryption = false) {
  const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: withDecryption }));
  if (!response.Parameter?.Value) throw new Error("RECOVERY_PARAMETER_EMPTY");
  return {
    value: response.Parameter.Value,
    type: response.Parameter.Type,
    version: response.Parameter.Version,
  };
}

async function putParameterCas(parameterName, parameterType, value, expected) {
  const before = await readValue(parameterName);
  if (before.type !== parameterType || before.version !== expected.version) {
    throw new Error("RECOVERY_STATE_CHANGED_BEFORE_WRITE");
  }
  const response = await ssm.send(
    new PutParameterCommand({ Name: parameterName, Type: parameterType, Value: value, Overwrite: true })
  );
  const after = await readValue(parameterName);
  if (after.type !== parameterType || after.value !== value || after.version === expected.version) {
    throw new Error("RECOVERY_STATE_CHANGED_DURING_WRITE");
  }
  if (Number.isSafeInteger(response?.Version) && response.Version !== after.version) {
    throw new Error("RECOVERY_STATE_VERSION_MISMATCH");
  }
  return after;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    );
  return value;
}

function canonicalString(value) {
  return JSON.stringify(canonical(value));
}

function assertRecoveryKeyring(raw, properties) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RECOVERY_KEYRING_INVALID");
  }
  if (JSON.stringify(canonical(value)) !== raw) throw new Error("RECOVERY_KEYRING_NOT_CANONICAL");
  if (value.schemaVersion !== 1 || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8)
    throw new Error("RECOVERY_KEYRING_INVALID");
  const ids = value.keys.map((entry) => entry?.keyId);
  if (
    value.keys.some(
      (entry) => !entry || !entry.keyId || !entry.secretBase64 || !["active", "verify-only"].includes(entry.status)
    ) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("RECOVERY_KEYRING_INVALID");
  if (JSON.stringify(ids) !== JSON.stringify(properties.ExpectedKeyIds || []))
    throw new Error("RECOVERY_KEYRING_KEY_IDS_MISMATCH");
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== properties.ExpectedKeyringSha256) throw new Error("RECOVERY_KEYRING_DIGEST_MISMATCH");
  const keys = new Map();
  for (const entry of value.keys) {
    const material = Buffer.from(entry.secretBase64, "base64");
    if (material.length < 32 || material.length > 64 || material.toString("base64") !== entry.secretBase64)
      throw new Error("RECOVERY_KEYRING_INVALID");
    keys.set(entry.keyId, material);
  }
  if (
    value.keys.filter((entry) => entry.status === "active").length !== 1 ||
    value.keys.find((entry) => entry.keyId === value.currentKeyId)?.status !== "active"
  )
    throw new Error("RECOVERY_KEYRING_INVALID");
  return keys;
}

function verifyRecoveryState(raw, kind, serverId, keys) {
  if (raw === "UNINITIALIZED") return 0;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`RECOVERY_${kind}_INVALID`);
  }
  if (canonicalString(value) !== raw) throw new Error(`RECOVERY_${kind}_NOT_CANONICAL`);
  if (
    Object.keys(value).sort().join(",") !== "authentication,format,schemaVersion,source,state" ||
    Object.keys(value.source || {})
      .sort()
      .join(",") !== "serverId" ||
    Object.keys(value.state || {})
      .sort()
      .join(",") !== "backupId,generation,kind,updatedAt" ||
    Object.keys(value.authentication || {})
      .sort()
      .join(",") !== "algorithm,keyId,tag"
  )
    throw new Error(`RECOVERY_${kind}_INVALID`);
  const state = value?.state;
  const auth = value?.authentication;
  if (
    value?.format !== "mc-aws-backup-state" ||
    value?.schemaVersion !== RECOVERY_SCHEMA_VERSION ||
    value?.source?.serverId !== serverId ||
    state?.kind !== kind ||
    !Number.isSafeInteger(state?.generation) ||
    state.generation < 1 ||
    !/^[a-f0-9]{32}$/.test(state.backupId) ||
    auth?.algorithm !== "HMAC-SHA256" ||
    typeof auth.keyId !== "string" ||
    !/^[a-f0-9]{64}$/.test(auth.tag)
  )
    throw new Error(`RECOVERY_${kind}_INVALID`);
  const key = keys.get(auth.keyId);
  if (!key) throw new Error(`RECOVERY_${kind}_KEY_MISSING`);
  const payload = {
    format: value.format,
    schemaVersion: value.schemaVersion,
    source: value.source,
    state: value.state,
  };
  const expected = createHmac("sha256", key).update(canonicalString(payload)).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(auth.tag))) throw new Error(`RECOVERY_${kind}_AUTH_FAILED`);
  return state.generation;
}

function assertRecoveryVerifier(raw, properties) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RECOVERY_VERIFIER_METADATA_INVALID");
  }
  if (
    canonicalString(value) !== raw ||
    Object.keys(value).sort().join(",") !==
      "algorithm,keyIds,manifestFormat,manifestSchemaVersion,stateFormat,stateSchemaVersion" ||
    value.algorithm !== "HMAC-SHA256" ||
    value.manifestFormat !== "mc-aws-drive-backup" ||
    value.manifestSchemaVersion !== RECOVERY_SCHEMA_VERSION ||
    value.stateFormat !== "mc-aws-backup-state" ||
    value.stateSchemaVersion !== RECOVERY_SCHEMA_VERSION ||
    JSON.stringify(value.keyIds) !== JSON.stringify(properties.ExpectedKeyIds || [])
  ) {
    throw new Error("RECOVERY_VERIFIER_METADATA_INVALID");
  }
}

function assertRecoveryLock(raw, properties) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RECOVERY_LOCK_INVALID");
  }
  const scope = value?.scope;
  if (
    canonicalString(value) !== raw ||
    Object.keys(value).sort().join(",") !==
      "capsuleDigest,checkpointGeneration,floorGeneration,format,keyIds,schemaVersion,scope,serverId" ||
    Object.keys(scope || {})
      .sort()
      .join(",") !== "account,region,stack" ||
    value.format !== "mc-aws-recovery-adoption-lock" ||
    value.schemaVersion !== RECOVERY_SCHEMA_VERSION ||
    scope.account !== properties.ExpectedAccountId ||
    scope.region !== properties.ExpectedRegion ||
    scope.stack !== properties.ExpectedStackName ||
    !/^[a-f0-9]{64}$/.test(value.capsuleDigest) ||
    value.capsuleDigest !== properties.ExpectedCapsuleDigest ||
    value.serverId !== properties.ExpectedServerIdentity ||
    value.checkpointGeneration !== Number(properties.ExpectedCheckpointGeneration) ||
    value.floorGeneration !== Number(properties.ExpectedRestoreFloorGeneration) ||
    JSON.stringify(value.keyIds) !== JSON.stringify(properties.ExpectedKeyIds || [])
  ) {
    throw new Error("RECOVERY_LOCK_INVALID");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authenticated state verification is one fail-closed boundary.
async function adoptRecoveryCapsuleState(properties) {
  const lockParameter = properties.RecoveryLockParameter || RECOVERY_LOCK_PARAMETER;
  const lockRecord = await readValue(lockParameter);
  if (lockRecord.type !== "String") throw new Error("RECOVERY_LOCK_TYPE_INVALID");
  assertRecoveryLock(lockRecord.value, properties);
  const keyringRecord = await readValue("/minecraft/backup-auth-keyring", true);
  if (keyringRecord.type !== "SecureString") throw new Error("RECOVERY_KEYRING_TYPE_INVALID");
  const keyring = keyringRecord.value;
  const keys = assertRecoveryKeyring(keyring, properties);
  const serverRecord = await readValue("/minecraft/backup-server-identity");
  if (serverRecord.type !== "String") throw new Error("RECOVERY_SERVER_IDENTITY_TYPE_INVALID");
  const serverIdentity = serverRecord.value;
  if (serverIdentity !== properties.ExpectedServerIdentity) throw new Error("RECOVERY_SERVER_IDENTITY_MISMATCH");
  let verifierRecord = await readValue("/minecraft/backup-verifier-metadata");
  if (verifierRecord.type !== "String") throw new Error("RECOVERY_VERIFIER_METADATA_TYPE_INVALID");
  let verifier = verifierRecord.value;
  if (verifier === "UNINITIALIZED") {
    if (typeof properties.ExpectedVerifierMetadata !== "string" || !properties.ExpectedVerifierMetadata) {
      throw new Error("RECOVERY_VERIFIER_METADATA_UNINITIALIZED");
    }
    assertRecoveryVerifier(properties.ExpectedVerifierMetadata, properties);
    await putParameterCas(
      "/minecraft/backup-verifier-metadata",
      "String",
      properties.ExpectedVerifierMetadata,
      verifierRecord
    );
    const lockAfterVerifierWrite = await readValue(lockParameter);
    if (
      lockAfterVerifierWrite.value !== lockRecord.value ||
      (lockRecord.version !== undefined && lockAfterVerifierWrite.version !== lockRecord.version)
    ) {
      throw new Error("RECOVERY_STATE_CHANGED_DURING_VERIFICATION");
    }
    verifierRecord = await readValue("/minecraft/backup-verifier-metadata");
    verifier = verifierRecord.value;
  }
  assertRecoveryVerifier(verifier, properties);
  if (createHash("sha256").update(verifier).digest("hex") !== properties.ExpectedVerifierSha256)
    throw new Error("RECOVERY_VERIFIER_METADATA_MISMATCH");
  const checkpointRecord = await readValue("/minecraft/backup-generation-checkpoint");
  const floorRecord = await readValue("/minecraft/restore-generation-floor");
  if (checkpointRecord.type !== "String" || floorRecord.type !== "String")
    throw new Error("RECOVERY_STATE_TYPE_INVALID");
  const checkpoint = checkpointRecord.value;
  const floor = floorRecord.value;
  const checkpointGeneration = verifyRecoveryState(checkpoint, "backup-generation", serverIdentity, keys);
  const floorGeneration = verifyRecoveryState(floor, "restore-floor", serverIdentity, keys);
  if (
    checkpointGeneration < Number(properties.ExpectedCheckpointGeneration) ||
    floorGeneration < Number(properties.ExpectedRestoreFloorGeneration)
  )
    throw new Error("RECOVERY_GENERATION_ROLLBACK");
  if (floorGeneration > checkpointGeneration) throw new Error("RECOVERY_FLOOR_EXCEEDS_CHECKPOINT");

  const expectedCheckpointGeneration = Number(properties.ExpectedCheckpointGeneration);
  const expectedFloorGeneration = Number(properties.ExpectedRestoreFloorGeneration);
  if (checkpointGeneration === expectedCheckpointGeneration && properties.ExpectedCheckpointBackupId) {
    const current = JSON.parse(checkpoint).state.backupId;
    if (current !== properties.ExpectedCheckpointBackupId) throw new Error("RECOVERY_CHECKPOINT_CONFLICT");
  }
  if (floorGeneration === expectedFloorGeneration && properties.ExpectedRestoreFloorBackupId) {
    const current = JSON.parse(floor).state.backupId;
    if (current !== properties.ExpectedRestoreFloorBackupId) throw new Error("RECOVERY_FLOOR_CONFLICT");
  }

  // SSM GetParameter is strongly consistent. Read the complete set again and
  // compare versions so a bypassing writer cannot make this verification claim
  // a state that was only partially observed.
  const reread = await Promise.all([
    readValue(lockParameter),
    readValue("/minecraft/backup-auth-keyring", true),
    readValue("/minecraft/backup-server-identity"),
    readValue("/minecraft/backup-verifier-metadata"),
    readValue("/minecraft/backup-generation-checkpoint"),
    readValue("/minecraft/restore-generation-floor"),
  ]);
  const first = [lockRecord, keyringRecord, serverRecord, verifierRecord, checkpointRecord, floorRecord];
  assertRecoveryLock(reread[0].value, properties);
  if (first.some((record, index) => record.version !== undefined && reread[index].version !== record.version))
    throw new Error("RECOVERY_STATE_CHANGED_DURING_VERIFICATION");
}

async function withMigrationLock(callback) {
  const value = JSON.stringify({
    format: "mc-aws-backup-recovery-migration-lock",
    operation: "custom-resource",
    owner: randomUUID(),
    schemaVersion: 1,
  });
  const tableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!tableName && process.env.VITEST !== "true" && process.env.NODE_ENV !== "test")
    throw new Error("MIGRATION_LOCK_AUTHORITY_UNAVAILABLE");
  if (tableName) {
    try {
      await dynamodb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            operationId: { S: MIGRATION_LOCK_KEY },
            lockOwner: { S: value },
            leaseExpiresAt: { N: String(Math.floor(Date.now() / 1000) + 900) },
          },
          ConditionExpression: "attribute_not_exists(operationId) OR leaseExpiresAt < :now",
          ExpressionAttributeValues: { ":now": { N: String(Math.floor(Date.now() / 1000)) } },
        })
      );
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new Error("MIGRATION_LOCK_BUSY");
      throw error;
    }
  } else {
    if (localMigrationLocks.has(MIGRATION_LOCK_KEY)) throw new Error("MIGRATION_LOCK_BUSY");
    localMigrationLocks.add(MIGRATION_LOCK_KEY);
  }
  try {
    const result = await callback();
    return result;
  } finally {
    if (tableName) {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { operationId: { S: MIGRATION_LOCK_KEY } },
          UpdateExpression: "SET leaseExpiresAt = :expired",
          ConditionExpression: "lockOwner = :owner",
          ExpressionAttributeValues: { ":expired": { N: "0" }, ":owner": { S: value } },
        })
      );
    } else localMigrationLocks.delete(MIGRATION_LOCK_KEY);
  }
}

async function retainParameter({ parameterName, parameterType, initialValue }) {
  try {
    await verifyExisting(parameterName, parameterType);
    return;
  } catch (error) {
    if (error?.message === "RETAINED_PARAMETER_TYPE_INVALID") throw error;
    if (error?.name !== "ParameterNotFound") throw new Error("RETAINED_PARAMETER_CHECK_FAILED");
  }
  if (parameterType === "SecureString") throw new Error("SECURE_PARAMETER_NOT_FOUND");
  await withMigrationLock(async () => {
    try {
      await verifyExisting(parameterName, parameterType);
      return;
    } catch (error) {
      if (error?.name !== "ParameterNotFound") throw new Error("RETAINED_PARAMETER_CHECK_FAILED");
    }
    try {
      await ssm.send(
        new PutParameterCommand({ Name: parameterName, Type: "String", Value: initialValue, Overwrite: false })
      );
    } catch (error) {
      if (error?.name !== "ParameterAlreadyExists") throw new Error("RETAINED_PARAMETER_CREATE_FAILED");
      await verifyExisting(parameterName, parameterType);
    }
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this callback is the fail-closed custom-resource transaction boundary.
async function processEvent(event) {
  const properties = event.ResourceProperties || event.OldResourceProperties || {};
  const parameterName = properties.ParameterName;
  const physicalResourceId = event.PhysicalResourceId || parameterName;
  if (properties.StackOwnershipClaim === "true") {
    if (event.RequestType === "Delete") await releaseStackOwnership(properties);
    else await claimStackOwnership(properties);
    return { PhysicalResourceId: physicalResourceId || STACK_CLAIM_PARAMETER };
  }
  if (event.RequestType === "Delete") {
    // Deliberately retained. The teardown workflow owns confidential-data scrubbing,
    // and replacement/delete callbacks must never remove a credential still in use.
    return { PhysicalResourceId: physicalResourceId };
  }
  if (properties.RecoveryCapsuleAdoption === "true") {
    await withMigrationLock(() => adoptRecoveryCapsuleState(properties));
    console.log("[RECOVERY_CAPSULE] authenticated state verified; secret material omitted");
    return { PhysicalResourceId: physicalResourceId };
  }
  if (properties.ExpectedValue !== undefined) {
    if (
      properties.ParameterType !== "String" ||
      typeof properties.ExpectedValue !== "string" ||
      properties.InitialValue !== "UNINITIALIZED"
    )
      throw new Error("EXPECTED_VALUE_INVALID");
    try {
      const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
      if (response.Parameter?.Type !== "String" || response.Parameter?.Value !== properties.ExpectedValue)
        throw new Error("EXPECTED_VALUE_MISMATCH");
    } catch (error) {
      if (error?.name !== "ParameterNotFound") throw error;
      await ssm.send(
        new PutParameterCommand({
          Name: parameterName,
          Type: "String",
          Value: properties.ExpectedValue,
          Overwrite: false,
        })
      );
    }
    return { PhysicalResourceId: physicalResourceId };
  }
  await retainParameter(retainedParameterSpec(properties));
  console.log("[RETAINED_PARAMETER] Existing parameter retained or missing mutable state initialized");
  return { PhysicalResourceId: physicalResourceId };
}

async function sendCloudFormationResponse(event, context, status, physicalResourceId) {
  const body = JSON.stringify({
    Status: status,
    Reason: status === "SUCCESS" ? "Retained parameter verified" : "Retained parameter verification failed",
    PhysicalResourceId: physicalResourceId || context?.logStreamName || "dns-secure-string-adoption",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: true,
  });
  const response = await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  if (!response.ok) throw new Error("CLOUDFORMATION_RESPONSE_FAILED");
}

export const handler = async (event, context) => {
  try {
    const result = await processEvent(event);
    if (event.ResponseURL) await sendCloudFormationResponse(event, context, "SUCCESS", result.PhysicalResourceId);
    return result;
  } catch (error) {
    if (!event.ResponseURL) throw error;
    await sendCloudFormationResponse(event, context, "FAILED", event.PhysicalResourceId);
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
};

export { processEvent, sendCloudFormationResponse };
