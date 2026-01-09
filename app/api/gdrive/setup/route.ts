/**
 * GET /api/gdrive/setup
 * Initiates Google OAuth flow by returning the authorization URL
 */

import { env } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(request: Request): Promise<NextResponse<ApiResponse<{ authUrl: string }>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(request as NextRequest);
      console.log("[GDRIVE-SETUP] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<{ authUrl: string }>>;
      }
      throw error;
    }

    console.log("[GDRIVE-SETUP] Generating Google OAuth URL");

    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error("GOOGLE_CLIENT_ID is not configured");
    }

    const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/gdrive/callback`;
    const scope = "https://www.googleapis.com/auth/drive.file";

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scope,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return NextResponse.json({
      success: true,
      data: { authUrl },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[GDRIVE-SETUP] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
