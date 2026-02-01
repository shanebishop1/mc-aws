/**
 * POST /api/start
 * Starts the server, handling hibernation recovery if needed
 */

import { requireAllowed } from "@/lib/api-auth";
import {
  findInstanceId,
  getInstanceState,
  invokeLambda,
  withServerActionLock,
} from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  let user;
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
    return await withServerActionLock("start", async () => {
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
      
      // Determine if we are using Mock Mode
      const isMock = env.MC_BACKEND_MODE === "mock";

      if (isMock) {
        console.log("[START] Mock Mode: Invoking mock start directly (simulated async)");
        // In mock mode, we just call the provider's invokeLambda which will delegate to startInstance
        // This keeps the flow similar to production where we invoke "something"
        await invokeLambda("StartMinecraftServer", {
          invocationType: "api",
          command: "start",
          userEmail: user.email,
          instanceId: resolvedId,
        });

      } else {
         console.log("[START] Production Mode: Invoking Lambda asynchronously");
         // Invoke the Lambda function asynchronously (Event)
         // The Lambda will handle:
         // 1. Resume from hibernation (if needed)
         // 2. Start EC2
         // 3. Update DNS
         // 4. Clear the 'server-action' lock when done
         
         await invokeLambda("StartMinecraftServer", {
           invocationType: "api",
           command: "start",
           userEmail: user.email,
           instanceId: resolvedId,
         });
      }

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
    });
  } catch (error) {
    console.error("[START] Error:", error);
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
}
