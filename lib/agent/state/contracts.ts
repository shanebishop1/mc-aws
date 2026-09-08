import type {
  AgentApproval,
  AgentCapability,
  AgentEvent,
  AgentEventKind,
  AgentSession,
  AgentTurn,
  ApprovalDecision,
  BackupTerminalReceipt,
  HarnessMetadata,
  InvocationAuthorization,
  JsonObject,
  PermissionPolicy,
  TargetScope,
} from "@/lib/agent/contracts";
import type {
  AgentRuntimeWorkClaim,
  AgentSessionSummaryRecord,
  AgentWorkCandidateQuery,
} from "@/lib/agent/state/repository-metadata";

export type AgentSessionStatus = AgentSession["status"];
export type AgentTaskStatus = "pending" | "running" | "waiting-approval" | "cancelled" | "failed" | "completed";

export interface AgentSessionStatusTransition {
  schemaVersion: 1;
  from: AgentSessionStatus | null;
  to: AgentSessionStatus;
  at: string;
  reason: string;
}

export interface AgentTaskRecord {
  schemaVersion: 1;
  taskId: string;
  sessionId: string;
  status: AgentTaskStatus;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** Last gateway draft ordinal accepted for this task. Never exposed by the public projection. */
  runtimeEventOrdinal?: number;
  /** One fenced outbound-runtime lease. Never exposed by the public projection. */
  lease?: AgentWorkLease;
  /** One-use terminal receipt for a result that races with cancellation. Never exposed publicly. */
  cancellationReconciliation?: AgentCancellationReconciliation;
  /** Bounded exact invocation authorizations issued by the authoritative store. */
  invocationAuthorizations?: InvocationAuthorization[];
  /** The single task-scoped invocation whose proposal was durably published and has no result yet. */
  activeRuntimeInvocation?: AgentActiveRuntimeInvocation;
  /** Latest authenticated terminal publication retained for acknowledgement retry. */
  runtimeRecoveries?: AgentRuntimeRecovery[];
}

export interface AgentRuntimeRecovery {
  schemaVersion: 1;
  runtimeId: string;
  sessionId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  journalSequence: number;
  /** Digest of the original executor result, before central persistence redaction. */
  resultDigest: string;
  /** Digest of the separately persisted, centrally redacted result payload. */
  persistedResultDigest: string;
  outcome: "committed" | "failed" | "cancelled" | "indeterminate";
  result: import("@/lib/agent/contracts").ToolResult;
  terminalReceipt: BackupTerminalReceipt;
  /** Immutable task projection at the publication revision. */
  taskStatus: "completed" | "failed" | "cancelled";
  /** Immutable session projection at the publication revision. */
  sessionStatus: "idle" | "completed" | "failed" | "cancelled";
  publishedAt: string;
  publicationRevision: number;
}

export interface AgentActiveRuntimeInvocation {
  schemaVersion: 1;
  runtimeId: string;
  sessionId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  capability: AgentCapability;
  targetScope: TargetScope;
  proposalOrdinal: number;
}

export interface AgentWorkLease {
  schemaVersion: 1;
  leaseId: string;
  claimId: string;
  runtimeId: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  acknowledgedAt?: string;
}

export interface AgentCancellationReconciliation {
  schemaVersion: 1;
  leaseId: string;
  runtimeId: string;
  generation: number;
  invocationId: string;
  invocationDigest: string;
  nextOrdinal: number;
  expiresAt: string;
  consumedAt?: string;
  resultDraftId?: string;
}

export interface RuntimeAgentEventDraft {
  schemaVersion: 1;
  draftId: string;
  ordinal: number;
  timestamp: string;
  kind: AgentEventKind;
  payload: JsonObject;
}

export interface RuntimeWorkAssignment {
  schemaVersion: 1;
  revision: number;
  providerProfileFingerprint: string;
  session: AgentSession;
  policySnapshot: PermissionPolicy;
  task: AgentTaskRecord;
  approvals: AgentApproval[];
  lease: AgentWorkLease;
}

export interface AgentCancellationState {
  schemaVersion: 1;
  requestedAt: string;
  requestedBy: string;
  reason: string;
}

export interface AgentStateIdempotencyRecord {
  schemaVersion: 1;
  key: string;
  operation: string;
  fingerprint: string;
  recordedAt: string;
}

/**
 * Versioned, JSON-only authoritative session aggregate. A Durable Object can
 * persist this value as one CAS-protected record; KV may cache it but must not
 * be treated as authoritative for events or approvals.
 */
