/**
 * POST /api/backup
 * Execute backup via SSM with optional custom name
 */

import { executeSSMCommand, findInstanceId, getInstanceState } from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ApiResponse, BackupResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<BackupResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(request);
      console.log("[BACKUP] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<BackupResponse>>;
      }
      throw error;
    }

    let instanceId: string | undefined;
    let backupName: string | undefined;

    try {
      const body = await request.json();
      backupName = body?.name;
      instanceId = body?.instanceId;
    } catch {
      // Empty or invalid body is fine, provided they are undefined
    }

    const resolvedId = instanceId || (await findInstanceId());
    console.log("[BACKUP] Starting backup operation for instance:", resolvedId);

    // Check current state - must be running
    const currentState = await getInstanceState(resolvedId);
    console.log("[BACKUP] Current state:", currentState);

    if (currentState !== "running") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot backup when server is ${currentState}. Server must be running.`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Build backup command
    const command = backupName ? `/usr/local/bin/mc-backup.sh ${backupName}` : "/usr/local/bin/mc-backup.sh";

    console.log("[BACKUP] Executing command:", command);
    const output = await executeSSMCommand(resolvedId, [command]);

    const response: ApiResponse<BackupResponse> = {
      success: true,
      data: {
        backupName,
        message: `Backup completed successfully${backupName ? ` (${backupName})` : ""}`,
        output,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[BACKUP] Error:", error);
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
