import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getParameter: vi.fn(),
  putParameter: vi.fn(),
  deleteParameter: vi.fn(),
  randomUUID: vi.fn(),
  acquireLifecycleLock: vi.fn(),
  releaseLifecycleLock: vi.fn(),
  renewLifecycleLock: vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("@/lib/aws", () => ({
  getParameter: mocks.getParameter,
  putParameter: mocks.putParameter,
  deleteParameter: mocks.deleteParameter,
}));
vi.mock("@/lib/aws/dynamodb-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/aws/dynamodb-client")>("@/lib/aws/dynamodb-client");
  return { ...actual, getDynamoDbClient: () => ({ send: mocks.send }) };
});
vi.mock("@/lib/aws/mock-state-store", () => ({
  getMockStateStore: () => ({
    acquireLifecycleLock: mocks.acquireLifecycleLock,
    releaseLifecycleLock: mocks.releaseLifecycleLock,
    renewLifecycleLock: mocks.renewLifecycleLock,
  }),
}));

import type { UpdateItemCommand } from "@/lib/aws/dynamodb-client";
import {
  ServerActionLockConflictError,
  acquireServerActionLock,
  assertServerActionLockOwned,
  releaseServerActionLock,
  releaseServerActionLockIfOwned,
  renewServerActionLock,
} from "./server-action-lock";

function item(lockId: string, token: number, action = "backup") {
  return {
    lockKey: { S: "minecraft-server-lifecycle" },
    lockId: { S: lockId },
    fencingToken: { N: String(token) },
    action: { S: action },
    ownerEmail: { S: "admin@example.com" },
    createdAt: { S: "2026-04-13T12:00:00.000Z" },
    leaseExpiresAt: { N: String(Date.parse("2026-04-13T12:45:00.000Z")) },
    released: { BOOL: false },
  };
}

const metadata = { Item: { protocolVersion: { S: "dual-v1" } } };
const legacy = JSON.stringify({
  lockId: "lock-a",
  action: "backup",
  ownerEmail: "admin@example.com",
  createdAt: "2026-04-13T12:00:00.000Z",
  expiresAt: "2026-04-13T12:45:00.000Z",
});

