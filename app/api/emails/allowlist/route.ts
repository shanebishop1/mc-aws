import { invalidateAllowlistCache } from "@/lib/allowlist-cache";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { updateEmailAllowlist } from "@/lib/aws";
import { env, getAllowedEmails } from "@/lib/env";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

declare global {
  var __mc_cachedEmails: { adminEmail: string; allowlist: string[]; timestamp: number } | null | undefined;
}

function uniqueEmails(emails: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function getBaselineAllowlist(): string[] {
  const notificationEmail = (process.env.NOTIFICATION_EMAIL || env.ADMIN_EMAIL || "").trim();
  return uniqueEmails([notificationEmail, env.ADMIN_EMAIL, ...getAllowedEmails()]);
}

export async function PUT(request: NextRequest): Promise<NextResponse<ApiResponse<{ allowlist: string[] }>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request);
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

    if (!emails.every((e) => typeof e === "string")) {
      return NextResponse.json(
        {
          success: false,
          error: "emails must be an array of strings",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const normalizedEmails = uniqueEmails(emails);

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = normalizedEmails.filter((e) => !emailRegex.test(e));
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

    const baselineAllowlist = getBaselineAllowlist();
    const effectiveAllowlist = uniqueEmails([...normalizedEmails, ...baselineAllowlist]);

    await updateEmailAllowlist(effectiveAllowlist);

    // Force auth allowlist cache refresh after admin mutations.
    invalidateAllowlistCache();

    // Invalidate /api/emails cache so the next GET is fresh
    globalThis.__mc_cachedEmails = null;

    return NextResponse.json({
      success: true,
      data: { allowlist: effectiveAllowlist },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<{ allowlist: string[] }>(error, "emailsAllowlist");
  }
}
