import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  getInstanceState: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-hibernate-123" }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  enforceMutatingRouteThrottle: vi.fn().mockResolvedValue(null),
  mapMutatingRouteThrottleFailure: vi.fn(async (response: Response, operation: string) => ({
    decision: {
      allowed: false,
      httpStatus: response.status,
      code: "throttled",
      message: `Too many ${operation} requests. Please retry shortly.`,
    },
    retryAfterHeader: response.headers.get("Retry-After") ?? undefined,
    cacheControlHeader: response.headers.get("Cache-Control") ?? undefined,
  })),
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  getInstanceState: mocks.getInstanceState,
  findInstanceId: mocks.findInstanceId,
}));

// Mock requireAdmin to return a fake admin user
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

vi.mock("@/lib/mutating-route-throttle", () => ({
  enforceMutatingRouteThrottle: mocks.enforceMutatingRouteThrottle,
  mapMutatingRouteThrottleFailure: mocks.mapMutatingRouteThrottleFailure,
}));

describe("POST /api/hibernate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.enforceMutatingRouteThrottle.mockResolvedValue(null);
    mocks.isServerActionLockConflictError.mockReturnValue(false);
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);
    mocks.invokeLambda.mockResolvedValue(undefined);
  });

  it("should hibernate successfully when running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<HibernateResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.instanceId).toBe("i-1234");
    expect(body.operation?.type).toBe("hibernate");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("hibernate-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "hibernate",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: [],
      lockId: "lock-hibernate-123",
    });
    expect(mocks.enforceMutatingRouteThrottle).toHaveBeenCalledTimes(1);
  });

  it("should return completed operation when already hibernating", async () => {
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<HibernateResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.operation?.status).toBe("completed");
    expect(body.data?.backupOutput).toContain("already hibernating");
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should return 400 when instance is not running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);
    mocks.invokeLambda.mockRejectedValueOnce(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to hibernate server");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Insufficient permissions" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Insufficient permissions");
    expect(body.operation?.type).toBe("hibernate");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("hibernate-");

    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Running);
    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("hibernate");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("hibernate-");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns 429 with throttle headers when mutating throttle is exceeded", async () => {
    mocks.enforceMutatingRouteThrottle.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: "Too many hibernate requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": "8",
            "Cache-Control": "no-store",
          },
        }
      )
    );

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Too many hibernate requests");
    expect(res.headers.get("Retry-After")).toBe("8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("runs lifecycle stages in auth -> throttle -> lock -> invoke order", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);

    const authOrder = mocks.requireAdmin.mock.invocationCallOrder[0];
    const throttleOrder = mocks.enforceMutatingRouteThrottle.mock.invocationCallOrder[0];
    const findInstanceOrder = mocks.findInstanceId.mock.invocationCallOrder[0];
    const lockOrder = mocks.acquireServerActionLock.mock.invocationCallOrder[0];
    const invokeOrder = mocks.invokeLambda.mock.invocationCallOrder[0];

    expect(authOrder).toBeLessThan(throttleOrder);
    expect(throttleOrder).toBeLessThan(findInstanceOrder);
    expect(findInstanceOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(invokeOrder);
  });
});
