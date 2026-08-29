import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { env } from "@/lib/env";
import { type NextRequest, NextResponse } from "next/server";

const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type SameOriginFailureReason = "invalid_configuration" | "invalid_host" | "missing_origin" | "invalid_origin";

export interface SameOriginDecision {
  allowed: boolean;
  reason?: SameOriginFailureReason;
}

function parseCanonicalOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseRequestOrigin(value: string): string | null {
  if (value === "null") {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isBrowserRequest(request: NextRequest): boolean {
  return request.headers.has("sec-fetch-site") || request.headers.has("sec-fetch-mode");
}

/**
 * Evaluate CSRF protection for cookie-authenticated mutations.
 *
 * Browsers must provide an exact canonical Origin. Origin-less requests are
 * reserved for controlled non-browser callers, identified by the absence of
 * browser Fetch Metadata headers. Host is always pinned to the configured
 * canonical application host to prevent a spoofed Host from becoming trusted.
 */
export function evaluateCookieMutationSameOrigin(
  request: NextRequest,
  canonicalAppUrl = env.NEXT_PUBLIC_APP_URL
): SameOriginDecision {
  if (!stateChangingMethods.has(request.method.toUpperCase()) || !request.cookies.has(SESSION_COOKIE_NAME)) {
    return { allowed: true };
  }

  const canonical = parseCanonicalOrigin(canonicalAppUrl);
  if (!canonical) {
    return { allowed: false, reason: "invalid_configuration" };
  }

  const requestHost = request.headers.get("host")?.trim() || request.nextUrl.host;
  if (requestHost.toLowerCase() !== canonical.host.toLowerCase()) {
    return { allowed: false, reason: "invalid_host" };
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) {
    return isBrowserRequest(request) ? { allowed: false, reason: "missing_origin" } : { allowed: true };
  }

  const requestOrigin = parseRequestOrigin(originHeader.trim());
  if (!requestOrigin || requestOrigin !== canonical.origin) {
    return { allowed: false, reason: "invalid_origin" };
  }

  return { allowed: true };
}

/**
 * Reject a cookie-authenticated state-changing request before authentication,
 * throttling, durable operation creation, or mutation lock acquisition.
 */
export function enforceCookieMutationSameOrigin(request: NextRequest): void {
  const decision = evaluateCookieMutationSameOrigin(request);
  if (decision.allowed) {
    return;
  }

  const configurationFailure = decision.reason === "invalid_configuration";
  throw NextResponse.json(
    {
      success: false,
      error: configurationFailure ? "Origin validation is unavailable" : "Request origin is not allowed",
      timestamp: new Date().toISOString(),
    },
    {
      status: configurationFailure ? 500 : 403,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
