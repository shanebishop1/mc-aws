import {
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentSession,
  type PermissionPolicy,
} from "@/lib/agent/contracts";
import {
  type AgentApprovalDecisionRequestDto,
  type AgentRevisionMutationRequestDto,
  type ContinueAgentSessionRequestDto,
  type CreateAgentSessionRequestDto,
  type PublicAgentSessionDetailDto,
  type PublicAgentSessionSummaryDto,
  projectAgentEvent,
  projectSessionDetail,
  projectSessionSummary,
  projectStoredSessionSummary,
} from "@/lib/agent/control-plane/contracts";
import {
  type PublicAgentProviderCatalogDto,
  assertCatalogSelection,
  catalogProfileMetadata,
  getPublicAgentProviderCatalog,
} from "@/lib/agent/control-plane/provider-catalog";
import { createInvocationSummaryDigest, createProposedInvocationSummary } from "@/lib/agent/policy";
import { computeProviderProfileFingerprint } from "@/lib/agent/provider-profile";
import {
  type AgentEventWait,
  type AgentSessionStateStore,
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateTransitionError,
} from "@/lib/agent/state";
import { agentSchemas } from "@/lib/agent/validators";

const LIST_LIMIT = 100;

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function atOffset(base: string, milliseconds: number): string {
  return new Date(Date.parse(base) + milliseconds).toISOString();
}

function owns(actorId: string, state: Awaited<ReturnType<AgentSessionStateStore["getSession"]>>): asserts state {
  if (!state) throw new AgentStateNotFoundError("agent-session");
  if (state.session.actorId !== actorId) throw new AgentStateNotFoundError("agent-session");
}

export async function deriveOpaqueActorId(email: string): Promise<string> {
  const normalized = email.trim().normalize("NFKC").toLowerCase();
  return `actor-${await digest(normalized)}`;
}

export class AgentControlPlaneService {
  constructor(
    private readonly store: AgentSessionStateStore,
    private readonly now: () => Date = () => new Date(),
    private readonly simulateLocalExecution = process.env.MC_BACKEND_MODE === "mock" ||
      process.env.NODE_ENV !== "production",
    private readonly providerCatalog: PublicAgentProviderCatalogDto = getPublicAgentProviderCatalog()
  ) {}

