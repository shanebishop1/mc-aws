/**
 * POST /api/stop
 * Stops the server (keeps EBS attached - not hibernation)
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, stopInstance } from "@/lib/aws";
import { createMutatingActionFailure, createMutatingActionSuccess } from "@/lib/mutating-action-contract";
import {
  createMutatingActionLockConflictFailure,
  mapMutatingActionExecutionToApiResponse,
} from "@/lib/mutating-action-response";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

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
      return mapMutatingActionExecutionToApiResponse(
        operation,
        createMutatingActionFailure("Server is already stopped", { httpStatus: 400, code: "already_stopped" })
      );
    }

    if (currentState !== ServerState.Running && currentState !== ServerState.Pending) {
      return mapMutatingActionExecutionToApiResponse(
        operation,
        createMutatingActionFailure(`Cannot stop server in state: ${currentState}`, {
          httpStatus: 400,
          code: "invalid_state",
        })
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

    return mapMutatingActionExecutionToApiResponse(
      operation,
      createMutatingActionSuccess({
        instanceId: resolvedId,
        message: "Server stop command sent successfully",
      })
    );
  } catch (error) {
    if (isServerActionLockConflictError(error)) {
      return mapMutatingActionExecutionToApiResponse(operation, createMutatingActionLockConflictFailure(error));
    }

    return formatApiErrorResponse<StopServerResponse>(
      error,
      "stop",
      undefined,
      withOperationStatus(operation, "failed")
    );
  }
}
