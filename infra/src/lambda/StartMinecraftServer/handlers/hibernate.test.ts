import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "../clients.js";

const mocks = vi.hoisted(() => ({
  executeSSMCommand: vi.fn(),
  handleRefreshBackups: vi.fn(),
  send: vi.fn(),
  getOperationExecutionContext: vi.fn(),
  getOperationState: vi.fn(),
  updateOperationState: vi.fn(),
}));

vi.mock("../clients.js", async () => {
  const actual = await vi.importActual<typeof import("../clients.js")>("../clients.js");
  return { ...actual, ec2: { send: mocks.send } };
});
vi.mock("../ssm.js", () => ({ executeSSMCommand: mocks.executeSSMCommand }));
vi.mock("../execution-context.js", () => ({ getOperationExecutionContext: mocks.getOperationExecutionContext }));
vi.mock("../operation-state.js", () => ({
  getOperationState: mocks.getOperationState,
  updateOperationState: mocks.updateOperationState,
}));
vi.mock("./backups.js", () => ({ handleRefreshBackups: mocks.handleRefreshBackups }));
vi.mock("../notifications.js", () => ({
  getSanitizedErrorMessage: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../runtime-budgets.js", () => ({
  HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS: 195,
  HIBERNATE_BACKUP_SSM_TIMEOUT_SECONDS: 360,
  HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS: 3,
  INSTANCE_STATE_MAX_ATTEMPTS: 1,
  INSTANCE_STATE_POLL_INTERVAL_MS: 0,
  VOLUME_DETACH_MAX_ATTEMPTS: 2,
  VOLUME_DETACH_POLL_INTERVAL_MS: 0,
}));

import { handleHibernate } from "./hibernate.js";

const getCommands = <T>(commandType: new (...args: never[]) => T): T[] =>
  mocks.send.mock.calls.map(([command]) => command).filter((command): command is T => command instanceof commandType);

const reconstructionImage = {
  Images: [
    {
      ImageId: "ami-source",
      State: "available",
      BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-source" } }],
    },
  ],
};

