/**
 * AWS Lambda client initialization and utilities
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "../env";
import { getAwsClientConfig } from "./aws-client-config";
import { getStackOutputValue } from "./cloudformation-client";

// Lazy initialization of AWS client
let _lambdaClient: LambdaClient | null = null;

function getRegion(): string {
  return env.AWS_REGION || "us-east-1";
}

export const lambda: LambdaClient = new Proxy({} as LambdaClient, {
  get(_target, prop) {
    if (!_lambdaClient) {
      const region = getRegion();
      console.log(`[AWS Config] Initializing Lambda client in region: ${region}`);
      _lambdaClient = new LambdaClient(getAwsClientConfig(region));
    }
    return _lambdaClient[prop as keyof LambdaClient];
  },
});

let _startMinecraftLambdaName: string | null | undefined;

async function resolveLambdaName(requestedName: string): Promise<string> {
  // The CDK stack creates the Lambda with an auto-generated name. The stack output
  // "LambdaFunctionName" is the stable way for the app to discover it.
  if (requestedName === "StartMinecraftServer" || requestedName.includes("StartMinecraftServer")) {
    if (_startMinecraftLambdaName !== undefined) {
      return _startMinecraftLambdaName || requestedName;
    }

    try {
      const resolved = await getStackOutputValue("LambdaFunctionName");
      _startMinecraftLambdaName = resolved;
      if (resolved) {
        console.log("[LAMBDA] Resolved StartMinecraftServer ->", resolved);
        return resolved;
      }
    } catch (error) {
      console.warn("[LAMBDA] Failed to resolve stack LambdaFunctionName:", error);
    }

    _startMinecraftLambdaName = null;
  }

  return requestedName;
}

/**
 * Invoke a Lambda function asynchronously (Event) or synchronously (RequestResponse)
 */
export async function invokeLambda(
  functionName: string,
  payload: unknown,
  invocationType: "Event" | "RequestResponse" = "Event"
): Promise<void> {
  const resolvedFunctionName = await resolveLambdaName(functionName);
  const command = new InvokeCommand({
    FunctionName: resolvedFunctionName,
    InvocationType: invocationType,
    Payload: JSON.stringify(payload),
  });

  await lambda.send(command);
}
