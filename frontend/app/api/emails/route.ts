import { NextResponse } from "next/server";
import { getEmailAllowlist } from "@/lib/aws-client";

export async function GET() {
  try {
    const adminEmail = process.env.NOTIFICATION_EMAIL || "Not configured";
    const allowlist = await getEmailAllowlist();

    return NextResponse.json({
      success: true,
      data: {
        adminEmail,
        allowlist,
      },
    });
  } catch (error) {
    console.error("Failed to get emails:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch email configuration" },
      { status: 500 }
    );
  }
}
