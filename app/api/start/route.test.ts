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
    mocks.acquireServerAction.mockResolvedValue(undefined); // Success

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("initiated");
    expect(body.data?.publicIp).toBe("pending");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("start");
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

    expect(mocks.acquireServerAction).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should return 409 when another action is in progress", async () => {
    // Setup state - acquireServerAction throws error (conflict)
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);
    mocks.acquireServerAction.mockRejectedValue(new Error("Another operation is in progress: stop"));

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is in progress");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("start");
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should use instanceId from request body if provided", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);
    mocks.acquireServerAction.mockResolvedValue(undefined);

    const req = createMockNextRequest("http://localhost/api/start", {
      method: "POST",
      body: JSON.stringify({ instanceId: "i-custom-id" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.instanceId).toBe("i-custom-id");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "start",
      userEmail: "test@example.com",
      instanceId: "i-custom-id",
    });
  });

  it("should release lock if lambda invocation fails", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);
    mocks.acquireServerAction.mockResolvedValue(undefined);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Lambda failure");

    expect(mocks.acquireServerAction).toHaveBeenCalledWith("start");
    expect(mocks.invokeLambda).toHaveBeenCalled();
    expect(mocks.releaseServerAction).toHaveBeenCalled();
  });
});
