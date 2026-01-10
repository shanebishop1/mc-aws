/**
 * GET /api/auth/login
 * Initiates the Google OAuth flow
 *
 * - Generates OAuth state and code verifier
 * - Stores them in HTTP-only cookies
 * - Redirects to Google's authorization URL
 *
 * For local development, use /api/auth/dev-login instead
 */

import { env } from "@/lib/env";
import { Google, generateCodeVerifier, generateState } from "arctic";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_CODE_VERIFIER_COOKIE = "oauth_code_verifier";
const OAUTH_COOKIE_EXPIRY = 600; // 10 minutes in seconds

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    console.log("[LOGIN] Initiating OAuth flow");

    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    if (!clientId || !clientSecret || !appUrl) {
      console.error("[LOGIN] Missing OAuth configuration");
      return NextResponse.redirect(new URL("/?error=oauth_config", request.url));
    }

    // Generate state and code verifier for PKCE
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    console.log("[LOGIN] Generated state and code verifier");

    // Store state and code verifier in HTTP-only cookies
    const cookieStore = await cookies();
    cookieStore.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_COOKIE_EXPIRY,
    });

    cookieStore.set(OAUTH_CODE_VERIFIER_COOKIE, codeVerifier, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_COOKIE_EXPIRY,
    });

    // Create Google OAuth client
    const redirectUri = `${appUrl}/api/auth/callback`;
    const google = new Google(clientId, clientSecret, redirectUri);

    // Generate authorization URL with required scopes
    const scopes = ["openid", "email", "profile"];
    const authUrl = google.createAuthorizationURL(state, codeVerifier, scopes);

    console.log("[LOGIN] Redirecting to Google OAuth");
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("[LOGIN] Error:", error);
    return NextResponse.redirect(new URL("/?error=oauth_failed", request.url));
  }
}
