import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  getInstanceState: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-resume-123" }),
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

// Mock sanitizeBackupName
vi.mock("@/lib/sanitization", () => ({
  sanitizeBackupName: vi.fn((value: string) => value),
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

describe("POST /api/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.enforceMutatingRouteThrottle.mockResolvedValue(null);
    mocks.isServerActionLockConflictError.mockReturnValue(false);
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.invokeLambda.mockResolvedValue(undefined);
  });

  it("should resume successfully from hibernating state", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.operation?.type).toBe("resume");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("resume-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith(
      "StartMinecraftServer",
      expect.objectContaining({
        invocationType: "api",
        command: "resume",
        userEmail: "admin@example.com",
        instanceId: "i-1234",
        args: [],
        lockId: "lock-resume-123",
        operationId: body.operation?.id,
      })
    );
    expect(mocks.enforceMutatingRouteThrottle).toHaveBeenCalledTimes(1);
  });

  it("should return 400 when instance is already running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should pass backupName to Lambda when provided", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);

    const req = createMockNextRequest("http://localhost/api/resume", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.restoreOutput).toBe("Restore requested: my-backup-2024");

    expect(mocks.invokeLambda).toHaveBeenCalledWith(
      "StartMinecraftServer",
      expect.objectContaining({
        invocationType: "api",
        command: "resume",
        userEmail: "admin@example.com",
        instanceId: "i-1234",
        args: ["my-backup-2024"],
        lockId: "lock-resume-123",
        operationId: body.operation?.id,
      })
    );
  });

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.invokeLambda.mockRejectedValueOnce(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to resume server");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication required");
    expect(body.operation?.type).toBe("resume");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("resume-");

    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Hibernating);
    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("resume");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("resume-");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns 429 with throttle headers when mutating throttle is exceeded", async () => {
    mocks.enforceMutatingRouteThrottle.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: "Too many resume requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": "10",
            "Cache-Control": "no-store",
          },
        }
      )
    );

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Too many resume requests");
    expect(res.headers.get("Retry-After")).toBe("10");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("runs lifecycle stages in auth -> throttle -> lock -> invoke order", async () => {
    mocks.getInstanceState.mockResolvedValueOnce(ServerState.Hibernating);

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
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
