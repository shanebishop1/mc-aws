import type { ApiResponse, CostData } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

type CostsResponseData = CostData & { cachedAt?: number };

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

describe("GET /api/costs mock/aws parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotState.value = null;

    requireAdminMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });
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

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("returns success response-contract parity in $mode mode", async ({ isMock }) => {
    isMockModeMock.mockReturnValue(isMock);

    const req = createMockNextRequest("http://localhost/api/costs");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<CostsResponseData>>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      totalCost: "10.00",
      currency: "USD",
      period: {
        start: "2026-03-01",
        end: "2026-03-31",
      },
      breakdown: [{ service: "Amazon EC2", cost: "10.00" }],
      fetchedAt: "2026-03-22T00:00:00.000Z",
    });
    expect(typeof body.data?.cachedAt).toBe("number");
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Costs-Cache")).toBe("MISS");

    if (isMock) {
      expect(getSnapshotMock).not.toHaveBeenCalled();
      expect(setSnapshotMock).not.toHaveBeenCalled();
      return;
    }

    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
    expect(setSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("applies refresh semantics in $mode mode", async ({ isMock }) => {
    isMockModeMock.mockReturnValue(isMock);
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1_000;
      return now;
    });

    const baseReq = createMockNextRequest("http://localhost/api/costs");
    const refreshReq = createMockNextRequest("http://localhost/api/costs?refresh=true");

    const firstRes = await GET(baseReq);
    const firstBody = await parseNextResponse<ApiResponse<CostsResponseData>>(firstRes);

    const secondRes = await GET(baseReq);
    const secondBody = await parseNextResponse<ApiResponse<CostsResponseData>>(secondRes);

    const refreshRes = await GET(refreshReq);
    const refreshBody = await parseNextResponse<ApiResponse<CostsResponseData>>(refreshRes);

    expect(firstBody.success).toBe(true);
    expect(secondBody.success).toBe(true);
    expect(refreshBody.success).toBe(true);

    if (isMock) {
      expect(firstRes.headers.get("X-Costs-Cache")).toBe("MISS");
      expect(secondRes.headers.get("X-Costs-Cache")).toBe("MISS");
      expect(secondBody.data?.cachedAt).toBeGreaterThan(firstBody.data?.cachedAt ?? 0);
      expect(getCostsMock).toHaveBeenCalledTimes(3);
    } else {
      expect(firstRes.headers.get("X-Costs-Cache")).toBe("MISS");
      expect(secondRes.headers.get("X-Costs-Cache")).toBe("HIT");
      expect(secondBody.data?.cachedAt).toBe(firstBody.data?.cachedAt);
      expect(getCostsMock).toHaveBeenCalledTimes(2);
    }

    expect(refreshRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(refreshRes.headers.get("X-Costs-Cache")).toBe("MISS");
    expect(refreshBody.data?.cachedAt).toBeGreaterThan(firstBody.data?.cachedAt ?? 0);

    nowSpy.mockRestore();
  });

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("returns parity error contract in $mode mode", async ({ isMock }) => {
    isMockModeMock.mockReturnValue(isMock);
    getCostsMock.mockRejectedValue(new Error("upstream failure"));

    const req = createMockNextRequest("http://localhost/api/costs");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<CostsResponseData>>(res);

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch cost data");
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Costs-Cache")).toBe("MISS");
  });
});
