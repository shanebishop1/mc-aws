/**
 * GET /api/service-status
 * Check if Minecraft service is active on the EC2 instance
 */

import { requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState } from "@/lib/aws";
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

/**
 * Check if Minecraft service is active via SSM
 */
async function checkMinecraftService(instanceId: string): Promise<boolean> {
  try {
    console.log("[SERVICE-STATUS] Checking Minecraft service status");
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const isActive = output.trim() === "active";
    console.log("[SERVICE-STATUS] Minecraft service active:", isActive);
    return isActive;
  } catch {
    console.error("[SERVICE-STATUS] Failed to check Minecraft service");
    return false;
  }
}

/**
 * Check if EC2 instance is running
 */
async function checkInstanceRunning(instanceId: string): Promise<boolean> {
  try {
    const state = await getInstanceState(instanceId);
    const isRunning = state === "running";
    console.log("[SERVICE-STATUS] Instance state:", state, "- Running:", isRunning);
    return isRunning;
  } catch {
    console.error("[SERVICE-STATUS] Failed to get instance state");
    return false;
  }
}

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

    // Get instance ID
    const instanceId = await findInstanceId();
    console.log("[SERVICE-STATUS] Using managed instance");

    // Check instance state first
    const instanceRunning = await checkInstanceRunning(instanceId);

    // Only check service if instance is running
    let serviceActive = false;
    if (instanceRunning) {
      serviceActive = await checkMinecraftService(instanceId);
    } else {
      console.log("[SERVICE-STATUS] Instance not running, skipping service check");
    }

    const payload: ApiResponse<ServiceStatusResponse> = {
      success: true,
      data: {
        serviceActive,
        instanceRunning,
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
