/**
 * GET /api/auth/callback
 * Handles the Google OAuth callback
 */

import { createSession, createSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { Google, type OAuth2Tokens } from "arctic";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_CODE_VERIFIER_COOKIE = "oauth_code_verifier";
const OAUTH_POPUP_COOKIE = "oauth_popup";
const CALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;
const CALLBACK_RATE_LIMIT_MAX_REQUESTS = 6;

interface GoogleUserInfo {
  email: string;
  name?: string;
  picture?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    console.log("[CALLBACK] Processing OAuth callback");

    const clientIp = getClientIp(request.headers);
    const rateLimit = checkRateLimit({
      key: `auth:callback:${clientIp}`,
      limit: CALLBACK_RATE_LIMIT_MAX_REQUESTS,
      windowMs: CALLBACK_RATE_LIMIT_WINDOW_MS,
    });

    if (!rateLimit.allowed) {
      console.warn("[CALLBACK] Rate limit exceeded for IP:", clientIp);
      const response = NextResponse.redirect(new URL("/?error=oauth_rate_limited", request.url));
      response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return response;
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // Check for missing required parameters
    if (!code || !state) {
      console.error("[CALLBACK] Missing code or state parameter");
      return NextResponse.redirect(new URL("/?error=oauth_missing_params", request.url));
    }

    const cookieStore = await cookies();
    const oauthState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
    const codeVerifier = cookieStore.get(OAUTH_CODE_VERIFIER_COOKIE)?.value;
    const isPopup = cookieStore.get(OAUTH_POPUP_COOKIE)?.value === "1";

    // Check for missing cookies
    if (!oauthState || !codeVerifier) {
      console.error("[CALLBACK] Missing OAuth cookies");
      return NextResponse.redirect(new URL("/?error=oauth_state_mismatch", request.url));
    }

    // Validate state matches
    if (state !== oauthState) {
      console.error("[CALLBACK] State mismatch:", { state, oauthState });
      return NextResponse.redirect(new URL("/?error=oauth_state_mismatch", request.url));
    }

    console.log("[CALLBACK] State validated successfully");

    // Exchange authorization code for tokens
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    if (!clientId || !clientSecret || !appUrl) {
      console.error("[CALLBACK] Missing OAuth configuration");
      return NextResponse.redirect(new URL("/?error=oauth_config", request.url));
    }

    const redirectUri = `${appUrl}/api/auth/callback`;
    const google = new Google(clientId, clientSecret, redirectUri);

    let tokens: OAuth2Tokens;
    try {
      tokens = await google.validateAuthorizationCode(code, codeVerifier);
      console.log("[CALLBACK] Token exchange successful");
    } catch (error) {
      console.error("[CALLBACK] Token exchange failed:", error);
      return NextResponse.redirect(new URL("/?error=oauth_token_failed", request.url));
    }

    const accessToken = tokens.accessToken();
    if (!accessToken) {
      console.error("[CALLBACK] No access token in response");
      return NextResponse.redirect(new URL("/?error=oauth_token_failed", request.url));
    }

    // Fetch user info from Google
    let userinfo: GoogleUserInfo;
    try {
      const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!userInfoResponse.ok) {
        throw new Error(`Userinfo request failed: ${userInfoResponse.status}`);
      }

      userinfo = (await userInfoResponse.json()) as GoogleUserInfo;
      console.log("[CALLBACK] Userinfo fetched successfully");
    } catch (error) {
      console.error("[CALLBACK] Userinfo fetch failed:", error);
      return NextResponse.redirect(new URL("/?error=oauth_userinfo_failed", request.url));
    }

    const email = userinfo.email;
    if (!email) {
      console.error("[CALLBACK] No email in userinfo response");
      return NextResponse.redirect(new URL("/?error=oauth_userinfo_failed", request.url));
    }

    console.log("[CALLBACK] Creating session for email:", email);

    // Create JWT session
    const token = await createSession(email);
    const sessionCookie = createSessionCookie(token);

    const popupCloseHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Signed in</title>
  </head>
  <body>
    <script>
      try {
        window.opener?.postMessage({ type: "MC_AUTH_SUCCESS" }, window.location.origin);
      } catch {}
      window.close();
      setTimeout(() => {
        window.location.href = "/";
      }, 250);
    </script>
    <p>Sign-in complete. You can close this window.</p>
  </body>
</html>`;

    const response = isPopup
      ? new NextResponse(popupCloseHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        })
      : NextResponse.redirect(new URL("/", request.url));

    response.cookies.set(sessionCookie.name, sessionCookie.value, {
      httpOnly: sessionCookie.httpOnly,
      secure: sessionCookie.secure,
      sameSite: sessionCookie.sameSite,
      path: sessionCookie.path,
      maxAge: sessionCookie.maxAge,
    });

    // Clear OAuth cookies
    response.cookies.delete(OAUTH_STATE_COOKIE);
    response.cookies.delete(OAUTH_CODE_VERIFIER_COOKIE);
    response.cookies.delete(OAUTH_POPUP_COOKIE);

    console.log("[CALLBACK] Session created and OAuth cookies cleared");
    return response;
  } catch (error) {
    console.error("[CALLBACK] Unexpected error:", error);
    return NextResponse.redirect(new URL("/?error=oauth_failed", request.url));
  }
}
