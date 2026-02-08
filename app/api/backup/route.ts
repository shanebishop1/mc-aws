/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { sanitizeBackupName } from "@/lib/sanitization";
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
async function validateBackupState(instanceId: string): Promise<NextResponse<ApiResponse<BackupResponse>> | null> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot backup when server is ${currentState}. Server must be running.`,
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
async function validateServiceReady(instanceId: string): Promise<NextResponse<ApiResponse<BackupResponse>> | null> {
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
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          backupName,
          message: "Backup started asynchronously. You will receive an email upon completion.",
          output: "",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[BACKUP] Lambda invocation failed:", error);
    throw error;
  }
}

/**
 * Build error response for backup endpoint
 */
function buildBackupErrorResponse(error: unknown): NextResponse<ApiResponse<BackupResponse>> {
  return formatApiErrorResponse<BackupResponse>(error, "backup");
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<BackupResponse>>> {
  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[BACKUP] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<BackupResponse>>;
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
    const stateError = await validateBackupState(resolvedId);
    if (stateError) {
      return stateError;
    }

    // Check Minecraft service is ready
    const serviceError = await validateServiceReady(resolvedId);
    if (serviceError) {
      return serviceError;
    }

    // Invoke Lambda for backup
    return await invokeBackupLambda(resolvedId, user, backupName);
  } catch (error) {
    return buildBackupErrorResponse(error);
  }
}
