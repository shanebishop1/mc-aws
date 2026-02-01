import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Mock AWS module
const mockInvokeLambda = vi.fn();
const mockGetInstanceState = vi.fn();
const mockFindInstanceId = vi.fn().mockResolvedValue("i-1234");
const mockGetServerAction = vi.fn();
const mockSetServerAction = vi.fn();

vi.mock("@/lib/aws", () => ({
  invokeLambda: mockInvokeLambda,
  getInstanceState: mockGetInstanceState,
  findInstanceId: mockFindInstanceId,
  getServerAction: mockGetServerAction,
  setServerAction: mockSetServerAction,
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
    mockGetServerAction.mockResolvedValue(null);
    mockGetInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("initiated");
    expect(body.data?.publicIp).toBe("pending");

    expect(mockSetServerAction).toHaveBeenCalledWith("start");
    expect(mockInvokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "start",
      userEmail: "test@example.com",
      instanceId: "i-1234",
    });
  });

  it("should return 400 when instance is already running", async () => {
    // Setup state
    mockGetServerAction.mockResolvedValue(null);
    mockGetInstanceState.mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");

    expect(mockSetServerAction).not.toHaveBeenCalled();
    expect(mockInvokeLambda).not.toHaveBeenCalled();
  });

  it("should return 409 when another action is in progress", async () => {
    // Setup state - another action is in progress
    mockGetServerAction.mockResolvedValue({ action: "stop", timestamp: Date.now() });

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is in progress");

    expect(mockSetServerAction).not.toHaveBeenCalled();
    expect(mockInvokeLambda).not.toHaveBeenCalled();
  });

  it("should use instanceId from request body if provided", async () => {
    // Setup state
    mockGetServerAction.mockResolvedValue(null);
    mockGetInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/start", {
      method: "POST",
      body: JSON.stringify({ instanceId: "i-custom-id" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.instanceId).toBe("i-custom-id");

    expect(mockInvokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "start",
      userEmail: "test@example.com",
      instanceId: "i-custom-id",
    });
  });
});
