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
    const firstBody = await parseNextResponse<ApiResponse<{ cachedAt?: number }>>(firstGet);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data?.cachedAt).toBeDefined();

    const secondGet = await GET(getRequest);
    const secondBody = await parseNextResponse<ApiResponse<{ cachedAt?: number }>>(secondGet);
    expect(secondBody.success).toBe(true);
    expect(secondBody.data?.cachedAt).toBe(firstBody.data?.cachedAt);
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
    const thirdBody = await parseNextResponse<ApiResponse<{ cachedAt?: number }>>(thirdGet);
    expect(thirdBody.success).toBe(true);
    expect(getEmailAllowlistMock).toHaveBeenCalledTimes(2);
  });
});
