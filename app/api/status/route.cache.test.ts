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
  const toleratedSnapshotStalenessMs = snapshotCacheTtlSeconds.status * 1000;
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

  it("tolerates bounded snapshot staleness for cache hits", async () => {
    const { GET } = await import("./route");

    const staleSnapshotAgeMs = toleratedSnapshotStalenessMs - 1_000;
    const staleGeneratedAt = new Date(Date.now() - staleSnapshotAgeMs).toISOString();

    runtimeStateFixture.seedSnapshot(snapshotCacheKeys.status, {
      generatedAt: staleGeneratedAt,
      instanceId: "i-1234567890abcdef0",
      displayState: "running",
      hasVolume: true,
    });

    const req = createMockNextRequest("http://localhost/api/status");
    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(response);

    expect(response.headers.get("X-Status-Cache")).toBe("HIT");
    expect(body.success).toBe(true);
    expect(body.timestamp).toBe(staleGeneratedAt);

    const observedStalenessMs = Date.now() - Date.parse(body.timestamp);
    expect(observedStalenessMs).toBeGreaterThan(0);
    expect(observedStalenessMs).toBeLessThanOrEqual(toleratedSnapshotStalenessMs);

    expect(findInstanceIdMock).not.toHaveBeenCalled();
    expect(getInstanceDetailsMock).not.toHaveBeenCalled();
  });

  it("propagates runtime-state misconfiguration as a route fallback error", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");

    getRuntimeStateAdapterMock.mockImplementation(() => {
      throw new Error(
        "[RUNTIME-STATE] Missing or invalid Cloudflare runtime-state binding in production. Ensure RUNTIME_STATE_DURABLE_OBJECT is configured; production cannot fall back to in-memory runtime-state."
      );
    });

    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/status");
    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(response);

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch server status");
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    expect(findInstanceIdMock).not.toHaveBeenCalled();
    expect(getInstanceDetailsMock).not.toHaveBeenCalled();
    expect(emitRuntimeStateTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "status.snapshot-cache",
        outcome: "FALLBACK",
        route: "/api/status",
        key: snapshotCacheKeys.status,
        reason: "status_fetch_failed",
      })
    );
  });
});
