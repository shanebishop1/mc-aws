/**
 * GET /api/service-status
 * Check if Minecraft service is active on the EC2 instance
 */

import { executeSSMCommand, findInstanceId, getInstanceState } from "@/lib/aws";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface ServiceStatusResponse {
  serviceActive: boolean;
  instanceRunning: boolean;
}

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

export async function GET(): Promise<NextResponse<ApiResponse<ServiceStatusResponse>>> {
  try {
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

    return NextResponse.json({
      success: true,
      data: {
        serviceActive,
        instanceRunning,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[SERVICE-STATUS] Error:", error);
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
