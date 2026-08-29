import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  checkRateLimit: vi.fn(),
  updateEmailAllowlist: vi.fn(),
  acquireServerActionLock: vi.fn(),
  releaseServerActionLock: vi.fn(),
  invalidateAllowlistCache: vi.fn(),
  invalidateSnapshot: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/aws", () => ({ updateEmailAllowlist: mocks.updateEmailAllowlist }));
vi.mock("@/lib/allowlist-cache", () => ({ invalidateAllowlistCache: mocks.invalidateAllowlistCache }));
vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
}));
vi.mock("@/lib/runtime-state", () => ({
  getRuntimeStateAdapter: () => ({ invalidateSnapshot: mocks.invalidateSnapshot }),
}));
vi.mock("@/lib/env", () => ({
  env: { ADMIN_EMAIL: "admin@example.com" },
  getAllowedEmails: () => [],
}));

import { PUT } from "./route";

describe("PUT /api/emails/allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 5, retryAfterSeconds: 0 });
    mocks.acquireServerActionLock.mockResolvedValue({ lockId: "lock-1", fencingToken: 1 });
    mocks.releaseServerActionLock.mockResolvedValue(true);
    mocks.invalidateSnapshot.mockResolvedValue({ ok: true, data: { key: "emails", invalidated: true } });
  });

  it.each(["{bad", "[]", "null"])("rejects malformed or non-object body %s", async (body) => {
    const response = await PUT(createMockNextRequest("http://localhost/api/emails/allowlist", { method: "PUT", body }));
    expect(response.status).toBe(400);
    expect(mocks.acquireServerActionLock).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies, lists, email values, and unsupported fields", async () => {
    const bodies = [
      JSON.stringify({ emails: ["a@example.com"], padding: "x".repeat(17_000) }),
      JSON.stringify({ emails: Array.from({ length: 101 }, (_, index) => `user${index}@example.com`) }),
      JSON.stringify({ emails: [`${"a".repeat(250)}@example.com`] }),
      JSON.stringify({ emails: [], admin: true }),
    ];
    for (const body of bodies) {
      const response = await PUT(
        createMockNextRequest("http://localhost/api/emails/allowlist", { method: "PUT", body })
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.updateEmailAllowlist).not.toHaveBeenCalled();
  });

  it("throttles before parsing or locking", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 9 });
    const response = await PUT(
      createMockNextRequest("http://localhost/api/emails/allowlist", {
        method: "PUT",
        body: JSON.stringify({ emails: [] }),
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
    expect(mocks.acquireServerActionLock).not.toHaveBeenCalled();
  });

  it("normalizes valid email updates", async () => {
    const response = await PUT(
      createMockNextRequest("http://localhost/api/emails/allowlist", {
        method: "PUT",
        body: JSON.stringify({ emails: [" Player@Example.com ", "player@example.com"] }),
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.updateEmailAllowlist).toHaveBeenCalledWith(["player@example.com", "admin@example.com"]);
    const body = await parseNextResponse<{ success: boolean }>(response);
    expect(body.success).toBe(true);
  });
});
