/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
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

    // Invoke Lambda for backup
    return await invokeBackupLambda(resolvedId, user, backupName);
  } catch (error) {
    return buildBackupErrorResponse(error);
  }
}
