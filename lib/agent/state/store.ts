import { canonicalJson } from "@/lib/agent/canonical-json";
import {
  AGENT_CAPABILITIES,
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentEvent,
  type InvocationAuthorization,
  type JsonObject,
  type JsonValue,
} from "@/lib/agent/contracts";
import {
  consumeSingleInvocationApproval,
  createInvocationSummaryDigest,
  permissionDecisionForRisk,
} from "@/lib/agent/policy";
import {
  RuntimeWorkResponseSizeError,
  assertEncodedRuntimeWorkLease,
  projectRuntimeWork,
} from "@/lib/agent/runtime/contracts";
import {
  type AddAgentTaskInput,
  type AgentEventReplay,
  type AgentEventWait,
  type AgentRuntimeRecovery,
  type AgentSessionStateStore,
  type AgentSessionStatus,
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateReplayError,
  type AgentStateRepository,
  type AgentStateRetention,
  AgentStateTransitionError,
  type AgentTaskRecord,
  type AgentTaskStatus,
  type AgentWorkLease,
  type AppendAgentEventInput,
  type CreateAgentSessionInput,
  type DurableAgentSessionState,
  type PutAgentApprovalInput,
  type RuntimeAgentEventDraft,
  type RuntimeLeaseMutationInput,
  type RuntimeWorkAssignment,
  type StateMutationResult,
} from "@/lib/agent/state/contracts";
import type { AgentRuntimeWorkClaim, AgentSessionSummaryRecord } from "@/lib/agent/state/repository-metadata";
import {
  AGENT_STATE_MAX_SERIALIZED_BYTES,
  AGENT_STATE_RESERVED_TERMINAL_BYTES,
  deserializeAgentSessionState,
  redactPersistedJson,
  redactReasonForPersistence,
  redactSessionForPersistence,
  redactTaskForPersistence,
  serializeAgentSessionState,
  serializedUtf8Bytes,
} from "@/lib/agent/state/serialization";
import { agentSchemas } from "@/lib/agent/validators";

const DEFAULT_RETENTION: AgentStateRetention = {
  maxEvents: 500,
  maxTasks: 100,
  maxStatusTransitions: 100,
  maxApprovals: 100,
  maxIdempotencyKeys: 500,
  maxSerializedBytes: AGENT_STATE_MAX_SERIALIZED_BYTES,
  reservedTerminalBytes: AGENT_STATE_RESERVED_TERMINAL_BYTES,
};
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 120_000;
const MAX_RUNTIME_EVENT_BATCH = 64;
export const MAX_RUNTIME_WORK_CANDIDATES_PER_POLL = 4;
/** Longer than the maximum executor restart reconciliation plus control publication retry budget. */
const CANCELLATION_RECONCILIATION_MS = 30 * 60_000;
const INVOCATION_AUTHORIZATION_MS = 15 * 60_000;
const MAX_INVOCATION_AUTHORIZATIONS = 64;

const SESSION_TRANSITIONS: Record<AgentSessionStatus, readonly AgentSessionStatus[]> = {
  pending: ["running", "cancelled", "failed"],
  running: ["waiting-approval", "idle", "cancelled", "failed", "completed"],
  "waiting-approval": ["running", "cancelled", "failed"],
  idle: ["pending", "cancelled", "failed"],
  cancelled: [],
  failed: [],
  completed: [],
};

