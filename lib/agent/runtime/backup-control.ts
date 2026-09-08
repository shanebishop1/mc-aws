import { createHash, randomUUID } from "node:crypto";
import type { BackupFenceAuthorization, BackupTerminalReceipt } from "@/lib/agent/contracts";
import {
  BACKUP_FENCE_AUTHORIZATION_MS,
  BACKUP_FENCE_EFFECT_MARGIN_MS,
  signBackupFenceAuthorization,
  verifyBackupFenceAuthorizationSignature,
} from "@/lib/agent/runtime/backup-fence";
import type {
  RuntimeBackupCreateRequest,
  RuntimeBackupFinalizeRequest,
  RuntimeBackupFinalizeResult,
  RuntimeBackupRenewRequest,
  RuntimeBackupRenewResult,
  RuntimeBackupResult,
} from "@/lib/agent/runtime/contracts";
import {
  executorReceiptSignedContent,
  parseExecutorReceiptVerifierSetJson,
  verifyExecutorTerminalReceipt,
} from "@/lib/agent/runtime/executor-receipt";
import type { AwsProvider } from "@/lib/aws/types";
import {
  type ClaimDurableOperationLockInput,
  type ClaimDurableOperationLockResult,
  type DurableOperationState,
  claimDurableOperationLock,
  expireAcceptedDispatchIfDeadlineElapsed,
  finalizeDurableOperationFence,
  getDurableOperationState,
  persistDurableOperationStateTransition,
  renewDurableOperationFence,
} from "@/lib/durable-operation-state";
import { type ServerActionLock, assertServerActionLockOwned, releaseServerActionLock } from "@/lib/server-action-lock";
import { ServerState } from "@/lib/types";

const RUNTIME_BACKUP_ROUTE = "/api/agent/runtime/backups";

