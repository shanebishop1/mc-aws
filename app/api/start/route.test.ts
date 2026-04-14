import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  getInstanceState: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-start-123" }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
  requireAllowed: vi.fn().mockResolvedValue({ email: "test@example.com", role: "admin" }),
  enforceMutatingRouteThrottle: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  getInstanceState: mocks.getInstanceState,
  findInstanceId: mocks.findInstanceId,
}));

// Mock requireAllowed to return a fake user
vi.mock("@/lib/api-auth", () => ({
  requireAllowed: mocks.requireAllowed,
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

vi.mock("@/lib/mutating-route-throttle", () => ({
  enforceMutatingRouteThrottle: mocks.enforceMutatingRouteThrottle,
}));

describe("POST /api/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should trigger async lambda when server is stopped", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("initiated");
    expect(body.operation?.type).toBe("start");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("start-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith(
      "StartMinecraftServer",
      expect.objectContaining({
        invocationType: "api",
        command: "start",
        userEmail: "test@example.com",
        instanceId: "i-1234",
        lockId: "lock-start-123",
        operationId: body.operation?.id,
      })
    );
    expect(mocks.enforceMutatingRouteThrottle).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when mutating route throttle is exceeded", async () => {
    mocks.enforceMutatingRouteThrottle.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: "Too many start requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": "7",
            "Cache-Control": "no-store",
          },
        }
      )
    );

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Too many start requests");
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.getInstanceState).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should return 400 when instance is already running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.acquireServerActionLock).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should ignore instanceId from request body and use server-side resolution", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/start", {
      method: "POST",
      body: JSON.stringify({ instanceId: "i-custom-id" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    // Should use the server-side resolved ID, not the caller-provided one
    expect(body.data?.instanceId).toBe("i-1234");

    expect(mocks.invokeLambda).toHaveBeenCalledWith(
      "StartMinecraftServer",
      expect.objectContaining({
        invocationType: "api",
        command: "start",
        userEmail: "test@example.com",
        instanceId: "i-1234", // Server-side resolved ID
        lockId: "lock-start-123",
        operationId: body.operation?.id,
      })
    );
  });

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to start server");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).toHaveBeenCalled();
    expect(mocks.releaseServerActionLock).toHaveBeenCalledWith("lock-start-123", {
      action: "start",
      ownerEmail: "test@example.com",
    });
  });

  it("runs shared lifecycle stages in order on success", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Stopped);
    mocks.invokeLambda.mockResolvedValueOnce(undefined);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);

    const authOrder = mocks.requireAllowed.mock.invocationCallOrder[0];
    const throttleOrder = mocks.enforceMutatingRouteThrottle.mock.invocationCallOrder[0];
    const findInstanceOrder = mocks.findInstanceId.mock.invocationCallOrder[0];
    const stateOrder = mocks.getInstanceState.mock.invocationCallOrder[0];
    const lockOrder = mocks.acquireServerActionLock.mock.invocationCallOrder[0];
    const invokeOrder = mocks.invokeLambda.mock.invocationCallOrder[0];

    expect(authOrder).toBeLessThan(throttleOrder);
    expect(throttleOrder).toBeLessThan(findInstanceOrder);
    expect(findInstanceOrder).toBeLessThan(stateOrder);
    expect(stateOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(invokeOrder);
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAllowed.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication required");
    expect(body.operation?.type).toBe("start");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("start-");

    expect(mocks.getInstanceState).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Stopped);
    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("start");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("start-");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });
});
