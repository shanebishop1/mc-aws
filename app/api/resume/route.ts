/**
 * POST /api/resume
 * Resume from hibernation -> Async Lambda
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { parseMutatingActionRequestPayload } from "@/lib/mutating-action-validation";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Check if server is already running
 */
function checkAlreadyRunning(
  currentState: string,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<ResumeResponse>> | null {
  if (currentState === ServerState.Running) {
    return NextResponse.json(
      {
        success: false,
        error: "Server is already running",
        operation: withOperationStatus(operationId, "failed"),
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }
  return null;
}

/**
 * Invoke resume Lambda and return response
 */
async function invokeResumeLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string,
  operationId: ReturnType<typeof createOperationInfo>,
  backupName?: string
): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  try {
    console.log(`[RESUME] Invoking Lambda for resume on ${instanceId}`);
    await invokeLambda("StartMinecraftServer", {
      invocationType: "api",
      command: "resume",
      instanceId: instanceId,
      userEmail: user.email,
      args: backupName ? [backupName] : [],
      lockId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          message: "Resume started asynchronously. You will receive an email upon completion.",
          instanceId: instanceId,
          domain: env.CLOUDFLARE_MC_DOMAIN,
          restoreOutput: backupName ? `Restore requested: ${backupName}` : undefined,
        },
        operation: withOperationStatus(operationId, "accepted"),
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[RESUME] Lambda invocation failed:", error);
    await releaseServerActionLock(lockId, { action: "resume", ownerEmail: user.email }).catch((releaseError) => {
      console.error("[RESUME] Failed to release lock after invoke error:", releaseError);
    });
    throw error;
  }
}

/**
 * Build error response for resume endpoint
 */
function buildResumeErrorResponse(
  error: unknown,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<ResumeResponse>> {
  return formatApiErrorResponse<ResumeResponse>(error, "resume", undefined, withOperationStatus(operationId, "failed"));
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  const operation = createOperationInfo("resume", "running");

  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[RESUME] Admin action by:", user.email);

      const throttleResponse = await enforceMutatingRouteThrottle<ResumeResponse>({
        request,
        route: "/api/resume",
        operation,
        identity: user.email,
      });
      if (throttleResponse) {
        return throttleResponse;
      }
    } catch (error) {
      if (error instanceof Response) {
        return await formatAuthErrorResponse<ResumeResponse>(error, withOperationStatus(operation, "failed"));
      }
      throw error;
    }

    // Parse and sanitize optional backup name
    const { backupName } = await parseMutatingActionRequestPayload(request, "resume");
    const resolvedId = await findInstanceId();

    // Check current state
    const currentState = await getInstanceState(resolvedId);

    // Check if already running
    const alreadyRunning = checkAlreadyRunning(currentState, operation);
    if (alreadyRunning) {
      return alreadyRunning;
    }

    // Invoke Lambda for resume
    const lock = await acquireServerActionLock("resume", user.email);
    return await invokeResumeLambda(resolvedId, user, lock.lockId, operation, backupName);
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

    return buildResumeErrorResponse(error, operation);
  }
}
