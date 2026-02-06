/**
 * GET /api/mock/state
 * Returns the current mock state (instance, SSM params, backups, costs, stack)
 * Only available in mock mode
 */

import { formatApiErrorResponse } from "@/lib/api-error";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] State endpoint accessed in non-mock mode");
    return NextResponse.json(
      {
        success: false,
        error: "Mock control endpoints are only available in mock mode",
        timestamp: new Date().toISOString(),
      },
      { status: 404 }
    );
  }

  try {
    console.log("[MOCK-CONTROL] Getting current mock state");
    const stateStore = getMockStateStore();
    const state = await stateStore.getState();

    // Convert Map to object for JSON serialization
    const serializableState = {
      ...state,
      faults: {
        ...state.faults,
        operationFailures: Object.fromEntries(state.faults.operationFailures),
      },
    };

    return NextResponse.json({
      success: true,
      data: serializableState,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<unknown>(error, "status", "Failed to get mock state");
  }
}
