#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export const BACKUP_AUTH_KEYRING_PARAMETER = "/minecraft/backup-auth-keyring";
export const BACKUP_RECOVERY_MIGRATION_LOCK_PARAMETER = "/minecraft/backup-recovery-migration-lock";
const migrationLockKey = "mc-aws-backup-recovery-migration";
const localMigrationLocks = new Set<string>();
const dynamodb = new DynamoDBClient({});
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface BackupAuthKeyring {
  schemaVersion: 1;
  currentKeyId: string;
  keys: Array<{ keyId: string; secretBase64: string; status: "active" | "verify-only" }>;
}

export function parseBackupAuthKeyring(raw: string): BackupAuthKeyring {
  const value = JSON.parse(raw) as Partial<BackupAuthKeyring>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "currentKeyId,keys,schemaVersion" ||
    value.schemaVersion !== 1 ||
    typeof value.currentKeyId !== "string" ||
    !KEY_ID.test(value.currentKeyId) ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > 8
  ) {
    throw new Error("Backup authentication keyring schema is invalid.");
  }
  if (raw !== JSON.stringify(value)) {
    throw new Error("Backup authentication keyring must be strict canonical JSON.");
  }
  const ids = new Set<string>();
  let active = 0;
  for (const key of value.keys) {
    if (
      !key ||
      typeof key !== "object" ||
      Array.isArray(key) ||
      Object.keys(key).sort().join(",") !== "keyId,secretBase64,status" ||
      typeof key.keyId !== "string" ||
      !KEY_ID.test(key.keyId) ||
      ids.has(key.keyId) ||
      (key.status !== "active" && key.status !== "verify-only") ||
      typeof key.secretBase64 !== "string"
    ) {
      throw new Error("Backup authentication key entry is invalid.");
    }
    const decoded = Buffer.from(key.secretBase64, "base64");
    if (decoded.length < 32 || decoded.length > 64 || decoded.toString("base64") !== key.secretBase64) {
      throw new Error("Backup authentication key material is invalid.");
    }
    ids.add(key.keyId);
    if (key.status === "active") active += 1;
  }
  if (active !== 1 || value.keys.find((key) => key.keyId === value.currentKeyId)?.status !== "active") {
    throw new Error("Backup authentication keyring must contain one matching active key.");
  }
  return value as BackupAuthKeyring;
}

export function createBackupAuthKeyring(keyId: string, material: Buffer = randomBytes(32)): BackupAuthKeyring {
  if (!KEY_ID.test(keyId) || material.length < 32 || material.length > 64) {
    throw new Error("Backup authentication key ID or material is invalid.");
  }
  return {
    schemaVersion: 1,
    currentKeyId: keyId,
    keys: [{ keyId, secretBase64: material.toString("base64"), status: "active" }],
  };
}

export function rotateBackupAuthKeyring(
  current: BackupAuthKeyring,
  newKeyId: string,
  material: Buffer = randomBytes(32)
): BackupAuthKeyring {
  const parsed = parseBackupAuthKeyring(JSON.stringify(current));
  if (
    !KEY_ID.test(newKeyId) ||
    material.length < 32 ||
    material.length > 64 ||
    parsed.keys.some((key) => key.keyId === newKeyId) ||
    parsed.keys.length >= 8
  ) {
    throw new Error("New backup authentication key ID is invalid, duplicated, or exceeds keyring capacity.");
  }
  return {
    schemaVersion: 1,
    currentKeyId: newKeyId,
    keys: [
      { keyId: newKeyId, secretBase64: material.toString("base64"), status: "active" },
      ...parsed.keys.map((key) => ({ ...key, status: "verify-only" as const })),
    ],
  };
}

type Send = (command: GetParameterCommand | PutParameterCommand) => Promise<unknown>;

type ParameterRecord = { value: string; type: string; version?: number };

async function readParameter(send: Send, name: string): Promise<ParameterRecord | undefined> {
  try {
    const response = (await send(
      new GetParameterCommand({ Name: name, WithDecryption: name === BACKUP_AUTH_KEYRING_PARAMETER })
    )) as {
      Parameter?: { Value?: string; Type?: string; Version?: number };
    };
    if (!response.Parameter?.Value || !response.Parameter.Type)
      throw new Error(`Parameter ${name} is empty or malformed.`);
    return {
      value: response.Parameter.Value,
      type: response.Parameter.Type,
      ...(Number.isSafeInteger(response.Parameter.Version) ? { version: response.Parameter.Version } : {}),
    };
  } catch (error) {
    if ((error as { name?: string }).name === "ParameterNotFound") return undefined;
    throw error;
  }
}

