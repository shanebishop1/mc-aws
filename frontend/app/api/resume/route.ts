/**
 * POST /api/resume
 * Resume from hibernation: create EBS, start EC2, optionally restore from backup
 *
 * This route combines the /start logic with optional restore functionality.
 * The existing /api/start route already handles volume creation for hibernated instances.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  handleResume,
  startInstance,
  waitForInstanceRunning,
  getPublicIp,
  getInstanceState,
  executeSSMCommand,
  findInstanceId,
} from "@/lib/aws-client";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { ResumeResponse, ApiResponse } from "@/lib/types";

async function handleAlreadyRunning(resolvedId: string): Promise<NextResponse<ApiResponse<ResumeResponse>> | null> {
  try {
    const publicIp = await getPublicIp(resolvedId);
    return NextResponse.json({
      success: true,
      data: {
        instanceId: resolvedId,
        publicIp,
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: "Server is already running",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[RESUME] Could not get public IP for running instance:", error);
    return null;
  }
}

async function validateInstanceState(currentState: string): Promise<NextResponse<ApiResponse<ResumeResponse>> | null> {
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
  return null;
}

async function restoreFromBackup(
  resolvedId: string,
  backupName: string
): Promise<NextResponse<ApiResponse<ResumeResponse>> | null> {
  const restoreCommand = `/usr/local/bin/mc-restore.sh ${backupName}`;
  try {
    await executeSSMCommand(resolvedId, [restoreCommand]);
    console.log("[RESUME] Restore completed");
    return null;
  } catch (error) {
    console.error("[RESUME] Restore failed:", error);
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

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  try {
    let instanceId: string | undefined;
    let backupName: string | undefined;

    try {
      const body = await request.json();
      backupName = body?.backupName;
      instanceId = body?.instanceId;
    } catch {
      // Empty or invalid body is fine
    }

    const resolvedId = instanceId || (await findInstanceId());
    console.log("[RESUME] Starting resume operation for instance:", resolvedId);

    const currentState = await getInstanceState(resolvedId);
    console.log("[RESUME] Current state:", currentState);

    if (currentState === "running") {
      const response = await handleAlreadyRunning(resolvedId);
      if (response) return response;
    }

    const validationResponse = await validateInstanceState(currentState);
    if (validationResponse) return validationResponse;

    console.log("[RESUME] Handling hibernation recovery...");
    await handleResume(resolvedId);

    console.log("[RESUME] Sending start command...");
    await startInstance(resolvedId);

    console.log("[RESUME] Waiting for instance to reach running state...");
    await waitForInstanceRunning(resolvedId);

    console.log("[RESUME] Waiting for public IP assignment...");
    const publicIp = await getPublicIp(resolvedId);

    console.log("[RESUME] Updating Cloudflare DNS...");
    await updateCloudflareDns(publicIp);

    if (backupName) {
      console.log("[RESUME] Restoring from backup:", backupName);
      const restoreResponse = await restoreFromBackup(resolvedId, backupName);
      if (restoreResponse) return restoreResponse;
    }

    const response: ApiResponse<ResumeResponse> = {
      success: true,
      data: {
        instanceId: resolvedId,
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
