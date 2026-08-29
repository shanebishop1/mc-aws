import { createHash } from "node:crypto";
import {
  CancelCommandCommand,
  DeleteParameterCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
  ssm,
} from "./clients.js";
import { getOperationExecutionContext } from "./execution-context.js";
import {
  heartbeatOperationExecution,
  recordOperationRemoteCommand,
  recordOperationRemoteCommandIdentity,
} from "./operation-state.js";
import {
  SSM_CANCEL_MAX_ATTEMPTS,
  SSM_MAX_ATTEMPTS,
  SSM_POLL_INTERVAL_MS,
  SSM_SEND_MAX_ATTEMPTS,
  SSM_SEND_RETRY_INTERVAL_MS,
  SSM_TIMEOUT_SECONDS,
} from "./runtime-budgets.js";

const SSM_NOT_READY_ERRORS = new Set(["InvalidInstanceId", "TargetNotConnected"]);
const SSM_TRANSIENT_POLL_ERRORS = new Set([
  "ThrottlingException",
  "InternalServerError",
  "ServiceUnavailable",
  "RequestTimeout",
  "TimeoutError",
]);
const SSM_TRANSIENT_POLL_MAX_ATTEMPTS = 3;
const SSM_AMBIGUOUS_SEND_ERRORS = new Set([
  "ThrottlingException",
  "InternalServerError",
  "ServiceUnavailable",
  "RequestTimeout",
  "TimeoutError",
  "NetworkingError",
]);
const SSM_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const SSM_CANCELLATION_RESERVE_MS = 25 * 1000;
const SSM_NON_TERMINAL_STATUSES = new Set(["Pending", "InProgress", "In Progress", "Delayed", "Cancelling"]);
const SSM_FAILURE_STATUSES = new Set([
  "Failed",
  "Cancelled",
  "TimedOut",
  "DeliveryTimedOut",
  "Delivery Timed Out",
  "ExecutionTimedOut",
  "Execution Timed Out",
  "Undeliverable",
  "Terminated",
  "AccessDenied",
]);

class SSMCommandUnresolvedError extends Error {
  constructor(commandId, code) {
    super(code);
    this.name = "SSMCommandUnresolvedError";
    this.code = code;
    Object.defineProperty(this, "commandId", { value: commandId, enumerable: false });
    this.retainLifecycleLock = true;
  }
}

class SSMCommandTerminalError extends Error {
  constructor(status) {
    const normalizedStatus = String(status).replaceAll(" ", "_").toUpperCase();
    super(`SSM_COMMAND_TERMINAL:${normalizedStatus}`);
    this.name = "SSMCommandTerminalError";
    this.code = "ssm_command_terminal";
    this.status = status;
    this.ssmTerminal = true;
  }
}

