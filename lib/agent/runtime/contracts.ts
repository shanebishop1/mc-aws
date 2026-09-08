import type {
  AgentApproval,
  AgentCapability,
  AgentEvent,
  AgentSession,
  AgentTurn,
  BackupFenceAuthorization,
  BackupTerminalReceipt,
  InvocationAuthorization,
  PermissionPolicy,
  RiskClass,
  TargetScope,
  TerminalPublicationAuthorization,
} from "@/lib/agent/contracts";
import type {
  AgentTaskRecord,
  AgentWorkLease,
  RuntimeAgentEventDraft,
  RuntimeRecoveryPublicationInput,
  RuntimeWorkAssignment,
} from "@/lib/agent/state";

export const RUNTIME_API_SCHEMA_VERSION = 1 as const;

export interface RuntimeWorkLeaseRequest {
  schemaVersion: 1;
  claimId: string;
  leaseDurationMs: number;
  waitMs: number;
}

export interface RuntimeWorkLeaseDto {
  schemaVersion: 1;
  revision: number;
  providerProfileFingerprint: string;
  session: AgentSession;
  /** Number of historical turns omitted from the bounded lease context. */
  sessionSummary?: RuntimeSessionSummary;
  policySnapshot: PermissionPolicy;
  task: AgentTaskRecord;
  approvals: AgentApproval[];
  lease: AgentWorkLease;
}

export interface RuntimeSessionSummary {
  schemaVersion: 1;
  omittedTurnCount: number;
  retainedTurnCount: number;
  retainedTurnBytes: number;
}

