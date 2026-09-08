import type { PermissionPolicy } from "@/lib/agent/contracts";
import type { AgentSessionStatus, DurableAgentSessionState } from "@/lib/agent/state/contracts";

const TERMINAL_TASK_STATUSES = new Set(["cancelled", "failed", "completed"]);
const ARCHIVED_SESSION_STATUSES = new Set<AgentSessionStatus>(["idle", "cancelled", "failed", "completed"]);

export interface AgentWorkIndexRecord {
  schemaVersion: 1;
  sessionId: string;
  taskId: string;
  orderAt: string;
  availableAt: string;
  lease?: {
    schemaVersion: 1;
    runtimeId: string;
    claimId: string;
    expiresAt: string;
  };
}

/** Small, separately indexed projection. It never contains turns, task content, events, or approval arguments. */
export interface AgentSessionSummaryRecord {
  schemaVersion: 1;
  sessionId: string;
  actorId: string;
  revision: number;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  policySnapshot: PermissionPolicy;
  taskCount: number;
  pendingApprovalCount: number;
  lastEventSequence: number;
  providerProfileId: string;
  model: string;
  archived: boolean;
  work: AgentWorkIndexRecord | null;
}

export interface AgentWorkCandidateQuery {
  runtimeId: string;
  claimId: string;
  now: string;
  limit: number;
}

/** Opaque coordinator grant authorizing one exact shard revision to acquire a lease. */
export interface AgentRuntimeWorkClaim {
  schemaVersion: 1;
  token: string;
  runtimeId: string;
  claimId: string;
  sessionId: string;
  taskId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
}

export function projectAgentSessionSummary(state: DurableAgentSessionState): AgentSessionSummaryRecord {
  const activeTask = state.tasks.find((task) => !TERMINAL_TASK_STATUSES.has(task.status));
  const work = activeTask
    ? activeTask.status === "pending" || activeTask.lease
      ? {
          schemaVersion: 1 as const,
          sessionId: state.session.sessionId,
          taskId: activeTask.taskId,
          orderAt: activeTask.createdAt,
          availableAt: activeTask.lease?.expiresAt ?? activeTask.createdAt,
          ...(activeTask.lease
            ? {
                lease: {
                  schemaVersion: 1 as const,
                  runtimeId: activeTask.lease.runtimeId,
                  claimId: activeTask.lease.claimId,
                  expiresAt: activeTask.lease.expiresAt,
                },
              }
            : {}),
        }
      : null
    : null;

  return {
    schemaVersion: 1,
    sessionId: state.session.sessionId,
    actorId: state.session.actorId,
    revision: state.revision,
    status: state.session.status,
    createdAt: state.session.createdAt,
    updatedAt: state.session.updatedAt,
    policySnapshot: state.policySnapshot,
    taskCount: state.tasks.length,
    pendingApprovalCount: state.approvals.filter((approval) => approval.decision === "pending").length,
    lastEventSequence: state.nextEventSequence - 1,
    providerProfileId: state.session.harness.providerProfileId,
    model: state.session.harness.model,
    archived: ARCHIVED_SESSION_STATUSES.has(state.session.status),
    work,
  };
}

export function orderedWorkCandidateSessionIds(
  workRecords: Iterable<AgentWorkIndexRecord>,
  query: AgentWorkCandidateQuery
): string[] {
  const now = Date.parse(query.now);
  const candidates = Array.from(workRecords).filter((work) => {
    if (work.lease?.runtimeId === query.runtimeId && work.lease.claimId === query.claimId) return true;
    return Date.parse(work.availableAt) <= now;
  });
  candidates.sort((left, right) => {
    const leftClaim = left.lease?.runtimeId === query.runtimeId && left.lease.claimId === query.claimId;
    const rightClaim = right.lease?.runtimeId === query.runtimeId && right.lease.claimId === query.claimId;
    if (leftClaim !== rightClaim) return leftClaim ? -1 : 1;
    return left.orderAt.localeCompare(right.orderAt) || left.sessionId.localeCompare(right.sessionId);
  });
  return candidates.slice(0, query.limit).map((work) => work.sessionId);
}
