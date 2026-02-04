import type { ApiResponse, HibernateResponse } from "@/lib/types";
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

describe("POST /api/hibernate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should hibernate successfully when running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<HibernateResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("asynchronously");
    expect(body.data?.instanceId).toBe("i-1234");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "hibernate",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: [],
    });
  });

  it("should return 400 when instance is not running", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("should handle lambda invocation failures", async () => {
    // Setup state
    mocks.getInstanceState.mockResolvedValue(ServerState.Running);
    mocks.invokeLambda.mockRejectedValue(new Error("Lambda failure"));

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Lambda failure");

    expect(mocks.invokeLambda).toHaveBeenCalled();
  });
});
