/**
 * GET /api/service-status
 * Check if Minecraft service is active on the EC2 instance
 */

import { requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getMinecraftServiceStatus } from "@/lib/aws";
import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import { snapshotCacheKeys, snapshotCacheTtlSeconds } from "@/lib/runtime-state/snapshot-cache";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface ServiceStatusResponse {
  serviceActive: boolean;
  instanceRunning: boolean;
}

type CachedServiceStatus = {
  payload: ApiResponse<ServiceStatusResponse>;
};

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServiceStatusResponse>>> {
  try {
    try {
      await requireAllowed(request);
      console.log("[SERVICE-STATUS] Authorized service-status read requested");
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<ServiceStatusResponse>>;
      }
      throw error;
    }

    const runtimeStateAdapter = getRuntimeStateAdapter();
    const cachedSnapshotResult = await runtimeStateAdapter.getSnapshot<CachedServiceStatus>({
      key: snapshotCacheKeys.serviceStatus,
    });

    if (cachedSnapshotResult.ok && cachedSnapshotResult.data.status === "hit") {
      const response = NextResponse.json(cachedSnapshotResult.data.value.payload);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Service-Status-Cache", "HIT");
      return response;
    }

    console.log("[SERVICE-STATUS] Starting service status check");

    console.log("[SERVICE-STATUS] Requesting sanitized managed service status");
    const status = await getMinecraftServiceStatus();

    const payload: ApiResponse<ServiceStatusResponse> = {
      success: true,
      data: {
        serviceActive: status.serviceActive,
        instanceRunning: status.instanceRunning,
      },
      timestamp: new Date().toISOString(),
    };

    await runtimeStateAdapter.setSnapshot({
      key: snapshotCacheKeys.serviceStatus,
      value: {
        payload,
      },
      ttlSeconds: snapshotCacheTtlSeconds.serviceStatus,
    });

    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Service-Status-Cache", "MISS");
    return response;
  } catch (error) {
    return formatApiErrorResponse<ServiceStatusResponse>(error, "status", "Failed to fetch service status");
  }
}
