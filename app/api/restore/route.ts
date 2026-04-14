/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatAuthErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
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
import type { ApiResponse, RestoreResponse } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

const validationErrorPatterns = [
  "Backup name is required",
  "Backup name exceeds maximum length",
  "Backup name cannot be empty",
  "Backup name contains invalid characters",
] as const;

class RestoreInvalidStateError extends Error {
  code = "invalid_state";

  constructor(currentState: string) {
    super(`Cannot restore when server is ${currentState}. Server must be running.`);
    this.name = "RestoreInvalidStateError";
  }
}

class RestoreServiceNotReadyError extends Error {
  code = "service_not_ready";

  constructor() {
    super("Minecraft service is still initializing. Please wait a moment.");
    this.name = "RestoreServiceNotReadyError";
  }
}

function isValidationErrorMessage(message: string): boolean {
  return validationErrorPatterns.some((pattern) => message.includes(pattern));
}

async function validateRestoreState(instanceId: string): Promise<void> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    throw new RestoreInvalidStateError(currentState);
  }
}

async function validateServiceReady(instanceId: string): Promise<void> {
  try {
    console.log("[RESTORE] Checking Minecraft service status on instance:", instanceId);
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const trimmedOutput = output.trim();

    if (trimmedOutput !== "active") {
      console.log("[RESTORE] Minecraft service not ready, status:", trimmedOutput);
      throw new RestoreServiceNotReadyError();
    }

    console.log("[RESTORE] Minecraft service is active and ready");
  } catch (error) {
    if (error instanceof RestoreServiceNotReadyError) {
      throw error;
    }

    console.error("[RESTORE] Error checking Minecraft service status:", error);
    // If we can't check the service status, allow the restore to proceed
    // This prevents blocking restores due to transient SSM issues
    console.warn("[RESTORE] Proceeding with restore despite service check failure");
  }
}

async function invokeRestoreLambda(
  instanceId: string,
  userEmail: string,
  lockId: string,
  operationId: string,
  backupName?: string
): Promise<RestoreResponse> {
  console.log(`[RESTORE] Invoking Lambda for restore on ${instanceId}`);
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "restore",
    instanceId,
    userEmail,
    args: backupName ? [backupName] : [],
    lockId,
    operationId,
  });

  return {
    backupName: backupName || "latest",
    message: "Restore started asynchronously. You will receive an email upon completion.",
    output: "",
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/restore", "restore");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;
  let backupName: string | undefined;

  const outcome = await runMutatingActionLifecycle<{ email: string; role: string }, RestoreResponse, void>({
    context,
    authenticate: async () => {
      const user = await requireAdmin(context.request);
      console.log("[RESTORE] Admin action by:", user.email);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<RestoreResponse>({
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
      const payload = await parseMutatingActionRequestPayload(context.request, "restore");
      backupName = payload.backupName;

      resolvedId = await findInstanceId();
      await validateRestoreState(resolvedId);
      await validateServiceReady(resolvedId);

      return await acquireServerActionLock("restore", user.email);
    },
    invoke: async ({ user, lock }) => {
      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking restore action");
      }

      return await invokeRestoreLambda(resolvedId, user.email, lock.lockId, context.operation.id, backupName);
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

      if (error instanceof RestoreInvalidStateError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: error.code,
          cause: error,
        });
      }

      if (error instanceof RestoreServiceNotReadyError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 409,
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

      return createMutatingActionFailure("Failed to restore backup", {
        cause: error,
      });
    },
    finalize: async ({ execution, lock, user }) => {
      if (execution.ok || !lock) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";
      await releaseServerActionLock(lock.lockId, { action: "restore", ownerEmail }).catch((releaseError) => {
        console.error("[RESTORE] Failed to release lock after invoke error:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<RestoreResponse>(
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
