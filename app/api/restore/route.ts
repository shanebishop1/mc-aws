/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { ApiResponse, RestoreRequest, RestoreResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Parse request body for restore endpoint
 */
async function parseRestoreBody(request: NextRequest): Promise<RestoreRequest> {
  try {
    return await request.json();
  } catch {
    // Empty body is valid - will use latest backup
    return {};
  }
}

/**
 * Validate server state for restore
 */
async function validateRestoreState(instanceId: string): Promise<NextResponse<ApiResponse<RestoreResponse>> | null> {
  const currentState = await getInstanceState(instanceId);
  if (currentState !== "running") {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot restore when server is ${currentState}. Server must be running.`,
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
async function validateServiceReady(instanceId: string): Promise<NextResponse<ApiResponse<RestoreResponse>> | null> {
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
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          backupName: backupName || "latest",
          message: "Restore started asynchronously. You will receive an email upon completion.",
          output: "",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[RESTORE] Lambda invocation failed:", error);
    throw error;
  }
}

/**
 * Build error response for restore endpoint
 */
function buildRestoreErrorResponse(error: unknown): NextResponse<ApiResponse<RestoreResponse>> {
  return formatApiErrorResponse<RestoreResponse>(error, "restore");
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  try {
    // Check admin authorization
    const authResult = await requireAdmin(request).catch((e) => e);
    if (authResult instanceof Response) {
      return authResult as NextResponse<ApiResponse<RestoreResponse>>;
    }
    console.log("[RESTORE] Admin action by:", authResult.email);

    // Parse request body
    const body = await parseRestoreBody(request);
    const backupName = body.backupName || body.name;
    const resolvedId = await findInstanceId();

    // Validate backup name if provided
    if (backupName) {
      sanitizeBackupName(backupName);
    }

    // Check current state - must be running
    const stateError = await validateRestoreState(resolvedId);
    if (stateError) {
      return stateError;
    }

    // Check Minecraft service is ready
    const serviceError = await validateServiceReady(resolvedId);
    if (serviceError) {
      return serviceError;
    }

    // Invoke Lambda for restore
    return await invokeRestoreLambda(resolvedId, authResult.email, backupName);
  } catch (error) {
    return buildRestoreErrorResponse(error);
  }
}
