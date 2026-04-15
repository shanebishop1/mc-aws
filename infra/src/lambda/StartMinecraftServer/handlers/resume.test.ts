import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
} from "../clients.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("../clients.js", async () => {
  const actual = await vi.importActual<typeof import("../clients.js")>("../clients.js");
  return {
    ...actual,
    ec2: {
      send: mocks.send,
    },
  };
});

import { handleResume } from "./resume.js";

const getCommands = <T>(commandType: new (...args: never[]) => T): T[] => {
  return mocks.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof commandType);
};

describe("lambda handlers/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [],
                  Placement: { AvailabilityZone: "us-east-1a" },
                  ImageId: "ami-source123",
                  RootDeviceName: "/dev/xvda",
                },
              ],
            },
          ],
        };
      }

      if (command instanceof DescribeImagesCommand) {
        return {
          Images: [
            {
              ImageId: "ami-source123",
              State: "available",
              BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-source123" } }],
            },
          ],
        };
      }

      if (command instanceof CreateVolumeCommand) {
        return {
          VolumeId: "vol-123",
        };
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

  it("reconstructs from instance-pinned AMI source, not latest AMI filters", async () => {
    await handleResume("i-resume");

    const describeImagesCommand = getCommands(DescribeImagesCommand)[0];
    expect(describeImagesCommand).toBeDefined();
    expect(describeImagesCommand.input.ImageIds).toEqual(["ami-source123"]);
    expect(describeImagesCommand.input.Filters).toBeUndefined();

    const createVolumeCommand = getCommands(CreateVolumeCommand)[0];
    expect(createVolumeCommand.input.SnapshotId).toBe("snap-source123");
    expect(createVolumeCommand.input.TagSpecifications?.[0]?.Tags).toEqual(
      expect.arrayContaining([
        { Key: "ReconstructionSourceImageId", Value: "ami-source123" },
        { Key: "ReconstructionSourceSnapshotId", Value: "snap-source123" },
      ])
    );

    const attachCommand = getCommands(AttachVolumeCommand)[0];
    expect(attachCommand).toBeDefined();
    expect(attachCommand.input.InstanceId).toBe("i-resume");
    expect(attachCommand.input.Device).toBe("/dev/xvda");
  });

  it("fails explicitly when source AMI metadata is missing", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [],
                  Placement: { AvailabilityZone: "us-east-1a" },
                  RootDeviceName: "/dev/xvda",
                },
              ],
            },
          ],
        };
      }

      return {};
    });

    await expect(handleResume("i-missing-image")).rejects.toThrow(
      "Could not determine source AMI for instance i-missing-image"
    );
    expect(getCommands(DescribeImagesCommand)).toHaveLength(0);
  });

  it("fails explicitly when source AMI cannot provide root snapshot", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [],
                  Placement: { AvailabilityZone: "us-east-1a" },
                  ImageId: "ami-source123",
                  RootDeviceName: "/dev/xvda",
                },
              ],
            },
          ],
        };
      }

      if (command instanceof DescribeImagesCommand) {
        return {
          Images: [
            {
              ImageId: "ami-source123",
              State: "available",
              BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: {} }],
            },
          ],
        };
      }

      return {};
    });

    await expect(handleResume("i-missing-snapshot")).rejects.toThrow(
      "Could not resolve root snapshot for source AMI ami-source123 and device /dev/xvda"
    );
    expect(getCommands(CreateVolumeCommand)).toHaveLength(0);
  });

  it("skips reconstruction when instance already has block devices", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-existing" } }],
                  Placement: { AvailabilityZone: "us-east-1a" },
                  ImageId: "ami-source123",
                  RootDeviceName: "/dev/xvda",
                },
              ],
            },
          ],
        };
      }

      return {};
    });

    await expect(handleResume("i-existing")).resolves.toBeUndefined();

    expect(getCommands(DescribeImagesCommand)).toHaveLength(0);
    expect(getCommands(CreateVolumeCommand)).toHaveLength(0);
    expect(getCommands(AttachVolumeCommand)).toHaveLength(0);
  });

  it("propagates attach failures without falling back to alternative source selection", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [],
                  Placement: { AvailabilityZone: "us-east-1a" },
                  ImageId: "ami-source123",
                  RootDeviceName: "/dev/xvda",
                },
              ],
            },
          ],
        };
      }

      if (command instanceof DescribeImagesCommand) {
        return {
          Images: [
            {
              ImageId: "ami-source123",
              State: "available",
              BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-source123" } }],
            },
          ],
        };
      }

      if (command instanceof CreateVolumeCommand) {
        return {
          VolumeId: "vol-created",
        };
      }

      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "available",
            },
          ],
        };
      }

      if (command instanceof AttachVolumeCommand) {
        throw new Error("attach failed");
      }

      return {};
    });

    await expect(handleResume("i-attach-fail")).rejects.toThrow("attach failed");

    expect(getCommands(DescribeImagesCommand)).toHaveLength(1);
    expect(getCommands(CreateVolumeCommand)).toHaveLength(1);
  });
});
