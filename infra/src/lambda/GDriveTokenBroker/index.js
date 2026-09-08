import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const GDRIVE_TOKEN_PARAMETER = "/minecraft/gdrive-token";
const MAX_PARAMETER_VALUE_BYTES = 4096;

function invalidRequest() {
  const error = new Error("GDRIVE_BROKER_REQUEST_INVALID");
  error.name = "GDriveTokenBrokerRequestError";
  return error;
}

function operationFrom(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw invalidRequest();
  const operation = event.operation;
  if (operation !== "get" && operation !== "put") throw invalidRequest();
  const allowedKeys = operation === "get" ? ["operation"] : ["operation", "value"];
  if (Object.keys(event).some((key) => !allowedKeys.includes(key))) throw invalidRequest();
  return operation;
}

async function getStatus() {
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: GDRIVE_TOKEN_PARAMETER, WithDecryption: false }));
    if (response.Parameter?.Type !== "SecureString" || !response.Parameter.Value) {
      throw new Error("GDRIVE_BROKER_PARAMETER_INVALID");
    }
    // Never return the encrypted value or any SSM response fields. The caller
    // only needs this sanitized boolean.
    return { configured: true };
  } catch (error) {
    if (error?.name === "ParameterNotFound") return { configured: false };
    if (error?.message === "GDRIVE_BROKER_PARAMETER_INVALID") throw error;
    throw new Error("GDRIVE_BROKER_STATUS_FAILED");
  }
}

async function putToken(event) {
  const value = event.value;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PARAMETER_VALUE_BYTES) {
    throw invalidRequest();
  }

  await ssm.send(
    new PutParameterCommand({
      Name: GDRIVE_TOKEN_PARAMETER,
      Type: "SecureString",
      Value: value,
      Overwrite: true,
    })
  );
  return { configured: true };
}

export async function processEvent(event) {
  const operation = operationFrom(event);
  return operation === "get" ? getStatus() : putToken(event);
}

export async function handler(event) {
  // Do not log the event or caught errors: both can contain OAuth credentials.
  return processEvent(event);
}
