/**
 * Authentication utilities for Google OAuth
 */

import { SignJWT, jwtVerify } from "jose";
import { getCachedAllowlist } from "./allowlist-cache";
import { assertProductionAuthSecret } from "./auth-secret";
import { env } from "./env";
import { getRuntimeAuthSecret } from "./runtime-auth-secret";

export type UserRole = "admin" | "allowed" | "public";

export const SESSION_COOKIE_NAME = "mc_session";
export const SESSION_ISSUER = "mc-aws";
export const SESSION_AUDIENCE = "mc-aws-panel";
export const SESSION_PURPOSE = "session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const getProcessAuthSecret = (): string | undefined => (process.env as Record<string, string | undefined>).AUTH_SECRET;

/**
 * Determines the user role based on email
 * @param email - User's email address
 * @param allowedEmails - Optional list of allowed emails (from SSM)
 * @returns The user's role: 'admin' | 'allowed' | 'public'
 */
export function getUserRole(email: string, allowedEmails: string[] = []): UserRole {
  const normalizeEmail = (value: string) => value.trim().toLowerCase();

  // Local dev convenience account. Only applies when dev-login is explicitly enabled.
  // Playwright runs the Next server via `next start` (NODE_ENV=production), so we key off ENABLE_DEV_LOGIN.
  if (normalizeEmail(email) === "dev@localhost" && process.env.ENABLE_DEV_LOGIN === "true") {
    return "admin";
  }

  const adminEmail = env.ADMIN_EMAIL;

  // Check if admin
  if (normalizeEmail(email) === normalizeEmail(adminEmail)) {
    return "admin";
  }

  // Check if in allowed list
  // Note: We now expect the caller to provide the authoritative list (from SSM)
  // The env.ALLOWED_EMAILS is deprecated for auth logic.
  if (allowedEmails.length > 0) {
    const normalizedList = allowedEmails.map(normalizeEmail);
    if (normalizedList.includes(normalizeEmail(email))) {
      return "allowed";
    }
  }

  return "public";
}

// ... (previous code)

/**
 * Creates a signed JWT session token
 * @param email - User's email address
 * @returns The signed JWT string
 */
export async function createSession(email: string): Promise<string> {
  const allowlist = await getCachedAllowlist();
  const role = getUserRole(email, allowlist);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_MAX_AGE_SECONDS;

  const configuredSecret = getRuntimeAuthSecret() ?? getProcessAuthSecret() ?? env.AUTH_SECRET;
  const secretKey =
    process.env.NODE_ENV === "production" ? assertProductionAuthSecret(configuredSecret) : configuredSecret;
  if (!secretKey) throw new Error("AUTH_SECRET is required to create a session");
  const secret = new TextEncoder().encode(secretKey);

  const token = await new SignJWT({ email, role, purpose: SESSION_PURPOSE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .sign(secret);

  return token;
}

/**
 * Verifies a JWT session token and returns the payload
 * @param token - The JWT string to verify
 * @returns The payload with email and role, or null if invalid
 */
export async function verifySession(token: string): Promise<{ email: string; role: UserRole } | null> {
  try {
    const secretKey = getRuntimeAuthSecret() ?? getProcessAuthSecret() ?? env.AUTH_SECRET;
    if (!secretKey) return null; // Can't verify without secret
    if (process.env.NODE_ENV === "production") assertProductionAuthSecret(secretKey);
    const secret = new TextEncoder().encode(secretKey);
    const { payload, protectedHeader } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: SESSION_AUDIENCE,
      issuer: SESSION_ISSUER,
      requiredClaims: ["exp", "iat", "iss", "aud"],
    });

    const now = Math.floor(Date.now() / 1000);
    const { exp, iat } = payload;
    const email = payload.email;
    if (
      protectedHeader.typ !== "JWT" ||
      typeof email !== "string" ||
      !email.trim() ||
      email !== email.trim() ||
      payload.purpose !== SESSION_PURPOSE ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(exp) ||
      (iat as number) > now ||
      (exp as number) <= (iat as number) ||
      (exp as number) - (iat as number) > SESSION_MAX_AGE_SECONDS ||
      now - (iat as number) > SESSION_MAX_AGE_SECONDS
    ) {
      return null;
    }

    const allowlist = await getCachedAllowlist();

    return {
      email,
      role: getUserRole(email, allowlist),
    };
  } catch {
    return null;
  }
}

/**
 * Creates cookie options for setting the session cookie
 * @param token - The JWT token
 * @returns Cookie options object
 */
export function createSessionCookie(token: string) {
  const isProduction = process.env.NODE_ENV === "production";

  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Creates cookie options for clearing the session cookie
 * @returns Cookie options object
 */
export function clearSessionCookie() {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}
