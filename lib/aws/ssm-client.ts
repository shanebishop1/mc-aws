/**
 * AWS SSM client initialization and utilities
 */

import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { env } from "../env";
import type { BackupInfo } from "../types";
import { getAwsClientConfig } from "./aws-client-config";
import { resolveInstanceId } from "./instance-resolver";
import type { ParameterStoreEntry, SsmMutationProof } from "./types";

// Lazy initialization of SSM client
let _ssmClient: SSMClient | null = null;

const SSM_TERMINAL_FAILURE_STATUSES = new Set([
  "Cancelled",
  "TimedOut",
  "Cancelling",
  "DeliveryTimedOut",
  "ExecutionTimedOut",
  "Failed",
  "Undeliverable",
  "Terminated",
]);

export function isSSMTerminalFailureStatus(status: string | undefined): boolean {
  return status !== undefined && SSM_TERMINAL_FAILURE_STATUSES.has(status);
}

function getRegion(): string {
  return env.AWS_REGION || "us-east-1";
}

export const ssm: SSMClient = new Proxy({} as SSMClient, {
  get(_target, prop) {
    if (!_ssmClient) {
      _ssmClient = new SSMClient(getAwsClientConfig(getRegion()));
    }
    return _ssmClient[prop as keyof SSMClient];
  },
});

async function checkCommandStatus(commandId: string, instanceId: string | undefined) {
  const invocationResponse = await ssm.send(
    new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId,
    })
  );

  const status = invocationResponse.Status;
  const output = invocationResponse.StandardOutputContent || "";

  if (isSSMTerminalFailureStatus(status)) {
    const errorOutput = invocationResponse.StandardErrorContent || "";
    const failureDetail = errorOutput || `command entered terminal status ${status}`;
    console.error(`SSM command failed with status ${status}; command output omitted`);
    throw new Error(`SSM command failed: ${failureDetail}`);
  }

  return { status, output };
}

async function pollCommandCompletion(
  commandId: string,
  instanceId: string | undefined,
  maxAttempts = 300
): Promise<string> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const { status, output } = await checkCommandStatus(commandId, instanceId);
      console.log(`Poll attempt ${attempts}/${maxAttempts} - Command status: ${status}`);

      if (status === "Success") {
        return output;
      }
    } catch (error) {
      const errorWithName = error as { name?: string; message?: string };
      if (errorWithName.name === "InvocationDoesNotExist") {
        console.log(`Poll attempt ${attempts}/${maxAttempts}: Command still processing...`);
      } else {
        throw error;
      }
    }
  }

  throw new Error(`SSM command did not complete within ${maxAttempts * 2} seconds`);
}

/**
 * Execute an SSM command on an EC2 instance
 */
export async function executeSSMCommand(instanceId: string | undefined, commands: string[]): Promise<string> {
  const resolvedId = await resolveInstanceId(instanceId);
  console.log(`Executing ${commands.length} SSM command(s) on managed instance`);

  try {
    const sendResponse = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [resolvedId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands,
        },
      })
    );

    const commandId = sendResponse.Command?.CommandId;
    if (!commandId) {
      throw new Error("Failed to get command ID from SSM response");
    }

    console.log("SSM command sent");

    const output = await pollCommandCompletion(commandId, instanceId);
    console.log("SSM command completed successfully; output omitted");
    return output;
  } catch (error) {
    console.error("SSM command execution failed");
    throw error;
  }
}

/**
 * List available backups from Google Drive via rclone on EC2
 */
export async function listBackups(instanceId?: string): Promise<BackupInfo[]> {
  if (!env.GDRIVE_REMOTE || !env.GDRIVE_ROOT) {
    console.warn("Google Drive config not set (GDRIVE_REMOTE or GDRIVE_ROOT missing)");
    return [];
  }

  const resolvedId = await resolveInstanceId(instanceId);

  try {
    console.log("Listing backups from Google Drive on managed instance");

    // p - path, s - size, t - modification time
    const command = `rclone lsf ${env.GDRIVE_REMOTE}:${env.GDRIVE_ROOT}/ --format "pst" --separator "|"`;
    const output = await executeSSMCommand(resolvedId, [command]);

    // Parse output - each line is name|size|date
    const backups = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, size, date] = line.split("|");
        return {
          name,
          size: size || "unknown",
          date: date || "unknown",
        };
      })
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")); // Most recent first

    console.log(`Found ${backups.length} backups`);
    return backups;
  } catch {
    console.error("Error listing backups");
    return [];
  }
}

/**
 * Get email allowlist from SSM Parameter Store
 */
