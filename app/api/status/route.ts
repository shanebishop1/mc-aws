/**
 * GET /api/status
 * Returns the current server state and details
 */

import { getAuthUser } from "@/lib/api-auth";
import {
  findInstanceId,
  getInstanceDetails,
  getInstanceState,
  getPublicIp,
  getServerAction,
  releaseServerAction,
} from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

// These action markers are a UI hint. EC2 state transitions should show up quickly
// after a real start/stop request, so keep the optimistic window short.
const startActionGraceMs = 2 * 60 * 1000;
const stopActionGraceMs = 2 * 60 * 1000;

/**
 * Determine display state based on server state and action
 */
function determineDisplayState(
  state: ServerState,
  hasVolume: boolean,
  serverAction: { action: string; timestamp: number } | null
): ServerState {
  // If AWS already reports a transitional state, show it.
  if (state === ServerState.Pending || state === ServerState.Stopping) {
    return state;
  }

  let displayState: ServerState = state;

  // If an operation is in progress, we *temporarily* show an in-progress state.
  // This is a UI hint, not a source of truth. If the instance never transitions,
  // we should fall back to the real state rather than staying "Starting..." forever.
  if (serverAction) {
    const ageMs = Date.now() - serverAction.timestamp;
    const isStartish = serverAction.action === "start" || serverAction.action === "resume";
    const isStopish = serverAction.action === "stop" || serverAction.action === "hibernate";

    if (isStartish && ageMs <= startActionGraceMs) {
      // Only override stable states for a short grace window.
      if (state === ServerState.Stopped || state === ServerState.Hibernating || state === ServerState.Unknown) {
        displayState = ServerState.Pending;
      }
    }

    if (isStopish && ageMs <= stopActionGraceMs) {
      if (state === ServerState.Running || state === ServerState.Unknown) {
        displayState = ServerState.Stopping;
      }
    }
  }

  // Convert stopped + no volume to hibernating
  if (displayState === ServerState.Stopped && !hasVolume && !serverAction) {
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
 * Get server action with error handling
 */
async function getCurrentServerAction(): Promise<{ action: string; timestamp: number } | null> {
  try {
    return await getServerAction();
  } catch (error) {
    console.warn("[STATUS] Could not get server action:", error);
    return null;
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
  serverAction: { action: string; timestamp: number } | null,
  user: import("@/lib/api-auth").AuthUser | null
): NextResponse<ApiResponse<ServerStatusResponse>> {
  const response: ApiResponse<ServerStatusResponse> = {
    success: true,
    data: {
      state: displayState,
      instanceId: user ? instanceId : "redacted",
      publicIp: user ? publicIp : undefined,
      hasVolume,
      lastUpdated: new Date().toISOString(),
      serverAction,
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

    let serverAction = await getCurrentServerAction();
    const { blockDeviceMappings } = await getInstanceDetails(instanceId);
    const state = await getInstanceState(instanceId);
    const hasVolume = blockDeviceMappings.length > 0;

    // If a start/stop action marker is stuck but the instance never transitions, clear it.
    // This prevents the UI from showing "Starting..."/"Stopping..." indefinitely.
    if (serverAction) {
      const ageMs = Date.now() - serverAction.timestamp;
      const isStartish = serverAction.action === "start" || serverAction.action === "resume";
      const isStopish = serverAction.action === "stop" || serverAction.action === "hibernate";

      const shouldClearStaleAction =
        (isStartish && state === ServerState.Stopped && ageMs > startActionGraceMs) ||
        (isStopish && state === ServerState.Running && ageMs > stopActionGraceMs);

      if (shouldClearStaleAction) {
        console.warn(
          "[STATUS] Clearing stale server action marker:",
          JSON.stringify({ action: serverAction.action, ageMs, state })
        );
        try {
          await releaseServerAction();
        } catch (error) {
          console.warn("[STATUS] Failed to clear stale server action marker:", error);
        }
        serverAction = null;
      }
    }

    // Get public IP if running
    const publicIp = await getServerPublicIp(instanceId, state);

    // Determine display state
    const displayState = determineDisplayState(state, hasVolume, serverAction);

    return buildStatusResponse(displayState, instanceId, publicIp, hasVolume, serverAction, user);
  } catch (error) {
    return buildStatusErrorResponse(error);
  }
}
