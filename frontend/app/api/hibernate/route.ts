/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import {
  detachAndDeleteVolumes,
  executeSSMCommand,
  findInstanceId,
  getInstanceState,
  stopInstance,
  waitForInstanceStopped,
} from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    let instanceId: string | undefined;
    try {
      const body = await request.clone().json();
      instanceId = body?.instanceId;
    } catch {}

    const resolvedId = instanceId || (await findInstanceId());
    // Check current state
    const currentState = await getInstanceState(resolvedId);
    console.log("[HIBERNATE] Current state:", currentState);

    if (currentState === "hibernated") {
      return NextResponse.json({
        success: true,
        data: {
          message: "Server is already hibernated (stopped with no volumes)",
          instanceId: resolvedId,
          backupOutput: "Skipped - already hibernated",
        },
        timestamp: new Date().toISOString(),
      });
    }

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
    const backupCommand = "/usr/local/bin/mc-backup.sh";
    const backupOutput = await executeSSMCommand(resolvedId, [backupCommand]);
    console.log("[HIBERNATE] Step 1 complete: Backup finished");

    // Step 2: Stop the instance
    console.log("[HIBERNATE] Stopping server...");
    await stopInstance(resolvedId);
    console.log("[HIBERNATE] Waiting for server to stop...");
    await waitForInstanceStopped(resolvedId);
    console.log("[HIBERNATE] Step 2 complete: Instance stopped");

    // Step 3: Detach and delete volumes
    console.log("[HIBERNATE] Step 3: Detaching and deleting volumes...");
    await detachAndDeleteVolumes(resolvedId);
    console.log("[HIBERNATE] Step 3 complete: Volumes deleted");

    const response: ApiResponse<HibernateResponse> = {
      success: true,
      data: {
        message: "Server hibernated successfully (volumes deleted)",
        instanceId: resolvedId,
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
