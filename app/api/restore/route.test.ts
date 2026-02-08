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
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  findInstanceId: mocks.findInstanceId,
  getInstanceState: mocks.getInstanceState,
  executeSSMCommand: mocks.executeSSMCommand,
}));

// Mock requireAdmin to return a fake admin user
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
}));

// Mock sanitizeBackupName
vi.mock("@/lib/sanitization", () => ({
  sanitizeBackupName: vi.fn(),
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

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["my-backup-2024"],
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
    });
  });
});
