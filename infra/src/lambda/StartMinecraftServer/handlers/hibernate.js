import {
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StopInstancesCommand,
  ec2,
} from "../clients.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import {
  INSTANCE_STATE_MAX_ATTEMPTS,
  INSTANCE_STATE_POLL_INTERVAL_MS,
  VOLUME_DETACH_MAX_ATTEMPTS,
  VOLUME_DETACH_POLL_INTERVAL_MS,
} from "../runtime-budgets.js";
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

    console.log("Step 3: Detaching and deleting the managed root volume...");
    await detachAndDeleteRootVolume(instanceId);

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

  for (let attempt = 1; attempt <= INSTANCE_STATE_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = Reservations?.[0]?.Instances?.[0]?.State?.Name;

    console.log(`Instance state poll (attempt ${attempt}/${INSTANCE_STATE_MAX_ATTEMPTS}): ${state}`);
    if (state === "stopped") {
      console.log(`Instance ${instanceId} is now stopped`);
      return;
    }
  }
  throw new Error(`Instance ${instanceId} did not stop within timeout`);
}

async function detachAndDeleteRootVolume(instanceId) {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const rootMapping = (instance.BlockDeviceMappings || []).find(
    (mapping) => mapping.DeviceName === instance.RootDeviceName
  );
  const volumeId = rootMapping?.Ebs?.VolumeId;
  if (!volumeId) {
    console.log(`Instance ${instanceId} has no attached root volume. Skipping volume deletion.`);
    return;
  }

  await assertManagedRootVolume(volumeId, instanceId);
  await detachVolume(volumeId, instanceId);
  await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
  console.log(`Managed root volume ${volumeId} deleted successfully`);
}

async function assertManagedRootVolume(volumeId, instanceId) {
  const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
  const volume = response.Volumes?.[0];
  if (!volume) throw new Error(`Root volume ${volumeId} was not found`);

  const tags = new Map((volume.Tags || []).map(({ Key, Value }) => [Key, Value]));
  const expectedProject = process.env.MC_PROJECT_TAG;
  const expectedStack = process.env.MC_STACK_TAG;
  const belongsToInstance = (volume.Attachments || []).some((attachment) => attachment.InstanceId === instanceId);

  if (
    !expectedProject ||
    !expectedStack ||
    tags.get("McAwsProject") !== expectedProject ||
    tags.get("McAwsStack") !== expectedStack ||
    tags.get("McAwsManagedRoot") !== "true" ||
    !belongsToInstance
  ) {
    throw new Error(`Refusing to delete root volume ${volumeId}: project ownership could not be verified`);
  }
}

async function detachVolume(volumeId, instanceId) {
  console.log(`Detaching volume ${volumeId}...`);
  await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));

  for (let attempt = 1; attempt <= VOLUME_DETACH_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, VOLUME_DETACH_POLL_INTERVAL_MS));
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
