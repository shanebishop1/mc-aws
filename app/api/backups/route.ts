/**
 * GET /api/backups
 * List available backups
 */

import { requireAdmin } from "@/lib/api-auth";
import { listBackups } from "@/lib/aws";
import type { ApiResponse, ListBackupsResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ListBackupsResponse>>> {
  try {
    const authResult = await requireAdmin(request).catch((e) => e);
    if (authResult instanceof Response) {
      return authResult as NextResponse<ApiResponse<ListBackupsResponse>>;
    }
    console.log("[BACKUPS] Admin action by:", authResult.email);

    const url = new URL(request.url);
    const instanceId = url.searchParams.get("instanceId") ?? undefined;
    const backups = await listBackups(instanceId);

    return NextResponse.json(
      {
        success: true,
        data: {
          backups,
          count: backups.length,
        },
        timestamp: new Date().toISOString(),
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    console.error("[BACKUPS] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
