/**
 * GET /api/auth/dev-login
 * Development-only route to generate a real session cookie
 *
 * Usage:
 * 1. Set ENABLE_DEV_LOGIN=true in .env
 * 2. Visit http://localhost:3000/api/auth/dev-login
 * 3. You're logged in with a real cookie for 30 days
 *
 * To test different roles, change the "role" value below
 */

import { createSession, createSessionCookie } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { type NextRequest, NextResponse } from "next/server";

const DEV_LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
const DEV_LOGIN_RATE_LIMIT_MAX_REQUESTS = 10;

export async function GET(request: NextRequest) {
  // SECURITY: Hard stop in production
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require explicit opt-in via environment variable
  if (process.env.ENABLE_DEV_LOGIN !== "true") {
    return NextResponse.json({ error: "Dev login is disabled. Set ENABLE_DEV_LOGIN=true in .env" }, { status: 403 });
  }

  const clientIp = getClientIp(request.headers);
  const rateLimit = await checkRateLimit({
    route: "/api/auth/dev-login",
    key: `auth:dev-login:${clientIp}`,
    limit: DEV_LOGIN_RATE_LIMIT_MAX_REQUESTS,
    windowMs: DEV_LOGIN_RATE_LIMIT_WINDOW_MS,
    failureMode: "closed",
  });

  if (!rateLimit.allowed) {
    const response = NextResponse.json(
      { error: "Too many dev login requests. Please retry shortly." },
      { status: 429 }
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  // Use the same strict session contract as production. Only the route and
  // AUTH_SECRET strength exception are development-only conveniences.
  const token = await createSession("dev@localhost");

  // Redirect to home page with the cookie set (use request origin to support different ports)
  const origin = request.nextUrl.origin;
  const response = NextResponse.redirect(new URL("/", origin));

  const cookie = createSessionCookie(token);
  response.cookies.set(cookie.name, cookie.value, cookie);

  return response;
}
