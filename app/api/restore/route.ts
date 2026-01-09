/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { executeSSMCommand, findInstanceId, getInstanceState, getPublicIp } from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { ApiResponse, RestoreRequest, RestoreResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(request);
      console.log("[RESTORE] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<RestoreResponse>>;
      }
      throw error;
    }

    // Parse request body
    const body: RestoreRequest = await request.json();
    const backupName = body.backupName || body.name;
    const instanceId = body.instanceId;

    const resolvedId = instanceId || (await findInstanceId());
    console.log("[RESTORE] Starting restore operation for instance:", resolvedId);

    // Check current state - must be running
    const currentState = await getInstanceState(resolvedId);
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
    const command = backupName ? `/usr/local/bin/mc-restore.sh ${backupName}` : "/usr/local/bin/mc-restore.sh";
    console.log("[RESTORE] Executing command:", command);
    const output = await executeSSMCommand(resolvedId, [command]);

    // Extract actual backup name used from output if it wasn't provided
    let actualBackupName = backupName || "unknown";
    if (!backupName) {
      const match = output.match(/Found latest backup: (.*)/) || output.match(/SUCCESS: Restored from (.*)\.tar\.gz/);
      if (match) {
        actualBackupName = match[1].trim();
      }
    }

    // Update DNS (in case IP changed or wasn't set)
    let publicIp: string | undefined;
    try {
      console.log("[RESTORE] Getting public IP...");
      publicIp = await getPublicIp(resolvedId);
      console.log("[RESTORE] Updating Cloudflare DNS...");
      await updateCloudflareDns(publicIp);
    } catch (error) {
      console.warn("[RESTORE] Could not update DNS:", error);
      // Continue without DNS update
    }

    const response: ApiResponse<RestoreResponse> = {
      success: true,
      data: {
        backupName: actualBackupName,
        publicIp,
        message: `Restore completed successfully (${actualBackupName})${publicIp ? `\nDNS updated to ${publicIp}` : ""}`,
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
