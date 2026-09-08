import {
  AgentControlPlaneService,
  type CreateAgentSessionRequestDto,
  deriveOpaqueActorId,
} from "@/lib/agent/control-plane";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import {
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateTransitionError,
  InMemoryAgentSessionStore,
  InMemoryAgentStateRepository,
} from "@/lib/agent/state";
import { describe, expect, it } from "vitest";

function createInput(overrides: Partial<CreateAgentSessionRequestDto> = {}): CreateAgentSessionRequestDto {
  const policy = createPolicyFromPreset("maintainer", "ignored");
  return {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "create-1",
    task: "Inspect Bearer abcdefghijklmnopqrstuvwxyz.123456 and propose a change",
    providerProfileId: "local-fake",
    model: "deterministic-v1",
    policy: {
      schemaVersion: 1,
      preset: policy.preset,
      rules: policy.rules,
      backupMode: policy.backupMode,
    },
    ...overrides,
  };
}

function service() {
  const repository = new InMemoryAgentStateRepository();
  const store = new InMemoryAgentSessionStore(repository);
  return {
    store,
    service: new AgentControlPlaneService(store, () => new Date("2026-09-02T12:00:00.000Z")),
  };
}

class FailOnceRepository extends InMemoryAgentStateRepository {
  private failed = false;

  override async compareAndSwap(sessionId: string, expectedRevision: number, value: string): Promise<void> {
    if (!this.failed && expectedRevision === 3) {
      this.failed = true;
      throw new Error("injected fixture interruption");
    }
    await super.compareAndSwap(sessionId, expectedRevision, value);
  }
}

