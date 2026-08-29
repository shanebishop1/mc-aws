import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-dynamodb")>("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class DynamoDBClient {
      send = mocks.send;
    },
  };
});

import { handler, metadataKey } from "./index.js";

const event = (requestType: string, tableName = "locks-a") => ({
  RequestType: requestType,
  StackId: "stack-1",
  LogicalResourceId: "MigrateServerActionLock",
  ResourceProperties: { LockTableName: tableName, MarkerVersion: "2" },
  PhysicalResourceId: `${tableName}:dual-v1:2`,
});

describe("replacement-safe lifecycle bridge metadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("initializes and strongly verifies metadata in the exact lock table", async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: {
        protocolVersion: { S: "dual-v1" },
        markerVersion: { S: "2" },
        ownerToken: { S: "stack-1:MigrateServerActionLock" },
      },
    });

    await expect(handler(event("Create"))).resolves.toEqual({ PhysicalResourceId: "locks-a:dual-v1:2" });
    expect(mocks.send.mock.calls[0][0]).toBeInstanceOf(UpdateItemCommand);
    expect(mocks.send.mock.calls[0][0].input.Key).toEqual({ lockKey: { S: metadataKey } });
    expect(mocks.send.mock.calls[1][0]).toBeInstanceOf(GetItemCommand);
    expect(mocks.send.mock.calls[1][0].input.ConsistentRead).toBe(true);
  });

  it("does not delete metadata when an old replacement resource is deleted late", async () => {
    await expect(
      handler({
        ...event("Delete", "locks-a"),
        OldResourceProperties: { LockTableName: "locks-a", MarkerVersion: "2" },
        ResourceProperties: { LockTableName: "locks-b", MarkerVersion: "3" },
      })
    ).resolves.toEqual({ PhysicalResourceId: "locks-a:dual-v1:2" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails closed when verification observes another owner or generation", async () => {
    mocks.send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Item: {
        protocolVersion: { S: "dual-v1" },
        markerVersion: { S: "1" },
        ownerToken: { S: "other-stack:resource" },
      },
    });
    await expect(handler(event("Update"))).rejects.toThrow("verification failed");
  });
});
