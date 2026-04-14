/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatApiErrorResponseWithStatus, formatAuthErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { enforceMutatingRouteThrottle } from "@/lib/mutating-route-throttle";
import { createOperationInfo, withOperationStatus } from "@/lib/operation";
import {
  acquireServerActionLock,
  isServerActionLockConflictError,
  releaseServerActionLock,
} from "@/lib/server-action-lock";
import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Parse request body for hibernate endpoint
 */
async function parseHibernateBody(request: NextRequest): Promise<void> {
  try {
    await request.clone().json();
    // We don't use any body parameters, just consume it
  } catch {
    // Empty or invalid body is fine
  }
}

/**
 * Check if server is already hibernating
 */
function checkAlreadyHibernating(
  currentState: string,
  resolvedId: string,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<HibernateResponse>> | null {
  if (currentState === ServerState.Hibernating) {
    return NextResponse.json({
      success: true,
      data: {
        message: "Server is already hibernating (stopped with no volumes)",
        instanceId: resolvedId,
        backupOutput: "Skipped - already hibernating",
      },
      operation: withOperationStatus(operationId, "completed"),
      timestamp: new Date().toISOString(),
    });
  }
  return null;
}

/**
 * Validate server state for hibernation
 */
function validateHibernateState(
  currentState: string,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<HibernateResponse>> | null {
  if (currentState !== ServerState.Running) {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot hibernate when server is ${currentState}. Server must be running.`,
        operation: withOperationStatus(operationId, "failed"),
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }
  return null;
}

/**
 * Invoke hibernate Lambda and return response
 */
async function invokeHibernateLambda(
  instanceId: string,
  user: AuthUser,
  lockId: string,
  operationId: ReturnType<typeof createOperationInfo>
): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    console.log(`[HIBERNATE] Invoking Lambda for hibernate on ${instanceId}`);
    await invokeLambda("StartMinecraftServer", {
      invocationType: "api",
      command: "hibernate",
      instanceId: instanceId,
      userEmail: user.email,
      args: [],
      lockId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          message: "Hibernate started asynchronously. You will receive an email upon completion.",
          instanceId: instanceId,
          backupOutput: "",
        },
        operation: withOperationStatus(operationId, "accepted"),
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[HIBERNATE] Lambda invocation failed:", error);
    await releaseServerActionLock(lockId, { action: "hibernate", ownerEmail: user.email }).catch((releaseError) => {
      console.error("[HIBERNATE] Failed to release lock after invoke error:", releaseError);
    });
    throw error;
  }
}

/**
 * Build error response for hibernate endpoint
 */
function buildHibernateErrorResponse(
  error: unknown,
  operationId: ReturnType<typeof createOperationInfo>
): NextResponse<ApiResponse<HibernateResponse>> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  if (isServerActionLockConflictError(error) || errorMessage.includes("Another operation is in progress")) {
    return formatApiErrorResponseWithStatus<HibernateResponse>(
      error,
      409,
      "Another operation is in progress. Please wait for it to complete.",
      withOperationStatus(operationId, "failed")
    );
  }

  return formatApiErrorResponse<HibernateResponse>(
    error,
    "hibernate",
    undefined,
    withOperationStatus(operationId, "failed")
  );
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  const operation = createOperationInfo("hibernate", "running");

  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[HIBERNATE] Admin action by:", user.email);

      const throttleResponse = await enforceMutatingRouteThrottle<HibernateResponse>({
        request,
        route: "/api/hibernate",
        operation,
        identity: user.email,
      });
      if (throttleResponse) {
        return throttleResponse;
      }
    } catch (error) {
      if (error instanceof Response) {
        return await formatAuthErrorResponse<HibernateResponse>(error, withOperationStatus(operation, "failed"));
      }
      throw error;
    }

    // Parse body (we don't use any parameters, just consume it)
    await parseHibernateBody(request);
    const resolvedId = await findInstanceId();

    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[HIBERNATE] Current state:", currentState);

    // Check if already hibernating
    const alreadyHibernating = checkAlreadyHibernating(currentState, resolvedId, operation);
    if (alreadyHibernating) {
      return alreadyHibernating;
    }

    // Validate state
    const stateError = validateHibernateState(currentState, operation);
    if (stateError) {
      return stateError;
    }

    // Invoke Lambda for hibernate
    const lock = await acquireServerActionLock("hibernate", user.email);
    return await invokeHibernateLambda(resolvedId, user, lock.lockId, operation);
  } catch (error) {
    return buildHibernateErrorResponse(error, operation);
  }
}
