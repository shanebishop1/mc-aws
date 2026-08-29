import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

async function processEvent(event) {
  const parameterName = event.ResourceProperties?.ParameterName || event.OldResourceProperties?.ParameterName;
  const physicalResourceId = event.PhysicalResourceId || parameterName;
  if (event.RequestType === "Delete") {
    // Deliberately retained. The teardown workflow owns confidential-data scrubbing,
    // and replacement/delete callbacks must never remove a credential still in use.
    return { PhysicalResourceId: physicalResourceId };
  }
  if (typeof parameterName !== "string" || !parameterName.startsWith("/minecraft/")) {
    throw new Error("DNS_SECURE_PARAMETER_NAME_INVALID");
  }
  try {
    const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
    if (response.Parameter?.Type !== "SecureString") throw new Error("DNS_SECURE_PARAMETER_TYPE_INVALID");
  } catch (error) {
    if (error?.message === "DNS_SECURE_PARAMETER_TYPE_INVALID") throw error;
    if (error?.name === "ParameterNotFound") throw new Error("DNS_SECURE_PARAMETER_NOT_FOUND");
    throw new Error("DNS_SECURE_PARAMETER_CHECK_FAILED");
  }
  console.log("[DNS_SECRET_ADOPTION] Existing SecureString verified; value not read or logged");
  return { PhysicalResourceId: physicalResourceId };
}

async function sendCloudFormationResponse(event, context, status, physicalResourceId) {
  const body = JSON.stringify({
    Status: status,
    Reason: status === "SUCCESS" ? "SecureString reference verified" : "SecureString reference verification failed",
    PhysicalResourceId: physicalResourceId || context?.logStreamName || "dns-secure-string-adoption",
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: true,
  });
  const response = await fetch(event.ResponseURL, {
    method: "PUT",
    headers: { "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  if (!response.ok) throw new Error("CLOUDFORMATION_RESPONSE_FAILED");
}

export const handler = async (event, context) => {
  try {
    const result = await processEvent(event);
    if (event.ResponseURL) await sendCloudFormationResponse(event, context, "SUCCESS", result.PhysicalResourceId);
    return result;
  } catch (error) {
    if (!event.ResponseURL) throw error;
    await sendCloudFormationResponse(event, context, "FAILED", event.PhysicalResourceId);
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
};

export { processEvent, sendCloudFormationResponse };
