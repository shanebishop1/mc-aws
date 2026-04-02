import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

type EmailsResponseData = {
  adminEmail: string;
  allowlist: string[];
  cachedAt?: number;
};

const {
  requireAdminMock,
  getEmailAllowlistMock,
  updateEmailAllowlistMock,
  invalidateAllowlistCacheMock,
  getAllowedEmailsMock,
  getRuntimeStateAdapterMock,
  getSnapshotMock,
  setSnapshotMock,
  snapshotState,
} = vi.hoisted(() => {
  return {
    requireAdminMock: vi.fn(),
    getEmailAllowlistMock: vi.fn(),
    updateEmailAllowlistMock: vi.fn(),
    invalidateAllowlistCacheMock: vi.fn(),
    getAllowedEmailsMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    getSnapshotMock: vi.fn(),
    setSnapshotMock: vi.fn(),
    snapshotState: { value: null as unknown },
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    requireAdmin: requireAdminMock,
  };
});

vi.mock("@/lib/aws", () => {
  return {
    getEmailAllowlist: getEmailAllowlistMock,
    updateEmailAllowlist: updateEmailAllowlistMock,
  };
});

vi.mock("@/lib/allowlist-cache", () => {
  return {
    invalidateAllowlistCache: invalidateAllowlistCacheMock,
  };
});

vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");

  return {
    ...actual,
    getAllowedEmails: getAllowedEmailsMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

describe("GET /api/emails mock/aws parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotState.value = null;

    requireAdminMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    getEmailAllowlistMock.mockResolvedValue(["friend@example.com"]);
    updateEmailAllowlistMock.mockResolvedValue(undefined);
    getAllowedEmailsMock.mockReturnValue([]);

    getSnapshotMock.mockImplementation(async () => {
      if (snapshotState.value) {
        return {
          ok: true,
          data: {
            status: "hit",
            value: snapshotState.value,
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        ok: true,
        data: {
          status: "miss",
        },
      };
    });

    setSnapshotMock.mockImplementation(async ({ value }: { value: unknown }) => {
      snapshotState.value = value;
      return {
        ok: true,
        data: {
          key: "emails:latest",
        },
      };
    });

    getRuntimeStateAdapterMock.mockReturnValue({
      kind: "in-memory",
      incrementCounter: vi.fn(),
      checkCounter: vi.fn(),
      invalidateSnapshot: vi.fn(),
      getSnapshot: getSnapshotMock,
      setSnapshot: setSnapshotMock,
    });
  });

  it.each([{ mode: "aws" }, { mode: "mock" }])("returns success response-contract parity in $mode mode", async () => {
    const req = createMockNextRequest("http://localhost/api/emails");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<EmailsResponseData>>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      allowlist: ["friend@example.com"],
    });
    expect(typeof body.data?.adminEmail).toBe("string");
    expect(typeof body.data?.cachedAt).toBe("number");
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Emails-Cache")).toBe("MISS");
  });

  it.each([{ mode: "aws" }, { mode: "mock" }])("applies refresh semantics in $mode mode", async () => {
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1_000;
      return now;
    });

    const baseReq = createMockNextRequest("http://localhost/api/emails");
    const refreshReq = createMockNextRequest("http://localhost/api/emails?refresh=true");

    const firstRes = await GET(baseReq);
    const firstBody = await parseNextResponse<ApiResponse<EmailsResponseData>>(firstRes);

    const secondRes = await GET(baseReq);
    const secondBody = await parseNextResponse<ApiResponse<EmailsResponseData>>(secondRes);

    const refreshRes = await GET(refreshReq);
    const refreshBody = await parseNextResponse<ApiResponse<EmailsResponseData>>(refreshRes);

    expect(firstBody.success).toBe(true);
    expect(secondBody.success).toBe(true);
    expect(refreshBody.success).toBe(true);

    expect(firstRes.headers.get("X-Emails-Cache")).toBe("MISS");
    expect(secondRes.headers.get("X-Emails-Cache")).toBe("HIT");
    expect(secondBody.data?.cachedAt).toBe(firstBody.data?.cachedAt);

    expect(refreshRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(refreshRes.headers.get("X-Emails-Cache")).toBe("MISS");
    expect(refreshBody.data?.cachedAt).toBeGreaterThan(firstBody.data?.cachedAt ?? 0);

    expect(getEmailAllowlistMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it.each([{ mode: "aws" }, { mode: "mock" }])("returns parity error contract in $mode mode", async () => {
    getEmailAllowlistMock.mockRejectedValue(new Error("allowlist read failure"));

    const req = createMockNextRequest("http://localhost/api/emails");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<EmailsResponseData>>(res);

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch email configuration");
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Emails-Cache")).toBe("MISS");
  });
});
