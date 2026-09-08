import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getParameter: vi.fn(),
  putParameter: vi.fn(),
  deleteParameter: vi.fn(),
  getParameterRecord: vi.fn(),
  putParameterIfCurrent: vi.fn(),
  deleteParameterIfCurrent: vi.fn(),
  randomUUID: vi.fn(),
  acquireLifecycleLock: vi.fn(),
  releaseLifecycleLock: vi.fn(),
  renewLifecycleLock: vi.fn(),
  transact: vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("@/lib/aws", () => ({
  getParameter: mocks.getParameter,
  putParameter: mocks.putParameter,
  deleteParameter: mocks.deleteParameter,
  getParameterRecord: mocks.getParameterRecord,
  putParameterIfCurrent: mocks.putParameterIfCurrent,
  deleteParameterIfCurrent: mocks.deleteParameterIfCurrent,
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
    transact: mocks.transact,
  }),
}));

import type { UpdateItemCommand } from "@/lib/aws/dynamodb-client";
import {
  ServerActionLockConflictError,
  acquireServerActionLock,
  acquireServerActionLockWithOperation,
  assertServerActionLockOwned,
  finalizeServerActionLockWithOperation,
  releaseServerActionLock,
  releaseServerActionLockIfOwned,
  renewServerActionLock,
  renewServerActionLockWithOperation,
  takeOverProtectedServerActionLockWithOperation,
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
    leaseGeneration: { N: "1" },
    agentFenceActive: { BOOL: false },
    released: { BOOL: false },
  };
}

const metadata = {
  Item: {
    protocolVersion: { S: "dual-v1" },
    cutoverState: { S: "provider-authoritative" },
    legacyBridgeState: { S: "absent" },
  },
};
const legacy = JSON.stringify({
  lockId: "lock-a",
  action: "backup",
  ownerEmail: "admin@example.com",
  createdAt: "2026-04-13T12:00:00.000Z",
  expiresAt: "2026-04-13T12:45:00.000Z",
  claimToken: "lock-a",
});

function operationItem(lockId: string, token: number, dispatchOwnerId: string) {
  return {
    payload: {
      S: JSON.stringify({
        id: "backup-agent-atomic",
        lockId,
        fencingToken: token,
        dispatchOwnerId,
      }),
    },
    version: { N: "2" },
  };
}

function fencedOperationPayload(generation: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: "backup-agent-atomic",
    type: "backup",
    route: "/api/agent/runtime/backups",
    status: "completed",
    phase: "terminal",
    requestedAt: "2026-04-13T11:00:00.000Z",
    updatedAt: "2026-04-13T12:00:00.000Z",
    requestedBy: "admin@example.com",
    lockId: "lock-a",
    fencingToken: 7,
    lockLeaseGeneration: generation,
    lockLeaseExpiresAt: "2026-04-13T13:30:00.000Z",
    dispatchOwnerId: "owner-agent",
    agentEffectReconciliationStatus: "active",
    agentEffectSafetyExpiresAt: "2026-04-13T12:04:00.000Z",
    agentFenceAuthorization: {
      backupId: "backup-agent-atomic",
      lifecycleLockId: "lock-a",
      lifecycleFencingToken: 7,
      lifecycleLeaseGeneration: generation,
      expiresAt: "2026-04-13T12:01:00.000Z",
    },
    history: [],
    version: generation,
    ...overrides,
  });
}

