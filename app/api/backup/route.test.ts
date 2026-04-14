import type { ApiResponse, BackupResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  getInstanceState: vi.fn().mockResolvedValue("running"),
  executeSSMCommand: vi.fn().mockResolvedValue("active"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-backup-123" }),
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
  findInstanceId: mocks.findInstanceId,
  getInstanceState: mocks.getInstanceState,
  executeSSMCommand: mocks.executeSSMCommand,
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

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

describe("POST /api/backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstanceState.mockResolvedValue("running");
    mocks.executeSSMCommand.mockResolvedValue("active");
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.enforceMutatingRouteThrottle.mockResolvedValue(null);
    mocks.isServerActionLockConflictError.mockReturnValue(false);
  });

  it("returns accepted operation metadata for async backups", async () => {
    const req = createMockNextRequest("http://localhost/api/backup", {
      method: "POST",
      body: JSON.stringify({ name: "nightly-2026" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<BackupResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("nightly-2026");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("backup-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "backup",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["nightly-2026"],
      lockId: "lock-backup-123",
    });
    expect(mocks.enforceMutatingRouteThrottle).toHaveBeenCalledTimes(1);
  });

  it("returns failed operation metadata for invalid state", async () => {
    mocks.getInstanceState.mockResolvedValue("stopped");

    const req = createMockNextRequest("http://localhost/api/backup", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Insufficient permissions" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/backup", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Insufficient permissions");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("backup-");

    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    mocks.getInstanceState.mockResolvedValueOnce("running");
    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/backup", {
      method: "POST",
      body: JSON.stringify({ name: "nightly-2026" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("backup-");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns 429 with throttle headers when mutating throttle is exceeded", async () => {
    mocks.enforceMutatingRouteThrottle.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: "Too many backup requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": "11",
            "Cache-Control": "no-store",
          },
        }
      )
    );

    const req = createMockNextRequest("http://localhost/api/backup", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Too many backup requests");
    expect(res.headers.get("Retry-After")).toBe("11");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("runs lifecycle stages in auth -> throttle -> lock -> invoke order", async () => {
    const req = createMockNextRequest("http://localhost/api/backup", {
      method: "POST",
      body: JSON.stringify({ backupName: "nightly-2026" }),
    });
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
