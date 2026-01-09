/**
 * Authentication utilities for Google OAuth
 */

import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

export type UserRole = "admin" | "allowed" | "public";

export const SESSION_COOKIE_NAME = "mc_session";
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Determines the user role based on email
 * @param email - User's email address
 * @returns The user's role: 'admin' | 'allowed' | 'public'
 */
export function getUserRole(email: string): UserRole {
  const adminEmail = env.ADMIN_EMAIL;
  const allowedEmails = env.ALLOWED_EMAILS;

  // Check if admin
  if (email === adminEmail) {
    return "admin";
  }

  // Check if in allowed list (comma-separated)
  if (allowedEmails) {
    const allowedList = allowedEmails.split(",").map((e: string) => e.trim().toLowerCase());
    if (allowedList.includes(email.toLowerCase())) {
      return "allowed";
    }
  }

  return "public";
}

/**
 * Creates a signed JWT session token
 * @param email - User's email address
 * @returns The signed JWT string
 */
export async function createSession(email: string): Promise<string> {
  const role = getUserRole(email);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SEVEN_DAYS_IN_SECONDS;

  const secret = new TextEncoder().encode(env.AUTH_SECRET);

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
export async function verifySession(
  token: string
): Promise<{ email: string; role: UserRole } | null> {
  try {
    const secret = new TextEncoder().encode(env.AUTH_SECRET);
    const { payload } = await jwtVerify(token, secret);

    return {
      email: payload.email as string,
      role: payload.role as UserRole,
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
