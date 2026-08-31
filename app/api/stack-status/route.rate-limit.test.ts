import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { checkRateLimitMock, getAuthUserMock, getRuntimeStateAdapterMock, getSnapshotMock } = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
    getAuthUserMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
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

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

vi.mock("@/lib/aws", () => {
  return {
    getStackStatus: vi.fn(),
  };
});

describe("GET /api/stack-status strict counter/throttle contract", () => {
  beforeEach(() => {
    getAuthUserMock.mockResolvedValue(null);
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
      retryAfterSeconds: 27,
    });
  });

  it("returns 429 with backward-compatible throttle headers", async () => {
    const req = createMockNextRequest("http://localhost/api/stack-status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/stack-status",
      key: "stack-status:unknown",
      limit: 15,
      windowMs: 60_000,
    });
    expect(res.headers.get("Retry-After")).toBe("27");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Stack-Status-Cache")).toBeNull();
    expect(getSnapshotMock).not.toHaveBeenCalled();
  });
});
