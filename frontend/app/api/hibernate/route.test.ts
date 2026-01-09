import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/test/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/hibernate", () => {
  it("should hibernate successfully when running", async () => {
    const { mockEC2Client, mockSSMClient } = await import("@/test/mocks/aws");

    // Sequence:
    // 1. getInstanceState -> running
    // 2. executeSSMCommand (backup) -> SendCommand
    // 3. executeSSMCommand (backup) -> GetCommandInvocation
    // 4. stopInstance -> success
    // 5. waitForInstanceStopped -> stopped
    // 6. detachAndDeleteVolumes -> DescribeInstances
    // 7. detachAndDeleteVolumes -> DetachVolume
    // 8. detachAndDeleteVolumes (waitForVolumeDetached) -> DescribeVolumes
    // 9. detachAndDeleteVolumes -> DeleteVolume

    mockEC2Client.send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }],
    }); // getInstanceState

    mockSSMClient.send
      .mockResolvedValueOnce({ Command: { CommandId: "cmd-123" } }) // SendCommand
      .mockResolvedValueOnce({ Status: "Success", StandardOutputContent: "Backup successful" }); // GetCommandInvocation

    mockEC2Client.send
      .mockResolvedValueOnce({}) // stopInstance
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] }) // waitForInstanceStopped
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-123" } }] }] }],
      }) // detachAndDeleteVolumes -> DescribeInstances
      .mockResolvedValueOnce({}) // detachAndDeleteVolumes -> DetachVolume
      .mockResolvedValueOnce({ Volumes: [{ Attachments: [] }] }) // detachAndDeleteVolumes (waitForVolumeDetached) -> DescribeVolumes
      .mockResolvedValueOnce({}); // detachAndDeleteVolumes -> DeleteVolume

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<HibernateResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupOutput).toBe("Backup successful");
  });

  it("should return 400 when instance is not running", async () => {
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

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");
  });
});
