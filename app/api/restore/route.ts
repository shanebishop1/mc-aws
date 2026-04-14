/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { parseMutatingActionRequestPayload } from "@/lib/mutating-action-validation";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, RestoreResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Validate server state for restore
 */
async function validateRestoreState(
  instanceId: string,
  operationId: ReturnType<typeof createOperationInfo>
): Promise<NextResponse<ApiResponse<RestoreResponse>> | null> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot restore when server is ${currentState}. Server must be running.`,
        operation: withOperationStatus(operationId, "failed"),
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }
  return null;
}

/**
 * Validate Minecraft service is ready for restore
 */
async function validateServiceReady(
  instanceId: string,
  operationId: ReturnType<typeof createOperationInfo>
): Promise<NextResponse<ApiResponse<RestoreResponse>> | null> {
  try {
    console.log("[RESTORE] Checking Minecraft service status on instance:", instanceId);
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const trimmedOutput = output.trim();

    if (trimmedOutput !== "active") {
      console.log("[RESTORE] Minecraft service not ready, status:", trimmedOutput);
      return NextResponse.json(
        {
          success: false,
          error: "Minecraft service is still initializing. Please wait a moment.",
          operation: withOperationStatus(operationId, "failed"),
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }

    console.log("[RESTORE] Minecraft service is active and ready");
    return null;
  } catch (error) {
    console.error("[RESTORE] Error checking Minecraft service status:", error);
    // If we can't check the service status, allow the restore to proceed
    // This prevents blocking restores due to transient SSM issues
    console.warn("[RESTORE] Proceeding with restore despite service check failure");

    return null;
  }
}

/**
 * Invoke restore Lambda and return response
 */
async function invokeRestoreLambda(
  instanceId: string,
  userEmail: string,
  lockId: string,
  operationId: ReturnType<typeof createOperationInfo>,
  backupName?: string
): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  try {
    console.log(`[RESTORE] Invoking Lambda for restore on ${instanceId}`);
    await invokeLambda("StartMinecraftServer", {
      invocationType: "api",
      command: "restore",
      instanceId: instanceId,
      userEmail: userEmail,
      args: backupName ? [backupName] : [],
      lockId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          backupName: backupName || "latest",
          message: "Restore started asynchronously. You will receive an email upon completion.",
          output: "",
        },
        operation: withOperationStatus(operationId, "accepted"),
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[RESTORE] Lambda invocation failed:", error);
    await releaseServerActionLock(lockId, { action: "restore", ownerEmail: userEmail }).catch((releaseError) => {
      console.error("[RESTORE] Failed to release lock after invoke error:", releaseError);
    });
    throw error;
  }
}

/**
 * Build error response for restore endpoint
 */
function buildRestoreErrorResponse(
  error: unknown,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<RestoreResponse>> {
  return formatApiErrorResponse<RestoreResponse>(
    error,
    "restore",
    undefined,
    withOperationStatus(operationId, "failed")
  );
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  const operation = createOperationInfo("restore", "running");

  try {
    // Check admin authorization
    const authResult = await requireAdmin(request).catch((e) => e);
    if (authResult instanceof Response) {
      return await formatAuthErrorResponse<RestoreResponse>(authResult, withOperationStatus(operation, "failed"));
    }
    console.log("[RESTORE] Admin action by:", authResult.email);

    const throttleResponse = await enforceMutatingRouteThrottle<RestoreResponse>({
      request,
      route: "/api/restore",
      operation,
      identity: authResult.email,
    });
    if (throttleResponse) {
      return throttleResponse;
    }

    // Parse and sanitize optional backup name (backupName takes precedence over legacy name)
    const { backupName } = await parseMutatingActionRequestPayload(request, "restore");
    const resolvedId = await findInstanceId();

    // Check current state - must be running
    const stateError = await validateRestoreState(resolvedId, operation);
    if (stateError) {
      return stateError;
    }

    // Check Minecraft service is ready
    const serviceError = await validateServiceReady(resolvedId, operation);
    if (serviceError) {
      return serviceError;
    }

    // Invoke Lambda for restore
    const lock = await acquireServerActionLock("restore", authResult.email);
    return await invokeRestoreLambda(resolvedId, authResult.email, lock.lockId, operation, backupName);
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

    return buildRestoreErrorResponse(error, operation);
  }
}
