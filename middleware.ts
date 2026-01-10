import { type NextRequest, NextResponse } from "next/server";

/**
 * Middleware that sanitizes incoming requests
 *
 * Security: Strips any x-user-* headers that attackers might try to spoof.
 * API routes verify auth independently via the session cookie (zero-trust).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestHeaders = new Headers(request.headers);

  // Strip any auth headers - prevents spoofing attempts
  // API routes verify JWT from cookies directly, but we still strip these
  // to prevent any legacy code or future bugs from trusting them
  requestHeaders.delete("x-user-email");
  requestHeaders.delete("x-user-role");

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: ["/api/:path*"],
};
