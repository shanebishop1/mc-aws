/**
 * GET /api/auth/me
 * Returns the current user's authentication state
 *
 * - If no session cookie or invalid session, returns { authenticated: false }
 * - If valid session, returns { authenticated: true, email, role }
 *
 * For local development, use /api/auth/dev-login to get a session cookie
 */

import { SESSION_COOKIE_NAME, clearSessionCookie, verifySession } from "@/lib/auth";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

type AuthMeResponse =
  | { authenticated: false }
  | { authenticated: true; email: string; role: "admin" | "allowed" | "public" };

function withClearedSessionCookie(response: NextResponse<AuthMeResponse>): NextResponse<AuthMeResponse> {
  const cookieOptions = clearSessionCookie();
  response.cookies.set(cookieOptions.name, cookieOptions.value, {
    httpOnly: cookieOptions.httpOnly,
    secure: cookieOptions.secure,
    sameSite: cookieOptions.sameSite,
    path: cookieOptions.path,
    maxAge: cookieOptions.maxAge,
  });
  return response;
}

export async function GET(_request: NextRequest): Promise<NextResponse<AuthMeResponse>> {
  try {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!sessionToken) {
      console.log("[AUTH/ME] No session cookie - not authenticated");
      return NextResponse.json({ authenticated: false });
    }

    const payload = await verifySession(sessionToken);
    if (!payload) {
      console.log("[AUTH/ME] Invalid or expired session - not authenticated");
      return withClearedSessionCookie(NextResponse.json({ authenticated: false }));
    }

    console.log("[AUTH/ME] Valid session - returning user:", payload.email);
    return NextResponse.json({
      authenticated: true,
      email: payload.email,
      role: payload.role,
    });
  } catch (error) {
    console.error("[AUTH/ME] Error:", error);
    return withClearedSessionCookie(NextResponse.json({ authenticated: false }));
  }
}
