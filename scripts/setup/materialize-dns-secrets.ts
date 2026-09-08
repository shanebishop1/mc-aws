#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import * as dotenv from "dotenv";

interface SecretMaterialization {
  name: "/minecraft/cloudflare-api-token" | "/minecraft/duckdns-token";
  value: string;
}

export interface DnsSecretMaterializationEvidence {
  name: string;
  action: "created" | "updated" | "preserved";
  version?: number;
}

const providerParameters = {
  cloudflare: ["/minecraft/cloudflare-api-token"],
  duckdns: ["/minecraft/duckdns-token"],
} as const;
const localMigrationLocks = new Set<string>();
const migrationLockKey = "mc-aws-setup-migration";
const dynamodb = new DynamoDBClient({});
const setupLockPath = () =>
  process.env.MC_AWS_SETUP_LOCK_FILE?.trim() || path.resolve(".local-artifacts/mc-aws-setup.lock");

type OwnershipProof = { claimToken: string; resourceVersion: number };

const readManifestOwnership = (environment: Record<string, string | undefined>): Map<string, OwnershipProof> => {
  const file = environment.MC_AWS_DEPLOYMENT_MANIFEST;
  if (!file) return new Map();
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      aws?: {
        ssmParameters?: Array<{
          name?: string;
          ownership?: string;
          createdByProject?: boolean;
          claimToken?: string;
          resourceVersion?: number;
        }>;
      };
    };
    return new Map(
      (manifest.aws?.ssmParameters ?? [])
        .filter(
          (entry) =>
            entry.createdByProject === true &&
            entry.ownership === "created" &&
            Boolean(entry.claimToken) &&
            Number.isSafeInteger(entry.resourceVersion)
        )
        .filter(
          (entry): entry is { name: string; claimToken: string; resourceVersion: number } =>
            typeof entry.name === "string" &&
            typeof entry.claimToken === "string" &&
            /^[a-f0-9-]{36}$/.test(entry.claimToken) &&
            Number.isSafeInteger(entry.resourceVersion)
        )
        .map((entry) => [entry.name, { claimToken: entry.claimToken, resourceVersion: entry.resourceVersion }] as const)
    );
  } catch {
    throw new Error("Deployment ownership manifest could not be read; refusing DNS credential cleanup.");
  }
};

export function dnsSecretMaterializationPlan(environment: Record<string, string | undefined>): SecretMaterialization[] {
  const mode = environment.MC_CONNECTION_MODE?.trim();
  if (mode === "raw_ip") return [];
  if (mode && mode !== "cloudflare" && mode !== "duckdns") {
    throw new Error("MC_CONNECTION_MODE must select cloudflare, duckdns, or raw_ip.");
  }
  const cloudflareConfigured = mode
    ? mode === "cloudflare"
    : Boolean(environment.CLOUDFLARE_ZONE_ID?.trim() || environment.CLOUDFLARE_MC_DOMAIN?.trim());
  const duckDnsConfigured = mode ? mode === "duckdns" : Boolean(environment.DUCKDNS_DOMAIN?.trim());
  if (!cloudflareConfigured && !duckDnsConfigured) return [];
  if (cloudflareConfigured && duckDnsConfigured) {
    throw new Error("Configure exactly one DNS provider before materializing its credential.");
  }
  if (cloudflareConfigured) {
    const value = environment.CLOUDFLARE_DNS_API_TOKEN?.trim();
    if (!value) throw new Error("CLOUDFLARE_DNS_API_TOKEN is required for Cloudflare DNS.");
    return [{ name: "/minecraft/cloudflare-api-token", value }];
  }
  const value = environment.DUCKDNS_TOKEN?.trim();
  if (!value) throw new Error("DUCKDNS_TOKEN is required for DuckDNS.");
  return [{ name: "/minecraft/duckdns-token", value }];
}

type SsmCommand = GetParameterCommand | PutParameterCommand;
type Send = (command: SsmCommand) => Promise<unknown>;
type ParameterMetadata = { Parameter?: { Type?: string; Value?: string; Version?: number } };

const createSender = (environment: Record<string, string | undefined>): Send => {
  const client = new SSMClient({
    region: environment.CDK_DEFAULT_REGION || environment.AWS_REGION || environment.AWS_DEFAULT_REGION,
  });
  return (command) => client.send(command as never);
};

const readParameterMetadata = async (send: Send, name: string): Promise<ParameterMetadata | undefined> => {
  try {
    return (await send(new GetParameterCommand({ Name: name, WithDecryption: false }))) as ParameterMetadata;
  } catch (error) {
    if ((error as { name?: string }).name === "ParameterNotFound") return undefined;
    throw error;
  }
};

