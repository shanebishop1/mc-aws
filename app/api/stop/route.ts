/**
 * POST /api/stop
 * Stops the server (keeps EBS attached - not hibernation)
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, stopInstance } from "@/lib/aws";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StopServerResponse>>> {
  const operation = createOperationInfo("stop", "running");
  let userEmail = "unknown";

  try {
    const user = await requireAdmin(request);
    userEmail = user.email;
    console.log("[STOP] Action by:", user.email, "role:", user.role);

    const throttleResponse = await enforceMutatingRouteThrottle<StopServerResponse>({
      request,
      route: "/api/stop",
      operation,
      identity: user.email,
    });
    if (throttleResponse) {
      return throttleResponse;
    }
  } catch (error) {
    if (error instanceof Response) {
      return await formatAuthErrorResponse<StopServerResponse>(error, withOperationStatus(operation, "failed"));
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
          operation: withOperationStatus(operation, "failed"),
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
          operation: withOperationStatus(operation, "failed"),
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const lock = await acquireServerActionLock("stop", userEmail);

    try {
      // Send stop command
      console.log("[STOP] Sending stop command...");
      await stopInstance(resolvedId);
    } finally {
      await releaseServerActionLock(lock.lockId, { action: "stop", ownerEmail: userEmail }).catch((releaseError) => {
        console.error("[STOP] Failed to release lock:", releaseError);
      });
    }

    const response: ApiResponse<StopServerResponse> = {
      success: true,
      data: {
        instanceId: resolvedId,
        message: "Server stop command sent successfully",
      },
      operation: withOperationStatus(operation, "accepted"),
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
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

    return formatApiErrorResponse<StopServerResponse>(
      error,
      "stop",
      undefined,
      withOperationStatus(operation, "failed")
    );
  }
}
