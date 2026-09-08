import { SESSION_AUDIENCE, SESSION_ISSUER, SESSION_MAX_AGE_SECONDS, SESSION_PURPOSE } from "@/lib/auth";
import { env } from "@/lib/env";
import { createMockNextRequest } from "@/tests/utils";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/api-auth");
vi.unmock("@/lib/auth");

const mocks = vi.hoisted(() => ({
  acquireServerActionLock: vi.fn(),
  checkRateLimit: vi.fn(),
  invalidateAllowlistCache: vi.fn(),
  updateEmailAllowlist: vi.fn(),
}));

vi.mock("@/lib/allowlist-cache", () => ({
  getCachedAllowlist: vi.fn(async () => []),
  invalidateAllowlistCache: mocks.invalidateAllowlistCache,
}));
vi.mock("@/lib/aws", () => ({ updateEmailAllowlist: mocks.updateEmailAllowlist }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: vi.fn(),
}));
vi.mock("@/lib/runtime-state", () => ({
  getRuntimeStateAdapter: () => ({ invalidateSnapshot: vi.fn() }),
}));

import { PUT } from "./route";

describe("PUT /api/emails/allowlist session verification", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rejects a forged admin JWT before route side effects", async () => {
    vi.stubEnv("NODE_ENV", "production");
    env.AUTH_SECRET = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      email: "admin@example.com",
      role: "admin",
      purpose: SESSION_PURPOSE,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + SESSION_MAX_AGE_SECONDS)
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .sign(new TextEncoder().encode("attacker-controlled-signing-key-material"));

    const response = await PUT(
      createMockNextRequest("http://localhost:3000/api/emails/allowlist", {
        method: "PUT",
        headers: {
          cookie: `mc_session=${forged}`,
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ emails: ["attacker@example.com"] }),
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.acquireServerActionLock).not.toHaveBeenCalled();
    expect(mocks.updateEmailAllowlist).not.toHaveBeenCalled();
  });
});
