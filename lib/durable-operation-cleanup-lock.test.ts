import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isAuthoritativeOwned: vi.fn() }));

vi.mock("@/lib/server-action-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-action-lock")>()),
  isAuthoritativeLifecycleLockOwned: mocks.isAuthoritativeOwned,
}));

import {
  cleanupExpiredDurableOperationStates,
  getDurableOperationState,
  persistDurableOperationStateTransition,
  resetDurableOperationStateStoreForTests,
} from "@/lib/durable-operation-state";

describe("durable operation cleanup lock protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDurableOperationStateStoreForTests();
    mocks.isAuthoritativeOwned.mockResolvedValue(true);
  });

  it("does not delete an old terminal mirror while its exact lifecycle lock is still owned", async () => {
    await persistDurableOperationStateTransition({
      operationId: "owned-operation",
      type: "backup",
      route: "/api/backup",
      status: "completed",
      source: "api",
      requestedAt: "2026-01-01T00:00:00.000Z",
      timestamp: "2026-01-01T00:00:00.000Z",
      lockId: "lock-owned",
      fencingToken: 9,
    });

    const result = await cleanupExpiredDurableOperationStates({
      now: new Date("2026-09-06T00:00:00.000Z"),
      retentionMs: 24 * 60 * 60 * 1000,
    });

    expect(mocks.isAuthoritativeOwned).toHaveBeenCalledWith({
      operationId: "owned-operation",
      lockId: "lock-owned",
      fencingToken: 9,
      action: "backup",
    });
    expect(result.selectedParameterNames).toEqual([]);
    expect(await getDurableOperationState("owned-operation")).not.toBeNull();
  });

  it("never retention-deletes a nonterminal operation even when it is old", async () => {
    await persistDurableOperationStateTransition({
      operationId: "running-operation",
      type: "resume",
      route: "/api/resume",
      status: "running",
      source: "api",
      requestedAt: "2026-01-01T00:00:00.000Z",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const result = await cleanupExpiredDurableOperationStates({
      now: new Date("2026-09-06T00:00:00.000Z"),
      retentionMs: 24 * 60 * 60 * 1000,
    });

    expect(result.selectedParameterNames).toEqual([]);
    expect(await getDurableOperationState("running-operation")).not.toBeNull();
  });
});
