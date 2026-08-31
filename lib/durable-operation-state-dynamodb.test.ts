import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/aws/dynamodb-operation-store", () => ({
  isOperationConditionalFailure: (error: unknown) =>
    (error as { name?: string })?.name === "ConditionalCheckFailedException",
  readVersionedOperationRecord: mocks.read,
  writeVersionedOperationRecord: mocks.write,
}));

import {
  expireAcceptedDispatchIfDeadlineElapsed,
  getDurableOperationState,
  persistDurableOperationStateTransition,
} from "@/lib/durable-operation-state";

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
