/**
 * GET /api/backups
 * List available Google Drive backups
 */

import { findInstanceId, getInstanceState, listBackups } from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ApiResponse, ListBackupsResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<ListBackupsResponse>>> {
  try {
    console.log("[BACKUPS] Listing available backups");

    // 1. Get instance ID (either from env or discovery)
    const instanceId = env.INSTANCE_ID || (await findInstanceId());

    // 2. Check instance state - must be running to run rclone command via SSM
    const currentState = await getInstanceState(instanceId);
    console.log("[BACKUPS] Current instance state:", currentState);

    if (currentState !== "running") {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot list backups when server is ${currentState}. Server must be running to access Google Drive.`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // 3. Fetch list of backups from Google Drive via EC2/SSM
    const backups = await listBackups(instanceId);

    const response: ApiResponse<ListBackupsResponse> = {
      success: true,
      data: {
        backups,
        count: backups.length,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[BACKUPS] Error:", error);
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
