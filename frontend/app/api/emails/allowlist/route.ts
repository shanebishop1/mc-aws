import { NextResponse } from "next/server";
import { updateEmailAllowlist } from "@/lib/aws-client";

declare global {
  // eslint-disable-next-line no-var
  var __mc_cachedEmails: { adminEmail: string; allowlist: string[]; timestamp: number } | null | undefined;
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { emails } = body;

    if (!Array.isArray(emails)) {
      return NextResponse.json(
        { success: false, error: "emails must be an array" },
        { status: 400 }
      );
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = emails.filter((e) => !emailRegex.test(e));
    if (invalidEmails.length > 0) {
      return NextResponse.json(
        { success: false, error: `Invalid email format: ${invalidEmails.join(", ")}` },
        { status: 400 }
      );
    }

    await updateEmailAllowlist(emails);

    // Invalidate /api/emails cache so the next GET is fresh
    globalThis.__mc_cachedEmails = null;

    return NextResponse.json({
      success: true,
      data: { allowlist: emails },
    });
  } catch (error) {
    console.error("Failed to update allowlist:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update email allowlist" },
      { status: 500 }
    );
  }
}
