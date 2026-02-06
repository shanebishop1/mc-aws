/**
 * POST /api/mock/patch
 * Patch specific parts of the mock state
 * Only available in mock mode
 */

import { requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Patch endpoint accessed in non-mock mode");
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
    console.log("[MOCK-CONTROL] State patch by:", user.email, "role:", user.role);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<unknown>>;
    }
    throw error;
  }

  try {
    const body = await request.json();

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Patch data is required", timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    console.log("[MOCK-CONTROL] Patching mock state:", body);
    const stateStore = getMockStateStore();

    // Convert operationFailures object back to Map if present
    const updates = { ...body };
    if (updates.faults?.operationFailures) {
      updates.faults = {
        ...updates.faults,
        operationFailures: new Map(Object.entries(updates.faults.operationFailures)),
      };
    }

    await stateStore.patchState(updates);

    return NextResponse.json({
      success: true,
      data: {
        message: "State patched successfully",
        appliedUpdates: Object.keys(body),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<unknown>(error, "status", "Failed to patch mock state");
  }
}
