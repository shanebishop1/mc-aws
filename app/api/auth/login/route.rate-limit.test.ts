import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthCookieAttributes = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 600,
} as const;

const mocks = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  mockEnv: {
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    NEXT_PUBLIC_APP_URL: "http://localhost:3001",
  },
  generateStateMock: vi.fn(() => "test-oauth-state"),
  generateCodeVerifierMock: vi.fn(() => "test-code-verifier"),
  googleConstructorMock: vi.fn(),
  createAuthorizationUrlMock: vi.fn(
    (..._args: [string, string, string[]]) =>
      new URL("https://accounts.google.com/o/oauth2/v2/auth?state=test-oauth-state")
  ),
  cookieStore: {
    set: vi.fn(),
  },
}));

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

vi.mock("arctic", () => ({
  generateState: mocks.generateStateMock,
  generateCodeVerifier: mocks.generateCodeVerifierMock,
  Google: class {
    constructor(clientId: string, clientSecret: string, redirectUri: string) {
      mocks.googleConstructorMock(clientId, clientSecret, redirectUri);
    }

    createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]) {
      return mocks.createAuthorizationUrlMock(state, codeVerifier, scopes);
    }
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

describe("GET /api/auth/login regression contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockEnv.GOOGLE_CLIENT_ID = "test-google-client-id";
    mocks.mockEnv.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    mocks.mockEnv.NEXT_PUBLIC_APP_URL = "http://localhost:3001";
    mocks.checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
    });
    mocks.generateStateMock.mockReturnValue("test-oauth-state");
    mocks.generateCodeVerifierMock.mockReturnValue("test-code-verifier");
    mocks.createAuthorizationUrlMock.mockReturnValue(
      new URL("https://accounts.google.com/o/oauth2/v2/auth?state=test-oauth-state")
    );
  });

  it("redirects to oauth_config error when required OAuth config is missing", async () => {
    mocks.mockEnv.GOOGLE_CLIENT_ID = "";
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/login");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_config");
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });

  it("sets oauth state and code verifier cookies with secure httpOnly attributes", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/login");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=test-oauth-state");
    expect(mocks.cookieStore.set).toHaveBeenCalledTimes(2);
    expect(mocks.cookieStore.set).toHaveBeenNthCalledWith(1, "oauth_state", "test-oauth-state", oauthCookieAttributes);
    expect(mocks.cookieStore.set).toHaveBeenNthCalledWith(
      2,
      "oauth_code_verifier",
      "test-code-verifier",
      oauthCookieAttributes
    );
  });

  it("sets oauth_popup cookie only when popup=1 is present", async () => {
    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/login?popup=1");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(mocks.cookieStore.set).toHaveBeenCalledTimes(3);
    expect(mocks.cookieStore.set).toHaveBeenNthCalledWith(1, "oauth_popup", "1", oauthCookieAttributes);
    expect(mocks.cookieStore.set).toHaveBeenNthCalledWith(2, "oauth_state", "test-oauth-state", oauthCookieAttributes);
    expect(mocks.cookieStore.set).toHaveBeenNthCalledWith(
      3,
      "oauth_code_verifier",
      "test-code-verifier",
      oauthCookieAttributes
    );
  });

  it("returns redirect throttle response with Retry-After header", async () => {
    mocks.checkRateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 23,
    });

    const { GET } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/login", {
      headers: {
        "cf-connecting-ip": "198.51.100.24",
      },
    });
    const res = await GET(req);

    expect(mocks.checkRateLimitMock).toHaveBeenCalledWith({
      route: "/api/auth/login",
      key: "auth:login:198.51.100.24",
      limit: 6,
      windowMs: 60_000,
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/?error=oauth_rate_limited");
    expect(res.headers.get("Retry-After")).toBe("23");
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });
});
