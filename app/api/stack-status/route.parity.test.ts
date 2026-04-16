import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";
import { resetProvider } from "@/lib/aws/provider-selector";
import type { ApiResponse, StackStatusResponse } from "@/lib/types";
import { createRuntimeStateAdapterFixture, freezeTime, restoreTime } from "@/tests/fixtures";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getAuthUserMock, checkRateLimitMock, getRuntimeStateAdapterMock, cloudformationSendMock } = vi.hoisted(() => {
  return {
    getAuthUserMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    cloudformationSendMock: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => {
  return {
    getAuthUser: getAuthUserMock,
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");

  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

vi.mock("@aws-sdk/client-cloudformation", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cloudformation")>(
    "@aws-sdk/client-cloudformation"
  );

  return {
    ...actual,
    CloudFormationClient: class {
      send = cloudformationSendMock;
    },
  };
});

type StackStatusResult = {
  status: number;
  body: ApiResponse<StackStatusResponse>;
  cacheControl: string | null;
  vary: string | null;
  cacheHeader: string | null;
};

describe("GET /api/stack-status mock/aws parity", () => {
  beforeEach(() => {
    freezeTime("2026-02-03T04:05:06.000Z");
    resetProvider();
    resetMockStateStore();
    vi.unstubAllEnvs();

    getAuthUserMock.mockResolvedValue(null);
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 10,
      retryAfterSeconds: 0,
    });
  });

  afterEach(() => {
    restoreTime();
    vi.unstubAllEnvs();
  });

  const runStackStatusInMode = async (mode: "aws" | "mock"): Promise<StackStatusResult> => {
    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", mode);
    cloudformationSendMock.mockReset();

    const runtimeStateFixture = createRuntimeStateAdapterFixture();
    getRuntimeStateAdapterMock.mockReturnValue(runtimeStateFixture.adapter);

    if (mode === "aws") {
      cloudformationSendMock.mockResolvedValue({
        Stacks: [
          {
            StackStatus: "CREATE_COMPLETE",
            StackId: "stack-123",
          },
        ],
      });
    } else {
      const stateStore = getMockStateStore();
      await stateStore.setStackStatus({
        exists: true,
        status: "CREATE_COMPLETE",
        stackId: "stack-123",
      });
    }

    const res = await GET(createMockNextRequest("http://localhost/api/stack-status"));

    return {
      status: res.status,
      body: await parseNextResponse<ApiResponse<StackStatusResponse>>(res),
      cacheControl: res.headers.get("Cache-Control"),
      vary: res.headers.get("Vary"),
      cacheHeader: res.headers.get("X-Stack-Status-Cache"),
    };
  };

  it("keeps anonymous success response contract parity between mock and aws", async () => {
    getAuthUserMock.mockResolvedValue(null);

    const awsResult = await runStackStatusInMode("aws");
    const mockResult = await runStackStatusInMode("mock");

    for (const result of [awsResult, mockResult]) {
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.timestamp).toBe("2026-02-03T04:05:06.000Z");
      expect(result.body.data).toEqual({
        exists: true,
        status: "CREATE_COMPLETE",
        stackId: "redacted",
      });
      expect(result.cacheControl).toBe("public, s-maxage=30, stale-while-revalidate=120");
      expect(result.cacheHeader).toBe("MISS");
      expect(result.vary).toBe("Cookie");
    }
  });

  it("keeps authenticated visibility + cache-header parity between mock and aws", async () => {
    getAuthUserMock.mockResolvedValue({ email: "admin@example.com", role: "admin" });

    const awsResult = await runStackStatusInMode("aws");
    const mockResult = await runStackStatusInMode("mock");

    for (const result of [awsResult, mockResult]) {
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data?.exists).toBe(true);
      expect(result.body.data?.status).toBe("CREATE_COMPLETE");
      expect(result.body.data?.stackId).toBe("stack-123");
      expect(result.cacheControl).toBe("private, no-store");
      expect(result.cacheHeader).toBe("MISS");
      expect(result.vary).toBe("Cookie");
    }
  });

  it("uses configured CloudFormation stack name in aws mode", async () => {
    getAuthUserMock.mockResolvedValue(null);

    const runtimeStateFixture = createRuntimeStateAdapterFixture();
    getRuntimeStateAdapterMock.mockReturnValue(runtimeStateFixture.adapter);
    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("CLOUDFORMATION_STACK_NAME", "CustomMinecraftStack");
    cloudformationSendMock.mockReset();
    cloudformationSendMock.mockResolvedValue({
      Stacks: [
        {
          StackStatus: "CREATE_COMPLETE",
          StackId: "stack-123",
        },
      ],
    });

    const response = await GET(createMockNextRequest("http://localhost/api/stack-status"));

    expect(response.status).toBe(200);
    expect(cloudformationSendMock).toHaveBeenCalledTimes(1);
    expect(cloudformationSendMock.mock.calls[0]?.[0]).toMatchObject({
      input: {
        StackName: "CustomMinecraftStack",
      },
    });
  });

  it("maps provider failures to same error contract with no-store caching", async () => {
    getAuthUserMock.mockResolvedValue(null);

    const awsRuntimeStateFixture = createRuntimeStateAdapterFixture();
    getRuntimeStateAdapterMock.mockReturnValue(awsRuntimeStateFixture.adapter);
    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    cloudformationSendMock.mockReset();
    cloudformationSendMock.mockRejectedValueOnce(new Error("AWS stack failure"));
    const awsResponse = await GET(createMockNextRequest("http://localhost/api/stack-status"));
    const awsBody = await parseNextResponse<ApiResponse<StackStatusResponse>>(awsResponse);

    const mockRuntimeStateFixture = createRuntimeStateAdapterFixture();
    getRuntimeStateAdapterMock.mockReturnValue(mockRuntimeStateFixture.adapter);
    resetProvider();
    vi.stubEnv("MC_BACKEND_MODE", "mock");
    const stateStore = getMockStateStore();
    await stateStore.setOperationFailure("getStackStatus", {
      failNext: true,
      alwaysFail: false,
      errorMessage: "Mock stack failure",
      errorCode: "MockError",
    });
    const mockResponse = await GET(createMockNextRequest("http://localhost/api/stack-status"));
    const mockBody = await parseNextResponse<ApiResponse<StackStatusResponse>>(mockResponse);

    for (const [response, body] of [
      [awsResponse, awsBody],
      [mockResponse, mockBody],
    ] as const) {
      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("Failed to fetch stack status");
      expect(body.timestamp).toBe("2026-02-03T04:05:06.000Z");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Stack-Status-Cache")).toBeNull();
    }
  });
});
