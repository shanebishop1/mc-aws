/**
 * AWS CloudFormation client initialization and utilities
 */

import { CloudFormationClient, DescribeStacksCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { env } from "../env";
import { getAwsClientConfig } from "./aws-client-config";

// Lazy initialization of AWS client
let _cloudformationClient: CloudFormationClient | null = null;

function getRegion(): string {
  return env.AWS_REGION || "us-east-1";
}

export const cloudformation: CloudFormationClient = new Proxy({} as CloudFormationClient, {
  get(_target, prop) {
    if (!_cloudformationClient) {
      const region = getRegion();
      console.log(`[AWS Config] Initializing CloudFormation client in region: ${region}`);
      _cloudformationClient = new CloudFormationClient(getAwsClientConfig(region));
    }
    return _cloudformationClient[prop as keyof CloudFormationClient];
  },
});

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

/**
 * Get an output value from a CloudFormation stack.
 */
export async function getStackOutputValue(outputKey: string, stackName?: string): Promise<string | null> {
  const resolvedStackName = stackName || env.CLOUDFORMATION_STACK_NAME || "MinecraftStack";
  const stack = await getStackStatus(resolvedStackName);
  if (!stack?.Outputs || stack.Outputs.length === 0) {
    return null;
  }

  const match = stack.Outputs.find((o) => o.OutputKey === outputKey);
  return match?.OutputValue || null;
}
