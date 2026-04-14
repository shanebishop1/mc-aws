import { resetProvider } from "@/lib/aws/provider-selector";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-stop-123" }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

describe("POST /api/stop", () => {
  let previousBackendMode: string | undefined;

  beforeEach(() => {
    previousBackendMode = process.env.MC_BACKEND_MODE;
    process.env.MC_BACKEND_MODE = "aws";
    resetProvider();
  });

  afterEach(() => {
    if (previousBackendMode === undefined) {
      process.env.MC_BACKEND_MODE = undefined;
    } else {
      process.env.MC_BACKEND_MODE = previousBackendMode;
    }
    resetProvider();
  });

  it("should stop the server successfully when running", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");

    // 1. getInstanceState -> running
    // 2. stopInstance -> success
    mockEC2Client.send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }] })
      .mockResolvedValueOnce({});

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StopServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("stop command sent successfully");
    expect(body.operation?.type).toBe("stop");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("stop-");
  });

  it("should return 400 when instance is already stopped", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");

    // 1. getInstanceState -> stopped
    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            { State: { Name: "stopped" }, InstanceId: "i-1234", BlockDeviceMappings: [{ DeviceName: "/dev/sda1" }] },
          ],
        },
      ],
    });

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already stopped");
    expect(body.operation?.status).toBe("failed");
  });

  it("returns failed operation metadata for auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication required");
    expect(body.operation?.type).toBe("stop");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("stop-");
  });

  it("returns failed operation metadata for lock conflicts", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");

    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }],
    });

    mocks.acquireServerActionLock.mockRejectedValueOnce(new Error("lock conflict"));
    mocks.isServerActionLockConflictError.mockReturnValueOnce(true);

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Another operation is already in progress");
    expect(body.operation?.type).toBe("stop");
    expect(body.operation?.status).toBe("failed");
    expect(body.operation?.id).toContain("stop-");
  });
});
