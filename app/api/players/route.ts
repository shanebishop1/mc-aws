import { getAuthUser } from "@/lib/api-auth";
import { getPlayerCount } from "@/lib/aws";
import type { ApiResponse, PlayersResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<PlayersResponse["data"]>>> {
  const user = getAuthUser(request);
  console.log("[PLAYERS] Access by:", user?.email ?? "anonymous");

  try {
    console.log("[PLAYERS] Fetching player count");
    const data = await getPlayerCount();
    return NextResponse.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PLAYERS] Failed to get player count:", error);
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
