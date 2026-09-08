import type { ApiResponse, ListBackupsResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findInstanceId: vi.fn(),
  getInstanceState: vi.fn(),
  getParameter: vi.fn(),
  invokeLambda: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/aws", () => ({
  findInstanceId: mocks.findInstanceId,
  getInstanceState: mocks.getInstanceState,
  getParameter: mocks.getParameter,
  invokeLambda: mocks.invokeLambda,
}));

import { GET } from "./route";

const backup = {
  name: "hibernate.tar.gz",
  size: "42",
  date: "2026-09-04T00:00:00Z",
  backupId: "b".repeat(32),
  digest: "a".repeat(64),
  generation: 7,
  createdAt: "2026-09-04T00:00:00Z",
  instanceId: "i-abc123456",
  serverId: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id",
  authenticationKeyId: "key-old",
  operationKey: null,
};
const authenticatedReadyCache = JSON.stringify({ status: "ready", backups: [backup], cachedAt: 1 });
const legacyUnauthenticatedCache = JSON.stringify({
  backups: [{ name: "hibernate.tar.gz", size: "42", date: "2026-09-04T00:00:00Z" }],
  cachedAt: 1,
});

describe("GET /api/backups cache lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com" });
    mocks.findInstanceId.mockResolvedValue("i-abc123456");
    mocks.getParameter.mockResolvedValue(authenticatedReadyCache);
    mocks.invokeLambda.mockResolvedValue(undefined);
  });

  it("launches the first refresh when no cache exists", async () => {
    mocks.getParameter.mockResolvedValueOnce(null);

    const response = await GET(createMockNextRequest("http://localhost/api/backups"));
    const body = await parseNextResponse<ApiResponse<ListBackupsResponse>>(response);

    expect(response.status).toBe(202);
    expect(body.data?.status).toBe("caching");
    expect(mocks.invokeLambda).toHaveBeenCalledTimes(1);
  });

  it("does not serve a legacy unauthenticated cache as a listing", async () => {
    mocks.getParameter.mockResolvedValueOnce(legacyUnauthenticatedCache);

    const response = await GET(createMockNextRequest("http://localhost/api/backups"));
    const body = await parseNextResponse<ApiResponse<ListBackupsResponse>>(response);

    expect(response.status).toBe(202);
    expect(body.data?.status).toBe("caching");
    expect(body.data?.backups).toEqual([]);
    expect(mocks.invokeLambda).toHaveBeenCalledTimes(1);
  });

  it("serves previous backups immediately while a refresh is pending", async () => {
    const now = Date.now();
    mocks.getParameter.mockResolvedValueOnce(
      JSON.stringify({ status: "pending", backups: [backup], cachedAt: 1, startedAt: now, updatedAt: now })
    );

    const response = await GET(createMockNextRequest("http://localhost/api/backups"));
    const body = await parseNextResponse<ApiResponse<ListBackupsResponse>>(response);

    expect(response.status).toBe(200);
    expect(body.data?.status).toBe("listing");
    expect(body.data?.backups).toEqual([backup]);
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("surfaces a recent safe asynchronous failure without provider details", async () => {
    const now = Date.now();
    mocks.getParameter.mockResolvedValueOnce(
      JSON.stringify({
        status: "failed",
        backups: [backup],
        cachedAt: 1,
        startedAt: now - 1000,
        updatedAt: now,
        retryAt: now + 30_000,
      })
    );

    const response = await GET(createMockNextRequest("http://localhost/api/backups"));
    const body = await parseNextResponse<ApiResponse<ListBackupsResponse>>(response);

    expect(response.status).toBe(200);
    expect(body.data?.status).toBe("error");
    expect(body.data?.errorMessage).toContain("Check Drive API and OAuth configuration");
    expect(body.data?.errorMessage).not.toContain("403");
    expect(body.data?.backups).toEqual([backup]);
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it.each([
    { status: "pending", retryAt: undefined, updatedAt: 1 },
    { status: "failed", retryAt: 1, updatedAt: 1 },
  ])("launches one retry after stale $status state", async ({ status, retryAt, updatedAt }) => {
    mocks.getParameter.mockResolvedValueOnce(
      JSON.stringify({ status, backups: [backup], cachedAt: 1, startedAt: 1, updatedAt, retryAt })
    );

    const response = await GET(createMockNextRequest("http://localhost/api/backups"));

    expect(response.status).toBe(200);
    expect(mocks.invokeLambda).toHaveBeenCalledTimes(1);
  });

  it("serves a ready cache without an EC2 state lookup", async () => {
    const response = await GET(createMockNextRequest("http://localhost/api/backups"));

    expect(response.status).toBe(200);
    expect(mocks.getInstanceState).not.toHaveBeenCalled();
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("does not explicitly refresh a hibernated instance", async () => {
    mocks.getInstanceState.mockResolvedValue(ServerState.Hibernating);

    const response = await GET(createMockNextRequest("http://localhost/api/backups?refresh=true"));

    expect(response.status).toBe(200);
    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });

  it("honors an explicit refresh for an ordinarily stopped instance", async () => {
    mocks.getInstanceState.mockResolvedValue(ServerState.Stopped);

    const response = await GET(createMockNextRequest("http://localhost/api/backups?refresh=true"));

    expect(response.status).toBe(200);
    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "refreshBackups",
      instanceId: "i-abc123456",
      userEmail: "admin@example.com",
    });
  });
});
