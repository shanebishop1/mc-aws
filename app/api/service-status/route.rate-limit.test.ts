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

describe("GET /api/service-status without route rate-limiting", () => {
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
  });

  it("does not throttle responses and does not emit throttle headers", async () => {
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
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(res.headers.get("X-Service-Status-Cache")).toBe("HIT");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("does not throttle sequential requests", async () => {
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

    const firstResponse = await GET(req);
    const firstBody = await parseNextResponse<ApiResponse<unknown>>(firstResponse);
    expect(firstResponse.status).toBe(200);
    expect(firstBody.success).toBe(true);
    expect(firstResponse.headers.get("X-Service-Status-Cache")).toBe("HIT");
    expect(firstResponse.headers.get("Retry-After")).toBeNull();

    const secondResponse = await GET(req);
    const secondBody = await parseNextResponse<ApiResponse<unknown>>(secondResponse);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.success).toBe(true);
    expect(secondResponse.headers.get("Retry-After")).toBeNull();
    expect(secondResponse.headers.get("X-Service-Status-Cache")).toBe("HIT");

    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });
});
