/**
 * GET /api/status
 * Returns the current server state and details
 */

import { getAuthUser } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceDetails } from "@/lib/aws";
import { env } from "@/lib/env";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STATUS_CACHE_TTL_MS = 5_000;
const STATUS_RATE_LIMIT_WINDOW_MS = 60_000;
const STATUS_RATE_LIMIT_MAX_REQUESTS = 30;
const IS_TEST_ENV = process.env.NODE_ENV === "test";

type CachedStatusSnapshot = {
  expiresAtMs: number;
  generatedAt: string;
  instanceId: string;
  displayState: ServerState;
  hasVolume: boolean;
};

let cachedStatusSnapshot: CachedStatusSnapshot | null = null;

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
function buildStatusPayload(
  snapshot: CachedStatusSnapshot,
  user: import("@/lib/api-auth").AuthUser | null
): ApiResponse<ServerStatusResponse> {
  const domain = snapshot.displayState === ServerState.Running ? env.CLOUDFLARE_MC_DOMAIN : undefined;
  return {
    success: true,
    data: {
      state: snapshot.displayState,
      instanceId: user ? snapshot.instanceId : "redacted",
      domain,
      hasVolume: snapshot.hasVolume,
      lastUpdated: snapshot.generatedAt,
    },
    timestamp: snapshot.generatedAt,
  };
}

function buildStatusResponse(
  payload: ApiResponse<ServerStatusResponse>,
  user: import("@/lib/api-auth").AuthUser | null,
  cacheStatus: "HIT" | "MISS"
): NextResponse<ApiResponse<ServerStatusResponse>> {
  const headers = new Headers();
  headers.set("Vary", "Cookie");
  headers.set("X-Status-Cache", cacheStatus);

  if (user) {
    headers.set("Cache-Control", "private, no-store");
  } else {
    headers.set("Cache-Control", "public, s-maxage=5, stale-while-revalidate=25");
  }

  return NextResponse.json(payload, { headers });
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

  if (!IS_TEST_ENV) {
    const clientIp = getClientIp(request.headers);
    const rateLimit = checkRateLimit({
      key: `status:${clientIp}`,
      limit: STATUS_RATE_LIMIT_MAX_REQUESTS,
      windowMs: STATUS_RATE_LIMIT_WINDOW_MS,
    });

    if (!rateLimit.allowed) {
      const response = NextResponse.json(
        {
          success: false,
          error: "Too many status requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }

  try {
    const nowMs = Date.now();
    if (!IS_TEST_ENV && cachedStatusSnapshot && cachedStatusSnapshot.expiresAtMs > nowMs) {
      const payload = buildStatusPayload(cachedStatusSnapshot, user);
      return buildStatusResponse(payload, user, "HIT");
    }

    // Always resolve instance ID server-side - do not trust caller input
    const instanceId = await findInstanceId();
    console.log("[STATUS] Getting server status for instance:", instanceId);

    const { blockDeviceMappings, state: ec2State } = await getInstanceDetails(instanceId);
    const state = mapEc2StateToServerState(ec2State);
    const hasVolume = blockDeviceMappings.length > 0;

    // Determine display state
    const displayState = determineDisplayState(state, hasVolume);

    const snapshot: CachedStatusSnapshot = {
      expiresAtMs: nowMs + STATUS_CACHE_TTL_MS,
      generatedAt: new Date().toISOString(),
      instanceId,
      displayState,
      hasVolume,
    };

    if (!IS_TEST_ENV) {
      cachedStatusSnapshot = snapshot;
    }
    const payload = buildStatusPayload(snapshot, user);

    return buildStatusResponse(payload, user, "MISS");
  } catch (error) {
    return buildStatusErrorResponse(error);
  }
}
