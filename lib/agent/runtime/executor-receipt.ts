import { canonicalJson } from "@/lib/agent/canonical-json";
import type { BackupTerminalReceipt, ExecutorReceiptVerifier, ExecutorReceiptVerifierSet } from "@/lib/agent/contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const MAX_EXECUTOR_RECEIPT_VERIFIERS = 3;

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function base64Bytes(value: string, label: string): Uint8Array {
  if (!BASE64.test(value) || value.length > 256) throw new Error(`${label} is invalid.`);
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function base64UrlBytes(value: string): Uint8Array {
  if (!SIGNATURE.test(value)) throw new Error("Executor terminal receipt signature is invalid.");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export type UnsignedBackupTerminalReceipt = Omit<BackupTerminalReceipt, "signature">;

export function executorReceiptSignedContent(value: UnsignedBackupTerminalReceipt): string {
  return `mc-aws-executor-terminal-receipt:v1\n${canonicalJson(value)}`;
}

export function parseBackupTerminalReceipt(value: unknown): BackupTerminalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backup terminal receipt is invalid.");
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "source",
    "proofKind",
    "outcome",
    "executorKeyId",
    "executorKeyEpoch",
    "executorEpoch",
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
    "resultDigest",
    "journalSequence",
    "completedAt",
    "signature",
    "fenceIssuedAt",
  ];
  const hasFence = item.backupId !== undefined;
  const hasCompleteFence =
    typeof item.backupId === "string" &&
    ID.test(item.backupId) &&
    typeof item.lifecycleLockId === "string" &&
    ID.test(item.lifecycleLockId) &&
    typeof item.lifecycleFencingToken === "number" &&
    Number.isSafeInteger(item.lifecycleFencingToken) &&
    item.lifecycleFencingToken >= 1 &&
    typeof item.lifecycleLeaseGeneration === "number" &&
    Number.isSafeInteger(item.lifecycleLeaseGeneration) &&
    item.lifecycleLeaseGeneration >= 1;
  if (
    !Object.keys(item).every((key) => keys.includes(key)) ||
    ![
      "schemaVersion",
      "source",
      "proofKind",
      "outcome",
      "executorKeyId",
      "executorEpoch",
      "runtimeId",
      "leaseId",
      "leaseGeneration",
      "sessionId",
      "taskId",
      "invocationId",
      "invocationDigest",
      "resultDigest",
      "journalSequence",
      "completedAt",
      "signature",
    ].every((key) => key in item) ||
    item.schemaVersion !== 1 ||
    item.source !== "executor-journal" ||
    (item.proofKind !== "terminal" && item.proofKind !== "clean-start-no-active") ||
    !["committed", "failed", "cancelled", "indeterminate"].includes(String(item.outcome)) ||
    ![
      item.executorKeyId,
      item.executorEpoch,
      item.runtimeId,
      item.leaseId,
      item.sessionId,
      item.taskId,
      item.invocationId,
    ].every((candidate) => typeof candidate === "string" && ID.test(candidate)) ||
    typeof item.leaseGeneration !== "number" ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    item.leaseGeneration < 1 ||
    (hasFence && !hasCompleteFence) ||
    (!hasFence &&
      (item.lifecycleLockId !== undefined ||
        item.lifecycleFencingToken !== undefined ||
        item.lifecycleLeaseGeneration !== undefined ||
        item.fenceIssuedAt !== undefined)) ||
    typeof item.journalSequence !== "number" ||
    !Number.isSafeInteger(item.journalSequence) ||
    item.journalSequence < 1 ||
    typeof item.invocationDigest !== "string" ||
    !SHA256.test(item.invocationDigest) ||
    typeof item.resultDigest !== "string" ||
    !SHA256.test(item.resultDigest) ||
    !isCanonicalTimestamp(item.completedAt) ||
    typeof item.signature !== "string" ||
    !SIGNATURE.test(item.signature) ||
    (item.executorKeyEpoch !== undefined &&
      (typeof item.executorKeyEpoch !== "number" ||
        !Number.isSafeInteger(item.executorKeyEpoch) ||
        item.executorKeyEpoch < 1)) ||
    (item.proofKind === "clean-start-no-active" && item.outcome !== "failed") ||
    (hasFence && !isCanonicalTimestamp(item.fenceIssuedAt))
  ) {
    throw new Error("Backup terminal receipt is invalid.");
  }
  return item as unknown as BackupTerminalReceipt;
}