describe("DynamoDB server action lock", () => {
  let parameters: Map<string, string>;

  beforeEach(() => {
    parameters = new Map<string, string>();
    vi.clearAllMocks();
    mocks.send.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "locks-table");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operations-table");
    mocks.randomUUID.mockReturnValue("lock-a");
    mocks.getParameter.mockImplementation(async (name: string) => parameters.get(name) ?? null);
    mocks.putParameter.mockImplementation(async (name: string, value: string, _type: string, overwrite = true) => {
      if (!overwrite && parameters.has(name)) {
        throw Object.assign(new Error("held"), { name: "ParameterAlreadyExists" });
      }
      parameters.set(name, value);
      return 1;
    });
    mocks.deleteParameter.mockImplementation(async (name: string) => {
      parameters.delete(name);
    });
    mocks.getParameterRecord.mockImplementation(async (name: string) => {
      const value = await mocks.getParameter(name);
      return value === null ? null : { name, value, type: "String", version: 1 };
    });
    mocks.putParameterIfCurrent.mockImplementation(
      async (
        name: string,
        value: string,
        proof: { claimToken: string; parameterVersion: number; claimParameterName?: string; claimVersion?: number },
        _type: string,
        overwrite = true
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The serialized test mock validates the complete mutation proof.
      ) => {
        const current = await mocks.getParameter(name);
        if (
          (!overwrite && current) ||
          (!current && proof.parameterVersion !== 0) ||
          (current && proof.parameterVersion !== 1)
        ) {
          return false;
        }
        if (proof.claimParameterName) {
          const claim = parameters.get(proof.claimParameterName);
          if (!claim || proof.claimVersion !== 1) return false;
          const parsedClaim = JSON.parse(claim) as { claimToken?: string; resourceVersion?: number };
          if (parsedClaim.claimToken !== proof.claimToken || parsedClaim.resourceVersion !== proof.parameterVersion)
            return false;
        }
        parameters.set(name, value);
        return true;
      }
    );
    mocks.deleteParameterIfCurrent.mockImplementation(
      async (
        name: string,
        proof: { claimToken: string; parameterVersion: number; claimParameterName?: string; claimVersion?: number }
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The serialized test mock validates the complete mutation proof.
      ) => {
        const current = await mocks.getParameter(name);
        if (!current) return false;
        if (proof.claimParameterName) {
          const claim = parameters.get(proof.claimParameterName);
          if (!claim || proof.claimVersion !== 1) return false;
          const parsedClaim = JSON.parse(claim) as { claimToken?: string; resourceVersion?: number };
          if (parsedClaim.claimToken !== proof.claimToken || parsedClaim.resourceVersion !== proof.parameterVersion)
            return false;
        } else if (name.startsWith("/minecraft/server-action-delete-claim/")) {
          const parsedClaim = JSON.parse(current) as { claimToken?: string; resourceVersion?: number };
          if (parsedClaim.claimToken !== proof.claimToken) return false;
        }
        if (name !== "/minecraft/server-action" && proof.parameterVersion !== 1) return false;
        parameters.delete(name);
        return true;
      }
    );
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
    expect(command.input.ConditionExpression).toContain("agentFenceActive");
    expect(command.input.UpdateExpression).toContain("fencingToken = if_not_exists(fencingToken, :zero) + :one");
    expect(command.input.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action")).toBeUndefined();
  });

  it("atomically binds the global lock and existing durable operation before ownership is returned", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: { ...item("old-lock", 7), released: { BOOL: true } } })
      .mockResolvedValueOnce({});

    const result = await acquireServerActionLockWithOperation("backup", "ADMIN@example.com", {
      operationId: "backup-agent-atomic",
      ownerId: "12345678-1234-4234-8234-123456789012",
      expectedVersion: 1,
      payload: (lock) =>
        JSON.stringify({
          id: "backup-agent-atomic",
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          dispatchOwnerId: lock.operationOwnerId,
        }),
      status: "accepted",
      phase: "dispatching",
      updatedAt: "2026-04-13T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
    });

    expect(result).toMatchObject({
      ownership: "acquired",
      lock: {
        lockId: "lock-a",
        fencingToken: 8,
        operationId: "backup-agent-atomic",
        operationOwnerId: "12345678-1234-4234-8234-123456789012",
      },
    });
    const transaction = mocks.send.mock.calls[2][0];
    expect(transaction.input.ClientRequestToken).toBe("12345678-1234-4234-8234-123456789012");
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems[0].Update.TableName).toBe("locks-table");
    expect(transaction.input.TransactItems[1].Update).toMatchObject({
      TableName: "operations-table",
      ConditionExpression: "#version = :expectedVersion",
    });
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":payload"].S).toContain(
      '"dispatchOwnerId":"12345678-1234-4234-8234-123456789012"'
    );
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("resumes the exact protected bridge owner after a crash before the binding transaction", async () => {
    const ownerId = "12345678-1234-4234-8234-123456789012";
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({
        ...JSON.parse(legacy),
        agentFenceActive: true,
        operationId: "replacement-op",
        operationOwnerId: ownerId,
      })
    );
    mocks.putParameter.mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }));
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: { ...item("prior-lock", 7), released: { BOOL: true } } })
      .mockResolvedValueOnce({});

    await expect(
      acquireServerActionLockWithOperation("backup", "admin@example.com", {
        operationId: "replacement-op",
        ownerId,
        expectedVersion: 1,
        payload: (lock) =>
          JSON.stringify({
            operationId: "replacement-op",
            operationOwnerId: ownerId,
            lockId: lock.lockId,
            fencingToken: lock.fencingToken,
            lockLeaseGeneration: lock.leaseGeneration,
          }),
        status: "running",
        phase: "created",
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        retainForAgentEffect: true,
      })
    ).resolves.toMatchObject({ ownership: "acquired", lock: { lockId: "lock-a", fencingToken: 8 } });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("reconciles atomic acquisition response loss by operation owner without releasing the bridge", async () => {
    const ownerId = "12345678-1234-4234-8234-123456789012";
    const ownedItem = {
      ...item("lock-a", 8),
      operationId: { S: "backup-agent-atomic" },
      operationOwnerId: { S: ownerId },
    };
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: { ...item("old-lock", 7), released: { BOOL: true } } })
      .mockRejectedValueOnce(Object.assign(new Error("response lost"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Item: ownedItem })
      .mockResolvedValueOnce({ Item: operationItem("lock-a", 8, ownerId) });

    await expect(
      acquireServerActionLockWithOperation("backup", "admin@example.com", {
        operationId: "backup-agent-atomic",
        ownerId,
        expectedVersion: 1,
        payload: () => JSON.stringify({}),
        status: "accepted",
        phase: "dispatching",
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
      })
    ).resolves.toMatchObject({ ownership: "acquired", lock: { lockId: "lock-a", fencingToken: 8 } });
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("allows exactly one winner when two acquisitions race", async () => {
    mocks.randomUUID
      .mockReset()
      .mockReturnValueOnce("lock-a")
      .mockReturnValueOnce("claim-a")
      .mockReturnValueOnce("lock-b")
      .mockReturnValueOnce("claim-b");
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
      )
      .mockResolvedValueOnce({ Item: item("other-lock", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).rejects.toBeInstanceOf(
      ServerActionLockConflictError
    );
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("parses an operator destroy barrier as an active lifecycle conflict", async () => {
    const destroyItem = {
      ...item("destroy-lock", 9, "destroy"),
      agentFenceActive: { BOOL: true },
      operationId: { S: "destroy-12345678-1234-4234-8234-123456789012" },
      operationOwnerId: { S: "destroy-12345678-1234-4234-8234-123456789012" },
    };
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(
        Object.assign(new Error("held"), { name: "ConditionalCheckFailedException", Item: destroyItem })
      );

    const error = await acquireServerActionLock("backup", "admin@example.com").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServerActionLockConflictError);
    expect((error as ServerActionLockConflictError).existingLock).toMatchObject({
      action: "destroy",
      lockId: "destroy-lock",
      fencingToken: 9,
      agentFenceActive: true,
    });
  });

  it("does not steal an expired protected replacement owner through generic acquisition", async () => {
    const replacement = {
      Item: {
        ...item("replacement-lock", 7),
        leaseExpiresAt: { N: String(Date.parse("2026-04-13T11:00:00.000Z")) },
        leaseGeneration: { N: "7" },
        agentFenceActive: { BOOL: true },
        operationId: { S: "replacement-op" },
        operationOwnerId: { S: "replacement-owner" },
      },
    };
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(
        Object.assign(new Error("held"), { name: "ConditionalCheckFailedException", ...replacement })
      )
      .mockResolvedValueOnce(replacement);

    await expect(acquireServerActionLock("start", "admin@example.com")).rejects.toBeInstanceOf(
      ServerActionLockConflictError
    );
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("does not let application code acquire the operator destroy barrier", async () => {
    await expect(acquireServerActionLock("destroy", "admin@example.com")).rejects.toThrow(
      "Unsupported lifecycle action: destroy"
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.putParameter).not.toHaveBeenCalled();
  });

  it("does not adopt or mutate an expired legacy SSM bridge lock", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    parameters.set("/minecraft/server-action", legacy);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 8,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action")).toBe(legacy);
  });

  it("preserves a malformed legacy bridge without proof while DynamoDB acquires authority", async () => {
    const malformed = '{"lockId":"legacy","action":"backup"}';
    parameters.set("/minecraft/server-action", malformed);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 8,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameter).not.toHaveBeenCalled();
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action")).toBe(malformed);
  });

  it("preserves an expired legacy delete-claim lease instead of taking it over", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    const staleClaim = JSON.stringify({
      claimToken: "dead-claim",
      createdAt: "2026-04-13T12:00:00.000Z",
      resourceVersion: 1,
      expiresAt: "2026-04-13T12:01:00.000Z",
    });
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    parameters.set("/minecraft/server-action", legacy);
    parameters.set("/minecraft/server-action-delete-claim/lock-a", staleClaim);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 9) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 9,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action-delete-claim/lock-a")).toBe(staleClaim);
  });

  it("does not let a stale claimant delete a successor claim during final cleanup", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    parameters.set("/minecraft/server-action", legacy);
    const successorClaim = JSON.stringify({
      claimToken: "successor",
      ownerId: "lock-a",
      resourceVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    parameters.set("/minecraft/server-action-delete-claim/lock-a", successorClaim);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({ lockId: "lock-new" });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action-delete-claim/lock-a")).toBe(successorClaim);
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

  it("does not attempt bridge cleanup after an ambiguous release commits", async () => {
    const released = { ...item("lock-a", 7), released: { BOOL: true } };
    parameters.set("/minecraft/server-action", legacy);
    mocks.send
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Item: released });

    await expect(releaseServerActionLock("lock-a", { fencingToken: 7, action: "backup" })).resolves.toBe(true);
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("does not self-heal or rewrite an active SSM bridge", async () => {
    mocks.randomUUID.mockReturnValueOnce("lock-new").mockReturnValueOnce("claim-new");
    parameters.set("/minecraft/server-action", legacy);
    mocks.send.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("lock-new", 8) });

    await expect(acquireServerActionLock("backup", "admin@example.com")).resolves.toMatchObject({
      lockId: "lock-new",
      fencingToken: 8,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameters.get("/minecraft/server-action")).toBe(legacy);
  });

  it("fails closed without dual-protocol table metadata", async () => {
    mocks.send.mockResolvedValueOnce({});
    await expect(acquireServerActionLock("backup", "admin@example.com")).rejects.toThrow(
      "provider-authoritative cutover barrier is missing"
    );
    expect(mocks.putParameter).not.toHaveBeenCalled();
  });

  it("asserts ownership using a strongly consistent read", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: item("lock-a", 4) })
      .mockResolvedValueOnce({ Item: item("lock-a", 4) })
      .mockResolvedValueOnce({ Item: item("lock-a", 4) });
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
    const expired = {
      ...item("lock-old", 7),
      leaseExpiresAt: { N: String(Date.parse("2026-04-13T11:00:00.000Z")) },
    };
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: expired })
      .mockResolvedValueOnce({ Item: expired });

    await expect(renewServerActionLock("lock-old", 7)).rejects.toBeInstanceOf(ServerActionLockConflictError);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("renews an exact lease generation and activates the non-expiring executor fence", async () => {
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: item("lock-a", 7) })
      .mockResolvedValueOnce({
        Attributes: {
          ...item("lock-a", 7),
          leaseGeneration: { N: "2" },
          agentFenceActive: { BOOL: true },
        },
      });

    await expect(
      renewServerActionLock("lock-a", 7, { expectedLeaseGeneration: 1, retainForAgentEffect: true })
    ).resolves.toMatchObject({ leaseGeneration: 2, agentFenceActive: true });
    const command = mocks.send.mock.calls[2][0] as UpdateItemCommand;
    expect(command.input.ConditionExpression).toContain("leaseGeneration = :generation");
    expect(command.input.ConditionExpression).toContain("agentFenceActive = :true");
    expect(command.input.UpdateExpression).toContain("leaseGeneration = :nextGeneration");
    expect(command.input.UpdateExpression).toContain("agentFenceActive = :true");
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("renews the lock generation and durable authorization in one DynamoDB transaction", async () => {
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "2" },
      agentFenceActive: { BOOL: true },
      operationId: { S: "backup-agent-atomic" },
      operationOwnerId: { S: "owner-agent" },
    };
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2, agentFenceActive: true })
    );
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) return {};
      if (command.input?.TableName === "locks-table") {
        return {
          Item: {
            ...active,
            leaseGeneration: { N: command.input?.ConsistentRead ? "2" : "3" },
          },
        };
      }
      return { Item: { payload: { S: fencedOperationPayload(3) }, version: { N: "3" } } };
    });

    const result = await renewServerActionLockWithOperation("lock-a", 7, {
      operationId: "backup-agent-atomic",
      operationOwnerId: "owner-agent",
      expectedOperationVersion: 2,
      expectedLeaseGeneration: 2,
      updatedAt: "2026-04-13T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
      payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
      reconcile: () => false,
    });

    expect(result).toMatchObject({ ownership: "renewed", lock: { leaseGeneration: 3, agentFenceActive: true } });
    const transaction = mocks.send.mock.calls.find(([command]) => command.input?.TransactItems)?.[0];
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems[0].Update).toMatchObject({ TableName: "locks-table" });
    expect(transaction.input.TransactItems[1].Update).toMatchObject({
      TableName: "operations-table",
      ConditionExpression: "#version = :expectedVersion",
    });
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":payload"].S).toContain(
      '"lockLeaseGeneration":3'
    );
  });

  it("keeps a replacement operation protected from generic expiry takeover while renewing", async () => {
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "2" },
      agentFenceActive: { BOOL: true },
      operationId: { S: "replacement-op" },
      operationOwnerId: { S: "replacement-owner" },
    };
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2, agentFenceActive: true })
    );
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) return {};
      if (command.input?.TableName === "locks-table") {
        return { Item: { ...active, leaseGeneration: { N: command.input?.ConsistentRead ? "2" : "3" } } };
      }
      return {
        Item: {
          payload: { S: fencedOperationPayload(3, { status: "running", phase: "executing" }) },
          version: { N: "3" },
        },
      };
    });

    await renewServerActionLockWithOperation("lock-a", 7, {
      operationId: "replacement-op",
      operationOwnerId: "replacement-owner",
      expectedOperationVersion: 2,
      expectedLeaseGeneration: 2,
      updatedAt: "2026-04-13T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
      status: "running",
      phase: "executing",
      retainForAgentEffect: true,
      payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
      reconcile: () => false,
    });

    const transaction = mocks.send.mock.calls.find(([command]) => command.input?.TransactItems)?.[0];
    expect(transaction.input.TransactItems[0].Update.ExpressionAttributeValues[":agentFenceActive"]).toEqual({
      BOOL: true,
    });
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues).toMatchObject({
      ":status": { S: "running" },
      ":phase": { S: "executing" },
    });
    expect(transaction.input.TransactItems[1].Update.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(transaction.input.TransactItems[1].Update.ExpressionAttributeValues[":ttl"]).toBeUndefined();
  });

  it("rotates only the exact expired protected replacement owner", async () => {
    const expired = {
      ...item("lock-old", 7),
      leaseGeneration: { N: "4" },
      leaseExpiresAt: { N: String(Date.parse("2026-04-13T11:59:00.000Z")) },
      agentFenceActive: { BOOL: true },
      operationId: { S: "replacement-op" },
      operationOwnerId: { S: "owner-old" },
    };
    mocks.randomUUID.mockReturnValue("lock-new");
    const expiredBridge = JSON.stringify({
      lockId: "lock-old",
      action: "backup",
      ownerEmail: "host-upgrade@local.invalid",
      createdAt: "2026-04-13T11:00:00.000Z",
      expiresAt: "2026-04-13T11:59:00.000Z",
      leaseGeneration: 4,
      agentFenceActive: true,
    });
    mocks.getParameter.mockImplementation(async (name: string) =>
      name === "/minecraft/server-action" ? expiredBridge : (parameters.get(name) ?? null)
    );
    const replacementOwner = {
      ...item("lock-new", 8),
      leaseExpiresAt: { N: String(Date.parse("2026-04-13T13:30:00.000Z")) },
      agentFenceActive: { BOOL: true },
      operationId: { S: "replacement-op" },
      operationOwnerId: { S: "owner-new" },
    };
    mocks.send
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: expired })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: replacementOwner })
      .mockResolvedValueOnce({ Item: replacementOwner });

    const result = await takeOverProtectedServerActionLockWithOperation("host-upgrade@local.invalid", {
      operationId: "replacement-op",
      ownerId: "owner-new",
      expectedVersion: 9,
      previousLockId: "lock-old",
      previousFencingToken: 7,
      previousLeaseGeneration: 4,
      previousOperationOwnerId: "owner-old",
      status: "running",
      phase: "prepared",
      updatedAt: "2026-04-13T12:00:00.000Z",
      ttlEpochSeconds: 1_800_000_000,
      payload: (lock) => JSON.stringify({ operationId: "replacement-op", lockId: lock.lockId }),
    });

    expect(result).toMatchObject({
      ownership: "acquired",
      lock: { lockId: "lock-new", fencingToken: 8, leaseGeneration: 1, agentFenceActive: true },
    });
    const transaction = mocks.send.mock.calls[2][0];
    expect(transaction.input.TransactItems[0].Update.ConditionExpression).toContain("agentFenceActive = :true");
    expect(transaction.input.TransactItems[1].Update.ConditionExpression).toContain("#status = :expectedStatus");
    expect(transaction.input.TransactItems[1].Update.UpdateExpression).toContain("REMOVE ttlEpochSeconds");
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("reconciles replacement finalization response loss from the exact released lock and operation version", async () => {
    const payload = JSON.stringify({
      lockId: "lock-a",
      fencingToken: 7,
      operationOwnerId: "replacement-owner",
      phase: "committed",
    });
    mocks.getParameter.mockResolvedValue(JSON.stringify({ ...JSON.parse(legacy), lockId: "lock-a" }));
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.TransactItems) throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      if (command.input?.TableName === "locks-table") {
        return { Item: { ...item("lock-a", 7), leaseGeneration: { N: "3" }, released: { BOOL: true } } };
      }
      return { Item: { payload: { S: payload }, version: { N: "6" } } };
    });

    await expect(
      finalizeServerActionLockWithOperation({
        operationId: "replacement-op",
        operationOwnerId: "replacement-owner",
        expectedOperationVersion: 5,
        lockId: "lock-a",
        fencingToken: 7,
        expectedLeaseGeneration: 3,
        ownerEmail: "host-upgrade@local.invalid",
        action: "backup",
        payload,
        status: "completed",
        phase: "committed",
        expectedStatus: "completed",
        expectedPhase: "committed",
        expectedAgentFenceActive: false,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
      })
    ).resolves.toEqual({ operationPayload: payload, operationVersion: 6 });
  });

  it("reconciles renewal response loss only from an exact two-record identity", async () => {
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "3" },
      agentFenceActive: { BOOL: true },
      operationId: { S: "backup-agent-atomic" },
      operationOwnerId: { S: "owner-agent" },
    };
    let transactionAttempted = false;
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2, agentFenceActive: true })
    );
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) {
        transactionAttempted = true;
        throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      }
      if (command.input?.TableName === "locks-table") {
        return { Item: transactionAttempted ? active : { ...active, leaseGeneration: { N: "2" } } };
      }
      return { Item: { payload: { S: fencedOperationPayload(3) }, version: { N: "3" } } };
    });

    await expect(
      renewServerActionLockWithOperation("lock-a", 7, {
        operationId: "backup-agent-atomic",
        operationOwnerId: "owner-agent",
        expectedOperationVersion: 2,
        expectedLeaseGeneration: 2,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
        reconcile: (payload, lock, version) =>
          payload === fencedOperationPayload(3) && lock.leaseGeneration === 3 && version === 3,
      })
    ).resolves.toMatchObject({ ownership: "reconciled", lock: { leaseGeneration: 3 } });
  });

  it("reconciles response loss for an expiring replacement operation fence", async () => {
    const replacementPayload = JSON.stringify({
      operationId: "replacement-op",
      operationOwnerId: "replacement-owner",
      lockId: "lock-a",
      fencingToken: 7,
      lockLeaseGeneration: 3,
      version: 3,
    });
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "3" },
      agentFenceActive: { BOOL: false },
      operationId: { S: "replacement-op" },
      operationOwnerId: { S: "replacement-owner" },
    };
    let transactionAttempted = false;
    mocks.getParameter.mockResolvedValue(JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2 }));
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) {
        transactionAttempted = true;
        throw Object.assign(new Error("response lost"), { name: "TimeoutError" });
      }
      if (command.input?.TableName === "locks-table") {
        return { Item: transactionAttempted ? active : { ...active, leaseGeneration: { N: "2" } } };
      }
      return { Item: { payload: { S: replacementPayload }, version: { N: "3" } } };
    });

    await expect(
      renewServerActionLockWithOperation("lock-a", 7, {
        operationId: "replacement-op",
        operationOwnerId: "replacement-owner",
        expectedOperationVersion: 2,
        expectedLeaseGeneration: 2,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        status: "running",
        phase: "executing",
        retainForAgentEffect: false,
        payload: () => replacementPayload,
        reconcile: (payload, lock, version) =>
          payload === replacementPayload && lock.leaseGeneration === 3 && version === 3,
      })
    ).resolves.toMatchObject({ ownership: "reconciled", lock: { leaseGeneration: 3, agentFenceActive: false } });
  });

  it("keeps durable renewal successful when the SSM bridge write fails", async () => {
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "2" },
      agentFenceActive: { BOOL: true },
      operationId: { S: "backup-agent-atomic" },
      operationOwnerId: { S: "owner-agent" },
    };
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2, agentFenceActive: true })
    );
    mocks.putParameter.mockRejectedValue(new Error("SSM unavailable"));
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) return {};
      return { Item: active };
    });

    await expect(
      renewServerActionLockWithOperation("lock-a", 7, {
        operationId: "backup-agent-atomic",
        operationOwnerId: "owner-agent",
        expectedOperationVersion: 2,
        expectedLeaseGeneration: 2,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
        reconcile: () => false,
      })
    ).resolves.toMatchObject({ ownership: "renewed", lock: { leaseGeneration: 3 } });
  });

  it("rejects conditional renewal reconciliation when operation ownership changed", async () => {
    const active = {
      ...item("lock-a", 7),
      leaseGeneration: { N: "2" },
      agentFenceActive: { BOOL: true },
      operationId: { S: "backup-agent-atomic" },
      operationOwnerId: { S: "owner-agent" },
    };
    mocks.getParameter.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(legacy), leaseGeneration: 2, agentFenceActive: true })
    );
    mocks.send.mockImplementation(async (command) => {
      if (command.input?.Key?.lockKey?.S === "protocol#dual-v1") return metadata;
      if (command.input?.TransactItems) {
        throw Object.assign(new Error("conditional"), { name: "TransactionCanceledException" });
      }
      if (command.input?.TableName === "locks-table") return { Item: active };
      return {
        Item: {
          payload: { S: fencedOperationPayload(2, { dispatchOwnerId: "other-owner" }) },
          version: { N: "2" },
        },
      };
    });

    await expect(
      renewServerActionLockWithOperation("lock-a", 7, {
        operationId: "backup-agent-atomic",
        operationOwnerId: "owner-agent",
        expectedOperationVersion: 2,
        expectedLeaseGeneration: 2,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
        reconcile: () => true,
      })
    ).rejects.toBeInstanceOf(ServerActionLockConflictError);
  });

  it("updates mock lock and operation authorization in one persisted transaction", async () => {
    vi.stubEnv("MC_BACKEND_MODE", "mock");
    const state = {
      ssm: {
        parameters: {
          "/minecraft/server-action": {
            value: JSON.stringify({
              lockId: "lock-a",
              fencingToken: 7,
              leaseGeneration: 2,
              agentFenceActive: true,
              action: "backup",
              ownerEmail: "admin@example.com",
              createdAt: "2026-04-13T11:00:00.000Z",
              expiresAt: "2026-04-13T13:30:00.000Z",
              operationId: "backup-agent-atomic",
              operationOwnerId: "owner-agent",
            }),
            type: "String" as const,
            lastModified: "2026-04-13T12:00:00.000Z",
          },
          "/minecraft/operations/backup-agent-atomic": {
            value: fencedOperationPayload(2),
            type: "String" as const,
            lastModified: "2026-04-13T12:00:00.000Z",
          },
        },
      },
    };
    mocks.transact.mockImplementationOnce(async (transaction) => await transaction(state));

    await expect(
      renewServerActionLockWithOperation("lock-a", 7, {
        operationId: "backup-agent-atomic",
        operationOwnerId: "owner-agent",
        expectedOperationVersion: 2,
        expectedLeaseGeneration: 2,
        updatedAt: "2026-04-13T12:00:00.000Z",
        ttlEpochSeconds: 1_800_000_000,
        payload: (lock, version) => fencedOperationPayload(lock.leaseGeneration ?? 0, { version }),
        reconcile: () => false,
      })
    ).resolves.toMatchObject({ ownership: "renewed", lock: { leaseGeneration: 3 } });

    expect(mocks.transact).toHaveBeenCalledOnce();
    expect(JSON.parse(state.ssm.parameters["/minecraft/server-action"].value)).toMatchObject({
      leaseGeneration: 3,
      agentFenceActive: true,
    });
    expect(JSON.parse(state.ssm.parameters["/minecraft/operations/backup-agent-atomic"].value)).toMatchObject({
      version: 3,
      lockLeaseGeneration: 3,
    });
    expect(mocks.renewLifecycleLock).not.toHaveBeenCalled();
  });

  it.each(["mock", "MOCK", " mock "])(
    "stores %j-mode locks in shared provider state and releases only the matching fence",
    async (backendMode) => {
      vi.stubEnv("MC_BACKEND_MODE", backendMode);
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
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );
});
