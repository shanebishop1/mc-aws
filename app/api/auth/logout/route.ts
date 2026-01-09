/**
 * POST /api/auth/logout
 * Clears the user's session cookie
 */

import { clearSessionCookie } from "@/lib/auth";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(_request: NextRequest): Promise<NextResponse> {
  try {
    console.log("[LOGOUT] Clearing session");

    const cookieOptions = clearSessionCookie();
    const response = NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
    });

    response.cookies.set(cookieOptions.name, cookieOptions.value, {
      httpOnly: cookieOptions.httpOnly,
      secure: cookieOptions.secure,
      sameSite: cookieOptions.sameSite,
      path: cookieOptions.path,
      maxAge: cookieOptions.maxAge,
    });

    return response;
  } catch (error) {
    console.error("[LOGOUT] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
