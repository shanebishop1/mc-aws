import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkRateLimitMock,
  findInstanceIdMock,
  getInstanceDetailsMock,
  getAuthUserMock,
  getRuntimeStateAdapterMock,
  emitRuntimeStateTelemetryMock,
  getSnapshotMock,
  setSnapshotMock,
  snapshotState,
  snapshotCacheKeys,
  snapshotCacheTtlSeconds,
} = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
    findInstanceIdMock: vi.fn(),
    getInstanceDetailsMock: vi.fn(),
    getAuthUserMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    emitRuntimeStateTelemetryMock: vi.fn(),
    getSnapshotMock: vi.fn(),
    setSnapshotMock: vi.fn(),
    snapshotState: { value: null as unknown },
    snapshotCacheKeys: {
      status: "status:test-key",
    },
    snapshotCacheTtlSeconds: {
      status: 17,
    },
  };
});

vi.mock("@/lib/runtime-state/snapshot-cache", () => {
  return {
    snapshotCacheKeys,
    snapshotCacheTtlSeconds,
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
    getInstanceDetails: getInstanceDetailsMock,
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    getAuthUser: getAuthUserMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
    emitRuntimeStateTelemetry: emitRuntimeStateTelemetryMock,
  };
});

describe("GET /api/status cache contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");

    snapshotState.value = null;

    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 29,
      retryAfterSeconds: 0,
    });
    getAuthUserMock.mockResolvedValue(null);
    findInstanceIdMock.mockResolvedValue("i-1234567890abcdef0");
    getInstanceDetailsMock.mockResolvedValue({
      state: "running",
      blockDeviceMappings: [{ deviceName: "/dev/sda1", ebs: { volumeId: "vol-1" } }],
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
          key: snapshotCacheKeys.status,
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
    vi.unstubAllEnvs();
  });

  it("returns MISS then HIT using runtime-state snapshots", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/status");

    const missResponse = await GET(req);
    const missBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(missResponse);
    expect(missBody.success).toBe(true);
    expect(missResponse.headers.get("X-Status-Cache")).toBe("MISS");

    const hitResponse = await GET(req);
    const hitBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(hitResponse);
    expect(hitBody.success).toBe(true);
    expect(hitResponse.headers.get("X-Status-Cache")).toBe("HIT");

    expect(findInstanceIdMock).toHaveBeenCalledTimes(1);
    expect(getInstanceDetailsMock).toHaveBeenCalledTimes(1);
    expect(setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: snapshotCacheKeys.status,
        ttlSeconds: snapshotCacheTtlSeconds.status,
      })
    );
  });
});
