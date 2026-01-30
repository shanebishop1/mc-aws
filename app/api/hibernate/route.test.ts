import type { ApiResponse, HibernateResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/hibernate", () => {
  it("should hibernate successfully when running", async () => {
    const { mockEC2Client, mockSSMClient } = await import("@/tests/mocks/aws");

    // Sequence:
    // 1. getServerAction (SSM GetParameter) -> null (no action in progress)
    // 2. setServerAction (SSM PutParameter) -> success
    // 3. getInstanceState -> running
    // 4. executeSSMCommand (backup) -> SendCommand
    // 5. executeSSMCommand (backup) -> GetCommandInvocation
    // 6. stopInstance -> success
    // 7. waitForInstanceStopped -> stopped
    // 8. detachAndDeleteVolumes -> DescribeInstances
    // 9. detachAndDeleteVolumes -> DetachVolume
    // 10. detachAndDeleteVolumes (waitForVolumeDetached) -> DescribeVolumes
    // 11. detachAndDeleteVolumes -> DeleteVolume
    // 12. deleteParameter (SSM DeleteParameter) -> success

    // SSM calls
    mockSSMClient.send
      .mockResolvedValueOnce({ Parameter: { Value: null } }) // getServerAction (GetParameter)
      .mockResolvedValueOnce({}) // setServerAction (PutParameter)
      .mockResolvedValueOnce({ Command: { CommandId: "cmd-123" } }) // SendCommand
      .mockResolvedValueOnce({ Status: "Success", StandardOutputContent: "Backup successful" }) // GetCommandInvocation
      .mockResolvedValueOnce({}); // deleteParameter (DeleteParameter) - called in finally block

    // EC2 calls
    mockEC2Client.send
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: "running" }, InstanceId: "i-1234" }] }],
      }) // getInstanceState
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

    const req = createMockNextRequest("http://localhost/api/hibernate", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");
  });
});
