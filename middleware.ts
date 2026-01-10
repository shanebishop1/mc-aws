import { jwtVerify } from "jose";
import { type NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Create a copy of request headers that we can modify
  const requestHeaders = new Headers(request.headers);

  // CRITICAL: Delete any incoming auth headers to prevent spoofing
  // Attackers could send these headers directly to bypass auth
  requestHeaders.delete("x-user-email");
  requestHeaders.delete("x-user-role");

  // Try to read and verify the session cookie
  const sessionCookie = request.cookies.get("mc_session");

  if (sessionCookie?.value) {
    try {
      const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
      const { payload } = await jwtVerify(sessionCookie.value, secret);

      // Set trusted headers from verified JWT payload
      const userEmail = payload.email as string | undefined;
      const userRole = payload.role as string | undefined;

      if (userEmail) {
        requestHeaders.set("x-user-email", userEmail);
      }

      if (userRole) {
        requestHeaders.set("x-user-role", userRole);
      }
    } catch {
      // Invalid token - headers remain deleted, user is unauthenticated
    }
  }

  // Pass the sanitized headers to downstream routes
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

// Configure which routes the middleware should run on
export const config = {
  matcher: [
    // Match all API routes except /api/auth routes (they handle their own auth)
    "/api/((?!auth).*)*",
  ],
};
