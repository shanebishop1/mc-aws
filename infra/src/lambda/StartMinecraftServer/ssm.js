import {
  DeleteParameterCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
  ssm,
} from "./clients.js";
import { SSM_MAX_ATTEMPTS, SSM_POLL_INTERVAL_MS } from "./runtime-budgets.js";

/**
 * Execute an SSM command on an EC2 instance and wait for completion
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} commands - Array of commands to execute
 * @returns {Promise<string>} The command output
 */
async function executeSSMCommand(instanceId, commands) {
  console.log(`Executing SSM command on instance ${instanceId}: ${commands.join(" ")}`);

  const sendResponse = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands },
    })
  );

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) throw new Error("Failed to get command ID from SSM response");

  console.log(`SSM command sent with ID: ${commandId}`);
  return await waitForSSMCompletion(commandId, instanceId);
}

async function waitForSSMCompletion(commandId, instanceId) {
  const maxAttempts = SSM_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SSM_POLL_INTERVAL_MS));

    try {
      const response = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = response.Status;

      console.log(`Poll attempt ${attempt}/${maxAttempts} - Command status: ${status}`);

      if (status === "Success") return response.StandardOutputContent || "";
      if (status === "Failed") {
        const errorOutput = response.StandardErrorContent || "";
        console.error(`SSM command failed. Error output: ${errorOutput}`);
        throw new Error(`SSM command failed: ${errorOutput}`);
      }
    } catch (error) {
      if (error.name !== "InvocationDoesNotExist") throw error;
      console.log(`Poll attempt ${attempt}/${maxAttempts}: Command still processing...`);
    }
  }

  throw new Error(`SSM command did not complete within ${(maxAttempts * SSM_POLL_INTERVAL_MS) / 1000} seconds`);
}

async function deleteParameter(name) {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
    console.log(`Successfully deleted parameter: ${name}`);
  } catch (error) {
    if (error.name === "ParameterNotFound") {
      console.log(`Parameter already deleted or not found: ${name}`);
      return;
    }
    console.error(`Error deleting parameter ${name}:`, error);
    throw error;
  }
}

async function putParameter(name, value, type = "String") {
  try {
    const command = new PutParameterCommand({
      Name: name,
      Value: value,
      Type: type,
      Overwrite: true,
    });
    await ssm.send(command);
    console.log(`Successfully put parameter: ${name}`);
  } catch (error) {
    console.error(`Error putting parameter ${name}:`, error);
    throw error;
  }
}

async function getParameter(name) {
  try {
    const response = await ssm.send(
      new GetParameterCommand({
        Name: name,
      })
    );
    return response.Parameter?.Value || null;
  } catch (error) {
    if (error.name === "ParameterNotFound") {
      return null;
    }
    throw error;
  }
}

export { executeSSMCommand, deleteParameter, getParameter, putParameter };
