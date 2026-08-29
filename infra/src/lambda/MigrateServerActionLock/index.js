import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({});
const metadataKey = "protocol#dual-v1";
const protocol = "dual-v1";

function resourceIdentity(event) {
  return `${event.StackId || "unknown-stack"}:${event.LogicalResourceId || "MigrateServerActionLock"}`;
}

function physicalResourceId(tableName, markerVersion) {
  return `${tableName}:${protocol}:${markerVersion}`;
}

async function initializeBridgeMetadata(event) {
  const tableName = event.ResourceProperties?.LockTableName;
  const markerVersion = String(event.ResourceProperties?.MarkerVersion || "1");
  if (!tableName) throw new Error("LockTableName is required");
  const ownerToken = resourceIdentity(event);
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { lockKey: { S: metadataKey } },
      ConditionExpression: "attribute_not_exists(ownerToken) OR ownerToken = :owner",
      UpdateExpression:
        "SET protocolVersion = :protocol, markerVersion = :version, ownerToken = :owner, tableName = :table, initializedAt = if_not_exists(initializedAt, :now), updatedAt = :now",
      ExpressionAttributeValues: {
        ":protocol": { S: protocol },
        ":version": { S: markerVersion },
        ":owner": { S: ownerToken },
        ":table": { S: tableName },
        ":now": { S: new Date().toISOString() },
      },
    })
  );
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
    verified.Item?.ownerToken?.S !== ownerToken
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

export { initializeBridgeMetadata, metadataKey, physicalResourceId };
