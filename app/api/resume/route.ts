/**
 * POST /api/resume
 * Resume from hibernation -> Async Lambda
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface ResumeRequestBody {
  backupName?: string;
}

/**
 * Parse request body for resume endpoint
 */
async function parseResumeBody(request: NextRequest): Promise<ResumeRequestBody> {
  try {
    const body = await request.clone().json();
    return {
      backupName: body?.backupName,
    };
  } catch {
    return {};
  }
}

/**
 * Check if server is already running
 */
function checkAlreadyRunning(currentState: string): NextResponse<ApiResponse<ResumeResponse>> | null {
  if (currentState === ServerState.Running) {
    return NextResponse.json(
      {
        success: false,
        error: "Server is already running",
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
        timestamp: new Date().toISOString(),
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("[RESUME] Lambda invocation failed:", error);
    throw error;
  }
}

/**
 * Build error response for resume endpoint
 */
function buildResumeErrorResponse(error: unknown): NextResponse<ApiResponse<ResumeResponse>> {
  return formatApiErrorResponse<ResumeResponse>(error, "resume");
}

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  try {
    // Check admin authorization
    let user: AuthUser;
    try {
      user = await requireAdmin(request);
      console.log("[RESUME] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<ResumeResponse>>;
      }
      throw error;
    }

    // Parse body for optional backup name
    const { backupName } = await parseResumeBody(request);
    const resolvedId = await findInstanceId();

    // Check current state
    const currentState = await getInstanceState(resolvedId);

    // Check if already running
    const alreadyRunning = checkAlreadyRunning(currentState);
    if (alreadyRunning) {
      return alreadyRunning;
    }

    // Validate backup name (defense in depth)
    if (backupName) {
      sanitizeBackupName(backupName);
    }

    // Invoke Lambda for resume
    return await invokeResumeLambda(resolvedId, user, backupName);
  } catch (error) {
    return buildResumeErrorResponse(error);
  }
}
