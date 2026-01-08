/**
 * AWS EC2 and SSM client initialization and utilities
 */

import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeImagesCommand,
  CreateVolumeCommand,
  AttachVolumeCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  DeleteVolumeCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { env } from "./env";
import type { ServerState } from "./types";

// Initialize AWS clients
const ec2 = new EC2Client({ region: env.AWS_REGION || "us-east-1" });
const ssm = new SSMClient({ region: env.AWS_REGION || "us-east-1" });

// Constants for polling
const MAX_POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 1000;

/**
 * Get the current state of an EC2 instance
 */
export async function getInstanceState(instanceId: string): Promise<ServerState> {
  try {
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );

    if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
      return "unknown";
    }

    const instance = Reservations[0].Instances[0];
    const currentState = instance.State?.Name;
    const blockDeviceMappings = instance.BlockDeviceMappings || [];

    // Determine the state
    if (currentState === "running") {
      return "running";
    } else if (currentState === "stopped" && blockDeviceMappings.length === 0) {
      // Stopped with no volumes = hibernated
      return "hibernated";
    } else if (currentState === "stopped") {
      return "stopped";
    } else if (currentState === "pending") {
      return "pending";
    } else if (currentState === "stopping") {
      return "stopping";
    } else if (currentState === "terminated") {
      return "terminated";
    }

    return "unknown";
  } catch (error) {
    console.error("Error getting instance state:", error);
    return "unknown";
  }
}

/**
 * Get instance details including state and public IP
 */
export async function getInstanceDetails(instanceId: string) {
  const { Reservations } = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] })
  );

  if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = Reservations[0].Instances[0];
  return {
    instance,
    state: instance.State?.Name,
    publicIp: instance.PublicIpAddress,
    blockDeviceMappings: instance.BlockDeviceMappings || [],
    az: instance.Placement?.AvailabilityZone,
  };
}

/**
 * Wait for instance to reach running state
 */
export async function waitForInstanceRunning(instanceId: string, timeoutSeconds = 300) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    const { state } = await getInstanceDetails(instanceId);

    if (state === "running") {
      return;
    }

    if (["terminated", "terminating"].includes(state || "")) {
      throw new Error(`Instance entered unexpected state: ${state}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Instance did not reach running state within ${timeoutSeconds} seconds`);
}

/**
 * Wait for instance to reach stopped state
 */
export async function waitForInstanceStopped(instanceId: string, timeoutSeconds = 300) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    const { state } = await getInstanceDetails(instanceId);

    if (state === "stopped") {
      return;
    }

    if (["terminated", "terminating"].includes(state || "")) {
      throw new Error(`Instance entered unexpected state: ${state}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Instance did not reach stopped state within ${timeoutSeconds} seconds`);
}

/**
 * Get the public IP address of an EC2 instance, polling until available
 */
export async function getPublicIp(instanceId: string): Promise<string> {
  let publicIp: string | null = null;
  let attempts = 0;

  console.log(`Polling for public IP address for instance: ${instanceId}`);

  while (!publicIp && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    try {
      const { publicIp: ip, state } = await getInstanceDetails(instanceId);

      console.log(
        `Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}: state=${state}, ip=${ip || "not assigned"}`
      );

      if (ip) {
        return ip;
      }

      if (["stopped", "stopping", "terminated", "shutting-down"].includes(state || "")) {
        throw new Error(`Instance entered unexpected state ${state} while waiting for IP`);
      }
    } catch (error) {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        throw new Error(`Failed to get public IP after ${attempts} attempts: ${error}`);
      }
      console.error(`Error on attempt ${attempts}:`, error);
    }

    if (!publicIp) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error("Timed out waiting for public IP address.");
}

/**
 * Start an EC2 instance
 */
