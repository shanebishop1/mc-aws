/**
 * POST /api/start
 * Starts the server asynchronously (fire-and-forget)
 * Sets the server-action lock, invokes the Lambda, and returns immediately
 * The Lambda is responsible for clearing the lock when complete
 */

import { type AuthUser, requireAllowed } from "@/lib/api-auth";
import { formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { createMutatingActionRequestContext, createMutatingActionFailure } from "@/lib/mutating-action-contract";
import { runMutatingActionLifecycle } from "@/lib/mutating-action-lifecycle";
import {
  createMutatingActionLockConflictFailure,
  mapMutatingActionExecutionToApiResponse,
} from "@/lib/mutating-action-response";
import { parseMutatingActionRequestPayload } from "@/lib/mutating-action-validation";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, StartServerResponse } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

const alreadyRunningErrorCode = "already_running";

class StartAlreadyRunningError extends Error {
  code = alreadyRunningErrorCode;

  constructor() {
    super("Server is already running");
    this.name = "StartAlreadyRunningError";
  }
}

function isAlreadyRunningError(error: unknown): error is StartAlreadyRunningError {
  return error instanceof StartAlreadyRunningError;
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/start", "start");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;

  const outcome = await runMutatingActionLifecycle<AuthUser, StartServerResponse, void>({
    context,
    authenticate: async () => {
      const user = await requireAllowed(context.request);
      console.log("[START] Action by:", user.email, "role:", user.role);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<StartServerResponse>({
        request: context.request,
        route: context.route,
        operation: context.operation,
        identity: user.email,
      });

      if (!throttleResponse) {
        return { allowed: true };
      }

      throttleRetryAfterHeader = throttleResponse.headers.get("Retry-After") ?? undefined;
      throttleCacheControlHeader = throttleResponse.headers.get("Cache-Control") ?? undefined;

      try {
        const payload = await throttleResponse.clone().json();
        const errorMessage =
          typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "Too many start requests. Please retry shortly.";

        return {
          allowed: false,
          httpStatus: throttleResponse.status,
          code: "throttled",
          message: errorMessage,
        };
      } catch {
        return {
          allowed: false,
          httpStatus: throttleResponse.status,
          code: "throttled",
          message: "Too many start requests. Please retry shortly.",
        };
      }
    },
    acquireLock: async ({ user }) => {
      await parseMutatingActionRequestPayload(context.request, "start");

      resolvedId = await findInstanceId();
      console.log("[START] Starting server instance:", resolvedId);

      const currentState = await getInstanceState(resolvedId);
      console.log("[START] Current state:", currentState);

      if (currentState === "running") {
        throw new StartAlreadyRunningError();
      }

      return await acquireServerActionLock("start", user.email);
    },
    invoke: async ({ user, lock }) => {
      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking start action");
      }

      console.log("[START] Invoking StartMinecraftServer Lambda");
      await invokeLambda("StartMinecraftServer", {
        invocationType: "api",
        command: "start",
        userEmail: user.email,
        instanceId: resolvedId,
        lockId: lock.lockId,
        operationId: context.operation.id,
      });

      return {
        instanceId: resolvedId,
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: "Server start initiated. This may take 1-2 minutes.",
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

      if (isAlreadyRunningError(error)) {
        return createMutatingActionFailure("Server is already running", {
          httpStatus: 400,
          code: alreadyRunningErrorCode,
          cause: error,
        });
      }

      return createMutatingActionFailure("Failed to start server", {
        cause: error,
      });
    },
    finalize: async ({ execution, lock, user }) => {
      if (execution.ok || !lock) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";

      await releaseServerActionLock(lock.lockId, { action: "start", ownerEmail }).catch((releaseError) => {
        console.error("[START] Failed to release lock after invoke error:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<StartServerResponse>(
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
