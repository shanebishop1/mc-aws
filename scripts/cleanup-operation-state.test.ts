import { DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { cleanupDynamoDbOperations, parseCliOptions } from "./cleanup-operation-state";

const item = (operationId: string, updatedAt: string, version = 1) => ({
  operationId: { S: operationId },
  updatedAt: { S: updatedAt },
  version: { N: String(version) },
});

describe("operation cleanup", () => {
  it("strictly parses cleanup modes and integer flags", () => {
    expect(parseCliOptions(["--dry-run", "--include-legacy-ssm", "--retention-days=7"])).toMatchObject({
      dryRun: true,
      includeLegacySsm: true,
      retentionDays: 7,
    });
    expect(() => parseCliOptions(["--retention-days=7days"])).toThrow("positive integer");
    expect(() => parseCliOptions(["--max-deletions=0"])).toThrow("positive integer");
  });

  it("paginates, selects oldest records, and performs no deletes in dry run", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [item("old-b", "2025-01-02T00:00:00Z")],
        LastEvaluatedKey: { operationId: { S: "old-b" } },
      })
      .mockResolvedValueOnce({ Items: [item("old-a", "2025-01-01T00:00:00Z"), item("new", "2026-01-01T00:00:00Z")] });
    const result = await cleanupDynamoDbOperations({
      client: { send } as never,
      tableName: "operations",
      cutoffMs: Date.parse("2025-12-01T00:00:00Z"),
      maxDeletions: 1,
      dryRun: true,
    });
    expect(result.selected).toEqual(["old-a"]);
    expect(send.mock.calls.every(([command]) => command instanceof ScanCommand)).toBe(true);
  });

  it("conditionally deletes and preserves concurrently changed records", async () => {
    const conditional = Object.assign(new Error("changed"), { name: "ConditionalCheckFailedException" });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [item("old-a", "2025-01-01T00:00:00Z"), item("old-b", "2025-01-02T00:00:00Z")] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditional);
    const result = await cleanupDynamoDbOperations({
      client: { send } as never,
      tableName: "operations",
      cutoffMs: Date.parse("2025-12-01T00:00:00Z"),
      maxDeletions: 2,
      dryRun: false,
    });
    expect(result.deleted).toEqual(["old-a"]);
    expect(result.skipped).toEqual(["old-b"]);
    expect(send.mock.calls.slice(1).every(([command]) => command instanceof DeleteItemCommand)).toBe(true);
  });
});
