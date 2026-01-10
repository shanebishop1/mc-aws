/**
 * GET /api/gdrive/status
 * Checks if Google Drive is configured (token exists in SSM)
 */

import { requireAdmin } from "@/lib/api-auth";
import { getParameter } from "@/lib/aws/ssm-client";
import type { ApiResponse, GDriveStatusResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<GDriveStatusResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(_request);
      console.log("[GDRIVE-STATUS] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<GDriveStatusResponse>>;
      }
      throw error;
    }

    console.log("[GDRIVE-STATUS] Checking Google Drive configuration");
    const token = await getParameter("/minecraft/gdrive-token");

    return NextResponse.json({
      success: true,
      data: {
        configured: token !== null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[GDRIVE-STATUS] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: true,
        data: {
          configured: false,
          error: errorMessage,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}
