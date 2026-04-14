import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DescribeImagesCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getInstanceDetails: vi.fn(),
  findInstanceId: vi.fn(),
}));

vi.mock("./ec2-client", () => ({
  ec2: { send: mocks.send },
  getInstanceDetails: mocks.getInstanceDetails,
  findInstanceId: mocks.findInstanceId,
}));

import { handleResume } from "./volume-client";

describe("volume-client handleResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.findInstanceId.mockResolvedValue("i-resolved");
    mocks.getInstanceDetails.mockResolvedValue({
      blockDeviceMappings: [],
      az: "us-east-1a",
    });

    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) {
        return {
          Images: [
            {
              ImageId: "ami-123",
              CreationDate: "2026-01-01T00:00:00.000Z",
              BlockDeviceMappings: [{ Ebs: { SnapshotId: "snap-123" } }],
            },
          ],
        };
      }

      if (command instanceof CreateVolumeCommand) {
        return { VolumeId: "vol-123" };
      }

      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "available",
              Attachments: [{ State: "attached" }],
            },
          ],
        };
      }

      return {};
    });
  });

  it("attaches restored volume to resolved instance id when no id is provided", async () => {
    await handleResume();

    const attachCall = mocks.send.mock.calls.find(([command]) => command instanceof AttachVolumeCommand);
    expect(attachCall).toBeDefined();

    const attachCommand = attachCall?.[0] as AttachVolumeCommand;
    expect(attachCommand.input.InstanceId).toBe("i-resolved");
    expect(attachCommand.input.Device).toBe("/dev/xvda");
  });
});
