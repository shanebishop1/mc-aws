import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { checkRateLimitMock } = vi.hoisted(() => {
  return {
    checkRateLimitMock: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");

  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
  };
});

describe("GET /api/service-status rate-limit contract", () => {
  beforeEach(() => {
    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 19,
    });
  });

  it("returns 429 with backward-compatible throttle headers", async () => {
    const req = createMockNextRequest("http://localhost/api/service-status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      key: "service-status:unknown",
      limit: 20,
      windowMs: 60_000,
    });
    expect(res.headers.get("Retry-After")).toBe("19");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
