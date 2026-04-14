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
}));

describe("POST /api/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "resume",
      userEmail: "admin@example.com",
      instanceId: "i-1234",
      args: [],
      lockId: "lock-resume-123",
    });
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

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "resume",
      userEmail: "admin@example.com",
      instanceId: "i-1234",
      args: ["my-backup-2024"],
      lockId: "lock-resume-123",
    });
  });

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

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
});