export async function getEmailAllowlist(): Promise<string[]> {
  try {
    const command = new GetParameterCommand({
      Name: "/minecraft/email-allowlist",
    });
    const response = await ssm.send(command);
    const value = response.Parameter?.Value || "";
    return value
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  } catch (error: unknown) {
    // Parameter may not exist yet
    const errorWithName = error as { name?: string };
    if (errorWithName.name === "ParameterNotFound") {
      return [];
    }
    throw error;
  }
}

/**
 * Update email allowlist in SSM Parameter Store
 */
export async function updateEmailAllowlist(emails: string[]): Promise<void> {
  const command = new PutParameterCommand({
    Name: "/minecraft/email-allowlist",
    Value: emails.join(","),
    Type: "String",
    Overwrite: true,
  });
  await ssm.send(command);
}

/**
 * Get player count from SSM Parameter Store
 */
export async function getPlayerCount(): Promise<{ count: number; lastUpdated: string }> {
  try {
    const command = new GetParameterCommand({
      Name: "/minecraft/player-count",
    });
    const response = await ssm.send(command);
    const count = Number.parseInt(response.Parameter?.Value || "0", 10);
    const lastUpdated = response.Parameter?.LastModifiedDate?.toISOString() || new Date().toISOString();

    return { count, lastUpdated };
  } catch (error: unknown) {
    // Parameter may not exist yet
    const errorWithName = error as { name?: string };
    if (errorWithName.name === "ParameterNotFound") {
      return { count: 0, lastUpdated: new Date().toISOString() };
    }
    throw error;
  }
}

/**
 * Set a parameter in SSM Parameter Store
 */
export async function putParameter(
  name: string,
  value: string,
  type: "String" | "SecureString" = "String",
  overwrite = true
): Promise<number | undefined> {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Type: type,
    Overwrite: overwrite,
  });
  const response = await ssm.send(command);
  if (!Number.isSafeInteger(response.Version) || (response.Version as number) < 1) {
    throw new Error("SSM_PUT_PARAMETER_VERSION_MISSING");
  }
  return response.Version;
}

/**
 * Get a parameter from SSM Parameter Store
 */
export async function getParameter(name: string): Promise<string | null> {
  const record = await getParameterRecord(name);
  return record?.value ?? null;
}

/** Read the value and the actual SSM resource version as one record. */
export async function getParameterRecord(name: string): Promise<ParameterStoreEntry | null> {
  try {
    const command = new GetParameterCommand({
      Name: name,
    });
    const response = await ssm.send(command);
    if (typeof response.Parameter?.Value !== "string") return null;
    if (!Number.isSafeInteger(response.Parameter.Version) || (response.Parameter.Version as number) < 1) return null;
    return {
      name,
      value: response.Parameter.Value,
      type: response.Parameter.Type,
      version: response.Parameter.Version,
      lastModifiedAt: response.Parameter.LastModifiedDate?.toISOString(),
    };
  } catch (error: unknown) {
    const errorWithName = error as { name?: string };
    if (errorWithName.name === "ParameterNotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * SSM has no conditional DeleteParameter API. A read followed by delete is not
 * a compare-and-swap because another writer can replace the resource between
 * those calls. Production therefore fails closed; the serialized mock store
 * provides the equivalent operation for local tests only.
 */
export async function deleteParameterIfCurrent(name: string, proof: SsmMutationProof): Promise<boolean> {
  void name;
  void proof;
  return false;
}

/** SSM has no conditional PutParameter counterpart; do not emulate one with reads. */
export async function putParameterIfCurrent(
  name: string,
  value: string,
  proof: SsmMutationProof,
  type: "String" | "SecureString" = "String",
  overwrite = true
): Promise<boolean> {
  void name;
  void value;
  void proof;
  void type;
  void overwrite;
  return false;
}

/**
 * List parameters under a path from SSM Parameter Store
 */
export async function listParametersByPath(path: string): Promise<ParameterStoreEntry[]> {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return [];
  }

  const normalizedPath = trimmedPath.endsWith("/") ? trimmedPath.slice(0, -1) : trimmedPath;
  const entries: ParameterStoreEntry[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ssm.send(
      new GetParametersByPathCommand({
        Path: normalizedPath,
        Recursive: true,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: nextToken,
      })
    );

    for (const parameter of response.Parameters ?? []) {
      if (!parameter.Name || typeof parameter.Value !== "string") {
        continue;
      }

      entries.push({
        name: parameter.Name,
        value: parameter.Value,
        type: parameter.Type,
        version: parameter.Version,
        lastModifiedAt: parameter.LastModifiedDate?.toISOString(),
      });
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return entries;
}

export async function deleteParameter(name: string): Promise<void> {
  void name;
  throw new Error("Unconditional SSM deletion is unavailable; use an authoritative conditional backend");
}
