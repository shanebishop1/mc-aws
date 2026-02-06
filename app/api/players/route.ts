import { requireAuth } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getPlayerCount } from "@/lib/aws";
import type { ApiResponse, PlayersResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<PlayersResponse["data"]>>> {
  try {
    const user = await requireAuth(request);
    console.log("[PLAYERS] Action by:", user.email);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse<ApiResponse<PlayersResponse["data"]>>;
    }
    throw error;
  }

  try {
    console.log("[PLAYERS] Fetching player count");
    const data = await getPlayerCount();
    return NextResponse.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<PlayersResponse["data"]>(error, "players");
  }
}