async function withMigrationLock<T>(_send: Send, operation: string, callback: () => Promise<T>): Promise<T> {
  const value = JSON.stringify({
    format: "mc-aws-backup-recovery-migration-lock",
    operation,
    owner: randomUUID(),
    schemaVersion: 1,
  });
  const tableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (tableName) {
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
      })
    );
  } else {
    const freshSetup =
      process.env.MC_AWS_FRESH_STACK === "true" && /^[a-f0-9-]{36}$/.test(process.env.MC_AWS_SETUP_CLAIM_TOKEN ?? "");
    if (!freshSetup && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
      throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for an existing deployment.");
    }
    if (localMigrationLocks.has(migrationLockKey)) throw new Error("Backup recovery migration is busy; retry later.");
    localMigrationLocks.add(migrationLockKey);
  }
  try {
    const result = await callback();
    return result;
  } finally {
    if (tableName) {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { operationId: { S: migrationLockKey } },
          UpdateExpression: "SET leaseExpiresAt = :expired",
          ConditionExpression: "lockOwner = :owner",
          ExpressionAttributeValues: { ":expired": { N: "0" }, ":owner": { S: value } },
        })
      );
    } else localMigrationLocks.delete(migrationLockKey);
  }
}

async function readKeyring(send: Send): Promise<BackupAuthKeyring | undefined> {
  try {
    const response = (await send(
      new GetParameterCommand({ Name: BACKUP_AUTH_KEYRING_PARAMETER, WithDecryption: true })
    )) as { Parameter?: { Value?: string } };
    if (!response.Parameter?.Value) throw new Error("Backup authentication keyring value is unavailable.");
    return parseBackupAuthKeyring(response.Parameter.Value);
  } catch (error) {
    if ((error as { name?: string }).name === "ParameterNotFound") return undefined;
    throw error;
  }
}

async function writeKeyring(send: Send, keyring: BackupAuthKeyring, expected: ParameterRecord): Promise<void> {
  const parsed = parseBackupAuthKeyring(JSON.stringify(keyring));
  // Keep the stored envelope in the same deterministic order used by recovery
  // capsules. This lets adoption compare complete material byte-for-byte while
  // never exposing it in logs or deployment metadata.
  const canonical = JSON.stringify({
    currentKeyId: parsed.currentKeyId,
    keys: parsed.keys,
    schemaVersion: parsed.schemaVersion,
  });
  const before = await readParameter(send, BACKUP_AUTH_KEYRING_PARAMETER);
  if (!before || before.type !== "SecureString" || before.version !== expected.version) {
    throw new Error("Backup authentication keyring changed before the version-CAS write.");
  }
  const response = (await send(
    new PutParameterCommand({
      Name: BACKUP_AUTH_KEYRING_PARAMETER,
      Value: canonical,
      Type: "SecureString",
      Overwrite: true,
    })
  )) as { Version?: number };
  const after = await readParameter(send, BACKUP_AUTH_KEYRING_PARAMETER);
  if (!after || after.type !== "SecureString" || after.version === expected.version) {
    throw new Error("Backup authentication keyring did not advance during the version-CAS write.");
  }
  if (Number.isSafeInteger(response.Version) && after.version !== response.Version) {
    throw new Error("Backup authentication keyring changed during the version-CAS write.");
  }
}

export async function provisionBackupAuthKeyring(send: Send, keyId: string): Promise<"created" | "existing"> {
  const keyring = createBackupAuthKeyring(keyId);
  const parsed = parseBackupAuthKeyring(JSON.stringify(keyring));
  const canonical = JSON.stringify({
    currentKeyId: parsed.currentKeyId,
    keys: parsed.keys,
    schemaVersion: parsed.schemaVersion,
  });
  try {
    // Creation is the CAS: never turn an absent probe into an unconditional
    // overwrite. A concurrent provisioner either wins this create or observes
    // the complete winner's keyring and leaves it untouched.
    await send(
      new PutParameterCommand({
        Name: BACKUP_AUTH_KEYRING_PARAMETER,
        Value: canonical,
        Type: "SecureString",
        Overwrite: false,
      })
    );
    return "created";
  } catch (error) {
    if ((error as { name?: string }).name !== "ParameterAlreadyExists") throw error;
    const existing = await readKeyring(send);
    if (!existing) throw new Error("Backup authentication keyring creation raced with an unavailable value.");
    return "existing";
  }
}

