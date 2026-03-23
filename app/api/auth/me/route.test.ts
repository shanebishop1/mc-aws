import { expectSessionCookieCleared } from "@/tests/auth-contract-utils";
import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const cookieValues: Record<string, string | undefined> = {};

  return {
    verifySessionMock: vi.fn(),
    clearSessionCookieMock: vi.fn(() => ({
      name: "mc_session",
      value: "",
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 0,
    })),
    cookieValues,
    cookieStore: {
      get: vi.fn((name: string) => {
        const value = cookieValues[name];
        return value ? { value } : undefined;
      }),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE_NAME: "mc_session",
  verifySession: mocks.verifySessionMock,
  clearSessionCookie: mocks.clearSessionCookieMock,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

describe("GET /api/auth/me regression contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieValues.mc_session = undefined;
  });

  it("returns unauthenticated payload when session cookie is missing", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
    expect(mocks.verifySessionMock).not.toHaveBeenCalled();
    expect(mocks.clearSessionCookieMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns unauthenticated payload and clears cookie when session is invalid", async () => {
    mocks.cookieValues.mc_session = "invalid-token";
    mocks.verifySessionMock.mockResolvedValue(null);

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
    expect(mocks.verifySessionMock).toHaveBeenCalledWith("invalid-token");
    expect(mocks.clearSessionCookieMock).toHaveBeenCalledTimes(1);

    expectSessionCookieCleared(res.headers.get("set-cookie"));
  });

  it("returns authenticated payload when session is valid", async () => {
    mocks.cookieValues.mc_session = "valid-token";
    mocks.verifySessionMock.mockResolvedValue({
      email: "admin@example.com",
      role: "admin",
    });

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      authenticated: true,
      email: "admin@example.com",
      role: "admin",
    });
    expect(mocks.verifySessionMock).toHaveBeenCalledWith("valid-token");
    expect(mocks.clearSessionCookieMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns unauthenticated payload and clears cookie when session verification throws", async () => {
    mocks.cookieValues.mc_session = "broken-token";
    mocks.verifySessionMock.mockRejectedValue(new Error("verification failed"));

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/me");
    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
    expect(mocks.verifySessionMock).toHaveBeenCalledWith("broken-token");
    expect(mocks.clearSessionCookieMock).toHaveBeenCalledTimes(1);

    expectSessionCookieCleared(res.headers.get("set-cookie"));
  });
});
