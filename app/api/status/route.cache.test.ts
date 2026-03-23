import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { createRuntimeStateAdapterFixture, freezeTime, restoreTime } from "@/tests/fixtures";
import type { RuntimeStateAdapterFixture } from "@/tests/fixtures/runtime-state";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkRateLimitMock,
  findInstanceIdMock,
  getInstanceDetailsMock,
  getAuthUserMock,
  getRuntimeStateAdapterMock,
  emitRuntimeStateTelemetryMock,
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
  let runtimeStateFixture: RuntimeStateAdapterFixture;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    freezeTime("2026-01-02T03:04:05.000Z");

    runtimeStateFixture = createRuntimeStateAdapterFixture();

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

    getRuntimeStateAdapterMock.mockReturnValue(runtimeStateFixture.adapter);
  });

  afterEach(() => {
    restoreTime();
    vi.unstubAllEnvs();
  });

  it("returns MISS then HIT using runtime-state snapshots", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/status");

    const missResponse = await GET(req);
    const missBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(missResponse);
    expect(missBody.success).toBe(true);
    expect(missBody.data).toMatchObject({
      state: "running",
      instanceId: "redacted",
      domain: "mc.example.com",
      hasVolume: true,
    });
    expect(missBody.data?.lastUpdated).toBe(missBody.timestamp);
    expect(missResponse.headers.get("X-Status-Cache")).toBe("MISS");

    const hitResponse = await GET(req);
    const hitBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(hitResponse);
    expect(hitBody.success).toBe(true);
    expect(hitBody).toEqual(missBody);
    expect(hitResponse.headers.get("X-Status-Cache")).toBe("HIT");

    expect(findInstanceIdMock).toHaveBeenCalledTimes(1);
    expect(getInstanceDetailsMock).toHaveBeenCalledTimes(1);
    expect(runtimeStateFixture.setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: snapshotCacheKeys.status,
        ttlSeconds: snapshotCacheTtlSeconds.status,
      })
    );
  });
});
