import type { AgentApproval, AgentSession } from "@/lib/agent/contracts";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { RUNTIME_WORK_RESPONSE_MAX_BYTES, projectRuntimeWork } from "@/lib/agent/runtime/contracts";
import {
  AgentStateConflictError,
  AgentStateTransitionError,
  InMemoryAgentSessionStore,
  InMemoryAgentStateRepository,
  deserializeAgentSessionState,
  serializeAgentSessionState,
} from "@/lib/agent/state";
import { describe, expect, it } from "vitest";

const at = (second: number) => `2026-09-02T10:00:${String(second).padStart(2, "0")}.000Z`;

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    actorId: "admin-1",
    status: "pending",
    createdAt: at(0),
    updatedAt: at(0),
    policyId: "policy-1",
    policyRevision: 1,
    harness: {
      schemaVersion: 1,
      adapterId: "fake-harness",
      adapterVersion: "1.0.0",
      providerProfileId: "fake-provider",
      providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
      model: "fake-model",
    },
    turns: [],
    ...overrides,
  };
}

function approval(approvalId: string, expiresAt = at(30)): AgentApproval {
  return {
    schemaVersion: 1,
    approvalId,
    actorId: "admin-1",
    sessionId: "session-1",
    policyId: "policy-1",
    policyRevision: 1,
    invocationDigest: "a".repeat(64),
    invocationSummary: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      invocationDigest: "a".repeat(64),
      toolId: "workspace.write",
      capability: "workspace.write",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      risk: "risky",
      sanitizedArguments: { path: "server.properties" },
      diffSummary: "File target: server.properties",
    },
    invocationSummaryDigest: "451d22a1f14fc4294e784dffd8ff84f1f14a1be460c2ad81b011dc4e886d45eb",
    scope: {
      schemaVersion: 1,
      kind: "single-invocation",
      capability: "workspace.write",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      risk: "risky",
    },
    expiresAt,
    decision: "pending",
    reason: "",
  };
}

async function createdStore(options: ConstructorParameters<typeof InMemoryAgentSessionStore>[1] = {}) {
  const repository = new InMemoryAgentStateRepository();
  const store = new InMemoryAgentSessionStore(repository, options);
  const created = await store.createSession({
    session: session(),
    policySnapshot: createPolicyFromPreset("maintainer", "policy-1"),
    idempotencyKey: "create-1",
  });
  return { repository, store, state: created.state };
}

