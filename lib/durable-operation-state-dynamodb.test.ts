import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  acquireOperationLock: vi.fn(),
  renewOperationLock: vi.fn(),
}));
vi.mock("@/lib/aws/dynamodb-operation-store", () => ({
  isOperationConditionalFailure: (error: unknown) =>
    (error as { name?: string })?.name === "ConditionalCheckFailedException",
  readVersionedOperationRecord: mocks.read,
  writeVersionedOperationRecord: mocks.write,
}));
vi.mock("@/lib/server-action-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-action-lock")>()),
  acquireServerActionLockWithOperation: mocks.acquireOperationLock,
  renewServerActionLockWithOperation: mocks.renewOperationLock,
}));

import {
  claimDurableOperationLock,
  expireAcceptedDispatchIfDeadlineElapsed,
  getDurableOperationState,
  persistDurableOperationStateTransition,
  renewDurableOperationFence,
} from "@/lib/durable-operation-state";

function fenceAuthorization(generation: number) {
  return {
    schemaVersion: 1 as const,
    status: "succeeded" as const,
    authorizationId: "fence-backup-op",
    runtimeId: "runtime-one",
    leaseId: "lease-one",
    leaseGeneration: 2,
    sessionId: "session-one",
    taskId: "task-one",
    invocationId: "invocation-one",
    invocationDigest: "a".repeat(64),
    backupId: "backup-op",
    lifecycleLockId: "lock-1",
    lifecycleFencingToken: 9,
    lifecycleLeaseGeneration: generation,
    lifecycleLeaseExpiresAt: "2026-08-27T13:30:00.000Z",
    issuedAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:01:00.000Z",
    signature: "A".repeat(86),
  };
}

function operationPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "backup-op",
    type: "backup",
    route: "/api/backup",
    status: "accepted",
    phase: "dispatched",
    requestedAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    requestedBy: "admin@example.com",
    lockId: "lock-1",
    fencingToken: 9,
    history: [],
    ...overrides,
  });
}

