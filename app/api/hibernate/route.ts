/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import {
  createMutatingActionFailure,
  createMutatingActionRequestContext,
  createMutatingActionSuccess,
} from "@/lib/mutating-action-contract";
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
import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

/**
 * Check if server is already hibernating
 */
function checkAlreadyHibernating(
  currentState: string,
  resolvedId: string
): HibernateResponse | null {
  if (currentState === ServerState.Hibernating) {
    return {
      message: "Server is already hibernating (stopped with no volumes)",
      instanceId: resolvedId,
      backupOutput: "Skipped - already hibernating",
    };
  }
  return null;
}

class HibernateInvalidStateError extends Error {
  code = "invalid_state";

  constructor(currentState: string) {
    super(`Cannot hibernate when server is ${currentState}. Server must be running.`);
    this.name = "HibernateInvalidStateError";
  }
}

function validateHibernateState(currentState: string): void {
  if (currentState !== ServerState.Running) {
    throw new HibernateInvalidStateError(currentState);
  }
}

/**
 * Invoke hibernate Lambda and return response
 */
async function invokeHibernateLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string
): Promise<HibernateResponse> {
  console.log(`[HIBERNATE] Invoking Lambda for hibernate on ${instanceId}`);
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "hibernate",
    instanceId,
    userEmail: user.email,
    args: [],
    lockId,
  });

  return {
    message: "Hibernate started asynchronously. You will receive an email upon completion.",
    instanceId,
    backupOutput: "",
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/hibernate", "hibernate");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;

  const outcome = await runMutatingActionLifecycle<AuthUser, HibernateResponse, void>({
    context,
    authenticate: async () => {
      const user = await requireAdmin(context.request);
      console.log("[HIBERNATE] Admin action by:", user.email);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<HibernateResponse>({
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
      await parseMutatingActionRequestPayload(context.request, "hibernate");

      resolvedId = await findInstanceId();
      const currentState = await getInstanceState(resolvedId);
      console.log("[HIBERNATE] Current state:", currentState);

      const alreadyHibernatingData = checkAlreadyHibernating(currentState, resolvedId);
      if (alreadyHibernatingData) {
        return {
          lockId: "already-hibernating",
          action: "hibernate",
          ownerEmail: user.email,
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          alreadyHibernatingData,
        };
      }

      validateHibernateState(currentState);
      return await acquireServerActionLock("hibernate", user.email);
    },
    invoke: async ({ user, lock }) => {
      const syntheticLock = lock as typeof lock & { alreadyHibernatingData?: HibernateResponse };
      if (syntheticLock.alreadyHibernatingData) {
        return syntheticLock.alreadyHibernatingData;
      }

      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking hibernate action");
      }

      return await invokeHibernateLambda(resolvedId, user, lock.lockId);
    },
    mapInvokeResult: ({ lock, invokeResult }) => {
      const syntheticLock = lock as typeof lock & { alreadyHibernatingData?: HibernateResponse };
      if (syntheticLock.alreadyHibernatingData) {
        return createMutatingActionSuccess(invokeResult, "completed", 200);
      }

      return createMutatingActionSuccess(invokeResult);
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

      if (error instanceof HibernateInvalidStateError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: error.code,
          cause: error,
        });
      }

      return createMutatingActionFailure("Failed to hibernate server", {
        cause: error,
      });
    },
    finalize: async ({ execution, lock, user }) => {
      const syntheticLock = lock as (typeof lock & { alreadyHibernatingData?: HibernateResponse }) | undefined;
      if (execution.ok || !lock || syntheticLock?.alreadyHibernatingData) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";
      await releaseServerActionLock(lock.lockId, { action: "hibernate", ownerEmail }).catch((releaseError) => {
        console.error("[HIBERNATE] Failed to release lock after invoke error:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<HibernateResponse>(
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
