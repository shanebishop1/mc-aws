import { env } from "@/lib/env";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { getAwsClientConfig } from "./aws-client-config";

let client: DynamoDBClient | null = null;

export function getDynamoDbClient(): DynamoDBClient {
  if (!client) {
    client = new DynamoDBClient(getAwsClientConfig(env.AWS_REGION || "us-east-1"));
  }
  return client;
}

export { GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand };
