import { createOperationInfo } from "@/lib/operation";
import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimitMock, getClientIpMock } = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
    getClientIpMock: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
    getClientIp: getClientIpMock,
  };
});

describe("enforceMutatingRouteThrottle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    getClientIpMock.mockReturnValue("203.0.113.7");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when request is allowed", async () => {
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 3,
      retryAfterSeconds: 0,
    });

    const { enforceMutatingRouteThrottle } = await import("./mutating-route-throttle");
    const operation = createOperationInfo("start", "running");
    const request = createMockNextRequest("http://localhost/api/start", { method: "POST" });

    const response = await enforceMutatingRouteThrottle({
      request,
      route: "/api/start",
      operation,
      identity: "Admin@Example.com",
    });

    expect(response).toBeNull();
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/start",
      key: "mutate:start:admin@example.com",
      limit: 4,
      windowMs: 30_000,
      failureMode: "closed",
    });
  });

  it("returns 429 with operation metadata when throttled", async () => {
    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    });

    const { enforceMutatingRouteThrottle } = await import("./mutating-route-throttle");
    const operation = createOperationInfo("stop", "running");
    const request = createMockNextRequest("http://localhost/api/stop", { method: "POST" });

    const response = await enforceMutatingRouteThrottle({
      request,
      route: "/api/stop",
      operation,
      identity: "admin@example.com",
    });

    expect(response).not.toBeNull();
    const payload = await parseNextResponse<ApiResponse<unknown>>(response!);

    expect(response?.status).toBe(429);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Too many stop requests. Please retry shortly.");
    expect(payload.operation?.type).toBe("stop");
    expect(payload.operation?.status).toBe("failed");
    expect(response?.headers.get("Retry-After")).toBe("17");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("skips throttling by default in test env", async () => {
    vi.stubEnv("NODE_ENV", "test");

    const { enforceMutatingRouteThrottle } = await import("./mutating-route-throttle");
    const operation = createOperationInfo("backup", "running");
    const request = createMockNextRequest("http://localhost/api/backup", { method: "POST" });

    const response = await enforceMutatingRouteThrottle({
      request,
      route: "/api/backup",
      operation,
      identity: "admin@example.com",
    });

    expect(response).toBeNull();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("can enforce throttling in tests when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_ENABLE_RATE_LIMIT_IN_TESTS", "true");
    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 9,
    });

    const { enforceMutatingRouteThrottle } = await import("./mutating-route-throttle");
    const operation = createOperationInfo("resume", "running");
    const request = createMockNextRequest("http://localhost/api/resume", { method: "POST" });

    const response = await enforceMutatingRouteThrottle({
      request,
      route: "/api/resume",
      operation,
    });

    expect(response?.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/resume",
      key: "mutate:resume:203.0.113.7",
      limit: 4,
      windowMs: 30_000,
      failureMode: "closed",
    });
  });
});
