import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/test/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/stop", () => {
  it("should stop the server successfully when running", async () => {
    const { mockEC2Client } = await import("@/test/mocks/aws");

    // 1. getInstanceState -> running
    // 2. stopInstance -> success
    mockEC2Client.send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }] })
      .mockResolvedValueOnce({});

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StopServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("stop command sent successfully");
  });

  it("should return 400 when instance is already stopped", async () => {
    const { mockEC2Client } = await import("@/test/mocks/aws");

    // 1. getInstanceState -> stopped
    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            { State: { Name: "stopped" }, InstanceId: "i-1234", BlockDeviceMappings: [{ DeviceName: "/dev/sda1" }] },
          ],
        },
      ],
    });

    const req = createMockNextRequest("http://localhost/api/stop", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already stopped");
  });
});
