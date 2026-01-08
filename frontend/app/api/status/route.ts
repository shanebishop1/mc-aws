/**
 * GET /api/status
 * Returns the current server state and details
 */

import { NextRequest, NextResponse } from "next/server";
import { getInstanceState, getInstanceDetails, getPublicIp } from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ServerStatusResponse, ApiResponse } from "@/lib/types";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServerStatusResponse>>> {
  try {
    console.log("[STATUS] Getting server status for instance:", env.INSTANCE_ID);

    const state = await getInstanceState(env.INSTANCE_ID);
    let publicIp: string | undefined;

    // Only try to get public IP if running
    if (state === "running") {
      try {
        publicIp = await getPublicIp(env.INSTANCE_ID);
      } catch (error) {
        console.warn("[STATUS] Could not get public IP:", error);
        // Continue without IP - it might still be assigning
      }
    }

    const response: ApiResponse<ServerStatusResponse> = {
      success: true,
      data: {
        state,
        instanceId: env.INSTANCE_ID,
        publicIp,
        lastUpdated: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[STATUS] Error:", error);
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
