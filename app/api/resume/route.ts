/**
 * POST /api/resume
 * Resume from hibernation: create EBS, start EC2, optionally restore from backup
 */

import { requireAdmin } from "@/lib/api-auth";
import {
  executeSSMCommand,
  findInstanceId,
  getInstanceState,
  getPublicIp,
  handleResume,
  startInstance,
  waitForInstanceRunning,
} from "@/lib/aws";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

const errorResponse = (message: string, status = 400): NextResponse<ApiResponse<ResumeResponse>> =>
  NextResponse.json({ success: false, error: message, timestamp: new Date().toISOString() }, { status });

const restoreFromBackup = async (instanceId: string, backupName: string): Promise<string | null> => {
  try {
    await executeSSMCommand(instanceId, [`/usr/local/bin/mc-restore.sh ${backupName}`]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Restore failed";
  }
};

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<ResumeResponse>>> {
  try {
    const authResult = await requireAdmin(request).catch((e) => e);
    if (authResult instanceof Response) {
      return authResult as NextResponse<ApiResponse<ResumeResponse>>;
    }
    console.log("[RESUME] Admin action by:", authResult.email);

    let instanceId: string | undefined;
    let backupName: string | undefined;
    try {
      const body = await request.json();
      backupName = body?.backupName;
      instanceId = body?.instanceId;
    } catch {
      // Empty body is fine
    }

    const resolvedId = instanceId || (await findInstanceId());
    const currentState = await getInstanceState(resolvedId);

    if (currentState === ServerState.Running) {
      return errorResponse("Server is already running");
    }
    if (currentState !== ServerState.Hibernating && currentState !== ServerState.Stopped) {
      return errorResponse(`Cannot resume from state: ${currentState}. Server must be hibernating or stopped.`);
    }

    await handleResume(resolvedId);
    await startInstance(resolvedId);
    await waitForInstanceRunning(resolvedId);
    const publicIp = await getPublicIp(resolvedId);
    await updateCloudflareDns(publicIp);

    if (backupName) {
      const restoreError = await restoreFromBackup(resolvedId, backupName);
      if (restoreError) {
        return errorResponse(`Server resumed but restore failed: ${restoreError}`, 500);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        instanceId: resolvedId,
        publicIp,
        domain: env.CLOUDFLARE_MC_DOMAIN,
        message: `Server resumed successfully. DNS updated to ${publicIp}${backupName ? ` and restored from ${backupName}` : ""}`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RESUME] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error", 500);
  }
}
