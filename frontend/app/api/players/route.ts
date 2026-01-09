import { getPlayerCount } from "@/lib/aws-client";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const data = await getPlayerCount();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Failed to get player count:", error);
    return NextResponse.json({ success: false, error: "Failed to fetch player count" }, { status: 500 });
  }
}
