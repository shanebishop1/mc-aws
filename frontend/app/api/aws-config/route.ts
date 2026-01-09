/**
 * GET /api/aws-config
 * Returns AWS configuration for constructing console URLs
 */

import { findInstanceId } from "@/lib/aws-client";
import { env } from "@/lib/env";
import { NextResponse } from "next/server";

export async function GET() {
  const { AWS_REGION } = env;

  // Get instance ID dynamically (same way other API routes do)
  let instanceId: string | null = null;
  try {
    instanceId = await findInstanceId();
  } catch {
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
}