const acquireDynamoMigrationLock = async (tableName: string, value: string, leaseExpiresAt: number): Promise<void> => {
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          operationId: { S: migrationLockKey },
          lockOwner: { S: value },
          leaseExpiresAt: { N: String(leaseExpiresAt) },
        },
        ConditionExpression: "attribute_not_exists(operationId) OR leaseExpiresAt < :now",
        ExpressionAttributeValues: { ":now": { N: String(Math.floor(Date.now() / 1000)) } },
      })
    );
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new Error("DNS migration is busy; retry later.");
    }
    throw error;
  }
};

const acquireFreshSetupLock = (): string => {
  const lockPath = setupLockPath();
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new Error("DNS migration is busy; retry later.");
    throw new Error("Fresh setup coordination lock is unavailable.");
  }
  localMigrationLocks.add(lockPath);
  return lockPath;
};

const acquireTestMigrationLock = (): void => {
  if (localMigrationLocks.has(migrationLockKey)) throw new Error("DNS migration is busy; retry later.");
  localMigrationLocks.add(migrationLockKey);
};

const releaseDynamoMigrationLock = async (tableName: string, value: string): Promise<void> => {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { operationId: { S: migrationLockKey } },
      UpdateExpression: "SET leaseExpiresAt = :expired",
      ConditionExpression: "lockOwner = :owner",
      ExpressionAttributeValues: { ":expired": { N: "0" }, ":owner": { S: value } },
    })
  );
};

const releaseFreshSetupLock = (lockPath: string): void => {
  if (!localMigrationLocks.delete(lockPath)) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
};

const withMigrationLock = async <T>(
  environment: Record<string, string | undefined>,
  callback: () => Promise<T>
): Promise<T> => {
  const value = JSON.stringify({
    format: "mc-aws-backup-recovery-migration-lock",
    operation: "dns-materialize",
    owner: randomUUID(),
    schemaVersion: 1,
  });
  const tableName = environment.MC_OPERATION_STATE_TABLE_NAME?.trim();
  const leaseExpiresAt = Math.floor(Date.now() / 1000) + 900;
  let release: () => Promise<void> | void;
  if (tableName) {
    await acquireDynamoMigrationLock(tableName, value, leaseExpiresAt);
    release = () => releaseDynamoMigrationLock(tableName, value);
  } else if (
    environment.MC_AWS_FRESH_STACK === "true" &&
    /^[a-f0-9-]{36}$/.test(environment.MC_AWS_SETUP_CLAIM_TOKEN ?? "")
  ) {
    const lockPath = acquireFreshSetupLock();
    release = () => releaseFreshSetupLock(lockPath);
  } else if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    acquireTestMigrationLock();
    release = () => {
      localMigrationLocks.delete(migrationLockKey);
    };
  } else {
    throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for an existing deployment.");
  }
  let callbackCompleted = false;
  try {
    const result = await callback();
    callbackCompleted = true;
    await release();
    return result;
  } catch (error) {
    if (callbackCompleted) throw error;
    await release();
    throw error;
  }
};

const putParameterCas = async (
  send: Send,
  name: string,
  type: "String" | "SecureString",
  value: string,
  expected: ParameterMetadata | undefined
): Promise<ParameterMetadata> => {
  const before = await readParameterMetadata(send, name);
  if (before?.Parameter?.Version !== expected?.Parameter?.Version) {
    throw new Error(`SSM parameter ${name} changed before the version-CAS write.`);
  }
  const response = (await send(
    new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: Boolean(expected) })
  )) as { Version?: number };
  const after = await readParameterMetadata(send, name);
  if (!after?.Parameter || after.Parameter.Type !== type) {
    throw new Error(`SSM parameter ${name} did not converge after the version-CAS write.`);
  }
  if (
    Number.isSafeInteger(response.Version) &&
    Number.isSafeInteger(after.Parameter.Version) &&
    response.Version !== after.Parameter.Version
  ) {
    throw new Error(`SSM parameter ${name} changed during the version-CAS write.`);
  }
  if (
    expected?.Parameter?.Version !== undefined &&
    after.Parameter.Version !== undefined &&
    after.Parameter.Version === expected.Parameter.Version
  ) {
    throw new Error(`SSM parameter ${name} did not advance during the version-CAS write.`);
  }
  return after;
};

const preserveOwnedSecret = async (
  send: Send,
  name: string,
  owned: Map<string, OwnershipProof>
): Promise<DnsSecretMaterializationEvidence | undefined> => {
  if (!owned.has(name)) return undefined;
  const current = await readParameterMetadata(send, name);
  if (!current) return undefined;
  if (current.Parameter?.Type !== "String" && current.Parameter?.Type !== "SecureString") {
    throw new Error(`Owned DNS parameter ${name} has an invalid type.`);
  }
  return {
    name,
    action: "preserved",
    ...(Number.isSafeInteger(current.Parameter.Version) ? { version: current.Parameter.Version } : {}),
  };
};

