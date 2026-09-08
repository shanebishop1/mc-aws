import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "./env";

vi.unmock("@/lib/auth");
vi.mock("./allowlist-cache", () => ({
  getCachedAllowlist: vi.fn(async () => []),
}));

import {
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  SESSION_MAX_AGE_SECONDS,
  SESSION_PURPOSE,
  createSession,
  verifySession,
} from "./auth";

const productionSecret = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";
const encoder = new TextEncoder();

interface TokenOptions {
  algorithm?: "HS256" | "HS512";
  audience?: string;
  email?: unknown;
  expiration?: number | null;
  issuedAt?: number | null;
  issuer?: string;
  purpose?: string;
  secret?: string;
  type?: string;
}

const signToken = async (options: TokenOptions = {}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.issuedAt === undefined ? now : options.issuedAt;
  const expiration = options.expiration === undefined ? now + SESSION_MAX_AGE_SECONDS : options.expiration;
  let jwt = new SignJWT({
    email: options.email === undefined ? "admin@example.com" : options.email,
    role: "admin",
    purpose: options.purpose ?? SESSION_PURPOSE,
  })
    .setProtectedHeader({ alg: options.algorithm ?? "HS256", typ: options.type ?? "JWT" })
    .setIssuer(options.issuer ?? SESSION_ISSUER)
    .setAudience(options.audience ?? SESSION_AUDIENCE);
  if (issuedAt !== null) jwt = jwt.setIssuedAt(issuedAt);
  if (expiration !== null) jwt = jwt.setExpirationTime(expiration);
  return jwt.sign(encoder.encode(options.secret ?? productionSecret));
};

describe("session AUTH_SECRET and JWT enforcement", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    env.AUTH_SECRET = productionSecret;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates and verifies a bounded HS256 session with all required claims", async () => {
    const token = await createSession("admin@example.com");
    await expect(verifySession(token)).resolves.toEqual({ email: "admin@example.com", role: "admin" });
  });

  it("does not create or verify sessions when production has a noncanonical secret", async () => {
    env.AUTH_SECRET = "weak-but-not-a-placeholder-value";
    await expect(createSession("admin@example.com")).rejects.toThrow("at least 32 cryptographically random bytes");

    const forged = await signToken({ secret: env.AUTH_SECRET });
    await expect(verifySession(forged)).resolves.toBeNull();
  });

  it("rejects forged signatures and algorithm confusion", async () => {
    await expect(verifySession(await signToken({ secret: "passwordpasswordpasswordpassword" }))).resolves.toBeNull();
    await expect(verifySession(await signToken({ algorithm: "HS512" }))).resolves.toBeNull();
  });

  it.each([
    ["missing exp", { expiration: null }],
    ["missing iat", { issuedAt: null }],
    ["wrong issuer", { issuer: "attacker" }],
    ["wrong audience", { audience: "other-service" }],
    ["wrong purpose", { purpose: "password-reset" }],
    ["wrong type", { type: "at+jwt" }],
    ["missing email", { email: null }],
  ] satisfies Array<[string, TokenOptions]>)("rejects a token with %s", async (_name, options) => {
    await expect(verifySession(await signToken(options))).resolves.toBeNull();
  });

  it("rejects future, stale, expired, and overlong sessions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      await signToken({ issuedAt: now + 60, expiration: now + 120 }),
      await signToken({ issuedAt: now - SESSION_MAX_AGE_SECONDS - 60, expiration: now + 60 }),
      await signToken({ issuedAt: now - 120, expiration: now - 60 }),
      await signToken({ issuedAt: now, expiration: now + SESSION_MAX_AGE_SECONDS + 1 }),
    ];
    for (const token of candidates) await expect(verifySession(token)).resolves.toBeNull();
  });
});
