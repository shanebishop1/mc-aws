/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import { sanitizeBackupName } from "@/lib/sanitization";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, BackupResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface BackupRequestBody {
  name?: string;
}

/**
 * Parse request body for backup endpoint
 */
async function parseBackupBody(request: NextRequest): Promise<BackupRequestBody> {
  try {
    const body = await request.json();
    return {
      name: body?.name,
    };
  } catch {
    // Empty or invalid body is fine
    return {};
  }
}

/**
 * Validate server state for backup
 */
async function validateBackupState(
  instanceId: string,
  operationId: ReturnType<typeof createOperationInfo>
): Promise<NextResponse<ApiResponse<BackupResponse>> | null> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot backup when server is ${currentState}. Server must be running.`,
        operation: withOperationStatus(operationId, "failed"),
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }
  return null;
}

/**
 * Validate Minecraft service is ready for backup
 */
async function validateServiceReady(
  instanceId: string,
  operationId: ReturnType<typeof createOperationInfo>
): Promise<NextResponse<ApiResponse<BackupResponse>> | null> {
  try {
    console.log("[BACKUP] Checking Minecraft service status on instance:", instanceId);
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const trimmedOutput = output.trim();

    if (trimmedOutput !== "active") {
      console.log("[BACKUP] Minecraft service not ready, status:", trimmedOutput);
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

    console.log("[BACKUP] Minecraft service is active and ready");
    return null;
  } catch (error) {
    console.error("[BACKUP] Error checking Minecraft service status:", error);
    // If we can't check the service status, allow the backup to proceed
    // This prevents blocking backups due to transient SSM issues
    console.warn("[BACKUP] Proceeding with backup despite service check failure");

    return null;
  }
}

/**
 * Invoke backup Lambda and return response
 */
async function invokeBackupLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string,
  operationId: ReturnType<typeof createOperationInfo>,
  backupName?: string
): Promise<NextResponse<ApiResponse<BackupResponse>>> {
  try {
    console.log(`[BACKUP] Invoking Lambda for backup on ${instanceId}`);
    await invokeLambda("StartMinecraftServer", {
      invocationType: "api",
      command: "backup",
      instanceId: instanceId,
      userEmail: user.email,
      args: backupName ? [backupName] : [],
      lockId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          backupName,
          message: "Backup started asynchronously. You will receive an email upon completion.",
          output: "",
        },
        operation: withOperationStatus(operationId, "accepted"),
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[BACKUP] Lambda invocation failed:", error);
    await releaseServerActionLock(lockId).catch((releaseError) => {
      console.error("[BACKUP] Failed to release lock after invoke error:", releaseError);
    });
    throw error;
  }
}

/**
 * Build error response for backup endpoint
 */
function buildBackupErrorResponse(
  error: unknown,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<BackupResponse>> {
  return formatApiErrorResponse<BackupResponse>(error, "backup", undefined, withOperationStatus(operationId, "failed"));
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<BackupResponse>>> {
  const operation = createOperationInfo("backup", "running");

  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[BACKUP] Admin action by:", user.email);

      const throttleResponse = await enforceMutatingRouteThrottle<BackupResponse>({
        request,
        route: "/api/backup",
        operation,
        identity: user.email,
      });
      if (throttleResponse) {
        return throttleResponse;
      }
    } catch (error) {
      if (error instanceof Response) {
        return await formatAuthErrorResponse<BackupResponse>(error, withOperationStatus(operation, "failed"));
      }
      throw error;
    }

    // Parse body for backup name
    const { name: backupName } = await parseBackupBody(request);
    const resolvedId = await findInstanceId();

    // Validate backup name (defense in depth)
    if (backupName) {
      sanitizeBackupName(backupName);
    }

    // Check current state - must be running
    const stateError = await validateBackupState(resolvedId, operation);
    if (stateError) {
      return stateError;
    }

    // Check Minecraft service is ready
    const serviceError = await validateServiceReady(resolvedId, operation);
    if (serviceError) {
      return serviceError;
    }

    // Invoke Lambda for backup
    const lock = await acquireServerActionLock("backup", user.email);
    return await invokeBackupLambda(resolvedId, user, lock.lockId, operation, backupName);
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

    return buildBackupErrorResponse(error, operation);
  }
}
