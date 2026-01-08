/**
 * POST /api/start
 * Starts the server, handling hibernation recovery if needed
 */

import { NextRequest, NextResponse } from "next/server";
import {
  handleResume,
  startInstance,
  waitForInstanceRunning,
  getPublicIp,
  getInstanceState,
} from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { StartServerResponse, ApiResponse } from "@/lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  try {
    console.log("[START] Starting server instance:", env.INSTANCE_ID);

    // Check current state
    const currentState = await getInstanceState(env.INSTANCE_ID);
    console.log("[START] Current state:", currentState);

    // If running, just return current IP
    if (currentState === "running") {
      try {
        const publicIp = await getPublicIp(env.INSTANCE_ID);
        return NextResponse.json({
          success: true,
          data: {
            instanceId: env.INSTANCE_ID,
            publicIp,
            domain: env.CLOUDFLARE_MC_DOMAIN,
            message: "Server is already running",
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[START] Could not get public IP for running instance:", error);
      }
    }

    // Handle hibernation recovery (creates volume if needed)
    console.log("[START] Handling hibernation recovery...");
    await handleResume(env.INSTANCE_ID);

    // Start the instance
    console.log("[START] Sending start command...");
    await startInstance(env.INSTANCE_ID);

    // Wait for running state
    console.log("[START] Waiting for instance to reach running state...");
    await waitForInstanceRunning(env.INSTANCE_ID);

    // Get public IP
    console.log("[START] Waiting for public IP assignment...");
    const publicIp = await getPublicIp(env.INSTANCE_ID);

    // Update Cloudflare DNS
    console.log("[START] Updating Cloudflare DNS...");
    await updateCloudflareDns(publicIp);

    const response: ApiResponse<StartServerResponse> = {
      success: true,
      data: {
        instanceId: env.INSTANCE_ID,
        publicIp,
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: `Server started successfully. DNS updated to ${publicIp}`,
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
