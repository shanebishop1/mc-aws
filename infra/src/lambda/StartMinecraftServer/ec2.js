import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, ec2 } from "./clients.js";
import {
  INSTANCE_STATE_MAX_ATTEMPTS,
  INSTANCE_STATE_POLL_INTERVAL_MS,
  PUBLIC_IP_MAX_ATTEMPTS,
  PUBLIC_IP_POLL_INTERVAL_MS,
} from "./runtime-budgets.js";

// Max attempts to get IP
export const MAX_POLL_ATTEMPTS = PUBLIC_IP_MAX_ATTEMPTS;
// Wait between public IP polls
export const POLL_INTERVAL_MS = PUBLIC_IP_POLL_INTERVAL_MS;

/**
 * Read the current instance state without changing it.
 * Scheduled maintenance uses this path so it can never wake a stopped server.
 */
export async function getInstanceState(instanceId) {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`Instance ${instanceId} not found`);
  return instance.State?.Name || "unknown";
}

/**
 * Check if instance is running, start it if stopped, and wait for running state
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: EC2's transitional state machine is kept explicit for crash recovery auditability.
export async function ensureInstanceRunning(instanceId) {
  console.log("Checking managed instance state");

  // Get current instance state
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));

  if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = Reservations[0].Instances[0];
  const currentState = instance.State?.Name;

  console.log(`Current instance state: ${currentState}`);

  // If already running, no action needed
  if (currentState === "running") {
    console.log("Managed instance is already running");
    return;
  }

  // If stopped, start it
  let startRequested = false;
  if (currentState === "stopped") {
    console.log("Managed instance is stopped; starting it");
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    startRequested = true;
    console.log("Start command sent for managed instance");
  } else if (currentState === "stopping" || currentState === "pending") {
    console.log(`Managed instance is in state ${currentState}; waiting for stable state`);
  } else {
    throw new Error(`Instance ${instanceId} is in unexpected state: ${currentState}`);
  }

  // Wait for instance to reach running state
  console.log("Waiting for managed instance to reach running state");
  let running = false;
  let attempts = 0;
  const maxAttempts = INSTANCE_STATE_MAX_ATTEMPTS;

  while (!running && attempts < maxAttempts) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));

    try {
      const { Reservations: updatedReservations } = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );

      const updatedInstance = updatedReservations?.[0]?.Instances?.[0];
      const state = updatedInstance?.State?.Name;

      console.log(`Instance state: ${state} (attempt ${attempts}/${maxAttempts})`);

      if (state === "running") {
        running = true;
        console.log("Managed instance is now running");
      } else if (state === "stopped" && !startRequested) {
        console.log("Managed instance finished stopping; starting it now");
        await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
        startRequested = true;
      }
    } catch {
      console.error(`Error checking managed instance state on attempt ${attempts}`);
    }
  }

  if (!running) {
    throw new Error(`Instance ${instanceId} did not reach running state within timeout`);
  }
}

/** Stop the managed instance idempotently and wait until EC2 confirms it is stopped. */
export async function ensureInstanceStopped(instanceId) {
  let state = await getInstanceState(instanceId);
  if (state === "stopped") return;
  if (state === "running" || state === "pending") {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  } else if (state !== "stopping") {
    throw new Error(`Instance ${instanceId} is in unexpected state: ${state}`);
  }
  for (let attempt = 1; attempt <= INSTANCE_STATE_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, INSTANCE_STATE_POLL_INTERVAL_MS));
    state = await getInstanceState(instanceId);
    if (state === "stopped") return;
  }
  const error = new Error(`Instance ${instanceId} did not reach stopped state within timeout`);
  error.retainLifecycleLock = true;
  throw error;
}

/**
 * Get the public IP address of an EC2 instance
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The public IP address
 */
export async function getPublicIp(instanceId) {
  console.log("Polling for managed instance public IP address");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(`Polling attempt ${attempt}/${MAX_POLL_ATTEMPTS}...`);

    const result = await pollInstanceForIp(instanceId, attempt);
    if (result.ip) return result.ip;
    if (result.error) throw result.error;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`Failed to obtain managed instance public IP after ${MAX_POLL_ATTEMPTS} attempts`);
  throw new Error("Timed out waiting for public IP address.");
}

/**
 * Helper function to poll an EC2 instance for its public IP address
 * @param {string} instanceId - The EC2 instance ID
 * @param {number} attempt - Current attempt number
 * @returns {Promise<{ip?: string, error?: Error}>} IP address or error
 */
async function pollInstanceForIp(instanceId, attempt) {
  try {
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));

    if (!Reservations?.length || !Reservations[0].Instances?.length) {
      console.warn("DescribeInstances response structure unexpected or empty for managed instance");
      return {};
    }

    const inst = Reservations[0].Instances[0];
    const publicIp = inst.PublicIpAddress;
    const instanceState = inst.State?.Name;

    console.log(`Instance state: ${instanceState}, public IP assigned: ${Boolean(publicIp)}`);

    if (publicIp) {
      console.log("Managed instance public IP found");
      return { ip: publicIp };
    }

    if (["terminated", "shutting-down"].includes(instanceState)) {
      console.error(`Managed instance entered terminal state ${instanceState} while waiting for IP`);
      return { error: new Error(`Instance entered unexpected state: ${instanceState}`) };
    }

    // If we just issued a start, DescribeInstances can briefly lag. Treat early "stopped/stopping"
    // as a transient observation and keep polling for a short grace window.
    if (["stopping", "stopped"].includes(instanceState)) {
      const graceAttempts = 10;
      if (attempt <= graceAttempts) {
        console.warn(
          `Instance ${instanceId} is ${instanceState} while waiting for IP (attempt ${attempt}/${MAX_POLL_ATTEMPTS}); continuing...`
        );
        return {};
      }

      console.error(`Managed instance entered unexpected state ${instanceState} while waiting for IP`);
      return { error: new Error(`Instance entered unexpected state: ${instanceState}`) };
    }

    return {};
  } catch (describeError) {
    console.error(`Error describing managed instance on attempt ${attempt}`);
    if (attempt >= MAX_POLL_ATTEMPTS) {
      return { error: new Error(`Failed to describe instance after ${attempt} attempts: ${describeError.message}`) };
    }
    return {};
  }
}
