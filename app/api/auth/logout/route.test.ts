import { expectSessionCookieCleared } from "@/tests/auth-contract-utils";
import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookieMock: vi.fn(() => ({
    name: "mc_session",
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  })),
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE_NAME: "mc_session",
  clearSessionCookie: mocks.clearSessionCookieMock,
}));

describe("POST /api/auth/logout regression contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success payload and clears session cookie with expected attributes", async () => {
    const { POST } = await import("./route");

    const req = createMockNextRequest("http://localhost/api/auth/logout", {
      method: "POST",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({ success: true });
    expect(typeof payload.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    expect(mocks.clearSessionCookieMock).toHaveBeenCalledTimes(1);

    expectSessionCookieCleared(res.headers.get("set-cookie"));
  });

  it("rejects a cross-site browser logout without clearing the cookie", async () => {
    const { POST } = await import("./route");
    const req = createMockNextRequest("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "mc_session=session-token",
        host: "localhost:3000",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "Request origin is not allowed" });
    expect(mocks.clearSessionCookieMock).not.toHaveBeenCalled();
  });
});
