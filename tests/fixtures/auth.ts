import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { createMockNextRequest } from "@/tests/utils";

export type FixtureAuthUser = {
  email: string;
  role: "admin" | "allowed" | "public";
};

const defaultFixtureAuthUser: FixtureAuthUser = {
  email: "admin@example.com",
  role: "admin",
};

export interface SessionCookieOptions {
  token?: string;
  cookieName?: string;
  additionalCookies?: Record<string, string>;
}

export interface AuthenticatedRequestOptions extends RequestInit {
  session?: SessionCookieOptions;
}

type SessionVerifierStub = {
  mockResolvedValue(value: FixtureAuthUser | null): unknown;
};

export function createFixtureAuthUser(overrides: Partial<FixtureAuthUser> = {}): FixtureAuthUser {
  return {
    ...defaultFixtureAuthUser,
    ...overrides,
  };
}

export function buildSessionCookieHeader(options: SessionCookieOptions = {}): string {
  const token = options.token ?? "fixture-session-token";
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  const baseCookie = `${cookieName}=${token}`;

  if (!options.additionalCookies || Object.keys(options.additionalCookies).length === 0) {
    return baseCookie;
  }

  const otherCookies = Object.entries(options.additionalCookies).map(([key, value]) => `${key}=${value}`);

  return [baseCookie, ...otherCookies].join("; ");
}

export function createAuthenticatedRequest(url: string, options: AuthenticatedRequestOptions = {}) {
  const headers = new Headers(options.headers);
  headers.set("cookie", buildSessionCookieHeader(options.session));

  return createMockNextRequest(url, {
    ...options,
    headers,
  });
}

export function stubSessionVerifier(
  verifySessionMock: SessionVerifierStub,
  user: FixtureAuthUser | null = defaultFixtureAuthUser,
  token = "fixture-session-token"
) {
  verifySessionMock.mockResolvedValue(user);

  return {
    token,
    user,
    cookieHeader: buildSessionCookieHeader({ token }),
  };
}
