import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
} from "@aws-sdk/client-ec2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { detachAndDeleteVolumes, handleResume } from "./volume-client";

const getCommands = <T>(commandType: new (...args: never[]) => T): T[] => {
  return mocks.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof commandType);
};

describe("volume-client handleResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mocks.findInstanceId.mockResolvedValue("i-resolved");
    mocks.getInstanceDetails.mockResolvedValue({
      instance: {
        ImageId: "ami-source123",
        RootDeviceName: "/dev/xvda",
      },
      blockDeviceMappings: [],
      az: "us-east-1a",
    });

    mocks.send.mockImplementation(async (command: unknown) => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses instance ImageId as pinned reconstruction source and attaches to resolved instance", async () => {
    await handleResume();

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
    expect(attachCommand.input.InstanceId).toBe("i-resolved");
    expect(attachCommand.input.Device).toBe("/dev/xvda");
  });

  it("fails explicitly when source AMI cannot be determined", async () => {
    mocks.getInstanceDetails.mockResolvedValue({
      instance: {
        RootDeviceName: "/dev/xvda",
      },
      blockDeviceMappings: [],
      az: "us-east-1a",
    });

    await expect(handleResume("i-explicit")).rejects.toThrow("Could not determine source AMI for instance i-explicit");
    expect(getCommands(DescribeImagesCommand)).toHaveLength(0);
    expect(getCommands(CreateVolumeCommand)).toHaveLength(0);
  });

  it("fails explicitly when pinned source AMI cannot provide a root snapshot", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
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

    await expect(handleResume()).rejects.toThrow(
      "Could not resolve root snapshot for source AMI ami-source123 and device /dev/xvda"
    );
    expect(getCommands(CreateVolumeCommand)).toHaveLength(0);
  });

  it("skips reconstruction when instance already has volumes", async () => {
    mocks.getInstanceDetails.mockResolvedValue({
      instance: {
        ImageId: "ami-source123",
        RootDeviceName: "/dev/xvda",
      },
      blockDeviceMappings: [{ Ebs: { VolumeId: "vol-existing" } }],
      az: "us-east-1a",
    });

    await expect(handleResume("i-existing")).resolves.toBeUndefined();

    expect(getCommands(DescribeImagesCommand)).toHaveLength(0);
    expect(getCommands(CreateVolumeCommand)).toHaveLength(0);
    expect(getCommands(AttachVolumeCommand)).toHaveLength(0);
  });

  it("propagates attach failure and does not perform implicit rollback", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
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
        return { VolumeId: "vol-new" };
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

    await expect(handleResume()).rejects.toThrow("attach failed");
    expect(getCommands(CreateVolumeCommand)).toHaveLength(1);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });
});

describe("volume-client detachAndDeleteVolumes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findInstanceId.mockResolvedValue("i-resolved");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detaches and deletes each attached volume to satisfy zero-EBS-cost hibernate model", async () => {
    vi.useFakeTimers();

    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-a" } }, { Ebs: { VolumeId: "vol-b" } }, { Ebs: {} }],
                },
              ],
            },
          ],
        };
      }

      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [{ Attachments: [{ State: "detached" }] }],
        };
      }

      return {};
    });

    const detachPromise = detachAndDeleteVolumes("i-explicit");
    await vi.runAllTimersAsync();
    await detachPromise;

    const detachCommands = getCommands(DetachVolumeCommand);
    expect(detachCommands.map((command) => command.input.VolumeId)).toEqual(["vol-a", "vol-b"]);

    const deleteCommands = getCommands(DeleteVolumeCommand);
    expect(deleteCommands.map((command) => command.input.VolumeId)).toEqual(["vol-a", "vol-b"]);

    expect(mocks.findInstanceId).not.toHaveBeenCalled();
  });

  it("fails explicitly when detach polling times out and avoids delete", async () => {
    vi.useFakeTimers();

    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-timeout" } }],
                },
              ],
            },
          ],
        };
      }

      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [{ Attachments: [{ State: "attached" }] }],
        };
      }

      return {};
    });

    const detachExpectation = expect(detachAndDeleteVolumes()).rejects.toThrow(
      "Volume vol-timeout did not detach within timeout"
    );
    await vi.runAllTimersAsync();
    await detachExpectation;
    expect(mocks.findInstanceId).toHaveBeenCalledTimes(1);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });
});
