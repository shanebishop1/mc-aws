/**
 * GET /api/gdrive/setup
 * Initiates Google OAuth flow by returning the authorization URL
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { env } from "@/lib/env";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { generateState } from "arctic";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const OAUTH_STATE_COOKIE = "gdrive_oauth_state";
const OAUTH_COOKIE_EXPIRY = 600; // 10 minutes in seconds

export async function GET(request: Request): Promise<NextResponse<ApiResponse<{ authUrl: string }>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request as NextRequest);
      console.log("[GDRIVE-SETUP] Admin action by:", user.email);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void user;
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<{ authUrl: string }>>;
      }
      throw error;
    }

    // Mock mode: Return mock OAuth URL
    if (isMockMode()) {
      console.log("[MOCK-GDRIVE] Returning mock OAuth URL");
      const mockAuthUrl = `${env.NEXT_PUBLIC_APP_URL}/api/gdrive/callback?mock=true`;

      return NextResponse.json({
        success: true,
        data: { authUrl: mockAuthUrl },
        timestamp: new Date().toISOString(),
      });
    }

    // AWS mode: Generate real Google OAuth URL
    console.log("[GDRIVE-SETUP] Generating Google OAuth URL");

    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error("GOOGLE_CLIENT_ID is not configured");
    }

    // Generate OAuth state for CSRF protection
    const state = generateState();
    console.log("[GDRIVE-SETUP] Generated OAuth state");

    // Store state in HTTP-only cookie
    const cookieStore = await cookies();
    cookieStore.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_COOKIE_EXPIRY,
    });

    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/gdrive/callback`;
    const scope = "https://www.googleapis.com/auth/drive.file";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scope,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state: state,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return NextResponse.json({
      success: true,
      data: { authUrl },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<{ authUrl: string }>(error, "gdriveSetup");
  }
}
