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
 * Find the Minecraft Server instance ID.
 * Priority:
 * 1. Environment variable INSTANCE_ID
 * 2. AWS Query for tag:Name=MinecraftServer (non-terminated)
 */
export async function findInstanceId(): Promise<string> {
  if (env.INSTANCE_ID) {
    return env.INSTANCE_ID;
  }

  try {
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Name", Values: ["MinecraftServer"] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
        ],
      })
    );

    const instanceFn = Reservations?.[0]?.Instances?.[0];
    if (instanceFn?.InstanceId) {
      console.log(`Discovered Instance ID: ${instanceFn.InstanceId}`);
      return instanceFn.InstanceId;
    }
  } catch (err) {
    console.error("Failed to discover instance ID:", err);
  }

  throw new Error(
    "Could not find Minecraft Server instance. Set INSTANCE_ID in .env or ensure instance has tag Name=MinecraftServer"
  );
}

/**
 * Get the current state of an EC2 instance
 */
export async function getInstanceState(instanceId?: string): Promise<ServerState> {
  const resolvedId = instanceId || (await findInstanceId());
  try {
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [resolvedId] }));

    if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
      return "unknown";
    }

    const instance = Reservations[0].Instances[0];
    const currentState = instance.State?.Name;
    const blockDeviceMappings = instance.BlockDeviceMappings || [];

    // Determine the state
    if (currentState === "running") {
      return "running";
    }
    if (currentState === "stopped" && blockDeviceMappings.length === 0) {
      // Stopped with no volumes = hibernated
      return "hibernated";
    }
    if (currentState === "stopped") {
      return "stopped";
    }
    if (currentState === "pending") {
      return "pending";
    }
    if (currentState === "stopping") {
      return "stopping";
    }
    if (currentState === "terminated") {
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
export async function getInstanceDetails(instanceId?: string) {
  const resolvedId = instanceId || (await findInstanceId());
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [resolvedId] }));

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
  const publicIp: string | null = null;
  let attempts = 0;

  console.log(`Polling for public IP address for instance: ${instanceId}`);

  while (!publicIp && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    try {
      const { publicIp: ip, state } = await getInstanceDetails(instanceId);

      console.log(`Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}: state=${state}, ip=${ip || "not assigned"}`);

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
export async function startInstance(instanceId?: string) {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Sending start command for instance ${resolvedId}`);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [resolvedId] }));
}

/**
 * Stop an EC2 instance
 */
export async function stopInstance(instanceId?: string) {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Sending stop command for instance ${resolvedId}`);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [resolvedId] }));
}

async function waitForVolumeDetached(volumeId: string, maxAttempts = 30): Promise<boolean> {
  let detached = false;
  let detachAttempts = 0;

  while (!detached && detachAttempts < maxAttempts) {
    detachAttempts++;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const volumeResponse = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));

      const volume = volumeResponse.Volumes?.[0];
      const attachmentState = volume?.Attachments?.[0]?.State;

      console.log(
        `Volume ${volumeId} attachment state poll (attempt ${detachAttempts}/${maxAttempts}): ${attachmentState}`
      );

      if (!attachmentState || attachmentState === "detached") {
        detached = true;
        console.log(`Volume ${volumeId} is now detached`);
      }
    } catch (error) {
      console.error(`Error checking volume attachment state for ${volumeId}:`, error);
    }
  }

  return detached;
}

/**
 * Detach and delete all volumes attached to an EC2 instance
 */
