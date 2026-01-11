import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  ec2,
} from "../clients.js";

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
  if ((instance.BlockDeviceMappings || []).length > 0) {
    console.log(`Instance ${instanceId} already has volumes. Skipping resume.`);
    return;
  }

  console.log(`Instance ${instanceId} has no volumes. Proceeding with hibernation recovery...`);

  const az = instance.Placement?.AvailabilityZone;
  if (!az) throw new Error(`Could not determine availability zone for instance ${instanceId}`);

  const snapshotId = await findLatestAL2023Snapshot();
  const volumeId = await createAndAttachVolume(instanceId, az, snapshotId);

  console.log(`Successfully restored volume ${volumeId} for instance ${instanceId}`);
}

async function findLatestAL2023Snapshot() {
  console.log("Looking up Amazon Linux 2023 ARM64 AMI...");
  const response = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023*-arm64"] },
        { Name: "state", Values: ["available"] },
      ],
    })
  );

  if (!response.Images?.length) throw new Error("Could not find Amazon Linux 2023 ARM64 AMI");

  const sortedImages = response.Images.sort(
    (a, b) => new Date(b.CreationDate).getTime() - new Date(a.CreationDate).getTime()
  );
  const snapshotId = sortedImages[0].BlockDeviceMappings?.[0]?.Ebs?.SnapshotId;

  if (!snapshotId) throw new Error(`Could not find snapshot for AMI ${sortedImages[0].ImageId}`);
  console.log(`Using snapshot: ${snapshotId}`);
  return snapshotId;
}

async function createAndAttachVolume(instanceId, az, snapshotId) {
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
          ],
        },
      ],
    })
  );

  const volumeId = createResponse.VolumeId;
  if (!volumeId) throw new Error("Failed to create volume");

  await waitForVolumeAvailable(volumeId);
  await attachVolumeToInstance(volumeId, instanceId);

  return volumeId;
}

async function waitForVolumeAvailable(volumeId) {
  console.log("Waiting for volume to become available...");
  for (let attempt = 1; attempt <= 60; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    if (response.Volumes?.[0]?.State === "available") {
      console.log(`Volume ${volumeId} is now available`);
      return;
    }
    console.log(`Volume state: ${response.Volumes?.[0]?.State}. Waiting... (attempt ${attempt}/60)`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
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
  for (let attempt = 1; attempt <= 60; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    if (response.Volumes?.[0]?.Attachments?.[0]?.State === "attached") {
      console.log(`Volume ${volumeId} is now attached`);
      return;
    }
    console.log(
      `Attachment state: ${response.Volumes?.[0]?.Attachments?.[0]?.State}. Waiting... (attempt ${attempt}/60)`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
}
