/**
 * GET /api/gdrive/callback
 * Handles Google OAuth callback, exchanges code for tokens, and stores them in SSM
 */

import { requireAdmin } from "@/lib/api-auth";
import { getMockStateStore } from "@/lib/aws/mock-state-store";
import { putParameter } from "@/lib/aws/ssm-client";
import { env } from "@/lib/env";
import { isMockMode } from "@/lib/env";
import { type NextRequest, NextResponse } from "next/server";

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
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=success`);
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

  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=success`);
}

/**
 * Handle OAuth errors from Google
 */
function handleOAuthError(error: string): NextResponse {
  console.error("[GDRIVE-CALLBACK] Google OAuth error:", error);
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent(error)}`);
}

/**
 * Handle missing code error
 */
function handleMissingCode(): NextResponse {
  console.error("[GDRIVE-CALLBACK] No code provided in callback");
  return NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent("No code provided")}`
  );
}

/**
 * Handle general errors
 */
function handleError(error: unknown): NextResponse {
  console.error("[GDRIVE-CALLBACK] Error:", error);
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/?gdrive=error&message=${encodeURIComponent(errorMessage)}`);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Check admin authorization
  try {
    const user = await requireAdmin(request);
    console.log("[GDRIVE-CALLBACK] Admin action by:", user.email);
  } catch (error) {
    if (error instanceof Response) {
      return error as NextResponse;
    }
    throw error;
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const mock = searchParams.get("mock");

  // Mock mode: Simulate successful OAuth without calling Google
  if (isMockMode() || mock === "true") {
    return handleMockOAuth();
  }

  // AWS mode: Handle real Google OAuth callback
  if (errorParam) {
    return handleOAuthError(errorParam);
  }

  if (!code) {
    return handleMissingCode();
  }

  try {
    return await handleRealOAuth(code);
  } catch (error) {
    return handleError(error);
  }
}
