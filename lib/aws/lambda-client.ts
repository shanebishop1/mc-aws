/**
 * AWS Lambda client initialization and utilities
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "../env";
import { getAwsClientConfig } from "./aws-client-config";
import { getStackOutputValue } from "./cloudformation-client";
import { resolveInstanceId } from "./instance-resolver";
import type { MinecraftServiceStatus } from "./types";

// Lazy initialization of AWS client
let _lambdaClient: LambdaClient | null = null;

function getRegion(): string {
  return env.AWS_REGION || "us-east-1";
}

export const lambda: LambdaClient = new Proxy({} as LambdaClient, {
  get(_target, prop) {
    if (!_lambdaClient) {
      _lambdaClient = new LambdaClient(getAwsClientConfig(getRegion()));
    }
    return _lambdaClient[prop as keyof LambdaClient];
  },
});

let _startMinecraftLambdaName: string | null | undefined;
let _gdriveTokenBrokerLambdaName: string | null | undefined;

type LambdaNameCache = {
  get(): string | null | undefined;
  set(value: string | null): void;
};

async function resolveSpecificLambdaName(
  requestedName: string,
  matches: (name: string) => boolean,
  outputName: string,
  cache: LambdaNameCache,
  label: string,
  warning: string
): Promise<string | null> {
  if (!matches(requestedName)) return null;
  const cached = cache.get();
  if (cached !== undefined) return cached || requestedName;

  try {
    const resolved = await getStackOutputValue(outputName);
    cache.set(resolved);
    if (resolved) {
      console.log(`[LAMBDA] Resolved ${label} ->`, resolved);
      return resolved;
    }
  } catch {
    console.warn(warning);
  }

  cache.set(null);
  return requestedName;
}

async function resolveLambdaName(requestedName: string): Promise<string> {
  const startMinecraftName = await resolveSpecificLambdaName(
    requestedName,
    (name) => name === "StartMinecraftServer" || name.includes("StartMinecraftServer"),
    "LambdaFunctionName",
    {
      get: () => _startMinecraftLambdaName,
      set: (value) => {
        _startMinecraftLambdaName = value;
      },
    },
    "StartMinecraftServer",
    "[LAMBDA] Failed to resolve managed Lambda function name"
  );
  if (startMinecraftName !== null) return startMinecraftName;

  const gdriveTokenBrokerName = await resolveSpecificLambdaName(
    requestedName,
    (name) => name === "GDriveTokenBroker" || name.includes("GDriveTokenBroker"),
    "GDriveTokenBrokerFunctionName",
    {
      get: () => _gdriveTokenBrokerLambdaName,
      set: (value) => {
        _gdriveTokenBrokerLambdaName = value;
      },
    },
    "GDriveTokenBroker",
    "[LAMBDA] Failed to resolve managed Google Drive token broker name"
  );
  if (gdriveTokenBrokerName !== null) return gdriveTokenBrokerName;

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

  const response = await lambda.send(command);
  const expectedStatus = invocationType === "Event" ? 202 : 200;
  if (response.StatusCode !== undefined && response.StatusCode !== expectedStatus) {
    const error = new Error("Lambda invocation was rejected before dispatch");
    Object.assign(error, { name: "LambdaInvokeRejectedError", remoteDispatchRejected: true });
    throw error;
  }
}

/**
 * Ask the lifecycle Lambda for one fixed, sanitized host-read operation.
 *
 * The Worker deliberately has no SSM command permissions. In particular, do
 * not replace this with a direct SendCommand/GetCommandInvocation pair: the
 * Lambda consumes the fixed service-status command and returns only booleans
 * and the instance state.
 */
export async function getMinecraftServiceStatus(instanceId?: string): Promise<MinecraftServiceStatus> {
  const resolvedInstanceId = await resolveInstanceId(instanceId);
  const resolvedFunctionName = await resolveLambdaName("StartMinecraftServer");
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: resolvedFunctionName,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify({ invocationType: "serviceStatus", instanceId: resolvedInstanceId }),
    })
  );

  if (response.FunctionError) {
    throw new Error("Managed service status operation failed");
  }

  const payload = decodeLambdaPayload(response.Payload);
  const body = payload && typeof payload === "object" ? (payload as { body?: unknown }).body : undefined;
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Managed service status operation returned an invalid response");
    }
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).instanceState !== "string" ||
    typeof (parsed as Record<string, unknown>).instanceRunning !== "boolean" ||
    typeof (parsed as Record<string, unknown>).serviceActive !== "boolean"
  ) {
    throw new Error("Managed service status operation returned an invalid response");
  }

  return parsed as MinecraftServiceStatus;
}

export interface GDriveTokenBrokerRequest {
  operation: "get" | "put";
  value?: string;
}

export interface GDriveTokenBrokerResponse {
  configured: boolean;
}

/**
 * Invoke only the fixed Drive token broker operation. The broker owns SSM
 * access and returns no credential material, even for a successful write.
 */
export async function invokeGdriveTokenBroker(request: GDriveTokenBrokerRequest): Promise<GDriveTokenBrokerResponse> {
  if (request.operation === "put" && typeof request.value !== "string") {
    throw new Error("Google Drive token broker request is invalid");
  }
  if (request.operation === "get") {
    if (request.value !== undefined) throw new Error("Google Drive token broker request is invalid");
  }

  const functionName = await resolveLambdaName("GDriveTokenBroker");
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify(request),
    })
  );

  if (response.FunctionError) throw new Error("Google Drive token broker operation failed");
  const payload = decodeLambdaPayload(response.Payload);
  const body = payload && typeof payload === "object" ? (payload as { body?: unknown }).body : undefined;
  let parsed: unknown = body === undefined ? payload : body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("Google Drive token broker returned an invalid response");
    }
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).configured !== "boolean") {
    throw new Error("Google Drive token broker returned an invalid response");
  }
  return { configured: (parsed as { configured: boolean }).configured };
}

function decodeLambdaPayload(payload: Uint8Array | string | undefined): unknown {
  if (!payload) return undefined;
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Managed service status operation returned an invalid response");
  }
}