describe("cross-runtime DynamoDB operation compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operations-table");
    mocks.write.mockResolvedValue(6);
  });

  it.each(["mock", "MOCK", " mock "])(
    "keeps %j-mode operations in the provider store when deployment table names are loaded",
    async (backendMode) => {
      vi.stubEnv("MC_BACKEND_MODE", backendMode);

      await persistDurableOperationStateTransition({
        operationId: "mock-backup-op",
        type: "backup",
        route: "/api/backup",
        status: "accepted",
        source: "api",
        requestedBy: "dev@localhost",
        lockId: "mock-lock",
        fencingToken: 1,
        phase: "dispatching",
      });

      expect(await getDurableOperationState("mock-backup-op")).toMatchObject({
        id: "mock-backup-op",
        status: "accepted",
        lockId: "mock-lock",
      });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    }
  );

  it("preserves Lambda execution ownership when the Worker records dispatched state", async () => {
    mocks.read.mockResolvedValue({
      version: 5,
      payload: JSON.stringify({
        schemaVersion: 1,
        id: "backup-op",
        type: "backup",
        route: "/api/backup",
        status: "running",
        phase: "executing",
        requestedAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:01.000Z",
        lockId: "lock-1",
        fencingToken: 9,
        executionToken: "attempt-1",
        executionAttempt: 1,
        executionClaimedAt: "2026-08-27T12:00:01.000Z",
        executionLeaseExpiresAt: "2026-08-27T12:02:01.000Z",
        history: [],
      }),
    });

    await persistDurableOperationStateTransition({
      operationId: "backup-op",
      type: "backup",
      status: "accepted",
      source: "api",
      phase: "dispatched",
    });
    const payload = JSON.parse(mocks.write.mock.calls[0][0].payload);
    expect(payload).toMatchObject({
      phase: "executing",
      fencingToken: 9,
      executionToken: "attempt-1",
      executionAttempt: 1,
    });
  });

  it("persists idempotency before atomically binding lock ownership", async () => {
    const order: string[] = [];
    let boundPayload = "";
    mocks.read.mockResolvedValueOnce(null).mockImplementation(async () => ({ version: 2, payload: boundPayload }));
    mocks.write.mockImplementationOnce(async (write) => {
      order.push("persist-idempotency");
      expect(JSON.parse(write.payload)).toMatchObject({
        id: "backup-agent-atomic-state",
        requestIdempotencyKey: "backup-agent-atomic-state",
        phase: "validating",
      });
      return 1;
    });
    mocks.acquireOperationLock.mockImplementationOnce(async (_action, _owner, atomic) => {
      order.push("acquire-lock-transaction");
      expect(mocks.write).toHaveBeenCalledOnce();
      const lock = {
        lockId: "lock-atomic-state",
        fencingToken: 4,
        action: "backup" as const,
        ownerEmail: "admin@example.com",
        createdAt: "2026-08-27T12:00:00.000Z",
        expiresAt: "2026-08-27T13:30:00.000Z",
        operationId: atomic.operationId,
        operationOwnerId: atomic.ownerId,
      };
      boundPayload = atomic.payload(lock);
      return { ownership: "acquired" as const, lock };
    });

    const claimed = await claimDurableOperationLock({
      operationId: "backup-agent-atomic-state",
      ownerId: "12345678-1234-4234-8234-123456789012",
      action: "backup",
      ownerEmail: "admin@example.com",
      type: "backup",
      route: "/api/agent/runtime/backups",
      requestedAt: "2026-08-27T12:00:00.000Z",
      requestedBy: "admin@example.com",
      instanceId: "i-runtime",
      status: "accepted",
      source: "api",
      phase: "validating",
      requestIdempotencyKey: "backup-agent-atomic-state",
      timestamp: "2026-08-27T12:00:00.000Z",
    });

    expect(order).toEqual(["persist-idempotency", "acquire-lock-transaction"]);
    expect(claimed).toMatchObject({
      ownership: "acquired",
      operation: {
        lockId: "lock-atomic-state",
        fencingToken: 4,
        dispatchOwnerId: "12345678-1234-4234-8234-123456789012",
      },
    });
  });

  it("builds the next signed authorization inside the same lock-operation renewal transaction", async () => {
    mocks.read.mockResolvedValue({
      version: 5,
      payload: operationPayload({
        route: "/api/agent/runtime/backups",
        status: "completed",
        phase: "terminal",
        lockLeaseGeneration: 2,
        lockLeaseExpiresAt: "2026-08-27T13:00:00.000Z",
        dispatchOwnerId: "owner-agent",
        requestIdempotencyKey: "backup-op",
      }),
    });
    let transactionPayload = "";
    mocks.renewOperationLock.mockImplementationOnce(async (_lockId, _token, renewal) => {
      const lock = {
        lockId: "lock-1",
        fencingToken: 9,
        leaseGeneration: 3,
        agentFenceActive: true,
        action: "backup" as const,
        ownerEmail: "admin@example.com",
        createdAt: "2026-08-27T10:00:00.000Z",
        expiresAt: "2026-08-27T13:30:00.000Z",
        operationId: "backup-op",
        operationOwnerId: "owner-agent",
      };
      transactionPayload = await renewal.payload(lock, 6);
      return {
        lock,
        operationPayload: transactionPayload,
        operationVersion: 6,
        ownership: "renewed" as const,
      };
    });

    const result = await renewDurableOperationFence({
      operationId: "backup-op",
      ownerEmail: "admin@example.com",
      timestamp: "2026-08-27T12:00:00.000Z",
      createAuthorization: async (lock) => ({
        ...fenceAuthorization(lock.leaseGeneration ?? 0),
        lifecycleLeaseExpiresAt: lock.expiresAt,
      }),
    });

    expect(result).toMatchObject({
      ownership: "renewed",
      authorization: { lifecycleLeaseGeneration: 3 },
      operation: {
        lockLeaseGeneration: 3,
        agentEffectReconciliationStatus: "awaiting-executor",
      },
    });
    expect(JSON.parse(transactionPayload)).toMatchObject({
      version: 6,
      lockLeaseGeneration: 3,
      agentFenceAuthorization: { lifecycleLeaseGeneration: 3 },
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("returns the authoritative generation for a duplicate renewal after response loss", async () => {
    const authoritative = fenceAuthorization(3);
    const payload = operationPayload({
      route: "/api/agent/runtime/backups",
      status: "completed",
      phase: "terminal",
      lockLeaseGeneration: 3,
      lockLeaseExpiresAt: authoritative.lifecycleLeaseExpiresAt,
      dispatchOwnerId: "owner-agent",
      agentEffectReconciliationStatus: "active",
      agentEffectSafetyExpiresAt: "2026-08-27T12:04:00.000Z",
      agentFenceAuthorization: authoritative,
      version: 6,
    });
    mocks.read.mockResolvedValue({ version: 6, payload });
    mocks.renewOperationLock.mockImplementationOnce(async (_lockId, _token, renewal) => {
      const lock = {
        lockId: "lock-1",
        fencingToken: 9,
        leaseGeneration: 3,
        agentFenceActive: true,
        action: "backup" as const,
        ownerEmail: "admin@example.com",
        createdAt: "2026-08-27T10:00:00.000Z",
        expiresAt: authoritative.lifecycleLeaseExpiresAt,
        operationId: "backup-op",
        operationOwnerId: "owner-agent",
      };
      expect(renewal.reconcile(payload, lock, 6)).toBe(true);
      return { lock, operationPayload: payload, operationVersion: 6, ownership: "reconciled" as const };
    });

    await expect(
      renewDurableOperationFence({
        operationId: "backup-op",
        ownerEmail: "admin@example.com",
        expectedAuthorization: fenceAuthorization(2),
        createAuthorization: vi.fn(),
      })
    ).resolves.toMatchObject({
      ownership: "reconciled",
      authorization: { lifecycleLeaseGeneration: 3 },
    });
  });

  it("terminalizes an accepted dispatched operation at, but never before, the 90-minute boundary", async () => {
    mocks.read.mockResolvedValue({ version: 5, payload: operationPayload() });

    const beforeBoundary = await expireAcceptedDispatchIfDeadlineElapsed(
      "backup-op",
      new Date("2026-08-27T11:29:59.999Z")
    );
    expect(beforeBoundary.operation?.status).toBe("accepted");
    expect(beforeBoundary.shouldReleaseLock).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();

    const atBoundary = await expireAcceptedDispatchIfDeadlineElapsed("backup-op", new Date("2026-08-27T11:30:00.000Z"));
    expect(atBoundary.operation).toMatchObject({
      status: "failed",
      phase: "terminal",
      code: "dispatch_expired",
      updatedAt: "2026-08-27T11:30:00.000Z",
      lockId: "lock-1",
      fencingToken: 9,
    });
    expect(atBoundary.shouldReleaseLock).toBe(true);
    expect(JSON.parse(mocks.write.mock.calls[0][0].payload)).toMatchObject({
      status: "failed",
      phase: "terminal",
      code: "dispatch_expired",
    });
  });

  it("re-reads and preserves a concurrent terminal result after the expiry write loses its fence", async () => {
    const conditionalFailure = Object.assign(new Error("version changed"), {
      name: "ConditionalCheckFailedException",
    });
    mocks.read.mockResolvedValueOnce({ version: 5, payload: operationPayload() }).mockResolvedValueOnce({
      version: 6,
      payload: operationPayload({
        status: "completed",
        phase: "terminal",
        updatedAt: "2026-08-27T11:29:59.999Z",
        code: "lambda_completed",
      }),
    });
    mocks.write.mockRejectedValueOnce(conditionalFailure);

    const result = await expireAcceptedDispatchIfDeadlineElapsed("backup-op", new Date("2026-08-27T11:30:00.000Z"));

    expect(result.operation).toMatchObject({ status: "completed", code: "lambda_completed" });
    expect(result.shouldReleaseLock).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
});
