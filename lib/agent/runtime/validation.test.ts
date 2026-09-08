import { parseEvents, parseRuntimeBackupRequest } from "@/lib/agent/runtime/validation";
import { describe, expect, it } from "vitest";

const draft = {
  schemaVersion: 1,
  sessionId: "session-1",
  taskId: "task-1",
  expectedRevision: 1,
  idempotencyKey: "event-1",
  drafts: [
    {
      schemaVersion: 1,
      draftId: "draft-1",
      ordinal: 1,
      timestamp: "2026-09-02T12:00:00.000Z",
      kind: "model",
      payload: { safe: true },
    },
  ],
};

describe("runtime event publication validation", () => {
  it.each([
    "sessionToken",
    "session_token",
    "AWS_SESSION_TOKEN",
    "clientSecret",
    "oauth-client-secret",
    "private.key",
    "private_key_pem",
  ])("rejects normalized sensitive key %s before publication", (key) => {
    const input = structuredClone(draft);
    input.drafts[0].payload = { nested: { [key]: "raw-secret" } } as never;
    expect(() => parseEvents(input)).toThrow("Invalid agent runtime request");
  });

  it("requires an exact executor terminal receipt for every releasing finalization", () => {
    const authorization = {
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "authorization-validation",
      runtimeId: "runtime-validation",
      leaseId: "lease-validation",
      leaseGeneration: 1,
      sessionId: "session-validation",
      taskId: "task-validation",
      invocationId: "invocation-validation",
      invocationDigest: "a".repeat(64),
      backupId: "backup-validation",
      lifecycleLockId: "lock-validation",
      lifecycleFencingToken: 1,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
      issuedAt: "2026-09-02T12:00:00.000Z",
      expiresAt: "2099-09-02T12:01:00.000Z",
      signature: "A".repeat(86),
    };
    expect(() =>
      parseRuntimeBackupRequest({ schemaVersion: 1, action: "finalize", authorization, outcome: "committed" })
    ).toThrow("Invalid agent runtime request");
    expect(
      parseRuntimeBackupRequest({
        schemaVersion: 1,
        action: "finalize",
        authorization,
        outcome: "indeterminate",
      })
    ).toMatchObject({ outcome: "indeterminate" });
  });
});
