/**
 * POST /api/start
 * Starts the server, handling hibernation recovery if needed
 */

import {
  findInstanceId,
  getInstanceState,
  getPublicIp,
  handleResume,
  startInstance,
  waitForInstanceRunning,
} from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<StartServerResponse>>> {
  try {
    // Try to get ID from body to avoid discovery overhead
    let instanceId: string | undefined;
    try {
      const body = await request.clone().json(); // clone because we might read it again? No, usually nextjs consumes stream.
      // Wait, if I read body here, I can't read it later?
      // Actually Start route doesn't use body for anything else.
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

    // Handle hibernation recovery (creates volume if needed)
    console.log("[START] Handling hibernation recovery...");
    await handleResume(resolvedId);

    // Start the instance
    console.log("[START] Sending start command...");
    await startInstance(resolvedId);

    // Wait for running state
    console.log("[START] Waiting for instance to reach running state...");
    await waitForInstanceRunning(resolvedId);

    // Get public IP
    console.log("[START] Waiting for public IP assignment...");
    const publicIp = await getPublicIp(resolvedId);

    // Update Cloudflare DNS
    console.log("[START] Updating Cloudflare DNS...");
    await updateCloudflareDns(publicIp);

    const response: ApiResponse<StartServerResponse> = {
      success: true,
      data: {
        instanceId: resolvedId,
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
