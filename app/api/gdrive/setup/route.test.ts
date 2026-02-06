/**
 * Unit tests for GET /api/gdrive/setup
 *
 * Tests OAuth state generation and cookie persistence
 */

import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  isMockMode: vi.fn(() => false),
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com" }),
  generateState: vi.fn(() => "test-state-12345"),
  cookieStore: {
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  // Mock environment variables (must be hoisted)
  mockEnv: {
    MC_BACKEND_MODE: "aws",
    NEXT_PUBLIC_APP_URL: "http://localhost:3001",
    GOOGLE_CLIENT_ID: "test-client-id",
  },
}));

// Mock dependencies
vi.mock("@/lib/env", () => ({
  env: mocks.mockEnv,
  isMockMode: mocks.isMockMode,
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("arctic", () => ({
  generateState: mocks.generateState,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mocks.cookieStore),
}));

describe("GET /api/gdrive/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset admin mock to resolve by default
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com" });
    // Reset mockEnv to default state
    mocks.mockEnv.GOOGLE_CLIENT_ID = "test-client-id";
    mocks.mockEnv.MC_BACKEND_MODE = "aws";
    mocks.isMockMode.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should generate OAuth state and set cookie in AWS mode", async () => {
    const req = createMockNextRequest("http://localhost/api/gdrive/setup");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<{ authUrl: string }>>(res);

    expect(body.success).toBe(true);
    expect(body.data?.authUrl).toBeDefined();

    // Verify state parameter is in auth URL
    const authUrl = new URL(body.data?.authUrl || "");
    expect(authUrl.searchParams.get("state")).toBe("test-state-12345");

    // Verify cookie was set with correct attributes
    expect(mocks.cookieStore.set).toHaveBeenCalledWith("gdrive_oauth_state", "test-state-12345", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  });

  it("should return mock OAuth URL in mock mode", async () => {
    mocks.isMockMode.mockReturnValue(true);

    const req = createMockNextRequest("http://localhost/api/gdrive/setup");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<{ authUrl: string }>>(res);

    expect(body.success).toBe(true);
    expect(body.data?.authUrl).toContain("/api/gdrive/callback?mock=true");

    // Cookie should not be set in mock mode
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
  });

  it("should require admin authentication", async () => {
    mocks.requireAdmin.mockRejectedValue(new Response("Unauthorized", { status: 401 }));

    const req = createMockNextRequest("http://localhost/api/gdrive/setup");
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it("should return error when GOOGLE_CLIENT_ID is not configured", async () => {
    mocks.mockEnv.GOOGLE_CLIENT_ID = "";

    const req = createMockNextRequest("http://localhost/api/gdrive/setup");
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);

    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to initiate Google Drive setup");
  });

  it("should include all required OAuth parameters in auth URL", async () => {
    const req = createMockNextRequest("http://localhost/api/gdrive/setup");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<{ authUrl: string }>>(res);

    const authUrl = new URL(body.data?.authUrl || "");

    expect(authUrl.searchParams.get("client_id")).toBe("test-client-id");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/gdrive/callback");
    expect(authUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("state")).toBe("test-state-12345");
  });
});
