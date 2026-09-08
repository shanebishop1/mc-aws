#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const KEYRING_PARAMETER = "/minecraft/backup-auth-keyring";
const SERVER_PARAMETER = "/minecraft/backup-server-identity";
const CHECKPOINT_PARAMETER = "/minecraft/backup-generation-checkpoint";
const FLOOR_PARAMETER = "/minecraft/restore-generation-floor";
const VERIFIER_PARAMETER = "/minecraft/backup-verifier-metadata";
export const RECOVERY_LOCK_PARAMETER = "/minecraft/backup-recovery-adoption-lock";
export const RECOVERY_MIGRATION_LOCK_PARAMETER = "/minecraft/backup-recovery-migration-lock";
const CURRENT_SCHEMA_VERSION = 3;
const migrationLockKey = "mc-aws-backup-recovery-migration";
const localMigrationLocks = new Set<string>();
const dynamodb = new DynamoDBClient({});
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVER_ID =
  /^arn:aws(?:-[a-z]+)?:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[A-Za-z0-9-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

type Key = { keyId: string; secretBase64: string; status: "active" | "verify-only" };
type Keyring = { schemaVersion: 1; currentKeyId: string; keys: Key[] };
type State = {
  format: "mc-aws-backup-state";
  schemaVersion: 3;
  source: { serverId: string };
  state: { backupId: string; generation: number; kind: "backup-generation" | "restore-floor"; updatedAt: string };
  authentication: { algorithm: "HMAC-SHA256"; keyId: string; tag: string };
};

const fail = (message: string): never => {
  throw new Error(`Recovery capsule adoption failed: ${message}`);
};

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }
  return value;
};

const canonical = (value: unknown): string => JSON.stringify(sortValue(value));

// biome-ignore lint/suspicious/noExplicitAny: the strict schema boundary narrows fields incrementally below.
const exactKeys = (value: unknown, keys: string[], label: string): Record<string, any> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  ) {
    fail(`${label} schema is invalid`);
  }
  // biome-ignore lint/suspicious/noExplicitAny: the validated object remains dynamically shaped by schema version.
  return value as Record<string, any>;
};

