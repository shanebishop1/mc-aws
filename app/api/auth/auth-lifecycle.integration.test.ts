import { createMockNextRequest } from "@/tests/utils";
import type { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const cookieJar: Record<string, string | undefined> = {};
  let issuedSessionToken = "";

  return {
    cookieJar,
    getIssuedSessionToken: () => issuedSessionToken,
    checkRateLimitMock: vi.fn(),
    fetchMock: vi.fn(),
    generateStateMock: vi.fn(() => "integration-oauth-state"),
    generateCodeVerifierMock: vi.fn(() => "integration-code-verifier"),
    createAuthorizationUrlMock: vi.fn(
      (..._args: [string, string, string[]]) =>
        new URL("https://accounts.google.com/o/oauth2/v2/auth?state=integration-oauth-state")
    ),
    validateAuthorizationCodeMock: vi.fn(),
    createSessionMock: vi.fn(async (email: string) => {
      issuedSessionToken = `session-for:${email}`;
      return issuedSessionToken;
    }),
    createSessionCookieMock: vi.fn((token: string) => ({
      name: "mc_session",
      value: token,
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 604_800,
    })),
    verifySessionMock: vi.fn(async (token: string) => {
      if (token !== issuedSessionToken) {
        return null;
      }

      return {
        email: "admin@example.com",
        role: "admin" as const,
      };
    }),
    clearSessionCookieMock: vi.fn(() => ({
      name: "mc_session",
      value: "",
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 0,
    })),
    cookieStore: {
      get: vi.fn((name: string) => {
        const value = cookieJar[name];
        return value ? { value } : undefined;
      }),
      set: vi.fn((name: string, value: string) => {
        cookieJar[name] = value;
      }),
    },
    mockEnv: {
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
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
  SESSION_COOKIE_NAME: "mc_session",
  createSession: mocks.createSessionMock,
  createSessionCookie: mocks.createSessionCookieMock,
  verifySession: mocks.verifySessionMock,
  clearSessionCookie: mocks.clearSessionCookieMock,
}));

vi.mock("arctic", () => ({
  generateState: mocks.generateStateMock,
  generateCodeVerifier: mocks.generateCodeVerifierMock,
  Google: class {
    createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]) {
      return mocks.createAuthorizationUrlMock(state, codeVerifier, scopes);
    }

    validateAuthorizationCode(code: string, codeVerifier: string) {
      return mocks.validateAuthorizationCodeMock(code, codeVerifier);
    }
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

const applyResponseCookiesToJar = (response: NextResponse) => {
  for (const cookie of response.cookies.getAll()) {
    if (!cookie.value) {
      delete mocks.cookieJar[cookie.name];
      continue;
    }

    mocks.cookieJar[cookie.name] = cookie.value;
  }
};

describe("Auth lifecycle integration smoke (login -> callback -> me)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    for (const key of Object.keys(mocks.cookieJar)) {
      delete mocks.cookieJar[key];
    }

    mocks.checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
    });

    mocks.validateAuthorizationCodeMock.mockResolvedValue({
      accessToken: () => "google-access-token",
    });

    mocks.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: "admin@example.com", name: "Admin" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    vi.stubGlobal("fetch", mocks.fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves session state across login, callback, and me endpoints", async () => {
    const [{ GET: loginGet }, { GET: callbackGet }, { GET: meGet }] = await Promise.all([
      import("@/app/api/auth/login/route"),
      import("@/app/api/auth/callback/route"),
      import("@/app/api/auth/me/route"),
    ]);

    const loginResponse = await loginGet(createMockNextRequest("http://localhost/api/auth/login"));

    expect(loginResponse.status).toBe(307);
    const loginLocation = loginResponse.headers.get("location");
    expect(loginLocation).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=integration-oauth-state");
    expect(mocks.cookieJar.oauth_state).toBe("integration-oauth-state");
    expect(mocks.cookieJar.oauth_code_verifier).toBe("integration-code-verifier");

    const callbackResponse = await callbackGet(
      createMockNextRequest("http://localhost/api/auth/callback?code=oauth-code&state=integration-oauth-state")
    );

    expect(callbackResponse.status).toBe(307);
    expect(callbackResponse.headers.get("location")).toBe("http://localhost/");
    applyResponseCookiesToJar(callbackResponse);

    expect(mocks.cookieJar.mc_session).toBe(mocks.getIssuedSessionToken());
    expect(mocks.cookieJar.oauth_state).toBeUndefined();
    expect(mocks.cookieJar.oauth_code_verifier).toBeUndefined();
    expect(mocks.cookieJar.oauth_popup).toBeUndefined();

    const meResponse = await meGet(createMockNextRequest("http://localhost/api/auth/me"));

    expect(meResponse.status).toBe(200);
    await expect(meResponse.json()).resolves.toEqual({
      authenticated: true,
      email: "admin@example.com",
      role: "admin",
    });
    expect(mocks.verifySessionMock).toHaveBeenCalledWith(mocks.getIssuedSessionToken());
    expect(mocks.fetchMock).toHaveBeenCalledWith("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: "Bearer google-access-token",
      },
    });
  });
});
