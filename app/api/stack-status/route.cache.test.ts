import type { ApiResponse } from "@/lib/types";
import { freezeTime, restoreTime } from "@/tests/fixtures";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUserMock,
  checkRateLimitMock,
  getStackStatusMock,
  getRuntimeStateAdapterMock,
  getSnapshotMock,
  setSnapshotMock,
  snapshotState,
  snapshotCacheKeys,
  snapshotCacheTtlSeconds,
} = vi.hoisted(() => {
  return {
    getAuthUserMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    getStackStatusMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
    setSnapshotMock: vi.fn(),
    snapshotState: { value: null as unknown },
    snapshotCacheKeys: {
      stackStatus: "stack-status:test-key",
    },
    snapshotCacheTtlSeconds: {
      stackStatus: 19,
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

vi.mock("@/lib/aws", () => {
  return {
    getStackStatus: getStackStatusMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

describe("GET /api/stack-status cache contract", () => {
  const toleratedSnapshotStalenessMs = snapshotCacheTtlSeconds.stackStatus * 1000;

  beforeEach(() => {
    freezeTime("2026-01-02T03:04:05.000Z");
    snapshotState.value = null;

    getAuthUserMock.mockResolvedValue(null);
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 14,
      retryAfterSeconds: 0,
    });
    getStackStatusMock.mockResolvedValue({
      StackStatus: "CREATE_COMPLETE",
      StackId: "stack-123",
    });

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
          key: snapshotCacheKeys.stackStatus,
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

  it("returns MISS then HIT with stack snapshot cache", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/stack-status");

    const missResponse = await GET(req);
    const missBody = await parseNextResponse<ApiResponse<unknown>>(missResponse);
    expect(missBody.success).toBe(true);
    expect(missBody.data).toEqual({
      exists: true,
      status: "CREATE_COMPLETE",
      stackId: "redacted",
    });
    expect(typeof missBody.timestamp).toBe("string");
    expect(missResponse.headers.get("Vary")).toBe("Cookie");
    expect(missResponse.headers.get("X-Stack-Status-Cache")).toBe("MISS");

    const hitResponse = await GET(req);
    const hitBody = await parseNextResponse<ApiResponse<unknown>>(hitResponse);
    expect(hitBody.success).toBe(true);
    expect(hitBody).toEqual(missBody);
    expect(hitResponse.headers.get("Vary")).toBe("Cookie");
    expect(hitResponse.headers.get("X-Stack-Status-Cache")).toBe("HIT");

    expect(getStackStatusMock).toHaveBeenCalledTimes(1);
    expect(setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: snapshotCacheKeys.stackStatus,
        ttlSeconds: snapshotCacheTtlSeconds.stackStatus,
      })
    );
  });

  it("allows stale-but-bounded snapshots on cache HIT", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/stack-status");

    const staleSnapshotAgeMs = toleratedSnapshotStalenessMs - 1_000;
    const staleGeneratedAt = new Date(Date.now() - staleSnapshotAgeMs).toISOString();

    snapshotState.value = {
      generatedAt: staleGeneratedAt,
      exists: true,
      status: "CREATE_COMPLETE",
      stackId: "stack-123",
    };

    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(response);

    expect(response.headers.get("X-Stack-Status-Cache")).toBe("HIT");
    expect(body.success).toBe(true);
    expect(body.timestamp).toBe(staleGeneratedAt);

    const observedStalenessMs = Date.now() - Date.parse(body.timestamp);
    expect(observedStalenessMs).toBeGreaterThan(0);
    expect(observedStalenessMs).toBeLessThanOrEqual(toleratedSnapshotStalenessMs);

    expect(getStackStatusMock).not.toHaveBeenCalled();
  });
});