const deleteDeselectedSecrets = async (
  send: Send,
  mode: string,
  owned: Map<string, OwnershipProof>
): Promise<DnsSecretMaterializationEvidence[]> => {
  const evidence: DnsSecretMaterializationEvidence[] = [];
  for (const provider of ["cloudflare", "duckdns"] as const) {
    if (provider === mode) continue;
    for (const name of providerParameters[provider]) {
      const preserved = await preserveOwnedSecret(send, name, owned);
      if (preserved) evidence.push(preserved);
    }
  }
  return evidence;
};

const writeSelectedSecrets = async (
  send: Send,
  selected: SecretMaterialization[],
  owned: Map<string, OwnershipProof>
): Promise<DnsSecretMaterializationEvidence[]> => {
  const evidence: DnsSecretMaterializationEvidence[] = [];
  for (const secret of selected) {
    const existing = await readParameterMetadata(send, secret.name);
    if (existing?.Parameter?.Type && existing.Parameter.Type !== "SecureString") {
      throw new Error(`DNS parameter ${secret.name} has the wrong type.`);
    }
    const proof = owned.get(secret.name);
    if (existing && !proof) {
      throw new Error(`DNS parameter ${secret.name} is pre-existing and ownership is not proven.`);
    }
    if (existing && existing.Parameter?.Version !== proof?.resourceVersion) {
      throw new Error(`DNS parameter ${secret.name} changed after the recorded ownership incarnation.`);
    }
    const response = await putParameterCas(send, secret.name, "SecureString", secret.value, existing);
    const version = response.Parameter?.Version;
    evidence.push({
      name: secret.name,
      action: existing ? "updated" : "created",
      ...(typeof version === "number" && Number.isSafeInteger(version) ? { version } : {}),
    });
  }
  return evidence;
};

export async function materializeDnsSecrets(
  environment: Record<string, string | undefined>,
  send: Send = createSender(environment)
): Promise<string[]> {
  const evidence = await materializeDnsSecretsWithEvidence(environment, send);
  return evidence.map((entry) => entry.name);
}

const selectedDnsMode = (environment: Record<string, string | undefined>, selected: SecretMaterialization[]): string =>
  environment.MC_CONNECTION_MODE?.trim() ||
  (selected[0]?.name.includes("duckdns") ? "duckdns" : selected.length ? "cloudflare" : "raw_ip");

const writeDnsMode = async (
  send: Send,
  mode: string,
  owned: Map<string, OwnershipProof>
): Promise<DnsSecretMaterializationEvidence> => {
  const modeName = "/minecraft/dns-mode";
  const existing = await readParameterMetadata(send, modeName);
  if (existing?.Parameter?.Type && existing.Parameter.Type !== "String") {
    throw new Error("DNS mode parameter has the wrong type.");
  }
  if (existing && !owned.has(modeName))
    throw new Error("DNS mode is pre-existing and ownership is not proven; refusing to overwrite it.");
  const response = await putParameterCas(send, modeName, "String", mode, existing);
  const version = response.Parameter?.Version;
  return {
    name: modeName,
    action: existing ? "updated" : "created",
    ...(typeof version === "number" && Number.isSafeInteger(version) ? { version } : {}),
  };
};

const materializeDnsSecretsLocked = async (
  environment: Record<string, string | undefined>,
  send: Send
): Promise<DnsSecretMaterializationEvidence[]> => {
  const selected = dnsSecretMaterializationPlan(environment);
  const mode = selectedDnsMode(environment, selected);
  const owned = readManifestOwnership(environment);
  const evidence = await deleteDeselectedSecrets(send, mode, owned);
  if (mode !== "raw_ip") evidence.push(...(await writeSelectedSecrets(send, selected, owned)));
  evidence.push(await writeDnsMode(send, mode, owned));
  return evidence;
};

export async function materializeDnsSecretsWithEvidence(
  environment: Record<string, string | undefined>,
  send: Send = createSender(environment)
): Promise<DnsSecretMaterializationEvidence[]> {
  return withMigrationLock(environment, () => materializeDnsSecretsLocked(environment, send));
}

async function main(): Promise<void> {
  try {
    const environmentFile = [".env.production", ".env.local"]
      .map((name) => path.resolve(process.cwd(), name))
      .find(existsSync);
    const explicitTarget = new Map(
      ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"]
        .map((name) => [name, process.env[name]] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    );
    if (environmentFile) dotenv.config({ path: environmentFile, override: true, quiet: true });
    for (const [name, value] of explicitTarget) process.env[name] = value;
    const evidence = await materializeDnsSecretsWithEvidence(process.env);
    for (const entry of evidence) console.log(`${entry.name}\t${entry.action}\t${entry.version ?? ""}`);
  } catch {
    console.error("DNS SecureString materialization failed; credential and provider details omitted.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
