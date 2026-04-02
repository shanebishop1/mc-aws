import { resetProvider } from "@/lib/aws/provider-selector";
import { type ApiResponse, ServerState, type ServerStatusResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/status", () => {
  let previousBackendMode: string | undefined;

  beforeEach(() => {
    previousBackendMode = process.env.MC_BACKEND_MODE;
    process.env.MC_BACKEND_MODE = "aws";
    resetProvider();
  });

  afterEach(() => {
    if (previousBackendMode === undefined) {
      process.env.MC_BACKEND_MODE = undefined;
    } else {
      process.env.MC_BACKEND_MODE = previousBackendMode;
    }
    resetProvider();
  });

  it("should return running status when instance is running", async () => {
    setupInstanceState("running");

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

    expect(body.success).toBe(true);
    expect(body.data?.state).toBe(ServerState.Running);
    expect(body.data?.domain).toBe("mc.example.com");
    expect(body.data?.instanceId).toBe("i-1234567890abcdef0");
  });

  it("should return hibernating status when instance is stopped without volume", async () => {
    // In our logic, stopped + no block devices = hibernating
    setupInstanceState("stopped", undefined, false);

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

    expect(body.success).toBe(true);
    expect(body.data?.state).toBe(ServerState.Hibernating);
  });

  it("should return 500 when AWS call fails", async () => {
    // Import the mock client to simulate failure
    const { mockEC2Client } = await import("@/tests/mocks/aws");
    mockEC2Client.send.mockRejectedValueOnce(new Error("AWS Error"));

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Failed to fetch server status");
  });
});
