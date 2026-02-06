/**
 * POST /api/stop
 * Stops the server (keeps EBS attached - not hibernation)
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, stopInstance } from "@/lib/aws";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StopServerResponse>>> {
  try {
    const user = await requireAdmin(request);
    console.log("[STOP] Action by:", user.email, "role:", user.role);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<StopServerResponse>>;
    }
    throw error;
  }

  try {
    // Always resolve instance ID server-side - do not trust caller input
    const resolvedId = await findInstanceId();
    console.log("[STOP] Stopping server instance:", resolvedId);

    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[STOP] Current state:", currentState);

    // If already stopped, return error (per requirement)
    if (currentState === ServerState.Stopped || currentState === ServerState.Hibernating) {
      return NextResponse.json(
        {
          success: false,
          error: "Server is already stopped",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    if (currentState !== ServerState.Running && currentState !== ServerState.Pending) {
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
    return formatApiErrorResponse<StopServerResponse>(error, "stop");
  }
}
