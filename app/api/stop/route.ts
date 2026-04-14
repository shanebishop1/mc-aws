/**
 * POST /api/stop
 * Stops the server (keeps EBS attached - not hibernation)
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, stopInstance } from "@/lib/aws";
import { createMutatingActionFailure, createMutatingActionRequestContext } from "@/lib/mutating-action-contract";
import { runMutatingActionLifecycle } from "@/lib/mutating-action-lifecycle";
import {
  createMutatingActionLockConflictFailure,
  mapMutatingActionExecutionToApiResponse,
} from "@/lib/mutating-action-response";
import { parseMutatingActionRequestPayload } from "@/lib/mutating-action-validation";
import { enforceMutatingRouteThrottle, mapMutatingRouteThrottleFailure } from "@/lib/mutating-route-throttle";
import { withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StopServerResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/stop", "stop");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;

  class StopAlreadyStoppedError extends Error {
    code = "already_stopped";

    constructor() {
      super("Server is already stopped");
      this.name = "StopAlreadyStoppedError";
    }
  }

  class StopInvalidStateError extends Error {
    code = "invalid_state";

    constructor(currentState: string) {
      super(`Cannot stop server in state: ${currentState}`);
      this.name = "StopInvalidStateError";
    }
  }

  const outcome = await runMutatingActionLifecycle({
    context,
    authenticate: async () => {
      const user = await requireAdmin(context.request);
      console.log("[STOP] Action by:", user.email, "role:", user.role);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<StopServerResponse>({
        request: context.request,
        route: context.route,
        operation: context.operation,
        identity: user.email,
      });

      if (!throttleResponse) {
        return { allowed: true };
      }

      const throttleFailure = await mapMutatingRouteThrottleFailure(throttleResponse, context.operation.type);
      throttleRetryAfterHeader = throttleFailure.retryAfterHeader;
      throttleCacheControlHeader = throttleFailure.cacheControlHeader;
      return throttleFailure.decision;
    },
    acquireLock: async ({ user }) => {
      await parseMutatingActionRequestPayload(context.request, "stop");

      resolvedId = await findInstanceId();
      console.log("[STOP] Stopping server instance:", resolvedId);

      const currentState = await getInstanceState(resolvedId);
      console.log("[STOP] Current state:", currentState);

      if (currentState === ServerState.Stopped || currentState === ServerState.Hibernating) {
        throw new StopAlreadyStoppedError();
      }

      if (currentState !== ServerState.Running && currentState !== ServerState.Pending) {
        throw new StopInvalidStateError(currentState);
      }

      return await acquireServerActionLock("stop", user.email);
    },
    invoke: async () => {
      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking stop action");
      }

      console.log("[STOP] Sending stop command...");
      await stopInstance(resolvedId);

      return {
        instanceId: resolvedId,
        message: "Server stop command sent successfully",
      };
    },
    mapError: ({ stage, error }) => {
      if (stage === "auth" && error instanceof Response) {
        authFailureResponse = error;
        return createMutatingActionFailure("Authentication required", {
          httpStatus: error.status,
          code: "auth_error",
          cause: error,
        });
      }

      if (isServerActionLockConflictError(error)) {
        return createMutatingActionLockConflictFailure(error);
      }

      if (error instanceof StopAlreadyStoppedError || error instanceof StopInvalidStateError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: error.code,
          cause: error,
        });
      }

      return createMutatingActionFailure("Failed to stop server", {
        cause: error,
      });
    },
    finalize: async ({ lock, user }) => {
      if (!lock) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";

      await releaseServerActionLock(lock.lockId, { action: "stop", ownerEmail }).catch((releaseError) => {
        console.error("[STOP] Failed to release lock:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<StopServerResponse>(
      authFailureResponse,
      withOperationStatus(context.operation, "failed")
    );
  }

  const response = mapMutatingActionExecutionToApiResponse(context.operation, outcome.execution);

  if (!outcome.execution.ok && outcome.execution.code === "throttled") {
    if (throttleRetryAfterHeader) {
      response.headers.set("Retry-After", throttleRetryAfterHeader);
    }

    if (throttleCacheControlHeader) {
      response.headers.set("Cache-Control", throttleCacheControlHeader);
    }
  }

  return response;
}
