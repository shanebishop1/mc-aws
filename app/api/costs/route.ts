import { getCosts } from "@/lib/aws-client";
import type { ApiResponse, CostData } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

// Permanent in-memory cache (until server restart or manual refresh)
let cachedCosts: { data: CostData; timestamp: number } | null = null;

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<CostData & { cachedAt?: number }>>> {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";

    // Return cached data if exists and not forcing refresh
    if (cachedCosts && !forceRefresh) {
      console.log("[COSTS] Returning cached cost data");
      return NextResponse.json({
        success: true,
        data: {
          ...cachedCosts.data,
          cachedAt: cachedCosts.timestamp,
        },
        timestamp: new Date().toISOString(),
      });
    }

    console.log("[COSTS] Fetching fresh cost data from AWS");
    const data = await getCosts();
    const timestamp = Date.now();

    // Update cache
    cachedCosts = { data, timestamp };

    return NextResponse.json({
      success: true,
      data: {
        ...data,
        cachedAt: timestamp,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[COSTS] Failed to get costs:", error);
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