function parseVerifier(value: unknown): ExecutorReceiptVerifier {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor receipt verifier is invalid.");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["schemaVersion", "keyId", "publicKeySpki", "keyEpoch", "rotationCutoffAt"].includes(key)
    ) ||
    !["schemaVersion", "keyId", "publicKeySpki"].every((key) => key in item) ||
    item.schemaVersion !== 1 ||
    typeof item.keyId !== "string" ||
    !ID.test(item.keyId) ||
    typeof item.publicKeySpki !== "string" ||
    (item.keyEpoch !== undefined &&
      (typeof item.keyEpoch !== "number" || !Number.isSafeInteger(item.keyEpoch) || item.keyEpoch < 1)) ||
    (item.rotationCutoffAt !== undefined &&
      (typeof item.rotationCutoffAt !== "string" || !Number.isFinite(Date.parse(item.rotationCutoffAt))))
  ) {
    throw new Error("Executor receipt verifier is invalid.");
  }
  const bytes = base64Bytes(item.publicKeySpki, "Executor receipt verifier");
  if (bytes.byteLength !== 44) throw new Error("Executor receipt verifier is invalid.");
  return { ...item, ...(item.keyEpoch === undefined ? { keyEpoch: 1 } : {}) } as unknown as ExecutorReceiptVerifier;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verifier-set parsing keeps the bounded history and epoch invariants at one trust boundary.
export function parseExecutorReceiptVerifierSet(value: unknown): ExecutorReceiptVerifierSet {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor receipt verifier set is invalid.");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 3 ||
    item.schemaVersion !== 1 ||
    typeof item.currentKeyId !== "string" ||
    !ID.test(item.currentKeyId) ||
    !Array.isArray(item.verifiers) ||
    item.verifiers.length < 1 ||
    item.verifiers.length > MAX_EXECUTOR_RECEIPT_VERIFIERS
  ) {
    throw new Error("Executor receipt verifier set is invalid.");
  }
  const verifiers = item.verifiers.map(parseVerifier);
  if (new Set(verifiers.map(({ keyId }) => keyId)).size !== verifiers.length) {
    throw new Error("Executor receipt verifier IDs must be unique.");
  }
  if (!verifiers.some(({ keyId }) => keyId === item.currentKeyId)) {
    throw new Error("Current executor receipt verifier is missing.");
  }
  const current = verifiers.find(({ keyId }) => keyId === item.currentKeyId)!;
  if (verifiers[0].keyId !== item.currentKeyId) {
    throw new Error("Current executor receipt verifier must be first.");
  }
  const epochs = new Set<number>();
  for (const verifier of verifiers) {
    if (epochs.has(verifier.keyEpoch!)) throw new Error("Executor receipt verifier epochs must be unique.");
    epochs.add(verifier.keyEpoch!);
    if (verifier.keyEpoch! > current.keyEpoch!) throw new Error("Executor receipt verifier epoch is invalid.");
    if (verifier.keyId === item.currentKeyId) {
      if (verifier.rotationCutoffAt !== undefined)
        throw new Error("Current executor receipt verifier cannot be retired.");
    } else {
      if (!verifier.rotationCutoffAt)
        throw new Error("Retained executor receipt verifiers require an explicit rotation cutoff.");
      if (!Number.isFinite(Date.parse(verifier.rotationCutoffAt))) {
        throw new Error("Executor receipt verifier rotation cutoff is invalid.");
      }
    }
  }
  return { schemaVersion: 1, currentKeyId: item.currentKeyId, verifiers } as ExecutorReceiptVerifierSet;
}

export function parseExecutorReceiptVerifierSetJson(value: string): ExecutorReceiptVerifierSet {
  if (!value || value.length > 4096) throw new Error("Executor receipt verifier set is invalid.");
  return parseExecutorReceiptVerifierSet(JSON.parse(value) as unknown);
}

/** Finds an exact durable handoff/fence reference before a verifier is evicted. */
export function hasExecutorReceiptVerifierReference(value: unknown, keyId: string, keyEpoch: number): boolean {
  if (Array.isArray(value)) return value.some((item) => hasExecutorReceiptVerifierReference(item, keyId, keyEpoch));
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.executorKeyId === keyId && item.executorKeyEpoch === keyEpoch) return true;
  return Object.values(item).some((child) => hasExecutorReceiptVerifierReference(child, keyId, keyEpoch));
}

function isCompleteTerminalReceipt(value: Record<string, unknown>): boolean {
  return (
    value.source === "executor-journal" &&
    (value.proofKind === "terminal" || value.proofKind === "clean-start-no-active") &&
    typeof value.executorKeyId === "string" &&
    typeof value.executorKeyEpoch === "number" &&
    typeof value.signature === "string" &&
    value.signature.length === 86 &&
    typeof value.journalSequence === "number" &&
    typeof value.resultDigest === "string"
  );
}

