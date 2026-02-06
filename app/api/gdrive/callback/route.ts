/**
 * GET /api/gdrive/callback
 * Handles Google OAuth callback, exchanges code for tokens, and stores them in SSM
 */

import { requireAdmin } from "@/lib/api-auth";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { putParameter } from "@/lib/aws/ssm-client";
import { env } from "@/lib/env";
import { isMockMode } from "@/lib/env";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const OAUTH_STATE_COOKIE = "gdrive_oauth_state";

/**
 * Handle mock OAuth flow for testing
 */
async function handleMockOAuth(): Promise<NextResponse> {
  console.log("[MOCK-GDRIVE] Simulating OAuth callback");

  // Create a mock rclone-compatible token
  const expiryDate = new Date();
  expiryDate.setSeconds(expiryDate.getSeconds() + 3600);

  const mockRcloneToken = {
    access_token: `mock_access_token_${Date.now()}`,
    token_type: "Bearer",
    refresh_token: `mock_refresh_token_${Date.now()}`,
    expiry: expiryDate.toISOString(),
  };

  // Store mock token in mock state store
  const mockStore = getMockStateStore();
  await mockStore.setParameter("/minecraft/gdrive-token", JSON.stringify(mockRcloneToken), "SecureString");

  console.log("[MOCK-GDRIVE] Mock token stored successfully");

  // Clear OAuth state cookie
  const response = NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=success`, 302);
  response.cookies.delete(OAUTH_STATE_COOKIE);

  return response;
}

/**
 * Exchange OAuth code for tokens with Google
 */
async function exchangeCodeForTokens(code: string): Promise<Record<string, string>> {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/gdrive/callback`;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.json();
    console.error("[GDRIVE-CALLBACK] Token exchange failed:", errorData);
    throw new Error(`Token exchange failed: ${errorData.error_description || errorData.error || "Unknown error"}`);
  }

  return tokenResponse.json();
}

/**
 * Store rclone-compatible token in SSM
 */
async function storeToken(tokens: Record<string, string>): Promise<void> {
  // rclone-compatible format
  // tokens contains: access_token, expires_in, refresh_token, scope, token_type
  // rclone expects: access_token, token_type, refresh_token, expiry
  const expiryDate = new Date();
  expiryDate.setSeconds(expiryDate.getSeconds() + (tokens.expires_in ? Number(tokens.expires_in) : 3600));

  const rcloneToken = {
    access_token: tokens.access_token,
    token_type: tokens.token_type || "Bearer",
    refresh_token: tokens.refresh_token,
    expiry: expiryDate.toISOString(),
  };

  console.log("[GDRIVE-CALLBACK] Storing token in SSM");
  await putParameter("/minecraft/gdrive-token", JSON.stringify(rcloneToken), "SecureString");
  console.log("[GDRIVE-CALLBACK] Token stored successfully");
}

/**
 * Handle real Google OAuth flow
 */
async function handleRealOAuth(code: string): Promise<NextResponse> {
  console.log("[GDRIVE-CALLBACK] Exchanging code for tokens");

  const tokens = await exchangeCodeForTokens(code);
  await storeToken(tokens);

  // Clear OAuth state cookie on success
  const response = NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=success`, 302);
  response.cookies.delete(OAUTH_STATE_COOKIE);

  return response;
}

/**
 * Handle OAuth errors from Google
 */
function handleOAuthError(error: string): NextResponse {
  console.error("[GDRIVE-CALLBACK] Google OAuth error:", error);
  const response = NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent("Google OAuth authorization failed")}`,
    302
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/**
 * Handle missing code error
 */
function handleMissingCode(): NextResponse {
  console.error("[GDRIVE-CALLBACK] No code provided in callback");
  const response = NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent("No authorization code provided")}`,
    302
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/**
 * Handle general errors
 */
function handleError(error: unknown): NextResponse {
  console.error("[GDRIVE-CALLBACK] Error:", error);
  const response = NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent("Failed to complete Google Drive setup")}`,
    302
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/**
 * Handle state validation errors
 */
function handleStateError(message: string): NextResponse {
  console.error("[GDRIVE-CALLBACK] State validation error:", message);
  // Map internal state errors to safe messages
  const safeMessage = message.includes("Missing") ? "Missing OAuth state parameter" : "OAuth state validation failed";
  const response = NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent(safeMessage)}`,
    302
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Check admin authorization
  try {
    const user = await requireAdmin(request);
    console.log("[GDRIVE-CALLBACK] Admin action by:", user.email);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void user;
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse;
    }
    throw error;
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const state = searchParams.get("state");

  // Mock mode: Simulate successful OAuth without calling Google
  // Only allow mock mode if isMockMode() is true, ignore ?mock=true override
  if (isMockMode()) {
    return handleMockOAuth();
  }

  // AWS mode: Handle real Google OAuth callback
  if (errorParam) {
    return handleOAuthError(errorParam);
  }

  // Validate state parameter is present
  if (!state) {
    console.error("[GDRIVE-CALLBACK] Missing state parameter");
    return handleStateError("Missing OAuth state parameter");
  }

  // Retrieve and validate state from cookie
  const cookieStore = await cookies();
  const oauthState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;

  if (!oauthState) {
    console.error("[GDRIVE-CALLBACK] Missing OAuth state cookie");
    return handleStateError("OAuth state cookie not found");
  }

  // Validate state matches
  if (state !== oauthState) {
    console.error("[GDRIVE-CALLBACK] State mismatch:", { state, oauthState });
    return handleStateError("OAuth state mismatch");
  }

  console.log("[GDRIVE-CALLBACK] State validated successfully");

  if (!code) {
    return handleMissingCode();
  }

  try {
    return await handleRealOAuth(code);
  } catch (error) {
    return handleError(error);
  }
}
