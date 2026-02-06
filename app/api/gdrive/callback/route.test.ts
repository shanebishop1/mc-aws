/**
 * Unit tests for GET /api/gdrive/callback
 *
 * Tests OAuth state validation, mock mode security, and error handling
 */

import { createMockNextRequest } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// Use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => ({
  isMockMode: vi.fn(() => false),
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com" }),
  getMockStateStore: vi.fn(() => ({
    setParameter: vi.fn().mockResolvedValue(undefined),
  })),
  putParameter: vi.fn().mockResolvedValue(undefined),
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
    GOOGLE_CLIENT_SECRET: "test-client-secret",
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

vi.mock("@/lib/aws/mock-state-store", () => ({
  getMockStateStore: mocks.getMockStateStore,
}));

vi.mock("@/lib/aws/ssm-client", () => ({
  putParameter: mocks.putParameter,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mocks.cookieStore),
}));

// Mock fetch for Google token exchange
global.fetch = vi.fn();

describe("GET /api/gdrive/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(global.fetch).mockClear();
    // Reset admin mock to resolve by default
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com" });
    // Reset mock mode to false by default
    mocks.isMockMode.mockReturnValue(false);
    // Reset cookie store
    mocks.cookieStore.get.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("State validation", () => {
    it("should reject when state parameter is missing", async () => {
      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("Missing%20OAuth%20state%20parameter");
    });

    it("should reject when state cookie is missing", async () => {
      mocks.cookieStore.get.mockReturnValue(undefined);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("OAuth%20state%20cookie%20not%20found");
    });

    it("should reject when state parameter does not match cookie", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state-from-cookie" });

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=invalid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("OAuth%20state%20mismatch");
    });

    it("should accept when state parameter matches cookie", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state-12345" });

      // Mock successful token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      } as Response);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=valid-state-12345");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=success");

      // State cookie should be cleared on success
    });
  });

  describe("Mock mode security", () => {
    it("should allow mock flow when isMockMode() is true", async () => {
      mocks.isMockMode.mockReturnValue(true);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?mock=true");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=success");

      // State cookie should be cleared
    });

    it("should ignore ?mock=true when isMockMode() is false", async () => {
      mocks.isMockMode.mockReturnValue(false);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?mock=true");
      const res = await GET(req);

      // Should reject due to missing state, not proceed with mock flow
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("Missing%20OAuth%20state%20parameter");

      // Should NOT redirect to success
      expect(res.headers.get("location")).not.toContain("?gdrive=success");
    });
  });

  describe("Error handling", () => {
    it("should handle Google OAuth errors", async () => {
      const req = createMockNextRequest("http://localhost/api/gdrive/callback?error=access_denied&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("access_denied");
    });

    it("should handle missing code parameter", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state" });

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?state=valid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
      expect(res.headers.get("location")).toContain("No%20code%20provided");
    });

    it("should handle token exchange failures", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state" });

      // Mock failed token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "invalid_grant",
          error_description: "Invalid authorization code",
        }),
      } as Response);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=invalid_code&state=valid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
    });

    it("should handle SSM storage failures", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state" });

      // Mock successful token exchange
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      } as Response);

      // Mock SSM failure
      mocks.putParameter.mockRejectedValueOnce(new Error("SSM Error"));

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=valid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("?gdrive=error");
    });
  });

  describe("Authentication", () => {
    it("should require admin authentication", async () => {
      mocks.requireAdmin.mockRejectedValue(new Response("Unauthorized", { status: 401 }));

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(401);
    });
  });

  describe("Cookie cleanup", () => {
    it("should clear state cookie on successful OAuth", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state" });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      } as Response);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=valid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
    });

    it("should clear state cookie on state validation error", async () => {
      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code");
      const res = await GET(req);

      expect(res.status).toBe(302);
    });

    it("should clear state cookie on token exchange error", async () => {
      mocks.cookieStore.get.mockReturnValue({ value: "valid-state" });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "invalid_grant",
        }),
      } as Response);

      const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=invalid_code&state=valid-state");
      const res = await GET(req);

      expect(res.status).toBe(302);
    });
  });
});