/**
 * Execute an SSM command on an EC2 instance and wait for completion
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} commands - Array of commands to execute
 * @returns {Promise<string>} The command output
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Durable dispatch identity, polling, and cancellation form one command transaction.
async function executeSSMCommand(instanceId, commands, options = {}) {
  console.log(`Executing ${commands.length} SSM command(s) on managed instance`);

  const executionContext = getOperationExecutionContext();
  const deadlineMs = options.deadlineMs ?? executionContext?.deadlineMs ?? Number.POSITIVE_INFINITY;
  const remainingForCommandMs = deadlineMs - Date.now() - SSM_CANCELLATION_RESERVE_MS;
  if (remainingForCommandMs < 30_000) {
    throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_BUDGET_INSUFFICIENT");
  }
  const timeoutSeconds = Math.max(
    30,
    Math.min(options.timeoutSeconds ?? SSM_TIMEOUT_SECONDS, Math.floor(remainingForCommandMs / 1000))
  );
  const commandIdentity = executionContext
    ? `mc-aws:${createHash("sha256")
        .update(`${executionContext.operationId}\0${options.step || "remote-command"}`)
        .digest("hex")}`
    : undefined;
  if (executionContext && commandIdentity) {
    await recordOperationRemoteCommandIdentity({
      ...executionContext,
      identity: commandIdentity,
      instanceId,
      step: options.step,
      final: options.finalRemoteStep,
    });
  }
  const durableCommands = commandIdentity ? wrapIdempotentRemoteCommands(commands, commandIdentity) : commands;
  const sendResponse = await sendCommandWhenReady(instanceId, durableCommands, timeoutSeconds, commandIdentity);

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_ID_MISSING");

  if (executionContext) {
    try {
      await recordOperationRemoteCommand({
        ...executionContext,
        commandId,
        identity: commandIdentity,
        instanceId,
        step: options.step,
        final: options.finalRemoteStep,
      });
    } catch (error) {
      try {
        await cancelCommandAndWait(commandId, instanceId, deadlineMs);
      } catch {
        throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_IDENTITY_UNRECORDED");
      }
      throw error;
    }
  }

  console.log("SSM command sent");
  try {
    return await waitForSSMCompletion(commandId, instanceId, options.maxAttempts, deadlineMs);
  } catch (error) {
    if (error?.ssmTerminal === true) throw error;
    const terminal = await cancelCommandAndWait(commandId, instanceId, deadlineMs);
    if (terminal.status === "Success") return terminal.output;
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSM readiness retries and ambiguous acceptance discovery must stay coupled.
async function sendCommandWhenReady(instanceId, commands, timeoutSeconds, commandIdentity) {
  for (let attempt = 1; attempt <= SSM_SEND_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ssm.send(
        new SendCommandCommand({
          InstanceIds: [instanceId],
          DocumentName: "AWS-RunShellScript",
          Parameters: { commands, executionTimeout: [String(timeoutSeconds)] },
          ...(timeoutSeconds ? { TimeoutSeconds: timeoutSeconds } : {}),
          ...(commandIdentity ? { Comment: commandIdentity } : {}),
        })
      );
      if (response.Command?.CommandId) return response;
      if (attempt === SSM_SEND_MAX_ATTEMPTS) {
        throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_ID_MISSING");
      }
    } catch (error) {
      if (error instanceof SSMCommandUnresolvedError) throw error;
      const errorName = error instanceof Error ? error.name : "";
      const retryable =
        SSM_NOT_READY_ERRORS.has(errorName) || (Boolean(commandIdentity) && SSM_AMBIGUOUS_SEND_ERRORS.has(errorName));
      if (!retryable || attempt === SSM_SEND_MAX_ATTEMPTS) {
        throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_DELIVERY_FAILED");
      }

      console.log(`SSM command delivery unresolved (attempt ${attempt}/${SSM_SEND_MAX_ATTEMPTS}); retrying safely...`);
      await new Promise((resolve) => setTimeout(resolve, SSM_SEND_RETRY_INTERVAL_MS));
    }
  }

  throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_DELIVERY_RETRY_EXHAUSTED");
}

function wrapIdempotentRemoteCommands(commands, identity) {
  if (!/^mc-aws:[a-f0-9]{64}$/.test(identity)) {
    throw new TypeError("Invalid remote command identity");
  }
  const key = identity.slice("mc-aws:".length);
  const encoded = Buffer.from(
    `set -euo pipefail\nexport MC_REMOTE_OPERATION_KEY=${key}\n${commands.join("\n")}`,
    "utf8"
  ).toString("base64");
  const stateDirectory = "/var/lib/mc-aws/ssm-operations";
  const backupJournal = "/var/lib/mc-aws/mc-backup-journal.json";
  const script = `set -euo pipefail
install -d -m 700 ${stateDirectory}
exec 9>${stateDirectory}/${key}.lock
flock 9
ack_backup_journal() {
  exec 8>/tmp/mc-operation.lock
  flock 8
  python3 - ${backupJournal} ${key} <<'PY'
import json
import os
import sys

journal, expected_key = sys.argv[1:]
try:
    with open(journal, encoding="utf-8") as source:
        value = json.load(source)
except FileNotFoundError:
    raise SystemExit(0)
except (OSError, ValueError) as error:
    raise SystemExit(f"backup journal acknowledgment failed: {error}")

if (
    value.get("version") != 1
    or value.get("phase") != "restart-complete"
    or value.get("operationKey") != expected_key
):
    raise SystemExit(0)

os.unlink(journal)
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  flock -u 8
}
if [[ -f ${stateDirectory}/${key}.done ]]; then
  ack_backup_journal
  cat ${stateDirectory}/${key}.out
  exit 0
fi
tmp=$(mktemp ${stateDirectory}/${key}.out.XXXXXX)
if printf %s ${encoded} | base64 -d | bash >"$tmp"; then
  chmod 600 "$tmp"
  python3 - "$tmp" ${stateDirectory}/${key}.out ${stateDirectory}/${key}.done <<'PY'
import os
import sys

temporary, output, done = sys.argv[1:]
with open(temporary, "rb") as pending:
    os.fsync(pending.fileno())
os.replace(temporary, output)
directory_path = os.path.dirname(output)
directory = os.open(directory_path, os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)

done_temporary = f"{done}.new.{os.getpid()}"
with open(done_temporary, "x", encoding="ascii") as marker:
    marker.write("complete\\n")
    marker.flush()
    os.fsync(marker.fileno())
os.replace(done_temporary, done)
directory = os.open(directory_path, os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  ack_backup_journal
  cat ${stateDirectory}/${key}.out
else
  rc=$?
  rm -f "$tmp"
  exit "$rc"
fi`;
  return [script];
}

function getInvocationStatus(response) {
  return response.StatusDetails || response.Status || "Unknown";
}

function isTerminalStatus(status) {
  return status === "Success" || SSM_FAILURE_STATUSES.has(status);
}

function assertKnownStatus(status) {
  if (isTerminalStatus(status) || SSM_NON_TERMINAL_STATUSES.has(status)) return;
  throw new SSMCommandUnresolvedError(null, "SSM_COMMAND_STATUS_UNKNOWN");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: All SSM status and retry branches remain together for auditability.
async function waitForSSMCompletion(commandId, instanceId, configuredMaxAttempts, deadlineMs) {
  const maxAttempts = configuredMaxAttempts ?? SSM_MAX_ATTEMPTS;
  let transientFailures = 0;
  let lastHeartbeatAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() + SSM_POLL_INTERVAL_MS >= deadlineMs - SSM_CANCELLATION_RESERVE_MS) break;
    await new Promise((resolve) => setTimeout(resolve, SSM_POLL_INTERVAL_MS));

    try {
      const response = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = getInvocationStatus(response);

      console.log(`Poll attempt ${attempt}/${maxAttempts} - Command status: ${status}`);

      const executionContext = getOperationExecutionContext();
      if (executionContext && Date.now() - lastHeartbeatAt >= SSM_HEARTBEAT_INTERVAL_MS) {
        await heartbeatOperationExecution(executionContext);
        lastHeartbeatAt = Date.now();
      }
      if (status === "Success") {
        if (executionContext) {
          await recordOperationRemoteCommand({
            ...executionContext,
            commandId,
            instanceId,
            status,
          });
        }
        return response.StandardOutputContent || "";
      }
      if (SSM_FAILURE_STATUSES.has(status)) {
        console.error("SSM command failed; raw command output omitted from logs and exceptions.");
        throw new SSMCommandTerminalError(status);
      }
      assertKnownStatus(status);
    } catch (error) {
      if (error?.ssmTerminal === true) throw error;
      if (error?.name === "InvocationDoesNotExist") {
        console.log(`Poll attempt ${attempt}/${maxAttempts}: Command still processing...`);
        continue;
      }
      if (SSM_TRANSIENT_POLL_ERRORS.has(error?.name) && transientFailures < SSM_TRANSIENT_POLL_MAX_ATTEMPTS) {
        transientFailures += 1;
        console.warn(`Transient SSM polling failure ${transientFailures}/${SSM_TRANSIENT_POLL_MAX_ATTEMPTS}`);
        continue;
      }
      if (error instanceof SSMCommandUnresolvedError) throw error;
      throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_STATUS_UNRESOLVED");
    }
  }

  throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_POLL_BUDGET_EXCEEDED");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation races and all terminal status branches must remain auditable together.
async function cancelCommandAndWait(commandId, instanceId, deadlineMs = Number.POSITIVE_INFINITY) {
  try {
    await ssm.send(new CancelCommandCommand({ CommandId: commandId, InstanceIds: [instanceId] }));
  } catch (error) {
    if (error?.name !== "InvalidCommandId") {
      throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_CANCEL_FAILED");
    }
  }

  for (let attempt = 1; attempt <= SSM_CANCEL_MAX_ATTEMPTS; attempt++) {
    if (Date.now() + SSM_POLL_INTERVAL_MS >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(resolve, SSM_POLL_INTERVAL_MS));
    try {
      const response = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = getInvocationStatus(response);
      if (isTerminalStatus(status))
        return { status, output: status === "Success" ? response.StandardOutputContent || "" : "" };
      assertKnownStatus(status);
    } catch (error) {
      if (error?.name === "InvocationDoesNotExist") continue;
      if (SSM_TRANSIENT_POLL_ERRORS.has(error?.name)) continue;
      if (error instanceof SSMCommandUnresolvedError) throw error;
      throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_CANCELLATION_STATUS_UNRESOLVED");
    }
  }

  throw new SSMCommandUnresolvedError(commandId, "SSM_COMMAND_CANCELLATION_UNCONFIRMED");
}

async function reconcileRemoteCommand(state) {
  if (!state?.remoteCommandInstanceId || (!state?.remoteCommandId && !state?.remoteCommandIdentity)) {
    return { terminal: false, status: "unrecorded" };
  }
  try {
    const commandId = state.remoteCommandId;
    if (!commandId && state.remoteCommandIdentity) {
      // A takeover resends the same host-journaled identity. The host-side flock and
      // success marker either wait for/replay an accepted command or execute it once.
      return { terminal: true, success: false, status: "IdentityRetryRequired" };
    }
    const response = await ssm.send(
      new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: state.remoteCommandInstanceId,
      })
    );
    const status = getInvocationStatus(response);
    assertKnownStatus(status);
    return {
      terminal: isTerminalStatus(status),
      success: status === "Success",
      status,
    };
  } catch (error) {
    if (error?.name === "InvocationDoesNotExist" || SSM_TRANSIENT_POLL_ERRORS.has(error?.name)) {
      return { terminal: false, status: error?.name || "unknown" };
    }
    throw error;
  }
}

function shouldRetainLifecycleLock(error) {
  return error?.retainLifecycleLock === true;
}

async function deleteParameter(name) {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
    console.log("Successfully deleted managed parameter");
  } catch (error) {
    if (error.name === "ParameterNotFound") {
      console.log("Managed parameter already deleted or not found");
      return;
    }
    console.error("Error deleting managed parameter");
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
    console.log("Successfully wrote managed parameter");
  } catch (error) {
    console.error("Error writing managed parameter");
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

export {
  deleteParameter,
  executeSSMCommand,
  getParameter,
  putParameter,
  reconcileRemoteCommand,
  shouldRetainLifecycleLock,
  wrapIdempotentRemoteCommands,
};
