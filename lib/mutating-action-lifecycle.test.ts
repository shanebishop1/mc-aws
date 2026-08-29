import {
  createMutatingActionFailure,
  createMutatingActionRequestContext,
  createMutatingActionSuccess,
} from "@/lib/mutating-action-contract";
import { runMutatingActionLifecycle } from "@/lib/mutating-action-lifecycle";
import type { ServerActionLock } from "@/lib/server-action-lock";
import { createMockNextRequest } from "@/tests/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistDurableOperationStateTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/durable-operation-state", () => ({
  persistDurableOperationStateTransition: mocks.persistDurableOperationStateTransition,
}));

describe("mutating-action-contract helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("creates request context with running operation metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));

    const request = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/start", "start");

    expect(context.route).toBe("/api/start");
    expect(context.action).toBe("start");
    expect(context.operation.type).toBe("start");
    expect(context.operation.status).toBe("running");
    expect(context.requestedAt).toBe("2026-04-13T12:00:00.000Z");
  });

  it("creates success and failure execution result helpers", () => {
    const success = createMutatingActionSuccess({ instanceId: "i-123" });
    const failure = createMutatingActionFailure("boom", {
      httpStatus: 409,
      code: "conflict",
    });

    expect(success).toEqual({
      ok: true,
      status: "accepted",
      httpStatus: 202,
      data: { instanceId: "i-123" },
    });

    expect(failure).toEqual({
      ok: false,
      status: "failed",
      httpStatus: 409,
      error: "boom",
      code: "conflict",
      cause: undefined,
    });
  });
});

