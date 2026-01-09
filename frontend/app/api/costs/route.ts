import { getCosts } from "@/lib/aws-client";
import { NextResponse } from "next/server";

// Permanent in-memory cache (until server restart or manual refresh)
let cachedCosts: { data: Awaited<ReturnType<typeof getCosts>>; timestamp: number } | null = null;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";

    // Return cached data if exists and not forcing refresh
    if (cachedCosts && !forceRefresh) {
      return NextResponse.json({
        success: true,
        data: cachedCosts.data,
        cachedAt: cachedCosts.timestamp,
      });
    }

    const data = await getCosts();
    const timestamp = Date.now();

    // Update cache
    cachedCosts = { data, timestamp };

    return NextResponse.json({
      success: true,
      data,
      cachedAt: timestamp,
    });
  } catch (error) {
    console.error("Failed to get costs:", error);
    return NextResponse.json({ success: false, error: "Failed to fetch cost data" }, { status: 500 });
  }
}
