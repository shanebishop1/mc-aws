/**
 * POST /api/resume
 * Resume from hibernation -> Async Lambda
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { createMutatingActionFailure, createMutatingActionRequestContext } from "@/lib/mutating-action-contract";
import { runMutatingActionLifecycle } from "@/lib/mutating-action-lifecycle";
import {
  createMutatingActionLockConflictFailure,
  mapMutatingActionExecutionToApiResponse,
} from "@/lib/mutating-action-response";
import { parseMutatingActionRequestPayload, type ResumeRestoreMode } from "@/lib/mutating-action-validation";
import { enforceMutatingRouteThrottle, mapMutatingRouteThrottleFailure } from "@/lib/mutating-route-throttle";
import { withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

/**
 * Check if server is already running
 */
function checkAlreadyRunning(
  currentState: string
): void {
  if (currentState === ServerState.Running) {
    throw new ResumeAlreadyRunningError();
  }
}

const validationErrorPatterns = [
  "Backup name is required",
  "Backup name exceeds maximum length",
  "Backup name cannot be empty",
  "Backup name contains invalid characters",
  "Restore mode must be one of",
  "Restore mode 'fresh' cannot be used with a backup name",
  "Restore mode 'latest' cannot be used with a backup name",
  "Backup name is required when restore mode is 'named'",
] as const;

class ResumeAlreadyRunningError extends Error {
  code = "already_running";

  constructor() {
    super("Server is already running");
    this.name = "ResumeAlreadyRunningError";
  }
}

function isValidationErrorMessage(message: string): boolean {
  return validationErrorPatterns.some((pattern) => message.includes(pattern));
}

/**
 * Invoke resume Lambda and return response
 */
async function invokeResumeLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string,
  operationId: string,
  restoreMode: ResumeRestoreMode,
  backupName?: string
): Promise<ResumeResponse> {
  console.log(`[RESUME] Invoking Lambda for resume on ${instanceId}`);
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "resume",
    instanceId,
    userEmail: user.email,
    restoreMode,
    args: backupName ? [backupName] : [],
    lockId,
    operationId,
  });

  const restoreOutputByMode: Record<ResumeRestoreMode, string> = {
    fresh: "Fresh world requested",
    latest: "Restore requested: latest",
    named: `Restore requested: ${backupName ?? "(missing backup)"}`,
  };

  return {
    message: "Resume started asynchronously. You will receive an email upon completion.",
    instanceId,
    domain: env.CLOUDFLARE_MC_DOMAIN,
    restoreOutput: restoreOutputByMode[restoreMode],
  };
}

function resolveResumeRestoreMode(backupName?: string, restoreMode?: ResumeRestoreMode): ResumeRestoreMode {
  if (restoreMode === "named" && !backupName) {
    throw new Error("Backup name is required when restore mode is 'named'");
  }

  if (restoreMode === "fresh" && backupName) {
    throw new Error("Restore mode 'fresh' cannot be used with a backup name");
  }

  if (restoreMode === "latest" && backupName) {
    throw new Error("Restore mode 'latest' cannot be used with a backup name");
  }

  if (backupName) {
    return "named";
  }

  return restoreMode === "latest" ? "latest" : "fresh";
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/resume", "resume");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;
  let backupName: string | undefined;
  let restoreMode: ResumeRestoreMode = "fresh";

  const outcome = await runMutatingActionLifecycle<AuthUser, ResumeResponse, void>({
    context,
    authenticate: async () => {
      const user = await requireAdmin(context.request);
      console.log("[RESUME] Admin action by:", user.email);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<ResumeResponse>({
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
      const payload = await parseMutatingActionRequestPayload(context.request, "resume");
      backupName = payload.backupName;
      restoreMode = resolveResumeRestoreMode(payload.backupName, payload.restoreMode);

      resolvedId = await findInstanceId();
      const currentState = await getInstanceState(resolvedId);
      checkAlreadyRunning(currentState);

      return await acquireServerActionLock("resume", user.email);
    },
    invoke: async ({ user, lock }) => {
      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking resume action");
      }

      return await invokeResumeLambda(resolvedId, user, lock.lockId, context.operation.id, restoreMode, backupName);
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

      if (error instanceof ResumeAlreadyRunningError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: error.code,
          cause: error,
        });
      }

      if (error instanceof Error && isValidationErrorMessage(error.message)) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: "invalid_payload",
          cause: error,
        });
      }

      return createMutatingActionFailure("Failed to resume server", {
        cause: error,
      });
    },
    finalize: async ({ execution, lock, user }) => {
      if (execution.ok || !lock) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";
      await releaseServerActionLock(lock.lockId, { action: "resume", ownerEmail }).catch((releaseError) => {
        console.error("[RESUME] Failed to release lock after invoke error:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<ResumeResponse>(
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
