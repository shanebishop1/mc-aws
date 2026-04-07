import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("GET /api/auth/callback rate-limit contract", () => {
  beforeEach(() => {
    checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 29,
    });
  });

  it("returns redirect throttle response with Retry-After header", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=abc&state=xyz", {
      headers: {
        "cf-connecting-ip": "198.51.100.25",
      },
    });
    const res = await GET(req);

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/auth/callback",
      key: "auth:callback:198.51.100.25",
      limit: 6,
      windowMs: 60_000,
      failureMode: "closed",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_rate_limited");
    expect(res.headers.get("Retry-After")).toBe("29");
  });
});