describe("lambda handlers/hibernate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_PROJECT_TAG", "mc-aws");
    vi.stubEnv("MC_STACK_TAG", "MinecraftStack");
    mocks.executeSSMCommand.mockResolvedValue("backup complete");
    mocks.handleRefreshBackups.mockResolvedValue("cache refreshed");
    mocks.getOperationExecutionContext.mockReturnValue(null);
    mocks.getOperationState.mockResolvedValue(null);
    mocks.updateOperationState.mockResolvedValue(undefined);
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  RootDeviceName: "/dev/xvda",
                  ImageId: "ami-source",
                  BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  State: { Name: "running" },
                },
              ],
            },
          ],
        };
      }
      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "in-use",
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
      return {};
    });
  });

  it("deletes only the managed root volume and preserves unrelated attached volumes", async () => {
    mocks.getOperationExecutionContext.mockReturnValue({
      operationId: "hibernate-op",
      command: "hibernate",
      executionToken: "attempt-1",
    });
    let instanceDescribeCount = 0;
    let volumeDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command dispatch keeps this lifecycle sequence auditable.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit AWS command sequencing documents the rollback contract.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The retry fixture models exact-volume reconciliation after deletion.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof StopInstancesCommand) return {};
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
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
        return {
          Reservations: [{ Instances: [{ State: { Name: instanceDescribeCount === 2 ? "running" : "stopped" } }] }],
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
        if (volumeDescribeCount === 2) return { Volumes: [{ State: "available", Attachments: [] }] };
        return { Volumes: [] };
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).resolves.toContain("Hibernation completed successfully");

    expect(getCommands(DetachVolumeCommand)).toHaveLength(1);
    expect(getCommands(DetachVolumeCommand)[0]?.input).toMatchObject({ VolumeId: "vol-root", InstanceId: "i-managed" });
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(1);
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-root");
    expect(mocks.executeSSMCommand).toHaveBeenNthCalledWith(
      1,
      "i-managed",
      [
        "if grep -Fq -- '--hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --hibernate; else /usr/local/bin/mc-backup.sh; fi",
      ],
      { maxAttempts: 195, timeoutSeconds: 360, step: "hibernate-backup", finalRemoteStep: false }
    );
    expect(mocks.updateOperationState).toHaveBeenCalledWith(
      expect.objectContaining({ managedVolumeId: "vol-root", hibernatePhase: "selected" })
    );
    expect(mocks.updateOperationState).toHaveBeenCalledWith(expect.objectContaining({ hibernatePhase: "stopped" }));
    expect(mocks.updateOperationState).toHaveBeenCalledWith(expect.objectContaining({ hibernatePhase: "detached" }));
    expect(mocks.updateOperationState).toHaveBeenCalledWith(expect.objectContaining({ hibernatePhase: "deleted" }));
    expect(mocks.updateOperationState.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.send.mock.invocationCallOrder.find(
        (_, index) => mocks.send.mock.calls[index][0] instanceof DetachVolumeCommand
      )!
    );
    expect(mocks.handleRefreshBackups).toHaveBeenCalledWith("i-managed");
    expect(mocks.executeSSMCommand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.handleRefreshBackups.mock.invocationCallOrder[0]
    );
    const stopCallIndex = mocks.send.mock.calls.findIndex(([command]) => command instanceof StopInstancesCommand);
    expect(mocks.handleRefreshBackups.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[stopCallIndex]
    );
  });

  it("does not stop or delete the root volume when cache refresh fails", async () => {
    mocks.handleRefreshBackups.mockRejectedValueOnce(new Error("cache failed"));

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("cache failed");

    expect(getCommands(StopInstancesCommand)).toHaveLength(0);
    expect(getCommands(DetachVolumeCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
    expect(mocks.executeSSMCommand).toHaveBeenNthCalledWith(
      2,
      "i-managed",
      [
        "if grep -Fq -- '--recover-hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --recover-hibernate; else systemctl start minecraft.service; fi",
      ],
      { maxAttempts: 30, timeoutSeconds: 45, step: "hibernate-recovery", finalRemoteStep: false }
    );
  });

  it("attempts idempotent host recovery after a terminal hibernate-backup failure", async () => {
    mocks.executeSSMCommand
      .mockRejectedValueOnce(new Error("backup timed out"))
      .mockResolvedValueOnce("no guard present");

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("backup timed out");

    expect(mocks.executeSSMCommand).toHaveBeenNthCalledWith(
      2,
      "i-managed",
      [
        "if grep -Fq -- '--recover-hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --recover-hibernate; else systemctl start minecraft.service; fi",
      ],
      { maxAttempts: 30, timeoutSeconds: 45, step: "hibernate-recovery", finalRemoteStep: false }
    );
    expect(getCommands(StopInstancesCommand)).toHaveLength(0);
  });

  it("refuses to detach a root volume without matching ownership tags", async () => {
    let instanceDescribeCount = 0;
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        return instanceDescribeCount === 1
          ? {
              Reservations: [
                {
                  Instances: [
                    {
                      RootDeviceName: "/dev/xvda",
                      ImageId: "ami-source",
                      BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-unowned" } }],
                    },
                  ],
                },
              ],
            }
          : { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] };
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

  it("preflights AMI snapshot reconstructability before backup, stop, or delete", async () => {
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return {
          Reservations: [
            {
              Instances: [
                {
                  RootDeviceName: "/dev/xvda",
                  ImageId: "ami-unusable",
                  BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                },
              ],
            },
          ],
        };
      }
      if (command instanceof DescribeVolumesCommand) {
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
      if (command instanceof DescribeImagesCommand) {
        return { Images: [{ ImageId: "ami-unusable", State: "available", BlockDeviceMappings: [] }] };
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("reconstruction snapshot is missing");
    expect(mocks.executeSSMCommand).not.toHaveBeenCalled();
    expect(getCommands(StopInstancesCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });

  it("restarts and clears the guard after StopInstances polling times out", async () => {
    let describeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit AWS command sequencing documents the rollback contract.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        describeCount += 1;
        if (describeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        if (describeCount === 2) return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
        if (describeCount === 3) return { Reservations: [{ Instances: [{ State: { Name: "stopping" } }] }] };
        if (describeCount === 4) return { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] };
        return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "in-use",
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
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("did not stop within timeout");
    expect(getCommands(StartInstancesCommand)).toHaveLength(1);
    expect(mocks.executeSSMCommand).toHaveBeenLastCalledWith(
      "i-managed",
      [
        "if grep -Fq -- '--recover-hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --recover-hibernate; else systemctl start minecraft.service; fi",
      ],
      { maxAttempts: 30, timeoutSeconds: 45, step: "hibernate-recovery", finalRemoteStep: false }
    );
  });

  it("reattaches the root volume and restarts after delete failure", async () => {
    let instanceCount = 0;
    let volumeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit AWS command sequencing documents the rollback contract.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceCount += 1;
        if (instanceCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        if (instanceCount <= 3) return { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] };
        return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
        volumeCount += 1;
        if (volumeCount === 1) {
          return {
            Volumes: [
              {
                State: "in-use",
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
        if (volumeCount <= 3) return { Volumes: [{ State: "available", Attachments: [] }] };
        return { Volumes: [{ State: "in-use", Attachments: [{ InstanceId: "i-managed", State: "attached" }] }] };
      }
      if (command instanceof DeleteVolumeCommand) throw new Error("delete failed");
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("delete failed");
    expect(getCommands(AttachVolumeCommand)).toHaveLength(1);
    expect(getCommands(StartInstancesCommand)).toHaveLength(1);
  });

  it("polls through a stale running observation and continues an ambiguously accepted stop", async () => {
    mocks.getOperationExecutionContext.mockReturnValue({
      operationId: "hibernate-op",
      command: "hibernate",
      executionToken: "attempt-1",
    });
    let instanceDescribeCount = 0;
    let volumeDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command sequencing models an ambiguous accepted stop and recovery.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    State: { Name: "running" },
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        const state = ["running", "running", "stopping", "stopped", "running"][instanceDescribeCount - 2] ?? "running";
        return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
        volumeDescribeCount += 1;
        if (volumeDescribeCount === 2) return { Volumes: [{ State: "available", Attachments: [] }] };
        if (volumeDescribeCount > 2) return { Volumes: [] };
        return {
          Volumes: [
            {
              State: "in-use",
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
      if (command instanceof StopInstancesCommand) {
        throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).resolves.toContain("Hibernation completed successfully");

    const stoppingWriteOrder = mocks.updateOperationState.mock.invocationCallOrder.find(
      (_, index) => mocks.updateOperationState.mock.calls[index][0].hibernatePhase === "stopping"
    )!;
    const stopOrder = mocks.send.mock.invocationCallOrder.find(
      (_, index) => mocks.send.mock.calls[index][0] instanceof StopInstancesCommand
    )!;
    expect(stoppingWriteOrder).toBeLessThan(stopOrder);
    expect(instanceDescribeCount).toBe(5);
    expect(getCommands(StartInstancesCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(1);
    expect(mocks.executeSSMCommand).toHaveBeenCalledTimes(1);
  });

  it("retains lifecycle ownership when bounded polling sees only running after ambiguous stop delivery", async () => {
    let instanceDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit AWS command sequencing verifies stable-state disambiguation.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    State: { Name: "running" },
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
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
      if (command instanceof StopInstancesCommand) {
        throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      }
      return {};
    });

    const error = await handleHibernate("i-managed", [], "").catch((caught) => caught);

    expect(error).toMatchObject({
      message: "response lost",
      stopDeliveryOutcome: "ambiguous",
      retainLifecycleLock: true,
    });
    expect(instanceDescribeCount).toBe(5);
    expect(getCommands(StartInstancesCommand)).toHaveLength(0);
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
    expect(mocks.executeSSMCommand).toHaveBeenCalledTimes(1);
  });

  it("performs host recovery after a definite StopInstances rejection", async () => {
    let instanceDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit AWS command sequencing verifies definite stop rejection recovery.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    State: { Name: "running" },
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
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
      if (command instanceof StopInstancesCommand) {
        throw Object.assign(new Error("stop rejected"), {
          name: "UnauthorizedOperation",
          $metadata: { httpStatusCode: 403 },
        });
      }
      return {};
    });

    const error = await handleHibernate("i-managed", [], "").catch((caught) => caught);

    expect(error).toMatchObject({ message: "stop rejected", stopDeliveryOutcome: "rejected" });
    expect(error.retainLifecycleLock).not.toBe(true);
    expect(instanceDescribeCount).toBe(2);
    expect(getCommands(StartInstancesCommand)).toHaveLength(0);
    expect(mocks.executeSSMCommand).toHaveBeenLastCalledWith(
      "i-managed",
      expect.arrayContaining([expect.stringContaining("recover-hibernate")]),
      expect.objectContaining({ step: "hibernate-recovery" })
    );
  });

  it("does not run host recovery while an accepted stop still has a stale running read", async () => {
    let instanceDescribeCount = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit command sequencing verifies stale reads after accepted stop delivery.
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        instanceDescribeCount += 1;
        if (instanceDescribeCount === 1) {
          return {
            Reservations: [
              {
                Instances: [
                  {
                    RootDeviceName: "/dev/xvda",
                    ImageId: "ami-source",
                    State: { Name: "running" },
                    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: "vol-root" } }],
                  },
                ],
              },
            ],
          };
        }
        const state = ["running", "stopping", "running", "stopped", "running"][instanceDescribeCount - 2] ?? "running";
        return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
        return {
          Volumes: [
            {
              State: "in-use",
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
      if (command instanceof StopInstancesCommand) {
        throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("did not stop within timeout");

    expect(getCommands(StartInstancesCommand)).toHaveLength(1);
    const startOrder = mocks.send.mock.invocationCallOrder.find(
      (_, index) => mocks.send.mock.calls[index][0] instanceof StartInstancesCommand
    )!;
    expect(mocks.executeSSMCommand.mock.invocationCallOrder.at(-1)).toBeGreaterThan(startOrder);
    expect(instanceDescribeCount).toBe(6);
  });

  it("deletes the exact durably recorded detached managed volume on retry", async () => {
    mocks.getOperationExecutionContext.mockReturnValue({
      operationId: "hibernate-op",
      command: "hibernate",
      executionToken: "attempt-2",
    });
    mocks.getOperationState.mockResolvedValue({ managedVolumeId: "vol-detached" });
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [{ Instances: [{ RootDeviceName: "/dev/xvda", BlockDeviceMappings: [] }] }] };
      }
      if (command instanceof DescribeVolumesCommand) {
        if (getCommands(DeleteVolumeCommand).length > 0) return { Volumes: [] };
        return {
          Volumes: [
            {
              State: "available",
              Attachments: [],
              Tags: [
                { Key: "McAwsProject", Value: "mc-aws" },
                { Key: "McAwsStack", Value: "MinecraftStack" },
                { Key: "McAwsManagedRoot", Value: "true" },
              ],
            },
          ],
        };
      }
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).resolves.toContain("already complete");
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(1);
    expect(getCommands(DeleteVolumeCommand)[0]?.input.VolumeId).toBe("vol-detached");
    expect(mocks.executeSSMCommand).not.toHaveBeenCalled();
  });

  it("fails closed when detached tagged candidates lack an exact durable identity", async () => {
    mocks.getOperationExecutionContext.mockReturnValue({
      operationId: "hibernate-op",
      command: "hibernate",
      executionToken: "attempt-2",
    });
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeImagesCommand) return reconstructionImage;
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [{ Instances: [{ RootDeviceName: "/dev/xvda", BlockDeviceMappings: [] }] }] };
      }
      if (command instanceof DescribeVolumesCommand) return { Volumes: [{ VolumeId: "vol-a" }, { VolumeId: "vol-b" }] };
      return {};
    });

    await expect(handleHibernate("i-managed", [], "")).rejects.toThrow("lack an exact durable identity");
    expect(getCommands(DeleteVolumeCommand)).toHaveLength(0);
  });
});
