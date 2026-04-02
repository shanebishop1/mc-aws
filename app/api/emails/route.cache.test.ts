import { snapshotCacheTtlSeconds } from "@/lib/runtime-state/snapshot-cache";
import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireAdminMock,
  getEmailAllowlistMock,
  updateEmailAllowlistMock,
  invalidateAllowlistCacheMock,
  getAllowedEmailsMock,
  getRuntimeStateAdapterMock,
  getSnapshotMock,
  setSnapshotMock,
  invalidateSnapshotMock,
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
    invalidateSnapshotMock: vi.fn(),
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

describe("emails routes cache contract", () => {
  beforeEach(() => {
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

    invalidateSnapshotMock.mockImplementation(async () => {
      snapshotState.value = null;
      return {
        ok: true,
        data: {
          key: "emails:latest",
          invalidated: true,
        },
      };
    });

    getRuntimeStateAdapterMock.mockReturnValue({
      kind: "in-memory",
      incrementCounter: vi.fn(),
      checkCounter: vi.fn(),
      getSnapshot: getSnapshotMock,
      setSnapshot: setSnapshotMock,
      invalidateSnapshot: invalidateSnapshotMock,
    });
  });

  it("serves cached GET response and invalidates cache on PUT", async () => {
    const { GET } = await import("./route");
    const { PUT } = await import("./allowlist/route");

    const getRequest = createMockNextRequest("http://localhost/api/emails");
    const firstGet = await GET(getRequest);
    const firstBody =
      await parseNextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>(firstGet);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data).toMatchObject({
      allowlist: ["friend@example.com"],
    });
    expect(typeof firstBody.data?.adminEmail).toBe("string");
    expect(firstBody.data?.cachedAt).toBeDefined();
    expect(firstGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(firstGet.headers.get("X-Emails-Cache")).toBe("MISS");

    expect(setSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "emails:latest",
        ttlSeconds: snapshotCacheTtlSeconds.emails,
      })
    );

    const secondGet = await GET(getRequest);
    const secondBody =
      await parseNextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>(secondGet);
    expect(secondBody.success).toBe(true);
    expect(secondBody.data).toMatchObject({
      allowlist: ["friend@example.com"],
    });
    expect(typeof secondBody.data?.adminEmail).toBe("string");
    expect(secondBody.data?.cachedAt).toBe(firstBody.data?.cachedAt);
    expect(secondGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(secondGet.headers.get("X-Emails-Cache")).toBe("HIT");
    expect(getEmailAllowlistMock).toHaveBeenCalledTimes(1);

    const putRequest = createMockNextRequest("http://localhost/api/emails/allowlist", {
      method: "PUT",
      body: JSON.stringify({ emails: ["new-user@example.com"] }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const putResponse = await PUT(putRequest);
    expect(putResponse.status).toBe(200);
    expect(invalidateSnapshotMock).toHaveBeenCalledWith({ key: "emails:latest" });

    const thirdGet = await GET(getRequest);
    const thirdBody =
      await parseNextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>(thirdGet);
    expect(thirdBody.success).toBe(true);
    expect(thirdGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(thirdGet.headers.get("X-Emails-Cache")).toBe("MISS");
    expect(getEmailAllowlistMock).toHaveBeenCalledTimes(2);
  });

  it("forces a fresh email fetch when refresh=true", async () => {
    const { GET } = await import("./route");
    const baseRequest = createMockNextRequest("http://localhost/api/emails");
    const refreshRequest = createMockNextRequest("http://localhost/api/emails?refresh=true");

    const firstGet = await GET(baseRequest);
    const firstBody =
      await parseNextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>(firstGet);
    expect(firstBody.success).toBe(true);
    expect(firstGet.headers.get("X-Emails-Cache")).toBe("MISS");

    const refreshGet = await GET(refreshRequest);
    const refreshBody =
      await parseNextResponse<ApiResponse<{ adminEmail: string; allowlist: string[]; cachedAt?: number }>>(refreshGet);
    expect(refreshBody.success).toBe(true);
    expect(refreshGet.headers.get("Cache-Control")).toBe("private, no-store");
    expect(refreshGet.headers.get("X-Emails-Cache")).toBe("MISS");

    expect(getEmailAllowlistMock).toHaveBeenCalledTimes(2);
  });
});
