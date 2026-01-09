import { getEmailAllowlist } from "@/lib/aws-client";
import { NextResponse } from "next/server";

// Permanent in-memory cache
let cachedEmails: {
  adminEmail: string;
  allowlist: string[];
  timestamp: number;
} | null = null;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";

    const adminEmail = process.env.NOTIFICATION_EMAIL || "Not configured";

    if (cachedEmails && !forceRefresh) {
      return NextResponse.json({
        success: true,
        data: {
          adminEmail: cachedEmails.adminEmail,
          allowlist: cachedEmails.allowlist,
        },
        cachedAt: cachedEmails.timestamp,
      });
    }

    const allowlist = await getEmailAllowlist();
    const timestamp = Date.now();

    cachedEmails = { adminEmail, allowlist, timestamp };

    return NextResponse.json({
      success: true,
      data: { adminEmail, allowlist },
      cachedAt: timestamp,
    });
  } catch (error) {
    console.error("Failed to get emails:", error);
    return NextResponse.json({ success: false, error: "Failed to fetch email configuration" }, { status: 500 });
  }
}
