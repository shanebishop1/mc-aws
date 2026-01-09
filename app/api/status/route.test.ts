import { type ApiResponse, ServerState, type ServerStatusResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/status", () => {
  it("should return running status when instance is running", async () => {
    const publicIp = "1.2.3.4";
    setupInstanceState("running", publicIp);

    const req = createMockNextRequest("http://localhost/api/status");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

    expect(body.success).toBe(true);
    expect(body.data?.state).toBe(ServerState.Running);
    expect(body.data?.publicIp).toBe(publicIp);
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
    expect(body.error).toBe("AWS Error");
  });
});
