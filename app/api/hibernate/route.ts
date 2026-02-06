/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse, formatApiErrorResponseWithStatus } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
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
  resolvedId: string
): NextResponse<ApiResponse<HibernateResponse>> | null {
  if (currentState === ServerState.Hibernating) {
    return NextResponse.json({
      success: true,
      data: {
        message: "Server is already hibernating (stopped with no volumes)",
        instanceId: resolvedId,
        backupOutput: "Skipped - already hibernating",
      },
      timestamp: new Date().toISOString(),
    });
  }
  return null;
}

/**
 * Validate server state for hibernation
 */
function validateHibernateState(currentState: string): NextResponse<ApiResponse<HibernateResponse>> | null {
  if (currentState !== ServerState.Running) {
    return NextResponse.json(
      {
        success: false,
        error: `Cannot hibernate when server is ${currentState}. Server must be running.`,
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
  user: AuthUser
): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    console.log(`[HIBERNATE] Invoking Lambda for hibernate on ${instanceId}`);
    await invokeLambda("StartMinecraftServer", {
      invocationType: "api",
      command: "hibernate",
      instanceId: instanceId,
      userEmail: user.email,
      args: [],
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          message: "Hibernate started asynchronously. You will receive an email upon completion.",
          instanceId: instanceId,
          backupOutput: "",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[HIBERNATE] Lambda invocation failed:", error);
    throw error;
  }
}

/**
 * Build error response for hibernate endpoint
 */
function buildHibernateErrorResponse(error: unknown): NextResponse<ApiResponse<HibernateResponse>> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // If the error is about another action in progress, return 409 Conflict
  // This is a specific business logic error that should be preserved
  if (errorMessage.includes("Another operation is in progress")) {
    return formatApiErrorResponseWithStatus<HibernateResponse>(
      error,
      409,
      "Another operation is in progress. Please wait for it to complete."
    );
  }

  return formatApiErrorResponse<HibernateResponse>(error, "hibernate");
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[HIBERNATE] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<HibernateResponse>>;
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
    const alreadyHibernating = checkAlreadyHibernating(currentState, resolvedId);
    if (alreadyHibernating) {
      return alreadyHibernating;
    }

    // Validate state
    const stateError = validateHibernateState(currentState);
    if (stateError) {
      return stateError;
    }

    // Invoke Lambda for hibernate
    return await invokeHibernateLambda(resolvedId, user);
  } catch (error) {
    return buildHibernateErrorResponse(error);
  }
}
