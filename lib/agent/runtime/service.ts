import { canonicalJson } from "@/lib/agent/canonical-json";
import type { BackupTerminalReceipt, JsonValue } from "@/lib/agent/contracts";
import type {
  RuntimeApprovalConsumptionRequest,
  RuntimeApprovalPublicationRequest,
  RuntimeBackupCreateRequest,
  RuntimeDecisionPollRequest,
  RuntimeDecisionSnapshot,
  RuntimeEventPublicationRequest,
  RuntimeEventPublicationResult,
  RuntimeInvocationAuthorizationRequest,
  RuntimeInvocationAuthorizationResult,
  RuntimeLeaseMutationRequest,
  RuntimeRecoveryPublicationRequest,
  RuntimeRecoveryPublicationResult,
  RuntimeRenewRequest,
  RuntimeStatusPublicationRequest,
  RuntimeWorkLeaseDto,
  RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime/contracts";
import { projectRuntimeWork } from "@/lib/agent/runtime/contracts";
import {
  type UnsignedTerminalPublicationAuthorization,
  signTerminalPublicationAuthorization,
} from "@/lib/agent/runtime/terminal-publication";
import { type AgentSessionStateStore, AgentStateConflictError } from "@/lib/agent/state";

export interface AgentRuntimeServiceOptions {
  now?: () => Date;
  createId?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  verifyRecoveryReceipt?: (receipt: BackupTerminalReceipt) => Promise<boolean>;
  issueTerminalAcknowledgement?: (
    input: UnsignedTerminalPublicationAuthorization
  ) => Promise<import("@/lib/agent/contracts").TerminalPublicationAuthorization>;
}

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });

