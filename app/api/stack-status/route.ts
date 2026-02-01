/**
 * GET /api/stack-status
 * Returns the status of the CloudFormation stack
 */

import { getAuthUser } from "@/lib/api-auth";
import { getStackStatus } from "@/lib/aws";
import type { ApiResponse, StackStatusResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<StackStatusResponse>>> {
  const user = await getAuthUser(request);
  console.log("[STACK-STATUS] Access by:", user?.email ?? "anonymous");

  try {
    console.log("[STACK-STATUS] Checking CloudFormation stack status");
    const stack = await getStackStatus("MinecraftStack");

    if (stack) {
      return NextResponse.json(
        {
          success: true,
          data: {
            exists: true,
            status: stack.StackStatus,
            stackId: stack.StackId,
          },
          timestamp: new Date().toISOString(),
        },
        { headers: noStoreHeaders }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          exists: false,
        },
        timestamp: new Date().toISOString(),
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    console.error("[STACK-STATUS] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
