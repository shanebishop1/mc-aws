/**
 * GET /api/mock/scenario
 * POST /api/mock/scenario
 * Scenario management for mock mode
 * Only available in mock mode
 */

import { requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { applyScenario, getAvailableScenarios, getCurrentScenario } from "@/lib/aws/mock-scenarios";
import { isMockMode } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Scenario endpoint accessed in non-mock mode");
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
    console.log("[MOCK-CONTROL] Getting scenario information");
    const currentScenario = await getCurrentScenario();
    const availableScenarios = getAvailableScenarios();

    return NextResponse.json({
      success: true,
      data: {
        currentScenario,
        availableScenarios,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<unknown>(error, "status", "Failed to get scenario information");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<unknown>>> {
  // Only allow in mock mode
  if (!isMockMode()) {
    console.log("[MOCK-CONTROL] Scenario endpoint accessed in non-mock mode");
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
  console.log("[MOCK-CONTROL] Applying scenario (mock mode, skipping auth)");

  try {
    const body = await request.json();
    const { scenario } = body;

    if (!scenario || typeof scenario !== "string") {
      return NextResponse.json(
        { success: false, error: "Scenario name is required", timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    console.log("[MOCK-CONTROL] Applying scenario:", scenario);
    await applyScenario(scenario);

    return NextResponse.json({
      success: true,
      data: {
        scenario,
        message: `Scenario "${scenario}" applied successfully`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<unknown>(error, "status", "Failed to apply scenario");
  }
}
