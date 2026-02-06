/**
 * Instance ID resolution utility
 * Extracted to avoid circular dependencies between EC2 and SSM clients
 */

import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { env } from "../env";
import { getAwsClientConfig } from "./aws-client-config";

// Lazy initialization to avoid resolving AWS credentials at module load time.
let _resolverEc2Client: EC2Client | null = null;

function getRegion(): string {
  return env.AWS_REGION || "us-east-1";
}

function getResolverEc2Client(): EC2Client {
  if (!_resolverEc2Client) {
    _resolverEc2Client = new EC2Client(getAwsClientConfig(getRegion()));
  }
  return _resolverEc2Client;
}

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

  const region = getRegion();
  console.log(
    `[Discovery] Searching for instance with tag:Name = MinecraftServer OR MinecraftStack/MinecraftServer in region ${region}`
  );

  try {
    const { Reservations } = await getResolverEc2Client().send(
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
    `Could not find Minecraft Server. Searched for tag Name=MinecraftServer OR MinecraftStack/MinecraftServer in ${region}`
  );
}

/**
 * Resolve instance ID - uses provided ID or discovers it
 */
export async function resolveInstanceId(instanceId?: string): Promise<string> {
  return instanceId || (await findInstanceId());
}
