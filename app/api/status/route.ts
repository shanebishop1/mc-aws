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

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

/**
 * Determine display state based on server state
 */
function determineDisplayState(state: ServerState, hasVolume: boolean): ServerState {
  // If AWS already reports a transitional state, show it.
  if (state === ServerState.Pending || state === ServerState.Stopping) {
    return state;
  }

  let displayState: ServerState = state;

  // Convert stopped + no volume to hibernating
  if (displayState === ServerState.Stopped && !hasVolume) {
    displayState = ServerState.Hibernating;
  }

  return displayState;
}

/**
 * Get public IP with timeout
 */
async function getServerPublicIp(instanceId: string, state: string): Promise<string | undefined> {
  // Only try to get public IP if running
  if (state !== "running") {
    return undefined;
  }

  try {
    // Use a short timeout for status checks (2 seconds) to avoid hanging
    return await getPublicIp(instanceId, 2);
  } catch (error) {
    console.warn("[STATUS] Could not get public IP:", error);
    // Continue without IP - it might still be assigning
    return undefined;
  }
}

/**
 * Build success response for status endpoint
 */
function buildStatusResponse(
  displayState: ServerState,
  instanceId: string,
  publicIp: string | undefined,
  hasVolume: boolean,
  user: import("@/lib/api-auth").AuthUser | null
): NextResponse<ApiResponse<ServerStatusResponse>> {
  // Show domain instead of raw IP when server is running
  const displayAddress = publicIp && env.CLOUDFLARE_MC_DOMAIN ? env.CLOUDFLARE_MC_DOMAIN : publicIp;

  const response: ApiResponse<ServerStatusResponse> = {
    success: true,
    data: {
      state: displayState,
      instanceId: user ? instanceId : "redacted",
      publicIp: displayAddress,
      hasVolume,
      lastUpdated: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(response, { headers: noStoreHeaders });
}

/**
 * Build error response for status endpoint
 */
function buildStatusErrorResponse(error: unknown): NextResponse<ApiResponse<ServerStatusResponse>> {
  console.error("[STATUS] Error:", error);
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

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServerStatusResponse>>> {
  const user = await getAuthUser(request);
  console.log("[STATUS] Access by:", user?.email ?? "anonymous");

  try {
    // Status implies discovery/verification, so we always verify
    // unless passed explicitly via query for speed (optional optimization)
    const url = new URL(request.url);
    const queryId = url.searchParams.get("instanceId");

    // If we have a query ID, use it, otherwise discover
    // But actually, status check IS the discovery mechanism, so it should probably always verify existence via AWS
    const instanceId = queryId || (await findInstanceId());
    console.log("[STATUS] Getting server status for instance:", instanceId);

    const { blockDeviceMappings } = await getInstanceDetails(instanceId);
    const state = await getInstanceState(instanceId);
    const hasVolume = blockDeviceMappings.length > 0;

    // Get public IP if running
    const publicIp = await getServerPublicIp(instanceId, state);

    // Determine display state
    const displayState = determineDisplayState(state, hasVolume);

    return buildStatusResponse(displayState, instanceId, publicIp, hasVolume, user);
  } catch (error) {
    return buildStatusErrorResponse(error);
  }
}
