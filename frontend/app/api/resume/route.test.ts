import type { ApiResponse, ResumeResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/test/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Mock Cloudflare DNS update
vi.mock("@/lib/cloudflare", () => ({
  updateCloudflareDns: vi.fn().mockResolvedValue(undefined),
}));

describe("POST /api/resume", () => {
  it("should resume successfully from hibernating state", async () => {
    // 1. Initially hibernating (stopped + no volume)
    setupInstanceState("stopped", undefined, false);

    const { mockEC2Client } = await import("@/test/mocks/aws");

    // getInstanceState -> hibernating
    // handleResume:
    //   getInstanceDetails -> returns no volumes
    //   DescribeImages -> returns AMI
    //   CreateVolume -> returns vol-123
    //   DescribeVolumes (waitForVolumeAvailable) -> returns available
    //   AttachVolume -> returns {}
    //   DescribeVolumes (waitForVolumeAttached) -> returns attached
    // startInstance -> returns {}
    // waitForInstanceRunning -> returns running
    // getPublicIp -> returns IP

    mockEC2Client.send
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: "stopped" }, BlockDeviceMappings: [] }] }],
      }) // getInstanceState
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { State: { Name: "stopped" }, BlockDeviceMappings: [], Placement: { AvailabilityZone: "us-east-1a" } },
            ],
          },
        ],
      }) // handleResume -> getInstanceDetails
      .mockResolvedValueOnce({
        Images: [
          {
            ImageId: "ami-123",
            CreationDate: "2023-01-01",
            BlockDeviceMappings: [{ Ebs: { SnapshotId: "snap-123" } }],
          },
        ],
      }) // handleResume -> DescribeImages
      .mockResolvedValueOnce({ VolumeId: "vol-123" }) // handleResume -> CreateVolume
      .mockResolvedValueOnce({ Volumes: [{ State: "available" }] }) // handleResume -> waitForVolumeAvailable
      .mockResolvedValueOnce({}) // handleResume -> AttachVolume
      .mockResolvedValueOnce({ Volumes: [{ Attachments: [{ State: "attached" }] }] }) // handleResume -> waitForVolumeAttached
      .mockResolvedValueOnce({}) // startInstance
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: "running" }, PublicIpAddress: "1.2.3.4" }] }],
      }) // waitForInstanceRunning
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ State: { Name: "running" }, PublicIpAddress: "1.2.3.4" }] }],
      }); // getPublicIp

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<ResumeResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.publicIp).toBe("1.2.3.4");
    expect(body.data?.message).toContain("resumed successfully");
  });

  it("should return 400 when instance is already running", async () => {
    setupInstanceState("running", "1.2.3.4");

    const req = createMockNextRequest("http://localhost/api/resume", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");
  });
});
