import type {
  AgentApproval,
  AgentCapability,
  AgentEvent,
  AgentSession,
  BackupMode,
  CapabilityRule,
  JsonObject,
  PermissionPolicy,
  PermissionPresetName,
  RiskClass,
  TargetScope,
} from "@/lib/agent/contracts";
import { redactSecretAwareJson, redactSensitiveText } from "@/lib/agent/redaction";
import type { AgentTaskStatus, DurableAgentSessionState } from "@/lib/agent/state";
import type { AgentSessionSummaryRecord } from "@/lib/agent/state/repository-metadata";

export interface PublicAgentPolicyDto {
  schemaVersion: 1;
  policyId: string;
  revision: number;
  preset: PermissionPresetName;
  rules: CapabilityRule[];
  backupMode: BackupMode;
}

export interface PublicAgentSessionSummaryDto {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  status: AgentSession["status"];
  createdAt: string;
  updatedAt: string;
  policy: PublicAgentPolicyDto;
  taskCount: number;
  pendingApprovalCount: number;
  lastEventSequence: number;
  providerProfileId: string;
  model: string;
}

export interface PublicAgentTaskDto {
  schemaVersion: 1;
  taskId: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAgentApprovalDto {
  schemaVersion: 1;
  approvalId: string;
  invocationId: string;
  invocationDigest: string;
  invocationSummaryDigest: string;
  toolId: string;
  sanitizedArguments: JsonObject;
  diffSummary?: string;
  backupFailureStatus?: "failed" | "unavailable";
  decision: AgentApproval["decision"];
  scope: {
    schemaVersion: 1;
    kind: "single-invocation" | "session-capability";
    capability: AgentCapability;
    targetScope: TargetScope;
    risk: RiskClass;
  };
  expiresAt: string;
  grantLifetime: "single-invocation" | "until-session-end-or-expiry";
  decidedAt?: string;
  consumedAt?: string;
}

export interface PublicAgentSessionDetailDto extends PublicAgentSessionSummaryDto {
  tasks: PublicAgentTaskDto[];
  approvals: PublicAgentApprovalDto[];
  cancellation?: { schemaVersion: 1; requestedAt: string };
}

export interface CreateAgentSessionRequestDto {
  schemaVersion: 1;
  expectedRevision: 0;
  idempotencyKey: string;
  task: string;
  providerProfileId: string;
  model: string;
  policy: {
    schemaVersion: 1;
    preset: PermissionPresetName;
    rules: CapabilityRule[];
    backupMode: BackupMode;
  };
}

export interface AgentRevisionMutationRequestDto {
  schemaVersion: 1;
  expectedRevision: number;
  idempotencyKey: string;
  reason?: string;
}

export interface ContinueAgentSessionRequestDto {
  schemaVersion: 1;
  expectedRevision: number;
  idempotencyKey: string;
  task: string;
  providerProfileId: string;
  model: string;
}

export interface AgentApprovalDecisionRequestDto extends AgentRevisionMutationRequestDto {
  decision: "approve" | "deny";
}

export function projectPolicy(policy: PermissionPolicy): PublicAgentPolicyDto {
  return {
    schemaVersion: 1,
    policyId: policy.policyId,
    revision: policy.revision,
    preset: policy.preset,
    rules: policy.rules.map((rule) => ({ ...rule })),
    backupMode: policy.backupMode,
  };
}

export function projectSessionSummary(state: DurableAgentSessionState): PublicAgentSessionSummaryDto {
  return {
    schemaVersion: 1,
    sessionId: state.session.sessionId,
    revision: state.revision,
    status: state.session.status,
    createdAt: state.session.createdAt,
    updatedAt: state.session.updatedAt,
    policy: projectPolicy(state.policySnapshot),
    taskCount: state.tasks.length,
    pendingApprovalCount: state.approvals.filter((approval) => approval.decision === "pending").length,
    lastEventSequence: state.nextEventSequence - 1,
    providerProfileId: state.session.harness.providerProfileId,
    model: state.session.harness.model,
  };
}

export function projectStoredSessionSummary(summary: AgentSessionSummaryRecord): PublicAgentSessionSummaryDto {
  return {
    schemaVersion: 1,
    sessionId: summary.sessionId,
    revision: summary.revision,
    status: summary.status,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    policy: projectPolicy(summary.policySnapshot),
    taskCount: summary.taskCount,
    pendingApprovalCount: summary.pendingApprovalCount,
    lastEventSequence: summary.lastEventSequence,
    providerProfileId: summary.providerProfileId,
    model: summary.model,
  };
}

export function projectSessionDetail(state: DurableAgentSessionState): PublicAgentSessionDetailDto {
  return {
    ...projectSessionSummary(state),
    tasks: state.tasks.map(({ taskId, status, createdAt, updatedAt }) => ({
      schemaVersion: 1,
      taskId,
      status,
      createdAt,
      updatedAt,
    })),
    approvals: state.approvals.map(
      ({
        approvalId,
        invocationDigest,
        invocationSummaryDigest,
        invocationSummary,
        decision,
        scope,
        expiresAt,
        decidedAt,
        consumedAt,
      }) => ({
        schemaVersion: 1,
        approvalId,
        invocationId: invocationSummary.invocationId,
        invocationDigest,
        invocationSummaryDigest,
        toolId: invocationSummary.toolId,
        sanitizedArguments: redactSecretAwareJson(invocationSummary.sanitizedArguments),
        ...(invocationSummary.diffSummary ? { diffSummary: redactSensitiveText(invocationSummary.diffSummary) } : {}),
        ...(invocationSummary.backupFailureStatus
          ? { backupFailureStatus: invocationSummary.backupFailureStatus }
          : {}),
        decision,
        scope: {
          schemaVersion: 1,
          kind: scope.kind,
          capability: scope.capability,
          targetScope: { ...scope.targetScope },
          risk: scope.risk,
        },
        expiresAt,
        grantLifetime: scope.kind === "single-invocation" ? "single-invocation" : "until-session-end-or-expiry",
        ...(decidedAt ? { decidedAt } : {}),
        ...(consumedAt ? { consumedAt } : {}),
      })
    ),
    ...(state.cancellation
      ? { cancellation: { schemaVersion: 1 as const, requestedAt: state.cancellation.requestedAt } }
      : {}),
  };
}

export function projectAgentEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    payload: { ...event.payload, data: structuredClone(event.payload.data) },
  };
}
