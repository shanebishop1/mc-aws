/**
 * Instance ID resolution utility
 * Extracted to avoid circular dependencies between EC2 and SSM clients
 */

import { env } from "../env";

/**
 * Find the Minecraft Server instance ID.
 * INSTANCE_ID must be set in .env file - no dynamic discovery
 */
export async function findInstanceId(): Promise<string> {
  if (env.INSTANCE_ID) {
    return env.INSTANCE_ID;
  }

  throw new Error("INSTANCE_ID is not set in .env file. Run ./setup.sh to configure it.");
}

/**
 * Resolve instance ID - uses provided ID or discovers it
 */
export async function resolveInstanceId(instanceId?: string): Promise<string> {
  return instanceId || (await findInstanceId());
}
