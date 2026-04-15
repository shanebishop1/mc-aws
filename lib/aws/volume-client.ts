/**
 * EBS Volume operations for EC2 instances
 */

import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
} from "@aws-sdk/client-ec2";
import { ec2 } from "./ec2-client";
import { getInstanceDetails } from "./ec2-client";
import { findInstanceId } from "./ec2-client";

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

  // Cost-model contract: hibernate is a zero-EBS-cost mode, so all attached instance volumes are removed.
  // Resume is responsible for recreating the root volume from an explicit, pinned source.

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

interface ResumeRootSource {
  imageId: string;
  rootDeviceName: string;
  snapshotId: string;
}

async function resolveResumeRootSource(
  instanceId: string,
  imageId: string,
  rootDeviceName: string
): Promise<ResumeRootSource> {
  console.log(
    `[RESUME] Resolving reconstruction source from instance AMI ${imageId} (root device: ${rootDeviceName})...`
  );

  const imagesResponse = await ec2.send(
    new DescribeImagesCommand({
      ImageIds: [imageId],
    })
  );

  const sourceImage = imagesResponse.Images?.find((image) => image.ImageId === imageId) ?? imagesResponse.Images?.[0];
  if (!sourceImage) {
    throw new Error(`Source AMI ${imageId} for instance ${instanceId} was not found`);
  }

  if (sourceImage.State && sourceImage.State !== "available") {
    throw new Error(`Source AMI ${imageId} is not available (state: ${sourceImage.State})`);
  }

  const rootBlockDeviceMapping = sourceImage.BlockDeviceMappings?.find(
    (mapping) => mapping.DeviceName === rootDeviceName
  );

  if (!rootBlockDeviceMapping?.Ebs?.SnapshotId) {
    throw new Error(`Could not resolve root snapshot for source AMI ${imageId} and device ${rootDeviceName}`);
  }

  return {
    imageId,
    rootDeviceName,
    snapshotId: rootBlockDeviceMapping.Ebs.SnapshotId,
  };
}

/**
 * Handle hibernation recovery by creating and attaching a volume if needed
 */
export async function handleResume(instanceId?: string) {
  const resolvedId = instanceId || (await findInstanceId());
  console.log(`Checking if instance ${resolvedId} needs volume restoration...`);

  const { blockDeviceMappings, az, instance } = await getInstanceDetails(resolvedId);

  if (blockDeviceMappings.length > 0) {
    console.log(`Instance ${resolvedId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`);
    return;
  }

  console.log(`Instance ${resolvedId} has no volumes. Proceeding with hibernation recovery...`);

  if (!az) {
    throw new Error(`Could not determine availability zone for instance ${resolvedId}`);
  }

  const sourceImageId = instance.ImageId;
  if (!sourceImageId) {
    throw new Error(`Could not determine source AMI for instance ${resolvedId}`);
  }

  const rootDeviceName = instance.RootDeviceName;
  if (!rootDeviceName) {
    throw new Error(`Could not determine root device name for instance ${resolvedId}`);
  }

  const resumeSource = await resolveResumeRootSource(resolvedId, sourceImageId, rootDeviceName);
  console.log(`[RESUME] Using pinned root snapshot ${resumeSource.snapshotId} from source AMI ${resumeSource.imageId}`);

  console.log("Creating new 8GB GP3 volume from snapshot...");
  const createVolumeResponse = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: az,
      SnapshotId: resumeSource.snapshotId,
      VolumeType: "gp3",
      Size: 8,
      Encrypted: true,
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Name", Value: "MinecraftServerVolume" },
            { Key: "Backup", Value: "weekly" },
            { Key: "ReconstructionSourceImageId", Value: resumeSource.imageId },
            { Key: "ReconstructionSourceSnapshotId", Value: resumeSource.snapshotId },
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

  console.log(`Attaching volume ${volumeId} to instance ${resolvedId} at /dev/xvda...`);
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: resolvedId,
      Device: "/dev/xvda",
    })
  );

  await waitForVolumeAttached(volumeId, resolvedId);

  console.log(`Successfully restored volume for instance ${resolvedId}`);
}
