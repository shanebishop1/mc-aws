import {
  AttachVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  ec2,
} from "../clients.js";
import { getOperationExecutionContext } from "../execution-context.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import { getOperationState, updateOperationState } from "../operation-state.js";
import {
  HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS,
  HIBERNATE_BACKUP_SSM_TIMEOUT_SECONDS,
  HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS,
  INSTANCE_STATE_MAX_ATTEMPTS,
  INSTANCE_STATE_POLL_INTERVAL_MS,
  VOLUME_DETACH_MAX_ATTEMPTS,
  VOLUME_DETACH_POLL_INTERVAL_MS,
} from "../runtime-budgets.js";
import { executeSSMCommand } from "../ssm.js";
import { handleRefreshBackups } from "./backups.js";

/**
 * Handle hibernate command - runs backup, stops instance, detaches/deletes volume
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} _args - Command arguments (unused)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The hibernate result message
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Durable phase resumption and recovery branches form one hibernate transaction.
async function handleHibernate(instanceId, _args, adminEmail) {
  console.log("Handling hibernate command for managed instance");
  let hibernateBackupAttempted = false;
  let stopRequested = false;
  let rootVolume;

  try {
    rootVolume = await resolveManagedRootVolume(instanceId);
    if (!rootVolume) return "Hibernation already complete; no root volume is attached.";
    const context = getOperationExecutionContext();
    const existingOperation = context ? await getOperationState(context.operationId) : null;
    const existingPhase = existingOperation?.hibernatePhase;
    if (!existingPhase) await recordHibernateVolume(rootVolume, "selected");
    await assertRootReconstructable(rootVolume);
    if (!hasReachedHibernatePhase(existingPhase, "backup-complete")) {
      console.log("Step 1: Running backup before hibernation...");
      hibernateBackupAttempted = true;
      await executeSSMCommand(
        instanceId,
        [
          "if grep -Fq -- '--hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --hibernate; else /usr/local/bin/mc-backup.sh; fi",
        ],
        {
          maxAttempts: HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS,
          timeoutSeconds: HIBERNATE_BACKUP_SSM_TIMEOUT_SECONDS,
          step: "hibernate-backup",
          finalRemoteStep: false,
        }
      );
      await recordHibernateVolume(rootVolume, "backup-complete");
    }

    if (!hasReachedHibernatePhase(existingPhase, "cache-refreshed")) {
      console.log("Step 2: Refreshing backup cache before removing the root volume...");
      await handleRefreshBackups(instanceId);
      await recordHibernateVolume(rootVolume, "cache-refreshed");
    }

    console.log("Step 3: Stopping instance...");
    stopRequested = true;
    await recordHibernateVolume(rootVolume, "stopping");
    await stopInstanceAndWait(instanceId);
    await recordHibernateVolume(rootVolume, "stopped");

    console.log("Step 4: Detaching and deleting the managed root volume...");
    await recordHibernateVolume(rootVolume, "detaching");
    await detachAndDeleteRootVolume(rootVolume);

    const message = "Hibernation completed successfully.";
    if (adminEmail) {
      await sendNotification(adminEmail, "Minecraft Server Hibernated", message).catch(() =>
        console.error("WARNING: Hibernation succeeded but notification failed")
      );
    }

    return message;
  } catch (error) {
    console.error("ERROR in handleHibernate.");
    if ((hibernateBackupAttempted || stopRequested) && error?.retainLifecycleLock !== true) {
      try {
        await recoverFailedHibernate(instanceId, rootVolume, stopRequested, error?.stopDeliveryOutcome);
      } catch (_recoveryError) {
        console.error("CRITICAL: Failed to recover Minecraft after aborted hibernation.");
        error.retainLifecycleLock = true;
      }
    }
    if (adminEmail) {
      await sendNotification(adminEmail, "Minecraft Hibernation Failed", getSanitizedErrorMessage("hibernate")).catch(
        () => console.error("WARNING: Failed to send hibernation failure notification")
      );
    }
    throw error;
  }
}

const HIBERNATE_PHASE_ORDER = new Map(
  ["selected", "backup-complete", "cache-refreshed", "stopping", "stopped", "detaching", "detached", "deleted"].map(
    (phase, index) => [phase, index]
  )
);

function hasReachedHibernatePhase(current, expected) {
  return (
    (HIBERNATE_PHASE_ORDER.get(current) ?? -1) >= (HIBERNATE_PHASE_ORDER.get(expected) ?? Number.POSITIVE_INFINITY)
  );
}

async function stopInstanceAndWait(instanceId) {
  const initial = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const initialState = initial.Reservations?.[0]?.Instances?.[0]?.State?.Name;
  if (initialState === "stopped") return;
  let stopDeliveryOutcome;
  if (initialState === "running" || initialState === "pending") {
    stopDeliveryOutcome = await requestInstanceStop(instanceId);
    console.log("Stop command sent, waiting for instance to stop...");
  } else if (initialState !== "stopping") {
    throw new Error(`Instance ${instanceId} cannot be stopped from state ${initialState}`);
  }

  for (let attempt = 1; attempt <= INSTANCE_STATE_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = Reservations?.[0]?.Instances?.[0]?.State?.Name;

    console.log(`Instance state poll (attempt ${attempt}/${INSTANCE_STATE_MAX_ATTEMPTS}): ${state}`);
    if (state === "stopped") {
      console.log("Managed instance is now stopped");
      return;
    }
  }
  const error = new Error(`Instance ${instanceId} did not stop within timeout`);
  if (stopDeliveryOutcome) error.stopDeliveryOutcome = stopDeliveryOutcome;
  throw error;
}

async function requestInstanceStop(instanceId) {
  try {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    return "accepted";
  } catch (error) {
    if (!isAmbiguousStopDeliveryError(error)) {
      error.stopDeliveryOutcome = "rejected";
      throw error;
    }

    try {
      error.stopDeliveryOutcome = await observeAmbiguousStopDelivery(instanceId);
      if (error.stopDeliveryOutcome === "accepted") {
        console.log("Stop command acceptance confirmed from the observed instance transition");
        return "accepted";
      }
      if (error.stopDeliveryOutcome === "ambiguous") error.retainLifecycleLock = true;
    } catch (_observationError) {
      error.stopDeliveryOutcome = "ambiguous";
      error.retainLifecycleLock = true;
    }
    throw error;
  }
}

function isAmbiguousStopDeliveryError(error) {
  if (error?.$metadata?.httpStatusCode) return false;
  return (
    ["TimeoutError", "RequestTimeout", "RequestTimeoutException", "NetworkingError"].includes(error?.name) ||
    ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(error?.code)
  );
}

async function observeAmbiguousStopDelivery(instanceId) {
  for (let attempt = 1; attempt <= HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
    const state = await readInstanceState(instanceId);
    console.log(`Ambiguous stop delivery poll (attempt ${attempt}/${HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS}): ${state}`);
    if (state === "stopping" || state === "stopped") return "accepted";
  }
  // DescribeInstances can remain stale after EC2 accepted the stop. Exhausting
  // observation without seeing the transition therefore cannot prove rejection.
  return "ambiguous";
}

async function resolveManagedRootVolume(instanceId) {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const rootMapping = (instance.BlockDeviceMappings || []).find(
    (mapping) => mapping.DeviceName === instance.RootDeviceName
  );
  const volumeId = rootMapping?.Ebs?.VolumeId;
  if (!volumeId) {
    await reconcileDetachedManagedVolume(instanceId);
    return null;
  }

  await assertManagedRootVolume(volumeId, instanceId);
  return {
    volumeId,
    instanceId,
    device: instance.RootDeviceName || "/dev/xvda",
    sourceImageId: instance.ImageId,
  };
}

async function assertRootReconstructable(rootVolume) {
  if (!rootVolume.sourceImageId) {
    throw new Error(`Refusing hibernation: managed instance ${rootVolume.instanceId} has no reconstruction AMI`);
  }
  const response = await ec2.send(new DescribeImagesCommand({ ImageIds: [rootVolume.sourceImageId] }));
  const image =
    response.Images?.find((candidate) => candidate.ImageId === rootVolume.sourceImageId) ?? response.Images?.[0];
  if (!image || (image.State && image.State !== "available")) {
    throw new Error(`Refusing hibernation: reconstruction AMI ${rootVolume.sourceImageId} is unavailable`);
  }
  const snapshotId = image.BlockDeviceMappings?.find((mapping) => mapping.DeviceName === rootVolume.device)?.Ebs
    ?.SnapshotId;
  if (!snapshotId) {
    throw new Error(`Refusing hibernation: reconstruction snapshot is missing for ${rootVolume.device}`);
  }
}

async function recordHibernateVolume(rootVolume, hibernatePhase) {
  const context = getOperationExecutionContext();
  if (!context) return;
  await updateOperationState({
    operationId: context.operationId,
    command: context.command,
    status: "running",
    phase: "executing",
    expectedExecutionToken: context.executionToken,
    managedVolumeId: rootVolume.volumeId,
    managedVolumeDevice: rootVolume.device,
    hibernatePhase,
  });
}

function isVolumeNotFound(error) {
  return error?.name === "InvalidVolume.NotFound" || error?.Code === "InvalidVolume.NotFound";
}

async function describeExactVolume(volumeId) {
  try {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    return response.Volumes?.[0] || null;
  } catch (error) {
    if (isVolumeNotFound(error)) return null;
    throw error;
  }
}

function assertDetachedVolumeIdentity(volume, volumeId) {
  const tags = new Map((volume.Tags || []).map(({ Key, Value }) => [Key, Value]));
  if (
    !process.env.MC_PROJECT_TAG ||
    !process.env.MC_STACK_TAG ||
    tags.get("McAwsProject") !== process.env.MC_PROJECT_TAG ||
    tags.get("McAwsStack") !== process.env.MC_STACK_TAG ||
    tags.get("McAwsManagedRoot") !== "true"
  ) {
    throw new Error(`Refusing detached-volume reconciliation for ${volumeId}: ownership tags do not match`);
  }
  if ((volume.Attachments || []).length > 0) {
    throw new Error(`Refusing detached-volume reconciliation for ${volumeId}: volume is still attached`);
  }
}

async function reconcileDetachedManagedVolume(instanceId) {
  const context = getOperationExecutionContext();
  const operation = context ? await getOperationState(context.operationId) : null;
  if (operation?.managedVolumeId) {
    const volume = await describeExactVolume(operation.managedVolumeId);
    if (!volume) {
      await recordHibernateVolume(
        {
          volumeId: operation.managedVolumeId,
          device: operation.managedVolumeDevice || "/dev/xvda",
        },
        "deleted"
      );
      return;
    }
    assertDetachedVolumeIdentity(volume, operation.managedVolumeId);
    if (volume.State !== "available") {
      throw new Error(`Managed detached volume ${operation.managedVolumeId} is in ambiguous state ${volume.State}`);
    }
    await ec2.send(new DeleteVolumeCommand({ VolumeId: operation.managedVolumeId }));
    await waitForVolumeDeleted(operation.managedVolumeId);
    await recordHibernateVolume(
      { volumeId: operation.managedVolumeId, device: operation.managedVolumeDevice || "/dev/xvda" },
      "deleted"
    );
    console.log("Reconciled and deleted the exact detached managed root volume");
    return;
  }

  if (!context) return;
  const candidates = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [
        { Name: "tag:McAwsProject", Values: [process.env.MC_PROJECT_TAG] },
        { Name: "tag:McAwsStack", Values: [process.env.MC_STACK_TAG] },
        { Name: "tag:McAwsManagedRoot", Values: ["true"] },
        { Name: "status", Values: ["available"] },
      ],
    })
  );
  if ((candidates.Volumes || []).length > 0) {
    throw new Error(
      `Hibernation cannot declare completion: ${candidates.Volumes.length} detached managed volume candidate(s) lack an exact durable identity for ${instanceId}`
    );
  }
  throw new Error(`Hibernation cannot declare completion without a durable managed root identity for ${instanceId}`);
}

async function detachAndDeleteRootVolume(rootVolume) {
  await detachVolume(rootVolume.volumeId, rootVolume.instanceId);
  await recordHibernateVolume(rootVolume, "detached");
  await ec2.send(new DeleteVolumeCommand({ VolumeId: rootVolume.volumeId }));
  await waitForVolumeDeleted(rootVolume.volumeId);
  await recordHibernateVolume(rootVolume, "deleted");
  console.log("Managed root volume deleted successfully");
}

async function waitForVolumeDeleted(volumeId) {
  for (let attempt = 1; attempt <= VOLUME_DETACH_MAX_ATTEMPTS; attempt++) {
    if (!(await describeExactVolume(volumeId))) return;
    await new Promise((resolve) => setTimeout(resolve, VOLUME_DETACH_POLL_INTERVAL_MS));
  }
  throw new Error(`Volume ${volumeId} deletion could not be confirmed within timeout`);
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
  console.log("Detaching managed volume");
  await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));

  for (let attempt = 1; attempt <= VOLUME_DETACH_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, VOLUME_DETACH_POLL_INTERVAL_MS));
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const attachmentState = response.Volumes?.[0]?.Attachments?.[0]?.State;

    if (!attachmentState || attachmentState === "detached") {
      console.log("Managed volume is now detached");
      return;
    }
  }
  throw new Error(`Volume ${volumeId} did not detach within timeout`);
}

async function waitForInstanceState(instanceId, expected) {
  for (let attempt = 1; attempt <= INSTANCE_STATE_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = response.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    if (state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
  }
  throw new Error(`Instance ${instanceId} did not reach ${expected} during hibernate recovery`);
}

async function waitForAcceptedStop(instanceId) {
  for (let attempt = 1; attempt <= HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS; attempt++) {
    const state = await readInstanceState(instanceId);
    console.log(`Accepted stop recovery poll (attempt ${attempt}/${HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS}): ${state}`);
    if (state === "stopped") return;
    if (state !== "running" && state !== "stopping" && state !== "pending") {
      throw new Error(`Cannot recover an accepted hibernation stop from instance state ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
  }
  throw new Error(`Instance ${instanceId} did not finish its accepted hibernation stop during recovery`);
}

async function ensureRecoveryVolumeAttached(rootVolume) {
  for (let attempt = 1; attempt <= VOLUME_DETACH_MAX_ATTEMPTS; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [rootVolume.volumeId] }));
    const volume = response.Volumes?.[0];
    if (!volume) throw new Error(`Root volume ${rootVolume.volumeId} no longer exists`);
    const attachment = (volume.Attachments || []).find((candidate) => candidate.InstanceId === rootVolume.instanceId);
    if (attachment?.State === "attached") return;
    if ((volume.Attachments || []).length === 0 && volume.State === "available") {
      await ec2.send(
        new AttachVolumeCommand({
          VolumeId: rootVolume.volumeId,
          InstanceId: rootVolume.instanceId,
          Device: rootVolume.device,
        })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, VOLUME_DETACH_POLL_INTERVAL_MS));
  }
  throw new Error(`Root volume ${rootVolume.volumeId} could not be reattached during hibernate recovery`);
}

async function recoverFailedHibernate(instanceId, rootVolume, stopRequested, stopDeliveryOutcome) {
  if (stopRequested && stopDeliveryOutcome !== "rejected") {
    if (!rootVolume) throw new Error("Cannot recover hibernation without the original root volume identity");
    if (stopDeliveryOutcome === "accepted") {
      // Once stop acceptance is known, a subsequent running read can only be
      // treated as stale. Wait for the accepted transition rather than sending
      // host recovery into an instance that is still about to stop.
      await waitForAcceptedStop(instanceId);
      await ensureRecoveryVolumeAttached(rootVolume);
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      await waitForInstanceState(instanceId, "running");
      await recoverHibernateService(instanceId);
      return;
    }
    const state = await readInstanceState(instanceId);
    if (state === "stopping") await waitForInstanceState(instanceId, "stopped");
    const observed = state === "stopping" ? "stopped" : state;
    if (observed === "stopped") {
      await ensureRecoveryVolumeAttached(rootVolume);
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      await waitForInstanceState(instanceId, "running");
    } else if (observed !== "running" && observed !== "pending") {
      throw new Error(`Cannot recover hibernation from instance state ${observed}`);
    }
  }
  await recoverHibernateService(instanceId);
}

async function recoverHibernateService(instanceId) {
  await executeSSMCommand(
    instanceId,
    [
      "if grep -Fq -- '--recover-hibernate' /usr/local/bin/mc-backup.sh; then /usr/local/bin/mc-backup.sh --recover-hibernate; else systemctl start minecraft.service; fi",
    ],
    {
      maxAttempts: 30,
      timeoutSeconds: 45,
      step: "hibernate-recovery",
      finalRemoteStep: false,
    }
  );
}

async function readInstanceState(instanceId) {
  const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return response.Reservations?.[0]?.Instances?.[0]?.State?.Name;
}

export { handleHibernate };
