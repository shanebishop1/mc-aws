import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimitMock, getAuthUserMock, getRuntimeStateAdapterMock, getSnapshotMock } = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
    getAuthUserMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    getAuthUser: getAuthUserMock,
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");

  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
    emitRuntimeStateTelemetry: vi.fn(),
  };
});

vi.mock("@/lib/aws", () => {
  return {
    findInstanceId: vi.fn(),
    getInstanceDetails: vi.fn(),
  };
});

describe("GET /api/status rate-limit contract", () => {
  beforeEach(() => {
    getAuthUserMock.mockResolvedValue(null);
    getRuntimeStateAdapterMock.mockReturnValue({
      kind: "in-memory",
      incrementCounter: vi.fn(),
      checkCounter: vi.fn(),
      invalidateSnapshot: vi.fn(),
      getSnapshot: getSnapshotMock,
      setSnapshot: vi.fn(),
    });

    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 11,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 429 with backward-compatible throttle headers", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/status",
      key: "status:unknown",
      limit: 30,
      windowMs: 60_000,
    });
    expect(res.headers.get("Retry-After")).toBe("11");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Status-Cache")).toBeNull();
  });

  it("allows a boundary request and throttles the next request", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");

    checkRateLimitMock
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 13,
      });

    getSnapshotMock.mockResolvedValue({
      ok: true,
      data: {
        status: "hit",
        value: {
          generatedAt: "2026-01-02T03:04:05.000Z",
          instanceId: "i-1234567890abcdef0",
          displayState: "running",
          hasVolume: true,
        },
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
    });

    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/status");

    const boundaryResponse = await GET(req);
    const boundaryBody = await parseNextResponse<ApiResponse<unknown>>(boundaryResponse);
    expect(boundaryResponse.status).toBe(200);
    expect(boundaryBody.success).toBe(true);
    expect(boundaryResponse.headers.get("X-Status-Cache")).toBe("HIT");
    expect(boundaryResponse.headers.get("Retry-After")).toBeNull();

    const throttledResponse = await GET(req);
    const throttledBody = await parseNextResponse<ApiResponse<unknown>>(throttledResponse);
    expect(throttledResponse.status).toBe(429);
    expect(throttledBody.success).toBe(false);
    expect(throttledResponse.headers.get("Retry-After")).toBe("13");
    expect(throttledResponse.headers.get("X-Status-Cache")).toBeNull();

    expect(checkRateLimitMock).toHaveBeenCalledTimes(2);
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