export class AgentRuntimeService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly verifyRecoveryReceipt?: AgentRuntimeServiceOptions["verifyRecoveryReceipt"];
  private readonly issueTerminalAcknowledgement: NonNullable<
    AgentRuntimeServiceOptions["issueTerminalAcknowledgement"]
  >;

  constructor(
    private readonly store: AgentSessionStateStore,
    options: AgentRuntimeServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.pause = options.sleep ?? sleep;
    this.verifyRecoveryReceipt = options.verifyRecoveryReceipt;
    this.issueTerminalAcknowledgement = options.issueTerminalAcknowledgement ?? signTerminalPublicationAuthorization;
  }

  async leaseWork(
    runtimeId: string,
    input: RuntimeWorkLeaseRequest,
    signal?: AbortSignal
  ): Promise<RuntimeWorkLeaseDto | null> {
    const deadline = this.now().getTime() + input.waitMs;
    do {
      const assignment = await this.store.leaseNextRuntimeWork({
        runtimeId,
        claimId: input.claimId,
        leaseId: `lease-${this.createId()}`,
        now: this.now().toISOString(),
        leaseDurationMs: input.leaseDurationMs,
      });
      if (assignment) return projectRuntimeWork(assignment);
      if (signal?.aborted || this.now().getTime() >= deadline) return null;
      await this.pause(Math.min(250, Math.max(1, deadline - this.now().getTime())), signal);
    } while (!signal?.aborted);
    return null;
  }

  async acknowledge(runtimeId: string, leaseId: string, input: RuntimeLeaseMutationRequest) {
    return await this.store.acknowledgeRuntimeWork({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
  }

  async renew(runtimeId: string, leaseId: string, input: RuntimeRenewRequest) {
    return await this.store.renewRuntimeWork({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
  }

  async publishEvents(
    runtimeId: string,
    leaseId: string,
    input: RuntimeEventPublicationRequest
  ): Promise<RuntimeEventPublicationResult> {
    const result = await this.store.publishRuntimeEvents({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
    return { schemaVersion: 1, revision: result.state.revision, events: result.events };
  }

  async publishRecovery(
    runtimeId: string,
    leaseId: string,
    input: RuntimeRecoveryPublicationRequest
  ): Promise<RuntimeRecoveryPublicationResult> {
    if (input.runtimeId !== runtimeId || input.leaseId !== leaseId) {
      throw new Error("Runtime recovery publication binding changed");
    }
    if (!this.verifyRecoveryReceipt || !(await this.verifyRecoveryReceipt(input.terminalReceipt))) {
      throw new AgentStateConflictError("Runtime recovery terminal receipt is not authenticated");
    }
    const result = await this.store.publishRuntimeRecovery({ ...input, at: this.now().toISOString() });
    const task = result.state.tasks.find((candidate) => candidate.taskId === input.taskId);
    const recovery = task?.runtimeRecoveries?.find((candidate) => candidate.invocationId === input.invocationId);
    if (!task || !recovery) throw new AgentStateConflictError("Runtime recovery acknowledgement evidence is missing");
    const persistedResultDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalJson(recovery.result as unknown as JsonValue))
        )
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    if (persistedResultDigest !== recovery.persistedResultDigest) {
      throw new AgentStateConflictError("Runtime recovery persisted result evidence is invalid");
    }
    const terminalReceiptDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalJson(recovery.terminalReceipt as unknown as JsonValue))
        )
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
    const acknowledgementAuthorization =
      recovery.outcome === "indeterminate"
        ? undefined
        : await this.issueTerminalAcknowledgement({
            schemaVersion: 1,
            source: "control-plane-terminal-publication",
            runtimeId: recovery.runtimeId,
            sessionId: recovery.sessionId,
            taskId: recovery.taskId,
            leaseId: recovery.leaseId,
            leaseGeneration: recovery.leaseGeneration,
            invocationId: recovery.invocationId,
            invocationDigest: recovery.invocationDigest,
            journalSequence: recovery.journalSequence,
            resultDigest: recovery.resultDigest,
            terminalReceiptDigest,
            outcome: recovery.outcome,
            taskDisposition: recovery.taskDisposition ?? "terminate",
            taskStatus: recovery.taskStatus,
            sessionStatus: recovery.sessionStatus,
            publicationRevision: recovery.publicationRevision,
            publishedAt: recovery.publishedAt,
          });
    return {
      schemaVersion: 1,
      revision: result.state.revision,
      event: result.event,
      ...(acknowledgementAuthorization ? { acknowledgementAuthorization } : {}),
    };
  }

  async publishApproval(runtimeId: string, leaseId: string, input: RuntimeApprovalPublicationRequest) {
    return await this.store.putRuntimeApproval({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
  }

  async consumeApproval(runtimeId: string, leaseId: string, input: RuntimeApprovalConsumptionRequest) {
    return await this.store.consumeRuntimeApproval({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
  }

  async authorizeInvocation(
    runtimeId: string,
    leaseId: string,
    input: RuntimeInvocationAuthorizationRequest
  ): Promise<RuntimeInvocationAuthorizationResult> {
    const result = await this.store.authorizeRuntimeInvocation({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
    return {
      schemaVersion: 1,
      revision: result.state.revision,
      authorization: result.authorization,
    };
  }

  async publishStatus(runtimeId: string, leaseId: string, input: RuntimeStatusPublicationRequest) {
    return await this.store.setRuntimeStatus({
      ...input,
      runtimeId,
      leaseId,
      at: this.now().toISOString(),
    });
  }

  async waitForDecision(
    runtimeId: string,
    leaseId: string,
    input: RuntimeDecisionPollRequest,
    signal?: AbortSignal
  ): Promise<RuntimeDecisionSnapshot> {
    const state = await this.store.waitForRuntimeState(
      {
        runtimeId,
        leaseId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        afterRevision: input.afterRevision,
        timeoutMs: input.waitMs,
      },
      signal
    );
    const task = state.tasks.find((candidate) => candidate.taskId === input.taskId);
    if (!task) throw new Error("Leased task disappeared");
    return {
      schemaVersion: 1,
      revision: state.revision,
      sessionStatus: state.session.status,
      taskStatus: task.status,
      leaseGeneration: task.lease?.generation ?? task.cancellationReconciliation?.generation,
      runtimeEventOrdinal: task.runtimeEventOrdinal ?? 0,
      ...(task.activeRuntimeInvocation
        ? { activeRuntimeInvocation: structuredClone(task.activeRuntimeInvocation) }
        : {}),
      approvals: structuredClone(state.approvals),
      ...(state.cancellation
        ? { cancellation: { schemaVersion: 1 as const, requestedAt: state.cancellation.requestedAt } }
        : {}),
    };
  }

  async assertBackupBinding(runtimeId: string, input: RuntimeBackupCreateRequest): Promise<void> {
    const now = this.now().getTime();
    const state = await this.store.waitForRuntimeState({
      runtimeId,
      leaseId: input.leaseId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      afterRevision: 1,
      timeoutMs: 0,
    });
    const task = state.tasks.find((candidate) => candidate.taskId === input.taskId);
    if (
      !task ||
      task.status === "cancelled" ||
      task.status === "failed" ||
      task.status === "completed" ||
      state.session.status === "cancelled" ||
      state.session.status === "failed" ||
      state.session.status === "completed" ||
      state.cancellation ||
      task.lease?.runtimeId !== runtimeId ||
      task.lease?.generation !== input.leaseGeneration ||
      task.lease?.leaseId !== input.leaseId ||
      !task.lease?.expiresAt ||
      Date.parse(task.lease.expiresAt) <= now
    ) {
      throw new AgentStateConflictError("Runtime backup lease generation is not active.");
    }
    const active = task.activeRuntimeInvocation;
    if (
      !active ||
      active.runtimeId !== runtimeId ||
      active.sessionId !== input.sessionId ||
      active.taskId !== input.taskId ||
      active.leaseId !== input.leaseId ||
      active.leaseGeneration !== input.leaseGeneration ||
      active.invocationId !== input.invocationId ||
      active.invocationDigest !== input.invocationDigest
    ) {
      throw new AgentStateConflictError("Runtime backup invocation is no longer the active invocation.");
    }
    const proposed = state.events.some(
      (event) =>
        event.kind === "tool-proposal" &&
        event.payload.data.invocationId === input.invocationId &&
        event.payload.data.invocationDigest === input.invocationDigest
    );
    const requested = state.events.some(
      (event) =>
        event.kind === "backup" &&
        event.payload.data.invocationId === input.invocationId &&
        event.payload.data.invocationDigest === input.invocationDigest &&
        event.payload.data.status === "requested"
    );
    if (!proposed || !requested) throw new AgentStateConflictError("Runtime backup binding is not active.");
    const revoked = state.approvals.some(
      (approval) =>
        approval.invocationDigest === input.invocationDigest &&
        (approval.decision === "denied" ||
          approval.decision === "cancelled" ||
          approval.decision === "revoked" ||
          (approval.decision === "pending" && Date.parse(approval.expiresAt) <= now))
    );
    if (revoked) throw new AgentStateConflictError("Runtime backup invocation approval is no longer active.");
  }
}
