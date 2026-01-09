/**
 * GET /api/aws-config
 * Returns AWS configuration for constructing console URLs
 */

import { findInstanceId } from "@/lib/aws-client";
import { env } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface AwsConfigResponse {
  region: string | null;
  instanceId: string | null;
  ec2ConsoleUrl: string | null;
}

export async function GET(_request: NextRequest): Promise<NextResponse<ApiResponse<AwsConfigResponse>>> {
  try {
    const { AWS_REGION } = env;
    console.log("[CONFIG] Fetching AWS configuration");

    // Get instance ID dynamically (same way other API routes do)
    let instanceId: string | null = null;
    try {
      instanceId = await findInstanceId();
    } catch (error) {
      console.warn("[CONFIG] Could not find instance ID:", error);
      // Silently fail - link is optional
    }

    // Construct EC2 instance URL if we have all the needed info
    let ec2ConsoleUrl: string | null = null;
    if (AWS_REGION && instanceId) {
      ec2ConsoleUrl = `https://${AWS_REGION}.console.aws.amazon.com/ec2/home?region=${AWS_REGION}#InstanceDetails:instanceId=${instanceId}`;
    }

    return NextResponse.json({
      success: true,
      data: {
        region: AWS_REGION || null,
        instanceId,
        ec2ConsoleUrl,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CONFIG] Error:", error);
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