export async function startInstance(instanceId: string) {
  console.log(`Sending start command for instance ${instanceId}`);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

/**
 * Stop an EC2 instance
 */
export async function stopInstance(instanceId: string) {
  console.log(`Sending stop command for instance ${instanceId}`);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

/**
 * Detach and delete all volumes attached to an EC2 instance
 */
export async function detachAndDeleteVolumes(instanceId: string): Promise<void> {
  console.log(`Detaching and deleting volumes for instance ${instanceId}...`);

  const { Reservations } = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] })
  );

  const instance = Reservations?.[0]?.Instances?.[0];
  const blockDeviceMappings = instance?.BlockDeviceMappings || [];
  console.log(`Found ${blockDeviceMappings.length} block device mappings`);

  for (const mapping of blockDeviceMappings) {
    const volumeId = mapping.Ebs?.VolumeId;
    if (!volumeId) {
      console.log("Skipping mapping with no VolumeId");
      continue;
    }

    try {
      // Detach volume
      console.log(`Detaching volume ${volumeId}...`);
      await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId }));
      console.log(`Detach command sent for volume ${volumeId}, waiting for detachment...`);

      // Wait for detachment (30 attempts * 2 seconds = 1 minute)
      let detached = false;
      let detachAttempts = 0;
      const detachMaxAttempts = 30;

      while (!detached && detachAttempts < detachMaxAttempts) {
        detachAttempts++;
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds

        try {
          const volumeResponse = await ec2.send(
            new DescribeVolumesCommand({ VolumeIds: [volumeId] })
          );

          const volume = volumeResponse.Volumes?.[0];
          const attachmentState = volume?.Attachments?.[0]?.State;

          console.log(
            `Volume ${volumeId} attachment state poll (attempt ${detachAttempts}/${detachMaxAttempts}): ${attachmentState}`
          );

          if (!attachmentState || attachmentState === "detached") {
            detached = true;
            console.log(`Volume ${volumeId} is now detached`);
          }
        } catch (error) {
          console.error(`Error checking volume attachment state for ${volumeId}:`, error);
        }
      }

      if (!detached) {
        throw new Error(`Volume ${volumeId} did not detach within timeout`);
      }

      // Delete volume
      console.log(`Deleting volume ${volumeId}...`);
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      console.log(`Volume ${volumeId} deleted successfully`);
    } catch (error) {
      console.error(`Error detaching/deleting volume ${volumeId}:`, error);
      throw error;
    }
  }

  console.log("All volumes detached and deleted");
}

/**
 * Handle hibernation recovery by creating and attaching a volume if needed
 */
