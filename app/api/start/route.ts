/**
 * POST /api/start
 * Starts the server asynchronously (fire-and-forget)
 * Sets the server-action lock, invokes the Lambda, and returns immediately
 * The Lambda is responsible for clearing the lock when complete
 */

import type { AuthUser } from "@/lib/api-auth";
import { requireAllowed } from "@/lib/api-auth";
import { findInstanceId, getInstanceState, getServerAction, invokeLambda, setServerAction } from "@/lib/aws";
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
    // Check if an action is already in progress
    const currentAction = await getServerAction();
    if (currentAction) {
      console.log("[START] Another operation in progress:", currentAction.action);
      return NextResponse.json(
        {
          success: false,
          error: `Cannot start server. Another operation is in progress: ${currentAction.action}`,
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }

    // Try to get ID from body to avoid discovery overhead
    let instanceId: string | undefined;
    try {
      const body = await request.json();
      instanceId = body?.instanceId;
    } catch {
      // Body parsing failed or empty
    }

    const resolvedId = instanceId || (await findInstanceId());
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

    // Set the server-action lock before invoking Lambda
    // The Lambda will clear this lock when it completes
    await setServerAction("start");
    console.log("[START] Server-action lock set");

    // Invoke the Lambda function asynchronously
    // The Lambda will handle:
    // 1. Resume from hibernation (if needed)
    // 2. Start EC2
    // 3. Update DNS
    // 4. Clear the 'server-action' lock when done
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
        publicIp: "pending", // IP is not known yet
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: "Server start initiated. This may take 1-2 minutes.",
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[START] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
