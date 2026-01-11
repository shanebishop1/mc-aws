import {
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StopInstancesCommand,
  ec2,
} from "../clients.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import { executeSSMCommand } from "../ssm.js";

/**
 * Handle hibernate command - runs backup, stops instance, detaches/deletes volume
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} _args - Command arguments (unused)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The hibernate result message
 */
async function handleHibernate(instanceId, _args, adminEmail) {
  console.log(`Handling hibernate command for instance ${instanceId}`);

  try {
    console.log("Step 1: Running backup before hibernation...");
    const backupOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-backup.sh"]);

    console.log("Step 2: Stopping instance...");
    await stopInstanceAndWait(instanceId);

    console.log("Step 3: Detaching and deleting volumes...");
    await detachAndDeleteVolumes(instanceId);

    const message = `Hibernation completed successfully.\n\nBackup output:\n${backupOutput}`;
    if (adminEmail) await sendNotification(adminEmail, "Minecraft Server Hibernated", message);

    return message;
  } catch (error) {
    console.error("ERROR in handleHibernate:", error.message);
    if (adminEmail)
      await sendNotification(adminEmail, "Minecraft Hibernation Failed", getSanitizedErrorMessage("hibernate"));
    throw error;
  }
}

async function stopInstanceAndWait(instanceId) {
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  console.log("Stop command sent, waiting for instance to stop...");

  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = Reservations?.[0]?.Instances?.[0]?.State?.Name;

    console.log(`Instance state poll (attempt ${attempt}/60): ${state}`);
    if (state === "stopped") {
      console.log(`Instance ${instanceId} is now stopped`);
      return;
    }
  }
  throw new Error(`Instance ${instanceId} did not stop within timeout`);
}

async function detachAndDeleteVolumes(instanceId) {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const blockDeviceMappings = Reservations?.[0]?.Instances?.[0]?.BlockDeviceMappings || [];

  for (const mapping of blockDeviceMappings) {
    const volumeId = mapping.Ebs?.VolumeId;
    if (!volumeId) continue;

    await detachVolume(volumeId);
    await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    console.log(`Volume ${volumeId} deleted successfully`);
  }
}

async function detachVolume(volumeId) {
  console.log(`Detaching volume ${volumeId}...`);
  await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId }));

  for (let attempt = 1; attempt <= 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const attachmentState = response.Volumes?.[0]?.Attachments?.[0]?.State;

    if (!attachmentState || attachmentState === "detached") {
      console.log(`Volume ${volumeId} is now detached`);
      return;
    }
  }
  throw new Error(`Volume ${volumeId} did not detach within timeout`);
}

export { handleHibernate };
