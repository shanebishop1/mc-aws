import { resetProvider } from "@/lib/aws/provider-selector";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-stop-123", fencingToken: 7 }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
  enforceMutatingRouteThrottle: vi.fn().mockResolvedValue(null),
  mapMutatingRouteThrottleFailure: vi.fn(async (response: Response, operation: string) => ({
    decision: {
      allowed: false,
      httpStatus: response.status,
      code: "throttled",
      message: `Too many ${operation} requests. Please retry shortly.`,
    },
    retryAfterHeader: response.headers.get("Retry-After") ?? undefined,
    cacheControlHeader: response.headers.get("Cache-Control") ?? undefined,
  })),
  invokeLambda: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/aws", async () => {
  const actual = await vi.importActual<typeof import("@/lib/aws")>("@/lib/aws");
  return { ...actual, invokeLambda: mocks.invokeLambda };
});

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

vi.mock("@/lib/mutating-route-throttle", () => ({
  enforceMutatingRouteThrottle: mocks.enforceMutatingRouteThrottle,
  mapMutatingRouteThrottleFailure: mocks.mapMutatingRouteThrottleFailure,
}));

describe("POST /api/stop", () => {
  let previousBackendMode: string | undefined;

  beforeEach(() => {
    previousBackendMode = process.env.MC_BACKEND_MODE;
    process.env.MC_BACKEND_MODE = "aws";
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.enforceMutatingRouteThrottle.mockResolvedValue(null);
    mocks.isServerActionLockConflictError.mockReturnValue(false);
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

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<StopServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("stop command sent successfully");
    expect(body.operation?.type).toBe("stop");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("stop-");
    expect(mocks.enforceMutatingRouteThrottle).toHaveBeenCalledTimes(1);
    expect(mocks.invokeLambda).toHaveBeenCalledWith(
      "StartMinecraftServer",
      expect.objectContaining({ command: "stop", lockId: "lock-stop-123", fencingToken: 7 })
    );
    expect(mocks.releaseServerActionLock).not.toHaveBeenCalled();
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

  it("keeps the durable stop operation and lock pending when Lambda dispatch is ambiguous", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");
    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }],
    });
    mocks.invokeLambda.mockRejectedValueOnce(Object.assign(new Error("socket reset"), { name: "TimeoutError" }));

    const res = await POST(createMockNextRequest("http://localhost/api/stop", { method: "POST" }));
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(503);
    expect(body.operation?.status).toBe("accepted");
    expect(mocks.releaseServerActionLock).not.toHaveBeenCalled();
  });

  it("terminalizes and releases when Lambda definitely rejects the event", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");
    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }],
    });
    mocks.invokeLambda.mockRejectedValueOnce(
      Object.assign(new Error("function not found"), {
        name: "ResourceNotFoundException",
        $metadata: { httpStatusCode: 404, requestId: "request-id" },
      })
    );

    const res = await POST(createMockNextRequest("http://localhost/api/stop", { method: "POST" }));
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(500);
    expect(body.operation?.status).toBe("failed");
    expect(mocks.releaseServerActionLock).toHaveBeenCalledWith(
      "lock-stop-123",
      expect.objectContaining({ action: "stop", fencingToken: 7 })
    );
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

  it("returns 429 with throttle headers when mutating throttle is exceeded", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");

    mocks.enforceMutatingRouteThrottle.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: "Too many stop requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": "5",
            "Cache-Control": "no-store",
          },
        }
      )
    );

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Too many stop requests");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockEC2Client.send).not.toHaveBeenCalled();
  });

  it("runs lifecycle stages in auth -> throttle -> lock order", async () => {
    const { mockEC2Client } = await import("@/tests/mocks/aws");

    mockEC2Client.send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }] })
      .mockResolvedValueOnce({});

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(202);

    const authOrder = mocks.requireAdmin.mock.invocationCallOrder[0];
    const throttleOrder = mocks.enforceMutatingRouteThrottle.mock.invocationCallOrder[0];
    const lockOrder = mocks.acquireServerActionLock.mock.invocationCallOrder[0];
    const invokeOrder = mocks.invokeLambda.mock.invocationCallOrder[0];

    expect(authOrder).toBeLessThan(throttleOrder);
    expect(throttleOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(invokeOrder);
  });
});
