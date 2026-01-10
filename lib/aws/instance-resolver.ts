/**
 * Instance ID resolution utility
 * Extracted to avoid circular dependencies between EC2 and SSM clients
 */

import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { env } from "../env";

// Shared EC2 client for instance resolution
const region = env.AWS_REGION || "us-east-1";
const ec2 = new EC2Client({ region });

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
 * Resolve instance ID - uses provided ID or discovers it
 */
export async function resolveInstanceId(instanceId?: string): Promise<string> {
  return instanceId || (await findInstanceId());
}
