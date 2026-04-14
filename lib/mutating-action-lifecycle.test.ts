import {
  createMutatingActionFailure,
  createMutatingActionRequestContext,
  createMutatingActionSuccess,
} from "@/lib/mutating-action-contract";
import { runMutatingActionLifecycle } from "@/lib/mutating-action-lifecycle";
import type { ServerActionLock } from "@/lib/server-action-lock";
import { createMockNextRequest } from "@/tests/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("mutating-action-contract helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
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
  it("executes auth -> throttle -> lock -> invoke -> finalize on success", async () => {
    const request = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/start", "start");
    const order: string[] = [];
    const lock: ServerActionLock = {
      lockId: "lock-123",
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
  });

  it("uses custom error mapper for invoke errors and finalizes with lock context", async () => {
    const request = createMockNextRequest("http://localhost/api/restore", { method: "POST" });
    const context = createMutatingActionRequestContext(request, "/api/restore", "restore");
    const finalizeSpy = vi.fn();
    const lock: ServerActionLock = {
      lockId: "lock-restore",
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
      httpStatus: 409,
      error: "failed at invoke",
      code: "lock_conflict",
    });
    expect(result.lock?.lockId).toBe("lock-restore");
    expect(finalizeSpy).toHaveBeenCalledOnce();
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        lock,
      })
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