export interface RuntimeBackupControlAdapter {
  evaluateAvailability(): Promise<"available" | "unavailable">;
  startOrPoll(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    signal?: AbortSignal,
    recheckActive?: () => Promise<boolean>
  ): Promise<RuntimeBackupResult>;
  recoverExisting(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupResult | null>;
  finalize(
    input: RuntimeBackupFinalizeRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupFinalizeResult>;
  renew(
    input: RuntimeBackupRenewRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupRenewResult>;
  /** Verifies executor-authenticated terminal evidence without changing backup state. */
  verifyTerminalReceipt?(receipt: BackupTerminalReceipt): Promise<boolean>;
}

interface ProductionRuntimeBackupDependencies {
  provider: Pick<AwsProvider, "findInstanceId" | "getInstanceState" | "getMinecraftServiceStatus" | "invokeLambda">;
  assertLock?: typeof assertServerActionLockOwned;
  releaseLock?: typeof releaseServerActionLock;
  renewOperationFence?: typeof renewDurableOperationFence;
  getOperation?: typeof getDurableOperationState;
  persistOperation?: typeof persistDurableOperationStateTransition;
  expireOperation?: typeof expireAcceptedDispatchIfDeadlineElapsed;
  claimOperationLock?: (input: ClaimDurableOperationLockInput) => Promise<ClaimDurableOperationLockResult>;
  finalizeOperationFence?: typeof finalizeDurableOperationFence;
  issueFence?: (input: Omit<BackupFenceAuthorization, "signature">) => Promise<BackupFenceAuthorization>;
  verifyFence?: (authorization: BackupFenceAuthorization) => Promise<boolean>;
  verifyReceipt?: (receipt: BackupTerminalReceipt, authorization?: BackupFenceAuthorization) => Promise<boolean>;
  /** Authoritative session/task/lease check. Operation idempotency is never authority. */
  assertCurrentAuthority?: (input: RuntimeBackupCreateRequest & { runtimeId: string }) => Promise<void>;
  now?: () => Date;
  createOwnerId?: () => string;
  ownerEmail: string;
  configured: boolean;
}

function operationId(input: RuntimeBackupCreateRequest): string {
  const digest = createHash("sha256")
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
    .digest("hex");
  return `backup-agent-${digest.slice(0, 48)}`;
}

function boundResult(input: RuntimeBackupCreateRequest, status: RuntimeBackupResult["status"]): RuntimeBackupResult {
  return {
    schemaVersion: 1,
    status,
    leaseId: input.leaseId,
    leaseGeneration: input.leaseGeneration,
    sessionId: input.sessionId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    invocationDigest: input.invocationDigest,
  };
}

function remoteDispatchWasDefinitelyRejected(error: unknown): boolean {
  return (error as { remoteDispatchRejected?: unknown })?.remoteDispatchRejected === true;
}

function sameAuthorizationBinding(left: BackupFenceAuthorization, right: BackupFenceAuthorization): boolean {
  return (
    left.authorizationId === right.authorizationId &&
    left.runtimeId === right.runtimeId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.invocationId === right.invocationId &&
    left.invocationDigest === right.invocationDigest &&
    left.backupId === right.backupId &&
    left.lifecycleLockId === right.lifecycleLockId &&
    left.lifecycleFencingToken === right.lifecycleFencingToken &&
    left.lifecycleLeaseGeneration === right.lifecycleLeaseGeneration &&
    left.executorKeyId === right.executorKeyId &&
    left.executorKeyEpoch === right.executorKeyEpoch
  );
}

function sameTerminalReceipt(left: BackupTerminalReceipt, right: BackupTerminalReceipt): boolean {
  const { signature: leftSignature, ...leftUnsigned } = left;
  const { signature: rightSignature, ...rightUnsigned } = right;
  return (
    leftSignature === rightSignature &&
    executorReceiptSignedContent(leftUnsigned) === executorReceiptSignedContent(rightUnsigned)
  );
}

function receiptMatchesAuthorization(
  receipt: BackupTerminalReceipt,
  authorization: BackupFenceAuthorization,
  outcome: RuntimeBackupFinalizeRequest["outcome"]
): boolean {
  return (
    receipt.outcome === outcome &&
    receipt.runtimeId === authorization.runtimeId &&
    receipt.leaseId === authorization.leaseId &&
    receipt.leaseGeneration === authorization.leaseGeneration &&
    receipt.sessionId === authorization.sessionId &&
    receipt.taskId === authorization.taskId &&
    receipt.invocationId === authorization.invocationId &&
    receipt.invocationDigest === authorization.invocationDigest &&
    receipt.backupId === authorization.backupId &&
    receipt.lifecycleLockId === authorization.lifecycleLockId &&
    receipt.lifecycleFencingToken === authorization.lifecycleFencingToken &&
    receipt.lifecycleLeaseGeneration === authorization.lifecycleLeaseGeneration &&
    (authorization.executorKeyId === undefined || receipt.executorKeyId === authorization.executorKeyId) &&
    (authorization.executorKeyEpoch === undefined || receipt.executorKeyEpoch === authorization.executorKeyEpoch) &&
    (receipt.fenceIssuedAt === undefined || receipt.fenceIssuedAt === authorization.issuedAt)
  );
}

function operationMatchesAuthorization(
  operation: DurableOperationState,
  authorization: BackupFenceAuthorization
): boolean {
  return (
    operation.id === authorization.backupId &&
    operation.agentRuntimeId === authorization.runtimeId &&
    operation.agentLeaseId === authorization.leaseId &&
    operation.agentLeaseGeneration === authorization.leaseGeneration &&
    operation.agentSessionId === authorization.sessionId &&
    operation.agentTaskId === authorization.taskId &&
    operation.agentInvocationId === authorization.invocationId &&
    operation.agentInvocationDigest === authorization.invocationDigest &&
    operation.lockId === authorization.lifecycleLockId &&
    operation.fencingToken === authorization.lifecycleFencingToken &&
    operation.lockLeaseGeneration === authorization.lifecycleLeaseGeneration
  );
}

function sameOperationBinding(
  operation: DurableOperationState,
  input: RuntimeBackupCreateRequest & { runtimeId: string }
): boolean {
  return (
    operation.type === "backup" &&
    operation.route === RUNTIME_BACKUP_ROUTE &&
    operation.agentRuntimeId === input.runtimeId &&
    operation.agentSessionId === input.sessionId &&
    operation.agentTaskId === input.taskId &&
    operation.agentLeaseId === input.leaseId &&
    operation.agentLeaseGeneration === input.leaseGeneration &&
    operation.agentInvocationId === input.invocationId &&
    operation.agentInvocationDigest === input.invocationDigest
  );
}

export class ProductionRuntimeBackupControlAdapter implements RuntimeBackupControlAdapter {
  private readonly assertLock: typeof assertServerActionLockOwned;
  private readonly releaseLock: typeof releaseServerActionLock;
  private readonly renewOperationFence: typeof renewDurableOperationFence;
  private readonly getOperation: typeof getDurableOperationState;
  private readonly persistOperation: typeof persistDurableOperationStateTransition;
  private readonly expireOperation: typeof expireAcceptedDispatchIfDeadlineElapsed;
  private readonly claimOperationLock: (
    input: ClaimDurableOperationLockInput
  ) => Promise<ClaimDurableOperationLockResult>;
  private readonly issueFence: (
    input: Omit<BackupFenceAuthorization, "signature">
  ) => Promise<BackupFenceAuthorization>;
  private readonly verifyFence: (authorization: BackupFenceAuthorization) => Promise<boolean>;
  private readonly verifyReceipt: (
    receipt: BackupTerminalReceipt,
    authorization?: BackupFenceAuthorization
  ) => Promise<boolean>;
  private readonly finalizeOperationFence: typeof finalizeDurableOperationFence;
  private readonly now: () => Date;
  private readonly createOwnerId: () => string;
  private readonly assertCurrentAuthority?: ProductionRuntimeBackupDependencies["assertCurrentAuthority"];

  constructor(private readonly dependencies: ProductionRuntimeBackupDependencies) {
    this.assertLock = dependencies.assertLock ?? assertServerActionLockOwned;
    this.releaseLock = dependencies.releaseLock ?? releaseServerActionLock;
    this.renewOperationFence = dependencies.renewOperationFence ?? renewDurableOperationFence;
    this.getOperation = dependencies.getOperation ?? getDurableOperationState;
    this.persistOperation = dependencies.persistOperation ?? persistDurableOperationStateTransition;
    this.expireOperation = dependencies.expireOperation ?? expireAcceptedDispatchIfDeadlineElapsed;
    this.claimOperationLock = dependencies.claimOperationLock ?? claimDurableOperationLock;
    this.issueFence = dependencies.issueFence ?? signBackupFenceAuthorization;
    this.verifyFence = dependencies.verifyFence ?? verifyBackupFenceAuthorizationSignature;
    this.verifyReceipt =
      dependencies.verifyReceipt ??
      (async (receipt, authorization) => {
        const configured = process.env.MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS?.trim() ?? "";
        if (!configured) return false;
        return await verifyExecutorTerminalReceipt(
          receipt,
          parseExecutorReceiptVerifierSetJson(configured),
          authorization
        );
      });
    this.finalizeOperationFence = dependencies.finalizeOperationFence ?? finalizeDurableOperationFence;
    this.now = dependencies.now ?? (() => new Date());
    this.createOwnerId = dependencies.createOwnerId ?? randomUUID;
    this.assertCurrentAuthority = dependencies.assertCurrentAuthority;
  }

  async evaluateAvailability(): Promise<"available" | "unavailable"> {
    return this.dependencies.configured ? "available" : "unavailable";
  }

  async verifyTerminalReceipt(receipt: BackupTerminalReceipt): Promise<boolean> {
    return await this.verifyReceipt(receipt);
  }

  async startOrPoll(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    signal?: AbortSignal,
    recheckActive?: () => Promise<boolean>
  ): Promise<RuntimeBackupResult> {
    if (!this.dependencies.configured) return boundResult(input, "unavailable");
    if (signal?.aborted) throw new DOMException("Runtime backup request cancelled", "AbortError");
    await this.assertCurrentAuthority?.(input);
    const id = operationId(input);
    const existing = await this.getOperation(id);
    if (existing) {
      if (
        existing.type !== "backup" ||
        existing.route !== RUNTIME_BACKUP_ROUTE ||
        existing.requestedBy?.toLowerCase() !== this.dependencies.ownerEmail.toLowerCase()
      ) {
        return boundResult(input, "ambiguous");
      }
      if (existing.status === "accepted" && existing.phase === "validating" && !existing.lockId) {
        return await this.start(input, id, signal, recheckActive);
      }
      const expired = await this.expireOperation(id, this.now());
      const operation = expired.operation ?? existing;
      if (expired.shouldReleaseLock) await this.releaseExpiredOperationLock(operation);
      return await this.operationResult(input, operation);
    }
    return await this.start(input, id, signal, recheckActive);
  }

  async recoverExisting(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupResult | null> {
    if (signal?.aborted) throw new DOMException("Runtime backup recovery cancelled", "AbortError");
    await this.assertCurrentAuthority?.(input);
    const id = operationId(input);
    const existing = await this.getOperation(id);
    if (!existing) return null;
    if (!sameOperationBinding(existing, input)) return boundResult(input, "ambiguous");
    const expired = await this.expireOperation(id, this.now());
    const operation = expired.operation ?? existing;
    if (expired.shouldReleaseLock) await this.releaseExpiredOperationLock(operation);
    return await this.operationResult(input, operation);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Finalization intentionally keeps every exact identity and receipt guard at one release boundary.
  async finalize(
    input: RuntimeBackupFinalizeRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupFinalizeResult> {
    if (signal?.aborted) throw new DOMException("Runtime backup finalization cancelled", "AbortError");
    const authorization = input.authorization;
    if (authorization.runtimeId !== input.runtimeId || !(await this.verifyFence(authorization))) {
      throw new Error("Runtime backup fence authorization is invalid");
    }
    if (input.terminalReceipt && !(await this.verifyReceipt(input.terminalReceipt, authorization))) {
      throw new Error("Runtime backup terminal receipt signature or key ID is invalid");
    }
    if (
      operationId({
        schemaVersion: 1,
        action: "create",
        leaseId: authorization.leaseId,
        leaseGeneration: authorization.leaseGeneration,
        sessionId: authorization.sessionId,
        taskId: authorization.taskId,
        invocationId: authorization.invocationId,
        invocationDigest: authorization.invocationDigest,
      }) !== authorization.backupId
    ) {
      throw new Error("Runtime backup fence binding is invalid");
    }
    const operation = await this.getOperation(authorization.backupId);
    const authoritative = operation?.agentFenceAuthorization;
    if (
      operation?.agentEffectReconciliationStatus === "resolved" &&
      authoritative &&
      (await this.verifyFence(authoritative)) &&
      sameAuthorizationBinding(authoritative, authorization) &&
      operation.agentTerminalReceipt &&
      input.terminalReceipt &&
      sameTerminalReceipt(operation.agentTerminalReceipt, input.terminalReceipt) &&
      input.outcome === operation.agentTerminalReceipt.outcome
    ) {
      return {
        schemaVersion: 1,
        authorizationId: authorization.authorizationId,
        status: "finalized",
        released: true,
      };
    }
    if (
      !operation ||
      operation.type !== "backup" ||
      operation.route !== RUNTIME_BACKUP_ROUTE ||
      operation.status !== "completed" ||
      operation.requestedBy?.toLowerCase() !== this.dependencies.ownerEmail.toLowerCase() ||
      !operation.lockId ||
      !Number.isSafeInteger(operation.fencingToken) ||
      operation.fencingToken! < 1 ||
      !Number.isSafeInteger(operation.lockLeaseGeneration) ||
      operation.lockLeaseGeneration! < 1 ||
      operation.agentEffectReconciliationStatus === "resolved" ||
      !authoritative ||
      !(await this.verifyFence(authoritative)) ||
      !operationMatchesAuthorization(operation, authoritative)
    ) {
      throw new Error("Runtime backup fence operation is not finalizable");
    }
    if (
      operation.lockId !== authoritative.lifecycleLockId ||
      operation.fencingToken !== authoritative.lifecycleFencingToken ||
      operation.lockLeaseGeneration !== authoritative.lifecycleLeaseGeneration ||
      !sameAuthorizationBinding(authoritative, authorization)
    ) {
      throw new Error("Runtime backup fence ownership binding is stale");
    }
    const receipt = input.terminalReceipt;
    if (
      input.outcome !== "indeterminate" &&
      (!receipt || !receiptMatchesAuthorization(receipt, authorization, input.outcome))
    ) {
      throw new Error("Runtime backup finalization requires an authoritative terminal executor receipt");
    }
    if (receipt && !receiptMatchesAuthorization(receipt, authorization, input.outcome)) {
      throw new Error("Runtime backup terminal receipt binding is stale");
    }
    if (input.outcome === "indeterminate") {
      return await this.retainIndeterminate(operation, authorization, receipt);
    }
    const released = await this.finalizeExactOperation(operation, receipt as BackupTerminalReceipt);
    return {
      schemaVersion: 1,
      authorizationId: authorization.authorizationId,
      status: Date.parse(authoritative.expiresAt) <= this.now().getTime() ? "expired" : "finalized",
      released,
    };
  }

  private async retainIndeterminate(
    operation: DurableOperationState,
    authorization: BackupFenceAuthorization,
    receipt?: BackupTerminalReceipt
  ): Promise<RuntimeBackupFinalizeResult> {
    await this.persistOperation({
      operationId: operation.id,
      type: "backup",
      route: RUNTIME_BACKUP_ROUTE,
      status: "completed",
      source: "api",
      phase: "terminal",
      agentEffectReconciliationStatus: "needed",
      ...(receipt ? { agentTerminalReceipt: receipt } : {}),
    });
    return {
      schemaVersion: 1,
      authorizationId: authorization.authorizationId,
      status: "reconciliation-needed",
      released: false,
    };
  }

  private async finalizeExactOperation(
    operation: DurableOperationState,
    receipt: BackupTerminalReceipt
  ): Promise<boolean> {
    if (
      this.dependencies.finalizeOperationFence ||
      (!this.dependencies.releaseLock && !this.dependencies.persistOperation)
    ) {
      await this.finalizeOperationFence({
        operation,
        ownerEmail: this.dependencies.ownerEmail,
        receipt,
        timestamp: this.now().toISOString(),
      });
      return true;
    }
    // Test adapters may provide isolated lock/state seams. Production always
    // uses finalizeDurableOperationFence above, which is one conditional DDB
    // transaction over the operation and exact lock generation.
    const released = await this.releaseLock(operation.lockId!, {
      action: "backup",
      ownerEmail: this.dependencies.ownerEmail,
      fencingToken: operation.fencingToken!,
      leaseGeneration: operation.lockLeaseGeneration,
    });
    if (released) {
      await this.persistOperation({
        operationId: operation.id,
        type: "backup",
        route: RUNTIME_BACKUP_ROUTE,
        status: "completed",
        source: "api",
        phase: "terminal",
        agentEffectReconciliationStatus: "resolved",
        agentTerminalReceipt: receipt,
      });
    }
    return released;
  }

  async renew(
    input: RuntimeBackupRenewRequest & { runtimeId: string },
    signal?: AbortSignal
  ): Promise<RuntimeBackupRenewResult> {
    if (signal?.aborted) throw new DOMException("Runtime backup renewal cancelled", "AbortError");
    const authorization = input.authorization;
    await this.assertCurrentAuthority?.({
      schemaVersion: 1,
      action: "create",
      runtimeId: input.runtimeId,
      leaseId: authorization.leaseId,
      leaseGeneration: authorization.leaseGeneration,
      sessionId: authorization.sessionId,
      taskId: authorization.taskId,
      invocationId: authorization.invocationId,
      invocationDigest: authorization.invocationDigest,
    });
    if (authorization.runtimeId !== input.runtimeId || !(await this.verifyFence(authorization))) {
      throw new Error("Runtime backup fence authorization is invalid");
    }
    const operation = await this.getOperation(authorization.backupId);
    if (
      !operation ||
      operation.status !== "completed" ||
      operation.route !== RUNTIME_BACKUP_ROUTE ||
      operation.lockId !== authorization.lifecycleLockId ||
      operation.fencingToken !== authorization.lifecycleFencingToken ||
      operation.agentEffectReconciliationStatus === "resolved" ||
      !Number.isSafeInteger(operation.lockLeaseGeneration) ||
      operation.lockLeaseGeneration! < authorization.lifecycleLeaseGeneration ||
      operationId({
        schemaVersion: 1,
        action: "create",
        leaseId: authorization.leaseId,
        leaseGeneration: authorization.leaseGeneration,
        sessionId: authorization.sessionId,
        taskId: authorization.taskId,
        invocationId: authorization.invocationId,
        invocationDigest: authorization.invocationDigest,
      }) !== authorization.backupId
    ) {
      return {
        schemaVersion: 1,
        authorizationId: authorization.authorizationId,
        status: "lost",
      };
    }
    try {
      const issuedAt = this.now();
      const renewed = await this.renewOperationFence({
        operationId: operation.id,
        ownerEmail: this.dependencies.ownerEmail,
        expectedAuthorization: authorization,
        timestamp: issuedAt.toISOString(),
        createAuthorization: async (lock) =>
          await this.authorizationFor(input.runtimeId, operation, lock, {
            leaseId: authorization.leaseId,
            leaseGeneration: authorization.leaseGeneration,
            sessionId: authorization.sessionId,
            taskId: authorization.taskId,
            invocationId: authorization.invocationId,
            invocationDigest: authorization.invocationDigest,
            issuedAt: issuedAt.toISOString(),
            expiresAt: this.authorizationExpiry(lock, issuedAt),
          }),
      });
      return {
        schemaVersion: 1,
        authorizationId: authorization.authorizationId,
        status: "renewed",
        authorization: renewed.authorization,
      };
    } catch {
      return {
        schemaVersion: 1,
        authorizationId: authorization.authorizationId,
        status: "lost",
      };
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Terminal classification, renewable fencing, and fail-closed reconciliation form one result boundary.
  private async operationResult(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    operation: DurableOperationState
  ): Promise<RuntimeBackupResult> {
    if (!sameOperationBinding(operation, input)) return boundResult(input, "ambiguous");
    if (operation.status === "failed") {
      if (operation.code === "runtime_backup_cancelled") return boundResult(input, "cancelled");
      if (operation.code === "runtime_backup_dispatch_failed" || operation.code === "dispatch_expired") {
        return boundResult(input, "ambiguous");
      }
      return boundResult(input, operation.code === "agent_backup_unavailable" ? "unavailable" : "failed");
    }
    if (operation.status !== "completed") return boundResult(input, "pending");
    if (
      !operation.lockId ||
      !Number.isSafeInteger(operation.fencingToken) ||
      operation.fencingToken! < 1 ||
      operation.requestedBy?.toLowerCase() !== this.dependencies.ownerEmail.toLowerCase()
    ) {
      return boundResult(input, "ambiguous");
    }
    // Re-check immediately before the operation lookup can turn a completed
    // record into a renewed fence. The durable operation is an idempotency
    // record, never proof that this invocation is still authoritative.
    await this.assertCurrentAuthority?.(input);
    const fencingToken = operation.fencingToken as number;
    try {
      await this.assertLock(operation.lockId, fencingToken, "backup", {
        ownerEmail: this.dependencies.ownerEmail,
        operationId: operation.id,
      });
    } catch {
      await this.releaseExpiredOperationLock(operation).catch(() => undefined);
      return boundResult(input, "unavailable");
    }
    const issuedAt = this.now();
    let renewed: Awaited<ReturnType<typeof renewDurableOperationFence>>;
    try {
      renewed = await this.renewOperationFence({
        operationId: operation.id,
        ownerEmail: this.dependencies.ownerEmail,
        expectedAuthorization: operation.agentFenceAuthorization,
        timestamp: issuedAt.toISOString(),
        createAuthorization: async (lock) =>
          await this.authorizationFor(input.runtimeId, operation, lock, {
            leaseId: input.leaseId,
            leaseGeneration: input.leaseGeneration,
            sessionId: input.sessionId,
            taskId: input.taskId,
            invocationId: input.invocationId,
            invocationDigest: input.invocationDigest,
            issuedAt: issuedAt.toISOString(),
            expiresAt: this.authorizationExpiry(lock, issuedAt),
          }),
      });
    } catch {
      return boundResult(input, "unavailable");
    }
    if (!Number.isFinite(issuedAt.getTime()) || issuedAt.getTime() > this.now().getTime() + 30_000) {
      return boundResult(input, "ambiguous");
    }
    return {
      ...boundResult(input, "succeeded"),
      backupId: operation.id,
      createdAt: operation.sideEffectCompletedAt ?? operation.updatedAt,
      fenceAuthorization: renewed.authorization,
    };
  }

  private authorizationExpiry(lock: ServerActionLock, issuedAt: Date): string {
    const expiresAtMs = Math.min(
      issuedAt.getTime() + BACKUP_FENCE_AUTHORIZATION_MS,
      Date.parse(lock.expiresAt) - BACKUP_FENCE_EFFECT_MARGIN_MS
    );
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAt.getTime()) {
      throw new Error("Renewed lifecycle lock has no safe executor authorization horizon");
    }
    return new Date(expiresAtMs).toISOString();
  }

  private async authorizationFor(
    runtimeId: string,
    operation: DurableOperationState,
    lock: ServerActionLock,
    binding: Pick<
      BackupFenceAuthorization,
      | "leaseId"
      | "leaseGeneration"
      | "sessionId"
      | "taskId"
      | "invocationId"
      | "invocationDigest"
      | "issuedAt"
      | "expiresAt"
    >
  ): Promise<BackupFenceAuthorization> {
    return await this.issueFence({
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: `fence-${operation.id.slice(-48)}`,
      runtimeId,
      ...binding,
      backupId: operation.id,
      lifecycleLockId: lock.lockId,
      lifecycleFencingToken: lock.fencingToken,
      lifecycleLeaseGeneration: lock.leaseGeneration ?? 1,
      lifecycleLeaseExpiresAt: lock.expiresAt,
    });
  }

  private async releaseExpiredOperationLock(operation: DurableOperationState): Promise<void> {
    if (
      !operation.lockId ||
      !Number.isSafeInteger(operation.fencingToken) ||
      (operation.fencingToken ?? 0) < 1 ||
      operation.requestedBy?.toLowerCase() !== this.dependencies.ownerEmail.toLowerCase()
    ) {
      throw new Error("Expired runtime backup is missing its fenced lock binding");
    }
    await this.releaseLock(operation.lockId, {
      action: "backup",
      ownerEmail: this.dependencies.ownerEmail,
      fencingToken: operation.fencingToken as number,
      ...(operation.lockLeaseGeneration ? { leaseGeneration: operation.lockLeaseGeneration } : {}),
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Prerequisite checks, atomic ownership, cancellation fencing, and ambiguous dispatch handling must remain ordered.
  private async start(
    input: RuntimeBackupCreateRequest & { runtimeId: string },
    id: string,
    signal?: AbortSignal,
    recheckActive?: () => Promise<boolean>
  ): Promise<RuntimeBackupResult> {
    const ownerId = this.createOwnerId();
    let lock: ServerActionLock | undefined;
    let dispatchStarted = false;
    let instanceId: string | undefined;
    try {
      instanceId = await this.dependencies.provider.findInstanceId();
      if ((await this.dependencies.provider.getInstanceState(instanceId)) !== ServerState.Running) {
        return boundResult(input, "unavailable");
      }
      const serviceStatus = await this.dependencies.provider.getMinecraftServiceStatus(instanceId);
      if (!serviceStatus.serviceActive) return boundResult(input, "unavailable");
      if (signal?.aborted) throw new DOMException("Runtime backup request cancelled", "AbortError");
      const requestedAt = this.now().toISOString();
      const claim = await this.claimOperationLock({
        operationId: id,
        ownerId,
        action: "backup",
        ownerEmail: this.dependencies.ownerEmail,
        type: "backup",
        route: RUNTIME_BACKUP_ROUTE,
        requestedAt,
        requestedBy: this.dependencies.ownerEmail,
        instanceId,
        status: "accepted",
        source: "api",
        phase: "validating",
        requestIdempotencyKey: id,
        agentRuntimeId: input.runtimeId,
        agentSessionId: input.sessionId,
        agentTaskId: input.taskId,
        agentLeaseId: input.leaseId,
        agentLeaseGeneration: input.leaseGeneration,
        agentInvocationId: input.invocationId,
        agentInvocationDigest: input.invocationDigest,
      });
      if (claim.ownership !== "acquired") return await this.operationResult(input, claim.operation);
      lock = claim.lock ?? (await this.assertClaimLock(claim.operation, id));
      await this.assertLock(lock.lockId, lock.fencingToken, "backup", {
        ownerEmail: this.dependencies.ownerEmail,
        operationId: id,
      });
      const activeAfterOwnership = recheckActive ? await recheckActive() : true;
      if (signal?.aborted || !activeAfterOwnership) {
        await this.cancelOwnedOperation(id, instanceId, lock);
        return boundResult(input, "cancelled");
      }
      dispatchStarted = true;
      await this.dependencies.provider.invokeLambda("StartMinecraftServer", {
        invocationType: "api",
        operationRoute: RUNTIME_BACKUP_ROUTE,
        command: "backup",
        instanceId,
        userEmail: this.dependencies.ownerEmail,
        args: [`agent-${id.slice(-16)}`],
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        lockLeaseGeneration: lock.leaseGeneration,
        lockLeaseExpiresAt: lock.expiresAt,
        requireAlreadyRunning: true,
        requireServiceActive: true,
        retainLockForAgentEffect: true,
        agentTwoPhase: true,
        operationId: id,
      });
      await this.persistOperation({
        operationId: id,
        type: "backup",
        status: "accepted",
        source: "api",
        phase: "dispatched",
      });
      const completed = await this.getOperation(id);
      return completed ? await this.operationResult(input, completed) : boundResult(input, "pending");
    } catch (error) {
      if (dispatchStarted && !remoteDispatchWasDefinitelyRejected(error)) return boundResult(input, "pending");
      if (lock) {
        await this.persistOperation({
          operationId: id,
          type: "backup",
          route: RUNTIME_BACKUP_ROUTE,
          requestedBy: this.dependencies.ownerEmail,
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
          lockLeaseGeneration: lock.leaseGeneration,
          lockLeaseExpiresAt: lock.expiresAt,
          instanceId,
          status: "failed",
          source: "api",
          phase: "terminal",
          error: "Runtime backup dispatch failed closed.",
          code: "runtime_backup_dispatch_failed",
        }).catch(() => undefined);
        await this.releaseLock(lock.lockId, {
          action: "backup",
          ownerEmail: this.dependencies.ownerEmail,
          fencingToken: lock.fencingToken,
          leaseGeneration: lock.leaseGeneration,
        }).catch(() => undefined);
      }
      return boundResult(input, signal?.aborted ? "cancelled" : "ambiguous");
    }
  }

  private async assertClaimLock(operation: DurableOperationState, id: string): Promise<ServerActionLock> {
    if (!operation.lockId || !Number.isSafeInteger(operation.fencingToken) || operation.id !== id) {
      throw new Error("Owned runtime backup is missing its atomic lifecycle binding");
    }
    return await this.assertLock(operation.lockId, operation.fencingToken as number, "backup", {
      ownerEmail: this.dependencies.ownerEmail,
      operationId: id,
    });
  }

  private async cancelOwnedOperation(
    id: string,
    instanceId: string | undefined,
    lock: ServerActionLock
  ): Promise<void> {
    await this.persistOperation({
      operationId: id,
      type: "backup",
      route: RUNTIME_BACKUP_ROUTE,
      requestedBy: this.dependencies.ownerEmail,
      lockId: lock.lockId,
      fencingToken: lock.fencingToken,
      lockLeaseGeneration: lock.leaseGeneration,
      lockLeaseExpiresAt: lock.expiresAt,
      instanceId,
      status: "failed",
      source: "api",
      phase: "terminal",
      error: "Runtime backup was cancelled before dispatch.",
      code: "runtime_backup_cancelled",
    });
    await this.releaseLock(lock.lockId, {
      action: "backup",
      ownerEmail: this.dependencies.ownerEmail,
      fencingToken: lock.fencingToken,
      leaseGeneration: lock.leaseGeneration,
    });
  }
}

export class DeterministicRuntimeBackupControlAdapter implements RuntimeBackupControlAdapter {
  constructor(
    private readonly mode: "succeeded" | "failed" | "unavailable" = "succeeded",
    private readonly now: () => Date = () => new Date("2026-01-01T00:00:00.000Z")
  ) {}

  async evaluateAvailability(): Promise<"available" | "unavailable"> {
    return this.mode === "unavailable" ? "unavailable" : "available";
  }

  async verifyTerminalReceipt(_receipt: BackupTerminalReceipt): Promise<boolean> {
    return true;
  }

  async startOrPoll(input: RuntimeBackupCreateRequest & { runtimeId: string }): Promise<RuntimeBackupResult> {
    if (this.mode !== "succeeded") return boundResult(input, this.mode);
    const backupId = operationId(input);
    return {
      ...boundResult(input, "succeeded"),
      backupId,
      createdAt: this.now().toISOString(),
      fenceAuthorization: {
        schemaVersion: 1,
        status: "succeeded",
        authorizationId: `fence-${backupId.slice(-48)}`,
        runtimeId: input.runtimeId,
        leaseId: input.leaseId,
        leaseGeneration: input.leaseGeneration,
        sessionId: input.sessionId,
        taskId: input.taskId,
        invocationId: input.invocationId,
        invocationDigest: input.invocationDigest,
        backupId,
        lifecycleLockId: `lock-${backupId.slice(-48)}`,
        lifecycleFencingToken: 1,
        lifecycleLeaseGeneration: 1,
        lifecycleLeaseExpiresAt: new Date(this.now().getTime() + 90 * 60_000).toISOString(),
        executorKeyId: "executor-receipt-deterministic",
        executorKeyEpoch: 1,
        issuedAt: this.now().toISOString(),
        expiresAt: new Date(this.now().getTime() + BACKUP_FENCE_AUTHORIZATION_MS).toISOString(),
        signature: "A".repeat(86),
      },
    };
  }

  async recoverExisting(): Promise<RuntimeBackupResult | null> {
    return null;
  }

  async renew(input: RuntimeBackupRenewRequest & { runtimeId: string }): Promise<RuntimeBackupRenewResult> {
    if (input.runtimeId !== input.authorization.runtimeId) {
      return { schemaVersion: 1, authorizationId: input.authorization.authorizationId, status: "lost" };
    }
    const authorization = {
      ...input.authorization,
      lifecycleLeaseGeneration: input.authorization.lifecycleLeaseGeneration + 1,
      lifecycleLeaseExpiresAt: new Date(this.now().getTime() + 90 * 60_000).toISOString(),
      issuedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + BACKUP_FENCE_AUTHORIZATION_MS).toISOString(),
      signature: "A".repeat(86),
    };
    return {
      schemaVersion: 1,
      authorizationId: authorization.authorizationId,
      status: "renewed",
      authorization,
    };
  }

  async finalize(input: RuntimeBackupFinalizeRequest & { runtimeId: string }): Promise<RuntimeBackupFinalizeResult> {
    if (
      input.outcome !== "indeterminate" &&
      (!input.terminalReceipt ||
        !receiptMatchesAuthorization(input.terminalReceipt, input.authorization, input.outcome))
    ) {
      throw new Error("Runtime backup finalization requires an authoritative terminal executor receipt");
    }
    if (input.outcome === "indeterminate") {
      return {
        schemaVersion: 1,
        authorizationId: input.authorization.authorizationId,
        status: "reconciliation-needed",
        released: false,
      };
    }
    return {
      schemaVersion: 1,
      authorizationId: input.authorization.authorizationId,
      status: Date.parse(input.authorization.expiresAt) <= this.now().getTime() ? "expired" : "finalized",
      released: true,
    };
  }
}
