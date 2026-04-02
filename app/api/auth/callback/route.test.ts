import { createMockNextRequest } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const cookieValues: Record<string, string | undefined> = {};

  return {
    checkRateLimitMock: vi.fn(),
    createSessionMock: vi.fn(),
    createSessionCookieMock: vi.fn(),
    googleConstructorMock: vi.fn(),
    validateAuthorizationCodeMock: vi.fn(),
    fetchMock: vi.fn(),
    mockEnv: {
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
    cookieValues,
    cookieStore: {
      get: vi.fn((name: string) => {
        const value = cookieValues[name];
        return value ? { value } : undefined;
      }),
    },
  };
});

vi.mock("@/lib/env", () => ({
  env: mocks.mockEnv,
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");

  return {
    ...actual,
    checkRateLimit: mocks.checkRateLimitMock,
  };
});

vi.mock("@/lib/auth", () => ({
  createSession: mocks.createSessionMock,
  createSessionCookie: mocks.createSessionCookieMock,
}));

vi.mock("arctic", () => ({
  Google: class {
    constructor(clientId: string, clientSecret: string, redirectUri: string) {
      mocks.googleConstructorMock(clientId, clientSecret, redirectUri);
    }

    validateAuthorizationCode(code: string, codeVerifier: string) {
      return mocks.validateAuthorizationCodeMock(code, codeVerifier);
    }
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

const setDefaultOAuthCookies = (popupValue = "0") => {
  mocks.cookieValues.oauth_state = "expected-state";
  mocks.cookieValues.oauth_code_verifier = "expected-code-verifier";
  mocks.cookieValues.oauth_popup = popupValue;
};

const expectNoCookiesSet = (response: Response) => {
  expect(response.headers.get("set-cookie")).toBeNull();
};

describe("GET /api/auth/callback regression contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetchMock as unknown as typeof fetch);

    mocks.mockEnv.GOOGLE_CLIENT_ID = "test-google-client-id";
    mocks.mockEnv.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    mocks.mockEnv.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    setDefaultOAuthCookies();

    mocks.checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
    });

    mocks.createSessionMock.mockResolvedValue("test-session-token");
    mocks.createSessionCookieMock.mockReturnValue({
      name: "mc_session",
      value: "test-session-token",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
    });

    mocks.validateAuthorizationCodeMock.mockResolvedValue({
      accessToken: () => "test-access-token",
    });

    mocks.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: "admin@example.com", name: "Admin" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects with oauth_missing_params when code or state is missing", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?state=expected-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_missing_params");
    expectNoCookiesSet(res);
    expect(mocks.validateAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createSessionMock).not.toHaveBeenCalled();
  });

  it("redirects with oauth_state_mismatch when callback state does not match cookie", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=test-code&state=wrong-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_state_mismatch");
    expectNoCookiesSet(res);
    expect(mocks.validateAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createSessionMock).not.toHaveBeenCalled();
  });

  it("redirects with oauth_token_failed when token exchange throws", async () => {
    mocks.validateAuthorizationCodeMock.mockRejectedValue(new Error("token exchange failed"));
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=test-code&state=expected-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_token_failed");
    expectNoCookiesSet(res);
    expect(mocks.validateAuthorizationCodeMock).toHaveBeenCalledWith("test-code", "expected-code-verifier");
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.createSessionMock).not.toHaveBeenCalled();
  });

  it("redirects with oauth_userinfo_failed when userinfo request fails", async () => {
    mocks.fetchMock.mockResolvedValue(
      new Response("unauthorized", {
        status: 401,
      })
    );
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=test-code&state=expected-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_userinfo_failed");
    expectNoCookiesSet(res);
    expect(mocks.validateAuthorizationCodeMock).toHaveBeenCalledWith("test-code", "expected-code-verifier");
    expect(mocks.fetchMock).toHaveBeenCalledWith("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: "Bearer test-access-token",
      },
    });
    expect(mocks.createSessionMock).not.toHaveBeenCalled();
  });

  it("creates session, clears oauth cookies, and redirects for non-popup callback", async () => {
    setDefaultOAuthCookies("0");
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=test-code&state=expected-state");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(mocks.createSessionMock).toHaveBeenCalledWith("admin@example.com");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mc_session=test-session-token");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("oauth_state=;");
    expect(setCookie).toContain("oauth_code_verifier=;");
    expect(setCookie).toContain("oauth_popup=;");
  });

  it("creates session, clears oauth cookies, and returns popup close HTML for popup callback", async () => {
    setDefaultOAuthCookies("1");
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/callback?code=test-code&state=expected-state");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await res.text();
    expect(body).toContain("MC_AUTH_SUCCESS");
    expect(body).toContain("window.close");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("mc_session=test-session-token");
    expect(setCookie).toContain("oauth_state=;");
    expect(setCookie).toContain("oauth_code_verifier=;");
    expect(setCookie).toContain("oauth_popup=;");
  });
});
