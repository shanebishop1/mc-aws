import { getEmailAllowlist } from "@/lib/aws-client";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

// Permanent in-memory cache
let cachedEmails: {
  adminEmail: string;
  allowlist: string[];
  timestamp: number;
} | null = null;

export async function GET(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>> {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";

    const adminEmail = process.env.NOTIFICATION_EMAIL || "Not configured";

    if (cachedEmails && !forceRefresh) {
      console.log("[EMAILS] Returning cached email configuration");
      return NextResponse.json({
        success: true,
        data: {
          adminEmail: cachedEmails.adminEmail,
          allowlist: cachedEmails.allowlist,
          cachedAt: cachedEmails.timestamp,
        },
        timestamp: new Date().toISOString(),
      });
    }

    console.log("[EMAILS] Fetching fresh email configuration");
    const allowlist = await getEmailAllowlist();
    const timestamp = Date.now();

    cachedEmails = { adminEmail, allowlist, timestamp };

    return NextResponse.json({
      success: true,
      data: { adminEmail, allowlist, cachedAt: timestamp },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[EMAILS] Failed to get emails:", error);
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
