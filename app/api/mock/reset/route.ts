/**
 * POST /api/mock/reset
 * Reset mock state to defaults
 * Only available in mock mode
 */

import { requireAllowed } from "@/lib/api-auth";
import { resetToDefaultScenario } from "@/lib/aws/mock-scenarios";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Reset endpoint accessed in non-mock mode");
    return NextResponse.json(
      {
        success: false,
        error: "Mock control endpoints are only available in mock mode",
        timestamp: new Date().toISOString(),
      },
      { status: 404 }
    );
  }

  // Require authentication for mutations
  try {
    const user = await requireAllowed(request);
    console.log("[MOCK-CONTROL] State reset by:", user.email, "role:", user.role);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<unknown>>;
    }
    throw error;
  }

  try {
    console.log("[MOCK-CONTROL] Resetting mock state to defaults");
    await resetToDefaultScenario();

    return NextResponse.json({
      success: true,
      data: {
        message: "Mock state reset to defaults successfully",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MOCK-CONTROL] Error resetting state:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
