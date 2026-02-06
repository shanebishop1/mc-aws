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
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  getInstanceState: mocks.getInstanceState,
  findInstanceId: mocks.findInstanceId,
}));

// Mock requireAllowed to return a fake user
vi.mock("@/lib/api-auth", () => ({
  requireAllowed: vi.fn().mockResolvedValue({ email: "test@example.com", role: "admin" }),
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

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("initiated");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "start",
      userEmail: "test@example.com",
      instanceId: "i-1234",
    });
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

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    // Should use the server-side resolved ID, not the caller-provided one
    expect(body.data?.instanceId).toBe("i-1234");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "start",
      userEmail: "test@example.com",
      instanceId: "i-1234", // Server-side resolved ID
    });
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

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });
});
