import { resetProvider } from "@/lib/aws/provider-selector";
import type { ApiResponse, StopServerResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/stop", () => {
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

  it("should stop the server successfully when running", async () => {
    const { mockEC2Client, mockSSMClient } = await import("@/tests/mocks/aws");

    // Mock SSM GetParameter to return null (no action in progress)
    mockSSMClient.send.mockResolvedValueOnce({ Parameter: { Value: null } });

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
    expect(body.operation?.type).toBe("stop");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("stop-");
  });

  it("should return 400 when instance is already stopped", async () => {
    const { mockEC2Client, mockSSMClient } = await import("@/tests/mocks/aws");

    // Mock SSM GetParameter to return null (no action in progress)
    mockSSMClient.send.mockResolvedValueOnce({ Parameter: { Value: null } });

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
    expect(body.operation?.status).toBe("failed");
  });
});
