/**
 * API route authorization helpers
 *
 * These functions verify the session cookie directly (zero-trust approach).
 * They do NOT rely on headers set by middleware - each route verifies auth independently.
 */

import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "./auth";

/**
 * User roles for authorization
 */
export type UserRole = "admin" | "allowed" | "public";

/**
 * Authenticated user information
 */
export type AuthUser = { email: string; role: UserRole };

/**
 * Extract authenticated user by verifying the session cookie directly
 * @param request - NextRequest object
 * @returns AuthUser or null if not authenticated
 */
export async function getAuthUser(request: NextRequest): Promise<AuthUser | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  const payload = await verifySession(token);
  if (!payload) {
    return null;
  }

  return { email: payload.email, role: payload.role };
}

/**
 * Require authentication - returns user or throws 401 error
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated
 */
export async function requireAuth(request: NextRequest): Promise<AuthUser> {
  const user = await getAuthUser(request);
  if (!user) {
    throw NextResponse.json(
      { success: false, error: "Authentication required", timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  return user;
}

/**
 * Require "allowed" or "admin" role - returns user or throws 403 error
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated, 403 if insufficient permissions
 */
export async function requireAllowed(request: NextRequest): Promise<AuthUser> {
  const user = await getAuthUser(request);
  if (!user) {
    throw NextResponse.json(
      { success: false, error: "Authentication required", timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  if (user.role !== "admin" && user.role !== "allowed") {
    throw NextResponse.json(
      { success: false, error: "Insufficient permissions", timestamp: new Date().toISOString() },
      { status: 403 }
    );
  }

  return user;
}

/**
 * Require "admin" role - returns user or throws 403 error
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated, 403 if insufficient permissions
 */
export async function requireAdmin(request: NextRequest): Promise<AuthUser> {
  const user = await getAuthUser(request);
  if (!user) {
    throw NextResponse.json(
      { success: false, error: "Authentication required", timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    throw NextResponse.json(
      { success: false, error: "Insufficient permissions", timestamp: new Date().toISOString() },
      { status: 403 }
    );
  }

  return user;
}
