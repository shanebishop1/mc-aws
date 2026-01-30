/**
 * POST /api/restore
 * Execute restore via SSM with selected backup name
 */

import { requireAdmin } from "@/lib/api-auth";
import { executeSSMCommand, findInstanceId, getInstanceState, getPublicIp, withServerActionLock } from "@/lib/aws";
import { updateCloudflareDns } from "@/lib/cloudflare";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { ApiResponse, RestoreRequest, RestoreResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

const parseBackupName = (output: string, providedName?: string): string => {
  if (providedName) return providedName;
  const match = output.match(/Found latest backup: (.*)/) || output.match(/SUCCESS: Restored from (.*)\.tar\.gz/);
  return match ? match[1].trim() : "unknown";
};

const updateDnsAfterRestore = async (instanceId: string): Promise<string | undefined> => {
  try {
    const publicIp = await getPublicIp(instanceId);
    await updateCloudflareDns(publicIp);
    return publicIp;
  } catch (error) {
    console.warn("[RESTORE] Could not update DNS:", error);
    return undefined;
  }
};

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<RestoreResponse>>> {
  try {
    // Check admin authorization
    const authResult = await requireAdmin(request).catch((e) => e);
    if (authResult instanceof Response) {
      return authResult as NextResponse<ApiResponse<RestoreResponse>>;
    }
    console.log("[RESTORE] Admin action by:", authResult.email);

    const body: RestoreRequest = await request.json();
    const backupName = body.backupName || body.name;
    const resolvedId = body.instanceId || (await findInstanceId());

    return await withServerActionLock("restore", async () => {
      const currentState = await getInstanceState(resolvedId);
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

      // Sanitize backup name to prevent command injection
      const sanitizedName = backupName ? sanitizeBackupName(backupName) : undefined;
      const command = sanitizedName ? `/usr/local/bin/mc-restore.sh ${sanitizedName}` : "/usr/local/bin/mc-restore.sh";
      const output = await executeSSMCommand(resolvedId, [command]);
      const actualBackupName = parseBackupName(output, backupName);
      const publicIp = await updateDnsAfterRestore(resolvedId);

      return NextResponse.json({
        success: true,
        data: {
          backupName: actualBackupName,
          publicIp,
          message: `Restore completed successfully (${actualBackupName})${publicIp ? `\nDNS updated to ${publicIp}` : ""}`,
          output,
        },
        timestamp: new Date().toISOString(),
      });
    });
  } catch (error) {
    console.error("[RESTORE] Error:", error);
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
