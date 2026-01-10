/**
 * GET /api/stack-status
 * Returns the status of the CloudFormation stack
 */

import { getAuthUser } from "@/lib/api-auth";
import { getStackStatus } from "@/lib/aws/cloudformation-client";
import type { ApiResponse, StackStatusResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<StackStatusResponse>>> {
  const user = getAuthUser(request);
  console.log("[STACK-STATUS] Access by:", user?.email ?? "anonymous");

  try {
    console.log("[STACK-STATUS] Checking CloudFormation stack status");
    const stack = await getStackStatus("MinecraftStack");

    if (stack) {
      return NextResponse.json({
        success: true,
        data: {
          exists: true,
          status: stack.StackStatus,
          stackId: stack.StackId,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        exists: false,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[STACK-STATUS] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: true, // We still return success: true because the request itself succeeded, but the data indicates the error
        data: {
          exists: false,
          error: errorMessage,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}