export async function materializeBackupAuthKeyring(environment: Record<string, string | undefined>): Promise<string[]> {
  const region = environment.CDK_DEFAULT_REGION || environment.AWS_REGION || environment.AWS_DEFAULT_REGION;
  const client = new SSMClient({ region });
  const keyId = `initial-${new Date().toISOString().slice(0, 7)}`;
  await provisionBackupAuthKeyring((command) => client.send(command as never), keyId);
  return [BACKUP_AUTH_KEYRING_PARAMETER];
}

export async function rotateStoredBackupAuthKeyring(send: Send, keyId: string): Promise<void> {
  await withMigrationLock(send, "keyring-rotate", async () => {
    const currentRecord = await readParameter(send, BACKUP_AUTH_KEYRING_PARAMETER);
    if (!currentRecord) throw new Error("Provision the backup authentication keyring before rotation.");
    if (currentRecord.type !== "SecureString") throw new Error("Backup authentication keyring has the wrong type.");
    const current = parseBackupAuthKeyring(currentRecord.value);
    await writeKeyring(send, rotateBackupAuthKeyring(current, keyId), currentRecord);
  });
}

export async function recoverBackupAuthKeyring(send: Send, file: string): Promise<void> {
  const status = statSync(file);
  if (!status.isFile() || (status.mode & 0o077) !== 0) {
    throw new Error("Recovery keyring file must be a regular file with no group/other permissions.");
  }
  await withMigrationLock(send, "keyring-recover", async () => {
    const current = await readParameter(send, BACKUP_AUTH_KEYRING_PARAMETER);
    if (!current) throw new Error("Provision the backup authentication keyring before recovery.");
    await writeKeyring(send, parseBackupAuthKeyring(readFileSync(file, "utf8").trim()), current);
  });
}

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function assertOperationStateTableAvailable(): void {
  const freshSetup =
    process.env.MC_AWS_FRESH_STACK === "true" && /^[a-f0-9-]{36}$/.test(process.env.MC_AWS_SETUP_CLAIM_TOKEN ?? "");
  if (!process.env.MC_OPERATION_STATE_TABLE_NAME?.trim() && !freshSetup) {
    throw new Error("MC_OPERATION_STATE_TABLE_NAME is required.");
  }
}

async function runProvision(send: Send): Promise<void> {
  const keyId = argument("--key-id");
  if (!keyId) throw new Error("provision requires --key-id.");
  const result = await provisionBackupAuthKeyring(send, keyId);
  console.log(`Backup authentication keyring ${result}; secret value omitted.`);
}

async function runRotate(send: Send): Promise<void> {
  const keyId = argument("--key-id");
  if (!keyId || argument("--confirm-key-id") !== keyId) {
    throw new Error("rotate requires matching --key-id and --confirm-key-id values.");
  }
  await rotateStoredBackupAuthKeyring(send, keyId);
  console.log(`Backup authentication key rotated to ${keyId}; secret values omitted.`);
}

async function runRecover(send: Send): Promise<void> {
  const file = argument("--from-file");
  if (!file || argument("--confirm-parameter") !== BACKUP_AUTH_KEYRING_PARAMETER) {
    throw new Error(`recover requires --from-file and --confirm-parameter ${BACKUP_AUTH_KEYRING_PARAMETER}.`);
  }
  await recoverBackupAuthKeyring(send, path.resolve(file));
  console.log("Backup authentication keyring recovered; secret values omitted.");
}

async function runAction(action: string | undefined, send: Send): Promise<void> {
  if (action === "provision") return runProvision(send);
  if (action === "rotate") return runRotate(send);
  if (action === "recover") return runRecover(send);
  throw new Error("Usage: manage-backup-auth-keyring.ts <provision|rotate|recover> ...");
}

async function main(): Promise<void> {
  assertOperationStateTableAvailable();
  const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  const client = new SSMClient({ region });
  const send: Send = (command) => client.send(command as never);
  try {
    await runAction(process.argv[2], send);
  } catch {
    console.error("Backup authentication keyring operation failed; secret values omitted.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
