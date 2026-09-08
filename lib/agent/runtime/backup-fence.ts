import { canonicalJson } from "@/lib/agent/canonical-json";
import type { BackupFenceAuthorization } from "@/lib/agent/contracts";
import { parseExecutorReceiptVerifierSetJson } from "@/lib/agent/runtime/executor-receipt";
export { parseBackupTerminalReceipt } from "@/lib/agent/runtime/executor-receipt";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

/** Short renewable permit; it is checked again by the executor immediately before commit. */
export const BACKUP_FENCE_AUTHORIZATION_MS = 60_000;
export const BACKUP_FENCE_RENEW_INTERVAL_MS = 20_000;
/** Longer than RuntimeMaxSec + hard-stop + restart in mc-agent-executor.service. */
export const BACKUP_FENCE_EFFECT_MARGIN_MS = 25 * 60_000;

export type UnsignedBackupFenceAuthorization = Omit<BackupFenceAuthorization, "signature">;

export function backupFenceSignedContent(value: UnsignedBackupFenceAuthorization): string {
  return canonicalJson(value);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 4096) {
    throw new Error("Backup fence signing key is invalid.");
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function base64Url(value: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64url");
  let raw = "";
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signingKey(): Promise<CryptoKey> {
  const encoded = process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8?.trim() ?? "";
  if (!encoded) throw new Error("Backup fence signing is unavailable.");
  const decoded = decodeBase64(encoded);
  const keyBytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
  return await crypto.subtle.importKey("pkcs8", keyBytes, { name: "Ed25519" }, false, ["sign"]);
}

export function parseBackupFenceAuthorization(value: unknown): BackupFenceAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Backup fence authorization is invalid.");
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "status",
    "authorizationId",
    "runtimeId",
    "leaseId",
    "leaseGeneration",
    "sessionId",
    "taskId",
    "invocationId",
    "invocationDigest",
    "backupId",
    "lifecycleLockId",
    "lifecycleFencingToken",
    "lifecycleLeaseGeneration",
    "lifecycleLeaseExpiresAt",
    "executorKeyId",
    "executorKeyEpoch",
    "issuedAt",
    "expiresAt",
    "signature",
  ];
  if (
    !Object.keys(item).every((key) => keys.includes(key)) ||
    ![
      "schemaVersion",
      "status",
      "authorizationId",
      "runtimeId",
      "leaseId",
      "leaseGeneration",
      "sessionId",
      "taskId",
      "invocationId",
      "invocationDigest",
      "backupId",
      "lifecycleLockId",
      "lifecycleFencingToken",
      "lifecycleLeaseGeneration",
      "lifecycleLeaseExpiresAt",
      "issuedAt",
      "expiresAt",
      "signature",
    ].every((key) => key in item) ||
    item.schemaVersion !== 1 ||
    item.status !== "succeeded" ||
    ![
      item.authorizationId,
      item.runtimeId,
      item.leaseId,
      item.sessionId,
      item.taskId,
      item.invocationId,
      item.backupId,
      item.lifecycleLockId,
    ].every((candidate) => typeof candidate === "string" && ID.test(candidate)) ||
    typeof item.leaseGeneration !== "number" ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    item.leaseGeneration < 1 ||
    typeof item.lifecycleFencingToken !== "number" ||
    !Number.isSafeInteger(item.lifecycleFencingToken) ||
    item.lifecycleFencingToken < 1 ||
    typeof item.lifecycleLeaseGeneration !== "number" ||
    !Number.isSafeInteger(item.lifecycleLeaseGeneration) ||
    item.lifecycleLeaseGeneration < 1 ||
    typeof item.invocationDigest !== "string" ||
    !SHA256.test(item.invocationDigest) ||
    typeof item.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(item.issuedAt)) ||
    typeof item.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    Date.parse(item.expiresAt) <= Date.parse(item.issuedAt) ||
    typeof item.lifecycleLeaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.lifecycleLeaseExpiresAt)) ||
    Date.parse(item.expiresAt) > Date.parse(item.lifecycleLeaseExpiresAt) - BACKUP_FENCE_EFFECT_MARGIN_MS ||
    (item.executorKeyId !== undefined && (typeof item.executorKeyId !== "string" || !ID.test(item.executorKeyId))) ||
    (item.executorKeyEpoch !== undefined &&
      (typeof item.executorKeyEpoch !== "number" ||
        !Number.isSafeInteger(item.executorKeyEpoch) ||
        item.executorKeyEpoch < 1)) ||
    typeof item.signature !== "string" ||
    !SIGNATURE.test(item.signature)
  ) {
    throw new Error("Backup fence authorization is invalid.");
  }
  return item as unknown as BackupFenceAuthorization;
}

export async function signBackupFenceAuthorization(
  value: UnsignedBackupFenceAuthorization
): Promise<BackupFenceAuthorization> {
  const configuredVerifiers = process.env.MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS?.trim();
  let boundValue = value;
  if (configuredVerifiers) {
    const verifierSet = parseExecutorReceiptVerifierSetJson(configuredVerifiers);
    const current = verifierSet.verifiers.find(({ keyId }) => keyId === verifierSet.currentKeyId);
    if (!current) throw new Error("Backup fence signing is unavailable.");
    const keyEpoch = current.keyEpoch ?? 1;
    if (
      (value.executorKeyId !== undefined && value.executorKeyId !== current.keyId) ||
      (value.executorKeyEpoch !== undefined && value.executorKeyEpoch !== keyEpoch)
    ) {
      throw new Error("Backup fence signing key epoch is retired or stale.");
    }
    boundValue = { ...value, executorKeyId: current.keyId, executorKeyEpoch: keyEpoch };
  }
  const signature = await signFenceContent(boundValue);
  return parseBackupFenceAuthorization({ ...boundValue, signature: base64Url(signature) });
}

async function signFenceContent(value: UnsignedBackupFenceAuthorization): Promise<ArrayBuffer> {
  return await crypto.subtle.sign(
    { name: "Ed25519" },
    await signingKey(),
    new TextEncoder().encode(backupFenceSignedContent(value))
  );
}

export async function verifyBackupFenceAuthorizationSignature(value: BackupFenceAuthorization): Promise<boolean> {
  let parsed: BackupFenceAuthorization;
  try {
    parsed = parseBackupFenceAuthorization(value);
    const configuredVerifiers = process.env.MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS?.trim();
    if (configuredVerifiers) {
      const verifierSet = parseExecutorReceiptVerifierSetJson(configuredVerifiers);
      const verifier = verifierSet.verifiers.find(({ keyId }) => keyId === parsed.executorKeyId);
      const current = verifierSet.verifiers.find(({ keyId }) => keyId === verifierSet.currentKeyId);
      if (
        !verifier ||
        !current ||
        parsed.executorKeyEpoch !== verifier.keyEpoch ||
        (verifier.keyId !== current.keyId &&
          (!verifier.rotationCutoffAt || Date.parse(parsed.issuedAt) > Date.parse(verifier.rotationCutoffAt)))
      ) {
        return false;
      }
    }
    const { signature, ...unsigned } = parsed;
    const expected = base64Url(await signFenceContent(unsigned));
    const actualBytes = new TextEncoder().encode(signature);
    const expectedBytes = new TextEncoder().encode(expected);
    if (actualBytes.length !== expectedBytes.length) return false;
    let difference = 0;
    for (let index = 0; index < actualBytes.length; index++) difference |= actualBytes[index] ^ expectedBytes[index];
    return difference === 0;
  } catch {
    return false;
  }
}
