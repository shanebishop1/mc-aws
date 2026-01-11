import { DescribeInstancesCommand, StartInstancesCommand, ec2 } from "./clients.js";

// Max attempts to get IP (e.g., 300 attempts * 1s = 5 minutes)
export const MAX_POLL_ATTEMPTS = 300;
// Wait 1 second between polls
export const POLL_INTERVAL_MS = 1000;

/**
 * Check if instance is running, start it if stopped, and wait for running state
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
export async function ensureInstanceRunning(instanceId) {
  console.log(`Checking instance state for ${instanceId}...`);

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
    console.log(`Instance ${instanceId} is already running`);
    return;
  }

  // If stopped, start it
  if (currentState === "stopped") {
    console.log(`Instance ${instanceId} is stopped. Starting it...`);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(`Start command sent for instance ${instanceId}`);
  } else if (currentState === "stopping" || currentState === "pending") {
    console.log(`Instance ${instanceId} is in state ${currentState}. Waiting for stable state...`);
  } else {
    throw new Error(`Instance ${instanceId} is in unexpected state: ${currentState}`);
  }

  // Wait for instance to reach running state
  console.log(`Waiting for instance ${instanceId} to reach running state...`);
  let running = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 * 5 seconds = 5 minutes

  while (!running && attempts < maxAttempts) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

    try {
      const { Reservations: updatedReservations } = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );

      const updatedInstance = updatedReservations?.[0]?.Instances?.[0];
      const state = updatedInstance?.State?.Name;

      console.log(`Instance state: ${state} (attempt ${attempts}/${maxAttempts})`);

      if (state === "running") {
        running = true;
        console.log(`Instance ${instanceId} is now running`);
      }
    } catch (error) {
      console.error(`Error checking instance state on attempt ${attempts}:`, error);
    }
  }

  if (!running) {
    throw new Error(`Instance ${instanceId} did not reach running state within timeout`);
  }
}

/**
 * Get the public IP address of an EC2 instance
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The public IP address
 */
export async function getPublicIp(instanceId) {
  console.log(`Polling for public IP address for instance: ${instanceId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(`Polling attempt ${attempt}/${MAX_POLL_ATTEMPTS}...`);

    const result = await pollInstanceForIp(instanceId, attempt);
    if (result.ip) return result.ip;
    if (result.error) throw result.error;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`Failed to obtain public IP for instance ${instanceId} after ${MAX_POLL_ATTEMPTS} attempts.`);
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
      console.warn(`DescribeInstances response structure unexpected or empty for instance ${instanceId}.`);
      return {};
    }

    const inst = Reservations[0].Instances[0];
    const publicIp = inst.PublicIpAddress;
    const instanceState = inst.State?.Name;

    console.log(`Instance state: ${instanceState}, Public IP: ${publicIp}`);

    if (publicIp) {
      console.log(`Public IP found: ${publicIp}`);
      return { ip: publicIp };
    }

    if (["stopping", "stopped", "terminated", "shutting-down"].includes(instanceState)) {
      console.error(`Instance ${instanceId} entered unexpected state ${instanceState} while waiting for IP.`);
      return { error: new Error(`Instance entered unexpected state: ${instanceState}`) };
    }

    return {};
  } catch (describeError) {
    console.error(`Error describing instance ${instanceId} on attempt ${attempt}:`, describeError);
    if (attempt >= MAX_POLL_ATTEMPTS) {
      return { error: new Error(`Failed to describe instance after ${attempt} attempts: ${describeError.message}`) };
    }
    return {};
  }
}
