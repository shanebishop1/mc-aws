/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { NextRequest, NextResponse } from "next/server";
import { executeSSMCommand, getInstanceState, getPublicIp } from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { RestoreResponse, ApiResponse } from "@/lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  try {
    console.log("[RESTORE] Starting restore operation");

    // Parse request body
    const body = await request.json();
    const backupName = body?.name;

    if (!backupName) {
      return NextResponse.json(
        {
          success: false,
          error: "Backup name is required",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Check current state - must be running
    const currentState = await getInstanceState(env.INSTANCE_ID);
    console.log("[RESTORE] Current state:", currentState);

    if (currentState !== "running") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot restore when server is ${currentState}. Server must be running.`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Execute restore command
    const command = `/usr/local/bin/mc-restore.sh ${backupName}`;
    console.log("[RESTORE] Executing command:", command);
    const output = await executeSSMCommand(env.INSTANCE_ID, [command]);

    // Update DNS (in case IP changed or wasn't set)
    let publicIp: string | undefined;
    try {
      console.log("[RESTORE] Getting public IP...");
      publicIp = await getPublicIp(env.INSTANCE_ID);
      console.log("[RESTORE] Updating Cloudflare DNS...");
      await updateCloudflareDns(publicIp);
    } catch (error) {
      console.warn("[RESTORE] Could not update DNS:", error);
      // Continue without DNS update
    }

    const response: ApiResponse<RestoreResponse> = {
      success: true,
      data: {
        backupName,
        publicIp,
        message: `Restore completed successfully (${backupName})${publicIp ? `\nDNS updated to ${publicIp}` : ""}`,
        output,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[RESTORE] Error:", error);
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
