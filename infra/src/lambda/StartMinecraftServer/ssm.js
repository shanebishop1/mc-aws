import {
  DeleteParameterCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
  ssm,
} from "./clients.js";
import {
  SSM_MAX_ATTEMPTS,
  SSM_POLL_INTERVAL_MS,
  SSM_SEND_MAX_ATTEMPTS,
  SSM_SEND_RETRY_INTERVAL_MS,
} from "./runtime-budgets.js";

const SSM_NOT_READY_ERRORS = new Set(["InvalidInstanceId", "TargetNotConnected"]);

/**
 * Execute an SSM command on an EC2 instance and wait for completion
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} commands - Array of commands to execute
 * @returns {Promise<string>} The command output
 */
async function executeSSMCommand(instanceId, commands, options = {}) {
  console.log(`Executing ${commands.length} SSM command(s) on instance ${instanceId}`);

  const sendResponse = await sendCommandWhenReady(instanceId, commands, options.timeoutSeconds);

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) throw new Error("Failed to get command ID from SSM response");

  console.log(`SSM command sent with ID: ${commandId}`);
  return await waitForSSMCompletion(commandId, instanceId, options.maxAttempts);
}

async function sendCommandWhenReady(instanceId, commands, timeoutSeconds) {
  for (let attempt = 1; attempt <= SSM_SEND_MAX_ATTEMPTS; attempt++) {
    try {
      return await ssm.send(
        new SendCommandCommand({
          InstanceIds: [instanceId],
          DocumentName: "AWS-RunShellScript",
          Parameters: { commands },
          ...(timeoutSeconds ? { TimeoutSeconds: timeoutSeconds } : {}),
        })
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "";
      if (!SSM_NOT_READY_ERRORS.has(errorName) || attempt === SSM_SEND_MAX_ATTEMPTS) {
        throw error;
      }

      console.log(
        `SSM managed node is not ready (attempt ${attempt}/${SSM_SEND_MAX_ATTEMPTS}); retrying command delivery...`
      );
      await new Promise((resolve) => setTimeout(resolve, SSM_SEND_RETRY_INTERVAL_MS));
    }
  }

  throw new Error("SSM command delivery retry budget exhausted");
}

function buildSSMFailureOutput(response) {
  const errorOutput = response.StandardErrorContent || "";
  const standardOutput = response.StandardOutputContent || "";
  const failureOutput = errorOutput || standardOutput || "No command output available";

  console.error("SSM command failed; raw command output omitted from logs.");

  return failureOutput;
}

async function waitForSSMCompletion(commandId, instanceId, configuredMaxAttempts) {
  const maxAttempts = configuredMaxAttempts ?? SSM_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SSM_POLL_INTERVAL_MS));

    try {
      const response = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = response.Status;

      console.log(`Poll attempt ${attempt}/${maxAttempts} - Command status: ${status}`);

      if (status === "Success") return response.StandardOutputContent || "";
      if (["Failed", "Cancelled", "TimedOut", "DeliveryTimedOut", "ExecutionTimedOut"].includes(status)) {
        throw new Error(`SSM command failed: ${buildSSMFailureOutput(response)}`);
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

async function putParameter(name, value, type = "String", overwrite = true) {
  try {
    const command = new PutParameterCommand({
      Name: name,
      Value: value,
      Type: type,
      Overwrite: overwrite,
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