export interface RuntimeLeaseMutationRequest {
  schemaVersion: 1;
  sessionId: string;
  taskId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface RuntimeRenewRequest extends RuntimeLeaseMutationRequest {
  leaseDurationMs: number;
}

export interface RuntimeEventPublicationRequest extends RuntimeLeaseMutationRequest {
  drafts: RuntimeAgentEventDraft[];
}

/** Terminal-only recovery publication; it carries no execution authority. */
export type RuntimeRecoveryPublicationRequest = Omit<RuntimeRecoveryPublicationInput, "at"> & { schemaVersion: 1 };

export interface RuntimeRecoveryPublicationResult {
  schemaVersion: 1;
  revision: number;
  event: AgentEvent;
  acknowledgementAuthorization?: TerminalPublicationAuthorization;
}

export interface RuntimeApprovalPublicationRequest extends RuntimeLeaseMutationRequest {
  approval: AgentApproval;
}

export interface RuntimeStatusPublicationRequest extends RuntimeLeaseMutationRequest {
  status: "running" | "waiting-approval" | "completed" | "failed" | "cancelled";
  reason: string;
  assistantTurn?: AgentTurn;
}

export interface RuntimeApprovalConsumptionRequest extends RuntimeLeaseMutationRequest {
  approvalId: string;
  invocationDigest: string;
}

export interface RuntimeInvocationAuthorizationRequest extends RuntimeLeaseMutationRequest {
  authorizationId: string;
  invocationId: string;
  invocationDigest: string;
  approvalId: string;
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
}

export interface RuntimeInvocationAuthorizationResult {
  schemaVersion: 1;
  revision: number;
  authorization: InvocationAuthorization;
}

export interface RuntimeDecisionPollRequest {
  schemaVersion: 1;
  sessionId: string;
  taskId: string;
  afterRevision: number;
  waitMs: number;
}

export interface RuntimeDecisionSnapshot {
  schemaVersion: 1;
  revision: number;
  sessionStatus: AgentSession["status"];
  taskStatus: AgentTaskRecord["status"];
  leaseGeneration?: number;
  runtimeEventOrdinal: number;
  activeRuntimeInvocation?: AgentTaskRecord["activeRuntimeInvocation"];
  approvals: AgentApproval[];
  cancellation?: { schemaVersion: 1; requestedAt: string };
}

export interface RuntimeEventPublicationResult {
  schemaVersion: 1;
  revision: number;
  events: AgentEvent[];
}

export interface RuntimeBackupAvailabilityRequest {
  schemaVersion: 1;
  action: "availability";
}

export interface RuntimeBackupCreateRequest {
  schemaVersion: 1;
  action: "create";
  leaseId: string;
  leaseGeneration: number;
  sessionId: string;
  taskId: string;
  invocationId: string;
  invocationDigest: string;
}

export type RuntimeBackupFinalOutcome = "committed" | "failed" | "cancelled" | "indeterminate";

export interface RuntimeBackupFinalizeRequest {
  schemaVersion: 1;
  action: "finalize";
  authorization: BackupFenceAuthorization;
  outcome: RuntimeBackupFinalOutcome;
  terminalReceipt?: BackupTerminalReceipt;
}

export interface RuntimeBackupRenewRequest {
  schemaVersion: 1;
  action: "renew";
  authorization: BackupFenceAuthorization;
}

export type RuntimeBackupRequest =
  | RuntimeBackupAvailabilityRequest
  | RuntimeBackupCreateRequest
  | RuntimeBackupRenewRequest
  | RuntimeBackupFinalizeRequest;

export interface RuntimeBackupAvailabilityResult {
  schemaVersion: 1;
  availability: "available" | "unavailable";
}

export interface RuntimeBackupResult {
  schemaVersion: 1;
  status: "pending" | "succeeded" | "failed" | "unavailable" | "cancelled" | "ambiguous";
  leaseId: string;
  leaseGeneration: number;
  sessionId: string;
  taskId: string;
  invocationId: string;
  invocationDigest: string;
  backupId?: string;
  createdAt?: string;
  fenceAuthorization?: BackupFenceAuthorization;
}

export interface RuntimeBackupFinalizeResult {
  schemaVersion: 1;
  authorizationId: string;
  status: "finalized" | "expired" | "reconciliation-needed";
  released: boolean;
}

export interface RuntimeBackupRenewResult {
  schemaVersion: 1;
  authorizationId: string;
  status: "renewed" | "lost";
  authorization?: BackupFenceAuthorization;
}

/** The executor's response reader rejects anything at or above this gateway ceiling. */
export const RUNTIME_GATEWAY_RESPONSE_MAX_BYTES = 256_000;
/** Includes the success envelope and timestamp, not merely the work DTO. */
export const RUNTIME_WORK_RESPONSE_MAX_BYTES = 240_000;
export const RUNTIME_WORK_SESSION_CONTEXT_MAX_BYTES = 64_000;
export const RUNTIME_WORK_SESSION_CONTEXT_MAX_TURNS = 128;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedSession(session: AgentSession): {
  session: AgentSession;
  summary: RuntimeSessionSummary;
} {
  const retained: AgentSession["turns"] = [];
  let retainedBytes = 0;
  for (
    let index = session.turns.length - 1;
    index >= 0 && retained.length < RUNTIME_WORK_SESSION_CONTEXT_MAX_TURNS;
    index--
  ) {
    const turn = session.turns[index];
    const turnBytes = utf8Bytes(JSON.stringify(turn));
    if (retainedBytes + turnBytes > RUNTIME_WORK_SESSION_CONTEXT_MAX_BYTES) break;
    retained.unshift(turn);
    retainedBytes += turnBytes;
  }
  const bounded = { ...structuredClone(session), turns: structuredClone(retained) };
  return {
    session: bounded,
    summary: {
      schemaVersion: 1,
      omittedTurnCount: session.turns.length - retained.length,
      retainedTurnCount: retained.length,
      retainedTurnBytes: retainedBytes,
    },
  };
}

/** Validates the complete runtime success envelope before a lease is persisted. */
export class RuntimeWorkResponseSizeError extends Error {
  constructor() {
    super("Runtime work lease exceeds its encoded response budget");
    this.name = "RuntimeWorkResponseSizeError";
  }
}

export function assertEncodedRuntimeWorkLease(work: RuntimeWorkLeaseDto): void {
  const encoded = JSON.stringify({
    success: true,
    data: work,
    // The production response uses an ISO timestamp of this exact encoded size.
    timestamp: "2099-09-02T12:00:00.000Z",
  });
  if (utf8Bytes(encoded) > RUNTIME_WORK_RESPONSE_MAX_BYTES) {
    throw new RuntimeWorkResponseSizeError();
  }
}

export function projectRuntimeWork(assignment: RuntimeWorkAssignment): RuntimeWorkLeaseDto {
  const bounded = boundedSession(assignment.session);
  const work: RuntimeWorkLeaseDto = {
    schemaVersion: 1,
    revision: assignment.revision,
    providerProfileFingerprint: assignment.providerProfileFingerprint,
    session: bounded.session,
    sessionSummary: bounded.summary,
    policySnapshot: structuredClone(assignment.policySnapshot),
    task: structuredClone(assignment.task),
    approvals: structuredClone(assignment.approvals),
    lease: structuredClone(assignment.lease),
  };
  assertEncodedRuntimeWorkLease(work);
  return work;
}
