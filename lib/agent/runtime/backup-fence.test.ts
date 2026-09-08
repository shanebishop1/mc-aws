import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { BackupFenceAuthorization, ExecutorReceiptVerifier } from "@/lib/agent/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backupFenceSignedContent,
  parseBackupFenceAuthorization,
  signBackupFenceAuthorization,
  verifyBackupFenceAuthorizationSignature,
} from "./backup-fence";

function receiptVerifier() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
  const verifier: ExecutorReceiptVerifier = {
    schemaVersion: 1,
    keyId: `executor-receipt-${createHash("sha256").update(publicKeySpki).digest("hex")}`,
    publicKeySpki: publicKeySpki.toString("base64"),
  };
  return { privateKey, verifier };
}

function unsignedFence(verifier: ExecutorReceiptVerifier): Omit<BackupFenceAuthorization, "signature"> {
  return {
    schemaVersion: 1,
    status: "succeeded",
    authorizationId: "fence-rotation",
    runtimeId: "runtime-rotation",
    leaseId: "lease-rotation",
    leaseGeneration: 1,
    sessionId: "session-rotation",
    taskId: "task-rotation",
    invocationId: "invocation-rotation",
    invocationDigest: "a".repeat(64),
    backupId: "backup-rotation",
    lifecycleLockId: "lock-rotation",
    lifecycleFencingToken: 1,
    lifecycleLeaseGeneration: 1,
    lifecycleLeaseExpiresAt: "2026-09-05T13:00:00.000Z",
    executorKeyId: verifier.keyId,
    executorKeyEpoch: verifier.keyEpoch ?? 1,
    issuedAt: "2026-09-05T11:59:00.000Z",
    expiresAt: "2026-09-05T12:00:00.000Z",
  };
}

function signFence(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  value: Omit<BackupFenceAuthorization, "signature">
): BackupFenceAuthorization {
  return parseBackupFenceAuthorization({
    ...value,
    signature: sign(null, Buffer.from(backupFenceSignedContent(value)), privateKey).toString("base64url"),
  });
}

describe("backup fence receipt-key rotation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("verifies an exact outstanding old fence while issuing only the current key", async () => {
    const fenceKeys = generateKeyPairSync("ed25519");
    const old = receiptVerifier();
    const current = receiptVerifier();
    old.verifier.keyEpoch = 1;
    current.verifier.keyEpoch = 2;
    old.verifier.rotationCutoffAt = "2026-09-05T12:30:00.000Z";
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    vi.stubEnv(
      "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS",
      JSON.stringify({
        schemaVersion: 1,
        currentKeyId: current.verifier.keyId,
        verifiers: [current.verifier, old.verifier],
      })
    );

    const oldFence = signFence(fenceKeys.privateKey, unsignedFence(old.verifier));
    await expect(verifyBackupFenceAuthorizationSignature(oldFence)).resolves.toBe(true);
    await expect(
      signBackupFenceAuthorization({ ...unsignedFence(old.verifier), issuedAt: "2026-09-05T12:31:00.000Z" })
    ).rejects.toThrow(/retired|stale/i);
    await expect(signBackupFenceAuthorization(unsignedFence(current.verifier))).resolves.toMatchObject({
      executorKeyId: current.verifier.keyId,
      executorKeyEpoch: 2,
    });
  });

  it("rejects a current fence relabeled with a retired key or epoch", async () => {
    const fenceKeys = generateKeyPairSync("ed25519");
    const old = receiptVerifier();
    const current = receiptVerifier();
    old.verifier.keyEpoch = 1;
    old.verifier.rotationCutoffAt = "2026-09-05T12:30:00.000Z";
    current.verifier.keyEpoch = 2;
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    vi.stubEnv(
      "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS",
      JSON.stringify({
        schemaVersion: 1,
        currentKeyId: current.verifier.keyId,
        verifiers: [current.verifier, old.verifier],
      })
    );
    const relabeled = signFence(fenceKeys.privateKey, {
      ...unsignedFence(old.verifier),
      executorKeyId: old.verifier.keyId,
      executorKeyEpoch: old.verifier.keyEpoch,
      issuedAt: "2026-09-05T12:31:00.000Z",
      expiresAt: "2026-09-05T12:32:00.000Z",
    });
    await expect(verifyBackupFenceAuthorizationSignature(relabeled)).resolves.toBe(false);
  });
});
