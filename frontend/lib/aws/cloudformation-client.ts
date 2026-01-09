/**
 * AWS CloudFormation client initialization and utilities
 */

import { CloudFormationClient, DescribeStacksCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { env } from "../env";

// Initialize AWS client
const region = env.AWS_REGION || "us-east-1";
console.log(`[AWS Config] Initializing CloudFormation client in region: ${region}`);

export const cloudformation = new CloudFormationClient({ region });

/**
 * Get stack details from CloudFormation
 * Returns Stack object if exists, null if not found (ValidationError: Stack with id ... does not exist)
 * Throws on other AWS connection errors
 */
export async function getStackStatus(stackName = "MinecraftStack"): Promise<Stack | null> {
  try {
    const { Stacks } = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));

    if (!Stacks || Stacks.length === 0) {
      return null;
    }

    return Stacks[0];
  } catch (error) {
    if (error instanceof Error && error.name === "ValidationError" && error.message.includes("does not exist")) {
      console.log(`[CloudFormation] Stack "${stackName}" does not exist.`);
      return null;
    }

    console.error(`[CloudFormation] Error getting stack status for "${stackName}":`, error);
    throw error;
  }
}

/**
 * Simple boolean wrapper around getStackStatus to check if a stack exists
 */
export async function checkStackExists(stackName = "MinecraftStack"): Promise<boolean> {
  const stack = await getStackStatus(stackName);
  return stack !== null;
}