/**
 * Finds references that can still require the retiring private key.
 *
 * A durable terminal receipt is safe to retain after key rotation: it is
 * already signed and can be verified with the public verifier.  Everything
 * before that boundary is deliberately conservative.  In particular, a
 * committed executor result without a receipt, an active gateway handoff,
 * an active backup fence, or an invocation proposal without terminal
 * publication evidence may still need the old signer during crash recovery.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This trust-boundary predicate keeps every unresolved durable-reference class fail-closed.
export function hasUnresolvedExecutorReceiptVerifierReference(
  value: unknown,
  keyId: string,
  keyEpoch: number
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnresolvedExecutorReceiptVerifierReference(item, keyId, keyEpoch));
  }
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  if (isCompleteTerminalReceipt(item)) return false;
  if (item.executorKeyId === keyId && item.executorKeyEpoch === keyEpoch) return true;

  const hasResult = item.result !== undefined || item.terminalResult !== undefined;
  if (item.status === "committed" && hasResult && item.terminalReceipt === undefined) return true;

  const gatewayHandoffStates = new Set(["awaiting-backup", "awaiting-executor", "dispatching"]);
  if (typeof item.state === "string" && gatewayHandoffStates.has(item.state) && item.terminalReceipt === undefined) {
    return true;
  }

  if (
    typeof item.backupId === "string" &&
    typeof item.lifecycleLockId === "string" &&
    item.terminalReceipt === undefined &&
    (item.status === "succeeded" || item.authorizationId !== undefined)
  ) {
    return true;
  }

  if (item.publicationRevision !== undefined && item.terminalReceipt === undefined) return true;

  if (item.activeRuntimeInvocation !== undefined && item.runtimeRecoveries === undefined) return true;

  return Object.entries(item).some(([key, child]) => {
    // The receipt itself is the durable boundary.  Do not rediscover its key
    // as an unresolved reference through the nested terminalReceipt object.
    if (key === "terminalReceipt" && child && typeof child === "object" && !Array.isArray(child)) {
      return false;
    }
    return hasUnresolvedExecutorReceiptVerifierReference(child, keyId, keyEpoch);
  });
}

export async function verifyExecutorTerminalReceipt(
  receipt: BackupTerminalReceipt,
  verifierSet: ExecutorReceiptVerifierSet,
  authorization?: { executorKeyId?: string; executorKeyEpoch?: number; issuedAt?: string }
): Promise<boolean> {
  const parsed = parseBackupTerminalReceipt(receipt);
  const parsedSet = parseExecutorReceiptVerifierSet(verifierSet);
  const verifiers = parsedSet.verifiers;
  const verifier = verifiers.find(({ keyId }) => keyId === parsed.executorKeyId);
  if (!verifier) return false;
  if (
    authorization &&
    (authorization.executorKeyId !== parsed.executorKeyId ||
      authorization.executorKeyEpoch !== parsed.executorKeyEpoch ||
      !isCanonicalTimestamp(authorization.issuedAt) ||
      parsed.fenceIssuedAt !== authorization.issuedAt)
  ) {
    return false;
  }
  if (parsed.backupId !== undefined && !authorization) return false;
  // Production receipts always carry the exact key epoch. Do not let a receipt
  // select a verifier by ID alone: an old key must never be interchangeable
  // with another generation of the same control-plane handoff.
  if (parsed.executorKeyEpoch !== verifier.keyEpoch) return false;
  if (verifier.keyId !== parsedSet.currentKeyId) {
    const cutoff = verifier.rotationCutoffAt;
    if (!cutoff || !parsed.fenceIssuedAt || Date.parse(parsed.fenceIssuedAt) > Date.parse(cutoff)) {
      return false;
    }
  }
  const { signature, ...unsigned } = parsed;
  try {
    const publicBytes = asArrayBuffer(base64Bytes(verifier.publicKeySpki, "Executor receipt verifier"));
    const digest = await crypto.subtle.digest("SHA-256", publicBytes);
    const derivedKeyId = `executor-receipt-${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
    if (verifier.keyId !== derivedKeyId) return false;
    const publicKey = await crypto.subtle.importKey("spki", publicBytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      asArrayBuffer(base64UrlBytes(signature)),
      asArrayBuffer(new TextEncoder().encode(executorReceiptSignedContent(unsigned)))
    );
  } catch {
    return false;
  }
}
