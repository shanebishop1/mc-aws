import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, dynamodb: { send: mocks.send } };
});

import {
  claimOperationExecution,
  claimResumeIntentPointer,
  heartbeatOperationExecution,
  recordOperationRemoteCommandIdentity,
  updateOperationState,
} from "./operation-state.js";

const dispatchingState = {
  id: "op-1",
  type: "backup",
  route: "/api/backup",
  status: "accepted",
  phase: "dispatching",
  requestedAt: "2026-04-13T12:00:00.000Z",
  updatedAt: "2026-04-13T12:00:00.000Z",
  history: [],
};

describe("DynamoDB operation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operations-table");
  });

  it("claims one execution with optimistic version ownership", async () => {
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(dispatchingState) }, version: { N: "3" } } })
      .mockResolvedValueOnce({});

    const claim = await claimOperationExecution({
      operationId: "op-1",
      command: "backup",
      executionToken: "op-1:execution",
      lockId: "lock-1",
      fencingToken: 4,
      instanceId: "i-123",
      userEmail: "admin@example.com",
    });

    expect(claim.claimed).toBe(true);
    expect(mocks.send.mock.calls[1][0].input.ConditionExpression).toBe("#version = :expected");
    expect(JSON.parse(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":payload"].S)).toMatchObject({
      schemaVersion: 1,
      status: "running",
      phase: "executing",
      executionToken: "op-1:execution",
      fencingToken: 4,
    });
  });

  it("persists exact hibernate volume lineage and authenticated backup deletion evidence", async () => {
    const existing = {
      ...dispatchingState,
      type: "hibernate",
      route: "/api/hibernate",
      status: "running",
      phase: "executing",
      instanceId: "i-1234567890abcdef0",
      executionToken: "hibernate-op:execution",
    };
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(existing) }, version: { N: "3" } } })
      .mockResolvedValueOnce({});

    await updateOperationState({
      operationId: "op-1",
      command: "hibernate",
      status: "running",
      phase: "executing",
      expectedExecutionToken: "hibernate-op:execution",
      instanceId: "i-1234567890abcdef0",
      managedVolumeId: "vol-1234567890abcdef0",
      managedVolumeDevice: "/dev/xvda",
      hibernateOriginalInstanceId: "i-1234567890abcdef0",
      hibernateSourceImageId: "ami-1234567890abcdef0",
      hibernateReconstructionSnapshotId: "snap-1234567890abcdef0",
      hibernatePhase: "detached",
      hibernateBackupId: "a".repeat(32),
      hibernateBackupDigest: "b".repeat(64),
      hibernateBackupSize: 42,
      hibernateBackupGeneration: 7,
      hibernateBackupCreatedAt: "2026-04-13T12:00:00.000Z",
      hibernateBackupOperationKey: "c".repeat(64),
      hibernateBackupInstanceId: "i-1234567890abcdef0",
      hibernateBackupServerId: "stack-identity",
      hibernateBackupArchiveName: "hibernate.tar.gz",
      hibernateBackupAuthenticationKeyId: "key-old",
      hibernateQuiescenceEvidence: { rootVolumeId: "vol-1234567890abcdef0" },
    });

    expect(JSON.parse(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":payload"].S)).toMatchObject({
      managedVolumeId: "vol-1234567890abcdef0",
      hibernateOriginalInstanceId: "i-1234567890abcdef0",
      hibernateSourceImageId: "ami-1234567890abcdef0",
      hibernateReconstructionSnapshotId: "snap-1234567890abcdef0",
      hibernateBackupOperationKey: "c".repeat(64),
      hibernateBackupServerId: "stack-identity",
      hibernateBackupAuthenticationKeyId: "key-old",
    });
  });

  it("preserves the exact agent backup handoff binding through Lambda execution transitions", async () => {
    const binding = {
      agentRuntimeId: "runtime-a",
      agentSessionId: "session-a",
      agentTaskId: "task-a",
      agentLeaseId: "lease-a",
      agentLeaseGeneration: 3,
      agentInvocationId: "invocation-a",
      agentInvocationDigest: "a".repeat(64),
      lockLeaseGeneration: 2,
      lockLeaseExpiresAt: "2026-04-13T13:30:00.000Z",
      requestIdempotencyKey: "op-1",
      dispatchOwnerId: "owner-agent",
      agentEffectReconciliationStatus: "awaiting-executor",
      agentEffectReconciliationUpdatedAt: "2026-04-13T12:00:00.000Z",
      agentEffectSafetyExpiresAt: "2026-04-13T12:04:00.000Z",
      agentFenceAuthorization: {
        status: "succeeded",
        lifecycleLeaseGeneration: 2,
      },
    };
    mocks.send
      .mockResolvedValueOnce({
        Item: {
          payload: {
            S: JSON.stringify({
              ...dispatchingState,
              route: "/api/agent/runtime/backups",
              ...binding,
            }),
          },
          version: { N: "3" },
        },
      })
      .mockResolvedValueOnce({});

    await claimOperationExecution({
      operationId: "op-1",
      command: "backup",
      executionToken: "op-1:execution",
    });

    expect(JSON.parse(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":payload"].S)).toMatchObject(
      binding
    );
  });

  it("rejects persisted records from an unknown schema version", async () => {
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: { S: JSON.stringify({ ...dispatchingState, schemaVersion: 2 }) },
        version: { N: "3" },
      },
    });

    await expect(
      claimOperationExecution({ operationId: "op-1", command: "backup", executionToken: "op-1:execution" })
    ).rejects.toThrow("malformed durable state");
  });

  it("does not let an old resume worker replace a newer active pointer owner", async () => {
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: {
          S: JSON.stringify({
            ...dispatchingState,
            type: "resume",
            route: "/api/resume",
            status: "running",
            phase: "executing",
            executionToken: "new-owner",
          }),
        },
        version: { N: "4" },
      },
    });

    await expect(
      claimResumeIntentPointer({
        operationId: "op-1",
        ownerToken: "old-owner",
        operationVersion: 3,
        intent: { mode: "latest" },
      })
    ).rejects.toThrow("Resume operation execution ownership changed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("rebinds a same-operation pointer from a stale execution token", async () => {
    const state = {
      ...dispatchingState,
      type: "resume",
      route: "/api/resume",
      status: "running",
      phase: "executing",
      executionToken: "owner-a",
    };
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(state) }, version: { N: "4" } } })
      .mockResolvedValueOnce({
        Item: {
          payload: {
            S: JSON.stringify({
              schemaVersion: 1,
              kind: "mc-aws-resume-intent",
              operationId: "op-1",
              ownerToken: "owner-old",
              status: "active",
              intent: { mode: "latest" },
              version: 2,
              updatedAt: "2026-04-13T12:00:00.000Z",
            }),
          },
          version: { N: "2" },
        },
      })
      .mockResolvedValueOnce({});

    await claimResumeIntentPointer({
      operationId: "op-1",
      ownerToken: "owner-a",
      operationVersion: 4,
      intent: { mode: "latest" },
    });

    expect(mocks.send.mock.calls[2][0].input.ConditionExpression).toContain("ownerToken = :previousOwnerToken");
    expect(mocks.send.mock.calls[2][0].input.ExpressionAttributeValues[":previousOwnerToken"]).toEqual({
      S: "owner-old",
    });
  });

  it.each([
    { executionAttempt: 0 },
    { executionLeaseExpiresAt: "not-a-date" },
    { sideEffectCompletedAt: 123 },
    { remoteCommandFinal: "yes" },
    { fencingToken: 1.5 },
  ])("rejects malformed optional execution metadata: %j", async (invalid) => {
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: { S: JSON.stringify({ ...dispatchingState, schemaVersion: 1, ...invalid }) },
        version: { N: "3" },
      },
    });

    await expect(
      claimOperationExecution({ operationId: "op-1", command: "backup", executionToken: "op-1:execution" })
    ).rejects.toThrow("malformed durable state");
  });

  it("does not discard the legitimate first dispatching execution", async () => {
    mocks.send.mockResolvedValueOnce({
      Item: { payload: { S: JSON.stringify(dispatchingState) }, version: { N: "1" } },
    });
    mocks.send.mockRejectedValueOnce(Object.assign(new Error("race"), { name: "ConditionalCheckFailedException" }));
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: {
          S: JSON.stringify({
            ...dispatchingState,
            status: "running",
            phase: "executing",
            executionToken: "first",
            executionLeaseExpiresAt: "2099-04-13T12:02:00.000Z",
          }),
        },
        version: { N: "2" },
      },
    });

    const claim = await claimOperationExecution({ operationId: "op-1", command: "backup", executionToken: "second" });
    expect(claim).toMatchObject({ claimed: false, reason: "active" });
  });

  it("rejects terminal writes from a stale execution owner", async () => {
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: {
          S: JSON.stringify({ ...dispatchingState, status: "running", phase: "executing", executionToken: "owner-a" }),
        },
        version: { N: "2" },
      },
    });

    await expect(
      updateOperationState({
        operationId: "op-1",
        command: "backup",
        status: "completed",
        expectedExecutionToken: "owner-b",
      })
    ).rejects.toThrow("execution ownership changed");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/email/allowlist", "allowlist"],
    ["/email/start", "start"],
    ["/scheduled/backup", "backup"],
  ])("round-trips and claims the %s route", async (route, command) => {
    mocks.send
      .mockResolvedValueOnce({
        Item: {
          payload: { S: JSON.stringify({ ...dispatchingState, type: command, route }) },
          version: { N: "1" },
        },
      })
      .mockResolvedValueOnce({});

    await expect(
      claimOperationExecution({ operationId: "op-1", command, executionToken: "attempt-1" })
    ).resolves.toMatchObject({ claimed: true });
  });

  it("conditionally takes over a stale claim with a new attempt identity", async () => {
    const stale = {
      ...dispatchingState,
      status: "running",
      phase: "executing",
      executionToken: "attempt-old",
      executionAttempt: 1,
      executionLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(stale) }, version: { N: "4" } } })
      .mockResolvedValueOnce({});

    await expect(
      claimOperationExecution({
        operationId: "op-1",
        command: "backup",
        executionToken: "attempt-new",
        staleExecutionToken: "attempt-old",
      })
    ).resolves.toMatchObject({ claimed: true, reason: "reclaimed", state: { executionAttempt: 2 } });
    expect(mocks.send.mock.calls[1][0].input.ConditionExpression).toBe("#version = :expected");
  });

  it("keeps nonterminal Lambda operation authority free of retention TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.stubEnv("MC_OPERATION_STATE_RETENTION_DAYS", "7");
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await updateOperationState({
      operationId: "op-retention",
      command: "backup",
      status: "accepted",
      route: "/api/backup",
    });
    expect(mocks.send.mock.calls[1][0].input.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":ttl"]).toBeUndefined();
    vi.useRealTimers();
  });

  it("heartbeats only the current execution owner and extends its claim lease", async () => {
    const executing = {
      ...dispatchingState,
      status: "running",
      phase: "executing",
      executionToken: "attempt-current",
      executionLeaseExpiresAt: "2026-04-13T12:01:00.000Z",
    };
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(executing) }, version: { N: "2" } } })
      .mockResolvedValueOnce({});

    await heartbeatOperationExecution({
      operationId: "op-1",
      command: "backup",
      executionToken: "attempt-current",
    });
    const payload = JSON.parse(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":payload"].S);
    expect(payload.executionLeaseExpiresAt).not.toBe(executing.executionLeaseExpiresAt);
  });

  it("refuses to terminalize hibernate before durable root-volume deletion", async () => {
    mocks.send.mockResolvedValueOnce({
      Item: {
        payload: {
          S: JSON.stringify({
            ...dispatchingState,
            type: "hibernate",
            route: "/api/hibernate",
            status: "running",
            phase: "executing",
            executionToken: "attempt-1",
            hibernatePhase: "detached",
          }),
        },
        version: { N: "4" },
      },
    });

    await expect(
      updateOperationState({
        operationId: "op-1",
        command: "hibernate",
        status: "completed",
        phase: "terminal",
        expectedExecutionToken: "attempt-1",
      })
    ).rejects.toThrow("cannot complete before managed root deletion is durable");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("clears the prior command id and status when a new remote-step identity is recorded", async () => {
    const executing = {
      ...dispatchingState,
      status: "running",
      phase: "executing",
      executionToken: "attempt-current",
      remoteCommandId: "command-old",
      remoteCommandIdentity: "identity-old",
      remoteCommandStatus: "Success",
      remoteCommandInstanceId: "i-123",
      remoteCommandStep: "backup",
    };
    mocks.send
      .mockResolvedValueOnce({ Item: { payload: { S: JSON.stringify(executing) }, version: { N: "5" } } })
      .mockResolvedValueOnce({});

    await recordOperationRemoteCommandIdentity({
      operationId: "op-1",
      command: "backup",
      executionToken: "attempt-current",
      identity: "identity-new",
      instanceId: "i-123",
      step: "refresh-backups",
      final: true,
    });

    const payload = JSON.parse(mocks.send.mock.calls[1][0].input.ExpressionAttributeValues[":payload"].S);
    expect(payload.remoteCommandIdentity).toBe("identity-new");
    expect(payload.remoteCommandId).toBeUndefined();
    expect(payload.remoteCommandStatus).toBe("Dispatching");
  });
});
