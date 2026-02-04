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
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  getInstanceState: mocks.getInstanceState,
  findInstanceId: mocks.findInstanceId,
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

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.publicIp).toBe("pending");

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

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Lambda failure");

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });
});
