/**
 * POST /api/resume
 * Resume from hibernation: create EBS, start EC2, optionally restore from backup
 * 
 * This route combines the /start logic with optional restore functionality.
 * The existing /api/start route already handles volume creation for hibernated instances.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  handleResume,
  startInstance,
  waitForInstanceRunning,
  getPublicIp,
  getInstanceState,
  executeSSMCommand,
} from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { ResumeResponse, ApiResponse } from "@/lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  try {
    console.log("[RESUME] Starting resume operation");

    // Parse request body for optional backup name
    let backupName: string | undefined;
    try {
      const body = await request.json();
      backupName = body?.backupName;
    } catch {
      // Empty or invalid body is fine
    }

    // Check current state
    const currentState = await getInstanceState(env.INSTANCE_ID);
    console.log("[RESUME] Current state:", currentState);

    if (currentState === "running") {
      // Already running, just return current IP
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
        console.warn("[RESUME] Could not get public IP for running instance:", error);
      }
    }

    if (currentState !== "hibernated" && currentState !== "stopped") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot resume from state: ${currentState}. Server must be hibernated or stopped.`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Handle hibernation recovery (creates volume if needed)
    console.log("[RESUME] Handling hibernation recovery...");
    await handleResume(env.INSTANCE_ID);

    // Start the instance
    console.log("[RESUME] Sending start command...");
    await startInstance(env.INSTANCE_ID);

    // Wait for running state
    console.log("[RESUME] Waiting for instance to reach running state...");
    await waitForInstanceRunning(env.INSTANCE_ID);

    // Get public IP
    console.log("[RESUME] Waiting for public IP assignment...");
    const publicIp = await getPublicIp(env.INSTANCE_ID);

    // Update Cloudflare DNS
    console.log("[RESUME] Updating Cloudflare DNS...");
    await updateCloudflareDns(publicIp);

    // If backup name provided, run restore
    if (backupName) {
      console.log("[RESUME] Restoring from backup:", backupName);
      const restoreCommand = `/usr/local/bin/mc-restore.sh ${backupName}`;
      try {
        await executeSSMCommand(env.INSTANCE_ID, [restoreCommand]);
        console.log("[RESUME] Restore completed");
      } catch (error) {
        console.error("[RESUME] Restore failed:", error);
        // Don't fail the whole operation - server is running, just restore failed
        const errorMessage = error instanceof Error ? error.message : "Restore failed";
        return NextResponse.json(
          {
            success: false,
            error: `Server resumed and ready, but restore failed: ${errorMessage}`,
            timestamp: new Date().toISOString(),
          },
          { status: 500 }
        );
      }
    }

    const response: ApiResponse<ResumeResponse> = {
      success: true,
      data: {
        instanceId: env.INSTANCE_ID,
        publicIp,
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: `Server resumed successfully. DNS updated to ${publicIp}${backupName ? ` and restored from backup ${backupName}` : ""}`,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[RESUME] Error:", error);
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
