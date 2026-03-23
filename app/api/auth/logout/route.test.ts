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
});
