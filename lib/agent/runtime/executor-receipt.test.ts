import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { BackupTerminalReceipt, ExecutorReceiptVerifier, ExecutorReceiptVerifierSet } from "@/lib/agent/contracts";
import { describe, expect, it } from "vitest";
import {
  executorReceiptSignedContent,
  hasExecutorReceiptVerifierReference,
  hasUnresolvedExecutorReceiptVerifierReference,
  parseBackupTerminalReceipt,
  parseExecutorReceiptVerifierSet,
  verifyExecutorTerminalReceipt,
} from "./executor-receipt";

function signingIdentity(): {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  verifier: ExecutorReceiptVerifier;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    verifier: {
      schemaVersion: 1,
      keyId: `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`,
      publicKeySpki: spki.toString("base64"),
    },
  };
}

function signedReceipt(identity: ReturnType<typeof signingIdentity>): BackupTerminalReceipt {
  const unsigned = {
    schemaVersion: 1,
    source: "executor-journal",
    proofKind: "terminal",
    outcome: "committed",
    executorKeyId: identity.verifier.keyId,
    executorKeyEpoch: identity.verifier.keyEpoch ?? 1,
    executorEpoch: "epoch-authoritative",
    runtimeId: "runtime-receipt",
    leaseId: "lease-receipt",
    leaseGeneration: 4,
    sessionId: "session-receipt",
    taskId: "task-receipt",
    invocationId: "invocation-receipt",
    invocationDigest: "a".repeat(64),
    backupId: "backup-receipt",
    lifecycleLockId: "lock-receipt",
    lifecycleFencingToken: 7,
    lifecycleLeaseGeneration: 3,
    resultDigest: "b".repeat(64),
    journalSequence: 12,
    completedAt: "2026-09-04T12:00:00.000Z",
    fenceIssuedAt: "2026-09-04T11:59:00.000Z",
  } as const;
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(executorReceiptSignedContent(unsigned)), identity.privateKey).toString(
      "base64url"
    ),
  };
}

function verifierSet(
  current: ExecutorReceiptVerifier,
  ...previous: ExecutorReceiptVerifier[]
): ExecutorReceiptVerifierSet {
  current.keyEpoch ??= previous.length > 0 ? 2 : 1;
  previous.forEach((item, index) => {
    item.keyEpoch ??= current.keyEpoch! - index - 1;
  });
  return {
    schemaVersion: 1,
    currentKeyId: current.keyId,
    verifiers: [
      { ...current },
      ...previous.map((item, _index) => ({
        ...item,
        keyEpoch: item.keyEpoch ?? 1,
        rotationCutoffAt: item.rotationCutoffAt ?? "2099-09-04T12:30:00.000Z",
      })),
    ],
  };
}

