/**
 * API route authorization helpers
 *
 * These functions are used in Next.js API routes to check user permissions
 * based on headers set by middleware (x-user-email and x-user-role).
 */

import { type NextRequest, NextResponse } from "next/server";

/**
 * User roles for authorization
 */
export type UserRole = "admin" | "allowed" | "public";

/**
 * Authenticated user information
 */
export type AuthUser = { email: string; role: UserRole };

/**
 * Check if running in development mode
 * @returns true if NODE_ENV !== "production"
 */
export function isDevMode(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Extract authenticated user from request headers
 * Headers are set by middleware (x-user-email and x-user-role)
 * @param request - NextRequest object
 * @returns AuthUser or null if not authenticated
 */
export function getAuthUser(request: NextRequest): AuthUser | null {
  const email = request.headers.get("x-user-email");
  const roleHeader = request.headers.get("x-user-role");

  if (!email || !roleHeader) {
    return null;
  }

  // Validate role value
  const role = roleHeader as UserRole;
  if (role !== "admin" && role !== "allowed" && role !== "public") {
    return null;
  }

  return { email, role };
}

/**
 * Require authentication - returns user or throws 401 error
 * In dev mode, returns a mock admin user
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated
 */
export function requireAuth(request: NextRequest): AuthUser {
  // In dev mode, return mock admin user
  if (isDevMode()) {
    return { email: "dev@localhost", role: "admin" };
  }

  const user = getAuthUser(request);
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
 * In dev mode, returns a mock admin user
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated, 403 if insufficient permissions
 */
export function requireAllowed(request: NextRequest): AuthUser {
  // In dev mode, return mock admin user
  if (isDevMode()) {
    return { email: "dev@localhost", role: "admin" };
  }

  const user = getAuthUser(request);
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
 * In dev mode, returns a mock admin user
 * @param request - NextRequest object
 * @returns AuthUser
 * @throws 401 Response if not authenticated, 403 if insufficient permissions
 */
export function requireAdmin(request: NextRequest): AuthUser {
  // In dev mode, return mock admin user
  if (isDevMode()) {
    return { email: "dev@localhost", role: "admin" };
  }

  const user = getAuthUser(request);
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
