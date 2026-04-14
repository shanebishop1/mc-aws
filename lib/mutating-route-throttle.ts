import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { withOperationStatus } from "@/lib/operation";
import type { ApiResponse, OperationInfo } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

const MUTATING_ROUTE_RATE_LIMIT_WINDOW_MS = 30_000;
const MUTATING_ROUTE_RATE_LIMIT_MAX_REQUESTS = 4;

interface EnforceMutatingRouteThrottleOptions {
  request: NextRequest;
  route: string;
  operation: OperationInfo;
  identity?: string;
}

function normalizeIdentity(identity: string): string {
  const trimmed = identity.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : "unknown";
}

export async function enforceMutatingRouteThrottle<T>({
  request,
  route,
  operation,
  identity,
}: EnforceMutatingRouteThrottleOptions): Promise<NextResponse<ApiResponse<T>> | null> {
  if (process.env.NODE_ENV === "test" && process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS !== "true") {
    return null;
  }

  const fallbackIdentity = getClientIp(request.headers);
  const throttleIdentity = normalizeIdentity(identity ?? fallbackIdentity);

  const rateLimit = await checkRateLimit({
    route,
    key: `mutate:${operation.type}:${throttleIdentity}`,
    limit: MUTATING_ROUTE_RATE_LIMIT_MAX_REQUESTS,
    windowMs: MUTATING_ROUTE_RATE_LIMIT_WINDOW_MS,
    failureMode: "closed",
  });

  if (rateLimit.allowed) {
    return null;
  }

  const response = NextResponse.json(
    {
      success: false,
      error: `Too many ${operation.type} requests. Please retry shortly.`,
      operation: withOperationStatus(operation, "failed"),
      timestamp: new Date().toISOString(),
    },
    { status: 429 }
  );

  response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
  response.headers.set("Cache-Control", "no-store");

  return response;
}
