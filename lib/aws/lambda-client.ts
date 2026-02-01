/**
 * AWS Lambda client initialization and utilities
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "../env";

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
      _lambdaClient = new LambdaClient({ region });
    }
    return _lambdaClient[prop as keyof LambdaClient];
  },
});

/**
 * Invoke a Lambda function asynchronously (Event) or synchronously (RequestResponse)
 */
export async function invokeLambda(functionName: string, payload: any, invocationType: "Event" | "RequestResponse" = "Event"): Promise<void> {
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: invocationType,
    Payload: JSON.stringify(payload),
  });

  await lambda.send(command);
}
