import type { ApiResponse, CostData } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdminMock,
  getCostsMock,
  isMockModeMock,
  getRuntimeStateAdapterMock,
  getSnapshotMock,
  setSnapshotMock,
  snapshotState,
} = vi.hoisted(() => {
  return {
    requireAdminMock: vi.fn(),
    getCostsMock: vi.fn(),
    isMockModeMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
    setSnapshotMock: vi.fn(),
    snapshotState: { value: null as unknown },
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    requireAdmin: requireAdminMock,
  };
});

vi.mock("@/lib/aws", () => {
  return {
    getCosts: getCostsMock,
  };
});

vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
  return {
    ...actual,
    isMockMode: isMockModeMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

describe("GET /api/costs cache contract", () => {
  beforeEach(() => {
    vi.resetModules();
    snapshotState.value = null;

    requireAdminMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    isMockModeMock.mockReturnValue(false);
    getCostsMock.mockResolvedValue({
      totalCost: "10.00",
      currency: "USD",
      period: {
        start: "2026-03-01",
        end: "2026-03-31",
      },
      breakdown: [
        {
          service: "Amazon EC2",
          cost: "10.00",
        },
      ],
      fetchedAt: "2026-03-22T00:00:00.000Z",
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
          key: "costs:latest",
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

  it("fetches on first cache miss", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/costs");

    const response = await GET(req);
    const body = await parseNextResponse<ApiResponse<CostData & { cachedAt?: number }>>(response);

    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      totalCost: "10.00",
      currency: "USD",
      period: {
        start: "2026-03-01",
        end: "2026-03-31",
      },
      breakdown: [
        {
          service: "Amazon EC2",
          cost: "10.00",
        },
      ],
      fetchedAt: "2026-03-22T00:00:00.000Z",
    });
    expect(body.data?.cachedAt).toBeDefined();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Costs-Cache")).toBe("MISS");

    expect(getCostsMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cache for repeated non-refresh requests", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/costs");

    const firstResponse = await GET(req);
    const firstBody = await parseNextResponse<ApiResponse<CostData & { cachedAt?: number }>>(firstResponse);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data?.cachedAt).toBeDefined();

    const secondResponse = await GET(req);
    const secondBody = await parseNextResponse<ApiResponse<CostData & { cachedAt?: number }>>(secondResponse);
    expect(secondBody.success).toBe(true);
    expect(secondBody.data).toMatchObject({
      totalCost: "10.00",
      currency: "USD",
    });
    expect(secondBody.data?.cachedAt).toBe(firstBody.data?.cachedAt);
    expect(secondResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(secondResponse.headers.get("X-Costs-Cache")).toBe("HIT");

    expect(getCostsMock).toHaveBeenCalledTimes(1);
  });

  it("forces a fresh AWS fetch when refresh=true", async () => {
    const { GET } = await import("./route");
    const baseReq = createMockNextRequest("http://localhost/api/costs");
    const refreshReq = createMockNextRequest("http://localhost/api/costs?refresh=true");

    const firstResponse = await GET(baseReq);
    const firstBody = await parseNextResponse<ApiResponse<CostData & { cachedAt?: number }>>(firstResponse);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data?.cachedAt).toBeDefined();

    const secondResponse = await GET(refreshReq);
    const secondBody = await parseNextResponse<ApiResponse<CostData & { cachedAt?: number }>>(secondResponse);

    expect(secondBody.success).toBe(true);
    expect(secondBody.data?.cachedAt).toBeDefined();
    expect(secondResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(secondResponse.headers.get("X-Costs-Cache")).toBe("MISS");

    expect(getCostsMock).toHaveBeenCalledTimes(2);
  });

  it("does not set ttlSeconds for costs snapshots", async () => {
    const { GET } = await import("./route");
    const req = createMockNextRequest("http://localhost/api/costs");

    await GET(req);

    expect(setSnapshotMock).toHaveBeenCalledTimes(1);
    const firstSetSnapshotCallArg = setSnapshotMock.mock.calls[0]?.[0] as { ttlSeconds?: number } | undefined;
    expect(firstSetSnapshotCallArg).toBeDefined();
    if (!firstSetSnapshotCallArg) {
      throw new Error("Expected setSnapshot to be called with a payload");
    }
    expect(firstSetSnapshotCallArg.ttlSeconds).toBeUndefined();
    expect("ttlSeconds" in firstSetSnapshotCallArg).toBe(false);

    expect(setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "costs:latest",
      })
    );
  });
});
