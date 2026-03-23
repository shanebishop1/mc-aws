/**
 * GET /api/stack-status
 * Returns the status of the CloudFormation stack
 */

import { getAuthUser } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getStackStatus } from "@/lib/aws";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { ApiResponse, StackStatusResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STACK_STATUS_CACHE_TTL_MS = 30_000;
const STACK_STATUS_RATE_LIMIT_WINDOW_MS = 60_000;
const STACK_STATUS_RATE_LIMIT_MAX_REQUESTS = 15;

type CachedStackStatusSnapshot = {
  expiresAtMs: number;
  generatedAt: string;
  exists: boolean;
  status?: string;
  stackId?: string;
};

let cachedStackStatusSnapshot: CachedStackStatusSnapshot | null = null;

function buildStackStatusPayload(
  snapshot: CachedStackStatusSnapshot,
  user: import("@/lib/api-auth").AuthUser | null
): ApiResponse<StackStatusResponse> {
  if (snapshot.exists) {
    return {
      success: true,
      data: {
        exists: true,
        status: snapshot.status,
        stackId: user ? snapshot.stackId : "redacted",
      },
      timestamp: snapshot.generatedAt,
    };
  }

  return {
    success: true,
    data: {
      exists: false,
    },
    timestamp: snapshot.generatedAt,
  };
}

function buildStackStatusResponse(
  payload: ApiResponse<StackStatusResponse>,
  user: import("@/lib/api-auth").AuthUser | null,
  cacheStatus: "HIT" | "MISS"
): NextResponse<ApiResponse<StackStatusResponse>> {
  const headers = new Headers();
  headers.set("Vary", "Cookie");
  headers.set("X-Stack-Status-Cache", cacheStatus);

  if (user) {
    headers.set("Cache-Control", "private, no-store");
  } else {
    headers.set("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
  }

  return NextResponse.json(payload, { headers });
}

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<StackStatusResponse>>> {
  const user = await getAuthUser(request);
  console.log("[STACK-STATUS] Access by:", user?.email ?? "anonymous");

  const clientIp = getClientIp(request.headers);
  const rateLimit = await checkRateLimit({
    route: "/api/stack-status",
    key: `stack-status:${clientIp}`,
    limit: STACK_STATUS_RATE_LIMIT_MAX_REQUESTS,
    windowMs: STACK_STATUS_RATE_LIMIT_WINDOW_MS,
  });

  if (!rateLimit.allowed) {
    const response = NextResponse.json(
      {
        success: false,
        error: "Too many stack status requests. Please retry shortly.",
        timestamp: new Date().toISOString(),
      },
      { status: 429 }
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  try {
    const nowMs = Date.now();
    if (cachedStackStatusSnapshot && cachedStackStatusSnapshot.expiresAtMs > nowMs) {
      const payload = buildStackStatusPayload(cachedStackStatusSnapshot, user);
      return buildStackStatusResponse(payload, user, "HIT");
    }

    console.log("[STACK-STATUS] Checking CloudFormation stack status");
    const stack = await getStackStatus("MinecraftStack");

    const snapshot: CachedStackStatusSnapshot = stack
      ? {
          expiresAtMs: nowMs + STACK_STATUS_CACHE_TTL_MS,
          generatedAt: new Date().toISOString(),
          exists: true,
          status: stack.StackStatus,
          stackId: stack.StackId,
        }
      : {
          expiresAtMs: nowMs + STACK_STATUS_CACHE_TTL_MS,
          generatedAt: new Date().toISOString(),
          exists: false,
        };

    cachedStackStatusSnapshot = snapshot;
    const payload = buildStackStatusPayload(snapshot, user);
    return buildStackStatusResponse(payload, user, "MISS");
  } catch (error) {
    const response = formatApiErrorResponse<StackStatusResponse>(error, "stackStatus");
    // Add no-store headers to the error response
    const headers = response.headers;
    headers.set("Cache-Control", "no-store");
    return response;
  }
}