export interface DurableAgentSessionState {
  schemaVersion: 1;
  revision: number;
  session: AgentSession;
  /** Immutable policy selected when the session was created. */
  policySnapshot: PermissionPolicy;
  statusHistory: AgentSessionStatusTransition[];
  tasks: AgentTaskRecord[];
  approvals: AgentApproval[];
  cancellation?: AgentCancellationState;
  events: AgentEvent[];
  nextEventSequence: number;
  retainedFromSequence: number;
  idempotency: AgentStateIdempotencyRecord[];
}

export interface VersionedAgentStateRecord {
  revision: number;
  value: string;
}

/** Minimal persistence boundary required from a Durable Object or equivalent. */
export interface AgentStateRepository {
  read(sessionId: string): Promise<VersionedAgentStateRecord | null>;
  list(limit: number): Promise<VersionedAgentStateRecord[]>;
  listSummaries(limit: number, actorId?: string): Promise<AgentSessionSummaryRecord[]>;
  listWorkCandidateSessionIds(query: AgentWorkCandidateQuery): Promise<string[]>;
  /** Atomically grants one runtime-wide claim bound to one exact shard revision. */
  claimRuntimeWorkCandidate(
    query: AgentWorkCandidateQuery & { claimDurationMs: number }
  ): Promise<AgentRuntimeWorkClaim | null>;
  releaseRuntimeWorkClaim(claim: AgentRuntimeWorkClaim): Promise<void>;
  /** Extends the same coordinator token before the authoritative shard lease is renewed. */
  renewRuntimeWorkClaim(input: {
    runtimeId: string;
    claimId: string;
    sessionId: string;
    taskId: string;
    now: string;
    expiresAt: string;
  }): Promise<void>;
  /** Durably suppresses one exact unleaseable revision without hiding later revisions. */
  quarantineWorkCandidate(input: {
    sessionId: string;
    revision: number;
    reason: "runtime-response-over-budget" | "migration-merge-over-budget";
  }): Promise<void>;
  create(sessionId: string, value: string): Promise<void>;
  compareAndSwap(
    sessionId: string,
    expectedRevision: number,
    value: string,
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<void>;
  waitForRevision(
    sessionId: string,
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ changed: boolean; revision: number | null }>;
}

export interface AgentStateRetention {
  maxEvents: number;
  maxTasks: number;
  maxStatusTransitions: number;
  maxApprovals: number;
  maxIdempotencyKeys: number;
  /** Hard UTF-8 JSON aggregate bound, kept below the Durable Object transport limit. */
  maxSerializedBytes: number;
  /** Capacity unavailable to ordinary growth so cancellation/failure can still be persisted. */
  reservedTerminalBytes: number;
}

export interface StateMutationResult {
  state: DurableAgentSessionState;
  idempotent: boolean;
}

export interface AppendAgentEventInput {
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  eventId: string;
  timestamp: string;
  kind: AgentEventKind;
  payload: JsonObject;
}

export interface AgentEventReplay {
  events: AgentEvent[];
  cursor: string;
  retainedFromSequence: number;
  truncated: boolean;
}

export interface AgentEventWait extends AgentEventReplay {
  timedOut: boolean;
  terminal: boolean;
}

export interface CreateAgentSessionInput {
  session: AgentSession;
  policySnapshot: PermissionPolicy;
  /** Created in the same authoritative aggregate write as the session and policy. */
  initialTask?: AgentTaskRecord;
  initialTurn?: AgentTurn;
  idempotencyKey?: string;
  /** Optional digest of the unredacted public create DTO; raw content is never persisted. */
  requestFingerprint?: string;
}

export interface AddAgentTaskInput {
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  task: AgentTaskRecord;
  turn?: AgentTurn;
  harness?: HarnessMetadata;
}

export interface PutAgentApprovalInput {
  sessionId: string;
  expectedRevision: number;
  idempotencyKey: string;
  approval: AgentApproval;
}

export interface AgentSessionStateStore {
  createSession(input: CreateAgentSessionInput): Promise<StateMutationResult>;
  getSession(sessionId: string): Promise<DurableAgentSessionState | null>;
  listSessions(limit?: number): Promise<DurableAgentSessionState[]>;
  listSessionSummaries(limit?: number, actorId?: string): Promise<AgentSessionSummaryRecord[]>;
  resumeSession(sessionId: string): Promise<DurableAgentSessionState | null>;
  transitionSession(input: {
    sessionId: string;
    expectedRevision: number;
    idempotencyKey: string;
    status: AgentSessionStatus;
    at: string;
    reason: string;
  }): Promise<StateMutationResult>;
  appendEvent(input: AppendAgentEventInput): Promise<StateMutationResult & { event: AgentEvent }>;
  replayEvents(sessionId: string, afterCursor?: string, limit?: number): Promise<AgentEventReplay>;
  waitForEvents(
    sessionId: string,
    afterCursor: string | undefined,
    limit: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AgentEventWait>;
  addTask(input: AddAgentTaskInput): Promise<StateMutationResult>;
  transitionTask(input: {
    sessionId: string;
    taskId: string;
    expectedRevision: number;
    idempotencyKey: string;
    status: AgentTaskStatus;
    at: string;
  }): Promise<StateMutationResult>;
  putApproval(input: PutAgentApprovalInput): Promise<StateMutationResult>;
  decideApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    decision: Exclude<ApprovalDecision, "pending" | "revoked">;
    reason: string;
    at: string;
  }): Promise<StateMutationResult>;
  consumeApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    invocationDigest: string;
    at: string;
  }): Promise<StateMutationResult>;
  revokeApproval(input: {
    sessionId: string;
    approvalId: string;
    expectedRevision: number;
    idempotencyKey: string;
    reason: string;
    at: string;
  }): Promise<StateMutationResult>;
  cancelSession(input: {
    sessionId: string;
    expectedRevision: number;
    idempotencyKey: string;
    requestedAt: string;
    requestedBy: string;
    reason: string;
  }): Promise<StateMutationResult>;
  leaseNextRuntimeWork(input: {
    runtimeId: string;
    claimId: string;
    leaseId: string;
    now: string;
    leaseDurationMs: number;
  }): Promise<RuntimeWorkAssignment | null>;
  acknowledgeRuntimeWork(input: RuntimeLeaseMutationInput & { at: string }): Promise<StateMutationResult>;
  renewRuntimeWork(
    input: RuntimeLeaseMutationInput & { at: string; leaseDurationMs: number }
  ): Promise<StateMutationResult>;
  publishRuntimeEvents(
    input: RuntimeLeaseMutationInput & {
      at: string;
      drafts: RuntimeAgentEventDraft[];
    }
  ): Promise<StateMutationResult & { events: AgentEvent[] }>;
  publishRuntimeRecovery(input: RuntimeRecoveryPublicationInput): Promise<StateMutationResult & { event: AgentEvent }>;
  putRuntimeApproval(
    input: RuntimeLeaseMutationInput & {
      at: string;
      approval: AgentApproval;
    }
  ): Promise<StateMutationResult>;
  consumeRuntimeApproval(
    input: RuntimeLeaseMutationInput & {
      at: string;
      approvalId: string;
      invocationDigest: string;
    }
  ): Promise<StateMutationResult>;
  authorizeRuntimeInvocation(
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
  ): Promise<StateMutationResult & { authorization: InvocationAuthorization }>;
  setRuntimeStatus(
    input: RuntimeLeaseMutationInput & {
      at: string;
      status: "running" | "waiting-approval" | "completed" | "failed" | "cancelled";
      reason: string;
      assistantTurn?: AgentTurn;
    }
  ): Promise<StateMutationResult>;
  waitForRuntimeState(
    input: Omit<RuntimeLeaseMutationInput, "expectedRevision" | "idempotencyKey"> & {
      afterRevision: number;
      timeoutMs: number;
    },
    signal?: AbortSignal
  ): Promise<DurableAgentSessionState>;
}

export interface RuntimeLeaseMutationInput {
  sessionId: string;
  taskId: string;
  leaseId: string;
  runtimeId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

/** Terminal-only publication authority. It never renews or creates a work lease. */
export interface RuntimeRecoveryPublicationInput {
  sessionId: string;
  taskId: string;
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  journalSequence: number;
  resultDigest: string;
  result: import("@/lib/agent/contracts").ToolResult;
  terminalReceipt: BackupTerminalReceipt;
  idempotencyKey: string;
  at: string;
}

export class AgentStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateConflictError";
  }
}

export class AgentStateNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Agent session ${sessionId} was not found`);
    this.name = "AgentStateNotFoundError";
  }
}

export class AgentStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateTransitionError";
  }
}

export class AgentStateReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateReplayError";
  }
}
