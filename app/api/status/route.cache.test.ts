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
    getRuntimeStateAdapterAsync: getRuntimeStateAdapterMock,
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

  it("lets authenticated smoke probes force a snapshot write before a subsequent read", async () => {
    getAuthUserMock.mockResolvedValue({ email: "smoke@example.com", role: "allowed" });
    runtimeStateFixture.seedSnapshot(snapshotCacheKeys.status, {
      generatedAt: "2026-01-02T03:03:00.000Z",
      instanceId: "i-stale",
      displayState: "stopped",
      hasVolume: false,
    });
    const { GET } = await import("./route");

    const refreshResponse = await GET(createMockNextRequest("http://localhost/api/status?refresh=1"));
    expect(refreshResponse.headers.get("X-Status-Cache")).toBe("MISS");
    const refreshProbe = refreshResponse.headers.get("X-Status-Refresh-Probe");
    expect(refreshProbe).toMatch(/^[a-f0-9]{32}$/);
    expect(findInstanceIdMock).toHaveBeenCalledOnce();
    expect(runtimeStateFixture.setSnapshotMock).toHaveBeenCalledOnce();
    expect(runtimeStateFixture.setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.objectContaining({ refreshProbe }) })
    );

    const readResponse = await GET(createMockNextRequest("http://localhost/api/status"));
    expect(readResponse.headers.get("X-Status-Cache")).toBe("HIT");
    expect(readResponse.headers.get("X-Status-Refresh-Probe")).toBe(refreshProbe);
    expect(findInstanceIdMock).toHaveBeenCalledOnce();
    const responseBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(readResponse);
    expect(JSON.stringify(responseBody)).not.toContain(refreshProbe);
  });

  it("returns service unavailable when production runtime state is misconfigured", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { RuntimeStateConfigurationError } = await import("@/lib/runtime-state/errors");

    getRuntimeStateAdapterMock.mockImplementation(() => {
      throw new RuntimeStateConfigurationError();
    });

    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/status");
    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(response);

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Runtime state service is unavailable");
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
