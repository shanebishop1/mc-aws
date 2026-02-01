/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { requireAdmin } from "@/lib/api-auth";
import { acquireServerAction, findInstanceId, invokeLambda, releaseServerAction } from "@/lib/aws";
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
 * Acquire server action lock with conflict handling
 */
async function acquireRestoreLock(): Promise<NextResponse<ApiResponse<RestoreResponse>> | null> {
  try {
    await acquireServerAction("restore");
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
          publicIp: "pending",
          message: "Restore started asynchronously. You will receive an email upon completion.",
          output: "",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[RESTORE] Lambda invocation failed:", error);
    await releaseServerAction();
    throw error;
  }
}

/**
 * Build error response for restore endpoint
 */
function buildRestoreErrorResponse(error: unknown): NextResponse<ApiResponse<RestoreResponse>> {
  console.error("[RESTORE] Error:", error);
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
    const resolvedId = body.instanceId || (await findInstanceId());

    // Validate backup name if provided
    if (backupName) {
      sanitizeBackupName(backupName);
    }

    // Check atomic lock
    const lockError = await acquireRestoreLock();
    if (lockError) {
      return lockError;
    }

    // Invoke Lambda for restore
    return await invokeRestoreLambda(resolvedId, authResult.email, backupName);
  } catch (error) {
    return buildRestoreErrorResponse(error);
  }
}
