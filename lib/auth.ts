/**
 * Authentication utilities for Google OAuth
 */

import { SignJWT, jwtVerify } from "jose";
import { getCachedAllowlist } from "./allowlist-cache";
import { env } from "./env";

export type UserRole = "admin" | "allowed" | "public";

export const SESSION_COOKIE_NAME = "mc_session";
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Determines the user role based on email
 * @param email - User's email address
 * @param allowedEmails - Optional list of allowed emails (from SSM)
 * @returns The user's role: 'admin' | 'allowed' | 'public'
 */
export function getUserRole(email: string, allowedEmails: string[] = []): UserRole {
  // Local dev convenience account. Only applies when dev-login is explicitly enabled.
  // Playwright runs the Next server via `next start` (NODE_ENV=production), so we key off ENABLE_DEV_LOGIN.
  if (email.toLowerCase() === "dev@localhost" && process.env.ENABLE_DEV_LOGIN === "true") {
    return "admin";
  }

  const adminEmail = env.ADMIN_EMAIL;

  // Check if admin
  if (email === adminEmail) {
    return "admin";
  }

  // Check if in allowed list
  // Note: We now expect the caller to provide the authoritative list (from SSM)
  // The env.ALLOWED_EMAILS is deprecated for auth logic.
  if (allowedEmails.length > 0) {
    const normalize = (e: string) => e.trim().toLowerCase();
    const normalizedList = allowedEmails.map(normalize);
    if (normalizedList.includes(normalize(email))) {
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
  const exp = now + SEVEN_DAYS_IN_SECONDS;

  const secretKey = env.AUTH_SECRET;
  if (!secretKey || (process.env.NODE_ENV === "production" && secretKey.length < 32)) {
    throw new Error("AUTH_SECRET is missing or too short (must be >= 32 chars in production)");
  }
  const secret = new TextEncoder().encode(secretKey);

  const token = await new SignJWT({ email, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
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
    const secretKey = env.AUTH_SECRET;
    if (!secretKey) return null; // Can't verify without secret
    const secret = new TextEncoder().encode(secretKey);
    const { payload } = await jwtVerify(token, secret);

    const email = payload.email as string | undefined;
    if (!email) return null;

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
    maxAge: SEVEN_DAYS_IN_SECONDS,
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