  async createSession(actorId: string, input: CreateAgentSessionRequestDto): Promise<PublicAgentSessionDetailDto> {
    const selectedProfile = assertCatalogSelection(this.providerCatalog, input.providerProfileId, input.model);
    const providerProfileFingerprint = await computeProviderProfileFingerprint(catalogProfileMetadata(selectedProfile));
    const seed = await digest(`${actorId}\0${input.idempotencyKey}`);
    const sessionId = `session-${seed}`;
    const requestFingerprint = await digest(JSON.stringify(input));
    const existing = await this.store.getSession(sessionId);
    if (existing) {
      owns(actorId, existing);
      const createRecord = existing.idempotency.find(
        (record) => record.key === input.idempotencyKey && record.operation === "create-session"
      );
      if (createRecord?.fingerprint !== requestFingerprint) {
        throw new AgentStateConflictError("Idempotency key was reused for another session request");
      }
    }

    const createdAt = existing?.session.createdAt ?? this.now().toISOString();
    const policy = this.policy(sessionId, input);
    const session: AgentSession = agentSchemas.agentSession.parse({
      schemaVersion: AGENT_SCHEMA_VERSION,
      sessionId,
      actorId,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      policyId: policy.policyId,
      policyRevision: policy.revision,
      harness: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        adapterId: this.simulateLocalExecution ? "fake-control-plane" : "runtime-dispatch",
        adapterVersion: "1.0.0",
        providerProfileId: input.providerProfileId,
        providerProfileFingerprint,
        model: input.model,
      },
      turns: [],
    });
    let result = await this.store.createSession({
      session,
      policySnapshot: policy,
      initialTask: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        taskId: `task-${seed}`,
        sessionId,
        status: "pending",
        content: input.task,
        createdAt,
        updatedAt: createdAt,
      },
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      initialTurn: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        turnId: `turn-${seed}`,
        kind: "task",
        content: input.task,
        createdAt,
      },
    });
    if (!this.simulateLocalExecution) return projectSessionDetail(result.state);
    result = await this.store.transitionSession({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:dispatch`,
      status: "running",
      at: atOffset(createdAt, 1),
      reason: "accepted by deterministic local dispatcher",
    });
    result = await this.store.transitionTask({
      sessionId,
      taskId: `task-${seed}`,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:task:running`,
      status: "running",
      at: atOffset(createdAt, 1),
    });
    const invocation = agentSchemas.toolInvocation.parse({
      schemaVersion: AGENT_SCHEMA_VERSION,
      invocationId: `invocation-${seed}`,
      sessionId,
      toolId: "workspace.write",
      capability: "workspace.write",
      targetScope: { schemaVersion: AGENT_SCHEMA_VERSION, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: {
        path: "server.properties",
        diff: "--- server.properties\n+++ server.properties\n@@ motd\n-Old message\n+Reviewed message",
      },
      requestedAt: atOffset(createdAt, 3),
    });
    const invocationSummary = await createProposedInvocationSummary(invocation, "risky");
    const invocationSummaryDigest = await createInvocationSummaryDigest(invocationSummary);
    result = await this.store.appendEvent({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:event:accepted`,
      eventId: `event-${seed}-1`,
      timestamp: atOffset(createdAt, 2),
      kind: "model",
      payload: { message: "Task accepted by the deterministic control-plane fixture." },
    });
    result = await this.store.appendEvent({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:event:proposal`,
      eventId: `event-${seed}-2`,
      timestamp: atOffset(createdAt, 3),
      kind: "tool-proposal",
      payload: {
        invocationId: invocation.invocationId,
        invocationDigest: invocationSummary.invocationDigest,
        invocationSummaryDigest,
        capability: "workspace.write",
        target: "server.properties",
        risk: "risky",
        sanitizedArguments: invocationSummary.sanitizedArguments,
        diffSummary: invocationSummary.diffSummary ?? "File target: server.properties",
      },
    });
    const approval: AgentApproval = agentSchemas.agentApproval.parse({
      schemaVersion: AGENT_SCHEMA_VERSION,
      approvalId: `approval-${seed}`,
      actorId,
      sessionId,
      policyId: policy.policyId,
      policyRevision: policy.revision,
      invocationDigest: invocationSummary.invocationDigest,
      invocationSummary,
      invocationSummaryDigest,
      scope: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        kind:
          policy.rules.find((rule) => rule.capability === "workspace.write")?.decision === "ask-always"
            ? "single-invocation"
            : "session-capability",
        capability: "workspace.write",
        targetScope: { schemaVersion: AGENT_SCHEMA_VERSION, kind: "workspace", normalizedTarget: "server.properties" },
        risk: "risky",
      },
      expiresAt: atOffset(createdAt, 30 * 60 * 1000),
      decision: "pending",
      reason: "",
    });
    result = await this.store.putApproval({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:approval`,
      approval,
    });
    result = await this.store.transitionSession({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:wait`,
      status: "waiting-approval",
      at: atOffset(createdAt, 4),
      reason: "waiting for an exact operator approval",
    });
    result = await this.store.transitionTask({
      sessionId,
      taskId: `task-${seed}`,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:task:wait`,
      status: "waiting-approval",
      at: atOffset(createdAt, 4),
    });
    result = await this.store.appendEvent({
      sessionId,
      expectedRevision: result.state.revision,
      idempotencyKey: `${input.idempotencyKey}:event:approval`,
      eventId: `event-${seed}-3`,
      timestamp: atOffset(createdAt, 5),
      kind: "approval",
      payload: { approvalId: approval.approvalId, capability: approval.scope.capability, decision: "pending" },
    });
    return projectSessionDetail(result.state);
  }

  async listSessions(actorId: string): Promise<PublicAgentSessionSummaryDto[]> {
    return (await this.store.listSessionSummaries(LIST_LIMIT, actorId)).map(projectStoredSessionSummary);
  }

  async getSession(actorId: string, sessionId: string): Promise<PublicAgentSessionDetailDto> {
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    return projectSessionDetail(state);
  }

  async continueSession(
    actorId: string,
    sessionId: string,
    input: ContinueAgentSessionRequestDto
  ): Promise<PublicAgentSessionDetailDto> {
    const selectedProfile = assertCatalogSelection(this.providerCatalog, input.providerProfileId, input.model);
    const providerProfileFingerprint = await computeProviderProfileFingerprint(catalogProfileMetadata(selectedProfile));
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    const seed = await digest(`${sessionId}\0${input.idempotencyKey}`);
    const prior = state.idempotency.find((entry) => entry.key === input.idempotencyKey);
    if (state.session.status !== "idle" && prior?.operation !== `add-task:task-${seed}`) {
      throw new AgentStateTransitionError("Only an idle session can accept a continuation turn");
    }
    const at = prior?.recordedAt ?? this.now().toISOString();
    let result = await this.store.addTask({
      sessionId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      task: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        taskId: `task-${seed}`,
        sessionId,
        status: "pending",
        content: input.task,
        createdAt: at,
        updatedAt: at,
      },
      turn: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        turnId: `turn-${seed}`,
        kind: "user",
        content: input.task,
        createdAt: at,
      },
      harness: {
        ...state.session.harness,
        providerProfileId: input.providerProfileId,
        providerProfileFingerprint,
        model: input.model,
      },
    });
    if (this.simulateLocalExecution) {
      result = await this.store.transitionSession({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:dispatch`,
        status: "running",
        at: atOffset(at, 1),
        reason: "continued by deterministic local dispatcher",
      });
      result = await this.store.transitionTask({
        sessionId,
        taskId: `task-${seed}`,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:task:running`,
        status: "running",
        at: atOffset(at, 1),
      });
      result = await this.store.appendEvent({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:event:continued`,
        eventId: `event-${seed}-continued`,
        timestamp: atOffset(at, 2),
        kind: "model",
        payload: { message: "Continuation accepted with persisted conversation context." },
      });
      result = await this.store.appendEvent({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:event:completed`,
        eventId: `event-${seed}-completed`,
        timestamp: atOffset(at, 3),
        kind: "completion",
        payload: { status: "completed", taskId: `task-${seed}` },
      });
      result = await this.store.transitionTask({
        sessionId,
        taskId: `task-${seed}`,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:task:completed`,
        status: "completed",
        at: atOffset(at, 4),
      });
      result = await this.store.transitionSession({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:idle`,
        status: "idle",
        at: atOffset(at, 4),
        reason: "deterministic continuation completed",
      });
    }
    return projectSessionDetail(result.state);
  }

  async cancel(actorId: string, sessionId: string, input: AgentRevisionMutationRequestDto) {
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    const result = await this.store.cancelSession({
      sessionId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      requestedAt: this.now().toISOString(),
      requestedBy: actorId,
      reason: input.reason ?? "cancelled by operator",
    });
    return projectSessionDetail(result.state);
  }

  async decideApproval(actorId: string, sessionId: string, approvalId: string, input: AgentApprovalDecisionRequestDto) {
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    let result = await this.store.decideApproval({
      sessionId,
      approvalId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      decision: input.decision === "approve" ? "approved" : "denied",
      reason: input.reason ?? (input.decision === "approve" ? "approved by operator" : "denied by operator"),
      at: this.now().toISOString(),
    });
    if (this.simulateLocalExecution) {
      const task = [...result.state.tasks].reverse().find((candidate) => candidate.status === "waiting-approval");
      if (!task) throw new AgentStateTransitionError("Mock approval has no waiting task");
      const at = this.now().toISOString();
      result = await this.store.transitionSession({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:resume-session`,
        status: "running",
        at,
        reason: "operator decided deterministic approval",
      });
      result = await this.store.transitionTask({
        sessionId,
        taskId: task.taskId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:resume-task`,
        status: "running",
        at,
      });
      result = await this.store.appendEvent({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:completion-event`,
        eventId: `event-${approvalId}-${input.decision}`,
        timestamp: at,
        kind: "completion",
        payload: {
          status: "completed",
          summary:
            input.decision === "approve"
              ? "Approved fixture action completed."
              : "Action denied; task completed safely.",
        },
      });
      result = await this.store.transitionTask({
        sessionId,
        taskId: task.taskId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:complete-task`,
        status: "completed",
        at,
      });
      result = await this.store.transitionSession({
        sessionId,
        expectedRevision: result.state.revision,
        idempotencyKey: `${input.idempotencyKey}:idle-session`,
        status: "idle",
        at,
        reason: "deterministic task completed",
      });
    }
    return projectSessionDetail(result.state);
  }

  async revokeApproval(actorId: string, sessionId: string, approvalId: string, input: AgentRevisionMutationRequestDto) {
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    const result = await this.store.revokeApproval({
      sessionId,
      approvalId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason ?? "revoked by operator",
      at: this.now().toISOString(),
    });
    return projectSessionDetail(result.state);
  }

  async waitForEvents(
    actorId: string,
    sessionId: string,
    after: string | undefined,
    limit: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AgentEventWait> {
    const state = await this.store.getSession(sessionId);
    owns(actorId, state);
    const result = await this.store.waitForEvents(sessionId, after, limit, timeoutMs, signal);
    return { ...result, events: result.events.map(projectAgentEvent) };
  }

  private policy(sessionId: string, input: CreateAgentSessionRequestDto): PermissionPolicy {
    return agentSchemas.permissionPolicy.parse({
      schemaVersion: AGENT_SCHEMA_VERSION,
      policyId: `policy-${sessionId.slice("session-".length)}`,
      revision: 1,
      preset: input.policy.preset,
      rules: input.policy.rules,
      backupMode: input.policy.backupMode,
    });
  }
}
