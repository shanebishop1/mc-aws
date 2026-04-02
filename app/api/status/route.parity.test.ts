import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";
import { resetProvider } from "@/lib/aws/provider-selector";
import { type ApiResponse, ServerState, type ServerStatusResponse } from "@/lib/types";
import { freezeTime, restoreTime } from "@/tests/fixtures";
import { mockEC2Client } from "@/tests/mocks/aws";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getAuthUserMock } = vi.hoisted(() => {
  return {
    getAuthUserMock: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    getAuthUser: getAuthUserMock,
  };
});

type StatusResult = {
  status: number;
  body: ApiResponse<ServerStatusResponse>;
  cacheControl: string | null;
  vary: string | null;
  cacheHeader: string | null;
};

describe("GET /api/status mock/aws parity", () => {
  beforeEach(() => {
    freezeTime("2026-02-03T04:05:06.000Z");
    resetProvider();
    resetMockStateStore();
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    getAuthUserMock.mockResolvedValue(null);
  });

  afterEach(() => {
    restoreTime();
    vi.unstubAllEnvs();
  });

  const runStatusInMode = async (mode: "aws" | "mock"): Promise<StatusResult> => {
    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", mode);

    if (mode === "aws") {
      setupInstanceState("running", undefined, true);
    } else {
      const stateStore = getMockStateStore();
      await stateStore.updateInstanceState(ServerState.Running);
      await stateStore.setHasVolume(true);
    }

    const res = await GET(createMockNextRequest("http://localhost/api/status"));

    return {
      status: res.status,
      body: await parseNextResponse<ApiResponse<ServerStatusResponse>>(res),
      cacheControl: res.headers.get("Cache-Control"),
      vary: res.headers.get("Vary"),
      cacheHeader: res.headers.get("X-Status-Cache"),
    };
  };

  it("keeps anonymous success response contract parity between mock and aws", async () => {
    getAuthUserMock.mockResolvedValue(null);

    const awsResult = await runStatusInMode("aws");
    const mockResult = await runStatusInMode("mock");

    expect(awsResult.status).toBe(200);
    expect(mockResult.status).toBe(200);

    for (const result of [awsResult, mockResult]) {
      expect(result.body.success).toBe(true);
      expect(result.body.timestamp).toBe("2026-02-03T04:05:06.000Z");
      expect(result.body.data).toMatchObject({
        state: "running",
        domain: "mc.example.com",
        hasVolume: true,
        instanceId: "redacted",
        lastUpdated: "2026-02-03T04:05:06.000Z",
      });

      expect(result.cacheHeader).toBe("MISS");
      expect(result.cacheControl).toBe("public, s-maxage=5, stale-while-revalidate=25");
      expect(result.vary).toBe("Cookie");
    }
  });

  it("keeps authenticated visibility + cache-header parity between mock and aws", async () => {
    getAuthUserMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });

    const awsResult = await runStatusInMode("aws");
    const mockResult = await runStatusInMode("mock");

    for (const result of [awsResult, mockResult]) {
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data?.instanceId).toBeDefined();
      expect(result.body.data?.instanceId).not.toBe("redacted");
      expect(result.body.data?.state).toBe("running");
      expect(result.body.data?.hasVolume).toBe(true);
      expect(result.cacheHeader).toBe("MISS");
      expect(result.cacheControl).toBe("private, no-store");
      expect(result.vary).toBe("Cookie");
    }
  });

  it("maps provider failures to same error contract with no-store caching", async () => {
    getAuthUserMock.mockResolvedValue(null);

    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    mockEC2Client.send.mockRejectedValueOnce(new Error("AWS details failure"));
    const awsResponse = await GET(createMockNextRequest("http://localhost/api/status"));
    const awsBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(awsResponse);

    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", "mock");
    const stateStore = getMockStateStore();
    await stateStore.setOperationFailure("getInstanceDetails", {
      failNext: true,
      alwaysFail: false,
      errorMessage: "Mock details failure",
      errorCode: "MockError",
    });
    const mockResponse = await GET(createMockNextRequest("http://localhost/api/status"));
    const mockBody = await parseNextResponse<ApiResponse<ServerStatusResponse>>(mockResponse);

    for (const [response, body] of [
      [awsResponse, awsBody],
      [mockResponse, mockBody],
    ] as const) {
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("Failed to fetch server status");
      expect(body.timestamp).toBe("2026-02-03T04:05:06.000Z");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Status-Cache")).toBeNull();
    }
  });
});
