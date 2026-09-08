import { createHash } from "node:crypto";
import type { BackupFenceAuthorization } from "@/lib/agent/contracts";
import type { RuntimeBackupCreateRequest } from "@/lib/agent/runtime/contracts";
import type { DurableOperationState } from "@/lib/durable-operation-state";
import { ServerState } from "@/lib/types";
import { describe, expect, it, vi } from "vitest";
import { DeterministicRuntimeBackupControlAdapter, ProductionRuntimeBackupControlAdapter } from "./backup-control";

const NOW = "2026-09-02T12:00:00.000Z";
const input: RuntimeBackupCreateRequest & { runtimeId: string } = {
  schemaVersion: 1,
  action: "create",
  leaseId: "lease-runtime",
  leaseGeneration: 4,
  sessionId: "session-runtime",
  taskId: "task-runtime",
  invocationId: "invocation-runtime",
  invocationDigest: "a".repeat(64),
  runtimeId: "runtime-production",
};

function backupIdForInput(): string {
  return `backup-agent-${createHash("sha256")
    .update(
      JSON.stringify([
        input.leaseId,
        input.leaseGeneration,
        input.sessionId,
        input.taskId,
        input.invocationId,
        input.invocationDigest,
      ])
    )
    .digest("hex")
    .slice(0, 48)}`;
}

function operation(id: string, status: DurableOperationState["status"]): DurableOperationState {
  return {
    schemaVersion: 1,
    id,
    type: "backup",
    route: "/api/agent/runtime/backups",
    status,
    requestedAt: NOW,
    updatedAt: NOW,
    requestedBy: "admin@example.invalid",
    agentRuntimeId: input.runtimeId,
    agentSessionId: input.sessionId,
    agentTaskId: input.taskId,
    agentLeaseId: input.leaseId,
    agentLeaseGeneration: input.leaseGeneration,
    agentInvocationId: input.invocationId,
    agentInvocationDigest: input.invocationDigest,
    phase: status === "completed" || status === "failed" ? "terminal" : "dispatched",
    history: [],
  };
}

function terminalReceipt(authorization: BackupFenceAuthorization, outcome: "committed" | "failed" | "cancelled") {
  return {
    schemaVersion: 1 as const,
    source: "executor-journal" as const,
    proofKind: "terminal" as const,
    outcome,
    executorKeyId: authorization.executorKeyId ?? "executor-receipt-test",
    ...(authorization.executorKeyEpoch !== undefined ? { executorKeyEpoch: authorization.executorKeyEpoch } : {}),
    executorEpoch: "epoch-test",
    runtimeId: authorization.runtimeId,
    leaseId: authorization.leaseId,
    leaseGeneration: authorization.leaseGeneration,
    sessionId: authorization.sessionId,
    taskId: authorization.taskId,
    invocationId: authorization.invocationId,
    invocationDigest: authorization.invocationDigest,
    backupId: authorization.backupId,
    lifecycleLockId: authorization.lifecycleLockId,
    lifecycleFencingToken: authorization.lifecycleFencingToken,
    lifecycleLeaseGeneration: authorization.lifecycleLeaseGeneration,
    resultDigest: "b".repeat(64),
    journalSequence: 1,
    completedAt: NOW,
    signature: "A".repeat(86),
  };
}

