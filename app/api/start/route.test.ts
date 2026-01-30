import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Mock Cloudflare DNS update
vi.mock("@/lib/cloudflare", () => ({
  updateCloudflareDns: vi.fn().mockResolvedValue(undefined),
}));

describe("POST /api/start", () => {
  it("should start the server successfully when stopped", async () => {
    // 1. Initially stopped
    setupInstanceState("stopped");

    // We need to mock the sequence of states for polling
    const { mockEC2Client, mockSSMClient } = await import("@/tests/mocks/aws");

    // Mock SSM GetParameter to return null (no action in progress)
    mockSSMClient.send.mockResolvedValueOnce({ Parameter: { Value: null } });

    // getInstanceState -> stopped
    // handleResume -> calls describeInstances? Yes
    // startInstance -> calls StartInstancesCommand
    // waitForInstanceRunning -> polls describeInstances until running
    // getPublicIp -> polls describeInstances until running + IP

    mockEC2Client.send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: "stopped" }, InstanceId: "i-1234" }] }] }) // getInstanceState
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { State: { Name: "stopped" }, InstanceId: "i-1234", BlockDeviceMappings: [{ DeviceName: "/dev/sda1" }] },
            ],
          },
        ],
      }) // handleResume check
      .mockResolvedValueOnce({}) // startInstance (StartInstancesCommand)
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ State: { Name: "running" }, InstanceId: "i-1234", PublicIpAddress: "1.2.3.4" }] },
        ],
      }) // waitForInstanceRunning
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ State: { Name: "running" }, InstanceId: "i-1234", PublicIpAddress: "1.2.3.4" }] },
        ],
      }); // getPublicIp

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.publicIp).toBe("1.2.3.4");
    expect(body.data?.message).toContain("started successfully");
  });

  it("should return 400 when instance is already running", async () => {
    const { mockSSMClient } = await import("@/tests/mocks/aws");

    // Mock SSM GetParameter to return null (no action in progress)
    mockSSMClient.send.mockResolvedValueOnce({ Parameter: { Value: null } });

    setupInstanceState("running", "1.2.3.4");

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");
  });
});