export async function handleResume(instanceId: string) {
  console.log(`Checking if instance ${instanceId} needs volume restoration...`);

  const { instance, blockDeviceMappings, az } = await getInstanceDetails(instanceId);

  // If instance already has volumes, no need to resume
  if (blockDeviceMappings.length > 0) {
    console.log(
      `Instance ${instanceId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`
    );
    return;
  }

  console.log(`Instance ${instanceId} has no volumes. Proceeding with hibernation recovery...`);

  if (!az) {
    throw new Error(`Could not determine availability zone for instance ${instanceId}`);
  }

  // Find latest Amazon Linux 2023 ARM64 AMI
  console.log("Looking up Amazon Linux 2023 ARM64 AMI...");
  const imagesResponse = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023*-arm64"] },
        { Name: "state", Values: ["available"] },
      ],
    })
  );

  if (!imagesResponse.Images || imagesResponse.Images.length === 0) {
    throw new Error("Could not find Amazon Linux 2023 ARM64 AMI");
  }

  // Sort by creation date and get the latest
  const sortedImages = imagesResponse.Images.sort(
    (
      a: (typeof imagesResponse.Images)[0],
      b: (typeof imagesResponse.Images)[0]
    ) => {
      const dateA = new Date(a.CreationDate || "").getTime();
      const dateB = new Date(b.CreationDate || "").getTime();
      return dateB - dateA; // Descending order (newest first)
    }
  );

  const amiId = sortedImages[0].ImageId;
  console.log(`Found latest AMI: ${amiId}`);

  // Get snapshot ID from AMI's BlockDeviceMappings
  const blockDeviceMapping = sortedImages[0].BlockDeviceMappings?.[0];
  if (!blockDeviceMapping || !blockDeviceMapping.Ebs?.SnapshotId) {
    throw new Error(`Could not find snapshot for AMI ${amiId}`);
  }

  const snapshotId = blockDeviceMapping.Ebs.SnapshotId;
  console.log(`Using snapshot: ${snapshotId}`);

  // Create volume from snapshot
  console.log("Creating new 8GB GP3 volume from snapshot...");
  const createVolumeResponse = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: az,
      SnapshotId: snapshotId,
      VolumeType: "gp3",
      Size: 8,
      Encrypted: true,
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Name", Value: "MinecraftServerVolume" },
            { Key: "Backup", Value: "weekly" },
          ],
        },
      ],
    })
  );

  const volumeId = createVolumeResponse.VolumeId;
  if (!volumeId) {
    throw new Error("Failed to create volume");
  }
  console.log(`Volume created: ${volumeId}`);

  // Wait for volume to become available
  console.log("Waiting for volume to become available...");
  let volumeAvailable = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 * 5 seconds = 5 minutes

  while (!volumeAvailable && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(
        new DescribeVolumesCommand({ VolumeIds: [volumeId] })
      );

      const volume = volumeResponse.Volumes?.[0];
      if (volume?.State === "available") {
        volumeAvailable = true;
        console.log(`Volume ${volumeId} is now available`);
      } else {
        console.log(
          `Volume state: ${volume?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`
        );
        await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
      }
    } catch (error) {
      console.error(`Error checking volume status on attempt ${attempts}:`, error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!volumeAvailable) {
    throw new Error(`Volume ${volumeId} did not become available within timeout`);
  }

  // Attach volume to instance at /dev/xvda (root device)
  console.log(`Attaching volume ${volumeId} to instance ${instanceId} at /dev/xvda...`);
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: "/dev/xvda",
    })
  );

  // Wait for attachment to complete
  console.log("Waiting for volume attachment to complete...");
  let attachmentComplete = false;
  attempts = 0;

  while (!attachmentComplete && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(
        new DescribeVolumesCommand({ VolumeIds: [volumeId] })
      );

      const attachment = volumeResponse.Volumes?.[0]?.Attachments?.[0];
      if (attachment?.State === "attached") {
        attachmentComplete = true;
        console.log(`Volume ${volumeId} is now attached to instance ${instanceId}`);
      } else {
        console.log(
          `Attachment state: ${attachment?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      }
    } catch (error) {
      console.error(`Error checking attachment status on attempt ${attempts}:`, error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!attachmentComplete) {
    throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
  }

  console.log(`Successfully restored volume for instance ${instanceId}`);
}

/**
 * Execute an SSM command on an EC2 instance
 */
export async function executeSSMCommand(instanceId: string, commands: string[]): Promise<string> {
  console.log(`Executing SSM command on instance ${instanceId}: ${commands.join(" ")}`);

  try {
    const sendResponse = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands,
        },
      })
    );

    const commandId = sendResponse.Command?.CommandId;
    if (!commandId) {
      throw new Error("Failed to get command ID from SSM response");
    }

    console.log(`SSM command sent with ID: ${commandId}`);

    // Wait for command completion (poll every 2 seconds, max 60 attempts = 2 minutes)
    let completed = false;
    let attempts = 0;
    const maxAttempts = 60;
    let output = "";

    while (!completed && attempts < maxAttempts) {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds

      try {
        const invocationResponse = await ssm.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          })
        );

        const status = invocationResponse.Status;
        console.log(
          `Poll attempt ${attempts}/${maxAttempts} - Command status: ${status}`
        );

        if (status === "Success" || status === "Failed") {
          completed = true;
          output = invocationResponse.StandardOutputContent || "";

          if (status === "Failed") {
            const errorOutput = invocationResponse.StandardErrorContent || "";
            console.error(`SSM command failed. Error output: ${errorOutput}`);
            throw new Error(`SSM command failed: ${errorOutput}`);
          }
        }
      } catch (error) {
        const errorWithName = error as { name?: string; message?: string };
        if (errorWithName.name === "InvocationDoesNotExist") {
          // Command still processing, continue polling
          console.log(`Poll attempt ${attempts}/${maxAttempts}: Command still processing...`);
        } else {
          throw error;
        }
      }
    }

    if (!completed) {
      throw new Error(`SSM command did not complete within ${maxAttempts * 2} seconds`);
    }

    console.log(`SSM command completed successfully. Final output: ${output}`);
    return output;
  } catch (error) {
    console.error("ERROR in executeSSMCommand:", error);
    throw error;
  }
}

/**
 * List available backups from Google Drive via rclone on EC2
 */
export async function listBackups(instanceId: string): Promise<string[]> {
  if (!env.GDRIVE_REMOTE || !env.GDRIVE_ROOT) {
    console.warn("Google Drive config not set (GDRIVE_REMOTE or GDRIVE_ROOT missing)");
    return [];
  }

  try {
    console.log(`Listing backups from Google Drive on instance ${instanceId}...`);

    const command = `rclone lsf ${env.GDRIVE_REMOTE}:${env.GDRIVE_ROOT}/ --format "p"`;
    const output = await executeSSMCommand(instanceId, [command]);

    // Parse output - each line is a backup name
    const backups = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort()
      .reverse(); // Most recent first

    console.log(`Found ${backups.length} backups`);
    return backups;
  } catch (error) {
    console.error("Error listing backups:", error);
    return [];
  }
}

export { ec2, ssm };
