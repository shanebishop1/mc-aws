import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StopInstancesCommand,
} from "../clients.js";

const mocks = vi.hoisted(() => ({
  executeSSMCommand: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../clients.js", async () => {
  const actual = await vi.importActual<typeof import("../clients.js")>("../clients.js");
  return { ...actual, ec2: { send: mocks.send } };
});
vi.mock("../ssm.js", () => ({ executeSSMCommand: mocks.executeSSMCommand }));
vi.mock("../notifications.js", () => ({
  getSanitizedErrorMessage: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../runtime-budgets.js", () => ({
  INSTANCE_STATE_MAX_ATTEMPTS: 1,
  INSTANCE_STATE_POLL_INTERVAL_MS: 0,
  VOLUME_DETACH_MAX_ATTEMPTS: 1,
  VOLUME_DETACH_POLL_INTERVAL_MS: 0,
}));

import { handleHibernate } from "./hibernate.js";

const getCommands = <T>(commandType: new (...args: never[]) => T): T[] =>
  mocks.send.mock.calls.map(([command]) => command).filter((command): command is T => command instanceof commandType);

describe("lambda handlers/hibernate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_PROJECT_TAG", "mc-aws");
    vi.stubEnv("MC_STACK_TAG", "MinecraftStack");
    mocks.executeSSMCommand.mockResolvedValue("backup complete");
  });

  it("deletes only the managed root volume and preserves unrelated attached volumes", async () => {
    let instanceDescribeCount = 0;
    let volumeDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command dispatch keeps this lifecycle sequence auditable.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof StopInstancesCommand) return {};
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] };
        }
        return {
          Reservations: [
            {
              Instances: [
                {
                  RootDeviceName: "/dev/xvda",
                  BlockDeviceMappings: [
                    { DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } },
                    { DeviceName: "/dev/sdf", Ebs: { VolumeId: "vol-unrelated" } },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (command instanceof DescribeVolumesCommand) {
        volumeDescribeCount += 1;
        if (volumeDescribeCount === 1) {
          return {
            Volumes: [
              {
                Tags: [
                  { Key: "McAwsProject", Value: "mc-aws" },
                  { Key: "McAwsStack", Value: "MinecraftStack" },
                  { Key: "McAwsManagedRoot", Value: "true" },
                ],
                Attachments: [{ InstanceId: "i-managed", State: "attached" }],
              },
            ],
          };
        }
        return { Volumes: [{ State: "available", Attachments: [] }] };
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).resolves.toContain("Hibernation completed successfully");

    expect(getCommands(DetachVolumeCommand)).toHaveLength(1);
    expect(getCommands(DetachVolumeCommand)[0]?.input).toMatchObject({ VolumeId: "vol-root", InstanceId: "i-managed" });
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(1);
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-root");
  });

  it("refuses to detach a root volume without matching ownership tags", async () => {
    let instanceDescribeCount = 0;
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        return instanceDescribeCount === 1
          ? { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] }
          : {
              Reservations: [
                {
                  Instances: [
                    {
                      RootDeviceName: "/dev/xvda",
                      BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-unowned" } }],
                    },
                  ],
                },
              ],
            };
      }
      if (command instanceof DescribeVolumesCommand) {
        return { Volumes: [{ Tags: [], Attachments: [{ InstanceId: "i-managed", State: "attached" }] }] };
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("Refusing to delete root volume vol-unowned");
    expect(getCommands(DetachVolumeCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });
});