const TASK_TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  pending: ["running", "cancelled", "failed"],
  running: ["waiting-approval", "cancelled", "failed", "completed"],
  "waiting-approval": ["running", "cancelled", "failed"],
  cancelled: [],
  failed: [],
  completed: [],
};
const TERMINAL_SESSION_STATUSES = new Set<AgentSessionStatus>(["cancelled", "failed", "completed"]);
const TERMINAL_TASK_STATUSES = new Set<AgentTaskStatus>(["cancelled", "failed", "completed"]);
const COMPACTED_TURN_CONTENT_BYTES = 16_000;
const REPLAYABLE_EVENT_KINDS = new Set(["model", "reasoning-summary", "tool-progress"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fingerprint(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runtimeIdempotencyKey(taskId: string, generation: number, key: string): Promise<string> {
  const task = (await fingerprint(taskId)).slice(0, 32);
  const prefix = `runtime:${task}:${generation}:`;
  if (key.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(key.slice(prefix.length))) return key;
  return `${prefix}${await fingerprint(key)}`;
}

function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function assertTimestamp(value: string, name: string): void {
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} must be a valid ISO timestamp`);
}

function isWaitingRuntimeResult(result: import("@/lib/agent/contracts").ToolResult): boolean {
  const output = result.output;
  return (
    result.status === "failed" &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    (output.code === "approval-required" ||
      output.code === "backup-required" ||
      output.code === "invocation-authorization-required")
  );
}

function assertTransition<T extends string>(kind: string, current: T, next: T, legal: Record<T, readonly T[]>): void {
  if (current === next || !legal[current].includes(next)) {
    throw new AgentStateTransitionError(`Illegal ${kind} transition from ${current} to ${next}`);
  }
}

function parseCursor(sessionId: string, cursor?: string): number {
  if (cursor === undefined) return 0;
  const prefix = `${sessionId}:`;
  if (!cursor.startsWith(prefix)) throw new AgentStateReplayError("Replay cursor belongs to another session");
  const sequence = Number(cursor.slice(prefix.length));
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AgentStateReplayError("Replay cursor is malformed");
  return sequence;
}

function assertSessionActive(state: DurableAgentSessionState, operation: string): void {
  if (TERMINAL_SESSION_STATUSES.has(state.session.status)) {
    throw new AgentStateTransitionError(`${operation} is not allowed after session ${state.session.status}`);
  }
}

function deactivateApprovals(state: DurableAgentSessionState, at: string, reason: string): void {
  for (const approval of state.approvals) {
    if (approval.decision === "pending") {
      approval.decision = "cancelled";
    } else if (approval.decision === "approved" && approval.scope.kind === "session-capability") {
      approval.decision = "revoked";
    } else if (approval.decision === "approved" && approval.consumedAt === undefined) {
      approval.decision = "cancelled";
    } else {
      continue;
    }
    approval.reason = reason;
    approval.decidedAt = at;
  }
}

function trackRuntimeInvocation(
  task: AgentTaskRecord,
  draft: RuntimeAgentEventDraft,
  binding: Pick<RuntimeLeaseMutationInput, "runtimeId" | "sessionId" | "taskId" | "leaseId"> & {
    leaseGeneration: number;
  }
): void {
  if (draft.kind === "tool-result") {
    if (!task.activeRuntimeInvocation || draft.payload.invocationId !== task.activeRuntimeInvocation.invocationId) {
      throw new AgentStateConflictError("Runtime tool result does not match its task-scoped in-flight invocation");
    }
    task.activeRuntimeInvocation = undefined;
    return;
  }
  if (draft.kind !== "tool-proposal") return;
  const invocationId = draft.payload.invocationId;
  const invocationDigest = draft.payload.invocationDigest;
  const capability = draft.payload.capability;
  const targetScope = draft.payload.targetScope;
  if (
    typeof invocationId !== "string" ||
    !RUNTIME_ID.test(invocationId) ||
    typeof invocationDigest !== "string" ||
    !SHA256.test(invocationDigest) ||
    typeof capability !== "string" ||
    !AGENT_CAPABILITIES.includes(capability as (typeof AGENT_CAPABILITIES)[number])
  )
    throw new AgentStateConflictError("Runtime tool proposal requires an exact invocation ID and digest");
  let parsedTargetScope: import("@/lib/agent/contracts").TargetScope;
  try {
    parsedTargetScope = agentSchemas.targetScope.parse(targetScope);
  } catch {
    throw new AgentStateConflictError("Runtime tool proposal requires an exact target scope");
  }
  if (
    task.activeRuntimeInvocation &&
    (task.activeRuntimeInvocation.invocationId !== invocationId ||
      task.activeRuntimeInvocation.invocationDigest !== invocationDigest ||
      task.activeRuntimeInvocation.capability !== capability ||
      task.activeRuntimeInvocation.targetScope.schemaVersion !== parsedTargetScope.schemaVersion ||
      task.activeRuntimeInvocation.targetScope.kind !== parsedTargetScope.kind ||
      task.activeRuntimeInvocation.targetScope.normalizedTarget !== parsedTargetScope.normalizedTarget)
  ) {
    throw new AgentStateConflictError("Runtime attempted more than one in-flight invocation");
  }
  task.activeRuntimeInvocation = {
    schemaVersion: 1,
    runtimeId: binding.runtimeId,
    sessionId: binding.sessionId,
    taskId: binding.taskId,
    leaseId: binding.leaseId,
    leaseGeneration: binding.leaseGeneration,
    invocationId,
    invocationDigest,
    capability: capability as import("@/lib/agent/contracts").AgentCapability,
    targetScope: clone(parsedTargetScope),
    proposalOrdinal: draft.ordinal,
  };
}

export class RepositoryAgentSessionStore implements AgentSessionStateStore {
  private readonly retention: AgentStateRetention;

  constructor(
    private readonly repository: AgentStateRepository,
    retention: Partial<AgentStateRetention> = {}
  ) {
    this.retention = { ...DEFAULT_RETENTION, ...retention };
    for (const [name, value] of Object.entries(this.retention)) assertLimit(name, value);
    if (this.retention.reservedTerminalBytes >= this.retention.maxSerializedBytes) {
      throw new Error("reservedTerminalBytes must be smaller than maxSerializedBytes");
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Aggregate create validates and safely resumes one atomic identity.
  async createSession(input: CreateAgentSessionInput): Promise<StateMutationResult> {
    const session = redactSessionForPersistence(agentSchemas.agentSession.parse(input.session));
    const policySnapshot = agentSchemas.permissionPolicy.parse(input.policySnapshot);
    const initialTask = input.initialTask ? redactTaskForPersistence(input.initialTask) : undefined;
    const initialTurn = input.initialTurn
      ? {
          ...agentSchemas.agentTurn.parse(input.initialTurn),
          content: redactReasonForPersistence(input.initialTurn.content),
        }
      : undefined;
    if (policySnapshot.policyId !== session.policyId || policySnapshot.revision !== session.policyRevision) {
      throw new AgentStateConflictError("Session policy snapshot does not match its policy reference");
    }
    if (input.requestFingerprint !== undefined && !SHA256.test(input.requestFingerprint)) {
      throw new AgentStateConflictError("Create request fingerprint is invalid");
    }
    const operationFingerprint =
      input.requestFingerprint ??
      (await fingerprint({
        session,
        policySnapshot,
        initialTask: initialTask ?? null,
        initialTurn: initialTurn ?? null,
      } as unknown as JsonValue));
    if (initialTask) {
      if (
        initialTask.sessionId !== session.sessionId ||
        initialTask.status !== "pending" ||
        initialTask.lease ||
        initialTask.cancellationReconciliation
      ) {
        throw new AgentStateConflictError("Initial task must be pending, unleased, and belong to its session");
      }
    }
    const existing = await this.load(session.sessionId);
    if (existing) {
      const prior = input.idempotencyKey
        ? existing.idempotency.find((entry) => entry.key === input.idempotencyKey)
        : undefined;
      if (prior?.operation === "create-session" && prior.fingerprint === operationFingerprint) {
        return await this.resumeInitialAggregate(existing, input, initialTask, initialTurn);
      }
      throw new AgentStateConflictError(`Agent session ${session.sessionId} already exists`);
    }
    const state: DurableAgentSessionState = {
      schemaVersion: AGENT_SCHEMA_VERSION,
      revision: 1,
      session,
      policySnapshot,
      statusHistory: [
        {
          schemaVersion: AGENT_SCHEMA_VERSION,
          from: null,
          to: session.status,
          at: session.createdAt,
          reason: "session created",
        },
      ],
      tasks: initialTask ? [initialTask] : [],
      approvals: [],
      events: [],
      nextEventSequence: 1,
      retainedFromSequence: 1,
      idempotency: input.idempotencyKey
        ? [this.idempotencyRecord(input.idempotencyKey, "create-session", operationFingerprint, session.createdAt)]
        : [],
    };
    if (initialTurn) {
      state.session.turns.push(initialTurn);
    }
    const serialized = this.serializeWithinBudget(state, "standard");
    try {
      await this.repository.create(session.sessionId, serialized);
    } catch (error) {
      if (!(error instanceof AgentStateConflictError)) throw error;
      const raced = await this.load(session.sessionId);
      const prior = raced?.idempotency.find((entry) => entry.key === input.idempotencyKey);
      if (!raced || prior?.operation !== "create-session" || prior.fingerprint !== operationFingerprint) throw error;
      return await this.resumeInitialAggregate(raced, input, initialTask, initialTurn);
    }
    return { state: clone(state), idempotent: false };
  }

  async getSession(sessionId: string): Promise<DurableAgentSessionState | null> {
    const state = await this.load(sessionId);
    return state ? clone(state) : null;
  }

  async listSessions(limit = 100): Promise<DurableAgentSessionState[]> {
    assertLimit("limit", limit);
    const records = await this.repository.list(limit);
    return records
      .map((record) => {
        const state = deserializeAgentSessionState(record.value);
        if (state.revision !== record.revision) {
          throw new AgentStateConflictError("Repository and payload revisions differ");
        }
        return state;
      })
      .sort(
        (left, right) =>
          right.session.updatedAt.localeCompare(left.session.updatedAt) ||
          left.session.sessionId.localeCompare(right.session.sessionId)
      )
      .map(clone);
  }

  async listSessionSummaries(limit = 100, actorId?: string): Promise<AgentSessionSummaryRecord[]> {
    assertLimit("limit", limit);
    return (await this.repository.listSummaries(limit, actorId)).map(clone);
  }

  async resumeSession(sessionId: string): Promise<DurableAgentSessionState | null> {
    return await this.getSession(sessionId);
  }

  async transitionSession(input: {
    sessionId: string;
    expectedRevision: number;
    idempotencyKey: string;
    status: AgentSessionStatus;
    at: string;
    reason: string;
  }): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.mutate(
      input,
      "transition-session",
      { status: input.status, at: input.at, reason: input.reason },
      (state) => {
        assertTransition("session", state.session.status, input.status, SESSION_TRANSITIONS);
        if (input.status === "completed" && state.tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
          throw new AgentStateTransitionError("A session cannot complete while tasks are active");
        }
        const reason = redactReasonForPersistence(input.reason);
        if (input.status === "failed") {
          for (const task of state.tasks) {
            if (!TERMINAL_TASK_STATUSES.has(task.status)) {
              task.status = "failed";
              task.updatedAt = input.at;
            }
            task.lease = undefined;
          }
        }
        if (input.status === "failed" || input.status === "completed") {
          deactivateApprovals(state, input.at, reason);
        }
        state.statusHistory.push({
          schemaVersion: AGENT_SCHEMA_VERSION,
          from: state.session.status,
          to: input.status,
          at: input.at,
          reason,
        });
        state.statusHistory = state.statusHistory.slice(-this.retention.maxStatusTransitions);
        state.session = { ...state.session, status: input.status, updatedAt: input.at };
      },
      TERMINAL_SESSION_STATUSES.has(input.status) ? "terminal" : "standard"
    );
  }

  async appendEvent(input: AppendAgentEventInput): Promise<StateMutationResult & { event: AgentEvent }> {
    const payload = redactPersistedJson(input.payload);
    assertTimestamp(input.timestamp, "timestamp");
    const eventFingerprint = await fingerprint({
      eventId: input.eventId,
      timestamp: input.timestamp,
      kind: input.kind,
      payload,
    });
    const current = await this.required(input.sessionId);
    const duplicate = current.events.find((event) => event.eventId === input.eventId);
    if (duplicate) {
      const existingFingerprint = await fingerprint({
        eventId: duplicate.eventId,
        timestamp: duplicate.timestamp,
        kind: duplicate.kind,
        payload: duplicate.payload.data,
      });
      if (existingFingerprint !== eventFingerprint)
        throw new AgentStateConflictError("Event ID was reused with new content");
      const reusedKey = current.idempotency.find((entry) => entry.key === input.idempotencyKey);
      if (
        reusedKey &&
        (reusedKey.operation !== `append-event:${input.eventId}` || reusedKey.fingerprint !== eventFingerprint)
      ) {
        throw new AgentStateConflictError(`Idempotency key ${input.idempotencyKey} was reused for another mutation`);
      }
      return { state: clone(current), event: clone(duplicate), idempotent: true };
    }
    const result = await this.mutateWithFingerprint(
      input,
      `append-event:${input.eventId}`,
      eventFingerprint,
      (state) => {
        assertSessionActive(state, "Appending events");
        const sequence = state.nextEventSequence;
        const event = agentSchemas.agentEvent.parse({
          schemaVersion: AGENT_SCHEMA_VERSION,
          eventId: input.eventId,
          sessionId: input.sessionId,
          sequence,
          timestamp: input.timestamp,
          kind: input.kind,
          payload: { schemaVersion: AGENT_SCHEMA_VERSION, redacted: true, data: payload },
          replayCursor: `${input.sessionId}:${sequence}`,
        });
        state.events.push(event);
        state.nextEventSequence++;
        this.compactEvents(state);
      }
    );
    const event = result.state.events.find((candidate) => candidate.eventId === input.eventId);
    if (!event) throw new AgentStateConflictError("Idempotent event result is outside the retention window");
    return { ...result, event: clone(event) };
  }

  async replayEvents(
    sessionId: string,
    afterCursor?: string,
    limit = this.retention.maxEvents
  ): Promise<AgentEventReplay> {
    assertLimit("limit", limit);
    const state = await this.required(sessionId);
    const afterSequence = parseCursor(sessionId, afterCursor);
    if (afterSequence >= state.nextEventSequence)
      throw new AgentStateReplayError("Replay cursor is ahead of the event stream");
    const truncated = afterSequence + 1 < state.retainedFromSequence;
    const events = state.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
    const cursor = events.at(-1)?.replayCursor ?? afterCursor ?? `${sessionId}:0`;
    return { events: clone(events), cursor, retainedFromSequence: state.retainedFromSequence, truncated };
  }

  async waitForEvents(
    sessionId: string,
    afterCursor: string | undefined,
    limit: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AgentEventWait> {
    assertLimit("limit", limit);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new Error("timeoutMs must be an integer between 0 and 30000");
    }
    let state = await this.required(sessionId);
    let replay = await this.replayEvents(sessionId, afterCursor, limit);
    const terminal = TERMINAL_SESSION_STATUSES.has(state.session.status);
    if (replay.events.length > 0 || replay.truncated || terminal || timeoutMs === 0 || signal?.aborted) {
      return { ...replay, timedOut: replay.events.length === 0 && !terminal, terminal };
    }

    const wait = await this.repository.waitForRevision(sessionId, state.revision, timeoutMs, signal);
    if (wait.changed) {
      state = await this.required(sessionId);
      replay = await this.replayEvents(sessionId, afterCursor, limit);
    }
    return {
      ...replay,
      timedOut: !wait.changed,
      terminal: TERMINAL_SESSION_STATUSES.has(state.session.status),
    };
  }

  async addTask(input: AddAgentTaskInput): Promise<StateMutationResult> {
    const task = redactTaskForPersistence(input.task);
    return await this.mutate(
      input,
      `add-task:${task.taskId}`,
      { task, turn: input.turn ?? null } as unknown as JsonValue,
      (state) => {
        assertSessionActive(state, "Adding tasks");
        if (task.sessionId !== input.sessionId) throw new AgentStateConflictError("Task belongs to another session");
        if (state.tasks.some((candidate) => candidate.taskId === task.taskId)) {
          throw new AgentStateConflictError(`Task ${task.taskId} already exists`);
        }
        // Serialization performs the strict task schema validation before CAS.
        state.tasks.push(task);
        this.compactTasks(state);
        if (input.turn) {
          const turn = agentSchemas.agentTurn.parse(input.turn);
          state.session.turns.push({ ...turn, content: redactReasonForPersistence(turn.content) });
          this.compactTurns(state);
        }
        if (input.harness) {
          state.session.harness = agentSchemas.harnessMetadata.parse(input.harness);
        }
        if (state.session.status === "idle") {
          this.transitionSessionState(state, "pending", task.updatedAt, "user continued the session");
        }
        state.session.updatedAt = task.updatedAt;
      }
    );
  }

  async transitionTask(input: {
    sessionId: string;
    taskId: string;
    expectedRevision: number;
    idempotencyKey: string;
    status: AgentTaskStatus;
    at: string;
  }): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.mutate(
      input,
      `transition-task:${input.taskId}`,
      { status: input.status, at: input.at },
      (state) => {
        assertSessionActive(state, "Transitioning tasks");
        const task = state.tasks.find((candidate) => candidate.taskId === input.taskId);
        if (!task) throw new AgentStateNotFoundError(`task:${input.taskId}`);
        assertTransition("task", task.status, input.status, TASK_TRANSITIONS);
        task.status = input.status;
        task.updatedAt = input.at;
        state.session.updatedAt = input.at;
      }
    );
  }

  async putApproval(input: PutAgentApprovalInput): Promise<StateMutationResult> {
    const approval = agentSchemas.agentApproval.parse({
      ...input.approval,
      reason: redactReasonForPersistence(input.approval.reason),
      invocationSummary: {
        ...input.approval.invocationSummary,
        sanitizedArguments: redactPersistedJson(input.approval.invocationSummary.sanitizedArguments),
        ...(input.approval.invocationSummary.diffSummary
          ? { diffSummary: redactReasonForPersistence(input.approval.invocationSummary.diffSummary) }
          : {}),
      },
    });
    if ((await createInvocationSummaryDigest(approval.invocationSummary)) !== approval.invocationSummaryDigest) {
      throw new AgentStateConflictError("Approval invocation summary digest is invalid");
    }
    return await this.mutate(
      input,
      `put-approval:${approval.approvalId}`,
      approval as unknown as JsonValue,
      (state) => {
        assertSessionActive(state, "Adding approvals");
        if (approval.sessionId !== input.sessionId)
          throw new AgentStateConflictError("Approval belongs to another session");
        if (approval.actorId !== state.session.actorId)
          throw new AgentStateConflictError("Approval actor does not match the session actor");
        if (approval.policyId !== state.session.policyId || approval.policyRevision !== state.session.policyRevision)
          throw new AgentStateConflictError("Approval policy does not match the session policy");
        if (state.approvals.some((candidate) => candidate.approvalId === approval.approvalId)) {
          throw new AgentStateConflictError(`Approval ${approval.approvalId} already exists`);
        }
        state.approvals.push(approval);
        this.compactApprovals(state);
      }
    );
  }

  async decideApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    decision: "approved" | "denied" | "cancelled";
    reason: string;
    at: string;
  }): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.mutate(
      input,
      `decide-approval:${input.approvalId}`,
      { decision: input.decision, reason: input.reason },
      (state) => {
        assertSessionActive(state, "Deciding approvals");
        const approval = this.approval(state, input.approvalId);
        if (approval.decision !== "pending")
          throw new AgentStateTransitionError("Only pending approvals can be decided");
        approval.decision = input.decision;
        approval.reason = redactReasonForPersistence(input.reason);
        approval.decidedAt = input.at;
        if (input.decision === "approved" && Date.parse(input.at) >= Date.parse(approval.expiresAt)) {
          throw new AgentStateTransitionError("Expired approvals cannot be approved");
        }
        state.session.updatedAt = input.at;
      }
    );
  }

  async consumeApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    invocationDigest: string;
    at: string;
  }): Promise<StateMutationResult> {
    return await this.mutate(
      input,
      `consume-approval:${input.approvalId}`,
      { invocationDigest: input.invocationDigest, at: input.at },
      (state) => {
        assertSessionActive(state, "Consuming approvals");
        const index = state.approvals.findIndex((candidate) => candidate.approvalId === input.approvalId);
        if (index < 0) throw new AgentStateNotFoundError(`approval:${input.approvalId}`);
        state.approvals[index] = consumeSingleInvocationApproval(
          state.approvals[index],
          input.sessionId,
          input.invocationDigest,
          input.at
        );
        state.session.updatedAt = input.at;
      }
    );
  }

  async revokeApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    reason: string;
    at: string;
  }): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.mutate(input, `revoke-approval:${input.approvalId}`, { reason: input.reason }, (state) => {
      assertSessionActive(state, "Revoking approvals");
      const approval = this.approval(state, input.approvalId);
      if (approval.scope.kind !== "session-capability")
        throw new AgentStateTransitionError("Only session-capability approvals can be revoked");
      if (approval.decision !== "approved")
        throw new AgentStateTransitionError("Only approved approvals can be revoked");
      approval.decision = "revoked";
      approval.reason = redactReasonForPersistence(input.reason);
      approval.decidedAt = input.at;
      state.session.updatedAt = input.at;
    });
  }

  async cancelSession(input: {
    sessionId: string;
    expectedRevision: number;
    idempotencyKey: string;
    requestedAt: string;
    requestedBy: string;
    reason: string;
  }): Promise<StateMutationResult> {
    assertTimestamp(input.requestedAt, "requestedAt");
    return await this.mutate(
      input,
      "cancel-session",
      { requestedBy: input.requestedBy, reason: input.reason },
      (state) => {
        assertTransition("session", state.session.status, "cancelled", SESSION_TRANSITIONS);
        const reason = redactReasonForPersistence(input.reason);
        const cancellationSequence = state.nextEventSequence++;
        state.events.push(
          agentSchemas.agentEvent.parse({
            schemaVersion: AGENT_SCHEMA_VERSION,
            eventId: `cancellation-${state.revision + 1}`,
            sessionId: input.sessionId,
            sequence: cancellationSequence,
            timestamp: input.requestedAt,
            kind: "cancellation",
            payload: {
              schemaVersion: AGENT_SCHEMA_VERSION,
              redacted: true,
              data: { requestedAt: input.requestedAt },
            },
            replayCursor: `${input.sessionId}:${cancellationSequence}`,
          })
        );
        this.compactEvents(state);
        state.cancellation = {
          schemaVersion: AGENT_SCHEMA_VERSION,
          requestedAt: input.requestedAt,
          requestedBy: input.requestedBy,
          reason,
        };
        state.statusHistory.push({
          schemaVersion: AGENT_SCHEMA_VERSION,
          from: state.session.status,
          to: "cancelled",
          at: input.requestedAt,
          reason,
        });
        state.statusHistory = state.statusHistory.slice(-this.retention.maxStatusTransitions);
        state.session = { ...state.session, status: "cancelled", updatedAt: input.requestedAt };
        for (const task of state.tasks) {
          const lease = task.lease;
          const activeInvocation = task.activeRuntimeInvocation;
          if (lease?.acknowledgedAt && activeInvocation) {
            task.cancellationReconciliation = {
              schemaVersion: 1,
              leaseId: lease.leaseId,
              runtimeId: lease.runtimeId,
              generation: lease.generation,
              invocationId: activeInvocation.invocationId,
              invocationDigest: activeInvocation.invocationDigest,
              nextOrdinal: (task.runtimeEventOrdinal ?? 0) + 1,
              expiresAt: new Date(Date.parse(input.requestedAt) + CANCELLATION_RECONCILIATION_MS).toISOString(),
            };
          }
          if (!["cancelled", "failed", "completed"].includes(task.status)) {
            task.status = "cancelled";
            task.updatedAt = input.requestedAt;
          }
          task.lease = undefined;
        }
        deactivateApprovals(state, input.requestedAt, reason);
      },
      "terminal"
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Lease selection and acknowledged-expiry reconciliation share one fenced flow.
  async leaseNextRuntimeWork(input: {
    runtimeId: string;
    claimId: string;
    leaseId: string;
    now: string;
    leaseDurationMs: number;
  }): Promise<RuntimeWorkAssignment | null> {
    assertTimestamp(input.now, "now");
    this.assertRuntimeId(input.runtimeId, "runtimeId");
    this.assertRuntimeId(input.claimId, "claimId");
    this.assertRuntimeId(input.leaseId, "leaseId");
    this.assertLeaseDuration(input.leaseDurationMs);
    const now = Date.parse(input.now);
    for (let attempt = 0; attempt < MAX_RUNTIME_WORK_CANDIDATES_PER_POLL * 2; attempt++) {
      const claim = await this.repository.claimRuntimeWorkCandidate({
        runtimeId: input.runtimeId,
        claimId: input.claimId,
        now: input.now,
        limit: 1,
        claimDurationMs: input.leaseDurationMs,
      });
      if (!claim) return null;
      const sessionId = claim.sessionId;
      const state = await this.load(sessionId);
      if (!state) {
        await this.repository.releaseRuntimeWorkClaim(claim);
        continue;
      }
      const existing = state.tasks.find(
        (task) =>
          task.lease?.runtimeId === input.runtimeId &&
          task.lease.claimId === input.claimId &&
          Date.parse(task.lease.expiresAt) > now
      );
      if (existing?.lease) {
        const assignment = this.assignment(state, existing, existing.lease);
        try {
          assertEncodedRuntimeWorkLease(projectRuntimeWork(assignment));
          return assignment;
        } catch (error) {
          if (error instanceof RuntimeWorkResponseSizeError) {
            await this.repository.quarantineWorkCandidate({
              sessionId,
              revision: state.revision,
              reason: "runtime-response-over-budget",
            });
            await this.repository.releaseRuntimeWorkClaim(claim);
            continue;
          }
          throw error;
        }
      }
      if (TERMINAL_SESSION_STATUSES.has(state.session.status)) {
        await this.repository.releaseRuntimeWorkClaim(claim);
        continue;
      }
      if (state.revision !== claim.revision || claim.taskId === "") {
        await this.repository.releaseRuntimeWorkClaim(claim);
        continue;
      }
      const abandoned = state.tasks.find(
        (candidate) =>
          !TERMINAL_TASK_STATUSES.has(candidate.status) &&
          candidate.lease !== undefined &&
          Date.parse(candidate.lease.expiresAt) <= now &&
          (candidate.status !== "pending" || candidate.lease.acknowledgedAt !== undefined)
      );
      if (abandoned?.lease) {
        try {
          await this.reconcileExpiredAcknowledgedWork(state, abandoned, input.now);
        } catch (error) {
          if (!(error instanceof AgentStateConflictError)) throw error;
        }
        await this.repository.releaseRuntimeWorkClaim(claim);
        continue;
      }
      const task = state.tasks.find((candidate) => {
        if (candidate.status !== "pending" || candidate.lease?.acknowledgedAt !== undefined) return false;
        return candidate.lease === undefined || Date.parse(candidate.lease.expiresAt) <= now;
      });
      if (!task || task.taskId !== claim.taskId) {
        await this.repository.releaseRuntimeWorkClaim(claim);
        continue;
      }
      const generation = (task.lease?.generation ?? 0) + 1;
      const lease: AgentWorkLease = {
        schemaVersion: AGENT_SCHEMA_VERSION,
        leaseId: input.leaseId,
        claimId: input.claimId,
        runtimeId: input.runtimeId,
        generation,
        acquiredAt: input.now,
        expiresAt: new Date(now + input.leaseDurationMs).toISOString(),
      };
      // Validate the exact bounded response before the lease enters durable CAS.
      const candidateAssignment = this.assignment(
        { ...state, revision: state.revision + 1, session: { ...state.session, updatedAt: input.now } },
        { ...task, lease, updatedAt: input.now },
        lease
      );
      try {
        assertEncodedRuntimeWorkLease(projectRuntimeWork(candidateAssignment));
      } catch (error) {
        // One poison/legacy candidate must not prevent other bounded candidates from leasing.
        if (error instanceof RuntimeWorkResponseSizeError) {
          await this.repository.quarantineWorkCandidate({
            sessionId,
            revision: state.revision,
            reason: "runtime-response-over-budget",
          });
          await this.repository.releaseRuntimeWorkClaim(claim);
          continue;
        }
        throw error;
      }
      try {
        const result = await this.mutate(
          {
            sessionId: state.session.sessionId,
            expectedRevision: state.revision,
            idempotencyKey: await runtimeIdempotencyKey(task.taskId, generation, `lease:${input.claimId}`),
          },
          `runtime-lease:${task.taskId}`,
          lease as unknown as JsonValue,
          (next) => {
            const currentTask = this.task(next, task.taskId);
            if (
              TERMINAL_TASK_STATUSES.has(currentTask.status) ||
              (currentTask.lease !== undefined && Date.parse(currentTask.lease.expiresAt) > now)
            ) {
              throw new AgentStateConflictError("Runtime work is already leased");
            }
            currentTask.lease = lease;
            currentTask.updatedAt = input.now;
            next.session.updatedAt = input.now;
          },
          "standard",
          claim
        );
        const leasedTask = this.task(result.state, task.taskId);
        const assignment = this.assignment(result.state, leasedTask, leasedTask.lease as AgentWorkLease);
        assertEncodedRuntimeWorkLease(projectRuntimeWork(assignment));
        return assignment;
      } catch (error) {
        if (error instanceof AgentStateConflictError) continue;
        throw error;
      }
    }
    return null;
  }

  async acknowledgeRuntimeWork(input: RuntimeLeaseMutationInput & { at: string }): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.runtimeMutate(input, "ack", {}, input.at, (state, task) => {
      if (task.status !== "pending" || state.session.status !== "pending") {
        throw new AgentStateTransitionError("Only pending runtime work can be acknowledged");
      }
      task.status = "running";
      task.updatedAt = input.at;
      task.lease = { ...(task.lease as AgentWorkLease), acknowledgedAt: input.at };
      this.transitionSessionState(state, "running", input.at, "runtime acknowledged work");
    });
  }

  async renewRuntimeWork(
    input: RuntimeLeaseMutationInput & { at: string; leaseDurationMs: number }
  ): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    this.assertLeaseDuration(input.leaseDurationMs);
    const observed = await this.required(input.sessionId);
    const prior = await this.runtimeIdempotencyRecord(observed, input.taskId, "renew", input.idempotencyKey);
    if (prior) {
      return await this.runtimeMutate(input, "renew", { leaseDurationMs: input.leaseDurationMs }, input.at, () => {
        throw new AgentStateConflictError("Idempotent runtime renewal unexpectedly attempted a second mutation");
      });
    }
    const observedTask = this.assertActiveLease(observed, input, input.at);
    const expiresAt = new Date(Date.parse(input.at) + input.leaseDurationMs).toISOString();
    await this.repository.renewRuntimeWorkClaim({
      runtimeId: input.runtimeId,
      claimId: (observedTask.lease as AgentWorkLease).claimId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      now: input.at,
      expiresAt,
    });
    return await this.runtimeMutate(
      input,
      "renew",
      { leaseDurationMs: input.leaseDurationMs },
      input.at,
      (state, task) => {
        task.lease = {
          ...(task.lease as AgentWorkLease),
          expiresAt,
        };
        task.updatedAt = input.at;
        state.session.updatedAt = input.at;
      }
    );
  }

  async publishRuntimeEvents(
    input: RuntimeLeaseMutationInput & { at: string; drafts: RuntimeAgentEventDraft[] }
  ): Promise<StateMutationResult & { events: AgentEvent[] }> {
    assertTimestamp(input.at, "at");
    if (input.drafts.length < 1 || input.drafts.length > MAX_RUNTIME_EVENT_BATCH) {
      throw new AgentStateConflictError("Runtime event batch is outside its allowed bound");
    }
    const drafts = input.drafts.map((draft) => ({
      ...draft,
      payload: redactPersistedJson(draft.payload),
    }));
    for (const draft of drafts) {
      assertTimestamp(draft.timestamp, "draft.timestamp");
      if (draft.schemaVersion !== AGENT_SCHEMA_VERSION || !Number.isSafeInteger(draft.ordinal) || draft.ordinal < 1) {
        throw new AgentStateConflictError("Runtime event draft is invalid");
      }
    }
    const observed = await this.required(input.sessionId);
    if (observed.session.status === "cancelled") {
      return await this.publishCancelledRuntimeEffect(input, drafts);
    }
    const result = await this.runtimeMutate(
      input,
      "events",
      drafts as unknown as JsonValue,
      input.at,
      (state, task) => {
        assertSessionActive(state, "Publishing runtime events");
        let expectedOrdinal = (task.runtimeEventOrdinal ?? 0) + 1;
        for (const draft of drafts) {
          if (draft.ordinal !== expectedOrdinal) {
            throw new AgentStateConflictError("Runtime event drafts must be strictly monotonic");
          }
          if (state.events.some((event) => event.eventId === draft.draftId)) {
            throw new AgentStateConflictError("Runtime event draft ID was already published");
          }
          const sequence = state.nextEventSequence++;
          state.events.push(
            agentSchemas.agentEvent.parse({
              schemaVersion: AGENT_SCHEMA_VERSION,
              eventId: draft.draftId,
              sessionId: input.sessionId,
              sequence,
              timestamp: draft.timestamp,
              kind: draft.kind,
              payload: { schemaVersion: AGENT_SCHEMA_VERSION, redacted: true, data: draft.payload },
              replayCursor: `${input.sessionId}:${sequence}`,
            })
          );
          trackRuntimeInvocation(task, draft, {
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            leaseId: input.leaseId,
            leaseGeneration: (task.lease as AgentWorkLease).generation,
          });
          task.runtimeEventOrdinal = draft.ordinal;
          expectedOrdinal++;
        }
        this.compactEvents(state);
        task.updatedAt = input.at;
        state.session.updatedAt = input.at;
      }
    );
    const ids = new Set(drafts.map((draft) => draft.draftId));
    const events = result.state.events.filter((event) => ids.has(event.eventId));
    if (events.length !== drafts.length)
      throw new AgentStateConflictError("Runtime event result left the retention window");
    return { ...result, events: clone(events) };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery publication keeps every terminal evidence, owner, replacement, and idempotency guard in one CAS boundary.
  async publishRuntimeRecovery(
    input: import("@/lib/agent/state/contracts").RuntimeRecoveryPublicationInput
  ): Promise<StateMutationResult & { event: AgentEvent }> {
    assertTimestamp(input.at, "at");
    this.assertRuntimeId(input.runtimeId, "runtimeId");
    this.assertRuntimeId(input.leaseId, "leaseId");
    if (
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1 ||
      !Number.isSafeInteger(input.journalSequence) ||
      input.journalSequence < 1 ||
      !SHA256.test(input.invocationDigest) ||
      !SHA256.test(input.resultDigest)
    ) {
      throw new AgentStateConflictError("Runtime recovery publication binding is invalid");
    }
    const result = agentSchemas.toolResult.parse(input.result);
    const displayResult = agentSchemas.toolResult.parse(input.displayResult ?? result);
    const authoritativeDisplayShape = { ...displayResult, evidence: result.evidence };
    if (
      canonicalJson(authoritativeDisplayShape as unknown as JsonValue) !== canonicalJson(result as unknown as JsonValue)
    ) {
      throw new AgentStateConflictError("Runtime recovery display result changed authoritative executor evidence");
    }
    const actualResultDigest = await fingerprint(result as unknown as JsonValue);
    const persistedResult = agentSchemas.toolResult.parse(
      redactPersistedJson(result as unknown as import("@/lib/agent/contracts").JsonObject)
    );
    const persistedDisplayResult = agentSchemas.toolResult.parse(
      redactPersistedJson(displayResult as unknown as import("@/lib/agent/contracts").JsonObject)
    );
    const persistedResultDigest = await fingerprint(persistedResult as unknown as JsonValue);
    const outcome = result.status === "succeeded" ? "committed" : result.status;
    const taskDisposition = input.taskDisposition ?? "terminate";
    const receipt = input.terminalReceipt;
    if (
      result.invocationId !== input.invocationId ||
      actualResultDigest !== input.resultDigest ||
      !outcome ||
      (receipt.proofKind !== "terminal" && receipt.proofKind !== "clean-start-no-active") ||
      receipt.outcome !== outcome ||
      receipt.runtimeId !== input.runtimeId ||
      receipt.leaseId !== input.leaseId ||
      receipt.leaseGeneration !== input.leaseGeneration ||
      receipt.sessionId !== input.sessionId ||
      receipt.taskId !== input.taskId ||
      receipt.invocationId !== input.invocationId ||
      receipt.invocationDigest !== input.invocationDigest ||
      receipt.journalSequence !== input.journalSequence ||
      receipt.resultDigest !== input.resultDigest
    ) {
      throw new AgentStateConflictError("Runtime recovery publication evidence is not exact");
    }
    if (taskDisposition === "continue" && outcome === "indeterminate") {
      throw new AgentStateConflictError("Indeterminate runtime recovery cannot continue a task");
    }
    const observed = await this.required(input.sessionId);
    const task = this.task(observed, input.taskId);
    const existingRecoveries = task.runtimeRecoveries ?? [];
    const existingRecovery = existingRecoveries.find((candidate) => candidate.invocationId === input.invocationId);
    const sameRecoveryEvidence = (candidate: AgentRuntimeRecovery) =>
      candidate.runtimeId === input.runtimeId &&
      candidate.sessionId === input.sessionId &&
      candidate.taskId === input.taskId &&
      candidate.leaseId === input.leaseId &&
      candidate.leaseGeneration === input.leaseGeneration &&
      candidate.invocationId === input.invocationId &&
      candidate.invocationDigest === input.invocationDigest &&
      candidate.journalSequence === input.journalSequence &&
      candidate.resultDigest === input.resultDigest &&
      candidate.persistedResultDigest === persistedResultDigest &&
      candidate.outcome === outcome &&
      canonicalJson(candidate.terminalReceipt as unknown as JsonValue) ===
        canonicalJson(receipt as unknown as JsonValue);
    const replacesIndeterminateRecovery = (candidate: AgentRuntimeRecovery) =>
      candidate.outcome === "indeterminate" &&
      outcome === "failed" &&
      receipt.proofKind === "clean-start-no-active" &&
      receipt.executorEpoch !== candidate.terminalReceipt.executorEpoch &&
      input.journalSequence > candidate.journalSequence &&
      candidate.runtimeId === input.runtimeId &&
      candidate.sessionId === input.sessionId &&
      candidate.taskId === input.taskId &&
      candidate.leaseId === input.leaseId &&
      candidate.leaseGeneration === input.leaseGeneration &&
      candidate.invocationId === input.invocationId &&
      candidate.invocationDigest === input.invocationDigest &&
      typeof result.output === "object" &&
      result.output !== null &&
      !Array.isArray(result.output) &&
      result.output.code === "reconciliation-clean-start" &&
      result.output.noActiveEffect === true;
    if (
      existingRecovery &&
      !sameRecoveryEvidence(existingRecovery) &&
      !replacesIndeterminateRecovery(existingRecovery)
    ) {
      throw new AgentStateConflictError("Runtime recovery publication conflicts with prior terminal evidence");
    }
    const existingEvent = observed.events.find(
      (event) => event.kind === "tool-result" && event.payload.data.invocationId === input.invocationId
    );
    if (existingRecovery && existingEvent) {
      const existingResult = agentSchemas.toolResult.parse(existingEvent.payload.data);
      // An indeterminate result can be a gateway-only placeholder published
      // before the executor's authenticated terminal truth arrived. It is not
      // an idempotency proof. Only the exact terminal result and receipt make
      // an already recovered publication idempotent.
      if (
        existingResult.status === persistedDisplayResult.status &&
        existingRecovery.resultDigest === input.resultDigest &&
        canonicalJson(existingRecovery.terminalReceipt as unknown as JsonValue) ===
          canonicalJson(receipt as unknown as JsonValue)
      ) {
        return { state: clone(observed), idempotent: true, event: clone(existingEvent) };
      }
      if (existingResult.status !== "indeterminate") {
        throw new AgentStateConflictError("Runtime recovery publication conflicts with prior terminal evidence");
      }
    }
    const proposal = task.activeRuntimeInvocation;
    if (
      proposal &&
      (proposal.runtimeId !== input.runtimeId ||
        proposal.sessionId !== input.sessionId ||
        proposal.taskId !== input.taskId ||
        proposal.leaseId !== input.leaseId ||
        proposal.leaseGeneration !== input.leaseGeneration ||
        proposal.invocationId !== input.invocationId ||
        proposal.invocationDigest !== input.invocationDigest)
    ) {
      throw new AgentStateConflictError("Runtime recovery publication would cross a replacement invocation");
    }
    if (
      task.lease &&
      (task.lease.runtimeId !== input.runtimeId ||
        task.lease.leaseId !== input.leaseId ||
        task.lease.generation !== input.leaseGeneration)
    ) {
      throw new AgentStateConflictError("Runtime recovery publication would cross a replacement lease");
    }
    if (
      taskDisposition === "continue" &&
      (!task.lease ||
        !proposal ||
        (task.status !== "running" && task.status !== "waiting-approval") ||
        (observed.session.status !== "running" && observed.session.status !== "waiting-approval"))
    ) {
      throw new AgentStateConflictError("Runtime invocation completion requires its exact live task authority");
    }
    const proposalExists = observed.events.some(
      (event) =>
        event.kind === "tool-proposal" &&
        event.payload.data.invocationId === input.invocationId &&
        event.payload.data.invocationDigest === input.invocationDigest
    );
    if (!proposalExists) throw new AgentStateConflictError("Runtime recovery publication has no durable handoff");
    const ordinal =
      task.cancellationReconciliation?.invocationId === input.invocationId
        ? task.cancellationReconciliation.nextOrdinal
        : (task.runtimeEventOrdinal ?? 0) + 1;
    const eventId = `recovery-${(
      await fingerprint({
        runtimeId: input.runtimeId,
        leaseId: input.leaseId,
        leaseGeneration: input.leaseGeneration,
        invocationId: input.invocationId,
        journalSequence: input.journalSequence,
        resultDigest: input.resultDigest,
      } as unknown as JsonValue)
    ).slice(0, 48)}`;
    const {
      at: _at,
      idempotencyKey: _idempotencyKey,
      schemaVersion: _schemaVersion,
      ...recoveryBinding
    } = input as typeof input & { schemaVersion?: number };
    const operationFingerprint = await fingerprint({
      ...recoveryBinding,
      result,
      displayResult,
      terminalReceipt: receipt,
    } as unknown as JsonValue);
    let publishedEventId = eventId;
    const mutation = await this.mutateWithFingerprint(
      { sessionId: input.sessionId, expectedRevision: observed.revision, idempotencyKey: input.idempotencyKey },
      `runtime-recovery:${input.taskId}:${input.leaseGeneration}`,
      operationFingerprint,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery validation and publication are intentionally one atomic evidence boundary.
      (state) => {
        const currentTask = this.task(state, input.taskId);
        const currentRecoveries = currentTask.runtimeRecoveries ?? [];
        const currentRecovery = currentRecoveries.find((candidate) => candidate.invocationId === input.invocationId);
        if (currentRecovery && sameRecoveryEvidence(currentRecovery)) return;
        if (
          (currentRecovery && !replacesIndeterminateRecovery(currentRecovery)) ||
          currentRecoveries.some((candidate) => candidate.journalSequence === input.journalSequence)
        ) {
          throw new AgentStateConflictError("Runtime recovery publication conflicts with prior terminal evidence");
        }
        if (
          currentTask.activeRuntimeInvocation &&
          (currentTask.activeRuntimeInvocation.invocationId !== input.invocationId ||
            currentTask.activeRuntimeInvocation.invocationDigest !== input.invocationDigest ||
            currentTask.activeRuntimeInvocation.leaseGeneration !== input.leaseGeneration)
        ) {
          throw new AgentStateConflictError("Runtime recovery publication crossed a replacement invocation");
        }
        if (
          taskDisposition === "continue" &&
          (!currentTask.lease ||
            currentTask.lease.runtimeId !== input.runtimeId ||
            currentTask.lease.leaseId !== input.leaseId ||
            currentTask.lease.generation !== input.leaseGeneration ||
            !currentTask.activeRuntimeInvocation ||
            currentTask.activeRuntimeInvocation.invocationId !== input.invocationId ||
            currentTask.activeRuntimeInvocation.invocationDigest !== input.invocationDigest ||
            (currentTask.status !== "running" && currentTask.status !== "waiting-approval") ||
            (state.session.status !== "running" && state.session.status !== "waiting-approval"))
        ) {
          throw new AgentStateConflictError("Runtime invocation completion lost its exact live task authority");
        }
        const currentExisting = state.events.find(
          (event) => event.kind === "tool-result" && event.payload.data.invocationId === input.invocationId
        );
        if (currentExisting) {
          publishedEventId = currentExisting.eventId;
          const currentResult = agentSchemas.toolResult.parse(currentExisting.payload.data);
          if (
            currentResult.status !== "indeterminate" &&
            (currentResult.status !== persistedDisplayResult.status ||
              currentResult.completedAt !== persistedDisplayResult.completedAt)
          ) {
            throw new AgentStateConflictError("Runtime recovery publication conflicts with prior terminal result");
          }
          if (currentResult.status === "indeterminate") {
            // Replace the synthetic indeterminate event in place. Keeping its
            // event ID preserves replay cursors while making terminal truth
            // visible before the executor acknowledgement is sent.
            currentExisting.timestamp = result.completedAt;
            currentExisting.payload = {
              schemaVersion: AGENT_SCHEMA_VERSION,
              redacted: true,
              data: persistedDisplayResult as unknown as JsonObject,
            };
          }
        } else {
          state.events.push(
            agentSchemas.agentEvent.parse({
              schemaVersion: AGENT_SCHEMA_VERSION,
              eventId,
              sessionId: input.sessionId,
              sequence: state.nextEventSequence++,
              timestamp: result.completedAt,
              kind: "tool-result",
              payload: {
                schemaVersion: AGENT_SCHEMA_VERSION,
                redacted: true,
                data: persistedDisplayResult as unknown as JsonObject,
              },
              replayCursor: `${input.sessionId}:${state.nextEventSequence - 1}`,
            })
          );
        }
        const cancellationWon = state.session.status === "cancelled" || currentTask.status === "cancelled";
        if (taskDisposition === "terminate" && !cancellationWon && currentTask.status !== "completed") {
          if (outcome === "committed") {
            currentTask.status = "completed";
          } else {
            currentTask.status = "failed";
            for (const candidate of state.tasks) {
              if (!TERMINAL_TASK_STATUSES.has(candidate.status)) candidate.status = "failed";
              candidate.lease = undefined;
              candidate.updatedAt = input.at;
            }
          }
        }
        currentTask.activeRuntimeInvocation = undefined;
        if (taskDisposition === "terminate") currentTask.lease = undefined;
        currentTask.invocationAuthorizations = currentTask.invocationAuthorizations?.filter(
          (candidate) => candidate.invocationId !== input.invocationId
        );
        if (currentTask.cancellationReconciliation?.invocationId === input.invocationId) {
          currentTask.cancellationReconciliation.consumedAt ??= input.at;
          currentTask.cancellationReconciliation.resultDraftId = publishedEventId;
        }
        currentTask.runtimeEventOrdinal = Math.max(currentTask.runtimeEventOrdinal ?? 0, ordinal);
        currentTask.updatedAt = input.at;
        this.compactEvents(state);
        if (taskDisposition === "terminate" && !cancellationWon && state.session.status !== "completed") {
          if (outcome === "committed" || currentTask.status === "completed") {
            if (state.tasks.every((candidate) => TERMINAL_TASK_STATUSES.has(candidate.status))) {
              this.transitionRecoveredSessionState(
                state,
                "idle",
                input.at,
                "Authenticated runtime recovery committed."
              );
            }
          } else {
            this.transitionRecoveredSessionState(state, "failed", input.at, "Authenticated runtime recovery failed.");
            deactivateApprovals(state, input.at, "Authenticated runtime recovery failed.");
          }
        } else {
          state.session.updatedAt = input.at;
        }
        const coherentProjection =
          taskDisposition === "continue"
            ? (currentTask.status === "running" || currentTask.status === "waiting-approval") &&
              (state.session.status === "running" || state.session.status === "waiting-approval") &&
              currentTask.lease !== undefined
            : TERMINAL_TASK_STATUSES.has(currentTask.status) &&
              ["idle", "completed", "failed", "cancelled"].includes(state.session.status);
        if (!coherentProjection) {
          throw new AgentStateConflictError("Runtime recovery publication did not reach a terminal projection");
        }
        // The executor's runtime-wide fence cannot admit this distinct
        // invocation until the prior terminal was acknowledged. Retaining the
        // latest publication therefore preserves every acknowledgement that
        // can still be outstanding without imposing a per-task lifetime cap.
        currentTask.runtimeRecoveries = [
          {
            schemaVersion: 1,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            leaseId: input.leaseId,
            leaseGeneration: input.leaseGeneration,
            invocationId: input.invocationId,
            invocationDigest: input.invocationDigest,
            journalSequence: input.journalSequence,
            resultDigest: input.resultDigest,
            persistedResultDigest,
            outcome,
            result: clone(persistedResult),
            terminalReceipt: clone(receipt),
            taskDisposition,
            taskStatus: currentTask.status as AgentRuntimeRecovery["taskStatus"],
            sessionStatus: state.session.status as AgentRuntimeRecovery["sessionStatus"],
            publishedAt: input.at,
            publicationRevision: state.revision + 1,
          },
        ];
      },
      "terminal"
    );
    const event = mutation.state.events.find(
      (candidate) =>
        candidate.eventId === publishedEventId ||
        (candidate.kind === "tool-result" && candidate.payload.data.invocationId === input.invocationId)
    );
    if (!event) throw new AgentStateConflictError("Runtime recovery result left the retention window");
    return { ...mutation, event: clone(event) };
  }

  private async publishCancelledRuntimeEffect(
    input: RuntimeLeaseMutationInput & { at: string; drafts: RuntimeAgentEventDraft[] },
    drafts: RuntimeAgentEventDraft[]
  ): Promise<StateMutationResult & { events: AgentEvent[] }> {
    if (drafts.length !== 1 || drafts[0].kind !== "tool-result") {
      throw new AgentStateConflictError("Cancelled runtime accepts only one reconciled tool result");
    }
    const parsed = agentSchemas.toolResult.safeParse(drafts[0].payload);
    if (!parsed.success || isWaitingRuntimeResult(parsed.data))
      throw new AgentStateConflictError("Cancelled runtime result is not a terminal effect result");
    const result = parsed.data;
    const observed = await this.required(input.sessionId);
    const receipt = this.cancelledReconciliationReceipt(observed, input);
    if (result.invocationId !== receipt.invocationId || drafts[0].ordinal !== receipt.nextOrdinal) {
      throw new AgentStateConflictError("Cancelled runtime result does not match its reconciliation receipt");
    }
    const generation = receipt.generation;
    const operationFingerprint = await fingerprint({
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      taskId: input.taskId,
      generation,
      payload: drafts as unknown as JsonValue,
    });
    const mutation = await this.mutateWithFingerprint(
      { ...input, idempotencyKey: await runtimeIdempotencyKey(input.taskId, generation, input.idempotencyKey) },
      `runtime-cancelled-effect:${input.taskId}:${generation}`,
      operationFingerprint,
      (state) => {
        const currentTask = this.assertOpenCancelledReconciliation(state, input, input.at, generation);
        const currentReceipt = currentTask.cancellationReconciliation as NonNullable<
          typeof currentTask.cancellationReconciliation
        >;
        const proposed = state.events.some(
          (event) =>
            event.kind === "tool-proposal" &&
            event.payload.data.invocationId === result.invocationId &&
            event.payload.data.invocationDigest === currentReceipt.invocationDigest
        );
        if (!proposed) throw new AgentStateConflictError("Reconciled tool result has no persisted proposal");
        if (
          state.events.some(
            (event) => event.kind === "tool-result" && event.payload.data.invocationId === result.invocationId
          )
        ) {
          throw new AgentStateConflictError("Reconciled tool result was already published");
        }
        const draft = drafts[0];
        if (draft.ordinal !== currentReceipt.nextOrdinal) {
          throw new AgentStateConflictError("Reconciled tool result ordinal is not the next runtime event");
        }
        const sequence = state.nextEventSequence++;
        state.events.push(
          agentSchemas.agentEvent.parse({
            schemaVersion: AGENT_SCHEMA_VERSION,
            eventId: draft.draftId,
            sessionId: input.sessionId,
            sequence,
            timestamp: draft.timestamp,
            kind: draft.kind,
            payload: { schemaVersion: AGENT_SCHEMA_VERSION, redacted: true, data: draft.payload },
            replayCursor: `${input.sessionId}:${sequence}`,
          })
        );
        state.events = state.events.slice(-this.retention.maxEvents);
        state.retainedFromSequence = state.events[0]?.sequence ?? state.nextEventSequence;
        currentTask.runtimeEventOrdinal = draft.ordinal;
        currentReceipt.consumedAt = input.at;
        currentReceipt.resultDraftId = draft.draftId;
        currentTask.activeRuntimeInvocation = undefined;
        currentTask.updatedAt = input.at;
        state.session.updatedAt = input.at;
      },
      "terminal",
      (state) => this.assertOpenCancelledReconciliation(state, input, input.at, generation)
    );
    const published = mutation.state.events.find((event) => event.eventId === drafts[0].draftId);
    if (!published) throw new AgentStateConflictError("Reconciled tool result left the retention window");
    return { ...mutation, events: [clone(published)] };
  }

  private cancelledReconciliationReceipt(
    state: DurableAgentSessionState,
    input: Pick<RuntimeLeaseMutationInput, "taskId" | "leaseId" | "runtimeId">,
    expectedGeneration?: number
  ) {
    const task = this.task(state, input.taskId);
    const receipt = task.cancellationReconciliation;
    if (
      state.session.status !== "cancelled" ||
      task.status !== "cancelled" ||
      receipt?.leaseId !== input.leaseId ||
      receipt.runtimeId !== input.runtimeId ||
      (expectedGeneration !== undefined && receipt.generation !== expectedGeneration)
    ) {
      throw new AgentStateConflictError("Cancelled runtime reconciliation receipt does not match");
    }
    return receipt;
  }

  private assertOpenCancelledReconciliation(
    state: DurableAgentSessionState,
    input: Pick<RuntimeLeaseMutationInput, "taskId" | "leaseId" | "runtimeId">,
    at: string,
    expectedGeneration?: number
  ) {
    const task = this.task(state, input.taskId);
    const receipt = this.cancelledReconciliationReceipt(state, input, expectedGeneration);
    if (receipt.consumedAt || Date.parse(receipt.expiresAt) < Date.parse(at)) {
      throw new AgentStateConflictError("Cancelled runtime reconciliation receipt is consumed or expired");
    }
    return task;
  }

  async putRuntimeApproval(
    input: RuntimeLeaseMutationInput & { at: string; approval: AgentApproval }
  ): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    const proposedApproval = agentSchemas.agentApproval.parse({
      ...input.approval,
      reason: redactReasonForPersistence(input.approval.reason),
      invocationSummary: {
        ...input.approval.invocationSummary,
        sanitizedArguments: redactPersistedJson(input.approval.invocationSummary.sanitizedArguments),
        ...(input.approval.invocationSummary.diffSummary
          ? { diffSummary: redactReasonForPersistence(input.approval.invocationSummary.diffSummary) }
          : {}),
      },
    });
    if (
      (await createInvocationSummaryDigest(proposedApproval.invocationSummary)) !==
      proposedApproval.invocationSummaryDigest
    ) {
      throw new AgentStateConflictError("Runtime approval invocation summary digest is invalid");
    }
    if (
      proposedApproval.decision !== "pending" ||
      proposedApproval.decidedAt !== undefined ||
      proposedApproval.consumedAt !== undefined
    ) {
      throw new AgentStateConflictError("Runtime may publish only an undecided pending approval");
    }
    return await this.runtimeMutate(
      input,
      "approval",
      proposedApproval as unknown as JsonValue,
      input.at,
      (state, task) => {
        if (
          proposedApproval.sessionId !== input.sessionId ||
          proposedApproval.actorId !== state.session.actorId ||
          proposedApproval.policyId !== state.session.policyId ||
          proposedApproval.policyRevision !== state.session.policyRevision
        ) {
          throw new AgentStateConflictError("Runtime approval does not match the leased session");
        }
        this.assertApprovalProposalBinding(state, proposedApproval);
        const approval = agentSchemas.agentApproval.parse({
          schemaVersion: AGENT_SCHEMA_VERSION,
          approvalId: proposedApproval.approvalId,
          actorId: state.session.actorId,
          sessionId: state.session.sessionId,
          policyId: state.policySnapshot.policyId,
          policyRevision: state.policySnapshot.revision,
          invocationDigest: proposedApproval.invocationDigest,
          invocationSummary: proposedApproval.invocationSummary,
          invocationSummaryDigest: proposedApproval.invocationSummaryDigest,
          scope: proposedApproval.scope,
          expiresAt: proposedApproval.expiresAt,
          decision: "pending",
          reason: redactReasonForPersistence(proposedApproval.reason),
        });
        if (state.approvals.some((candidate) => candidate.approvalId === approval.approvalId)) {
          throw new AgentStateConflictError("Runtime approval already exists");
        }
        state.approvals.push(approval);
        this.compactApprovals(state);
        if (task.status === "running") task.status = "waiting-approval";
        else if (task.status !== "waiting-approval") {
          throw new AgentStateTransitionError("Runtime approval requires running work");
        }
        task.updatedAt = input.at;
        if (state.session.status === "running") {
          this.transitionSessionState(state, "waiting-approval", input.at, "runtime waiting for operator decision");
        } else if (state.session.status !== "waiting-approval") {
          throw new AgentStateTransitionError("Runtime approval requires a running session");
        }
      }
    );
  }

  async consumeRuntimeApproval(
    input: RuntimeLeaseMutationInput & { at: string; approvalId: string; invocationDigest: string }
  ): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.runtimeMutate(
      input,
      "consume-approval",
      // `at` is generated by the server and therefore cannot be part of the retry fingerprint. A client retry with
      // the same idempotency key must recover the original committed consumedAt while the same lease is active.
      { approvalId: input.approvalId, invocationDigest: input.invocationDigest },
      input.at,
      (state) => {
        const index = state.approvals.findIndex((approval) => approval.approvalId === input.approvalId);
        if (index < 0) throw new AgentStateNotFoundError(`approval:${input.approvalId}`);
        state.approvals[index] = consumeSingleInvocationApproval(
          state.approvals[index],
          input.sessionId,
          input.invocationDigest,
          input.at
        );
        state.session.updatedAt = input.at;
      }
    );
  }

  async authorizeRuntimeInvocation(
    input: RuntimeLeaseMutationInput & {
      at: string;
      authorizationId: string;
      invocationId: string;
      invocationDigest: string;
      approvalId: string;
      capability: import("@/lib/agent/contracts").AgentCapability;
      targetScope: import("@/lib/agent/contracts").TargetScope;
      risk: import("@/lib/agent/contracts").RiskClass;
    }
  ): Promise<StateMutationResult & { authorization: InvocationAuthorization }> {
    assertTimestamp(input.at, "at");
    this.assertRuntimeId(input.runtimeId, "runtimeId");
    this.assertRuntimeId(input.authorizationId, "authorizationId");
    this.assertRuntimeId(input.invocationId, "invocationId");
    this.assertRuntimeId(input.approvalId, "approvalId");
    if (!SHA256.test(input.invocationDigest)) {
      throw new AgentStateConflictError("Invocation authorization digest is invalid");
    }
    agentSchemas.targetScope.parse(input.targetScope);

    const observed = await this.required(input.sessionId);
    const activeTask = this.assertActiveLease(observed, input, input.at);
    const leaseGeneration = (activeTask.lease as AgentWorkLease).generation;
    const operationFingerprint = await fingerprint({
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      taskId: input.taskId,
      leaseGeneration,
      authorizationId: input.authorizationId,
      invocationId: input.invocationId,
      invocationDigest: input.invocationDigest,
      approvalId: input.approvalId,
      capability: input.capability,
      targetScope: input.targetScope,
      risk: input.risk,
    } as unknown as JsonValue);
    const mutation = await this.mutateWithFingerprint(
      {
        ...input,
        idempotencyKey: await runtimeIdempotencyKey(input.taskId, leaseGeneration, input.idempotencyKey),
      },
      `runtime-authorize-invocation:${input.taskId}:${leaseGeneration}`,
      operationFingerprint,
      (state) => {
        const task = this.assertActiveLease(state, input, input.at, leaseGeneration);
        this.assertActiveRuntimeInvocation(task, input, leaseGeneration);
        const approval = this.approval(state, input.approvalId);
        const approvalKind = permissionDecisionForRisk(state.policySnapshot, input.capability, input.risk);
        if (approvalKind !== "ask-once" && approvalKind !== "ask-always") {
          throw new AgentStateConflictError("Invocation does not require an approval-bound authorization");
        }
        if (
          approval.actorId !== state.session.actorId ||
          approval.sessionId !== state.session.sessionId ||
          approval.policyId !== state.policySnapshot.policyId ||
          approval.policyRevision !== state.policySnapshot.revision ||
          approval.decision !== "approved" ||
          Date.parse(approval.expiresAt) <= Date.parse(input.at) ||
          approval.scope.kind !== (approvalKind === "ask-once" ? "session-capability" : "single-invocation") ||
          approval.scope.capability !== input.capability ||
          approval.scope.risk !== input.risk ||
          approval.scope.targetScope.schemaVersion !== input.targetScope.schemaVersion ||
          approval.scope.targetScope.kind !== input.targetScope.kind ||
          approval.scope.targetScope.normalizedTarget !== input.targetScope.normalizedTarget ||
          (approvalKind === "ask-always" && approval.invocationDigest !== input.invocationDigest)
        ) {
          throw new AgentStateConflictError("Invocation approval is no longer active or does not match");
        }
        const proposed = state.events.some(
          (event) =>
            event.kind === "tool-proposal" &&
            event.payload.data.invocationId === input.invocationId &&
            event.payload.data.invocationDigest === input.invocationDigest &&
            event.payload.data.capability === input.capability &&
            (() => {
              const targetScope = event.payload.data.targetScope;
              return (
                targetScope !== null &&
                typeof targetScope === "object" &&
                !Array.isArray(targetScope) &&
                targetScope.schemaVersion === input.targetScope.schemaVersion &&
                targetScope.kind === input.targetScope.kind &&
                targetScope.normalizedTarget === input.targetScope.normalizedTarget
              );
            })()
        );
        if (!proposed) throw new AgentStateConflictError("Invocation authorization has no exact persisted proposal");
        if (approvalKind === "ask-always") {
          const index = state.approvals.findIndex((candidate) => candidate.approvalId === approval.approvalId);
          state.approvals[index] = consumeSingleInvocationApproval(
            approval,
            input.sessionId,
            input.invocationDigest,
            input.at
          );
        }
        const expiresAt = new Date(
          Math.min(Date.parse(approval.expiresAt), Date.parse(input.at) + INVOCATION_AUTHORIZATION_MS)
        ).toISOString();
        const authorization: InvocationAuthorization = {
          schemaVersion: 1,
          authorizationId: input.authorizationId,
          runtimeId: input.runtimeId,
          leaseId: input.leaseId,
          leaseGeneration,
          taskId: input.taskId,
          sessionId: state.session.sessionId,
          actorId: state.session.actorId,
          policyId: state.policySnapshot.policyId,
          policyRevision: state.policySnapshot.revision,
          invocationId: input.invocationId,
          invocationDigest: input.invocationDigest,
          approvalId: approval.approvalId,
          approvalKind,
          capability: input.capability,
          targetScope: clone(input.targetScope),
          risk: input.risk,
          issuedAt: input.at,
          expiresAt,
        };
        task.invocationAuthorizations = [...(task.invocationAuthorizations ?? []), authorization].slice(
          -MAX_INVOCATION_AUTHORIZATIONS
        );
        task.updatedAt = input.at;
        state.session.updatedAt = input.at;
      },
      "standard",
      (state) => {
        this.assertActiveLease(state, input, input.at, leaseGeneration);
        this.assertActiveRuntimeInvocation(this.task(state, input.taskId), input, leaseGeneration);
      }
    );
    const authorization = this.task(mutation.state, input.taskId).invocationAuthorizations?.find(
      (candidate) => candidate.authorizationId === input.authorizationId
    );
    if (!authorization) throw new AgentStateConflictError("Invocation authorization was not recorded");
    return { ...mutation, authorization: clone(authorization) };
  }

  async setRuntimeStatus(
    input: RuntimeLeaseMutationInput & {
      at: string;
      status: "running" | "waiting-approval" | "completed" | "failed" | "cancelled";
      reason: string;
      assistantTurn?: import("@/lib/agent/contracts").AgentTurn;
    }
  ): Promise<StateMutationResult> {
    assertTimestamp(input.at, "at");
    return await this.runtimeMutate(
      input,
      "status",
      {
        status: input.status,
        reason: input.reason,
        assistantTurn: input.assistantTurn ?? null,
      } as unknown as JsonValue,
      input.at,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Runtime status transitions deliberately keep all terminal invariants in one atomic mutation.
      (state, task) => {
        const reason = redactReasonForPersistence(input.reason);
        if (input.status === "running") {
          assertTransition("task", task.status, "running", TASK_TRANSITIONS);
          task.status = "running";
          this.transitionSessionState(state, "running", input.at, reason);
        } else if (input.status === "waiting-approval") {
          assertTransition("task", task.status, "waiting-approval", TASK_TRANSITIONS);
          task.status = "waiting-approval";
          this.transitionSessionState(state, "waiting-approval", input.at, reason);
        } else if (input.status === "cancelled") {
          assertTransition("task", task.status, "cancelled", TASK_TRANSITIONS);
          state.cancellation = {
            schemaVersion: AGENT_SCHEMA_VERSION,
            requestedAt: input.at,
            requestedBy: input.runtimeId,
            reason,
          };
          for (const candidate of state.tasks) {
            if (!TERMINAL_TASK_STATUSES.has(candidate.status)) candidate.status = "cancelled";
            candidate.updatedAt = input.at;
            candidate.lease = undefined;
          }
          this.transitionSessionState(state, "cancelled", input.at, reason);
          deactivateApprovals(state, input.at, reason);
        } else if (input.status === "failed") {
          assertTransition("task", task.status, "failed", TASK_TRANSITIONS);
          task.status = "failed";
          for (const candidate of state.tasks) {
            if (!TERMINAL_TASK_STATUSES.has(candidate.status)) candidate.status = "failed";
            candidate.lease = undefined;
          }
          this.transitionSessionState(state, "failed", input.at, reason);
          deactivateApprovals(state, input.at, reason);
        } else {
          assertTransition("task", task.status, "completed", TASK_TRANSITIONS);
          task.status = "completed";
          if (state.tasks.every((candidate) => TERMINAL_TASK_STATUSES.has(candidate.status))) {
            this.transitionSessionState(state, "idle", input.at, reason);
          }
        }
        if (input.assistantTurn) {
          if (input.status !== "completed") {
            throw new AgentStateTransitionError("Assistant continuation context requires completed work");
          }
          const assistantTurn = agentSchemas.agentTurn.parse(input.assistantTurn);
          if (assistantTurn.kind !== "assistant") {
            throw new AgentStateTransitionError("Runtime completion turn must be an assistant turn");
          }
          state.session.turns.push({
            ...assistantTurn,
            content: redactReasonForPersistence(assistantTurn.content),
          });
          this.compactTurns(state);
        }
        task.updatedAt = input.at;
        state.session.updatedAt = input.at;
        if (TERMINAL_TASK_STATUSES.has(task.status)) task.lease = undefined;
      },
      input.status === "failed" || input.status === "cancelled" ? "terminal" : "standard"
    );
  }

  async waitForRuntimeState(
    input: Omit<RuntimeLeaseMutationInput, "expectedRevision" | "idempotencyKey"> & {
      afterRevision: number;
      timeoutMs: number;
    },
    signal?: AbortSignal
  ): Promise<DurableAgentSessionState> {
    if (!Number.isSafeInteger(input.afterRevision) || input.afterRevision < 1) throw new Error("Invalid revision");
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 30_000) {
      throw new Error("Invalid runtime wait timeout");
    }
    let state = await this.required(input.sessionId);
    this.assertRuntimeDecisionAccess(state, input, new Date().toISOString());
    if (state.revision <= input.afterRevision && input.timeoutMs > 0 && !signal?.aborted) {
      await this.repository.waitForRevision(input.sessionId, input.afterRevision, input.timeoutMs, signal);
      state = await this.required(input.sessionId);
      this.assertRuntimeDecisionAccess(state, input, new Date().toISOString());
    }
    return clone(state);
  }

  private async mutate(
    input: { sessionId: string; expectedRevision: number; idempotencyKey: string },
    operation: string,
    fingerprintValue: JsonValue,
    apply: (state: DurableAgentSessionState) => void,
    budget: "standard" | "terminal" = "standard",
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<StateMutationResult> {
    return await this.mutateWithFingerprint(
      input,
      operation,
      await fingerprint(fingerprintValue),
      apply,
      budget,
      undefined,
      runtimeWorkClaim
    );
  }

  private async runtimeMutate(
    input: RuntimeLeaseMutationInput,
    operation: string,
    fingerprintValue: JsonValue,
    at: string,
    apply: (state: DurableAgentSessionState, task: import("@/lib/agent/state/contracts").AgentTaskRecord) => void,
    budget: "standard" | "terminal" = "standard"
  ): Promise<StateMutationResult> {
    this.assertRuntimeId(input.runtimeId, "runtimeId");
    const observed = await this.required(input.sessionId);
    const prior = await this.runtimeIdempotencyRecord(observed, input.taskId, operation, input.idempotencyKey);
    const observedTask = prior ? this.task(observed, input.taskId) : this.assertActiveLease(observed, input, at);
    const generation = prior?.generation ?? (observedTask.lease as AgentWorkLease).generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new AgentStateConflictError("Runtime idempotency generation is invalid");
    }
    const operationFingerprint = await fingerprint({
      runtimeId: input.runtimeId,
      leaseId: input.leaseId,
      taskId: input.taskId,
      generation,
      payload: fingerprintValue,
    });
    return await this.mutateWithFingerprint(
      {
        ...input,
        idempotencyKey: prior?.key ?? (await runtimeIdempotencyKey(input.taskId, generation, input.idempotencyKey)),
      },
      `runtime-${operation}:${input.taskId}:${generation}`,
      operationFingerprint,
      (state) => apply(state, this.assertActiveLease(state, input, at, generation)),
      budget,
      (state) => {
        this.assertActiveLease(state, input, at, generation);
      }
    );
  }

  private async runtimeIdempotencyRecord(
    state: DurableAgentSessionState,
    taskId: string,
    operation: string,
    idempotencyKey: string
  ): Promise<{ generation: number; key: string } | undefined> {
    const operationPrefix = `runtime-${operation}:${taskId}:`;
    for (const entry of state.idempotency) {
      if (!entry.operation.startsWith(operationPrefix)) continue;
      const generation = Number(entry.operation.slice(operationPrefix.length));
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      const key = await runtimeIdempotencyKey(taskId, generation, idempotencyKey);
      if (entry.key === key) return { generation, key };
    }
    return undefined;
  }

  private assertActiveLease(
    state: DurableAgentSessionState,
    input: Pick<RuntimeLeaseMutationInput, "taskId" | "leaseId" | "runtimeId">,
    at: string,
    expectedGeneration?: number
  ) {
    assertSessionActive(state, "Runtime lease mutation");
    const task = this.assertLease(state, input, at, expectedGeneration);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new AgentStateConflictError("Runtime lease task is terminal");
    }
    return task;
  }

  private assertActiveRuntimeInvocation(
    task: AgentTaskRecord,
    input: Pick<
      RuntimeLeaseMutationInput & {
        invocationId: string;
        invocationDigest: string;
        capability: import("@/lib/agent/contracts").AgentCapability;
        targetScope: import("@/lib/agent/contracts").TargetScope;
      },
      | "runtimeId"
      | "sessionId"
      | "taskId"
      | "leaseId"
      | "invocationId"
      | "invocationDigest"
      | "capability"
      | "targetScope"
    >,
    leaseGeneration: number
  ): void {
    const active = task.activeRuntimeInvocation;
    if (
      !active ||
      active.runtimeId !== input.runtimeId ||
      active.sessionId !== input.sessionId ||
      active.taskId !== input.taskId ||
      active.leaseId !== input.leaseId ||
      active.leaseGeneration !== leaseGeneration ||
      active.invocationId !== input.invocationId ||
      active.invocationDigest !== input.invocationDigest ||
      active.capability !== input.capability ||
      active.targetScope.schemaVersion !== input.targetScope.schemaVersion ||
      active.targetScope.kind !== input.targetScope.kind ||
      active.targetScope.normalizedTarget !== input.targetScope.normalizedTarget
    ) {
      throw new AgentStateConflictError("Invocation authorization does not match the active runtime invocation");
    }
  }

  private assertLease(
    state: DurableAgentSessionState,
    input: Pick<RuntimeLeaseMutationInput, "taskId" | "leaseId" | "runtimeId">,
    at: string,
    expectedGeneration?: number
  ) {
    const task = this.task(state, input.taskId);
    if (task.lease?.leaseId !== input.leaseId || task.lease.runtimeId !== input.runtimeId) {
      throw new AgentStateConflictError("Runtime lease is not owned by this worker");
    }
    if (Date.parse(task.lease.expiresAt) <= Date.parse(at)) {
      throw new AgentStateConflictError("Runtime lease expired");
    }
    if (expectedGeneration !== undefined && task.lease.generation !== expectedGeneration) {
      throw new AgentStateConflictError("Runtime lease generation changed");
    }
    return task;
  }

  private assertRuntimeDecisionAccess(
    state: DurableAgentSessionState,
    input: Pick<RuntimeLeaseMutationInput, "taskId" | "leaseId" | "runtimeId">,
    at: string
  ): void {
    const task = this.task(state, input.taskId);
    if (task.lease?.leaseId === input.leaseId && task.lease.runtimeId === input.runtimeId) {
      this.assertLease(state, input, at);
      return;
    }
    const receipt = this.cancelledReconciliationReceipt(state, input);
    if (receipt.consumedAt || Date.parse(receipt.expiresAt) < Date.parse(at)) {
      throw new AgentStateConflictError("Cancelled runtime reconciliation receipt is consumed or expired");
    }
  }

  private transitionSessionState(
    state: DurableAgentSessionState,
    status: AgentSessionStatus,
    at: string,
    reason: string
  ): void {
    assertTransition("session", state.session.status, status, SESSION_TRANSITIONS);
    state.statusHistory.push({
      schemaVersion: AGENT_SCHEMA_VERSION,
      from: state.session.status,
      to: status,
      at,
      reason,
    });
    state.statusHistory = state.statusHistory.slice(-this.retention.maxStatusTransitions);
    state.session = { ...state.session, status, updatedAt: at };
  }

  /** Recovery alone may repair an expiry-induced failed projection to idle. Cancellation is never reversible. */
  private transitionRecoveredSessionState(
    state: DurableAgentSessionState,
    status: "idle" | "failed",
    at: string,
    reason: string
  ): void {
    if (state.session.status === status) {
      state.session.updatedAt = at;
      return;
    }
    if (state.session.status === "cancelled" || state.session.status === "completed") return;
    const legalRecovery =
      status === "idle"
        ? ["pending", "running", "waiting-approval", "failed"].includes(state.session.status)
        : ["pending", "running", "waiting-approval", "idle"].includes(state.session.status);
    if (!legalRecovery) throw new AgentStateTransitionError("Runtime recovery session transition is invalid");
    state.statusHistory.push({
      schemaVersion: AGENT_SCHEMA_VERSION,
      from: state.session.status,
      to: status,
      at,
      reason,
    });
    state.statusHistory = state.statusHistory.slice(-this.retention.maxStatusTransitions);
    state.session = { ...state.session, status, updatedAt: at };
  }

  private assignment(
    state: DurableAgentSessionState,
    task: import("@/lib/agent/state/contracts").AgentTaskRecord,
    lease: AgentWorkLease
  ): RuntimeWorkAssignment {
    return clone({
      schemaVersion: AGENT_SCHEMA_VERSION,
      revision: state.revision,
      providerProfileFingerprint: state.session.harness.providerProfileFingerprint,
      session: state.session,
      policySnapshot: state.policySnapshot,
      task,
      approvals: state.approvals,
      lease,
    });
  }

  private task(state: DurableAgentSessionState, taskId: string) {
    const task = state.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) throw new AgentStateNotFoundError(`task:${taskId}`);
    return task;
  }

  private assertRuntimeId(value: string, name: string): void {
    if (!RUNTIME_ID.test(value)) throw new AgentStateConflictError(`${name} is invalid`);
  }

  private assertLeaseDuration(value: number): void {
    if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
      throw new AgentStateConflictError("Runtime lease duration is outside its allowed bound");
    }
  }

  private async mutateWithFingerprint(
    input: { sessionId: string; expectedRevision: number; idempotencyKey: string },
    operation: string,
    operationFingerprint: string,
    apply: (state: DurableAgentSessionState) => void,
    budget: "standard" | "terminal" = "standard",
    validateCurrent?: (state: DurableAgentSessionState) => void,
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<StateMutationResult> {
    const current = await this.required(input.sessionId);
    const prior = current.idempotency.find((entry) => entry.key === input.idempotencyKey);
    if (prior) {
      if (prior.operation !== operation || prior.fingerprint !== operationFingerprint) {
        throw new AgentStateConflictError(`Idempotency key ${input.idempotencyKey} was reused for another mutation`);
      }
      return { state: clone(current), idempotent: true };
    }
    validateCurrent?.(current);
    if (current.revision !== input.expectedRevision) {
      throw new AgentStateConflictError(
        `Agent session ${input.sessionId} expected revision ${input.expectedRevision}, found ${current.revision}`
      );
    }
    const next = clone(current);
    apply(next);
    next.revision = current.revision + 1;
    next.idempotency.push(
      this.idempotencyRecord(input.idempotencyKey, operation, operationFingerprint, next.session.updatedAt)
    );
    next.idempotency = next.idempotency.slice(-this.retention.maxIdempotencyKeys);
    await this.repository.compareAndSwap(
      input.sessionId,
      current.revision,
      this.serializeWithinBudget(next, budget),
      runtimeWorkClaim
    );
    return { state: clone(next), idempotent: false };
  }

  private idempotencyRecord(key: string, operation: string, operationFingerprint: string, recordedAt: string) {
    return {
      schemaVersion: AGENT_SCHEMA_VERSION,
      key,
      operation,
      fingerprint: operationFingerprint,
      recordedAt,
    } as const;
  }

  private approval(state: DurableAgentSessionState, approvalId: string): AgentApproval {
    const approval = state.approvals.find((candidate) => candidate.approvalId === approvalId);
    if (!approval) throw new AgentStateNotFoundError(`approval:${approvalId}`);
    return approval;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery compares and repairs both optional aggregate children under CAS.
  private async resumeInitialAggregate(
    existing: DurableAgentSessionState,
    input: CreateAgentSessionInput,
    initialTask: import("@/lib/agent/state/contracts").AgentTaskRecord | undefined,
    initialTurn: import("@/lib/agent/contracts").AgentTurn | undefined
  ): Promise<StateMutationResult> {
    let current = existing;
    for (let attempt = 0; attempt < 4; attempt++) {
      const storedTask = initialTask
        ? current.tasks.find((candidate) => candidate.taskId === initialTask.taskId)
        : undefined;
      if (
        storedTask &&
        (storedTask.sessionId !== initialTask?.sessionId ||
          storedTask.content !== initialTask.content ||
          storedTask.createdAt !== initialTask.createdAt)
      ) {
        throw new AgentStateConflictError("Initial task ID was reused with different content");
      }
      const storedTurn = initialTurn
        ? current.session.turns.find((candidate) => candidate.turnId === initialTurn.turnId)
        : undefined;
      if (
        storedTurn &&
        (await fingerprint(storedTurn as unknown as JsonValue)) !==
          (await fingerprint(initialTurn as unknown as JsonValue))
      ) {
        throw new AgentStateConflictError("Initial turn ID was reused with different content");
      }
      if ((!initialTask || storedTask) && (!initialTurn || storedTurn)) {
        return { state: clone(current), idempotent: true };
      }

      const repaired = clone(current);
      if (initialTask && !storedTask) repaired.tasks.push(initialTask);
      if (initialTurn && !storedTurn) {
        repaired.session.turns.push({
          ...initialTurn,
          content: redactReasonForPersistence(initialTurn.content),
        });
      }
      repaired.revision = current.revision + 1;
      repaired.session.updatedAt = initialTask?.updatedAt ?? initialTurn?.createdAt ?? repaired.session.updatedAt;
      try {
        await this.repository.compareAndSwap(
          input.session.sessionId,
          current.revision,
          this.serializeWithinBudget(repaired, "standard")
        );
        return { state: clone(repaired), idempotent: true };
      } catch (error) {
        if (!(error instanceof AgentStateConflictError)) throw error;
        current = await this.required(input.session.sessionId);
      }
    }
    throw new AgentStateConflictError("Initial session aggregate repair exceeded its retry bound");
  }

  private serializeWithinBudget(state: DurableAgentSessionState, budget: "standard" | "terminal"): string {
    const limit =
      budget === "terminal"
        ? this.retention.maxSerializedBytes
        : this.retention.maxSerializedBytes - this.retention.reservedTerminalBytes;
    this.compactForByteBudget(state, limit);
    const serialized = serializeAgentSessionState(state);
    if (serializedUtf8Bytes(serialized) > limit) {
      throw new AgentStateConflictError(
        budget === "terminal"
          ? "Agent session aggregate exceeded its terminal byte budget"
          : "Agent session aggregate byte budget is reserved for terminalization"
      );
    }
    return serialized;
  }

  /**
   * Shrinks only replayable context. Authoritative approvals, task records,
   * invocation digests, active proposals, and terminal receipts are never
   * discarded to make room for a new write.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Budget fallback order is intentionally explicit and fail-closed.
  private compactForByteBudget(state: DurableAgentSessionState, limit: number): void {
    this.compactTurns(state);
    this.compactEvents(state);
    state.statusHistory = state.statusHistory.slice(-this.retention.maxStatusTransitions);
    state.idempotency = state.idempotency.slice(-this.retention.maxIdempotencyKeys);

    for (;;) {
      const size = serializedUtf8Bytes(serializeAgentSessionState(state));
      if (size <= limit) return;

      // Keep the newest turn as the immediate continuation context. Older
      // turns are replayable and can be deterministically removed.
      if (state.session.turns.length > 1) {
        state.session.turns.shift();
        continue;
      }

      const firstRemovableEvent = state.events.findIndex((event) => !this.isProtectedEvent(state, event));
      if (firstRemovableEvent === 0) {
        state.events.shift();
        state.retainedFromSequence = state.events[0]?.sequence ?? state.nextEventSequence;
        continue;
      }

      // A protected event can sit before replayable events. Compact those
      // payloads in place rather than creating a sequence gap or dropping the
      // audit-bearing event that the active operation still references.
      const compactable = state.events.find(
        (event) => REPLAYABLE_EVENT_KINDS.has(event.kind) && !this.isProtectedEvent(state, event)
      );
      if (compactable && !this.isCompactedEvent(compactable)) {
        compactable.payload = {
          schemaVersion: AGENT_SCHEMA_VERSION,
          redacted: true,
          data: { compacted: true },
        };
        continue;
      }

      if (state.statusHistory.length > 1) {
        state.statusHistory.shift();
        continue;
      }
      if (state.idempotency.length > 1) {
        state.idempotency.shift();
        continue;
      }
      if (
        state.session.turns.length === 1 &&
        serializedUtf8Bytes(state.session.turns[0].content) > COMPACTED_TURN_CONTENT_BYTES
      ) {
        state.session.turns[0].content = this.compactText(state.session.turns[0].content);
        continue;
      }
      return;
    }
  }

  private compactTurns(state: DurableAgentSessionState): void {
    state.session.turns = state.session.turns.slice(-this.retention.maxTasks);
  }

  private compactEvents(state: DurableAgentSessionState): void {
    while (state.events.length > this.retention.maxEvents) {
      if (this.isProtectedEvent(state, state.events[0])) break;
      state.events.shift();
    }
    state.retainedFromSequence = state.events[0]?.sequence ?? state.nextEventSequence;
  }

  private isProtectedEvent(
    state: DurableAgentSessionState,
    event: DurableAgentSessionState["events"][number]
  ): boolean {
    // The event(s) introduced by the current mutation must remain observable
    // to the caller after serialization and retry handling.
    if (event.sequence === state.nextEventSequence - 1) return true;
    if (event.kind === "tool-proposal") return true;
    if (["backup", "approval", "cancellation", "completion"].includes(event.kind)) return true;
    if (event.kind === "tool-result") {
      const invocationId = event.payload.data.invocationId;
      if (
        typeof invocationId === "string" &&
        state.tasks.some((task) => task.runtimeRecoveries?.some((recovery) => recovery.invocationId === invocationId))
      ) {
        return true;
      }
      const status = event.payload.data.status;
      return status === "indeterminate" || event.payload.data.mutationCommit !== undefined;
    }
    const invocationId = event.payload.data.invocationId;
    if (typeof invocationId !== "string") return false;
    return state.tasks.some(
      (task) =>
        task.activeRuntimeInvocation?.invocationId === invocationId ||
        task.cancellationReconciliation?.invocationId === invocationId ||
        task.invocationAuthorizations?.some((authorization) => authorization.invocationId === invocationId) ||
        state.approvals.some((approval) => approval.invocationSummary.invocationId === invocationId)
    );
  }

  private isCompactedEvent(event: DurableAgentSessionState["events"][number]): boolean {
    return event.payload.data.compacted === true;
  }

  private compactText(value: string): string {
    const marker = "… [truncated]";
    const target = Math.max(1, COMPACTED_TURN_CONTENT_BYTES - serializedUtf8Bytes(marker));
    let result = "";
    for (const character of Array.from(value)) {
      if (serializedUtf8Bytes(result + character) > target) break;
      result += character;
    }
    return `${result}${marker}`;
  }

  private compactTasks(state: DurableAgentSessionState): void {
    while (state.tasks.length > this.retention.maxTasks) {
      const removable = state.tasks.findIndex(
        (candidate) =>
          TERMINAL_TASK_STATUSES.has(candidate.status) &&
          candidate.lease === undefined &&
          candidate.cancellationReconciliation === undefined &&
          (candidate.runtimeRecoveries?.length ?? 0) === 0 &&
          (candidate.invocationAuthorizations?.length ?? 0) === 0
      );
      if (removable < 0) throw new AgentStateConflictError("Task retention is full of active records");
      state.tasks.splice(removable, 1);
    }
  }

  private assertApprovalProposalBinding(state: DurableAgentSessionState, approval: AgentApproval): void {
    const summary = approval.invocationSummary;
    const proposalsWithDigest = state.events.filter(
      (event) => event.kind === "tool-proposal" && typeof event.payload.data.invocationDigest === "string"
    );
    const matching = proposalsWithDigest.find(
      (event) =>
        event.payload.data.invocationId === summary.invocationId &&
        event.payload.data.invocationDigest === summary.invocationDigest &&
        event.payload.data.invocationSummaryDigest === approval.invocationSummaryDigest &&
        event.payload.data.toolId === summary.toolId &&
        event.payload.data.capability === summary.capability
    );
    if (!matching) throw new AgentStateConflictError("Runtime approval digest does not match a persisted proposal");
  }

  private async reconcileExpiredAcknowledgedWork(
    observed: DurableAgentSessionState,
    task: import("@/lib/agent/state/contracts").AgentTaskRecord,
    at: string
  ): Promise<void> {
    const lease = task.lease as AgentWorkLease;
    const reason = "Acknowledged runtime lease expired; manual reconciliation is required.";
    await this.mutate(
      {
        sessionId: observed.session.sessionId,
        expectedRevision: observed.revision,
        idempotencyKey: `runtime-expiry-reconcile:${task.taskId}:${lease.generation}`,
      },
      `runtime-expiry-reconcile:${task.taskId}:${lease.generation}`,
      { taskId: task.taskId, leaseId: lease.leaseId, runtimeId: lease.runtimeId, generation: lease.generation, at },
      (state) => {
        const currentTask = this.task(state, task.taskId);
        if (
          currentTask.lease?.leaseId !== lease.leaseId ||
          currentTask.lease.runtimeId !== lease.runtimeId ||
          currentTask.lease.generation !== lease.generation ||
          Date.parse(currentTask.lease.expiresAt) > Date.parse(at) ||
          (currentTask.status === "pending" && currentTask.lease.acknowledgedAt === undefined)
        ) {
          throw new AgentStateConflictError("Expired runtime work changed before reconciliation");
        }
        for (const candidate of state.tasks) {
          if (!TERMINAL_TASK_STATUSES.has(candidate.status)) candidate.status = "failed";
          candidate.updatedAt = at;
          candidate.lease = undefined;
        }
        this.transitionSessionState(state, "failed", at, reason);
        deactivateApprovals(state, at, reason);
      },
      "terminal"
    );
  }

  private compactApprovals(state: DurableAgentSessionState): void {
    while (state.approvals.length > this.retention.maxApprovals) {
      const removable = state.approvals.findIndex(
        (approval) =>
          approval.decision === "denied" || approval.decision === "cancelled" || approval.decision === "revoked"
      );
      if (removable < 0) throw new AgentStateConflictError("Approval retention is full of active records");
      state.approvals.splice(removable, 1);
    }
  }

  private async load(sessionId: string): Promise<DurableAgentSessionState | null> {
    const record = await this.repository.read(sessionId);
    if (!record) return null;
    const state = deserializeAgentSessionState(record.value);
    if (state.revision !== record.revision)
      throw new AgentStateConflictError("Repository and payload revisions differ");
    return state;
  }

  private async required(sessionId: string): Promise<DurableAgentSessionState> {
    const state = await this.load(sessionId);
    if (!state) throw new AgentStateNotFoundError(sessionId);
    return state;
  }
}

/** @deprecated Use RepositoryAgentSessionStore; retained for existing callers. */
export { RepositoryAgentSessionStore as InMemoryAgentSessionStore };
