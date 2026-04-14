import type { ApiResponse, RestoreResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  getInstanceState: vi.fn().mockResolvedValue("running"),
  executeSSMCommand: vi.fn().mockResolvedValue("active"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-restore-123" }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  findInstanceId: mocks.findInstanceId,
  getInstanceState: mocks.getInstanceState,
  executeSSMCommand: mocks.executeSSMCommand,
}));

// Mock requireAdmin to return a fake admin user
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

// Mock sanitizeBackupName
vi.mock("@/lib/sanitization", () => ({
  sanitizeBackupName: vi.fn(),
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

describe("POST /api/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should trigger async lambda with backup name when provided", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("my-backup-2024");
    expect(body.data?.message).toContain("asynchronously");
    expect(body.operation?.type).toBe("restore");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("restore-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["my-backup-2024"],
      lockId: "lock-restore-123",
    });
  });

  it("should trigger async lambda with empty args when no backup name provided (back-compat)", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("latest");
    expect(body.data?.message).toContain("asynchronously");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: [],
      lockId: "lock-restore-123",
    });
  });

  it("should handle empty body gracefully (back-compat)", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: "",
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("latest");
    expect(body.data?.message).toContain("asynchronously");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: [],
      lockId: "lock-restore-123",
    });
  });

  it("should ignore instanceId from request body and use server-side resolution", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024", instanceId: "i-custom-id" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("my-backup-2024");

    // Should use the server-side resolved ID, not the caller-provided one
    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234", // Server-side resolved ID
      userEmail: "admin@example.com",
      args: ["my-backup-2024"],
      lockId: "lock-restore-123",
    });
  });

  it("should handle lambda invocation failures", async () => {
    mocks.invokeLambda.mockRejectedValueOnce(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to restore backup");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });

  it("should support legacy 'name' field for backward compatibility", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ name: "legacy-backup" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("legacy-backup");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["legacy-backup"],
      lockId: "lock-restore-123",
    });
  });

  it("should prefer 'backupName' over 'name' when both are provided", async () => {
    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "new-backup", name: "old-backup" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<RestoreResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("new-backup");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["new-backup"],
      lockId: "lock-restore-123",
    });
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication required");
    expect(body.operation?.type).toBe("restore");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("restore-");

    expect(mocks.findInstanceId).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/restore", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("restore");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("restore-");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });
});
