/**
 * GET /api/service-status
 * Check if Minecraft service is active on the EC2 instance
 */

import { requireAllowed } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { executeSSMCommand, findInstanceId, getInstanceState } from "@/lib/aws";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import { snapshotCacheKeys, snapshotCacheTtlSeconds } from "@/lib/runtime-state/snapshot-cache";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface ServiceStatusResponse {
  serviceActive: boolean;
  instanceRunning: boolean;
}

const SERVICE_STATUS_RATE_LIMIT_WINDOW_MS = 60_000;
const SERVICE_STATUS_RATE_LIMIT_MAX_REQUESTS = 20;

type CachedServiceStatus = {
  payload: ApiResponse<ServiceStatusResponse>;
};

/**
 * Check if Minecraft service is active via SSM
 */
async function checkMinecraftService(instanceId: string): Promise<boolean> {
  try {
    console.log("[SERVICE-STATUS] Checking Minecraft service status on instance:", instanceId);
    const output = await executeSSMCommand(instanceId, ["systemctl is-active minecraft"]);
    const isActive = output.trim() === "active";
    console.log("[SERVICE-STATUS] Minecraft service active:", isActive);
    return isActive;
  } catch (error) {
    console.error("[SERVICE-STATUS] Failed to check Minecraft service:", error);
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
  } catch (error) {
    console.error("[SERVICE-STATUS] Failed to get instance state:", error);
    return false;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ServiceStatusResponse>>> {
  try {
    try {
      const user = await requireAllowed(request);
      console.log("[SERVICE-STATUS] Access by:", user.email, "role:", user.role);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<ServiceStatusResponse>>;
      }
      throw error;
    }

    const clientIp = getClientIp(request.headers);
    const rateLimit = await checkRateLimit({
      route: "/api/service-status",
      key: `service-status:${clientIp}`,
      limit: SERVICE_STATUS_RATE_LIMIT_MAX_REQUESTS,
      windowMs: SERVICE_STATUS_RATE_LIMIT_WINDOW_MS,
    });

    if (!rateLimit.allowed) {
      const response = NextResponse.json(
        {
          success: false,
          error: "Too many service status requests. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      response.headers.set("Cache-Control", "no-store");
      return response;
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
    console.log("[SERVICE-STATUS] Using instance ID:", instanceId);

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
