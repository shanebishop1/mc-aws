import { GetItemCommand, UpdateItemCommand, getDynamoDbClient } from "./dynamodb-client";

export interface VersionedOperationRecord {
  version: number;
  payload: string;
}

function tableName(): string {
  const value = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for durable operation state");
  return value;
}

export async function readVersionedOperationRecord(operationId: string): Promise<VersionedOperationRecord | null> {
  const response = await getDynamoDbClient().send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: operationId } },
      ConsistentRead: true,
    })
  );
  const payload = response.Item?.payload?.S;
  const version = Number(response.Item?.version?.N ?? Number.NaN);
  return payload && Number.isSafeInteger(version) ? { payload, version } : null;
}

export async function writeVersionedOperationRecord(input: {
  operationId: string;
  expectedVersion: number;
  payload: string;
  status: string;
  phase: string;
  updatedAt: string;
  ttlEpochSeconds: number;
}): Promise<number> {
  const nextVersion = input.expectedVersion + 1;
  let hasLifecycleBinding = true;
  try {
    const payload = JSON.parse(input.payload) as { lockId?: unknown; fencingToken?: unknown };
    hasLifecycleBinding = typeof payload.lockId === "string" && Number.isSafeInteger(payload.fencingToken);
  } catch {
    // Malformed payloads fail safe: retention cleanup must review them manually.
  }
  const ttlEligible = (input.status === "completed" || input.status === "failed") && !hasLifecycleBinding;
  await getDynamoDbClient().send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: input.operationId } },
      ConditionExpression:
        input.expectedVersion === 0 ? "attribute_not_exists(operationId)" : "#version = :expectedVersion",
      UpdateExpression: ttlEligible
        ? "SET payload = :payload, #version = :nextVersion, #status = :status, phase = :phase, updatedAt = :updatedAt, ttlEpochSeconds = :ttl"
        : "SET payload = :payload, #version = :nextVersion, #status = :status, phase = :phase, updatedAt = :updatedAt REMOVE ttlEpochSeconds",
      ExpressionAttributeNames: { "#version": "version", "#status": "status" },
      ExpressionAttributeValues: {
        ...(input.expectedVersion === 0 ? {} : { ":expectedVersion": { N: String(input.expectedVersion) } }),
        ":payload": { S: input.payload },
        ":nextVersion": { N: String(nextVersion) },
        ":status": { S: input.status },
        ":phase": { S: input.phase },
        ":updatedAt": { S: input.updatedAt },
        ...(ttlEligible ? { ":ttl": { N: String(input.ttlEpochSeconds) } } : {}),
      },
    })
  );
  return nextVersion;
}

export function isOperationConditionalFailure(error: unknown): boolean {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}