export async function detachAndDeleteVolumes(instanceId?: string): Promise<void> {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Detaching and deleting volumes for instance ${resolvedId}...`);

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [resolvedId] }));

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
      console.log(`Detaching volume ${volumeId}...`);
      await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId }));
      console.log(`Detach command sent for volume ${volumeId}, waiting for detachment...`);

      const detached = await waitForVolumeDetached(volumeId);
      if (!detached) {
        throw new Error(`Volume ${volumeId} did not detach within timeout`);
      }

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

async function waitForVolumeAvailable(volumeId: string, maxAttempts = 60): Promise<void> {
  let volumeAvailable = false;
  let attempts = 0;

  console.log("Waiting for volume to become available...");
  while (!volumeAvailable && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));

      const volume = volumeResponse.Volumes?.[0];
      if (volume?.State === "available") {
        volumeAvailable = true;
        console.log(`Volume ${volumeId} is now available`);
      } else {
        console.log(`Volume state: ${volume?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      console.error(`Error checking volume status on attempt ${attempts}:`, error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!volumeAvailable) {
    throw new Error(`Volume ${volumeId} did not become available within timeout`);
  }
}

async function waitForVolumeAttached(
  volumeId: string,
  instanceId: string | undefined,
  maxAttempts = 60
): Promise<void> {
  let attachmentComplete = false;
  let attempts = 0;

  console.log("Waiting for volume attachment to complete...");
  while (!attachmentComplete && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));

      const attachment = volumeResponse.Volumes?.[0]?.Attachments?.[0];
      if (attachment?.State === "attached") {
        attachmentComplete = true;
        console.log(`Volume ${volumeId} is now attached to instance ${instanceId}`);
      } else {
        console.log(`Attachment state: ${attachment?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`Error checking attachment status on attempt ${attempts}:`, error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!attachmentComplete) {
    throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
  }
}

/**
 * Handle hibernation recovery by creating and attaching a volume if needed
 */
export async function handleResume(instanceId?: string) {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Checking if instance ${resolvedId} needs volume restoration...`);

  const { blockDeviceMappings, az } = await getInstanceDetails(resolvedId);

  if (blockDeviceMappings.length > 0) {
    console.log(`Instance ${resolvedId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`);
    return;
  }

  console.log(`Instance ${resolvedId} has no volumes. Proceeding with hibernation recovery...`);

  if (!az) {
    throw new Error(`Could not determine availability zone for instance ${resolvedId}`);
  }

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

  const sortedImages = imagesResponse.Images.sort(
    (a: (typeof imagesResponse.Images)[0], b: (typeof imagesResponse.Images)[0]) => {
      const dateA = new Date(a.CreationDate || "").getTime();
      const dateB = new Date(b.CreationDate || "").getTime();
      return dateB - dateA;
    }
  );

  const amiId = sortedImages[0].ImageId;
  console.log(`Found latest AMI: ${amiId}`);

  const blockDeviceMapping = sortedImages[0].BlockDeviceMappings?.[0];
  if (!blockDeviceMapping || !blockDeviceMapping.Ebs?.SnapshotId) {
    throw new Error(`Could not find snapshot for AMI ${amiId}`);
  }

  const snapshotId = blockDeviceMapping.Ebs.SnapshotId;
  console.log(`Using snapshot: ${snapshotId}`);

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

  await waitForVolumeAvailable(volumeId);

  console.log(`Attaching volume ${volumeId} to instance ${instanceId} at /dev/xvda...`);
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: "/dev/xvda",
    })
  );

  await waitForVolumeAttached(volumeId, instanceId);

  console.log(`Successfully restored volume for instance ${instanceId}`);
}

async function checkCommandStatus(commandId: string, instanceId: string | undefined) {
  const invocationResponse = await ssm.send(
    new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId,
    })
  );

  const status = invocationResponse.Status;
  const output = invocationResponse.StandardOutputContent || "";

  if (status === "Failed") {
    const errorOutput = invocationResponse.StandardErrorContent || "";
    console.error(`SSM command failed. Error output: ${errorOutput}`);
    throw new Error(`SSM command failed: ${errorOutput}`);
  }

  return { status, output };
}

async function pollCommandCompletion(
  commandId: string,
  instanceId: string | undefined,
  maxAttempts = 60
): Promise<string> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const { status, output } = await checkCommandStatus(commandId, instanceId);
      console.log(`Poll attempt ${attempts}/${maxAttempts} - Command status: ${status}`);

      if (status === "Success") {
        return output;
      }
    } catch (error) {
      const errorWithName = error as { name?: string; message?: string };
      if (errorWithName.name === "InvocationDoesNotExist") {
        console.log(`Poll attempt ${attempts}/${maxAttempts}: Command still processing...`);
      } else {
        throw error;
      }
    }
  }

  throw new Error(`SSM command did not complete within ${maxAttempts * 2} seconds`);
}

/**
 * Execute an SSM command on an EC2 instance
 */
export async function executeSSMCommand(instanceId: string | undefined, commands: string[]): Promise<string> {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Executing SSM command on instance ${resolvedId}: ${commands.join(" ")}`);

  try {
    const sendResponse = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [resolvedId],
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

    const output = await pollCommandCompletion(commandId, instanceId);
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
export async function listBackups(instanceId?: string): Promise<string[]> {
  if (!env.GDRIVE_REMOTE || !env.GDRIVE_ROOT) {
    console.warn("Google Drive config not set (GDRIVE_REMOTE or GDRIVE_ROOT missing)");
    return [];
  }

  const resolvedId = instanceId || (await findInstanceId());

  try {
    console.log(`Listing backups from Google Drive on instance ${resolvedId}...`);

    const command = `rclone lsf ${env.GDRIVE_REMOTE}:${env.GDRIVE_ROOT}/ --format "p"`;
    const output = await executeSSMCommand(resolvedId, [command]);

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
