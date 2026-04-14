import {
  cleanupExpiredDurableOperationStates,
  getDurableOperationState,
  persistDurableOperationStateTransition,
  resetDurableOperationStateStoreForTests,
  selectExpiredDurableOperationStateParameterNames,
} from "@/lib/durable-operation-state";
import { describe, expect, it } from "vitest";

const oneDayMs = 24 * 60 * 60 * 1000;

function buildPersistedOperationStateValue(input: {
  id: string;
  type: "start" | "stop" | "backup" | "restore" | "hibernate" | "resume";
  updatedAt: string;
  status?: "accepted" | "running" | "completed" | "failed";
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type,
    route: `/api/${input.type}`,
    status: input.status ?? "completed",
    requestedAt: input.updatedAt,
    updatedAt: input.updatedAt,
    history: [
      {
        status: input.status ?? "completed",
        at: input.updatedAt,
        source: "api",
      },
    ],
  });
}

describe("durable-operation-state", () => {
  it("persists transition history across running -> accepted -> running -> completed", async () => {
    resetDurableOperationStateStoreForTests();
    const operationId = "resume-123";

    await persistDurableOperationStateTransition({
      operationId,
      type: "resume",
      route: "/api/resume",
      status: "running",
      source: "api",
      requestedAt: "2026-04-14T10:00:00.000Z",
      requestedBy: "admin@example.com",
      lockId: "lock-resume-123",
      instanceId: "i-1234",
      timestamp: "2026-04-14T10:00:00.000Z",
    });

    await persistDurableOperationStateTransition({
      operationId,
      type: "resume",
      status: "accepted",
      source: "api",
      timestamp: "2026-04-14T10:00:01.000Z",
    });

    await persistDurableOperationStateTransition({
      operationId,
      type: "resume",
      status: "running",
      source: "lambda",
      timestamp: "2026-04-14T10:00:10.000Z",
    });

    await persistDurableOperationStateTransition({
      operationId,
      type: "resume",
      status: "completed",
      source: "lambda",
      timestamp: "2026-04-14T10:01:00.000Z",
    });

    const persisted = await getDurableOperationState(operationId);

    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("completed");
    expect(persisted?.requestedBy).toBe("admin@example.com");
    expect(persisted?.lockId).toBe("lock-resume-123");
    expect(persisted?.instanceId).toBe("i-1234");
    expect(persisted?.history.map((entry) => entry.status)).toEqual(["running", "accepted", "running", "completed"]);
  });

  it("does not regress operation status when late accepted update arrives", async () => {
    resetDurableOperationStateStoreForTests();
    const operationId = "backup-456";

    await persistDurableOperationStateTransition({
      operationId,
      type: "backup",
      route: "/api/backup",
      status: "running",
      source: "lambda",
      timestamp: "2026-04-14T11:00:00.000Z",
    });

    await persistDurableOperationStateTransition({
      operationId,
      type: "backup",
      route: "/api/backup",
      status: "accepted",
      source: "api",
      timestamp: "2026-04-14T11:00:05.000Z",
    });

    const persisted = await getDurableOperationState(operationId);

    expect(persisted?.status).toBe("running");
    expect(persisted?.history.map((entry) => entry.status)).toEqual(["running"]);
  });

  it("keeps terminal status when non-terminal retries attempt to overwrite it", async () => {
    resetDurableOperationStateStoreForTests();
    const operationId = "restore-789";

    await persistDurableOperationStateTransition({
      operationId,
      type: "restore",
      route: "/api/restore",
      status: "failed",
      source: "lambda",
      error: "Restore command failed",
      code: "lambda_execution_failed",
      timestamp: "2026-04-14T12:00:00.000Z",
    });

    await persistDurableOperationStateTransition({
      operationId,
      type: "restore",
      route: "/api/restore",
      status: "running",
      source: "lambda",
      timestamp: "2026-04-14T12:00:05.000Z",
    });

    const persisted = await getDurableOperationState(operationId);

    expect(persisted?.status).toBe("failed");
    expect(persisted?.lastError).toBe("Restore command failed");
    expect(persisted?.code).toBe("lambda_execution_failed");
    expect(persisted?.history.map((entry) => entry.status)).toEqual(["failed"]);
  });

  it("selects only expired records in oldest-first order and supports exclusion/limit", () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const records = [
      {
        name: "/minecraft/operations/fresh-op",
        value: buildPersistedOperationStateValue({
          id: "fresh-op",
          type: "start",
          updatedAt: "2026-04-30T12:00:00.000Z",
        }),
      },
      {
        name: "/minecraft/operations/old-op-2",
        value: buildPersistedOperationStateValue({
          id: "old-op-2",
          type: "backup",
          updatedAt: "2026-04-10T10:00:00.000Z",
        }),
      },
      {
        name: "/minecraft/operations/old-op-1",
        value: buildPersistedOperationStateValue({
          id: "old-op-1",
          type: "resume",
          updatedAt: "2026-04-08T10:00:00.000Z",
        }),
      },
      {
        name: "/minecraft/operations/invalid-json",
        value: "not-json",
        lastModifiedAt: "2026-04-01T10:00:00.000Z",
      },
    ];

    const selected = selectExpiredDurableOperationStateParameterNames({
      records,
      retentionMs: 14 * oneDayMs,
      now,
      excludeParameterNames: ["/minecraft/operations/old-op-1"],
      limit: 2,
    });

    expect(selected).toEqual(["/minecraft/operations/invalid-json", "/minecraft/operations/old-op-2"]);
  });

  it("deletes only expired operation states and respects max deletion limit", async () => {
    resetDurableOperationStateStoreForTests();

    await persistDurableOperationStateTransition({
      operationId: "stale-op-1",
      type: "start",
      status: "completed",
      source: "api",
      timestamp: "2026-04-01T00:00:00.000Z",
    });
    await persistDurableOperationStateTransition({
      operationId: "stale-op-2",
      type: "backup",
      status: "failed",
      source: "api",
      error: "boom",
      timestamp: "2026-04-02T00:00:00.000Z",
    });
    await persistDurableOperationStateTransition({
      operationId: "fresh-op",
      type: "resume",
      status: "running",
      source: "api",
      timestamp: "2026-04-29T00:00:00.000Z",
    });

    const cleanupResult = await cleanupExpiredDurableOperationStates({
      now: new Date("2026-05-01T00:00:00.000Z"),
      retentionMs: 14 * oneDayMs,
      maxDeletions: 1,
    });

    expect(cleanupResult.expiredCount).toBe(2);
    expect(cleanupResult.selectedParameterNames).toEqual(["/minecraft/operations/stale-op-1"]);
    expect(cleanupResult.deletedParameterNames).toEqual(["/minecraft/operations/stale-op-1"]);
    expect(cleanupResult.deletedCount).toBe(1);

    expect(await getDurableOperationState("stale-op-1")).toBeNull();
    expect(await getDurableOperationState("stale-op-2")).not.toBeNull();
    expect(await getDurableOperationState("fresh-op")).not.toBeNull();
  });
});