describe("agent control-plane service", () => {
  it("derives an opaque normalized actor and returns secret-free projections", async () => {
    expect(await deriveOpaqueActorId(" Admin@Example.COM  ")).toBe(await deriveOpaqueActorId("admin@example.com"));
    const actorId = await deriveOpaqueActorId("admin@example.com");
    const { service: control, store } = service();
    const created = await control.createSession(actorId, createInput());

    expect(created.status).toBe("waiting-approval");
    expect(created.revision).toBe(9);
    expect(created.tasks).toEqual([expect.not.objectContaining({ content: expect.anything() })]);
    expect(JSON.stringify(created)).not.toContain("admin@example.com");
    expect(JSON.stringify(created)).not.toContain("Bearer");
    const persisted = await store.getSession(created.sessionId);
    expect(persisted?.tasks[0].content).toContain("[REDACTED]");
    expect(persisted?.session.harness.providerProfileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.policySnapshot).toEqual(expect.objectContaining({ preset: "maintainer", revision: 1 }));
    expect((await control.listSessions(actorId))[0].sessionId).toBe(created.sessionId);
  });

  it("enforces create idempotency, request ownership, revisions, decisions, and active-grant revocation", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const other = await deriveOpaqueActorId("other@example.com");
    const { service: control } = service();
    const created = await control.createSession(owner, createInput());
    expect(await control.createSession(owner, createInput())).toEqual(created);
    await expect(control.createSession(owner, createInput({ task: "Changed request" }))).rejects.toBeInstanceOf(
      AgentStateConflictError
    );
    await expect(control.getSession(other, created.sessionId)).rejects.toBeInstanceOf(AgentStateNotFoundError);

    const approvalId = created.approvals[0].approvalId;
    await expect(
      control.decideApproval(owner, created.sessionId, approvalId, {
        schemaVersion: 1,
        expectedRevision: 6,
        idempotencyKey: "stale",
        decision: "approve",
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
    const approved = await control.decideApproval(owner, created.sessionId, approvalId, {
      schemaVersion: 1,
      expectedRevision: created.revision,
      idempotencyKey: "approve",
      decision: "approve",
    });
    expect(approved.approvals[0].decision).toBe("approved");
    const revoked = await control.revokeApproval(owner, created.sessionId, approvalId, {
      schemaVersion: 1,
      expectedRevision: approved.revision,
      idempotencyKey: "revoke",
    });
    expect(revoked.approvals[0].decision).toBe("revoked");
  });

  it("rejects every mutation after cancellation", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const { service: control } = service();
    const created = await control.createSession(owner, createInput());
    const cancelled = await control.cancel(owner, created.sessionId, {
      schemaVersion: 1,
      expectedRevision: created.revision,
      idempotencyKey: "cancel",
    });
    expect(cancelled.status).toBe("cancelled");
    await expect(
      control.decideApproval(owner, created.sessionId, created.approvals[0].approvalId, {
        schemaVersion: 1,
        expectedRevision: cancelled.revision,
        idempotencyKey: "late-decision",
        decision: "deny",
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
  });

  it("continues an owned idle session with revision and idempotency binding while preserving turns and tasks", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const { service: control, store } = service();
    const created = await control.createSession(owner, createInput());
    const idle = await control.decideApproval(owner, created.sessionId, created.approvals[0].approvalId, {
      schemaVersion: 1,
      expectedRevision: created.revision,
      idempotencyKey: "approve-for-continuation",
      decision: "approve",
    });
    expect(idle.status).toBe("idle");

    const request = {
      schemaVersion: 1 as const,
      expectedRevision: idle.revision,
      idempotencyKey: "continue-1",
      task: "Now explain the persisted result",
      providerProfileId: "local-fake",
      model: "deterministic-v1",
    };
    const continued = await control.continueSession(owner, created.sessionId, request);
    expect(continued).toMatchObject({ status: "idle", taskCount: 2, providerProfileId: "local-fake" });
    expect(continued.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect((await store.getSession(created.sessionId))?.session.turns.map((turn) => turn.kind)).toEqual([
      "task",
      "user",
    ]);
    expect(continued).not.toHaveProperty("turns");
    expect(await control.continueSession(owner, created.sessionId, request)).toEqual(continued);
    await expect(
      control.continueSession(owner, created.sessionId, {
        ...request,
        idempotencyKey: "continue-stale",
        task: "Conflicting stale turn",
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
  });

  it("rejects continuation for active and explicitly terminal sessions", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const { service: control } = service();
    const active = await control.createSession(owner, createInput({ idempotencyKey: "active-create" }));
    const request = {
      schemaVersion: 1 as const,
      expectedRevision: active.revision,
      idempotencyKey: "continue-active",
      task: "Not legal while active",
      providerProfileId: "local-fake",
      model: "deterministic-v1",
    };
    await expect(control.continueSession(owner, active.sessionId, request)).rejects.toBeInstanceOf(
      AgentStateTransitionError
    );
    const cancelled = await control.cancel(owner, active.sessionId, {
      schemaVersion: 1,
      expectedRevision: active.revision,
      idempotencyKey: "cancel-terminal",
    });
    await expect(
      control.continueSession(owner, active.sessionId, { ...request, expectedRevision: cancelled.revision })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
  });

  it("does not present fake execution as production runtime history", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
    const control = new AgentControlPlaneService(store, () => new Date("2026-09-02T12:00:00.000Z"), false);
    const created = await control.createSession(owner, createInput());
    expect(created).toMatchObject({ status: "pending", revision: 1, approvals: [], lastEventSequence: 0 });
  });

  it("atomically creates the initial aggregate and safely resumes interrupted mock fixture steps", async () => {
    const owner = await deriveOpaqueActorId("owner@example.com");
    const repository = new FailOnceRepository();
    const store = new InMemoryAgentSessionStore(repository);
    const control = new AgentControlPlaneService(store, () => new Date("2026-09-02T12:00:00.000Z"), true);

    await expect(control.createSession(owner, createInput())).rejects.toThrow(/fixture interruption/);
    const interrupted = (await store.listSessions())[0];
    expect(interrupted).toMatchObject({ revision: 3, tasks: [{ status: "running" }] });

    const resumed = await control.createSession(owner, createInput());
    expect(resumed).toMatchObject({ revision: 9, status: "waiting-approval", taskCount: 1 });
    expect((await store.getSession(resumed.sessionId))?.events.map((event) => event.eventId)).toHaveLength(3);
  });
});
