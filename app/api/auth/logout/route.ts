/**
 * POST /api/auth/logout
 * Clears the user's session cookie
 */

import { formatApiErrorResponse } from "@/lib/api-error";
import { clearSessionCookie } from "@/lib/auth";
import { enforceCookieMutationSameOrigin } from "@/lib/same-origin";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    enforceCookieMutationSameOrigin(request);
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
    if (error instanceof Response) {
      return error as NextResponse;
    }
    return formatApiErrorResponse<Record<string, never>>(error, "logout");
  }
}
