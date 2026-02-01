/**
 * GET /api/gdrive/status
 * Checks if Google Drive is configured (token exists in SSM)
 */

import { requireAdmin } from "@/lib/api-auth";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { getParameter } from "@/lib/aws/ssm-client";
import { isMockMode } from "@/lib/env";
import type { ApiResponse, GDriveStatusResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<GDriveStatusResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(_request);
      console.log("[GDRIVE-STATUS] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<GDriveStatusResponse>>;
      }
      throw error;
    }

    // Mock mode: Return mock status
    if (isMockMode()) {
      console.log("[MOCK-GDRIVE] Returning mock Google Drive status");
      const mockStore = getMockStateStore();
      const mockToken = await mockStore.getParameter("/minecraft/gdrive-token");
      const configured = Boolean(mockToken);

      return NextResponse.json(
        {
          success: true,
          data: {
            configured,
          },
          timestamp: new Date().toISOString(),
        },
        { headers: noStoreHeaders }
      );
    }

    // AWS mode: Check real SSM parameter
    console.log("[GDRIVE-STATUS] Checking Google Drive configuration");
    const token = await getParameter("/minecraft/gdrive-token");

    return NextResponse.json(
      {
        success: true,
        data: {
          configured: Boolean(token),
        },
        timestamp: new Date().toISOString(),
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    console.error("[GDRIVE-STATUS] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
