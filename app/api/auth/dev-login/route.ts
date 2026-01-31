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

import { SignJWT } from "jose";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  // SECURITY: Hard stop in production
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require explicit opt-in via environment variable
  if (process.env.ENABLE_DEV_LOGIN !== "true") {
    return NextResponse.json({ error: "Dev login is disabled. Set ENABLE_DEV_LOGIN=true in .env" }, { status: 403 });
  }

  // Create a real JWT token (same as production login would)
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
  const token = await new SignJWT({
    email: "dev@localhost",
    role: "admin", // Change to "allowed" to test non-admin users
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);

  // Redirect to home page with the cookie set (use request origin to support different ports)
  const origin = request.nextUrl.origin;
  const response = NextResponse.redirect(new URL("/", origin));

  response.cookies.set("mc_session", token, {
    httpOnly: true,
    secure: false, // Strictly for localhost
    sameSite: "lax",
    path: "/",
  });

  return response;
}
