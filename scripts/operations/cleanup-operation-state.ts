import { pathToFileURL } from "node:url";
import {
  cleanupExpiredDurableOperationStates,
  getDurableOperationStateRetentionMs,
} from "@/lib/durable-operation-state";
import {
  type AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  ScanCommand,
  type ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";

const oneDayMs = 24 * 60 * 60 * 1000;

export interface CliOptions {
  dryRun: boolean;
  includeLegacySsm: boolean;
  legacySsmOnly: boolean;
  retentionDays?: number;
  maxDeletions?: number;
}

interface DynamoCandidate {
  operationId: string;
  version: number;
  updatedAt: string;
  timestampMs: number;
}

export function parsePositiveIntegerFlag(flag: string, value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a safe positive integer.`);
  return parsed;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, includeLegacySsm: false, legacySsmOnly: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--include-legacy-ssm") options.includeLegacySsm = true;
    else if (arg === "--legacy-ssm-only") options.legacySsmOnly = true;
    else if (arg.startsWith("--retention-days="))
      options.retentionDays = parsePositiveIntegerFlag("--retention-days", arg.split("=", 2)[1]);
    else if (arg.startsWith("--max-deletions="))
      options.maxDeletions = parsePositiveIntegerFlag("--max-deletions", arg.split("=", 2)[1]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.legacySsmOnly) options.includeLegacySsm = true;
  return options;
}

function parseDynamoCandidate(item: Record<string, AttributeValue>): DynamoCandidate | null {
  const operationId = item?.operationId?.S;
  const updatedAt = item?.updatedAt?.S;
  const version = Number(item?.version?.N ?? Number.NaN);
  const timestampMs = Date.parse(updatedAt ?? "");
  if (!operationId || !updatedAt || !Number.isSafeInteger(version) || Number.isNaN(timestampMs)) return null;
  return { operationId, updatedAt, version, timestampMs };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pagination, retention selection, dry-run, and conditional race handling stay visibly ordered.
export async function cleanupDynamoDbOperations(input: {
  client: Pick<DynamoDBClient, "send">;
  tableName: string;
  cutoffMs: number;
  maxDeletions: number;
  dryRun: boolean;
}): Promise<{ scanned: number; expired: number; selected: string[]; deleted: string[]; skipped: string[] }> {
  const candidates: DynamoCandidate[] = [];
  let scanned = 0;
  let exclusiveStartKey: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page = (await input.client.send(
      new ScanCommand({
        TableName: input.tableName,
        ProjectionExpression: "operationId, #version, updatedAt",
        ExpressionAttributeNames: { "#version": "version" },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      })
    )) as ScanCommandOutput;
    scanned += page.Items?.length ?? 0;
    for (const item of page.Items ?? []) {
      const candidate = parseDynamoCandidate(item);
      if (candidate && candidate.timestampMs <= input.cutoffMs) candidates.push(candidate);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  candidates.sort((a, b) => a.timestampMs - b.timestampMs || a.operationId.localeCompare(b.operationId));
  const selectedCandidates = candidates.slice(0, input.maxDeletions);
  const deleted: string[] = [];
  const skipped: string[] = [];
  if (!input.dryRun) {
    for (const candidate of selectedCandidates) {
      try {
        await input.client.send(
          new DeleteItemCommand({
            TableName: input.tableName,
            Key: { operationId: { S: candidate.operationId } },
            ConditionExpression: "#version = :version AND updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": { N: String(candidate.version) },
              ":updatedAt": { S: candidate.updatedAt },
            },
          })
        );
        deleted.push(candidate.operationId);
      } catch (error) {
        if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
        skipped.push(candidate.operationId);
      }
    }
  }
  return {
    scanned,
    expired: candidates.length,
    selected: selectedCandidates.map((candidate) => candidate.operationId),
    deleted,
    skipped,
  };
}

function printUsage(): void {
  console.log(
    "Usage: tsx scripts/operations/cleanup-operation-state.ts [--dry-run] [--include-legacy-ssm|--legacy-ssm-only] [--retention-days=<days>] [--max-deletions=<count>]"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  const retentionMs = options.retentionDays ? options.retentionDays * oneDayMs : getDurableOperationStateRetentionMs();
  const now = new Date();
  const maxDeletions = options.maxDeletions ?? Number.MAX_SAFE_INTEGER;
  let remaining = maxDeletions;

  if (!options.legacySsmOnly) {
    const tableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
    if (!tableName) throw new Error("MC_OPERATION_STATE_TABLE_NAME is required unless --legacy-ssm-only is used");
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    });
    const result = await cleanupDynamoDbOperations({
      client,
      tableName,
      cutoffMs: now.getTime() - retentionMs,
      maxDeletions: remaining,
      dryRun: options.dryRun,
    });
    remaining -= result.selected.length;
    console.log(
      `[OPERATIONS] DynamoDB scanned=${result.scanned} expired=${result.expired} selected=${result.selected.length} deleted=${result.deleted.length} skipped=${result.skipped.length}`
    );
    for (const operationId of result.selected) console.log(`  - dynamodb:${operationId}`);
  }

  if (options.includeLegacySsm) {
    const legacy = await cleanupExpiredDurableOperationStates({
      dryRun: options.dryRun,
      retentionMs,
      maxDeletions: remaining,
      now,
    });
    console.log(
      `[OPERATIONS] Legacy SSM scanned=${legacy.scannedCount} expired=${legacy.expiredCount} selected=${legacy.selectedParameterNames.length} deleted=${legacy.deletedCount}`
    );
    for (const name of legacy.selectedParameterNames) console.log(`  - legacy-ssm:${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(`[OPERATIONS] Cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    printUsage();
    process.exitCode = 1;
  });
}
