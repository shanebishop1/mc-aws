/**
 * GET /api/status
 * Returns the current server state and details
 */

import { getAuthUser } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceDetails } from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

function mapEc2StateToServerState(state: string | undefined): ServerState {
  if (state === "running") return ServerState.Running;
  if (state === "stopped") return ServerState.Stopped;
  if (state === "pending") return ServerState.Pending;
  if (state === "stopping") return ServerState.Stopping;
  if (state === "terminated") return ServerState.Terminated;
  return ServerState.Unknown;
}

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
 * Build success response for status endpoint
 */
function buildStatusResponse(
  displayState: ServerState,
  instanceId: string,
  hasVolume: boolean,
  user: import("@/lib/api-auth").AuthUser | null
): NextResponse<ApiResponse<ServerStatusResponse>> {
  const domain = displayState === ServerState.Running ? env.CLOUDFLARE_MC_DOMAIN : undefined;

  const response: ApiResponse<ServerStatusResponse> = {
    success: true,
    data: {
      state: displayState,
      instanceId: user ? instanceId : "redacted",
      domain,
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
  const response = formatApiErrorResponse<ServerStatusResponse>(error, "status");
  // Add no-store headers to the error response
  const headers = response.headers;
  headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServerStatusResponse>>> {
  const user = await getAuthUser(request);
  console.log("[STATUS] Access by:", user?.email ?? "anonymous");

  try {
    // Always resolve instance ID server-side - do not trust caller input
    const instanceId = await findInstanceId();
    console.log("[STATUS] Getting server status for instance:", instanceId);

    const { blockDeviceMappings, state: ec2State } = await getInstanceDetails(instanceId);
    const state = mapEc2StateToServerState(ec2State);
    const hasVolume = blockDeviceMappings.length > 0;

    // Determine display state
    const displayState = determineDisplayState(state, hasVolume);

    return buildStatusResponse(displayState, instanceId, hasVolume, user);
  } catch (error) {
    return buildStatusErrorResponse(error);
  }
}