describe("runtime backup control adapters", () => {
  it("uses the injected provider boundary, awaits its dispatch, and returns an invocation-bound terminal result", async () => {
    let current: DurableOperationState | null = null;
    let releaseDispatch: (() => void) | undefined;
    const dispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const invokeLambda = vi.fn(async (_name: string, payload: unknown) => {
      await dispatch;
      const id = (payload as { operationId: string }).operationId;
      current = {
        ...operation(id, "completed"),
        sideEffectCompletedAt: NOW,
        lockId: "lock-runtime",
        fencingToken: 7,
      };
    });
    let lifecycleFenceHeld = true;
    const releaseLock = vi.fn(async () => {
      lifecycleFenceHeld = false;
      return true;
    });
    const attemptRestore = async () => {
      if (lifecycleFenceHeld) throw new Error("restore blocked by global lifecycle fence");
      return "restore accepted";
    };
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(async () => "i-runtime"),
        getInstanceState: vi.fn(async () => ServerState.Running),
        getMinecraftServiceStatus: vi.fn(async () => ({
          instanceState: ServerState.Running,
          instanceRunning: true,
          serviceActive: true,
        })),
        invokeLambda,
      },
      claimOperationLock: vi.fn(async (claim) => {
        const lock = {
          lockId: "lock-runtime",
          fencingToken: 7,
          action: "backup" as const,
          leaseGeneration: 1,
          agentFenceActive: false,
          ownerEmail: "admin@example.invalid",
          createdAt: NOW,
          expiresAt: "2026-09-02T13:00:00.000Z",
          operationId: claim.operationId,
          operationOwnerId: claim.ownerId,
        };
        current = {
          ...operation(claim.operationId, "accepted"),
          phase: "dispatching",
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          dispatchOwnerId: claim.ownerId,
          requestIdempotencyKey: claim.operationId,
        };
        return { ownership: "acquired" as const, operation: current, lock };
      }),
      releaseLock,
      assertLock: vi.fn(async () => ({
        lockId: "lock-runtime",
        fencingToken: 7,
        action: "backup" as const,
        leaseGeneration: 1,
        agentFenceActive: false,
        ownerEmail: "admin@example.invalid",
        createdAt: NOW,
        expiresAt: "2026-09-02T13:00:00.000Z",
      })),
      renewOperationFence: vi.fn(async (renewal) => {
        const lock = {
          lockId: "lock-runtime",
          fencingToken: 7,
          action: "backup" as const,
          leaseGeneration:
            (renewal.expectedAuthorization?.lifecycleLeaseGeneration ?? current?.lockLeaseGeneration ?? 1) + 1,
          agentFenceActive: true,
          ownerEmail: "admin@example.invalid",
          createdAt: NOW,
          expiresAt: "2026-09-02T13:30:00.000Z",
        };
        const authorization = await renewal.createAuthorization(lock);
        current = {
          ...(current as DurableOperationState),
          lockLeaseGeneration: lock.leaseGeneration,
          lockLeaseExpiresAt: lock.expiresAt,
          agentEffectReconciliationStatus: renewal.expectedAuthorization ? "active" : "awaiting-executor",
          agentFenceAuthorization: authorization,
        };
        return { operation: current, lock, authorization, ownership: "renewed" as const };
      }),
      issueFence: vi.fn(async (authorization) => ({ ...authorization, signature: "A".repeat(86) })),
      verifyFence: vi.fn(async () => true),
      verifyReceipt: vi.fn(async () => true),
      getOperation: vi.fn(async () => current),
      persistOperation: vi.fn(async (transition) => {
        if (current?.status === "completed") {
          current = {
            ...current,
            agentEffectReconciliationStatus:
              transition.agentEffectReconciliationStatus ?? current.agentEffectReconciliationStatus,
            agentEffectSafetyExpiresAt: transition.agentEffectSafetyExpiresAt ?? current.agentEffectSafetyExpiresAt,
            lockLeaseGeneration: transition.lockLeaseGeneration ?? current.lockLeaseGeneration,
            lockLeaseExpiresAt: transition.lockLeaseExpiresAt ?? current.lockLeaseExpiresAt,
          };
          return current;
        }
        current = operation(transition.operationId, transition.status);
        return current;
      }),
      expireOperation: vi.fn(async () => ({ operation: current, shouldReleaseLock: false })),
    });
    const pending = adapter.startOrPoll(input);
    await vi.waitFor(() => expect(invokeLambda).toHaveBeenCalledTimes(1));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDispatch?.();
    const result = await pending;
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: input.sessionId,
      taskId: input.taskId,
      invocationId: input.invocationId,
      invocationDigest: input.invocationDigest,
      createdAt: NOW,
    });
    const payload = invokeLambda.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      invocationType: "api",
      operationRoute: "/api/agent/runtime/backups",
      command: "backup",
      lockId: "lock-runtime",
      fencingToken: 7,
      requireAlreadyRunning: true,
      requireServiceActive: true,
      retainLockForAgentEffect: true,
    });
    expect(JSON.stringify(payload)).not.toContain("provider-secret");
    expect(releaseLock).not.toHaveBeenCalled();
    if (!result.fenceAuthorization) throw new Error("test fence authorization missing");
    const renewed = await adapter.renew({
      schemaVersion: 1,
      action: "renew",
      runtimeId: input.runtimeId,
      authorization: result.fenceAuthorization,
    });
    expect(renewed).toMatchObject({
      status: "renewed",
      authorization: { lifecycleLeaseGeneration: 3 },
    });
    expect(current).toMatchObject({
      agentEffectReconciliationStatus: "active",
      lockLeaseGeneration: 3,
    });
    const renewedAuthorization = renewed.authorization;
    if (renewed.status !== "renewed" || !renewedAuthorization) throw new Error("test fence renewal missing");
    await expect(
      adapter.renew({
        schemaVersion: 1,
        action: "renew",
        runtimeId: input.runtimeId,
        authorization: result.fenceAuthorization,
      })
    ).resolves.toMatchObject({ status: "renewed", authorization: { lifecycleLeaseGeneration: 3 } });
    await expect(attemptRestore()).rejects.toThrow(/blocked by global lifecycle fence/i);
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization: renewedAuthorization,
        outcome: "indeterminate",
      })
    ).resolves.toEqual({
      schemaVersion: 1,
      authorizationId: renewedAuthorization.authorizationId,
      status: "reconciliation-needed",
      released: false,
    });
    expect(releaseLock).not.toHaveBeenCalled();
    expect(current).toMatchObject({ agentEffectReconciliationStatus: "needed" });
    expect((current as DurableOperationState | null)?.agentEffectSafetyExpiresAt).toBeUndefined();
    await expect(attemptRestore()).rejects.toThrow(/blocked by global lifecycle fence/i);
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization: renewedAuthorization,
        outcome: "committed",
        terminalReceipt: terminalReceipt(renewedAuthorization, "committed"),
      })
    ).resolves.toMatchObject({ status: "finalized", released: true });
    expect(releaseLock).toHaveBeenCalledWith("lock-runtime", {
      action: "backup",
      ownerEmail: "admin@example.invalid",
      fencingToken: 7,
      leaseGeneration: 3,
    });
    expect(current).toMatchObject({ agentEffectReconciliationStatus: "resolved" });
    await expect(attemptRestore()).resolves.toBe("restore accepted");
  });

  it("keeps an ambiguous Lambda dispatch fenced and reconciles the same operation without dispatching twice", async () => {
    let current: DurableOperationState | null = null;
    const invokeLambda = vi.fn(async () => {
      throw new Error("ambiguous Lambda response loss");
    });
    const releaseLock = vi.fn(async () => true);
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(async () => "i-runtime"),
        getInstanceState: vi.fn(async () => ServerState.Running),
        getMinecraftServiceStatus: vi.fn(async () => ({
          instanceState: ServerState.Running,
          instanceRunning: true,
          serviceActive: true,
        })),
        invokeLambda,
      },
      claimOperationLock: vi.fn(async (claim) => {
        const lock = {
          lockId: "lock-ambiguous",
          fencingToken: 8,
          action: "backup" as const,
          leaseGeneration: 1,
          agentFenceActive: false,
          ownerEmail: "admin@example.invalid",
          createdAt: NOW,
          expiresAt: "2026-09-02T13:00:00.000Z",
          operationId: claim.operationId,
          operationOwnerId: claim.ownerId,
        };
        current = {
          ...operation(claim.operationId, "accepted"),
          phase: "dispatching",
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          dispatchOwnerId: claim.ownerId,
          requestIdempotencyKey: claim.operationId,
        };
        return { ownership: "acquired" as const, operation: current, lock };
      }),
      assertLock: vi.fn(async () => ({
        lockId: "lock-ambiguous",
        fencingToken: 8,
        action: "backup" as const,
        leaseGeneration: 1,
        agentFenceActive: false,
        ownerEmail: "admin@example.invalid",
        createdAt: NOW,
        expiresAt: "2026-09-02T13:00:00.000Z",
        operationId: current?.id,
        operationOwnerId: current?.dispatchOwnerId,
      })),
      releaseLock,
      getOperation: vi.fn(async () => current),
      persistOperation: vi.fn(async (transition) => {
        current = {
          ...operation(transition.operationId, transition.status),
          phase: transition.phase,
          lockId: transition.lockId ?? current?.lockId,
          fencingToken: transition.fencingToken ?? current?.fencingToken,
        };
        return current;
      }),
      expireOperation: vi.fn(async () => ({ operation: current, shouldReleaseLock: false })),
    });
    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "pending" });
    expect(releaseLock).not.toHaveBeenCalled();
    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "pending" });
    expect(invokeLambda).toHaveBeenCalledOnce();
  });

  it("transactionally rechecks cancellation after ownership and persists cancellation before releasing", async () => {
    let current: DurableOperationState | null = null;
    const order: string[] = [];
    const lock = {
      lockId: "lock-cancel-race",
      fencingToken: 9,
      action: "backup" as const,
      leaseGeneration: 1,
      agentFenceActive: false,
      ownerEmail: "admin@example.invalid",
      createdAt: NOW,
      expiresAt: "2026-09-02T13:00:00.000Z",
      operationId: "backup-cancel-race",
      operationOwnerId: "owner-cancel-race",
    };
    const invokeLambda = vi.fn();
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      createOwnerId: () => "owner-cancel-race",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(async () => "i-runtime"),
        getInstanceState: vi.fn(async () => ServerState.Running),
        getMinecraftServiceStatus: vi.fn(async () => ({
          instanceState: ServerState.Running,
          instanceRunning: true,
          serviceActive: true,
        })),
        invokeLambda,
      },
      claimOperationLock: vi.fn(async (claim) => {
        order.push("claim");
        current = {
          ...operation(claim.operationId, "accepted"),
          phase: "dispatching",
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          dispatchOwnerId: claim.ownerId,
          requestIdempotencyKey: claim.operationId,
        };
        return { ownership: "acquired" as const, operation: current, lock };
      }),
      assertLock: vi.fn(async () => {
        order.push("assert-owner");
        return lock;
      }),
      persistOperation: vi.fn(async (transition) => {
        order.push(`persist-${transition.code}`);
        current = {
          ...(current as DurableOperationState),
          status: transition.status,
          phase: transition.phase,
          code: transition.code,
        };
        return current;
      }),
      releaseLock: vi.fn(async () => {
        order.push("release");
        expect(current).toMatchObject({ status: "failed", code: "runtime_backup_cancelled" });
        return true;
      }),
      getOperation: vi.fn(async () => current),
      expireOperation: vi.fn(async () => ({ operation: current, shouldReleaseLock: false })),
    });

    await expect(
      adapter.startOrPoll(input, undefined, async () => {
        order.push("recheck-cancelled");
        return false;
      })
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(order).toEqual([
      "claim",
      "assert-owner",
      "recheck-cancelled",
      "persist-runtime_backup_cancelled",
      "release",
    ]);
    expect(invokeLambda).not.toHaveBeenCalled();
  });

  it("attaches a simultaneous duplicate to the owned in-progress operation and dispatches once", async () => {
    let current: DurableOperationState | null = null;
    let releaseDispatch: (() => void) | undefined;
    const dispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const lock = {
      lockId: "lock-duplicate",
      fencingToken: 10,
      action: "backup" as const,
      leaseGeneration: 1,
      agentFenceActive: false,
      ownerEmail: "admin@example.invalid",
      createdAt: NOW,
      expiresAt: "2026-09-02T13:00:00.000Z",
      operationId: "backup-duplicate",
      operationOwnerId: "owner-first",
    };
    const invokeLambda = vi.fn(async () => {
      await dispatch;
      current = {
        ...(current as DurableOperationState),
        status: "completed",
        phase: "terminal",
        sideEffectCompletedAt: NOW,
      };
    });
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      createOwnerId: vi.fn().mockReturnValueOnce("owner-first").mockReturnValueOnce("owner-duplicate"),
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(async () => "i-runtime"),
        getInstanceState: vi.fn(async () => ServerState.Running),
        getMinecraftServiceStatus: vi.fn(async () => ({
          instanceState: ServerState.Running,
          instanceRunning: true,
          serviceActive: true,
        })),
        invokeLambda,
      },
      claimOperationLock: vi.fn(async (claim) => {
        current = {
          ...operation(claim.operationId, "accepted"),
          phase: "dispatching",
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          dispatchOwnerId: claim.ownerId,
          requestIdempotencyKey: claim.operationId,
        };
        return { ownership: "acquired" as const, operation: current, lock };
      }),
      assertLock: vi.fn(async () => lock),
      renewOperationFence: vi.fn(async (renewal) => {
        const renewedLock = { ...lock, leaseGeneration: 2, agentFenceActive: true };
        const authorization = await renewal.createAuthorization(renewedLock);
        current = {
          ...(current as DurableOperationState),
          lockLeaseGeneration: 2,
          lockLeaseExpiresAt: renewedLock.expiresAt,
          agentEffectReconciliationStatus: renewal.expectedAuthorization ? "active" : "awaiting-executor",
          agentFenceAuthorization: authorization,
        };
        return { operation: current, lock: renewedLock, authorization, ownership: "renewed" as const };
      }),
      issueFence: vi.fn(async (authorization) => ({ ...authorization, signature: "A".repeat(86) })),
      getOperation: vi.fn(async () => current),
      persistOperation: vi.fn(async () => current as DurableOperationState),
      expireOperation: vi.fn(async () => ({ operation: current, shouldReleaseLock: false })),
    });

    const first = adapter.startOrPoll(input, undefined, async () => true);
    await vi.waitFor(() => expect(invokeLambda).toHaveBeenCalledOnce());
    await expect(adapter.startOrPoll(input, undefined, async () => true)).resolves.toMatchObject({ status: "pending" });
    releaseDispatch?.();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    expect(invokeLambda).toHaveBeenCalledOnce();
  });

  it("maps atomic lock or persistence ambiguity to a non-terminal ambiguous response without dispatch", async () => {
    const invokeLambda = vi.fn();
    const releaseLock = vi.fn();
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      provider: {
        findInstanceId: vi.fn(async () => "i-runtime"),
        getInstanceState: vi.fn(async () => ServerState.Running),
        getMinecraftServiceStatus: vi.fn(async () => ({
          instanceState: ServerState.Running,
          instanceRunning: true,
          serviceActive: true,
        })),
        invokeLambda,
      },
      claimOperationLock: vi.fn(async () => {
        throw new Error("atomic transaction response and ownership read were lost");
      }),
      releaseLock,
      getOperation: vi.fn(async () => null),
    });

    await expect(adapter.startOrPoll(input, undefined, async () => true)).resolves.toMatchObject({
      status: "ambiguous",
    });
    expect(invokeLambda).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it("retains an active completed fence when its remaining horizon is too short", async () => {
    const completed = {
      ...operation("backup-agent-expired-fence", "completed"),
      sideEffectCompletedAt: "2026-09-02T11:50:00.000Z",
      lockId: "lock-expired-fence",
      fencingToken: 12,
    };
    const releaseLock = vi.fn(async () => true);
    const issueFence = vi.fn();
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => completed),
      expireOperation: vi.fn(async () => ({ operation: completed, shouldReleaseLock: false })),
      assertLock: vi.fn(async () => ({
        lockId: "lock-expired-fence",
        fencingToken: 12,
        action: "backup" as const,
        leaseGeneration: 1,
        agentFenceActive: false,
        ownerEmail: "admin@example.invalid",
        createdAt: "2026-09-02T11:00:00.000Z",
        expiresAt: "2026-09-02T12:00:20.000Z",
      })),
      renewOperationFence: vi.fn(async (renewal) => {
        const lock = {
          lockId: "lock-expired-fence",
          fencingToken: 12,
          action: "backup" as const,
          leaseGeneration: 2,
          agentFenceActive: true,
          ownerEmail: "admin@example.invalid",
          createdAt: "2026-09-02T11:00:00.000Z",
          expiresAt: "2026-09-02T12:00:20.000Z",
        };
        const authorization = await renewal.createAuthorization(lock);
        return { operation: completed, lock, authorization, ownership: "renewed" as const };
      }),
      releaseLock,
      issueFence,
    });
    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "unavailable" });
    expect(issueFence).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it("does not release an expired fence while executor reconciliation is still needed", async () => {
    const completed = {
      ...operation("backup-agent-unresolved-fence", "completed"),
      sideEffectCompletedAt: "2026-09-02T11:50:00.000Z",
      lockId: "lock-unresolved-fence",
      fencingToken: 13,
      agentEffectReconciliationStatus: "needed" as const,
      agentEffectSafetyExpiresAt: "2026-09-02T11:53:00.000Z",
    };
    const releaseLock = vi.fn(async () => true);
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => completed),
      expireOperation: vi.fn(async () => ({ operation: completed, shouldReleaseLock: false })),
      assertLock: vi.fn(async () => ({
        lockId: completed.lockId,
        fencingToken: completed.fencingToken,
        action: "backup" as const,
        leaseGeneration: 1,
        agentFenceActive: false,
        ownerEmail: "admin@example.invalid",
        createdAt: "2026-09-02T11:00:00.000Z",
        expiresAt: "2026-09-02T13:00:00.000Z",
      })),
      releaseLock,
    });

    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "unavailable" });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it.each(["committed", "failed", "cancelled"] as const)(
    "does not release for a fabricated %s outcome without an executor receipt",
    async (outcome) => {
      const authorization = {
        schemaVersion: 1 as const,
        status: "succeeded" as const,
        authorizationId: "authorization-fabricated",
        runtimeId: input.runtimeId,
        leaseId: input.leaseId,
        leaseGeneration: input.leaseGeneration,
        sessionId: input.sessionId,
        taskId: input.taskId,
        invocationId: input.invocationId,
        invocationDigest: input.invocationDigest,
        backupId: backupIdForInput(),
        lifecycleLockId: "lock-fabricated",
        lifecycleFencingToken: 15,
        lifecycleLeaseGeneration: 2,
        lifecycleLeaseExpiresAt: "2026-09-02T13:00:00.000Z",
        issuedAt: NOW,
        expiresAt: "2026-09-02T12:01:00.000Z",
        signature: "A".repeat(86),
      } satisfies BackupFenceAuthorization;
      const current = {
        ...operation(authorization.backupId, "completed"),
        lockId: authorization.lifecycleLockId,
        fencingToken: authorization.lifecycleFencingToken,
        lockLeaseGeneration: authorization.lifecycleLeaseGeneration,
        dispatchOwnerId: "owner-fabricated",
        version: 3,
        agentEffectReconciliationStatus: "active" as const,
        agentFenceAuthorization: authorization,
      };
      const releaseLock = vi.fn(async () => true);
      const adapter = new ProductionRuntimeBackupControlAdapter({
        configured: true,
        ownerEmail: "admin@example.invalid",
        now: () => new Date(NOW),
        provider: {
          findInstanceId: vi.fn(),
          getInstanceState: vi.fn(),
          getMinecraftServiceStatus: vi.fn(),
          invokeLambda: vi.fn(),
        },
        getOperation: vi.fn(async () => current),
        verifyFence: vi.fn(async () => true),
        verifyReceipt: vi.fn(async () => true),
        releaseLock,
        persistOperation: vi.fn(async () => current),
      });
      await expect(
        adapter.finalize({
          schemaVersion: 1,
          action: "finalize",
          runtimeId: input.runtimeId,
          authorization,
          outcome,
        })
      ).rejects.toThrow(/authoritative terminal executor receipt/i);
      expect(releaseLock).not.toHaveBeenCalled();
    }
  );

  it("accepts one valid terminal receipt, makes the exact replay idempotent, and rejects a conflicting replay", async () => {
    const authorization: BackupFenceAuthorization = {
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "authorization-replay",
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      leaseGeneration: input.leaseGeneration,
      sessionId: input.sessionId,
      taskId: input.taskId,
      invocationId: input.invocationId,
      invocationDigest: input.invocationDigest,
      backupId: backupIdForInput(),
      lifecycleLockId: "lock-replay",
      lifecycleFencingToken: 16,
      lifecycleLeaseGeneration: 2,
      lifecycleLeaseExpiresAt: "2026-09-02T13:00:00.000Z",
      issuedAt: NOW,
      expiresAt: "2026-09-02T12:01:00.000Z",
      signature: "A".repeat(86),
    };
    const receipt = terminalReceipt(authorization, "committed");
    let current: DurableOperationState = {
      ...operation(authorization.backupId, "completed"),
      lockId: authorization.lifecycleLockId,
      fencingToken: authorization.lifecycleFencingToken,
      lockLeaseGeneration: authorization.lifecycleLeaseGeneration,
      dispatchOwnerId: "owner-replay",
      version: 3,
      agentFenceAuthorization: authorization,
    };
    const releaseLock = vi.fn(async () => true);
    const persistOperation = vi.fn(async (transition) => {
      current = {
        ...current,
        agentEffectReconciliationStatus: transition.agentEffectReconciliationStatus,
        agentTerminalReceipt: transition.agentTerminalReceipt,
      };
      return current;
    });
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => current),
      verifyFence: vi.fn(async () => true),
      verifyReceipt: vi.fn(async (candidate) => candidate.signature === receipt.signature),
      releaseLock,
      persistOperation,
    });
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization,
        outcome: "committed",
        terminalReceipt: { ...receipt, signature: "B".repeat(86) },
      })
    ).rejects.toThrow(/signature|key ID/i);
    expect(releaseLock).not.toHaveBeenCalled();
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization,
        outcome: "committed",
        terminalReceipt: receipt,
      })
    ).resolves.toMatchObject({ released: true });
    expect(releaseLock).toHaveBeenCalledOnce();
    current = { ...current, agentEffectReconciliationStatus: "resolved", agentTerminalReceipt: receipt };
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization,
        outcome: "committed",
        terminalReceipt: receipt,
      })
    ).resolves.toMatchObject({ released: true });
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization,
        outcome: "failed",
        terminalReceipt: terminalReceipt(authorization, "failed"),
      })
    ).rejects.toThrow(/not finalizable|receipt/i);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("never releases an indeterminate fence merely because every elapsed-time horizon passed", async () => {
    const backupId = `backup-agent-${createHash("sha256")
      .update(
        JSON.stringify([
          input.leaseId,
          input.leaseGeneration,
          input.sessionId,
          input.taskId,
          input.invocationId,
          input.invocationDigest,
        ])
      )
      .digest("hex")
      .slice(0, 48)}`;
    const authorization: BackupFenceAuthorization = {
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "authorization-expired",
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      leaseGeneration: input.leaseGeneration,
      sessionId: input.sessionId,
      taskId: input.taskId,
      invocationId: input.invocationId,
      invocationDigest: input.invocationDigest,
      backupId,
      lifecycleLockId: "lock-expired-agent-effect",
      lifecycleFencingToken: 14,
      lifecycleLeaseGeneration: 2,
      lifecycleLeaseExpiresAt: "2026-09-02T11:55:00.000Z",
      issuedAt: "2026-09-02T11:50:00.000Z",
      expiresAt: "2026-09-02T11:51:00.000Z",
      signature: "A".repeat(86),
    };
    let current: DurableOperationState = {
      ...operation(backupId, "completed"),
      lockId: authorization.lifecycleLockId,
      fencingToken: authorization.lifecycleFencingToken,
      lockLeaseGeneration: authorization.lifecycleLeaseGeneration,
      agentEffectReconciliationStatus: "needed",
      agentEffectSafetyExpiresAt: "2026-09-02T11:54:00.000Z",
      agentFenceAuthorization: authorization,
    };
    const releaseLock = vi.fn(async () => true);
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => current),
      verifyFence: vi.fn(async () => true),
      verifyReceipt: vi.fn(async () => true),
      releaseLock,
      persistOperation: vi.fn(async (transition) => {
        current = {
          ...current,
          agentEffectReconciliationStatus:
            transition.agentEffectReconciliationStatus ?? current.agentEffectReconciliationStatus,
        };
        return current;
      }),
    });

    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization,
        outcome: "indeterminate",
      })
    ).resolves.toMatchObject({ status: "reconciliation-needed", released: false });
    expect(releaseLock).not.toHaveBeenCalled();
    expect(current).toMatchObject({ agentEffectReconciliationStatus: "needed" });
  });

  it("fails unavailable without dispatch when production prerequisites are absent", async () => {
    const invokeLambda = vi.fn();
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: false,
      ownerEmail: "unavailable@agent.invalid",
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda,
      },
    });
    await expect(adapter.evaluateAvailability()).resolves.toBe("unavailable");
    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "unavailable" });
    expect(invokeLambda).not.toHaveBeenCalled();
  });

  it("honors expired-operation lock release with the persisted fencing token", async () => {
    const accepted = {
      ...operation("backup-agent-expired", "accepted"),
      lockId: "lock-expired",
      fencingToken: 11,
      phase: "dispatched" as const,
    };
    const expired = {
      ...accepted,
      status: "failed" as const,
      phase: "terminal" as const,
      code: "dispatch_expired",
    };
    const releaseLock = vi.fn(async () => true);
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => accepted),
      expireOperation: vi.fn(async () => ({ operation: expired, shouldReleaseLock: true })),
      releaseLock,
    });

    await expect(adapter.startOrPoll(input)).resolves.toMatchObject({ status: "ambiguous" });
    expect(releaseLock).toHaveBeenCalledWith("lock-expired", {
      action: "backup",
      ownerEmail: "admin@example.invalid",
      fencingToken: 11,
    });
  });

  it.each(["cancelled", "replaced", "expired-lease"] as const)(
    "checks current runtime authority before a completed operation can renew for %s",
    async (reason) => {
      const completed = {
        ...operation(backupIdForInput(), "completed"),
        lockId: "lock-delayed-retry",
        fencingToken: 20,
        lockLeaseGeneration: 2,
      };
      const getOperation = vi.fn(async () => completed);
      const renewOperationFence = vi.fn();
      const assertCurrentAuthority = vi.fn(async () => {
        throw new Error(`current invocation authority is ${reason}`);
      });
      const adapter = new ProductionRuntimeBackupControlAdapter({
        configured: true,
        ownerEmail: "admin@example.invalid",
        provider: {
          findInstanceId: vi.fn(),
          getInstanceState: vi.fn(),
          getMinecraftServiceStatus: vi.fn(),
          invokeLambda: vi.fn(),
        },
        getOperation,
        renewOperationFence,
        assertCurrentAuthority,
      });

      await expect(adapter.startOrPoll(input)).rejects.toThrow(/current invocation authority/);
      expect(assertCurrentAuthority).toHaveBeenCalledOnce();
      expect(getOperation).not.toHaveBeenCalled();
      expect(renewOperationFence).not.toHaveBeenCalled();
    }
  );

  it("renews and finalizes an exact retained old fence after durable restart recovery", async () => {
    const backupId = backupIdForInput();
    const oldAuthorization: BackupFenceAuthorization = {
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "fence-retained-old",
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      leaseGeneration: input.leaseGeneration,
      sessionId: input.sessionId,
      taskId: input.taskId,
      invocationId: input.invocationId,
      invocationDigest: input.invocationDigest,
      backupId,
      lifecycleLockId: "lock-retained-old",
      lifecycleFencingToken: 21,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: "2026-09-02T13:00:00.000Z",
      executorKeyId: "executor-receipt-old",
      executorKeyEpoch: 1,
      issuedAt: "2026-09-02T11:59:00.000Z",
      expiresAt: "2026-09-02T12:01:00.000Z",
      signature: "A".repeat(86),
    };
    const currentOperation: DurableOperationState = {
      ...operation(backupId, "completed"),
      lockId: oldAuthorization.lifecycleLockId,
      fencingToken: oldAuthorization.lifecycleFencingToken,
      lockLeaseGeneration: 1,
      dispatchOwnerId: "owner-retained-old",
      version: 4,
      agentEffectReconciliationStatus: "needed",
      agentFenceAuthorization: oldAuthorization,
    };
    const currentAuthorization = {
      ...oldAuthorization,
      lifecycleLeaseGeneration: 2,
      lifecycleLeaseExpiresAt: "2026-09-02T13:30:00.000Z",
      executorKeyId: "executor-receipt-current",
      executorKeyEpoch: 2,
      issuedAt: "2026-09-02T12:00:00.000Z",
      expiresAt: "2026-09-02T12:01:00.000Z",
    };
    const lock = {
      lockId: oldAuthorization.lifecycleLockId,
      fencingToken: oldAuthorization.lifecycleFencingToken,
      action: "backup" as const,
      leaseGeneration: 2,
      agentFenceActive: true,
      ownerEmail: "admin@example.invalid",
      createdAt: NOW,
      expiresAt: "2026-09-02T13:30:00.000Z",
      operationId: backupId,
      operationOwnerId: "owner-retained-old",
    };
    const renewOperationFence = vi.fn(async (renewal) => {
      await renewal.createAuthorization(lock);
      return {
        operation: { ...currentOperation, lockLeaseGeneration: 2, agentFenceAuthorization: currentAuthorization },
        lock,
        authorization: currentAuthorization,
        ownership: "renewed" as const,
      };
    });
    const finalizeOperationFence = vi.fn(async () => currentOperation);
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      now: () => new Date(NOW),
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation: vi.fn(async () => currentOperation),
      verifyFence: vi.fn(async () => true),
      verifyReceipt: vi.fn(async () => true),
      renewOperationFence,
      issueFence: vi.fn(async (value) => ({ ...value, ...currentAuthorization })),
      finalizeOperationFence,
    });

    await expect(
      adapter.renew({ schemaVersion: 1, action: "renew", runtimeId: input.runtimeId, authorization: oldAuthorization })
    ).resolves.toMatchObject({ status: "renewed", authorization: { executorKeyEpoch: 2 } });
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        runtimeId: input.runtimeId,
        authorization: oldAuthorization,
        outcome: "committed",
        terminalReceipt: terminalReceipt(oldAuthorization, "committed"),
      })
    ).resolves.toMatchObject({ released: true });
    expect(renewOperationFence).toHaveBeenCalledOnce();
    expect(finalizeOperationFence).toHaveBeenCalledOnce();
  });

  it("fences recovery before consulting a completed operation", async () => {
    const getOperation = vi.fn();
    const adapter = new ProductionRuntimeBackupControlAdapter({
      configured: true,
      ownerEmail: "admin@example.invalid",
      provider: {
        findInstanceId: vi.fn(),
        getInstanceState: vi.fn(),
        getMinecraftServiceStatus: vi.fn(),
        invokeLambda: vi.fn(),
      },
      getOperation,
      assertCurrentAuthority: vi.fn(async () => {
        throw new Error("invocation was revoked before recovery");
      }),
    });

    await expect(adapter.recoverExisting(input)).rejects.toThrow(/revoked/);
    expect(getOperation).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed", "unavailable"] as const)("provides deterministic %s fake behavior", async (mode) => {
    const adapter = new DeterministicRuntimeBackupControlAdapter(mode, () => new Date(NOW));
    const first = await adapter.startOrPoll(input);
    const second = await adapter.startOrPoll(input);
    expect(second).toEqual(first);
    expect(first.status).toBe(mode);
    expect(first).toMatchObject({ sessionId: input.sessionId, invocationId: input.invocationId });
  });
});
