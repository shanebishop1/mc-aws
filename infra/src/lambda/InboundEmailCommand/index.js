import { createHash } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const lambda = new LambdaClient({});
const ssm = new SSMClient({});
const allowlistParameter = "/minecraft/email-allowlist";
const maximumMimeBytes = 512 * 1024;

function uniqueEmails(values) {
  return [
    ...new Set(
      values
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    ),
  ];
}

function extractAddress(value) {
  const match = String(value || "").match(/<([^<>]+)>/);
  return (match?.[1] || value || "").trim().toLowerCase();
}

function extractEmails(value) {
  return uniqueEmails(String(value || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []);
}

function sanitizeBackupName(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(normalized)) return null;
  return normalized;
}

function parseCommand(subject, startKeyword) {
  const tokens = String(subject || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0] === startKeyword && tokens.length === 1) return { command: "start", args: [] };
  if (["hibernate", "resume"].includes(tokens[0]) && tokens.length === 1) return { command: tokens[0], args: [] };
  if (["backup", "restore"].includes(tokens[0]) && tokens.length <= 2) {
    if (tokens.length === 1) return { command: tokens[0], args: [] };
    const name = sanitizeBackupName(tokens[1]);
    return name ? { command: tokens[0], args: [name] } : null;
  }
  return null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep every raw-event trust and size check at one ingress boundary.
function parseSnsSesEvent(event) {
  if (!Array.isArray(event?.Records) || event.Records.length !== 1) return null;
  const record = event.Records[0];
  if ((record.EventSource || record.eventSource) !== "aws:sns") return null;
  const sns = record.Sns;
  if (!sns?.Message || sns.TopicArn !== process.env.EXPECTED_TOPIC_ARN) return null;
  const payload = JSON.parse(sns.Message);
  const sender = extractAddress(payload.mail?.commonHeaders?.from?.[0]);
  const messageId = payload.mail?.messageId || sns.MessageId;
  const expectedRecipient = String(process.env.EXPECTED_RECIPIENT || "").toLowerCase();
  const recipients = uniqueEmails([...(payload.mail?.destination || []), ...(payload.receipt?.recipients || [])]);
  if (!sender || !messageId || !expectedRecipient || !recipients.includes(expectedRecipient)) return null;
  const verdicts = [
    payload.receipt?.spfVerdict?.status,
    payload.receipt?.dkimVerdict?.status,
    payload.receipt?.dmarcVerdict?.status,
  ];
  if (verdicts.some((verdict) => verdict !== "PASS")) return null;
  const encodedContent = typeof payload.content === "string" ? payload.content : "";
  if (encodedContent.length > Math.ceil((maximumMimeBytes * 4) / 3) + 4) return null;
  const mime = Buffer.from(encodedContent, "base64");
  if (mime.byteLength > maximumMimeBytes) return null;
  const mimeText = mime.toString("utf8");
  const bodyStart = mimeText.search(/\r?\n\r?\n/);
  return {
    sender,
    subject: String(payload.mail?.commonHeaders?.subject || "").slice(0, 256),
    body: bodyStart === -1 ? "" : mimeText.slice(bodyStart).slice(0, maximumMimeBytes),
    operationId: `email-${createHash("sha256").update(String(messageId)).digest("hex").slice(0, 40)}`,
    requestedAt:
      typeof payload.mail?.timestamp === "string" && !Number.isNaN(Date.parse(payload.mail.timestamp))
        ? new Date(payload.mail.timestamp).toISOString()
        : undefined,
  };
}

async function getAllowlist() {
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: allowlistParameter }));
    return uniqueEmails(String(response.Parameter?.Value || "").split(","));
  } catch (error) {
    if (error?.name === "ParameterNotFound") return [];
    throw error;
  }
}

async function updateAllowlist(addresses) {
  await ssm.send(
    new PutParameterCommand({ Name: allowlistParameter, Value: addresses.join(","), Type: "String", Overwrite: true })
  );
}

async function processEvent(event) {
  const email = parseSnsSesEvent(event);
  if (!email) return { statusCode: 400, body: "Rejected inbound message." };
  const adminEmail = String(process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  const isAdmin = Boolean(adminEmail) && email.sender === adminEmail;
  const startKeyword = String(process.env.START_KEYWORD || "start")
    .trim()
    .toLowerCase();

  if (isAdmin && email.subject.trim().toLowerCase() === "allowlist") {
    const requested = extractEmails(email.body);
    if (requested.length === 0) return { statusCode: 200, body: "No allowlist update requested." };
    const baseline = uniqueEmails([adminEmail, ...String(process.env.ALLOWED_EMAILS || "").split(",")]);
    await updateAllowlist(uniqueEmails([...baseline, ...requested]));
    console.log("[EMAIL_INGRESS] allowlist command completed");
    return { statusCode: 200, body: "Allowlist updated." };
  }

  const command = parseCommand(email.subject, startKeyword);
  if (!command) return { statusCode: 200, body: "No supported command." };
  if (!isAdmin) {
    const allowlist = uniqueEmails([...(await getAllowlist()), ...String(process.env.ALLOWED_EMAILS || "").split(",")]);
    if (!allowlist.includes(email.sender) || command.command !== "start") {
      return { statusCode: 403, body: "Not authorized." };
    }
  }

  const payload = {
    invocationType: "emailCommand",
    operationId: email.operationId,
    command: command.command,
    args: command.args,
    requestedAt: email.requestedAt,
  };
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.LIFECYCLE_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
  console.log(
    "[EMAIL_INGRESS] sanitized command dispatched",
    JSON.stringify({ command: command.command, operationId: email.operationId })
  );
  return { statusCode: 202, body: "Command accepted." };
}

export const handler = async (event) => {
  try {
    return await processEvent(event);
  } catch {
    console.error("[EMAIL_INGRESS] retryable processing failure; payload omitted");
    throw new Error("EMAIL_INGRESS_RETRYABLE");
  }
};

export { parseCommand, parseSnsSesEvent, processEvent };
