/**
 * AWS EC2 client initialization and utilities
 */

import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { env } from "../env";
import { ServerState } from "../types";

// Initialize AWS client
const region = env.AWS_REGION || "us-east-1";
console.log(`[AWS Config] Initializing EC2 client in region: ${region}`);

export const ec2 = new EC2Client({ region });

// Constants for polling
export const MAX_POLL_ATTEMPTS = 300;
export const POLL_INTERVAL_MS = 1000;

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

  console.log(
    `[Discovery] Searching for instance with tag:Name = MinecraftServer OR MinecraftStack/MinecraftServer in region ${env.AWS_REGION}`
  );

  try {
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Name", Values: ["MinecraftServer", "MinecraftStack/MinecraftServer"] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] },
        ],
      })
    );

    const instanceFn = Reservations?.[0]?.Instances?.[0];
    if (instanceFn?.InstanceId) {
      console.log(`[Discovery] Discovered Instance ID: ${instanceFn.InstanceId} (${instanceFn.State?.Name})`);
      return instanceFn.InstanceId;
    }
    console.warn("[Discovery] No instances found matching filters.");
  } catch (err) {
    console.error("[Discovery] Failed to discover instance ID:", err);
    throw err;
  }

  throw new Error(
    `Could not find Minecraft Server. Searched for tag Name=MinecraftServer OR MinecraftStack/MinecraftServer in ${env.AWS_REGION}`
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
      return ServerState.Unknown;
    }

    const instance = Reservations[0].Instances[0];
    const currentState = instance.State?.Name;
    const blockDeviceMappings = instance.BlockDeviceMappings || [];

    if (currentState === "running") {
      return ServerState.Running;
    }
    if (currentState === "stopped" && blockDeviceMappings.length === 0) {
      return ServerState.Hibernating;
    }
    if (currentState === "stopped") {
      return ServerState.Stopped;
    }
    if (currentState === "pending") {
      return ServerState.Pending;
    }
    if (currentState === "stopping") {
      return ServerState.Stopping;
    }
    if (currentState === "terminated") {
      return ServerState.Terminated;
    }

    return ServerState.Unknown;
  } catch (error) {
    console.error("Error getting instance state:", error);
    return ServerState.Unknown;
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
