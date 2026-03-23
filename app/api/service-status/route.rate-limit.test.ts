import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { checkRateLimitMock, requireAllowedMock, getRuntimeStateAdapterMock, getSnapshotMock } = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
    requireAllowedMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    requireAllowed: requireAllowedMock,
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
  };
});

vi.mock("@/lib/aws", () => {
  return {
    findInstanceId: vi.fn(),
    getInstanceState: vi.fn(),
    executeSSMCommand: vi.fn(),
  };
});

describe("GET /api/service-status strict counter/throttle contract", () => {
  beforeEach(() => {
    requireAllowedMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });
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
      retryAfterSeconds: 19,
    });
  });

  it("returns 429 with backward-compatible throttle headers", async () => {
    const req = createMockNextRequest("http://localhost/api/service-status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/service-status",
      key: "service-status:unknown",
      limit: 20,
      windowMs: 60_000,
    });
    expect(res.headers.get("Retry-After")).toBe("19");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Service-Status-Cache")).toBeNull();
  });

  it("enforces strict boundary then throttle sequencing", async () => {
    checkRateLimitMock
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0,
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 8,
      });

    getSnapshotMock.mockResolvedValue({
      ok: true,
      data: {
        status: "hit",
        value: {
          payload: {
            success: true,
            data: {
              serviceActive: true,
              instanceRunning: true,
            },
            timestamp: "2026-01-02T03:04:05.000Z",
          },
        },
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
    });

    const req = createMockNextRequest("http://localhost/api/service-status");

    const boundaryResponse = await GET(req);
    const boundaryBody = await parseNextResponse<ApiResponse<unknown>>(boundaryResponse);
    expect(boundaryResponse.status).toBe(200);
    expect(boundaryBody.success).toBe(true);
    expect(boundaryResponse.headers.get("X-Service-Status-Cache")).toBe("HIT");
    expect(boundaryResponse.headers.get("Retry-After")).toBeNull();

    const throttledResponse = await GET(req);
    const throttledBody = await parseNextResponse<ApiResponse<unknown>>(throttledResponse);
    expect(throttledResponse.status).toBe(429);
    expect(throttledBody.success).toBe(false);
    expect(throttledResponse.headers.get("Retry-After")).toBe("8");
    expect(throttledResponse.headers.get("X-Service-Status-Cache")).toBeNull();

    expect(checkRateLimitMock).toHaveBeenCalledTimes(2);
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
