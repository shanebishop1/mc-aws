import { createAuthenticatedRequest, createFixtureAuthUser, stubSessionVerifier } from "@/tests/fixtures";
import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/api-auth");
vi.unmock("@/lib/auth");

const { verifySessionMock } = vi.hoisted(() => {
  return {
    verifySessionMock: vi.fn(),
  };
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");

  return {
    ...actual,
    verifySession: verifySessionMock,
  };
});

describe("api-auth fixture integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts the authenticated user from session cookie", async () => {
    const authUser = createFixtureAuthUser({ email: "player@example.com", role: "allowed" });
    const session = stubSessionVerifier(verifySessionMock, authUser, "session-from-fixture");

    const request = createAuthenticatedRequest("http://localhost/api/status", {
      session: {
        token: session.token,
      },
    });

    const { getAuthUser } = await import("@/lib/api-auth");
    const user = await getAuthUser(request);

    expect(user).toEqual(authUser);
    expect(verifySessionMock).toHaveBeenCalledWith("session-from-fixture");
  });

  it("returns null when no session cookie is provided", async () => {
    const nextRequest = createMockNextRequest("http://localhost/api/status");

    const { getAuthUser } = await import("@/lib/api-auth");
    const user = await getAuthUser(nextRequest);

    expect(user).toBeNull();
    expect(verifySessionMock).not.toHaveBeenCalled();
  });
});
