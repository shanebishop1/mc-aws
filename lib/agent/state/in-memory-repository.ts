import { AgentStateConflictError, type AgentStateRepository } from "@/lib/agent/state/contracts";
import {
  type AgentRuntimeWorkClaim,
  type AgentWorkCandidateQuery,
  orderedWorkCandidateSessionIds,
  projectAgentSessionSummary,
} from "@/lib/agent/state/repository-metadata";
import { deserializeAgentSessionState } from "@/lib/agent/state/serialization";

/** Deterministic process-local CAS repository used by mock mode and tests. */
export class InMemoryAgentStateRepository implements AgentStateRepository {
  private readonly records = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly workQuarantines = new Map<string, number>();
  private readonly runtimeClaims = new Map<string, AgentRuntimeWorkClaim>();

  async read(sessionId: string) {
    const value = this.records.get(sessionId);
    if (value === undefined) return null;
    return { revision: deserializeAgentSessionState(value).revision, value };
  }

  async list(limit: number) {
    return Array.from(this.records.values())
      .map((value) => ({ revision: deserializeAgentSessionState(value).revision, value }))
      .sort((left, right) => {
        const leftState = deserializeAgentSessionState(left.value);
        const rightState = deserializeAgentSessionState(right.value);
        return rightState.session.updatedAt.localeCompare(leftState.session.updatedAt);
      })
      .slice(0, limit);
  }

