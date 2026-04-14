import {
  getDurableOperationState,
  persistDurableOperationStateTransition,
  resetDurableOperationStateStoreForTests,
} from "@/lib/durable-operation-state";
import { describe, expect, it } from "vitest";

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
});
