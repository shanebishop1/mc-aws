import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const dynamodb = new DynamoDBClient({});
const ssm = new SSMClient({});
const metadataKey = "protocol#dual-v1";
const protocol = "dual-v1";
const cutoverState = "provider-authoritative";
const legacyBridgeState = "absent";

function resourceIdentity(event) {
  return `${event.StackId || "unknown-stack"}:${event.LogicalResourceId || "MigrateServerActionLock"}`;
}

async function assertLegacyBridgeAbsent(parameterName) {
  try {
    await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: false }));
  } catch (error) {
    if (error?.name === "ParameterNotFound") return;
    throw error;
  }
  throw new Error("Legacy /minecraft/server-action bridge is still present; drain it before cutover");
}

function physicalResourceId(tableName, markerVersion) {
  return `${tableName}:${protocol}:${markerVersion}`;
}

async function initializeBridgeMetadata(event) {
  const tableName = event.ResourceProperties?.LockTableName;
  const markerVersion = String(event.ResourceProperties?.MarkerVersion || "1");
  const legacyParameterName = event.ResourceProperties?.LegacyParameterName || "/minecraft/server-action";
  if (!tableName) throw new Error("LockTableName is required");
  if (legacyParameterName !== "/minecraft/server-action") throw new Error("LegacyParameterName is invalid");
  await assertLegacyBridgeAbsent(legacyParameterName);
  const ownerToken = resourceIdentity(event);
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { lockKey: { S: metadataKey } },
      ConditionExpression:
        "(attribute_not_exists(ownerToken) OR ownerToken = :owner) AND (attribute_not_exists(cutoverState) OR cutoverState = :cutover)",
      UpdateExpression:
        "SET protocolVersion = :protocol, markerVersion = :version, ownerToken = :owner, tableName = :table, cutoverState = :cutover, legacyBridgeState = :legacy, barrierVersion = :barrier, initializedAt = if_not_exists(initializedAt, :now), updatedAt = :now",
      ExpressionAttributeValues: {
        ":protocol": { S: protocol },
        ":version": { S: markerVersion },
        ":owner": { S: ownerToken },
        ":table": { S: tableName },
        ":cutover": { S: cutoverState },
        ":legacy": { S: legacyBridgeState },
        ":barrier": { N: "1" },
        ":now": { S: new Date().toISOString() },
      },
    })
  );
  await assertLegacyBridgeAbsent(legacyParameterName);
  const verified = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { lockKey: { S: metadataKey } },
      ConsistentRead: true,
    })
  );
  if (
    verified.Item?.protocolVersion?.S !== protocol ||
    verified.Item?.markerVersion?.S !== markerVersion ||
    verified.Item?.ownerToken?.S !== ownerToken ||
    verified.Item?.cutoverState?.S !== cutoverState ||
    verified.Item?.legacyBridgeState?.S !== legacyBridgeState
  ) {
    throw new Error("Lifecycle bridge metadata verification failed");
  }
  return physicalResourceId(tableName, markerVersion);
}

export const handler = async (event) => {
  const tableName = event.ResourceProperties?.LockTableName || event.OldResourceProperties?.LockTableName || "unknown";
  const markerVersion = String(
    event.ResourceProperties?.MarkerVersion || event.OldResourceProperties?.MarkerVersion || "1"
  );
  if (event.RequestType === "Delete") {
    // Replacement and rollback safe: old-resource Delete must never remove the
    // metadata required by a replacement table/runtime generation.
    return { PhysicalResourceId: event.PhysicalResourceId || physicalResourceId(tableName, markerVersion) };
  }
  return { PhysicalResourceId: await initializeBridgeMetadata(event) };
};

export { assertLegacyBridgeAbsent, initializeBridgeMetadata, metadataKey, physicalResourceId };
