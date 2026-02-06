/**
 * AWS SSM client initialization and utilities
 */

import {
  DeleteParameterCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { env } from "../env";
import type { BackupInfo } from "../types";
import { getAwsClientConfig } from "./aws-client-config";
import { resolveInstanceId } from "./instance-resolver";

// Lazy initialization of SSM client
let _ssmClient: SSMClient | null = null;

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

  if (status === "Failed") {
    const errorOutput = invocationResponse.StandardErrorContent || "";
    console.error(`SSM command failed. Error output: ${errorOutput}`);
    throw new Error(`SSM command failed: ${errorOutput}`);
  }

  return { status, output };
}

async function pollCommandCompletion(
  commandId: string,
  instanceId: string | undefined,
  maxAttempts = 60
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
  console.log(`Executing SSM command on instance ${resolvedId}: ${commands.join(" ")}`);

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

    console.log(`SSM command sent with ID: ${commandId}`);

    const output = await pollCommandCompletion(commandId, instanceId);
    console.log(`SSM command completed successfully. Final output: ${output}`);
    return output;
  } catch (error) {
    console.error("ERROR in executeSSMCommand:", error);
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
    console.log(`Listing backups from Google Drive on instance ${resolvedId}...`);

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
  } catch (error) {
    console.error("Error listing backups:", error);
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
  type: "String" | "SecureString" = "String"
): Promise<void> {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Type: type,
    Overwrite: true,
  });
  await ssm.send(command);
}

/**
 * Get a parameter from SSM Parameter Store
 */
export async function getParameter(name: string): Promise<string | null> {
  try {
    const command = new GetParameterCommand({
      Name: name,
    });
    const response = await ssm.send(command);
    return response.Parameter?.Value || null;
  } catch (error: unknown) {
    const errorWithName = error as { name?: string };
    if (errorWithName.name === "ParameterNotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a parameter from SSM Parameter Store
 */
export async function deleteParameter(name: string): Promise<void> {
  await ssm.send(
    new DeleteParameterCommand({
      Name: name,
    })
  );
}
