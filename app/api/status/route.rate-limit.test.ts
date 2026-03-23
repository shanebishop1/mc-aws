import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("GET /api/status rate-limit contract", () => {
  beforeEach(() => {
    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 11,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 429 with backward-compatible throttle headers", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(res.status).toBe(429);
    expect(body.success).toBe(false);
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      key: "status:unknown",
      limit: 30,
      windowMs: 60_000,
    });
    expect(res.headers.get("Retry-After")).toBe("11");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
