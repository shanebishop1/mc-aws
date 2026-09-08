import { AgentStateConflictError, type AgentStateRepository } from "@/lib/agent/state/contracts";
import {
  type AgentRuntimeWorkClaim,
  type AgentWorkCandidateQuery,
  type AgentWorkIndexRecord,
  orderedWorkCandidateSessionIds,
  projectAgentSessionSummary,
} from "@/lib/agent/state/repository-metadata";
import { deserializeAgentSessionState } from "@/lib/agent/state/serialization";
import { type MockStateStore, getMockStateStore } from "@/lib/aws/mock-state-store";

const POLL_INTERVAL_MS = 25;

/**
 * Cross-runtime mock repository backed by MockStateStore's locked JSON state.
 * Tests continue to use InMemoryAgentStateRepository; this implementation is
 * for the Next development server and Playwright's separately bundled routes.
 */
export class MockAgentStateRepository implements AgentStateRepository {
  private static readonly claimsByStore = new WeakMap<object, Map<string, AgentRuntimeWorkClaim>>();

  constructor(private readonly stateStore: MockStateStore = getMockStateStore()) {}

  private runtimeClaims(): Map<string, AgentRuntimeWorkClaim> {
    let claims = MockAgentStateRepository.claimsByStore.get(this.stateStore);
    if (!claims) {
      claims = new Map();
      MockAgentStateRepository.claimsByStore.set(this.stateStore, claims);
    }
    return claims;
  }

  async read(sessionId: string) {
    return await this.stateStore.readAgentSessionRecord(sessionId);
  }

  async list(limit: number) {
    const records = await this.stateStore.listAgentSessionRecords();
    return records
      .sort((left, right) => {
        const leftState = deserializeAgentSessionState(left.value);
        const rightState = deserializeAgentSessionState(right.value);
        return (
          rightState.session.updatedAt.localeCompare(leftState.session.updatedAt) ||
          leftState.session.sessionId.localeCompare(rightState.session.sessionId)
        );
      })
      .slice(0, limit);
  }

  async listSummaries(limit: number, actorId?: string) {
    const records = await this.stateStore.listAgentSessionRecords();
    return records
      .map((record) => projectAgentSessionSummary(deserializeAgentSessionState(record.value)))
      .filter((summary) => actorId === undefined || summary.actorId === actorId)
      .sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId)
      )
      .slice(0, limit);
  }

  async listWorkCandidateSessionIds(query: AgentWorkCandidateQuery): Promise<string[]> {
    const records = await this.stateStore.listAgentSessionRecords();
    const candidates: AgentWorkIndexRecord[] = [];
    for (const record of records) {
      const summary = projectAgentSessionSummary(deserializeAgentSessionState(record.value));
      if (
        summary.work &&
        !(await this.stateStore.isAgentWorkCandidateQuarantined(summary.sessionId, summary.revision))
      ) {
        candidates.push(summary.work);
      }
    }
    return orderedWorkCandidateSessionIds(candidates, query);
  }

  async claimRuntimeWorkCandidate(
    query: AgentWorkCandidateQuery & { claimDurationMs: number }
  ): Promise<AgentRuntimeWorkClaim | null> {
    const claims = this.runtimeClaims();
    const now = Date.parse(query.now);
    const existing = claims.get(query.runtimeId);
    if (existing && Date.parse(existing.expiresAt) > now) {
      return existing.claimId === query.claimId ? structuredClone(existing) : null;
    }
    if (existing) claims.delete(query.runtimeId);
    const sessionId = (await this.listWorkCandidateSessionIds({ ...query, limit: 1 }))[0];
    if (!sessionId) return null;
    const record = await this.read(sessionId);
    if (!record) return null;
    const state = deserializeAgentSessionState(record.value);
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
    claims.set(query.runtimeId, claim);
    return structuredClone(claim);
  }

  async releaseRuntimeWorkClaim(claim: AgentRuntimeWorkClaim): Promise<void> {
    const claims = this.runtimeClaims();
    if (claims.get(claim.runtimeId)?.token === claim.token) claims.delete(claim.runtimeId);
  }

  async renewRuntimeWorkClaim(input: {
    runtimeId: string;
    claimId: string;
    sessionId: string;
    taskId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    const claims = this.runtimeClaims();
    const claim = claims.get(input.runtimeId);
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
    claims.set(input.runtimeId, { ...claim, expiresAt: input.expiresAt });
  }

  async quarantineWorkCandidate(input: {
    sessionId: string;
    revision: number;
    reason: "runtime-response-over-budget" | "migration-merge-over-budget";
  }): Promise<void> {
    await this.stateStore.quarantineAgentWorkCandidate(input.sessionId, input.revision, input.reason);
  }

  async create(sessionId: string, value: string): Promise<void> {
    const state = deserializeAgentSessionState(value);
    if (state.session.sessionId !== sessionId || state.revision !== 1) {
      throw new AgentStateConflictError("Initial agent state must match its key and start at revision 1");
    }
    if (!(await this.stateStore.createAgentSessionRecord(sessionId, { revision: state.revision, value }))) {
      throw new AgentStateConflictError(`Agent session ${sessionId} already exists`);
    }
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: number,
    value: string,
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<void> {
    const current = await this.read(sessionId);
    if (!current || current.revision !== expectedRevision) {
      throw new AgentStateConflictError(`Agent session ${sessionId} revision conflict`);
    }
    const next = deserializeAgentSessionState(value);
    if (next.session.sessionId !== sessionId || next.revision !== expectedRevision + 1) {
      throw new AgentStateConflictError("Agent state CAS writes must increment one matching session revision");
    }
    const currentState = deserializeAgentSessionState(current.value);
    const acquiredLease = next.tasks.find((task) => {
      const prior = currentState.tasks.find((candidate) => candidate.taskId === task.taskId);
      return task.lease && (!prior?.lease || task.lease.leaseId !== prior.lease.leaseId);
    });
    if (acquiredLease) {
      const authoritative = runtimeWorkClaim && this.runtimeClaims().get(runtimeWorkClaim.runtimeId);
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
    const swapped = await this.stateStore.compareAndSwapAgentSessionRecord(sessionId, expectedRevision, {
      revision: next.revision,
      value,
    });
    if (!swapped) throw new AgentStateConflictError(`Agent session ${sessionId} revision conflict`);
  }

  async waitForRevision(sessionId: string, afterRevision: number, timeoutMs: number, signal?: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const revision = (await this.read(sessionId))?.revision ?? null;
      if (revision === null || revision > afterRevision) {
        return { changed: revision !== null && revision > afterRevision, revision };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal?.aborted) return { changed: false, revision };
      await this.delay(Math.min(POLL_INTERVAL_MS, remainingMs), signal);
    }
  }

  private async delay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}

export async function resetPersistedMockAgentState(): Promise<void> {
  await getMockStateStore().clearAgentSessionRecords();
}
