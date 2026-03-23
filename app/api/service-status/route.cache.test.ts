import type { ApiResponse } from "@/lib/types";
import { freezeTime, restoreTime } from "@/tests/fixtures";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAllowedMock,
  checkRateLimitMock,
  findInstanceIdMock,
  getInstanceStateMock,
  executeSSMCommandMock,
  getRuntimeStateAdapterMock,
  getSnapshotMock,
  setSnapshotMock,
  snapshotState,
  snapshotCacheKeys,
  snapshotCacheTtlSeconds,
} = vi.hoisted(() => {
  return {
    requireAllowedMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    findInstanceIdMock: vi.fn(),
    getInstanceStateMock: vi.fn(),
    executeSSMCommandMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
    setSnapshotMock: vi.fn(),
    snapshotState: { value: null as unknown },
    snapshotCacheKeys: {
      serviceStatus: "service-status:test-key",
    },
    snapshotCacheTtlSeconds: {
      serviceStatus: 11,
    },
  };
});

vi.mock("@/lib/runtime-state/snapshot-cache", () => {
  return {
    snapshotCacheKeys,
    snapshotCacheTtlSeconds,
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

vi.mock("@/lib/aws", () => {
  return {
    findInstanceId: findInstanceIdMock,
    getInstanceState: getInstanceStateMock,
    executeSSMCommand: executeSSMCommandMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

describe("GET /api/service-status cache contract", () => {
  const toleratedSnapshotStalenessMs = snapshotCacheTtlSeconds.serviceStatus * 1000;

  beforeEach(() => {
    freezeTime("2026-01-02T03:04:05.000Z");
    snapshotState.value = null;

    requireAllowedMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 19,
      retryAfterSeconds: 0,
    });
    findInstanceIdMock.mockResolvedValue("i-1234567890abcdef0");
    getInstanceStateMock.mockResolvedValue("running");
    executeSSMCommandMock.mockResolvedValue("active\n");

    getSnapshotMock.mockImplementation(async () => {
      if (snapshotState.value) {
        return {
          ok: true,
          data: {
            status: "hit",
            value: snapshotState.value,
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        ok: true,
        data: {
          status: "miss",
        },
      };
    });

    setSnapshotMock.mockImplementation(async ({ value }: { value: unknown }) => {
      snapshotState.value = value;
      return {
        ok: true,
        data: {
          key: snapshotCacheKeys.serviceStatus,
        },
      };
    });

    getRuntimeStateAdapterMock.mockReturnValue({
      kind: "in-memory",
      incrementCounter: vi.fn(),
      checkCounter: vi.fn(),
      invalidateSnapshot: vi.fn(),
      getSnapshot: getSnapshotMock,
      setSnapshot: setSnapshotMock,
    });
  });

  afterEach(() => {
    restoreTime();
  });

  it("returns MISS then HIT and avoids repeated AWS checks", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/service-status");

    const missResponse = await GET(req);
    const missBody = await parseNextResponse<ApiResponse<unknown>>(missResponse);
    expect(missBody.success).toBe(true);
    expect(missBody.data).toEqual({
      serviceActive: true,
      instanceRunning: true,
    });
    expect(missResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(missResponse.headers.get("X-Service-Status-Cache")).toBe("MISS");

    const hitResponse = await GET(req);
    const hitBody = await parseNextResponse<ApiResponse<unknown>>(hitResponse);
    expect(hitBody.success).toBe(true);
    expect(hitBody).toEqual(missBody);
    expect(hitResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(hitResponse.headers.get("X-Service-Status-Cache")).toBe("HIT");

    expect(findInstanceIdMock).toHaveBeenCalledTimes(1);
    expect(getInstanceStateMock).toHaveBeenCalledTimes(1);
    expect(executeSSMCommandMock).toHaveBeenCalledTimes(1);
    expect(setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: snapshotCacheKeys.serviceStatus,
        ttlSeconds: snapshotCacheTtlSeconds.serviceStatus,
      })
    );
  });

  it("accepts bounded-stale cached payloads without strict freshness", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/service-status");

    const stalePayloadAgeMs = toleratedSnapshotStalenessMs - 1_000;
    const staleTimestamp = new Date(Date.now() - stalePayloadAgeMs).toISOString();

    snapshotState.value = {
      payload: {
        success: true,
        data: {
          serviceActive: true,
          instanceRunning: true,
        },
        timestamp: staleTimestamp,
      },
    };

    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(response);

    expect(response.headers.get("X-Service-Status-Cache")).toBe("HIT");
    expect(body.success).toBe(true);
    expect(body.timestamp).toBe(staleTimestamp);

    const observedStalenessMs = Date.now() - Date.parse(body.timestamp);
    expect(observedStalenessMs).toBeGreaterThan(0);
    expect(observedStalenessMs).toBeLessThanOrEqual(toleratedSnapshotStalenessMs);

    expect(findInstanceIdMock).not.toHaveBeenCalled();
    expect(getInstanceStateMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
  });
});
