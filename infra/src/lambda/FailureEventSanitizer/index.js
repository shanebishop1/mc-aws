import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});
const allowedInvocationTypes = new Set(["api", "emailCommand", "scheduledBackup", "backupFreshnessCheck"]);
const allowedCommands = new Set(["start", "backup", "restore", "hibernate", "resume", "refreshBackups"]);

function boundedIdentifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,256}$/.test(value) ? value : undefined;
}

function sanitizedFailureRecord(event) {
  const request = event?.requestPayload || {};
  const invocationType = allowedInvocationTypes.has(request.invocationType) ? request.invocationType : "unknown";
  const command = allowedCommands.has(request.command) ? request.command : undefined;
  return {
    schemaVersion: 1,
    failureType: "async_execution_exhausted",
    invocationType,
    operationId: boundedIdentifier(request.operationId),
    eventId: boundedIdentifier(request.eventId || request.id),
    command,
    argumentCount: Array.isArray(request.args) ? Math.min(request.args.length, 2) : 0,
    attempts: Number.isSafeInteger(event?.requestContext?.approximateInvokeCount)
      ? event.requestContext.approximateInvokeCount
      : undefined,
    failedAt: new Date().toISOString(),
  };
}

export const handler = async (event) => {
  try {
    const record = sanitizedFailureRecord(event);
    await sqs.send(
      new SendMessageCommand({ QueueUrl: process.env.FAILURE_QUEUE_URL, MessageBody: JSON.stringify(record) })
    );
    console.log("[FAILURE_SANITIZER] Sanitized async failure recorded", JSON.stringify(record));
    return record;
  } catch {
    console.error("[FAILURE_SANITIZER] Failed to record sanitized failure; source payload omitted");
    throw new Error("FAILURE_SANITIZER_DELIVERY_FAILED");
  }
};

export { sanitizedFailureRecord };
