import { invalidateAllowlistCache } from "@/lib/allowlist-cache";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { getEmailAllowlist, updateEmailAllowlist } from "@/lib/aws";
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

export async function GET(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>> {
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request);
      console.log("[EMAILS] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>;
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";

    const adminEmail = (process.env.NOTIFICATION_EMAIL || env.ADMIN_EMAIL || "Not configured").trim();

    if (globalThis.__mc_cachedEmails && !forceRefresh) {
      console.log("[EMAILS] Returning cached email configuration");
      return NextResponse.json({
        success: true,
        data: {
          adminEmail: globalThis.__mc_cachedEmails.adminEmail,
          allowlist: globalThis.__mc_cachedEmails.allowlist,
          cachedAt: globalThis.__mc_cachedEmails.timestamp,
        },
        timestamp: new Date().toISOString(),
      });
    }

    console.log("[EMAILS] Fetching fresh email configuration");
    const baselineAllowlist = getBaselineAllowlist();
    const storedAllowlist = uniqueEmails(await getEmailAllowlist());
    const allowlist = uniqueEmails([...storedAllowlist, ...baselineAllowlist]);

    // If the parameter is missing/empty, seed it so email/Lambda behavior matches the UI allow list.
    if (storedAllowlist.length === 0 && baselineAllowlist.length > 0) {
      await updateEmailAllowlist(allowlist);
      invalidateAllowlistCache();
    }

    const timestamp = Date.now();

    globalThis.__mc_cachedEmails = { adminEmail, allowlist, timestamp };

    return NextResponse.json({
      success: true,
      data: { adminEmail, allowlist, cachedAt: timestamp },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>(error, "emails");
  }
}
