/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import type { AuthUser } from "@/lib/api-auth";
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
import type { ApiResponse, BackupResponse } from "@/lib/types";
import type { NextRequest, NextResponse } from "next/server";

const validationErrorPatterns = [
  "Backup name is required",
  "Backup name exceeds maximum length",
  "Backup name cannot be empty",
  "Backup name contains invalid characters",
] as const;

class BackupInvalidStateError extends Error {
  code = "invalid_state";

  constructor(currentState: string) {
    super(`Cannot backup when server is ${currentState}. Server must be running.`);
    this.name = "BackupInvalidStateError";
  }
}

class BackupServiceNotReadyError extends Error {
  code = "service_not_ready";

  constructor() {
    super("Minecraft service is still initializing. Please wait a moment.");
    this.name = "BackupServiceNotReadyError";
  }
}

function isValidationErrorMessage(message: string): boolean {
  return validationErrorPatterns.some((pattern) => message.includes(pattern));
}

async function validateBackupState(instanceId: string): Promise<void> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    throw new BackupInvalidStateError(currentState);
  }
}

async function validateServiceReady(instanceId: string): Promise<void> {
  try {
    console.log("[BACKUP] Checking Minecraft service status on instance:", instanceId);
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const trimmedOutput = output.trim();

    if (trimmedOutput !== "active") {
      console.log("[BACKUP] Minecraft service not ready, status:", trimmedOutput);
      throw new BackupServiceNotReadyError();
    }

    console.log("[BACKUP] Minecraft service is active and ready");
  } catch (error) {
    if (error instanceof BackupServiceNotReadyError) {
      throw error;
    }

    console.error("[BACKUP] Error checking Minecraft service status:", error);
    // If we can't check the service status, allow the backup to proceed
    // This prevents blocking backups due to transient SSM issues
    console.warn("[BACKUP] Proceeding with backup despite service check failure");
  }
}

async function invokeBackupLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string,
  operationId: string,
  backupName?: string
): Promise<BackupResponse> {
  console.log(`[BACKUP] Invoking Lambda for backup on ${instanceId}`);
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "backup",
    instanceId,
    userEmail: user.email,
    args: backupName ? [backupName] : [],
    lockId,
    operationId,
  });

  return {
    backupName,
    message: "Backup started asynchronously. You will receive an email upon completion.",
    output: "",
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<BackupResponse>>> {
  const context = createMutatingActionRequestContext(request, "/api/backup", "backup");

  let authFailureResponse: Response | null = null;
  let throttleRetryAfterHeader: string | undefined;
  let throttleCacheControlHeader: string | undefined;
  let resolvedId: string | null = null;
  let backupName: string | undefined;

  const outcome = await runMutatingActionLifecycle<AuthUser, BackupResponse, void>({
    context,
    authenticate: async () => {
      const user = await requireAdmin(context.request);
      console.log("[BACKUP] Admin action by:", user.email);
      return user;
    },
    throttle: async ({ user }) => {
      const throttleResponse = await enforceMutatingRouteThrottle<BackupResponse>({
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
      const payload = await parseMutatingActionRequestPayload(context.request, "backup");
      backupName = payload.backupName;

      resolvedId = await findInstanceId();
      await validateBackupState(resolvedId);
      await validateServiceReady(resolvedId);

      return await acquireServerActionLock("backup", user.email);
    },
    invoke: async ({ user, lock }) => {
      if (!resolvedId) {
        throw new Error("Resolved instance ID is required before invoking backup action");
      }

      return await invokeBackupLambda(resolvedId, user, lock.lockId, context.operation.id, backupName);
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

      if (error instanceof BackupInvalidStateError) {
        return createMutatingActionFailure(error.message, {
          httpStatus: 400,
          code: error.code,
          cause: error,
        });
      }

      if (error instanceof BackupServiceNotReadyError) {
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

      return createMutatingActionFailure("Failed to create backup", {
        cause: error,
      });
    },
    finalize: async ({ execution, lock, user }) => {
      if (execution.ok || !lock) {
        return;
      }

      const ownerEmail = user?.email ?? "unknown";

      await releaseServerActionLock(lock.lockId, { action: "backup", ownerEmail }).catch((releaseError) => {
        console.error("[BACKUP] Failed to release lock after invoke error:", releaseError);
      });
    },
  });

  if (authFailureResponse) {
    return await formatAuthErrorResponse<BackupResponse>(
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