describe("executor terminal receipt verification", () => {
  it("accepts exact receipts from both current and retained rotation keys", async () => {
    const current = signingIdentity();
    const previous = signingIdentity();
    const set = verifierSet(current.verifier, previous.verifier);

    const currentReceipt = signedReceipt(current);
    const previousReceipt = signedReceipt(previous);
    await expect(
      verifyExecutorTerminalReceipt(currentReceipt, set, {
        executorKeyId: current.verifier.keyId,
        executorKeyEpoch: currentReceipt.executorKeyEpoch,
        issuedAt: currentReceipt.fenceIssuedAt,
      })
    ).resolves.toBe(true);
    await expect(
      verifyExecutorTerminalReceipt(previousReceipt, set, {
        executorKeyId: previous.verifier.keyId,
        executorKeyEpoch: previousReceipt.executorKeyEpoch,
        issuedAt: previousReceipt.fenceIssuedAt,
      })
    ).resolves.toBe(true);
  });

  it("accepts a retained key when the fence was issued before its cutoff", async () => {
    const current = signingIdentity();
    const previous = signingIdentity();
    const set = verifierSet(current.verifier, previous.verifier);
    const retained = signedReceipt(previous);

    await expect(
      verifyExecutorTerminalReceipt({ ...retained, fenceIssuedAt: "2099-09-04T12:31:00.000Z" }, set, {
        executorKeyId: previous.verifier.keyId,
        executorKeyEpoch: retained.executorKeyEpoch,
        issuedAt: retained.fenceIssuedAt,
      })
    ).resolves.toBe(false);
    const completedAfterCutoff = { ...retained, completedAt: "2099-09-04T12:31:00.000Z" };
    const { signature: _signature, ...unsigned } = completedAfterCutoff;
    await expect(
      verifyExecutorTerminalReceipt(
        {
          ...completedAfterCutoff,
          signature: sign(null, Buffer.from(executorReceiptSignedContent(unsigned)), previous.privateKey).toString(
            "base64url"
          ),
        },
        set,
        {
          executorKeyId: previous.verifier.keyId,
          executorKeyEpoch: completedAfterCutoff.executorKeyEpoch,
          issuedAt: completedAfterCutoff.fenceIssuedAt,
        }
      )
    ).resolves.toBe(true);
  });

  it("binds a terminal receipt to the fence's current key epoch", async () => {
    const current = signingIdentity();
    const previous = signingIdentity();
    const set = verifierSet(current.verifier, previous.verifier);
    const receipt = signedReceipt(current);

    await expect(
      verifyExecutorTerminalReceipt(receipt, set, {
        executorKeyId: previous.verifier.keyId,
        executorKeyEpoch: 1,
        issuedAt: receipt.fenceIssuedAt,
      })
    ).resolves.toBe(false);
    await expect(
      verifyExecutorTerminalReceipt(receipt, set, {
        executorKeyId: current.verifier.keyId,
        executorKeyEpoch: receipt.executorKeyEpoch,
        issuedAt: receipt.fenceIssuedAt,
      })
    ).resolves.toBe(true);
  });

  it("requires durable fence issuance authority and canonical receipt timestamps", async () => {
    const current = signingIdentity();
    const set = verifierSet(current.verifier);
    const receipt = signedReceipt(current);

    await expect(verifyExecutorTerminalReceipt(receipt, set)).resolves.toBe(false);
    await expect(
      verifyExecutorTerminalReceipt(receipt, set, {
        executorKeyId: current.verifier.keyId,
        executorKeyEpoch: receipt.executorKeyEpoch,
        issuedAt: receipt.fenceIssuedAt,
      })
    ).resolves.toBe(true);

    const nonCanonical = { ...receipt, fenceIssuedAt: "2026-09-04T11:59:00Z" };
    const { signature: _signature, ...unsigned } = nonCanonical;
    const resigned = {
      ...nonCanonical,
      signature: sign(null, Buffer.from(executorReceiptSignedContent(unsigned)), current.privateKey).toString(
        "base64url"
      ),
    };
    expect(() => parseBackupTerminalReceipt(resigned)).toThrow(/invalid/i);
  });

  it("rejects modified, forged, wrong-key, and unpinned receipts", async () => {
    const current = signingIdentity();
    const attacker = signingIdentity();
    const receipt = signedReceipt(current);
    const set = verifierSet(current.verifier);
    const modified = { ...receipt, lifecycleLeaseGeneration: receipt.lifecycleLeaseGeneration! + 1 };
    const wrongKey = { ...signedReceipt(attacker), executorKeyId: current.verifier.keyId };

    await expect(verifyExecutorTerminalReceipt(modified, set)).resolves.toBe(false);
    await expect(verifyExecutorTerminalReceipt({ ...receipt, signature: "A".repeat(86) }, set)).resolves.toBe(false);
    await expect(verifyExecutorTerminalReceipt(wrongKey, set)).resolves.toBe(false);
    await expect(verifyExecutorTerminalReceipt(signedReceipt(attacker), set)).resolves.toBe(false);
  });

  it("bounds verifier rotation history", () => {
    const identities = Array.from({ length: 4 }, signingIdentity);
    expect(() =>
      parseExecutorReceiptVerifierSet({
        schemaVersion: 1,
        currentKeyId: identities[0].verifier.keyId,
        verifiers: identities.map(({ verifier }) => verifier),
      })
    ).toThrow(/invalid/i);
  });

  it("blocks verifier removal only for the exact durable key ID and epoch", () => {
    const current = signingIdentity();
    const operation = {
      agentFenceAuthorization: { executorKeyId: current.verifier.keyId, executorKeyEpoch: 4 },
      nested: [{ executorKeyId: current.verifier.keyId, executorKeyEpoch: 3 }],
    };
    expect(hasExecutorReceiptVerifierReference(operation, current.verifier.keyId, 4)).toBe(true);
    expect(hasExecutorReceiptVerifierReference(operation, current.verifier.keyId, 2)).toBe(false);
  });

  it("keeps a retiring key live for committed results, handoffs, and fences until terminal evidence exists", () => {
    const current = signingIdentity();
    const keyId = current.verifier.keyId;
    expect(
      hasUnresolvedExecutorReceiptVerifierReference({ status: "committed", result: { status: "succeeded" } }, keyId, 1)
    ).toBe(true);
    expect(
      hasUnresolvedExecutorReceiptVerifierReference(
        { state: "dispatching", backupAuthorization: { executorKeyId: keyId, executorKeyEpoch: 1 } },
        keyId,
        1
      )
    ).toBe(true);
    expect(
      hasUnresolvedExecutorReceiptVerifierReference(
        {
          status: "succeeded",
          backupId: "backup",
          lifecycleLockId: "lock",
          executorKeyId: keyId,
          executorKeyEpoch: 1,
        },
        keyId,
        1
      )
    ).toBe(true);
    expect(hasUnresolvedExecutorReceiptVerifierReference({ publicationRevision: 4 }, keyId, 1)).toBe(true);
    expect(hasUnresolvedExecutorReceiptVerifierReference({ terminalReceipt: signedReceipt(current) }, keyId, 1)).toBe(
      false
    );
  });
});
