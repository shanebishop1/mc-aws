import { updateEmailAllowlist } from "@/lib/aws-client";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

declare global {
  var __mc_cachedEmails: { adminEmail: string; allowlist: string[]; timestamp: number } | null | undefined;
}

export async function PUT(request: NextRequest): Promise<NextResponse<ApiResponse<{ allowlist: string[] }>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(request);
      console.log("[EMAILS] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<{ allowlist: string[] }>>;
      }
      throw error;
    }

    const body = await request.json();
    const { emails } = body;

    console.log("[EMAILS] Updating email allowlist");

    if (!Array.isArray(emails)) {
      return NextResponse.json(
        {
          success: false,
          error: "emails must be an array",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = emails.filter((e) => !emailRegex.test(e));
    if (invalidEmails.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid email format: ${invalidEmails.join(", ")}`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    await updateEmailAllowlist(emails);

    // Invalidate /api/emails cache so the next GET is fresh
    globalThis.__mc_cachedEmails = null;

    return NextResponse.json({
      success: true,
      data: { allowlist: emails },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[EMAILS] Failed to update allowlist:", error);
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
