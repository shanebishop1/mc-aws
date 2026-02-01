/**
 * GET /api/mock/fault
 * POST /api/mock/fault
 * DELETE /api/mock/fault
 * Fault injection configuration for mock mode
 * Only available in mock mode
 */

import { requireAllowed } from "@/lib/api-auth";
import { clearAllFaults, clearFault, getFaultConfig, injectFault, setGlobalLatency } from "@/lib/aws/mock-scenarios";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Fault endpoint accessed in non-mock mode");
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
    console.log("[MOCK-CONTROL] Getting fault configuration");
    const stateStore = getMockStateStore();

    // Get global latency
    const globalLatency = await stateStore.getGlobalLatency();

    // Get all operation failures
    const state = await stateStore.getState();
    const operationFailures = Object.fromEntries(state.faults.operationFailures);

    return NextResponse.json({
      success: true,
      data: {
        globalLatency,
        operationFailures,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MOCK-CONTROL] Error getting fault configuration:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Fault endpoint accessed in non-mock mode");
    return NextResponse.json(
      {
        success: false,
        error: "Mock control endpoints are only available in mock mode",
        timestamp: new Date().toISOString(),
      },
      { status: 404 }
    );
  }

  // In mock mode, skip authentication for easier testing
  console.log("[MOCK-CONTROL] Injecting fault (mock mode, skipping auth)");

  try {
    const body = await request.json();
    const { operation, latency, failNext, alwaysFail, errorCode, errorMessage } = body;

    if (!operation || typeof operation !== "string") {
      return NextResponse.json(
        { success: false, error: "Operation name is required", timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    console.log("[MOCK-CONTROL] Injecting fault for operation:", operation, body);

    // Apply fault injection
    await injectFault({
      operation,
      latency,
      failNext,
      alwaysFail,
      errorCode,
      errorMessage,
    });

    return NextResponse.json({
      success: true,
      data: {
        operation,
        message: `Fault injection configured for operation "${operation}"`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MOCK-CONTROL] Error configuring fault injection:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Fault endpoint accessed in non-mock mode");
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
    console.log("[MOCK-CONTROL] Fault clear by:", user.email, "role:", user.role);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<unknown>>;
    }
    throw error;
  }

  try {
    const url = new URL(request.url);
    const operation = url.searchParams.get("operation");

    if (operation) {
      // Clear specific operation fault
      console.log("[MOCK-CONTROL] Clearing fault for operation:", operation);
      await clearFault(operation);

      return NextResponse.json({
        success: true,
        data: {
          operation,
          message: `Fault cleared for operation "${operation}"`,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Clear all faults
    console.log("[MOCK-CONTROL] Clearing all faults");
    await clearAllFaults();

    return NextResponse.json({
      success: true,
      data: {
        message: "All fault injections cleared",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MOCK-CONTROL] Error clearing fault injection:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
