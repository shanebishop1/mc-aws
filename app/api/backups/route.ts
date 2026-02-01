/**
 * GET /api/backups
 * List available backups from SSM cache, or trigger refresh via Lambda
 */

import { requireAdmin } from "@/lib/api-auth";
import { findInstanceId, getParameter, invokeLambda } from "@/lib/aws";
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

    const url = new URL(request.url);
    const shouldRefresh = url.searchParams.get("refresh") === "true";
    const instanceId = url.searchParams.get("instanceId"); // Optional

    const resolvedId = instanceId || (await findInstanceId());

    // If refresh requested, trigger Lambda and return 202
    if (shouldRefresh) {
        console.log("[BACKUPS] Refresh requested by:", authResult.email);
        await invokeLambda("StartMinecraftServer", {
            invocationType: "api",
            command: "refreshBackups",
            instanceId: resolvedId,
            userEmail: authResult.email
        });
        
        return NextResponse.json(
            {
                success: true,
                data: {
                    backups: [],
                    count: 0,
                    status: "caching"
                },
                timestamp: new Date().toISOString(),
                // Add message to standard response structure? 
                // Currently ApiResponse doesn't have message at top level usually, 
                // but ListBackupsResponse data doesn't have message either.
                // Front end assumes data has backups.
                // We return empty backups + caching status.
            },
            { status: 202, headers: noStoreHeaders }
        );
    }
    
    // Try to read from cache
    const cached = await getParameter("/minecraft/backups-cache");
    if (cached) {
        try {
            const data = JSON.parse(cached);
            // Verify structure
            if (Array.isArray(data.backups)) {
                return NextResponse.json(
                    {
                        success: true,
                        data: {
                            backups: data.backups,
                            count: data.backups.length,
                            cachedAt: data.cachedAt,
                            status: "listing"
                        },
                        timestamp: new Date().toISOString()
                    },
                    { headers: noStoreHeaders }
                );
            }
        } catch (e) {
            console.warn("[BACKUPS] Invalid cache format:", e);
        }
    }

    // No valid cache found, trigger auto-refresh
    console.log("[BACKUPS] Cache missing or invalid, triggering auto-refresh");
    await invokeLambda("StartMinecraftServer", {
        invocationType: "api",
        command: "refreshBackups", // Make sure this matches Lambda handler
        instanceId: resolvedId,
        userEmail: authResult.email
    });
    
    return NextResponse.json(
        {
            success: true,
            data: {
                backups: [],
                count: 0,
                status: "caching"
            },
            timestamp: new Date().toISOString()
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
