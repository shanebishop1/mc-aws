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
  acquireServerAction: vi.fn(),
  releaseServerAction: vi.fn(),
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  getInstanceState: mocks.getInstanceState,
  findInstanceId: mocks.findInstanceId,
  acquireServerAction: mocks.acquireServerAction,
  releaseServerAction: mocks.releaseServerAction,
}));

// Mock requireAdmin to return a fake admin user
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
}));

// Mock sanitizeBackupName
vi.mock("@/lib/sanitization", () => ({
  sanitizeBackupName: vi.fn(),
}));

describe("POST /api/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resume successfully from hibernating state", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.acquireServerAction.mockResolvedValue(undefined); // Success

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.publicIp).toBe("pending");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("resume");
    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "resume",
      userEmail: "admin@example.com",
      instanceId: "i-1234",
      args: [],
    });
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

    expect(mocks.acquireServerAction).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should pass backupName to Lambda when provided", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.acquireServerAction.mockResolvedValue(undefined);

    const req = createMockNextRequest("http://localhost/api/resume", {
      method: "POST",
      body: JSON.stringify({ backupName: "my-backup-2024" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.publicIp).toBe("pending");
    expect(body.data?.restoreOutput).toBe("Restore requested: my-backup-2024");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "resume",
      userEmail: "admin@example.com",
      instanceId: "i-1234",
      args: ["my-backup-2024"],
    });
  });

  it("should return 409 when another action is in progress", async () => {
    // Setup state - acquireServerAction throws error (conflict)
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.acquireServerAction.mockRejectedValue(new Error("Another operation is in progress: start"));

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is in progress");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("resume");
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should release lock if lambda invocation fails", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.acquireServerAction.mockResolvedValue(undefined);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Lambda failure");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("resume");
    expect(mocks.invokeLambda).toHaveBeenCalled();
    expect(mocks.releaseServerAction).toHaveBeenCalled();
  });
});
