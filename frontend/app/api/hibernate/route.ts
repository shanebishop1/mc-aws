/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  executeSSMCommand,
  stopInstance,
  waitForInstanceStopped,
  detachAndDeleteVolumes,
  getInstanceState,
} from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { HibernateResponse, ApiResponse } from "@/lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    console.log("[HIBERNATE] Starting hibernation operation");

    // Check current state - must be running
    const currentState = await getInstanceState(env.INSTANCE_ID);
    console.log("[HIBERNATE] Current state:", currentState);

    if (currentState !== "running") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot hibernate when server is ${currentState}. Server must be running.`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Step 1: Run backup script
    console.log("[HIBERNATE] Step 1: Running backup before hibernation...");
    const backupCommand = `/usr/local/bin/mc-backup.sh`;
    const backupOutput = await executeSSMCommand(env.INSTANCE_ID, [backupCommand]);
    console.log("[HIBERNATE] Step 1 complete: Backup finished");

    // Step 2: Stop the instance
    console.log("[HIBERNATE] Step 2: Stopping instance...");
    await stopInstance(env.INSTANCE_ID);
    console.log("[HIBERNATE] Waiting for instance to stop...");
    await waitForInstanceStopped(env.INSTANCE_ID);
    console.log("[HIBERNATE] Step 2 complete: Instance stopped");

    // Step 3: Detach and delete volumes
    console.log("[HIBERNATE] Step 3: Detaching and deleting volumes...");
    await detachAndDeleteVolumes(env.INSTANCE_ID);
    console.log("[HIBERNATE] Step 3 complete: Volumes deleted");

    const response: ApiResponse<HibernateResponse> = {
      success: true,
      data: {
        message: "Hibernation completed successfully. Server backed up, stopped, and volume deleted.",
        backupOutput,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[HIBERNATE] Error:", error);
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