describe("DynamoDB server action lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "locks-table");
    mocks.randomUUID.mockReturnValue("lock-a");
    mocks.getParameter.mockResolvedValue(legacy);
    mocks.putParameter.mockResolvedValue(undefined);
    mocks.deleteParameter.mockResolvedValue(undefined);
    mocks.releaseLifecycleLock.mockResolvedValue(true);
  });

  it("acquires with one conditional update and returns the fencing token", async () => {
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-a", 7) });

    await expect(acquireServerActionLock("backup", "ADMIN@example.com")).resolves.toMatchObject({
      lockId: "lock-a",
      fencingToken: 7,
      expiresAt: "2026-04-13T12:45:00.000Z",
    });
    const command = mocks.send.mock.calls[1][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toContain("leaseExpiresAt < :now");
    expect(command.input.UpdateExpression).toContain("fencingToken = if_not_exists(fencingToken, :zero) + :one");
    expect(command.input.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(mocks.putParameter).toHaveBeenCalledWith(
      "/minecraft/server-action",
      expect.stringContaining('"lockId":"lock-a"'),
      "String",
      false
    );
    const bridgePayload = JSON.parse(
      mocks.putParameter.mock.calls.find(([name]) => name === "/minecraft/server-action")?.[1] as string
    );
    expect(bridgePayload.expiresAt).toBe("2026-04-13T13:30:00.000Z");
  });

  it("allows exactly one winner when two acquisitions race", async () => {
    let updateCount = 0;
    mocks.send.mockImplementation(async (command) => {
      if (command.input.Key.lockKey.S === "protocol#dual-v1") return metadata;
      if (command.input.ConsistentRead) return { Item: item("lock-a", 1) };
      updateCount += 1;
      if (updateCount === 1) return { Attributes: item("lock-a", 1) };
      throw Object.assign(new Error("held"), {
        name: "ConditionalCheckFailedException",
        Item: item("lock-a", 1),
      });
    });
    mocks.putParameter
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }));

    const first = acquireServerActionLock("backup", "admin@example.com");
    const second = acquireServerActionLock("restore", "other@example.com");

    await expect(first).resolves.toMatchObject({ lockId: "lock-a", fencingToken: 1 });
    await expect(second).rejects.toBeInstanceOf(ServerActionLockConflictError);
  });

  it("releases the exact legacy bridge lock when DynamoDB acquisition loses", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(
        Object.assign(new Error("held"), { name: "ConditionalCheckFailedException", Item: item("other-lock", 8) })
      );

    await expect(acquireServerActionLock("backup", "admin@example.com")).rejects.toBeInstanceOf(
      ServerActionLockConflictError
    );
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("uses the legacy delete-claim protocol to recover an expired SSM bridge lock", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 8,
    });
    expect(mocks.putParameter).toHaveBeenCalledWith(
      "/minecraft/server-action-delete-claim/lock-a",
      expect.stringContaining('"claimId":"claim-new"'),
      "String",
      false
    );
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action-delete-claim/lock-a");
  });

  it("takes over an expired delete-claim lease instead of blocking for the lock lease", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    const staleClaim = JSON.stringify({
      claimId: "dead-claim",
      createdAt: "2026-04-13T12:00:00.000Z",
      expiresAt: "2026-04-13T12:01:00.000Z",
    });
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    mocks.getParameter.mockResolvedValueOnce(legacy).mockResolvedValueOnce(staleClaim).mockResolvedValueOnce(legacy);
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockRejectedValueOnce(Object.assign(new Error("stale claim"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 9) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 9,
    });
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action-delete-claim/lock-a");
    expect(mocks.putParameter).toHaveBeenCalledWith(
      "/minecraft/server-action-delete-claim/lock-a",
      expect.stringContaining('"expiresAt"'),
      "String",
      false
    );
  });

  it("reconciles an ambiguous DynamoDB acquisition that committed", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Item: item("lock-a", 12) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-a",
      fencingToken: 12,
    });
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("repairs ambiguous acquisition with an idempotent conditional write when reads fail", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("write timeout"), { name: "TimeoutError" }))
      .mockRejectedValueOnce(Object.assign(new Error("read timeout"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Attributes: item("lock-a", 14) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-a",
      fencingToken: 14,
    });
    expect((mocks.send.mock.calls[3][0] as UpdateItemCommand).input.ConditionExpression).toContain("lockId = :lockId");
    expect((mocks.send.mock.calls[3][0] as UpdateItemCommand).input.UpdateExpression).not.toContain("fencingToken");
  });

  it("fails closed after the bounded ambiguity repair budget is exhausted", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("write timeout"), { name: "TimeoutError" }))
      .mockRejectedValueOnce(Object.assign(new Error("read timeout"), { name: "TimeoutError" }))
      .mockRejectedValue(Object.assign(new Error("repair timeout"), { name: "TimeoutError" }));

    await expect(acquireServerActionLock("backup", "admin@example.com")).rejects.toThrow("repair timeout");
    expect(mocks.send).toHaveBeenCalledTimes(6);
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("finishes bridge cleanup after an ambiguous release committed", async () => {
    const released = { ...item("lock-a", 7), released: { BOOL: true } };
    mocks.send
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Item: released });

    await expect(releaseServerActionLock("lock-a", { fencingToken: 7, action: "backup" })).resolves.toBe(true);
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("self-heals an active SSM bridge whose matching DynamoDB owner is already released", async () => {
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: { ...item("lock-a", 7), released: { BOOL: true } } })
      .mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 8,
    });
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("fails closed without dual-protocol table metadata", async () => {
    mocks.send.mockResolvedValueOnce({});
    await expect(acquireServerActionLock("backup", "admin@example.com")).rejects.toThrow(
      "dual-protocol metadata is missing"
    );
    expect(mocks.putParameter).not.toHaveBeenCalled();
  });

  it("asserts ownership using a strongly consistent read", async () => {
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Item: item("lock-a", 4) });
    await expect(assertServerActionLockOwned("lock-a", 4, "backup")).resolves.toMatchObject({ fencingToken: 4 });
    expect(mocks.send.mock.calls[1][0].input.ConsistentRead).toBe(true);
  });

  it("prevents an old fencing token from releasing a newer owner", async () => {
    mocks.send.mockRejectedValueOnce(Object.assign(new Error("changed"), { name: "ConditionalCheckFailedException" }));
    await expect(
      releaseServerActionLock("lock-old", {
        action: "backup",
        ownerEmail: "admin@example.com",
        fencingToken: 3,
      })
    ).resolves.toBe(false);
  });

  it("releases an operation lock using its complete fenced identity without resolving a newer fence", async () => {
    mocks.send.mockResolvedValueOnce({});

    await expect(
      releaseServerActionLockIfOwned({
        lockId: "lock-a",
        action: "backup",
        ownerEmail: "ADMIN@example.com",
        fencingToken: 7,
      })
    ).resolves.toBe(true);

    const command = mocks.send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toBe(
      "lockId = :lockId AND fencingToken = :token AND released = :false AND #action = :action AND ownerEmail = :ownerEmail"
    );
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":lockId": { S: "lock-a" },
      ":token": { N: "7" },
      ":action": { S: "backup" },
      ":ownerEmail": { S: "admin@example.com" },
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("does not renew an already expired lease", async () => {
    mocks.getParameter.mockResolvedValue(JSON.stringify({ ...JSON.parse(legacy), lockId: "lock-old" }));
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("expired"), { name: "ConditionalCheckFailedException" }))
      .mockResolvedValueOnce({ Item: item("lock-new", 8) });

    await expect(renewServerActionLock("lock-old", 7)).rejects.toBeInstanceOf(ServerActionLockConflictError);
    const command = mocks.send.mock.calls[1][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toContain("leaseExpiresAt >= :now");
  });

  it("stores mock locks in the shared provider state and releases only the matching fence", async () => {
    vi.stubEnv("MC_BACKEND_MODE", "mock");
    const storedLock = {
      lockId: "lock-a",
      fencingToken: 5,
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T12:00:00.000Z",
      expiresAt: "2026-04-13T13:30:00.000Z",
    };
    mocks.acquireLifecycleLock.mockResolvedValueOnce({ acquired: true, lock: storedLock });

    const lock = await acquireServerActionLock("backup", "ADMIN@example.com");

    expect(lock).toMatchObject({ lockId: "lock-a", fencingToken: 5, ownerEmail: "admin@example.com" });
    expect(mocks.acquireLifecycleLock).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: "lock-a", ownerEmail: "admin@example.com" }),
      Date.parse("2026-04-13T12:00:00.000Z")
    );

    await expect(
      releaseServerActionLock(lock.lockId, {
        action: "backup",
        ownerEmail: "admin@example.com",
        fencingToken: lock.fencingToken,
      })
    ).resolves.toBe(true);
    expect(mocks.releaseLifecycleLock).toHaveBeenCalledWith({
      lockId: "lock-a",
      fencingToken: 5,
      action: "backup",
      ownerEmail: "admin@example.com",
    });
  });
});