// biome-ignore lint/suspicious/noExplicitAny: JSON is narrowed by exactKeys immediately after parsing.
const parseStrict = (raw: string, label: string): any => {
  // biome-ignore lint/suspicious/noExplicitAny: JSON.parse is narrowed by the canonical/schema checks below.
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is not JSON`);
  }
  if (raw !== `${canonical(value)}\n` && raw !== canonical(value)) fail(`${label} is not strict canonical JSON`);
  return value;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the authenticated keyring boundary.
const decodeKeyring = (value: unknown): { keyring: Keyring; keys: Map<string, Buffer> } => {
  const object = exactKeys(value, ["currentKeyId", "keys", "schemaVersion"], "keyring");
  if (object.schemaVersion !== 1 || typeof object.currentKeyId !== "string" || !KEY_ID.test(object.currentKeyId))
    fail("keyring identity is invalid");
  if (!Array.isArray(object.keys) || object.keys.length < 1 || object.keys.length > 8) fail("keyring keys are invalid");
  const keys = new Map<string, Buffer>();
  let active = 0;
  for (const item of object.keys) {
    const entry = exactKeys(item, ["keyId", "secretBase64", "status"], "keyring entry");
    if (typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId) || keys.has(entry.keyId))
      fail("keyring key ID is invalid or duplicated");
    if (entry.status !== "active" && entry.status !== "verify-only") fail("keyring status is invalid");
    if (typeof entry.secretBase64 !== "string") fail("keyring material is invalid");
    const material = Buffer.from(entry.secretBase64, "base64");
    if (material.length < 32 || material.length > 64 || material.toString("base64") !== entry.secretBase64)
      fail("keyring material is invalid");
    keys.set(entry.keyId, material);
    if (entry.status === "active") active += 1;
  }
  if (active !== 1 || object.keys.find((item: Key) => item.keyId === object.currentKeyId)?.status !== "active")
    fail("keyring must have one matching active key");
  return { keyring: object as Keyring, keys };
};

const verifyState = (raw: string, kind: State["state"]["kind"], serverId: string, keys: Map<string, Buffer>): State => {
  if (raw === "UNINITIALIZED") fail(`${kind} is uninitialized in the capsule`);
  const value = parseStrict(raw, `${kind} state`);
  const document = exactKeys(value, ["authentication", "format", "schemaVersion", "source", "state"], `${kind} state`);
  const auth = exactKeys(document.authentication, ["algorithm", "keyId", "tag"], `${kind} authentication`);
  const source = exactKeys(document.source, ["serverId"], `${kind} source`);
  const state = exactKeys(document.state, ["backupId", "generation", "kind", "updatedAt"], `${kind} value`);
  if (
    document.format !== "mc-aws-backup-state" ||
    document.schemaVersion !== CURRENT_SCHEMA_VERSION ||
    state.kind !== kind ||
    source.serverId !== serverId
  )
    fail(`${kind} identity is invalid`);
  if (
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1 ||
    state.generation > MAX_GENERATION ||
    !/^[a-f0-9]{32}$/.test(state.backupId)
  )
    fail(`${kind} generation is invalid`);
  if (
    auth.algorithm !== "HMAC-SHA256" ||
    typeof auth.keyId !== "string" ||
    !KEY_ID.test(auth.keyId) ||
    !SHA256.test(auth.tag)
  )
    fail(`${kind} authentication metadata is invalid`);
  const key = keys.get(auth.keyId);
  if (!key) fail(`${kind} uses a key absent from the capsule keyring`);
  const verifiedKey = key as Buffer;
  const payload = {
    format: document.format,
    schemaVersion: document.schemaVersion,
    source: document.source,
    state: document.state,
  };
  const expected = createHmac("sha256", verifiedKey).update(canonical(payload)).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(auth.tag))) fail(`${kind} authentication failed`);
  return document as State;
};

const readCapsule = (file: string, account: string, region: string, stack: string) => {
  const info = statSync(file);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) fail("capsule must be a private regular file");
  const raw = readFileSync(file, "ascii");
  const value = parseStrict(raw, "recovery capsule");
  const capsule = exactKeys(
    value,
    ["authentication", "checkpoint", "format", "keyring", "restoreFloor", "schemaVersion", "serverId", "verifier"],
    "recovery capsule"
  );
  if (
    capsule.format !== "mc-aws-recovery-capsule" ||
    capsule.schemaVersion !== CURRENT_SCHEMA_VERSION ||
    typeof capsule.serverId !== "string" ||
    !SERVER_ID.test(capsule.serverId)
  )
    fail("capsule identity is invalid");
  const expectedServer = new RegExp(
    `^arn:aws(?:-[a-z]+)?:cloudformation:${region}:${account}:stack/${stack}/[A-Za-z0-9-]+$`
  );
  if (!expectedServer.test(capsule.serverId)) fail("capsule belongs to another AWS account, region, or stack");
  const { keyring, keys } = decodeKeyring(capsule.keyring);
  const verifier = exactKeys(
    capsule.verifier,
    ["algorithm", "keyIds", "manifestFormat", "manifestSchemaVersion", "stateFormat", "stateSchemaVersion"],
    "verifier metadata"
  );
  if (
    verifier.algorithm !== "HMAC-SHA256" ||
    verifier.manifestFormat !== "mc-aws-drive-backup" ||
    verifier.manifestSchemaVersion !== CURRENT_SCHEMA_VERSION ||
    verifier.stateFormat !== "mc-aws-backup-state" ||
    verifier.stateSchemaVersion !== CURRENT_SCHEMA_VERSION ||
    JSON.stringify(verifier.keyIds) !== JSON.stringify(keyring.keys.map((key) => key.keyId))
  )
    fail("verifier metadata does not match the complete keyring");
  const authentication = exactKeys(capsule.authentication, ["algorithm", "keyId", "tag"], "capsule authentication");
  if (
    authentication.algorithm !== "HMAC-SHA256" ||
    authentication.keyId !== keyring.currentKeyId ||
    !SHA256.test(authentication.tag)
  )
    fail("capsule authentication metadata is invalid");
  const payload = {
    checkpoint: capsule.checkpoint,
    format: capsule.format,
    keyring: capsule.keyring,
    restoreFloor: capsule.restoreFloor,
    schemaVersion: capsule.schemaVersion,
    serverId: capsule.serverId,
    verifier: capsule.verifier,
  };
  const activeKey = keys.get(keyring.currentKeyId);
  if (!activeKey) fail("capsule active key is missing");
  const verifiedActiveKey = activeKey as Buffer;
  const expectedTag = createHmac("sha256", verifiedActiveKey).update(canonical(payload)).digest("hex");
  if (!timingSafeEqual(Buffer.from(expectedTag), Buffer.from(authentication.tag)))
    fail("capsule authentication failed");
  const checkpoint =
    capsule.checkpoint === "UNINITIALIZED"
      ? undefined
      : verifyState(capsule.checkpoint, "backup-generation", capsule.serverId, keys);
  const floor =
    capsule.restoreFloor === "UNINITIALIZED"
      ? undefined
      : verifyState(capsule.restoreFloor, "restore-floor", capsule.serverId, keys);
  if (floor && checkpoint && floor.state.generation > checkpoint.state.generation)
    fail("restore floor exceeds checkpoint");
  return {
    capsule,
    keyring,
    keys,
    checkpoint,
    floor,
    verifier: canonical(verifier),
    keyringRaw: canonical(keyring),
    serverId: capsule.serverId,
    capsuleDigest: createHash("sha256").update(canonical(capsule)).digest("hex"),
  };
};

type Parameter = { value: string; type: string; version?: number };
// biome-ignore lint/suspicious/noExplicitAny: AWS SDK command responses are intentionally opaque at this boundary.
type Sender = (command: GetParameterCommand | PutParameterCommand) => Promise<any>;

const getParameter = async (send: Sender, name: string, decrypt: boolean): Promise<Parameter | undefined> => {
  try {
    const response = await send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
    if (!response.Parameter?.Value || !response.Parameter.Type)
      fail(`authoritative parameter ${name} is empty or has no type`);
    const version = response.Parameter.Version;
    return {
      value: response.Parameter.Value,
      type: response.Parameter.Type,
      ...(Number.isSafeInteger(version) && version >= 1 ? { version } : {}),
    };
  } catch (error: unknown) {
    const awsError = error as { name?: string };
    if (awsError.name === "ParameterNotFound") return undefined;
    throw error;
  }
};

export interface RecoveryCapsuleAdoptionLock {
  lockId: string;
  fencingToken: number;
  value?: string;
  version?: number;
  external?: boolean;
}

type RecoveryLockIdentity = {
  account: string;
  region: string;
  stack: string;
  capsuleDigest: string;
  serverId: string;
  checkpointGeneration: number;
  floorGeneration: number;
  keyIds: string[];
};

export interface RecoveryCapsuleAdoptionOptions {
  /** Test/local seam; production uses the retained account-scoped SSM claim. */
  acquireLock?: (identity?: RecoveryLockIdentity) => Promise<RecoveryCapsuleAdoptionLock>;
  releaseLock?: (lock: RecoveryCapsuleAdoptionLock) => Promise<boolean>;
  /** Test seam for the same account-scoped lock used by runtime backup writers. */
  acquireMigrationLock?: (identity?: RecoveryLockIdentity) => Promise<RecoveryCapsuleAdoptionLock>;
  releaseMigrationLock?: (lock: RecoveryCapsuleAdoptionLock) => Promise<boolean>;
}

const recoveryLockValue = (identity: RecoveryLockIdentity): string =>
  canonical({
    capsuleDigest: identity.capsuleDigest,
    checkpointGeneration: identity.checkpointGeneration,
    floorGeneration: identity.floorGeneration,
    format: "mc-aws-recovery-adoption-lock",
    keyIds: identity.keyIds,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    scope: { account: identity.account, region: identity.region, stack: identity.stack },
    serverId: identity.serverId,
  });

const retainedRecoveryLockMatches = (raw: string, identity: RecoveryLockIdentity): boolean => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const scope = value.scope as Record<string, unknown> | undefined;
    const checkpointGeneration = value.checkpointGeneration;
    const floorGeneration = value.floorGeneration;
    return (
      canonical(value) === raw &&
      Object.keys(value).sort().join(",") ===
        "capsuleDigest,checkpointGeneration,floorGeneration,format,keyIds,schemaVersion,scope,serverId" &&
      Object.keys(scope ?? {})
        .sort()
        .join(",") === "account,region,stack" &&
      value.format === "mc-aws-recovery-adoption-lock" &&
      value.schemaVersion === CURRENT_SCHEMA_VERSION &&
      value.capsuleDigest === identity.capsuleDigest &&
      value.serverId === identity.serverId &&
      scope?.account === identity.account &&
      scope?.region === identity.region &&
      scope?.stack === identity.stack &&
      JSON.stringify(value.keyIds) === JSON.stringify(identity.keyIds) &&
      typeof checkpointGeneration === "number" &&
      Number.isSafeInteger(checkpointGeneration) &&
      checkpointGeneration >= identity.checkpointGeneration &&
      typeof floorGeneration === "number" &&
      Number.isSafeInteger(floorGeneration) &&
      floorGeneration >= identity.floorGeneration &&
      floorGeneration <= checkpointGeneration
    );
  } catch {
    return false;
  }
};

const defaultAcquireLock = async (
  send: Sender,
  identity: RecoveryLockIdentity
): Promise<RecoveryCapsuleAdoptionLock> => {
  const value = recoveryLockValue(identity);
  try {
    const response = await send(
      new PutParameterCommand({
        Name: RECOVERY_LOCK_PARAMETER,
        Type: "String",
        Value: value,
        Overwrite: false,
      })
    );
    const committed = await getParameter(send, RECOVERY_LOCK_PARAMETER, false);
    if (!committed || !sameParameter(committed, { value, type: "String" })) {
      fail("recovery adoption lock was not durably claimed");
    }
    if (!committed) throw new Error("recovery adoption lock was not durably claimed");
    const version = committed.version ?? (Number.isSafeInteger(response?.Version) ? response.Version : 1);
    return { lockId: identity.capsuleDigest, fencingToken: version, value, version, external: true };
  } catch (error: unknown) {
    if ((error as { name?: string }).name !== "ParameterAlreadyExists") throw error;
    const existing = await getParameter(send, RECOVERY_LOCK_PARAMETER, false);
    if (!existing || existing.type !== "String" || !retainedRecoveryLockMatches(existing.value, identity)) {
      fail("recovery adoption lock conflicts with another capsule or is malformed");
    }
    if (!existing) throw new Error("recovery adoption lock conflicts with another capsule or is malformed");
    const version = existing.version ?? 1;
    return { lockId: identity.capsuleDigest, fencingToken: version, value: existing.value, version, external: true };
  }
};

const updateExternalRecoveryLock = async (
  send: Sender,
  lock: RecoveryCapsuleAdoptionLock,
  identity: RecoveryLockIdentity
): Promise<RecoveryCapsuleAdoptionLock> => {
  if (!lock.external) return lock;
  const value = recoveryLockValue(identity);
  const current = await getParameter(send, RECOVERY_LOCK_PARAMETER, false);
  if (
    !current ||
    current.type !== "String" ||
    current.value !== lock.value ||
    (lock.version !== undefined && current.version !== lock.version)
  ) {
    throw new ConcurrentRecoveryStateChange();
  }
  const currentIdentity = JSON.parse(current.value) as {
    checkpointGeneration: number;
    floorGeneration: number;
  };
  if (
    currentIdentity.checkpointGeneration > identity.checkpointGeneration ||
    currentIdentity.floorGeneration > identity.floorGeneration
  ) {
    fail("authoritative recovery state is behind the retained monotonic adoption lock");
  }
  if (current.value === value) return { ...lock, value, version: current.version };
  const response = await send(
    new PutParameterCommand({ Name: RECOVERY_LOCK_PARAMETER, Type: "String", Value: value, Overwrite: true })
  );
  const updated = await getParameter(send, RECOVERY_LOCK_PARAMETER, false);
  if (!updated || updated.type !== "String" || updated.value !== value) throw new ConcurrentRecoveryStateChange();
  if (
    Number.isSafeInteger(response?.Version) &&
    updated.version !== undefined &&
    response.Version !== updated.version
  ) {
    throw new ConcurrentRecoveryStateChange();
  }
  return { ...lock, value, version: updated.version };
};

const defaultReleaseLock = async (): Promise<boolean> => true;

const defaultAcquireMigrationLock = async (
  _send: Sender,
  identity: RecoveryLockIdentity
): Promise<RecoveryCapsuleAdoptionLock> => {
  const value = canonical({
    capsuleDigest: identity.capsuleDigest,
    format: "mc-aws-backup-recovery-migration-lock",
    operation: "capsule-adoption",
    schemaVersion: 1,
  });
  const tableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!tableName) {
    const freshSetup =
      process.env.MC_AWS_FRESH_STACK === "true" && /^[a-f0-9-]{36}$/.test(process.env.MC_AWS_SETUP_CLAIM_TOKEN ?? "");
    if (!freshSetup && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
      fail("MC_OPERATION_STATE_TABLE_NAME is required for an existing deployment");
    }
    if (localMigrationLocks.has(migrationLockKey)) fail("backup recovery migration is busy; retry later");
    localMigrationLocks.add(migrationLockKey);
    return { lockId: identity.capsuleDigest, fencingToken: 1, value, version: 1, external: true };
  }
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          operationId: { S: migrationLockKey },
          lockOwner: { S: value },
          leaseExpiresAt: { N: String(Math.floor(Date.now() / 1000) + 900) },
        },
        ConditionExpression: "attribute_not_exists(operationId) OR leaseExpiresAt < :now",
        ExpressionAttributeValues: { ":now": { N: String(Math.floor(Date.now() / 1000)) } },
        ReturnConsumedCapacity: "NONE",
      })
    );
    return {
      lockId: identity.capsuleDigest,
      fencingToken: 1,
      value,
      version: 1,
      external: true,
    };
  } catch (error: unknown) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException")
      fail("backup recovery migration is busy; refusing concurrent checkpoint, floor, keyring, or capsule mutation");
    throw error;
  }
};

const defaultReleaseMigrationLock = async (_send: Sender, lock: RecoveryCapsuleAdoptionLock): Promise<boolean> => {
  const tableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!tableName) {
    localMigrationLocks.delete(migrationLockKey);
    return true;
  }
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { operationId: { S: migrationLockKey } },
      UpdateExpression: "SET leaseExpiresAt = :expired",
      ConditionExpression: "lockOwner = :owner",
      ExpressionAttributeValues: { ":expired": { N: "0" }, ":owner": { S: lock.value ?? "" } },
    })
  );
  return true;
};

function sameParameter(left: Parameter | undefined, right: Parameter | undefined): boolean {
  return (
    left?.value === right?.value &&
    left?.type === right?.type &&
    (left?.version === undefined || right?.version === undefined || left.version === right.version)
  );
}

class ConcurrentRecoveryStateChange extends Error {
  constructor() {
    super("authoritative recovery state changed during adoption; retrying without rollback");
    this.name = "ConcurrentRecoveryStateChange";
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: adoption is one fail-closed transaction boundary.
export async function adoptBackupRecoveryCapsule(
  send: Sender,
  capsuleFile: string,
  account: string,
  region: string,
  stack: string,
  options: RecoveryCapsuleAdoptionOptions = {}
): Promise<string> {
  const adopted = readCapsule(capsuleFile, account, region, stack);
  const names = [KEYRING_PARAMETER, SERVER_PARAMETER, CHECKPOINT_PARAMETER, FLOOR_PARAMETER, VERIFIER_PARAMETER];
  const releaseLock = options.releaseLock ?? defaultReleaseLock;
  const lockIdentity: RecoveryLockIdentity = {
    account,
    region,
    stack,
    capsuleDigest: adopted.capsuleDigest,
    serverId: adopted.serverId,
    checkpointGeneration: adopted.checkpoint?.state.generation ?? 0,
    floorGeneration: adopted.floor?.state.generation ?? 0,
    keyIds: adopted.keyring.keys.map((key) => key.keyId),
  };
  let migrationLock: RecoveryCapsuleAdoptionLock | undefined;
  let lock: RecoveryCapsuleAdoptionLock | undefined;
  let released = false;
  let migrationReleased = false;
  const releaseLocks = async (): Promise<void> => {
    if (!released) {
      released = true;
      if (lock && !(await releaseLock(lock)))
        throw new Error("Recovery capsule adoption lock release did not converge");
    }
    if (migrationLock && !migrationReleased) {
      migrationReleased = true;
      const releasedMigration = options.releaseMigrationLock
        ? await options.releaseMigrationLock(migrationLock)
        : await defaultReleaseMigrationLock(send, migrationLock);
      if (!releasedMigration) throw new Error("Recovery migration lock release did not converge");
    }
  };
  const assertExternalLock = async (): Promise<void> => {
    const externalLock = lock;
    if (!externalLock?.external) return;
    const current = await getParameter(send, RECOVERY_LOCK_PARAMETER, false);
    if (
      !current ||
      current.value !== externalLock.value ||
      (externalLock.version !== undefined && current.version !== externalLock.version)
    ) {
      throw new ConcurrentRecoveryStateChange();
    }
  };
  try {
    migrationLock = options.acquireMigrationLock
      ? await options.acquireMigrationLock(lockIdentity)
      : options.acquireLock
        ? undefined
        : await defaultAcquireMigrationLock(send, lockIdentity);
    lock = options.acquireLock ? await options.acquireLock(lockIdentity) : await defaultAcquireLock(send, lockIdentity);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertExternalLock();
      const existing = new Map<string, Parameter | undefined>();
      for (const name of names) existing.set(name, await getParameter(send, name, name === KEYRING_PARAMETER));
      const currentKeyring = existing.get(KEYRING_PARAMETER);
      if (currentKeyring && (currentKeyring.type !== "SecureString" || currentKeyring.value !== adopted.keyringRaw))
        fail("existing keyring does not exactly match the authenticated capsule");
      const currentServer = existing.get(SERVER_PARAMETER);
      if (currentServer && (currentServer.type !== "String" || currentServer.value !== adopted.serverId))
        fail("existing server identity does not match the authenticated capsule");
      const currentVerifier = existing.get(VERIFIER_PARAMETER);
      if (
        currentVerifier &&
        (currentVerifier.type !== "String" ||
          (currentVerifier.value !== adopted.verifier && currentVerifier.value !== "UNINITIALIZED"))
      )
        fail("existing verifier metadata does not match the authenticated capsule");

      const decisions: Array<{ name: string; type: "String" | "SecureString"; value: string; shouldWrite: boolean }> = [
        { name: KEYRING_PARAMETER, type: "SecureString", value: adopted.keyringRaw, shouldWrite: !currentKeyring },
        { name: SERVER_PARAMETER, type: "String", value: adopted.serverId, shouldWrite: !currentServer },
        {
          name: VERIFIER_PARAMETER,
          type: "String",
          value: adopted.verifier,
          shouldWrite: !currentVerifier || currentVerifier.value === "UNINITIALIZED",
        },
      ];
      for (const [name, candidate, kind] of [
        [CHECKPOINT_PARAMETER, adopted.checkpoint, "backup-generation"],
        [FLOOR_PARAMETER, adopted.floor, "restore-floor"],
      ] as const) {
        const current = existing.get(name);
        if (current && current.type !== "String") fail(`authoritative parameter ${name} has the wrong type`);
        if (!candidate) {
          decisions.push({ name, type: "String", value: "UNINITIALIZED", shouldWrite: !current });
          continue;
        }
        let shouldWrite = !current || current.value === "UNINITIALIZED";
        if (current && current.value !== "UNINITIALIZED") {
          const parsed = verifyState(current.value, kind, adopted.serverId, adopted.keys);
          if (parsed.state.generation > candidate.state.generation) shouldWrite = false;
          else if (parsed.state.generation === candidate.state.generation) {
            if (parsed.state.backupId !== candidate.state.backupId)
              fail(`${kind} would roll back or conflict at the same generation`);
            shouldWrite = false;
          }
        }
        decisions.push({ name, type: "String", value: canonical(candidate), shouldWrite });
      }

      const written: Array<{ name: string; prior?: Parameter; written: Parameter }> = [];
      try {
        // Compare every capsule record, including fields that need no write,
        // immediately before entering the write phase. This is the
        // transaction's complete strongly-consistent read set.
        for (const name of names) {
          const current = await getParameter(send, name, name === KEYRING_PARAMETER);
          if (!sameParameter(current, existing.get(name))) throw new ConcurrentRecoveryStateChange();
        }
        await assertExternalLock();
        for (const decision of decisions) {
          if (!decision.shouldWrite) continue;
          await assertExternalLock();
          // SSM has no expected-version PutParameter argument. The shared
          // lifecycle lock plus this strongly-consistent version check is the
          // CAS boundary; Overwrite is permitted only for an unchanged version.
          const before = await getParameter(send, decision.name, decision.name === KEYRING_PARAMETER);
          if (!sameParameter(before, existing.get(decision.name))) throw new ConcurrentRecoveryStateChange();
          const response = await send(
            new PutParameterCommand({
              Name: decision.name,
              Type: decision.type,
              Value: decision.value,
              Overwrite: Boolean(before),
            })
          );
          const after = await getParameter(send, decision.name, decision.name === KEYRING_PARAMETER);
          if (!after || after.value !== decision.value || after.type !== decision.type)
            throw new ConcurrentRecoveryStateChange();
          const responseVersion = response?.Version;
          if (Number.isSafeInteger(responseVersion) && after.version !== undefined && responseVersion !== after.version)
            throw new ConcurrentRecoveryStateChange();
          written.push({ name: decision.name, prior: existing.get(decision.name), written: after });
        }
      } catch (error) {
        for (const item of written.reverse()) {
          try {
            const current = await getParameter(send, item.name, item.name === KEYRING_PARAMETER);
            // Never undo a later writer. Version is the generation of this
            // attempt; value equality is retained for test/mocked SSM backends.
            if (!current || !sameParameter(current, item.written)) continue;
            if (item.prior) {
              await send(
                new PutParameterCommand({
                  Name: item.name,
                  Type: item.prior.type as "String" | "SecureString",
                  Value: item.prior.value,
                  Overwrite: true,
                })
              );
            } else {
              // SSM has no conditional delete. Preserve a newly created
              // record rather than risking removal of a successor.
            }
          } catch {
            // Preserve the original error and, importantly, never overwrite a
            // value whose version no longer belongs to this attempt.
          }
        }
        if (error instanceof ConcurrentRecoveryStateChange && attempt < 2) continue;
        throw new Error(
          `partial recovery capsule adoption was rolled back; no deployment was started (${error instanceof Error ? error.message : "unknown"})`
        );
      }

      const final = new Map<string, Parameter | undefined>();
      await assertExternalLock();
      for (const name of names) final.set(name, await getParameter(send, name, name === KEYRING_PARAMETER));
      if (!sameParameter(final.get(KEYRING_PARAMETER), { value: adopted.keyringRaw, type: "SecureString" }))
        fail("adopted keyring changed during verification");
      if (!sameParameter(final.get(SERVER_PARAMETER), { value: adopted.serverId, type: "String" }))
        fail("adopted server identity changed during verification");
      if (!sameParameter(final.get(VERIFIER_PARAMETER), { value: adopted.verifier, type: "String" }))
        fail("adopted verifier metadata changed during verification");
      const checkpoint = final.get(CHECKPOINT_PARAMETER);
      const floor = final.get(FLOOR_PARAMETER);
      const checkpointState =
        checkpoint?.value && checkpoint.value !== "UNINITIALIZED"
          ? verifyState(checkpoint.value, "backup-generation", adopted.serverId, adopted.keys)
          : undefined;
      const floorState =
        floor?.value && floor.value !== "UNINITIALIZED"
          ? verifyState(floor.value, "restore-floor", adopted.serverId, adopted.keys)
          : undefined;
      const effectiveCheckpoint = checkpointState?.state.generation ?? 0;
      const effectiveFloor = floorState?.state.generation ?? 0;
      if (effectiveFloor > effectiveCheckpoint) fail("effective authoritative floor exceeds checkpoint");
      if (
        adopted.checkpoint &&
        effectiveCheckpoint === adopted.checkpoint.state.generation &&
        checkpointState?.state.backupId !== adopted.checkpoint.state.backupId
      )
        fail("backup-generation would roll back or conflict at the same generation");
      if (
        adopted.floor &&
        effectiveFloor === adopted.floor.state.generation &&
        floorState?.state.backupId !== adopted.floor.state.backupId
      )
        fail("restore-floor would roll back or conflict at the same generation");
      if (lock) {
        lock = await updateExternalRecoveryLock(send, lock, {
          ...lockIdentity,
          checkpointGeneration: effectiveCheckpoint,
          floorGeneration: effectiveFloor,
        });
      }
      return [
        adopted.serverId,
        String(adopted.checkpoint?.state.generation ?? 0),
        String(adopted.floor?.state.generation ?? 0),
        String(effectiveCheckpoint),
        String(effectiveFloor),
        adopted.keyring.keys.map((key) => key.keyId).join(","),
        createHash("sha256").update(adopted.verifier).digest("hex"),
        createHash("sha256").update(adopted.keyringRaw).digest("hex"),
        checkpointState?.state.backupId ?? "",
        floorState?.state.backupId ?? "",
        adopted.capsuleDigest,
        adopted.verifier,
      ].join("\t");
    }
    throw new Error("Recovery capsule adoption did not converge");
  } finally {
    await releaseLocks();
  }
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) fail(`${name} is required`);
  return value;
};

if (process.argv[1]?.endsWith("adopt-backup-recovery-capsule.ts")) {
  try {
    const region = argument("--region");
    if (!process.env.MC_OPERATION_STATE_TABLE_NAME?.trim())
      throw new Error("MC_OPERATION_STATE_TABLE_NAME is required");
    const client = new SSMClient({ region });
    const send: Sender = (command) => client.send(command as never);
    adoptBackupRecoveryCapsule(send, argument("--capsule"), argument("--account"), region, argument("--stack"))
      .then((result) => console.log(result))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : "Recovery capsule adoption failed");
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Recovery capsule adoption failed");
    process.exitCode = 1;
  }
}
