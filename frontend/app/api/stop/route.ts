/**
 * POST /api/stop
 * Stops the server (keeps EBS attached - not hibernation)
 */

import { findInstanceId, getInstanceState, stopInstance } from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StopServerResponse>>> {
  try {
    let instanceId: string | undefined;
    try {
      const body = await request.clone().json();
      instanceId = body?.instanceId;
    } catch {}

    const resolvedId = instanceId || (await findInstanceId());
    console.log("[STOP] Stopping server instance:", resolvedId);

    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[STOP] Current state:", currentState);

    // If already stopped, just return success
    if (currentState === "stopped" || currentState === "hibernated") {
      return NextResponse.json({
        success: true,
        data: {
          instanceId: resolvedId,
          message: "Server is already stopped",
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (currentState !== "running" && currentState !== "pending") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot stop server in state: ${currentState}`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Send stop command
    console.log("[STOP] Sending stop command...");
    await stopInstance(resolvedId);

    const response: ApiResponse<StopServerResponse> = {
      success: true,
      data: {
        instanceId: resolvedId,
        message: "Server stop command sent successfully",
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[STOP] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
