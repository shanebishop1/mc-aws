/**
 * GET /api/auth/me
 * Returns the current user's authentication state
 *
 * In development mode:
 * - If no session cookie, returns authenticated dev user (auth bypass)
 * - If session cookie exists, verifies and returns actual user info
 *
 * In production mode:
 * - If no session cookie or invalid session, returns { authenticated: false }
 * - If valid session, returns { authenticated: true, email, role }
 */

import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isDev } from "@/lib/env";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

type AuthMeResponse =
  | { authenticated: false }
  | { authenticated: true; email: string; role: "admin" | "allowed" | "public" };

export async function GET(
  _request: NextRequest
): Promise<NextResponse<AuthMeResponse>> {
  try {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (isDev) {
      // Development mode: auth bypass
      console.log("[AUTH/ME] Development mode - checking for session cookie");

      if (!sessionToken) {
        // No session cookie - return authenticated dev user
        console.log("[AUTH/ME] No session cookie in dev mode - returning dev user");
        return NextResponse.json({
          authenticated: true,
          email: "dev@localhost",
          role: "admin",
        });
      }

      // Session cookie exists - verify it
      const payload = await verifySession(sessionToken);
      if (payload) {
        console.log("[AUTH/ME] Valid session in dev mode - returning user:", payload.email);
        return NextResponse.json({
          authenticated: true,
          email: payload.email,
          role: payload.role,
        });
      }

      // Invalid session in dev mode - still return dev user as fallback
      console.log("[AUTH/ME] Invalid session in dev mode - returning dev user fallback");
      return NextResponse.json({
        authenticated: true,
        email: "dev@localhost",
        role: "admin",
      });
    }

    // Production mode: require valid session
    console.log("[AUTH/ME] Production mode - verifying session");

    if (!sessionToken) {
      console.log("[AUTH/ME] No session cookie in production - not authenticated");
      return NextResponse.json({ authenticated: false });
    }

    const payload = await verifySession(sessionToken);
    if (!payload) {
      console.log("[AUTH/ME] Invalid or expired session - not authenticated");
      return NextResponse.json({ authenticated: false });
    }

    console.log("[AUTH/ME] Valid session - returning user:", payload.email);
    return NextResponse.json({
      authenticated: true,
      email: payload.email,
      role: payload.role,
    });
  } catch (error) {
    console.error("[AUTH/ME] Error:", error);
    // On any error in production, treat as not authenticated
    // In dev mode, still return dev user for smoother development
    if (isDev) {
      console.log("[AUTH/ME] Error in dev mode - returning dev user fallback");
      return NextResponse.json({
        authenticated: true,
        email: "dev@localhost",
        role: "admin",
      });
    }
    return NextResponse.json({ authenticated: false });
  }
}
