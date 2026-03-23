import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getCosts } from "@/lib/aws";
import { isMockMode } from "@/lib/env";
import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import { snapshotCacheKeys } from "@/lib/runtime-state/snapshot-cache";
import type { ApiResponse, CostData } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

type CachedCostsSnapshot = {
  data: CostData;
  timestamp: number;
};

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<CostData & { cachedAt?: number }>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request);
      console.log("[COSTS] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<CostData & { cachedAt?: number }>>;
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";
    const skipCache = isMockMode();
    const runtimeStateAdapter = getRuntimeStateAdapter();

    // Return cached data if exists and not forcing refresh
    if (!forceRefresh && !skipCache) {
      const cachedSnapshotResult = await runtimeStateAdapter.getSnapshot<CachedCostsSnapshot>({
        key: snapshotCacheKeys.costs,
      });

      if (cachedSnapshotResult.ok && cachedSnapshotResult.data.status === "hit") {
        console.log("[COSTS] Returning cached cost data");
        return NextResponse.json({
          success: true,
          data: {
            ...cachedSnapshotResult.data.value.data,
            cachedAt: cachedSnapshotResult.data.value.timestamp,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    console.log(skipCache ? "[COSTS] Mock mode - skipping cache" : "[COSTS] Fetching fresh cost data from AWS");
    const data = await getCosts();
    const timestamp = Date.now();

    // Update cache
    if (!skipCache) {
      await runtimeStateAdapter.setSnapshot({
        key: snapshotCacheKeys.costs,
        value: { data, timestamp },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        ...data,
        cachedAt: timestamp,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<CostData & { cachedAt?: number }>(error, "costs");
  }
}
