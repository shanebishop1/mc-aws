/**
 * POST /api/start
 * Starts the server asynchronously (fire-and-forget)
 * Sets the server-action lock, invokes the Lambda, and returns immediately
 * The Lambda is responsible for clearing the lock when complete
 */

import { type AuthUser, requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  const operation = createOperationInfo("start", "running");

  let user: AuthUser;
  try {
    user = await requireAllowed(request);
    console.log("[START] Action by:", user.email, "role:", user.role);

    const throttleResponse = await enforceMutatingRouteThrottle<StartServerResponse>({
      request,
      route: "/api/start",
      operation,
      identity: user.email,
    });
    if (throttleResponse) {
      return throttleResponse;
    }
  } catch (error) {
    if (error instanceof Response) {
      return await formatAuthErrorResponse<StartServerResponse>(error, withOperationStatus(operation, "failed"));
    }
    throw error;
  }

  try {
    // Always resolve instance ID server-side - do not trust caller input
    const resolvedId = await findInstanceId();
    console.log("[START] Starting server instance:", resolvedId);

    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[START] Current state:", currentState);

    // If running, return error (per requirement)
    if (currentState === "running") {
      return NextResponse.json(
        {
          success: false,
          error: "Server is already running",
          operation: withOperationStatus(operation, "failed"),
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Invoke the Lambda function asynchronously
    const lock = await acquireServerActionLock("start", user.email);

    try {
      console.log("[START] Invoking StartMinecraftServer Lambda");
      await invokeLambda("StartMinecraftServer", {
        invocationType: "api",
        command: "start",
        userEmail: user.email,
        instanceId: resolvedId,
        lockId: lock.lockId,
      });

      // Return immediately with pending status (fire-and-forget)
      const response: ApiResponse<StartServerResponse> = {
        success: true,
        data: {
          instanceId: resolvedId,
          domain: env.CLOUDFLARE_MC_DOMAIN,
          message: "Server start initiated. This may take 1-2 minutes.",
        },
        operation: withOperationStatus(operation, "accepted"),
        timestamp: new Date().toISOString(),
      };

      return NextResponse.json(response);
    } catch (error) {
      console.error("[START] Lambda invocation failed:", error);
      await releaseServerActionLock(lock.lockId).catch((releaseError) => {
        console.error("[START] Failed to release lock after invoke error:", releaseError);
      });
      throw error;
    }
  } catch (error) {
    if (isServerActionLockConflictError(error)) {
      return NextResponse.json(
        {
          success: false,
          error: "Another operation is already in progress. Please wait for it to complete.",
          operation: withOperationStatus(operation, "failed"),
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }

    return formatApiErrorResponse<StartServerResponse>(error, "start", undefined, withOperationStatus(operation, "failed"));
  }
}
