/**
 * GET /api/backups
 * List available backups from SSM cache, or trigger refresh via Lambda.
 */

import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { findInstanceId, getInstanceState, getParameter, invokeLambda } from "@/lib/aws";
import type { ApiResponse, BackupInfo, ListBackupsResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;
const BACKUPS_CACHE_PARAM = "/minecraft/backups-cache";
const PENDING_REFRESH_TTL_MS = 15 * 60_000;
const SAFE_REFRESH_ERROR =
  "Could not refresh backups from Google Drive. Check Drive API and OAuth configuration, then try again.";

type ReadyCache = { status: "ready"; backups: BackupInfo[]; cachedAt: number };
type PendingCache = {
  status: "pending";
  backups: BackupInfo[];
  startedAt: number;
  updatedAt: number;
  cachedAt?: number;
};
type FailedCache = {
  status: "failed";
  backups: BackupInfo[];
  startedAt: number;
  updatedAt: number;
  retryAt: number;
  cachedAt?: number;
};
type BackupsCache = ReadyCache | PendingCache | FailedCache;

function isBackupList(value: unknown): value is BackupInfo[] {
  return Array.isArray(value);
}

function parseBackupsCache(raw: string | null): BackupsCache | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isBackupList(parsed.backups)) return null;

    // Backward compatibility for the original untagged ready cache payload.
    if (parsed.status === undefined && typeof parsed.cachedAt === "number") {
      return { status: "ready", backups: parsed.backups, cachedAt: parsed.cachedAt };
    }
    if (parsed.status === "ready" && typeof parsed.cachedAt === "number") {
      return { status: "ready", backups: parsed.backups, cachedAt: parsed.cachedAt };
    }
    if (parsed.status === "pending" && typeof parsed.startedAt === "number" && typeof parsed.updatedAt === "number") {
      return {
        status: "pending",
        backups: parsed.backups,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : undefined,
      };
    }
    if (
      parsed.status === "failed" &&
      typeof parsed.startedAt === "number" &&
      typeof parsed.updatedAt === "number" &&
      typeof parsed.retryAt === "number"
    ) {
      return {
        status: "failed",
        backups: parsed.backups,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
        retryAt: parsed.retryAt,
        cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function cacheData(cache: BackupsCache | null): Pick<ListBackupsResponse, "backups" | "count" | "cachedAt"> {
  const backups = cache?.backups ?? [];
  return { backups, count: backups.length, cachedAt: cache?.cachedAt };
}

function cachingResponse(cache: BackupsCache | null): NextResponse<ApiResponse<ListBackupsResponse>> {
  return NextResponse.json(
    {
      success: true,
      data: { ...cacheData(cache), status: "caching" },
      timestamp: new Date().toISOString(),
    },
    { status: 202, headers: noStoreHeaders }
  );
}

function listingResponse(cache: BackupsCache): NextResponse<ApiResponse<ListBackupsResponse>> {
  return NextResponse.json(
    {
      success: true,
      data: { ...cacheData(cache), status: "listing" },
      timestamp: new Date().toISOString(),
    },
    { headers: noStoreHeaders }
  );
}

function failureResponse(cache: FailedCache): NextResponse<ApiResponse<ListBackupsResponse>> {
  return NextResponse.json(
    {
      success: true,
      data: {
        ...cacheData(cache),
        status: "error",
        errorMessage: SAFE_REFRESH_ERROR,
        retryAt: cache.retryAt,
      },
      timestamp: new Date().toISOString(),
    },
    { headers: noStoreHeaders }
  );
}

async function triggerRefresh(instanceId: string, userEmail: string): Promise<void> {
  await invokeLambda("StartMinecraftServer", {
    invocationType: "api",
    command: "refreshBackups",
    instanceId,
    userEmail,
  });
}

async function shouldRefreshReadyCache(explicitRefresh: boolean, instanceId: string): Promise<boolean> {
  if (!explicitRefresh) return false;
  const instanceState = await getInstanceState(instanceId);
  if (instanceState === ServerState.Hibernating) return false;
  return true;
}

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ListBackupsResponse>>> {
  try {
    const authResult = await requireAdmin(request).catch((error) => error);
    if (authResult instanceof Response) {
      return authResult as NextResponse<ApiResponse<ListBackupsResponse>>;
    }

    const url = new URL(request.url);
    const explicitRefresh = url.searchParams.get("refresh") === "true";
    const resolvedId = url.searchParams.get("instanceId") || (await findInstanceId());
    const cache = parseBackupsCache(await getParameter(BACKUPS_CACHE_PARAM));
    const now = Date.now();

    if (cache?.status === "pending" && now - cache.updatedAt < PENDING_REFRESH_TTL_MS) {
      return cache.backups.length > 0 ? listingResponse(cache) : cachingResponse(cache);
    }
    if (cache?.status === "failed" && now < cache.retryAt) {
      return failureResponse(cache);
    }
    if (cache?.status === "ready" && !(await shouldRefreshReadyCache(explicitRefresh, resolvedId))) {
      return listingResponse(cache);
    }

    await triggerRefresh(resolvedId, authResult.email);
    return cache && cache.backups.length > 0 ? listingResponse(cache) : cachingResponse(cache);
  } catch (error) {
    const response = formatApiErrorResponse<ListBackupsResponse>(error, "backups");
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
