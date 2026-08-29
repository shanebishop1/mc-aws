import { createHash } from "node:crypto";
import { invalidateAllowlistCache } from "@/lib/allowlist-cache";
import { requireAdmin } from "@/lib/api-auth";
import { formatApiErrorResponse } from "@/lib/api-error";
import { updateEmailAllowlist } from "@/lib/aws";
import { env, getAllowedEmails } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import { snapshotCacheKeys } from "@/lib/runtime-state/snapshot-cache";
import { acquireServerActionLock, releaseServerActionLock } from "@/lib/server-action-lock";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { isValidEmail } from "./email-validation";

const MAX_ALLOWLIST_BODY_BYTES = 16_384;
const MAX_ALLOWLIST_EMAILS = 100;
const MAX_EMAIL_LENGTH = 254;
const ALLOWLIST_RATE_LIMIT_WINDOW_MS = 60_000;
const ALLOWLIST_RATE_LIMIT_MAX_REQUESTS = 6;

function invalidPayload(error: string): NextResponse<ApiResponse<{ allowlist: string[] }>> {
  return NextResponse.json(
    { success: false, error, timestamp: new Date().toISOString() },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );
}

async function readBoundedBody(request: NextRequest): Promise<string | NextResponse> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ALLOWLIST_BODY_BYTES) {
    return invalidPayload("Request body is too large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let rawBody = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ALLOWLIST_BODY_BYTES) {
      await reader.cancel();
      return invalidPayload("Request body is too large");
    }
    rawBody += decoder.decode(value, { stream: true });
  }
  return rawBody + decoder.decode();
}

async function parseAllowlistBody(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  const bodyResult = await readBoundedBody(request);
  if (bodyResult instanceof Response) return bodyResult;
  let body: unknown;
  try {
    body = JSON.parse(bodyResult);
  } catch {
    return invalidPayload("Request body must contain valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidPayload("Request body must be a JSON object");
  }
  const fields = Object.keys(body);
  if (fields.some((field) => field !== "emails")) {
    return invalidPayload("Request body contains unsupported fields");
  }
  return body as Record<string, unknown>;
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
  let lock: Awaited<ReturnType<typeof acquireServerActionLock>> | undefined;
  let ownerEmail = "unknown";
  try {
    // Check admin authorization
    try {
      const user = await requireAdmin(request);
      ownerEmail = user.email;
      console.log("[EMAILS] Authorized allowlist update requested");
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<{ allowlist: string[] }>>;
      }
      throw error;
    }

    const identityHash = createHash("sha256").update(ownerEmail.trim().toLowerCase()).digest("hex").slice(0, 32);
    const rateLimit = await checkRateLimit({
      route: "/api/emails/allowlist",
      key: `allowlist:${identityHash}`,
      limit: ALLOWLIST_RATE_LIMIT_MAX_REQUESTS,
      windowMs: ALLOWLIST_RATE_LIMIT_WINDOW_MS,
      failureMode: "closed",
    });
    if (!rateLimit.allowed) {
      const response = NextResponse.json(
        {
          success: false,
          error: "Too many allowlist updates. Please retry shortly.",
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    const body = await parseAllowlistBody(request);
    if (body instanceof Response) return body as NextResponse<ApiResponse<{ allowlist: string[] }>>;
    const { emails } = body;

    console.log("[EMAILS] Updating email allowlist");

    if (!Array.isArray(emails)) {
      return invalidPayload("emails must be an array");
    }

    if (!emails.every((e) => typeof e === "string")) {
      return invalidPayload("emails must be an array of strings");
    }

    if (emails.length > MAX_ALLOWLIST_EMAILS || emails.some((email) => email.length > MAX_EMAIL_LENGTH)) {
      return invalidPayload("emails exceeds allowed size limits");
    }

    const normalizedEmails = uniqueEmails(emails);

    // Basic email validation
    if (normalizedEmails.some((email) => !isValidEmail(email))) {
      return invalidPayload("Invalid email format");
    }

    const baselineAllowlist = getBaselineAllowlist();
    const effectiveAllowlist = uniqueEmails([...normalizedEmails, ...baselineAllowlist]);

    lock = await acquireServerActionLock("allowlist", ownerEmail);
    await updateEmailAllowlist(effectiveAllowlist);

    // Force auth allowlist cache refresh after admin mutations.
    invalidateAllowlistCache();

    // Invalidate /api/emails cache so the next GET is fresh.
    const runtimeStateAdapter = getRuntimeStateAdapter();
    await runtimeStateAdapter.invalidateSnapshot({ key: snapshotCacheKeys.emails });

    return NextResponse.json({
      success: true,
      data: { allowlist: effectiveAllowlist },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return formatApiErrorResponse<{ allowlist: string[] }>(error, "emailsAllowlist");
  } finally {
    if (lock) {
      await releaseServerActionLock(lock.lockId, {
        action: "allowlist",
        ownerEmail,
        fencingToken: lock.fencingToken,
      }).catch(() => console.error("[EMAILS] Failed to release allowlist lock"));
    }
  }
}