  async listSummaries(limit: number, actorId?: string) {
    return this.summaries()
      .filter((summary) => actorId === undefined || summary.actorId === actorId)
      .sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId)
      )
      .slice(0, limit);
  }

  async listWorkCandidateSessionIds(query: AgentWorkCandidateQuery): Promise<string[]> {
    return orderedWorkCandidateSessionIds(
      this.summaries().flatMap((summary) =>
        summary.work && this.workQuarantines.get(summary.sessionId) !== summary.revision ? [summary.work] : []
      ),
      query
    );
  }

  async claimRuntimeWorkCandidate(
    query: AgentWorkCandidateQuery & { claimDurationMs: number }
  ): Promise<AgentRuntimeWorkClaim | null> {
    const now = Date.parse(query.now);
    const existing = this.runtimeClaims.get(query.runtimeId);
    if (existing) {
      const stateValue = this.records.get(existing.sessionId);
      const state = stateValue ? deserializeAgentSessionState(stateValue) : undefined;
      const task = state?.tasks.find((candidate) => candidate.taskId === existing.taskId);
      const stillOwned =
        Date.parse(existing.expiresAt) > now &&
        task?.lease?.runtimeId === existing.runtimeId &&
        task.lease.claimId === existing.claimId &&
        Date.parse(task.lease.expiresAt) > now;
      const stillAcquiring =
        Date.parse(existing.expiresAt) > now && state?.revision === existing.revision && task?.status === "pending";
      if (stillOwned || stillAcquiring) return existing.claimId === query.claimId ? structuredClone(existing) : null;
      this.runtimeClaims.delete(query.runtimeId);
    }
    const sessionId = (await this.listWorkCandidateSessionIds({ ...query, limit: 1 }))[0];
    if (!sessionId) return null;
    const value = this.records.get(sessionId);
    if (!value) return null;
    const state = deserializeAgentSessionState(value);
    const task = state.tasks.find((candidate) => candidate.taskId === projectAgentSessionSummary(state).work?.taskId);
    if (!task) return null;
    const claim: AgentRuntimeWorkClaim = {
      schemaVersion: 1,
      token: `claim-token-${crypto.randomUUID()}`,
      runtimeId: query.runtimeId,
      claimId: query.claimId,
      sessionId,
      taskId: task.taskId,
      revision: state.revision,
      issuedAt: query.now,
      expiresAt: new Date(now + query.claimDurationMs).toISOString(),
    };
    this.runtimeClaims.set(query.runtimeId, claim);
    return structuredClone(claim);
  }

  async releaseRuntimeWorkClaim(claim: AgentRuntimeWorkClaim): Promise<void> {
    if (this.runtimeClaims.get(claim.runtimeId)?.token === claim.token) this.runtimeClaims.delete(claim.runtimeId);
  }

  async renewRuntimeWorkClaim(input: {
    runtimeId: string;
    claimId: string;
    sessionId: string;
    taskId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    const claim = this.runtimeClaims.get(input.runtimeId);
    if (
      !claim ||
      claim.claimId !== input.claimId ||
      claim.sessionId !== input.sessionId ||
      claim.taskId !== input.taskId ||
      Date.parse(claim.expiresAt) <= Date.parse(input.now) ||
      Date.parse(input.expiresAt) <= Date.parse(input.now)
    ) {
      throw new AgentStateConflictError("Runtime lease renewal lacks its coordinator claim");
    }
    this.runtimeClaims.set(input.runtimeId, { ...claim, expiresAt: input.expiresAt });
  }

  async quarantineWorkCandidate(input: { sessionId: string; revision: number }): Promise<void> {
    const value = this.records.get(input.sessionId);
    if (value && deserializeAgentSessionState(value).revision === input.revision) {
      this.workQuarantines.set(input.sessionId, input.revision);
    }
  }

  async create(sessionId: string, value: string): Promise<void> {
    if (this.records.has(sessionId)) throw new AgentStateConflictError(`Agent session ${sessionId} already exists`);
    const state = deserializeAgentSessionState(value);
    if (state.session.sessionId !== sessionId || state.revision !== 1) {
      throw new AgentStateConflictError("Initial agent state must match its key and start at revision 1");
    }
    this.records.set(sessionId, value);
    this.workQuarantines.delete(sessionId);
    this.notify(sessionId);
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: number,
    value: string,
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<void> {
    const current = this.records.get(sessionId);
    if (current === undefined || deserializeAgentSessionState(current).revision !== expectedRevision) {
      throw new AgentStateConflictError(`Agent session ${sessionId} revision conflict`);
    }
    const next = deserializeAgentSessionState(value);
    if (next.session.sessionId !== sessionId || next.revision !== expectedRevision + 1) {
      throw new AgentStateConflictError("Agent state CAS writes must increment one matching session revision");
    }
    const currentState = deserializeAgentSessionState(current);
    const acquiredLease = next.tasks.find((task) => {
      const prior = currentState.tasks.find((candidate) => candidate.taskId === task.taskId);
      return task.lease && (!prior?.lease || task.lease.leaseId !== prior.lease.leaseId);
    });
    if (acquiredLease) {
      const authoritative = runtimeWorkClaim && this.runtimeClaims.get(runtimeWorkClaim.runtimeId);
      if (
        !runtimeWorkClaim ||
        authoritative?.token !== runtimeWorkClaim.token ||
        runtimeWorkClaim.sessionId !== sessionId ||
        runtimeWorkClaim.taskId !== acquiredLease.taskId ||
        runtimeWorkClaim.revision !== expectedRevision ||
        acquiredLease.lease?.runtimeId !== runtimeWorkClaim.runtimeId ||
        acquiredLease.lease.claimId !== runtimeWorkClaim.claimId ||
        Date.parse(authoritative.expiresAt) <= Date.parse(acquiredLease.lease.acquiredAt)
      ) {
        throw new AgentStateConflictError("Runtime lease acquisition lacks an active coordinator claim");
      }
    }
    this.records.set(sessionId, value);
    this.workQuarantines.delete(sessionId);
    this.notify(sessionId);
  }

  async waitForRevision(sessionId: string, afterRevision: number, timeoutMs: number, signal?: AbortSignal) {
    const currentRevision = this.currentRevision(sessionId);
    if (currentRevision === null || currentRevision > afterRevision) {
      return { changed: currentRevision !== null && currentRevision > afterRevision, revision: currentRevision };
    }
    if (timeoutMs === 0 || signal?.aborted) return { changed: false, revision: currentRevision };

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.waiters.get(sessionId)?.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const sessionWaiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      sessionWaiters.add(finish);
      this.waiters.set(sessionId, sessionWaiters);
      signal?.addEventListener("abort", finish, { once: true });
      if (this.currentRevision(sessionId) !== afterRevision) finish();
    });
    const revision = this.currentRevision(sessionId);
    return { changed: revision !== null && revision > afterRevision, revision };
  }

  clear(): void {
    this.records.clear();
    this.workQuarantines.clear();
    this.runtimeClaims.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter();
    this.waiters.clear();
  }

  private currentRevision(sessionId: string): number | null {
    const value = this.records.get(sessionId);
    return value === undefined ? null : deserializeAgentSessionState(value).revision;
  }

  private notify(sessionId: string): void {
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter();
  }

  private summaries() {
    return Array.from(this.records.values(), (value) =>
      projectAgentSessionSummary(deserializeAgentSessionState(value))
    );
  }
}
