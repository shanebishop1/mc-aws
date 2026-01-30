/**
 * POST /api/hibernate
 * Full hibernation: backup, stop EC2, delete EBS volume (zero cost mode)
 */

import { requireAdmin } from "@/lib/api-auth";
import {
  detachAndDeleteVolumes,
  executeSSMCommand,
  findInstanceId,
  getInstanceState,
  stopInstance,
  waitForInstanceStopped,
  withServerActionLock,
} from "@/lib/aws";
import { env } from "@/lib/env";
import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<HibernateResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request);
      console.log("[HIBERNATE] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<HibernateResponse>>;
      }
      throw error;
    }

    return await withServerActionLock("hibernate", async () => {
      let instanceId: string | undefined;
      try {
        const body = await request.clone().json();
        instanceId = body?.instanceId;
      } catch {}

      const resolvedId = instanceId || (await findInstanceId());
      // Check current state
      const currentState = await getInstanceState(resolvedId);
      console.log("[HIBERNATE] Current state:", currentState);

      if (currentState === ServerState.Hibernating) {
        return NextResponse.json({
          success: true,
          data: {
            message: "Server is already hibernating (stopped with no volumes)",
            instanceId: resolvedId,
            backupOutput: "Skipped - already hibernating",
          },
          timestamp: new Date().toISOString(),
        });
      }

      if (currentState !== ServerState.Running) {
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
          message: "Server hibernating successfully (volumes deleted)",
          instanceId: resolvedId,
          backupOutput,
        },
        timestamp: new Date().toISOString(),
      };

      return NextResponse.json(response);
    });
  } catch (error) {
    console.error("[HIBERNATE] Error:", error);
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
