import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
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

vi.mock("../runtime-budgets.js", () => ({
  VOLUME_ATTACH_MAX_ATTEMPTS: 1,
  VOLUME_ATTACH_POLL_INTERVAL_MS: 0,
  VOLUME_AVAILABLE_MAX_ATTEMPTS: 1,
  VOLUME_AVAILABLE_POLL_INTERVAL_MS: 0,
}));

import { handleResume } from "./resume.js";

const getCommands = <T>(commandType: new (...args: never[]) => T): T[] => {
  return mocks.send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof commandType);
};

describe("lambda handlers/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_PROJECT_TAG", "mc-aws");
    vi.stubEnv("MC_STACK_TAG", "MinecraftStack");

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
              Attachments: [{ InstanceId: "i-resume", State: "attached" }],
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
        { Key: "McAwsProject", Value: "mc-aws" },
        { Key: "McAwsStack", Value: "MinecraftStack" },
        { Key: "McAwsInstanceId", Value: "i-resume" },
        { Key: "McAwsManagedRoot", Value: "true" },
        { Key: "McAwsReconstructed", Value: "true" },
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

  it("skips reconstruction when the instance already has a root volume", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-existing" } }],
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

  it("reconstructs the missing root volume when an unrelated volume remains attached", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  BlockDeviceMappings: [{ DeviceName: "/dev/sdf", Ebs: { VolumeId: "vol-unrelated" } }],
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
      if (command instanceof CreateVolumeCommand) return { VolumeId: "vol-reconstructed" };
      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "available",
              Attachments: [{ InstanceId: "i-unrelated", State: "attached" }],
            },
          ],
        };
      }
      return {};
    });

    await expect(handleResume("i-unrelated")).resolves.toBeUndefined();
    expect(getCommands(CreateVolumeCommand)).toHaveLength(1);
    expect(getCommands(AttachVolumeCommand)).toHaveLength(1);
  });

  it("rolls back an available volume after an attach API failure", async () => {
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
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-created");
  });

  it("propagates create failures without attempting cleanup", async () => {
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
      if (command instanceof CreateVolumeCommand) throw new Error("create failed");
      return {};
    });

    await expect(handleResume("i-create-fail")).rejects.toThrow("create failed");
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });

  it("rolls back a volume after the availability wait times out", async () => {
    let volumeDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command dispatch keeps this rollback sequence auditable.
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
      if (command instanceof CreateVolumeCommand) return { VolumeId: "vol-slow" };
      if (command instanceof DescribeVolumesCommand) {
        volumeDescribeCount += 1;
        return { Volumes: [{ State: volumeDescribeCount === 1 ? "creating" : "available", Attachments: [] }] };
      }
      return {};
    });

    await expect(handleResume("i-availability-timeout")).rejects.toThrow(
      "Volume vol-slow did not become available within timeout"
    );
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-slow");
  });

  it("detaches a partial attachment before deleting the failed reconstructed volume", async () => {
    let volumeDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command dispatch keeps this rollback sequence auditable.
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
      if (command instanceof CreateVolumeCommand) return { VolumeId: "vol-partial" };
      if (command instanceof DescribeVolumesCommand) {
        volumeDescribeCount += 1;
        if (volumeDescribeCount === 1) return { Volumes: [{ State: "available", Attachments: [] }] };
        if (volumeDescribeCount <= 3)
          return { Volumes: [{ State: "in-use", Attachments: [{ InstanceId: "i-partial", State: "attaching" }] }] };
        return { Volumes: [{ State: "available", Attachments: [] }] };
      }
      return {};
    });

    await expect(handleResume("i-partial")).rejects.toThrow(
      "Volume vol-partial attachment did not complete within timeout"
    );
    expect(getCommands(DetachVolumeCommand)[0]?.input).toMatchObject({
      VolumeId: "vol-partial",
      InstanceId: "i-partial",
    });
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-partial");
  });

  it("deletes an unattached volume after the attachment wait times out", async () => {
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
      if (command instanceof CreateVolumeCommand) return { VolumeId: "vol-unattached" };
      if (command instanceof DescribeVolumesCommand) return { Volumes: [{ State: "available", Attachments: [] }] };
      return {};
    });

    await expect(handleResume("i-unattached")).rejects.toThrow(
      "Volume vol-unattached attachment did not complete within timeout"
    );
    expect(getCommands(DetachVolumeCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-unattached");
  });

  it("preserves the original failure and reports a retained volume when cleanup fails", async () => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command dispatch keeps both failure paths auditable.
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
      if (command instanceof CreateVolumeCommand) return { VolumeId: "vol-retained" };
      if (command instanceof DescribeVolumesCommand) return { Volumes: [{ State: "available", Attachments: [] }] };
      if (command instanceof AttachVolumeCommand) throw new Error("original attach failure");
      if (command instanceof DeleteVolumeCommand) throw new Error("delete denied");
      return {};
    });

    const failure = await handleResume("i-cleanup-fail").catch((error) => error);
    expect(failure.message).toContain("original attach failure");
    expect(failure.message).toContain("retained volume vol-retained");
    expect(failure.message).toContain("delete denied");
    expect(failure.cause).toEqual(new Error("original attach failure"));
  });
});
