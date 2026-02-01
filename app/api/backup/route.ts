/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { acquireServerAction, findInstanceId, getInstanceState, invokeLambda, releaseServerAction } from "@/lib/aws";
import { env } from "@/lib/env";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { ApiResponse, BackupResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface BackupRequestBody {
  instanceId?: string;
  name?: string;
}

/**
 * Parse request body for backup endpoint
 */
async function parseBackupBody(request: NextRequest): Promise<BackupRequestBody> {
  try {
    const body = await request.json();
    return {
      instanceId: body?.instanceId,
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
 * Acquire server action lock with conflict handling
 */
async function acquireBackupLock(): Promise<NextResponse<ApiResponse<BackupResponse>> | null> {
  try {
    await acquireServerAction("backup");
    return null;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("Another operation is in progress")) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }
    throw error;
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
    await releaseServerAction();
    throw error;
  }
}

/**
 * Build error response for backup endpoint
 */
function buildBackupErrorResponse(error: unknown): NextResponse<ApiResponse<BackupResponse>> {
  console.error("[BACKUP] Error:", error);
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // If the error is about another action in progress, return 409 Conflict
  if (errorMessage.includes("Another operation is in progress")) {
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    },
    { status: 500 }
  );
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
    const { instanceId, name: backupName } = await parseBackupBody(request);
    const resolvedId = instanceId || (await findInstanceId());

    // Validate backup name (defense in depth)
    if (backupName) {
      sanitizeBackupName(backupName);
    }

    // Check current state - must be running
    const stateError = await validateBackupState(resolvedId);
    if (stateError) {
      return stateError;
    }

    // Acquire server action lock
    const lockError = await acquireBackupLock();
    if (lockError) {
      return lockError;
    }

    // Invoke Lambda for backup
    return await invokeBackupLambda(resolvedId, user, backupName);
  } catch (error) {
    return buildBackupErrorResponse(error);
  }
}
