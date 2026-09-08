import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./dynamodb-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dynamodb-client")>()),
  getDynamoDbClient: () => ({ send: mocks.send }),
}));

import { writeVersionedOperationRecord } from "./dynamodb-operation-store";

describe("DynamoDB operation retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operations-table");
    mocks.send.mockResolvedValue({});
  });

  it("removes TTL from nonterminal operation records", async () => {
    await writeVersionedOperationRecord({
      operationId: "replacement-op",
      expectedVersion: 0,
      payload: "{}",
      status: "running",
      phase: "preparing",
      updatedAt: "2026-09-06T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
    });

    const command = mocks.send.mock.calls[0][0];
    expect(command.input.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(command.input.ExpressionAttributeValues[":ttl"]).toBeUndefined();
  });

  it("adds retention TTL only after a terminal status", async () => {
    await writeVersionedOperationRecord({
      operationId: "replacement-op",
      expectedVersion: 8,
      payload: "{}",
      status: "completed",
      phase: "committed",
      updatedAt: "2026-09-06T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
    });

    const command = mocks.send.mock.calls[0][0];
    expect(command.input.UpdateExpression).toContain("ttlEpochSeconds = :ttl");
    expect(command.input.ExpressionAttributeValues[":ttl"]).toEqual({ N: "1800000000" });
  });

  it("does not TTL-delete terminal state that still carries lifecycle ownership", async () => {
    await writeVersionedOperationRecord({
      operationId: "replacement-op",
      expectedVersion: 8,
      payload: JSON.stringify({ lockId: "lock-1", fencingToken: 9 }),
      status: "failed",
      phase: "recovery-required",
      updatedAt: "2026-09-06T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
    });

    const command = mocks.send.mock.calls[0][0];
    expect(command.input.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(command.input.ExpressionAttributeValues[":ttl"]).toBeUndefined();
  });
});
