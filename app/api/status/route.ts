/**
 * GET /api/status
 * Returns the current server state and details
 */

import { getAuthUser } from "@/lib/api-auth";
import { findInstanceId, getInstanceDetails, getInstanceState, getPublicIp } from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServerStatusResponse>>> {
  const user = await getAuthUser(request);
  console.log("[STATUS] Access by:", user?.email ?? "anonymous");

  try {
    // Status implies discovery/verification, so we always verify
    // unless pased explicitly via query for speed (optional optimization)
    const url = new URL(request.url);
    const queryId = url.searchParams.get("instanceId");

    // If we have a query ID, use it, otherwise discover
    // But actually, status check IS the discovery mechanism, so it should probably always verify existence via AWS
    const instanceId = queryId || (await findInstanceId());
    console.log("[STATUS] Getting server status for instance:", instanceId);

    const { blockDeviceMappings } = await getInstanceDetails(instanceId);
    const state = await getInstanceState(instanceId);
    const hasVolume = blockDeviceMappings.length > 0;
    let publicIp: string | undefined;

    // Only try to get public IP if running
    if (state === "running") {
      try {
        // Use a short timeout for status checks (2 seconds) to avoid hanging
        publicIp = await getPublicIp(instanceId, 2);
      } catch (error) {
        console.warn("[STATUS] Could not get public IP:", error);
        // Continue without IP - it might still be assigning
      }
    }

    // Convert stopped + no volume to hibernating
    let displayState = state;
    if (state === "stopped" && !hasVolume) {
      displayState = ServerState.Hibernating;
    }

    const response: ApiResponse<ServerStatusResponse> = {
      success: true,
      data: {
        state: displayState,
        instanceId,
        publicIp,
        hasVolume,
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