describe("in-memory agent session state", () => {
  it("resumes durable state and replays ordered events from a monotonic cursor", async () => {
    const { store } = await createdStore();
    let revision = 1;
    for (let index = 1; index <= 3; index++) {
      const result = await store.appendEvent({
        sessionId: "session-1",
        expectedRevision: revision++,
        idempotencyKey: `event-${index}`,
        eventId: `event-${index}`,
        timestamp: at(index),
        kind: "model",
        payload: { text: `chunk-${index}` },
      });
      expect(result.event.sequence).toBe(index);
      expect(result.event.replayCursor).toBe(`session-1:${index}`);
    }

    const resumed = await store.resumeSession("session-1");
    expect(resumed?.revision).toBe(4);
    const replay = await store.replayEvents("session-1", "session-1:1");
    expect(replay.events.map((event) => event.eventId)).toEqual(["event-2", "event-3"]);
    expect(replay.cursor).toBe("session-1:3");
    expect(replay.truncated).toBe(false);
  });

  it("deduplicates event IDs and idempotency keys without consuming revisions", async () => {
    const { store } = await createdStore();
    const input = {
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "append-1",
      eventId: "event-1",
      timestamp: at(1),
      kind: "model" as const,
      payload: { text: "hello" },
    };
    const first = await store.appendEvent(input);
    const retry = await store.appendEvent({ ...input, expectedRevision: 1 });
    const duplicateId = await store.appendEvent({ ...input, expectedRevision: 2, idempotencyKey: "append-alias" });

    expect(first.idempotent).toBe(false);
    expect(retry.idempotent).toBe(true);
    expect(duplicateId.idempotent).toBe(true);
    expect(duplicateId.state.revision).toBe(2);
    expect(duplicateId.state.events).toHaveLength(1);
    await expect(
      store.appendEvent({ ...input, expectedRevision: 2, payload: { text: "changed" } })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
  });

  it("enforces legal session and task transitions", async () => {
    const { store } = await createdStore();
    const running = await store.transitionSession({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "run",
      status: "running",
      at: at(1),
      reason: "dispatched",
    });
    const completed = await store.transitionSession({
      sessionId: "session-1",
      expectedRevision: running.state.revision,
      idempotencyKey: "complete",
      status: "completed",
      at: at(2),
      reason: "done",
    });
    await expect(
      store.transitionSession({
        sessionId: "session-1",
        expectedRevision: completed.state.revision,
        idempotencyKey: "restart",
        status: "running",
        at: at(3),
        reason: "invalid restart",
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);

    const taskStore = (await createdStore()).store;
    const added = await taskStore.addTask({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "task-1",
      task: {
        schemaVersion: 1,
        taskId: "task-1",
        sessionId: "session-1",
        status: "pending",
        content: "Inspect logs",
        createdAt: at(1),
        updatedAt: at(1),
      },
    });
    await expect(
      taskStore.transitionTask({
        sessionId: "session-1",
        taskId: "task-1",
        expectedRevision: added.state.revision,
        idempotencyKey: "skip-task",
        status: "completed",
        at: at(2),
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
  });

  it("rejects one of two writers using the same optimistic revision", async () => {
    const { store } = await createdStore();
    const write = (eventId: string) =>
      store.appendEvent({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: eventId,
        eventId,
        timestamp: at(1),
        kind: "model",
        payload: { eventId },
      });
    const results = await Promise.allSettled([write("event-a"), write("event-b")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AgentStateConflictError);
    expect((await store.getSession("session-1"))?.events).toHaveLength(1);
  });

  it("consumes approvals once and enforces revocation and expiry", async () => {
    const { store } = await createdStore();
    const pending = await store.putApproval({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "approval-1",
      approval: approval("approval-1"),
    });
    const approved = await store.decideApproval({
      sessionId: "session-1",
      approvalId: "approval-1",
      expectedRevision: pending.state.revision,
      idempotencyKey: "approve-1",
      decision: "approved",
      reason: "approved by operator",
      at: at(2),
    });
    const consumed = await store.consumeApproval({
      sessionId: "session-1",
      approvalId: "approval-1",
      expectedRevision: approved.state.revision,
      idempotencyKey: "consume-1",
      invocationDigest: "a".repeat(64),
      at: at(3),
    });
    const replay = await store.consumeApproval({
      sessionId: "session-1",
      approvalId: "approval-1",
      expectedRevision: approved.state.revision,
      idempotencyKey: "consume-1",
      invocationDigest: "a".repeat(64),
      at: at(3),
    });
    expect(replay.idempotent).toBe(true);
    await expect(
      store.consumeApproval({
        sessionId: "session-1",
        approvalId: "approval-1",
        expectedRevision: consumed.state.revision,
        idempotencyKey: "consume-again",
        invocationDigest: "a".repeat(64),
        at: at(4),
      })
    ).rejects.toThrow(/replay/i);
    await expect(
      store.revokeApproval({
        sessionId: "session-1",
        approvalId: "approval-1",
        expectedRevision: consumed.state.revision,
        idempotencyKey: "revoke-consumed-single",
        reason: "must not erase consumption audit",
        at: at(4),
      })
    ).rejects.toThrow(/session-capability/i);
    expect((await store.getSession("session-1"))?.approvals[0]).toMatchObject({
      decision: "approved",
      consumedAt: at(3),
    });

    const pendingRevoke = await store.putApproval({
      sessionId: "session-1",
      expectedRevision: consumed.state.revision,
      idempotencyKey: "approval-2",
      approval: {
        ...approval("approval-2"),
        scope: { ...approval("approval-2").scope, kind: "session-capability" },
      },
    });
    const approvedRevoke = await store.decideApproval({
      sessionId: "session-1",
      approvalId: "approval-2",
      expectedRevision: pendingRevoke.state.revision,
      idempotencyKey: "approve-2",
      decision: "approved",
      reason: "temporary",
      at: at(5),
    });
    const revoked = await store.revokeApproval({
      sessionId: "session-1",
      approvalId: "approval-2",
      expectedRevision: approvedRevoke.state.revision,
      idempotencyKey: "revoke-2",
      reason: "operator revoked",
      at: at(6),
    });
    expect(revoked.state.approvals.find((item) => item.approvalId === "approval-2")?.decision).toBe("revoked");

    const pendingExpired = await store.putApproval({
      sessionId: "session-1",
      expectedRevision: revoked.state.revision,
      idempotencyKey: "approval-expired",
      approval: approval("approval-expired", at(8)),
    });
    await expect(
      store.decideApproval({
        sessionId: "session-1",
        approvalId: "approval-expired",
        expectedRevision: pendingExpired.state.revision,
        idempotencyKey: "approve-expired",
        decision: "approved",
        reason: "too late",
        at: at(8),
      })
    ).rejects.toThrow(/expired/i);
  });

  it("rejects a tampered persisted approval summary digest", async () => {
    const { store } = await createdStore();
    const tampered = approval("approval-tampered");
    tampered.invocationSummary = {
      ...tampered.invocationSummary,
      sanitizedArguments: { command: "different action" },
    };
    await expect(
      store.putApproval({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: "tampered-summary",
        approval: tampered,
      })
    ).rejects.toThrow(/summary digest/i);
  });

  it("persists cancellation and cancels active tasks and approvals", async () => {
    const { store } = await createdStore();
    const running = await store.transitionSession({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "running",
      status: "running",
      at: at(1),
      reason: "started",
    });
    const task = await store.addTask({
      sessionId: "session-1",
      expectedRevision: running.state.revision,
      idempotencyKey: "task",
      task: {
        schemaVersion: 1,
        taskId: "task-1",
        sessionId: "session-1",
        status: "running",
        content: "Change configuration",
        createdAt: at(2),
        updatedAt: at(2),
      },
    });
    const pending = await store.putApproval({
      sessionId: "session-1",
      expectedRevision: task.state.revision,
      idempotencyKey: "approval",
      approval: approval("approval-1"),
    });
    const grantPending = await store.putApproval({
      sessionId: "session-1",
      expectedRevision: pending.state.revision,
      idempotencyKey: "approval-grant",
      approval: {
        ...approval("approval-grant"),
        scope: { ...approval("approval-grant").scope, kind: "session-capability" },
      },
    });
    const grant = await store.decideApproval({
      sessionId: "session-1",
      approvalId: "approval-grant",
      expectedRevision: grantPending.state.revision,
      idempotencyKey: "approve-grant",
      decision: "approved",
      reason: "session grant",
      at: at(3),
    });
    const cancelled = await store.cancelSession({
      sessionId: "session-1",
      expectedRevision: grant.state.revision,
      idempotencyKey: "cancel",
      requestedAt: at(4),
      requestedBy: "admin-1",
      reason: "operator stopped task",
    });

    expect(cancelled.state.session.status).toBe("cancelled");
    expect(cancelled.state.cancellation).toMatchObject({ requestedBy: "admin-1" });
    expect(cancelled.state.tasks[0].status).toBe("cancelled");
    expect(cancelled.state.approvals).toEqual([
      expect.objectContaining({ approvalId: "approval-1", decision: "cancelled" }),
      expect.objectContaining({ approvalId: "approval-grant", decision: "revoked" }),
    ]);
  });

  it("rejects approvals for a different actor or policy", async () => {
    const { store } = await createdStore();
    await expect(
      store.putApproval({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: "wrong-actor",
        approval: { ...approval("wrong-actor"), actorId: "attacker-1" },
      })
    ).rejects.toThrow(/actor/i);
    await expect(
      store.putApproval({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: "wrong-policy",
        approval: { ...approval("wrong-policy"), policyRevision: 2 },
      })
    ).rejects.toThrow(/policy/i);
  });

  it("cannot complete with active tasks and rejects child mutations after terminal status", async () => {
    const active = await createdStore();
    const running = await active.store.transitionSession({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "running",
      status: "running",
      at: at(1),
      reason: "started",
    });
    const task = await active.store.addTask({
      sessionId: "session-1",
      expectedRevision: running.state.revision,
      idempotencyKey: "active-task",
      task: {
        schemaVersion: 1,
        taskId: "active-task",
        sessionId: "session-1",
        status: "running",
        content: "Still running",
        createdAt: at(2),
        updatedAt: at(2),
      },
    });
    await expect(
      active.store.transitionSession({
        sessionId: "session-1",
        expectedRevision: task.state.revision,
        idempotencyKey: "premature-completion",
        status: "completed",
        at: at(3),
        reason: "not actually done",
      })
    ).rejects.toThrow(/tasks are active/i);

    const terminal = await createdStore();
    const terminalRunning = await terminal.store.transitionSession({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "terminal-running",
      status: "running",
      at: at(1),
      reason: "started",
    });
    const completed = await terminal.store.transitionSession({
      sessionId: "session-1",
      expectedRevision: terminalRunning.state.revision,
      idempotencyKey: "terminal-completed",
      status: "completed",
      at: at(2),
      reason: "done",
    });
    await expect(
      terminal.store.appendEvent({
        sessionId: "session-1",
        expectedRevision: completed.state.revision,
        idempotencyKey: "late-event",
        eventId: "late-event",
        timestamp: at(3),
        kind: "model",
        payload: { text: "late" },
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
    await expect(
      terminal.store.addTask({
        sessionId: "session-1",
        expectedRevision: completed.state.revision,
        idempotencyKey: "late-task",
        task: {
          schemaVersion: 1,
          taskId: "late-task",
          sessionId: "session-1",
          status: "pending",
          content: "late",
          createdAt: at(3),
          updatedAt: at(3),
        },
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
    await expect(
      terminal.store.putApproval({
        sessionId: "session-1",
        expectedRevision: completed.state.revision,
        idempotencyKey: "late-approval",
        approval: approval("late-approval"),
      })
    ).rejects.toBeInstanceOf(AgentStateTransitionError);
  });

  it("rejects replay cursors ahead of the event stream", async () => {
    const { store } = await createdStore();
    await expect(store.replayEvents("session-1", "session-1:1")).rejects.toThrow(/ahead/i);
  });

  it("bounds retained events, task history, status history, and reports stale replay cursors", async () => {
    const { store } = await createdStore({ maxEvents: 2, maxTasks: 2, maxStatusTransitions: 2 });
    let revision = 1;
    for (let index = 1; index <= 4; index++) {
      const result = await store.appendEvent({
        sessionId: "session-1",
        expectedRevision: revision,
        idempotencyKey: `append-${index}`,
        eventId: `event-${index}`,
        timestamp: at(index),
        kind: "model",
        payload: { index },
      });
      revision = result.state.revision;
    }
    for (let index = 1; index <= 2; index++) {
      const result = await store.addTask({
        sessionId: "session-1",
        expectedRevision: revision,
        idempotencyKey: `task-${index}`,
        task: {
          schemaVersion: 1,
          taskId: `task-${index}`,
          sessionId: "session-1",
          status: "pending",
          content: `task ${index}`,
          createdAt: at(index + 4),
          updatedAt: at(index + 4),
        },
      });
      revision = result.state.revision;
    }
    const terminalTask = await store.transitionTask({
      sessionId: "session-1",
      taskId: "task-1",
      expectedRevision: revision,
      idempotencyKey: "terminal-task-1",
      status: "failed",
      at: at(7),
    });
    const thirdTask = await store.addTask({
      sessionId: "session-1",
      expectedRevision: terminalTask.state.revision,
      idempotencyKey: "task-3",
      task: {
        schemaVersion: 1,
        taskId: "task-3",
        sessionId: "session-1",
        status: "pending",
        content: "task 3",
        createdAt: at(7),
        updatedAt: at(7),
      },
    });
    revision = thirdTask.state.revision;
    const running = await store.transitionSession({
      sessionId: "session-1",
      expectedRevision: revision,
      idempotencyKey: "status-1",
      status: "running",
      at: at(8),
      reason: "run",
    });
    const waiting = await store.transitionSession({
      sessionId: "session-1",
      expectedRevision: running.state.revision,
      idempotencyKey: "status-2",
      status: "waiting-approval",
      at: at(9),
      reason: "wait",
    });

    expect(waiting.state.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(waiting.state.tasks.map((task) => task.taskId)).toEqual(["task-2", "task-3"]);
    expect(waiting.state.statusHistory).toHaveLength(2);
    const replay = await store.replayEvents("session-1", "session-1:1");
    expect(replay.truncated).toBe(true);
    expect(replay.retainedFromSequence).toBe(3);
    expect(replay.events.map((event) => event.sequence)).toEqual([3, 4]);
  });

  it("never evicts active tasks when task retention is full", async () => {
    const { store } = await createdStore({ maxTasks: 1 });
    const first = await store.addTask({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "active-task-1",
      task: {
        schemaVersion: 1,
        taskId: "active-task-1",
        sessionId: "session-1",
        status: "pending",
        content: "active one",
        createdAt: at(1),
        updatedAt: at(1),
      },
    });
    await expect(
      store.addTask({
        sessionId: "session-1",
        expectedRevision: first.state.revision,
        idempotencyKey: "active-task-2",
        task: {
          schemaVersion: 1,
          taskId: "active-task-2",
          sessionId: "session-1",
          status: "pending",
          content: "active two",
          createdAt: at(2),
          updatedAt: at(2),
        },
      })
    ).rejects.toThrow(/active records/i);
    expect((await store.getSession("session-1"))?.tasks.map((task) => task.taskId)).toEqual(["active-task-1"]);
  });

  it("reserves serialized capacity for terminal cancellation", async () => {
    const { store } = await createdStore({ maxSerializedBytes: 6_000, reservedTerminalBytes: 1_500 });
    await expect(
      store.appendEvent({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: "oversized-growth",
        eventId: "oversized-growth",
        timestamp: at(1),
        kind: "model",
        payload: { text: "x".repeat(4_000) },
      })
    ).rejects.toThrow(/reserved for terminalization/i);
    const cancelled = await store.cancelSession({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "terminal-cancel",
      requestedAt: at(2),
      requestedBy: "admin-1",
      reason: "reconcile bounded state",
    });
    expect(cancelled.state.session.status).toBe("cancelled");
    expect(new TextEncoder().encode(serializeAgentSessionState(cancelled.state)).byteLength).toBeLessThanOrEqual(6_000);
  });

  it("prunes old replayable events before a near-cap result while retaining the result cursor", async () => {
    const repository = new InMemoryAgentStateRepository();
    const policySnapshot = createPolicyFromPreset("maintainer", "policy-1");
    const events = Array.from({ length: 500 }, (_, index) => ({
      schemaVersion: 1 as const,
      eventId: `near-cap-${index + 1}`,
      sessionId: "session-1",
      sequence: index + 1,
      timestamp: at(index % 30),
      kind: "model" as const,
      payload: { schemaVersion: 1 as const, redacted: true as const, data: { text: "x".repeat(1_600) } },
      replayCursor: `session-1:${index + 1}`,
    }));
    const largeState = {
      schemaVersion: 1 as const,
      revision: 1,
      session: session(),
      policySnapshot,
      statusHistory: [{ schemaVersion: 1 as const, from: null, to: "pending" as const, at: at(0), reason: "created" }],
      tasks: [],
      approvals: [],
      events,
      nextEventSequence: 501,
      retainedFromSequence: 1,
      idempotency: [],
    };
    await repository.create("session-1", serializeAgentSessionState(largeState));
    const store = new InMemoryAgentSessionStore(repository, { maxEvents: 500, maxTasks: 100 });
    const before = await store.getSession("session-1");
    expect(new TextEncoder().encode(serializeAgentSessionState(before!)).byteLength).toBeGreaterThan(772_000);
    const revision = before!.revision;

    const result = await store.appendEvent({
      sessionId: "session-1",
      expectedRevision: revision,
      idempotencyKey: "near-cap-result",
      eventId: "near-cap-result",
      timestamp: at(1),
      kind: "tool-result",
      payload: { status: "succeeded", output: { message: "✅🙂" } },
    });
    expect(result.event.eventId).toBe("near-cap-result");
    expect(result.state.events.at(-1)?.eventId).toBe("near-cap-result");
    expect(result.state.retainedFromSequence).toBeGreaterThan(1);
    expect(new TextEncoder().encode(serializeAgentSessionState(result.state)).byteLength).toBeLessThanOrEqual(772_000);
    const replay = await store.replayEvents("session-1", "session-1:1");
    expect(replay.truncated).toBe(true);
    expect(replay.events.at(-1)?.eventId).toBe("near-cap-result");
  }, 15_000);

  it("bounds a 32k-turn multibyte session before durable creation and across restart", async () => {
    const repository = new InMemoryAgentStateRepository();
    const store = new InMemoryAgentSessionStore(repository);
    const turns = Array.from({ length: 32_000 }, (_, index) => ({
      schemaVersion: 1 as const,
      turnId: `turn-${index}`,
      kind: "user" as const,
      content: "履歴🙂é",
      createdAt: at(index % 30),
    }));
    const created = await store.createSession({
      session: session({ turns }),
      policySnapshot: createPolicyFromPreset("maintainer", "policy-1"),
      initialTask: {
        schemaVersion: 1,
        taskId: "restart-task",
        sessionId: "session-1",
        status: "pending",
        content: "Resume after restart",
        createdAt: at(1),
        updatedAt: at(1),
      },
      idempotencyKey: "large-session",
    });
    expect(created.state.session.turns).toHaveLength(100);
    expect(created.state.session.turns.at(-1)?.turnId).toBe("turn-31999");
    expect(new TextEncoder().encode(serializeAgentSessionState(created.state)).byteLength).toBeLessThanOrEqual(772_000);
    const restarted = new InMemoryAgentSessionStore(repository);
    expect((await restarted.resumeSession("session-1"))?.session.turns).toHaveLength(100);
    const nextLease = await restarted.leaseNextRuntimeWork({
      runtimeId: "runtime-restarted",
      claimId: "claim-restarted",
      leaseId: "lease-restarted",
      now: at(2),
      leaseDurationMs: 20_000,
    });
    expect(nextLease?.task.taskId).toBe("restart-task");
    expect(projectRuntimeWork(nextLease!).session.turns).toHaveLength(100);
  });

  it("keeps active proposal, approval digest, task status, and terminal receipt while compacting", async () => {
    const { store } = await createdStore({ maxEvents: 2 });
    const added = await store.addTask({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "active-task",
      task: {
        schemaVersion: 1,
        taskId: "task-preserved",
        sessionId: "session-1",
        status: "pending",
        content: "preserve status",
        createdAt: at(1),
        updatedAt: at(1),
      },
    });
    await store.putApproval({
      sessionId: "session-1",
      expectedRevision: added.state.revision,
      idempotencyKey: "approval-preserved",
      approval: approval("approval-preserved"),
    });
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-preserved",
      claimId: "claim-preserved",
      leaseId: "lease-preserved",
      now: at(2),
      leaseDurationMs: 20_000,
    });
    const boundedLease = projectRuntimeWork(work!);
    expect(boundedLease.session.turns.length).toBeLessThanOrEqual(128);
    expect(
      new TextEncoder().encode(JSON.stringify({ success: true, data: boundedLease, timestamp: at(5) })).byteLength
    ).toBeLessThan(RUNTIME_WORK_RESPONSE_MAX_BYTES);
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-1",
      taskId: "task-preserved",
      leaseId: "lease-preserved",
      runtimeId: "runtime-preserved",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-preserved",
      at: at(3),
    });
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-1",
      taskId: "task-preserved",
      leaseId: "lease-preserved",
      runtimeId: "runtime-preserved",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-preserved",
      at: at(4),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-preserved",
          ordinal: 1,
          timestamp: at(4),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-preserved",
            invocationDigest: "a".repeat(64),
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const cancelled = await store.cancelSession({
      sessionId: "session-1",
      expectedRevision: proposal.state.revision,
      idempotencyKey: "cancel-preserved",
      requestedAt: at(5),
      requestedBy: "admin-1",
      reason: "retain terminal receipt",
    });
    const retained = await store.getSession("session-1");
    expect(retained?.session.status).toBe("cancelled");
    expect(retained?.approvals.find((item) => item.approvalId === "approval-preserved")?.invocationDigest).toBe(
      "a".repeat(64)
    );
    expect(retained?.tasks.find((item) => item.taskId === "task-preserved")?.status).toBe("cancelled");
    expect(retained?.tasks.find((item) => item.taskId === "task-preserved")?.cancellationReconciliation).toBeDefined();
    expect(retained?.events.some((event) => event.eventId === "proposal-preserved")).toBe(true);
    expect(cancelled.state.cancellation?.reason).toContain("retain terminal receipt");
  });

  it("skips an unencodable lease before its lease mutation reaches durable state", async () => {
    const { store } = await createdStore();
    const added = await store.addTask({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "oversized-lease-task",
      task: {
        schemaVersion: 1,
        taskId: "oversized-lease-task",
        sessionId: "session-1",
        status: "pending",
        content: "🙂".repeat(130_000),
        createdAt: at(1),
        updatedAt: at(1),
      },
    });
    await expect(
      store.leaseNextRuntimeWork({
        runtimeId: "runtime-oversized",
        claimId: "claim-oversized",
        leaseId: "lease-oversized",
        now: at(2),
        leaseDurationMs: 20_000,
      })
    ).resolves.toBeNull();
    const persisted = await store.getSession("session-1");
    expect(persisted?.revision).toBe(added.state.revision);
    expect(persisted?.tasks[0].lease).toBeUndefined();
  });

  it("redacts credential-shaped text, rejects sensitive keys, and round-trips strict serialization", async () => {
    const repository = new InMemoryAgentStateRepository();
    const store = new InMemoryAgentSessionStore(repository);
    const created = await store.createSession({
      session: session({
        turns: [
          {
            schemaVersion: 1,
            turnId: "turn-1",
            kind: "user",
            content: "Use Bearer abcdefghijklmnopqrstuvwxyz.123456",
            createdAt: at(0),
          },
        ],
      }),
      policySnapshot: createPolicyFromPreset("maintainer", "policy-1"),
    });
    expect(created.state.session.turns[0].content).toContain("[REDACTED]");
    const appended = await store.appendEvent({
      sessionId: "session-1",
      expectedRevision: 1,
      idempotencyKey: "redacted-event",
      eventId: "event-1",
      timestamp: at(1),
      kind: "model",
      payload: { message: "provider said sk-abcdefghijklmnop" },
    });
    expect(appended.event.payload.data.message).toBe("provider said [REDACTED]");
    await expect(
      store.appendEvent({
        sessionId: "session-1",
        expectedRevision: 2,
        idempotencyKey: "raw-secret",
        eventId: "event-2",
        timestamp: at(2),
        kind: "error",
        payload: { apiKey: "raw-value" },
      })
    ).rejects.toThrow(/credential fields/i);
    for (const key of [
      "sessionToken",
      "AWS_SESSION_TOKEN",
      "clientSecret",
      "oauth-client-secret",
      "privateKey",
      "private_key_pem",
    ]) {
      await expect(
        store.appendEvent({
          sessionId: "session-1",
          expectedRevision: 2,
          idempotencyKey: `raw-${key}`,
          eventId: `event-${key}`,
          timestamp: at(2),
          kind: "error",
          payload: { nested: { [key]: "raw-value" } },
        })
      ).rejects.toThrow(/credential fields/i);
    }

    const serialized = serializeAgentSessionState(appended.state);
    expect(deserializeAgentSessionState(serialized)).toEqual(appended.state);
    expect(() => deserializeAgentSessionState(serialized.replace('"revision":2', '"revision":0'))).toThrow(/revision/);
  });
});
