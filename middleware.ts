import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Skip auth processing in development mode
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  const response = NextResponse.next();

  // Try to read and verify the session cookie
  const sessionCookie = request.cookies.get("mc_session");

  if (sessionCookie?.value) {
    try {
      const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
      const { payload } = await jwtVerify(sessionCookie.value, secret);

      // Enrich request with auth headers for downstream routes
      const userEmail = payload.email as string | undefined;
      const userRole = payload.role as string | undefined;

      if (userEmail) {
        response.headers.set("x-user-email", userEmail);
      }

      if (userRole) {
        response.headers.set("x-user-role", userRole);
      }
    } catch {
      // Invalid token - continue without headers (don't block)
    }
  }

  // Always continue - middleware only enriches context, doesn't block
  return response;
}

// Configure which routes the middleware should run on
export const config = {
  matcher: [
    // Match all API routes except /api/auth routes (they handle their own auth)
    "/api/((?!auth).*)*",
  ],
};