describe("runMutatingActionLifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist operation state or acquire a lock when CSRF validation fails during authentication", async () => {
    const request = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/start", "start");
    const finalize = vi.fn().mockResolvedValue(undefined);
    const acquireLock = vi.fn();

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => {
        throw new Response(null, { status: 403 });
      },
      throttle: async () => ({ allowed: true }),
      acquireLock,
      invoke: async () => {
        throw new Error("should not invoke");
      },
      finalize,
    });

    expect(result.execution.ok).toBe(false);
    expect(finalize).toHaveBeenCalledOnce();
    expect(acquireLock).not.toHaveBeenCalled();
    expect(mocks.persistDurableOperationStateTransition).not.toHaveBeenCalled();
  });

  it("executes auth -> throttle -> lock -> invoke -> finalize on success", async () => {
    const request = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/start", "start");
    const order: string[] = [];
    const lock: ServerActionLock = {
      lockId: "lock-123",
      fencingToken: 1,
      action: "start",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T12:00:00.000Z",
      expiresAt: "2026-04-13T12:30:00.000Z",
    };

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => {
        order.push("auth");
        return { email: "admin@example.com" };
      },
      throttle: async () => {
        order.push("throttle");
        return { allowed: true };
      },
      acquireLock: async () => {
        order.push("lock");
        return lock;
      },
      invoke: async () => {
        order.push("invoke");
        return { instanceId: "i-123", message: "started" };
      },
      finalize: async () => {
        order.push("finalize");
        return { released: false };
      },
    });

    expect(order).toEqual(["auth", "throttle", "lock", "invoke", "finalize"]);
    expect(result.execution.ok).toBe(true);
    expect(result.execution).toMatchObject({ status: "accepted", httpStatus: 202 });
    expect(result.completedStage).toBe("finalize");
    expect(result.finalizeResult).toEqual({ released: false });
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        lockId: "lock-123",
        fencingToken: 1,
        phase: "dispatching",
      })
    );
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lockId: "lock-123",
        fencingToken: 1,
        phase: "dispatched",
      })
    );
  });

  it("short-circuits lock/invoke when throttled and still finalizes", async () => {
    const request = createMockNextRequest("http://localhost/api/backup", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/backup", "backup");
    const order: string[] = [];

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => {
        order.push("auth");
        return { email: "admin@example.com" };
      },
      throttle: async () => {
        order.push("throttle");
        return { allowed: false, message: "too many requests" };
      },
      acquireLock: async () => {
        order.push("lock");
        throw new Error("should not acquire lock");
      },
      invoke: async () => {
        order.push("invoke");
        throw new Error("should not invoke");
      },
      finalize: async () => {
        order.push("finalize");
        return { finalized: true };
      },
    });

    expect(order).toEqual(["auth", "throttle", "finalize"]);
    expect(result.execution).toMatchObject({
      ok: false,
      status: "failed",
      httpStatus: 429,
      error: "too many requests",
      code: "throttled",
    });
    expect(result.finalizeResult).toEqual({ finalized: true });
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenCalledTimes(2);
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "failed",
        requestedBy: "admin@example.com",
        code: "throttled",
      })
    );
  });

  it("uses the custom error mapper but retains the lock when remote dispatch is ambiguous", async () => {
    const request = createMockNextRequest("http://localhost/api/restore", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/restore", "restore");
    const finalizeSpy = vi.fn();
    const lock: ServerActionLock = {
      lockId: "lock-restore",
      fencingToken: 1,
      action: "restore",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T12:00:00.000Z",
      expiresAt: "2026-04-13T12:30:00.000Z",
    };

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => ({ email: "admin@example.com" }),
      throttle: async () => ({ allowed: true }),
      acquireLock: async () => lock,
      invoke: async () => {
        throw new Error("conflict");
      },
      mapError: ({ stage, error }) =>
        createMutatingActionFailure(`failed at ${stage}`, {
          httpStatus: 409,
          code: "lock_conflict",
          cause: error,
        }),
      finalize: async (input) => {
        finalizeSpy(input);
        return { released: true };
      },
    });

    expect(result.execution).toMatchObject({
      ok: false,
      status: "failed",
      httpStatus: 503,
      error: "Remote dispatch could not be confirmed. The operation remains pending until its lease expires.",
      code: "dispatch_unresolved",
      operationStatus: "accepted",
    });
    expect(result.lock?.lockId).toBe("lock-restore");
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        status: "accepted",
        phase: "dispatching",
      })
    );
  });

  it("terminalizes and releases after a definite Lambda service rejection", async () => {
    const request = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/stop", "stop");
    const finalize = vi.fn().mockResolvedValue({ released: true });
    const rejected = Object.assign(new Error("too many requests"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429, requestId: "request-id" },
    });

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => ({ email: "admin@example.com" }),
      throttle: async () => ({ allowed: true }),
      acquireLock: async () => ({
        lockId: "lock-stop",
        fencingToken: 2,
        action: "stop",
        ownerEmail: "admin@example.com",
        createdAt: "2026-04-13T12:00:00.000Z",
        expiresAt: "2026-04-13T13:30:00.000Z",
      }),
      invoke: async () => {
        throw rejected;
      },
      finalize,
    });

    expect(result.execution).toMatchObject({ ok: false, status: "failed" });
    expect(finalize).toHaveBeenCalledOnce();
    expect(mocks.persistDurableOperationStateTransition).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", phase: "terminal" })
    );
  });

  it("marks successful invocation as failed when finalize throws", async () => {
    const request = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/stop", "stop");

    const result = await runMutatingActionLifecycle({
      context,
      authenticate: async () => ({ email: "admin@example.com" }),
      throttle: async () => ({ allowed: true }),
      acquireLock: async () => ({
        lockId: "lock-stop",
        fencingToken: 1,
        action: "stop",
        ownerEmail: "admin@example.com",
        createdAt: "2026-04-13T12:00:00.000Z",
        expiresAt: "2026-04-13T12:30:00.000Z",
      }),
      invoke: async () => ({ instanceId: "i-123", message: "stopped" }),
      finalize: async () => {
        throw new Error("release failed");
      },
    });

    expect(result.execution).toMatchObject({
      ok: false,
      status: "failed",
      error: "Failed to finalize mutating action",
      code: "finalize_failed",
      httpStatus: 500,
    });
    expect(result.finalizeError).toBeInstanceOf(Error);
  });
});
