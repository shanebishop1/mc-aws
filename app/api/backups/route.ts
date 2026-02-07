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

const BACKUPS_CACHE_PARAM = "/minecraft/backups-cache";
const AUTO_REFRESH_CACHE_AGE_MS = 60_000; // Keep cache fresh-ish without blocking on rclone/SSM

type BackupsCachePayload = {
  backups: unknown;
  cachedAt?: unknown;
};

function parseBackupsCache(raw: string): { backups: ListBackupsResponse["backups"]; cachedAt?: number } | null {
  try {
    const parsed = JSON.parse(raw) as BackupsCachePayload;
    if (!parsed || !Array.isArray(parsed.backups)) return null;

    const cachedAt = typeof parsed.cachedAt === "number" ? parsed.cachedAt : undefined;
    return { backups: parsed.backups as ListBackupsResponse["backups"], cachedAt };
  } catch {
    return null;
  }
}

async function triggerRefresh(instanceId: string, userEmail: string): Promise<void> {
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "refreshBackups",
    instanceId,
    userEmail,
  });
}

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

    const cachedRaw = await getParameter(BACKUPS_CACHE_PARAM);
    const cached = cachedRaw ? parseBackupsCache(cachedRaw) : null;

    const cacheAgeMs = cached?.cachedAt ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY;
    const shouldAutoRefresh = cacheAgeMs > AUTO_REFRESH_CACHE_AGE_MS;

    if (shouldRefresh || !cached || shouldAutoRefresh) {
      console.log(
        "[BACKUPS] Triggering refresh:",
        JSON.stringify({
          requestedBy: authResult.email,
          shouldRefresh,
          hasCache: Boolean(cached),
          cacheAgeMs: Number.isFinite(cacheAgeMs) ? cacheAgeMs : null,
        })
      );

      await triggerRefresh(resolvedId, authResult.email);

      return NextResponse.json(
        {
          success: true,
          data: {
            backups: cached?.backups ?? [],
            count: cached?.backups?.length ?? 0,
            cachedAt: cached?.cachedAt,
            status: "caching",
          },
          timestamp: new Date().toISOString(),
        },
        { status: 202, headers: noStoreHeaders }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          backups: cached.backups,
          count: cached.backups.length,
          cachedAt: cached.cachedAt,
          status: "listing",
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
