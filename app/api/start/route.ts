/**
 * POST /api/start
 * Starts the server asynchronously (fire-and-forget)
 * Sets the server-action lock, invokes the Lambda, and returns immediately
 * The Lambda is responsible for clearing the lock when complete
 */

import { type AuthUser, requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, invokeLambda } from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  let user: AuthUser;
  try {
    user = await requireAllowed(request);
    console.log("[START] Action by:", user.email, "role:", user.role);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<StartServerResponse>>;
    }
    throw error;
  }

  try {
    // Always resolve instance ID server-side - do not trust caller input
    const resolvedId = await findInstanceId();
    console.log("[START] Starting server instance:", resolvedId);

    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[START] Current state:", currentState);

    // If running, return error (per requirement)
    if (currentState === "running") {
      return NextResponse.json(
        {
          success: false,
          error: "Server is already running",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Invoke the Lambda function asynchronously
    try {
      console.log("[START] Invoking StartMinecraftServer Lambda");
      await invokeLambda("StartMinecraftServer", {
        invocationType: "api",
        command: "start",
        userEmail: user.email,
        instanceId: resolvedId,
      });

      // Return immediately with pending status (fire-and-forget)
      const response: ApiResponse<StartServerResponse> = {
        success: true,
        data: {
          instanceId: resolvedId,
          domain: env.CLOUDFLARE_MC_DOMAIN,
          message: "Server start initiated. This may take 1-2 minutes.",
        },
        timestamp: new Date().toISOString(),
      };

      return NextResponse.json(response);
    } catch (error) {
      console.error("[START] Lambda invocation failed:", error);
      throw error;
    }
  } catch (error) {
    return formatApiErrorResponse<StartServerResponse>(error, "start");
  }
}
