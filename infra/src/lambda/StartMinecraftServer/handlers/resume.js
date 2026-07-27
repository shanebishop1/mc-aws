import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  ec2,
} from "../clients.js";
import {
  VOLUME_ATTACH_MAX_ATTEMPTS,
  VOLUME_ATTACH_POLL_INTERVAL_MS,
  VOLUME_AVAILABLE_MAX_ATTEMPTS,
  VOLUME_AVAILABLE_POLL_INTERVAL_MS,
} from "../runtime-budgets.js";

/**
 * Handle resuming a hibernated instance by creating and attaching a root volume
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
export async function handleResume(instanceId) {
  console.log(`Checking if instance ${instanceId} needs volume restoration...`);

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  if (!Reservations?.length || !Reservations[0].Instances?.length) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = Reservations[0].Instances[0];
  const rootDeviceName = instance.RootDeviceName;
  if (!rootDeviceName) throw new Error(`Could not determine root device name for instance ${instanceId}`);

  const attachedRootVolume = (instance.BlockDeviceMappings || []).find(
    (mapping) => mapping.DeviceName === rootDeviceName && mapping.Ebs?.VolumeId
  );
  if (attachedRootVolume) {
    console.log(`Instance ${instanceId} already has a root volume. Skipping resume.`);
    return;
  }

  console.log(`Instance ${instanceId} has no volumes. Proceeding with hibernation recovery...`);

  const az = instance.Placement?.AvailabilityZone;
  if (!az) throw new Error(`Could not determine availability zone for instance ${instanceId}`);

  const imageId = instance.ImageId;
  if (!imageId) throw new Error(`Could not determine source AMI for instance ${instanceId}`);

  const snapshotId = await resolvePinnedRootSnapshot(instanceId, imageId, rootDeviceName);
  const volumeId = await createAndAttachVolume(instanceId, az, imageId, snapshotId);

  console.log(`Successfully restored volume ${volumeId} for instance ${instanceId}`);
}

async function resolvePinnedRootSnapshot(instanceId, imageId, rootDeviceName) {
  console.log(`Resolving reconstruction source from instance AMI ${imageId} (root device: ${rootDeviceName})...`);
  const response = await ec2.send(
    new DescribeImagesCommand({
      ImageIds: [imageId],
    })
  );

  const sourceImage = response.Images?.find((image) => image.ImageId === imageId) ?? response.Images?.[0];
  if (!sourceImage) {
    throw new Error(`Source AMI ${imageId} for instance ${instanceId} was not found`);
  }

  if (sourceImage.State && sourceImage.State !== "available") {
    throw new Error(`Source AMI ${imageId} is not available (state: ${sourceImage.State})`);
  }

  const rootBlockDeviceMapping = sourceImage.BlockDeviceMappings?.find(
    (mapping) => mapping.DeviceName === rootDeviceName
  );
  const snapshotId = rootBlockDeviceMapping?.Ebs?.SnapshotId;

  if (!snapshotId) {
    throw new Error(`Could not resolve root snapshot for source AMI ${imageId} and device ${rootDeviceName}`);
  }

  console.log(`Using pinned root snapshot ${snapshotId} from source AMI ${imageId}`);
  return snapshotId;
}

async function createAndAttachVolume(instanceId, az, sourceImageId, snapshotId) {
  console.log("Creating new 8GB GP3 volume from snapshot...");
  const createResponse = await ec2.send(
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
            { Key: "McAwsProject", Value: requiredOwnershipTag("MC_PROJECT_TAG") },
            { Key: "McAwsStack", Value: requiredOwnershipTag("MC_STACK_TAG") },
            { Key: "McAwsInstanceId", Value: instanceId },
            { Key: "McAwsManagedRoot", Value: "true" },
            { Key: "McAwsReconstructed", Value: "true" },
            { Key: "ReconstructionSourceImageId", Value: sourceImageId },
            { Key: "ReconstructionSourceSnapshotId", Value: snapshotId },
          ],
        },
      ],
    })
  );

  const volumeId = createResponse.VolumeId;
  if (!volumeId) throw new Error("Failed to create volume");

  try {
    await waitForVolumeAvailable(volumeId);
    await attachVolumeToInstance(volumeId, instanceId);
  } catch (originalError) {
    try {
      await cleanupCreatedVolume(volumeId, instanceId);
    } catch (cleanupError) {
      const original = toError(originalError);
      const cleanup = toError(cleanupError);
      console.error(`Cleanup failed; retaining reconstructed volume ${volumeId}: ${cleanup.message}`);
      throw new Error(`${original.message}. Cleanup failed; retained volume ${volumeId}: ${cleanup.message}`, {
        cause: original,
      });
    }
    throw originalError;
  }

  return volumeId;
}

function requiredOwnershipTag(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required lifecycle ownership setting ${name}`);
  return value;
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForVolumeAvailable(volumeId) {
  console.log("Waiting for volume to become available...");
  for (let attempt = 1; attempt <= VOLUME_AVAILABLE_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    if (response.Volumes?.[0]?.State === "available") {
      console.log(`Volume ${volumeId} is now available`);
      return;
    }
    console.log(
      `Volume state: ${response.Volumes?.[0]?.State}. Waiting... (attempt ${attempt}/${VOLUME_AVAILABLE_MAX_ATTEMPTS})`
    );
    await new Promise((resolve) => setTimeout(resolve, VOLUME_AVAILABLE_POLL_INTERVAL_MS));
  }
  throw new Error(`Volume ${volumeId} did not become available within timeout`);
}

async function attachVolumeToInstance(volumeId, instanceId) {
  console.log(`Attaching volume ${volumeId} to instance ${instanceId} at /dev/xvda...`);
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: "/dev/xvda",
    })
  );

  console.log("Waiting for volume attachment to complete...");
  for (let attempt = 1; attempt <= VOLUME_ATTACH_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const attachment = response.Volumes?.[0]?.Attachments?.find((candidate) => candidate.InstanceId === instanceId);
    if (attachment?.State === "attached") {
      console.log(`Volume ${volumeId} is now attached`);
      return;
    }
    console.log(
      `Attachment state: ${attachment?.State}. Waiting... (attempt ${attempt}/${VOLUME_ATTACH_MAX_ATTEMPTS})`
    );
    await new Promise((resolve) => setTimeout(resolve, VOLUME_ATTACH_POLL_INTERVAL_MS));
  }
  throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
}

async function cleanupCreatedVolume(volumeId, instanceId) {
  console.log(`Rolling back reconstructed volume ${volumeId}...`);

  for (let attempt = 1; attempt <= VOLUME_AVAILABLE_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = response.Volumes?.[0];
    if (!volume) {
      console.log(`Reconstructed volume ${volumeId} no longer exists`);
      return;
    }

    const attachments = volume.Attachments || [];
    const foreignAttachment = attachments.find(
      (attachment) => attachment.InstanceId && attachment.InstanceId !== instanceId
    );
    if (foreignAttachment) {
      throw new Error(`volume is attached to unexpected instance ${foreignAttachment.InstanceId}`);
    }

    if (attachments.length > 0) {
      await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));
      await waitForVolumeDetached(volumeId);
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      console.log(`Rolled back reconstructed volume ${volumeId}`);
      return;
    }

    if (volume.State === "available") {
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      console.log(`Rolled back reconstructed volume ${volumeId}`);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, VOLUME_AVAILABLE_POLL_INTERVAL_MS));
  }

  throw new Error("volume did not become safe to delete within cleanup timeout");
}

async function waitForVolumeDetached(volumeId) {
  for (let attempt = 1; attempt <= VOLUME_ATTACH_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = response.Volumes?.[0];
    if (!volume || (volume.State === "available" && (volume.Attachments || []).length === 0)) return;
    await new Promise((resolve) => setTimeout(resolve, VOLUME_ATTACH_POLL_INTERVAL_MS));
  }
  throw new Error("volume did not detach within cleanup timeout");
}
