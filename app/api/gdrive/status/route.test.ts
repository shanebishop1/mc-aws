import type { ApiResponse, GDriveStatusResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  isMockMode: vi.fn(() => false),
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com" }),
  invokeGdriveTokenBroker: vi.fn(),
  mockStoreGetParameter: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  isMockMode: mocks.isMockMode,
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/aws", () => ({
  invokeGdriveTokenBroker: mocks.invokeGdriveTokenBroker,
}));

vi.mock("@/lib/aws/mock-state-store", () => ({
  getMockStateStore: vi.fn(() => ({
    getParameter: mocks.mockStoreGetParameter,
  })),
}));

describe("GET /api/gdrive/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMockMode.mockReturnValue(false);
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com" });
    mocks.invokeGdriveTokenBroker.mockResolvedValue({ configured: true });
    mocks.mockStoreGetParameter.mockResolvedValue("token");
  });

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("returns equivalent success contract in $mode mode", async ({ isMock }) => {
    mocks.isMockMode.mockReturnValue(isMock);

    const req = createMockNextRequest("http://localhost/api/gdrive/status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<GDriveStatusResponse>>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ configured: true });
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    if (isMock) {
      expect(mocks.mockStoreGetParameter).toHaveBeenCalledWith("/minecraft/gdrive-token");
      expect(mocks.invokeGdriveTokenBroker).not.toHaveBeenCalled();
      return;
    }

    expect(mocks.invokeGdriveTokenBroker).toHaveBeenCalledWith({ operation: "get" });
    expect(mocks.mockStoreGetParameter).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("requires admin auth in $mode mode", async ({ isMock }) => {
    mocks.isMockMode.mockReturnValue(isMock);
    mocks.requireAdmin.mockRejectedValue(new Response("Unauthorized", { status: 401 }));

    const req = createMockNextRequest("http://localhost/api/gdrive/status");
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(mocks.invokeGdriveTokenBroker).not.toHaveBeenCalled();
    expect(mocks.mockStoreGetParameter).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "aws", isMock: false },
    { mode: "mock", isMock: true },
  ])("returns formatted error contract with no-store in $mode mode", async ({ isMock }) => {
    mocks.isMockMode.mockReturnValue(isMock);

    if (isMock) {
      mocks.mockStoreGetParameter.mockRejectedValue(new Error("store failure"));
    } else {
      mocks.invokeGdriveTokenBroker.mockRejectedValue(new Error("broker failure"));
    }

    const req = createMockNextRequest("http://localhost/api/gdrive/status");
    const res = await GET(req);
    const body = await parseNextResponse<ApiResponse<GDriveStatusResponse>>(res);

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to check Google Drive status");
    expect(body.timestamp).toBeDefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
