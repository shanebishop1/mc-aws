import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type {
  AgentApproval,
  AgentCapability,
  AgentSession,
  BackupTerminalReceipt,
  JsonObject,
  PermissionDecision,
  ProposedInvocationSummary,
  TargetScope,
  ToolInvocation,
  ToolResult,
} from "@/lib/agent/contracts";
import { networkDownloadApprovalScope } from "@/lib/agent/network-download";
import { createInvocationDigest, createInvocationSummaryDigest } from "@/lib/agent/policy";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import { AgentStateConflictError, InMemoryAgentSessionStore, InMemoryAgentStateRepository } from "@/lib/agent/state";
import { describe, expect, it } from "vitest";

const at = (milliseconds: number) => new Date(Date.parse("2026-09-02T10:00:00.000Z") + milliseconds).toISOString();
const CANCELLATION_INVOCATION_DIGEST = "a".repeat(64);

function resultDigest(result: ToolResult): string {
  return createHash("sha256")
    .update(canonicalJson(result as never))
    .digest("hex");
}

function recoveryReceipt(input: {
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  sessionId: string;
  taskId: string;
  invocationId: string;
  invocationDigest: string;
  journalSequence: number;
  resultDigest: string;
  outcome: "committed" | "failed" | "cancelled" | "indeterminate";
}): BackupTerminalReceipt {
  return {
    schemaVersion: 1,
    source: "executor-journal",
    proofKind: "terminal",
    outcome: input.outcome,
    executorKeyId: "executor-key",
    executorKeyEpoch: 1,
    executorEpoch: "executor-epoch",
    runtimeId: input.runtimeId,
    leaseId: input.leaseId,
    leaseGeneration: input.leaseGeneration,
    sessionId: input.sessionId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    invocationDigest: input.invocationDigest,
    backupId: "backup-recovery",
    lifecycleLockId: "lock-recovery",
    lifecycleFencingToken: 1,
    lifecycleLeaseGeneration: 1,
    fenceIssuedAt: at(4_000),
    resultDigest: input.resultDigest,
    journalSequence: input.journalSequence,
    completedAt: at(4_500),
    signature: "A".repeat(86),
  };
}

async function setup(decision?: { capability: AgentCapability; decision: PermissionDecision }) {
  const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
  const session: AgentSession = {
    schemaVersion: 1,
    sessionId: "session-runtime",
    actorId: "actor-runtime",
    status: "pending",
    createdAt: at(0),
    updatedAt: at(0),
    policyId: "policy-runtime",
    policyRevision: 1,
    harness: {
      schemaVersion: 1,
      adapterId: "runtime-dispatch",
      adapterVersion: "1.0.0",
      providerProfileId: "fake-profile",
      providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
      model: "fake-model",
    },
    turns: [],
  };
  const basePolicy = createPolicyFromPreset("maintainer", "policy-runtime");
  const policySnapshot = decision
    ? createCustomPolicy(basePolicy, "policy-runtime", 1, { [decision.capability]: decision.decision })
    : basePolicy;
  let result = await store.createSession({
    session,
    policySnapshot,
    idempotencyKey: "create-runtime",
  });
  result = await store.addTask({
    sessionId: session.sessionId,
    expectedRevision: result.state.revision,
    idempotencyKey: "add-runtime-task",
    task: {
      schemaVersion: 1,
      taskId: "task-runtime",
      sessionId: session.sessionId,
      status: "pending",
      content: "Inspect the local fixture only",
      createdAt: at(0),
      updatedAt: at(0),
    },
  });
  return { store, revision: result.state.revision };
}

describe("runtime work state", () => {
  it("completes one task into resumable idle state and leases a later turn without losing history", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-first",
      leaseId: "lease-first",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    expect(work?.providerProfileFingerprint).toBe(work?.session.harness.providerProfileFingerprint);
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-first",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-first",
      at: at(2_000),
    });
    const completed = await store.setRuntimeStatus({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-first",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "terminal-shared",
      at: at(3_000),
      status: "completed",
      reason: "first turn completed",
      assistantTurn: {
        schemaVersion: 1,
        turnId: "turn-assistant-first",
        kind: "assistant",
        content: "Persisted first result",
        createdAt: at(3_000),
      },
    });
    expect(completed.state).toMatchObject({
      session: { status: "idle", turns: [{ kind: "assistant", content: "Persisted first result" }] },
      tasks: [{ taskId: "task-runtime", status: "completed" }],
    });
    const terminalRetry = await store.setRuntimeStatus({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-first",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "terminal-shared",
      at: at(3_500),
      status: "completed",
      reason: "first turn completed",
      assistantTurn: {
        schemaVersion: 1,
        turnId: "turn-assistant-first",
        kind: "assistant",
        content: "Persisted first result",
        createdAt: at(3_000),
      },
    });
    expect(terminalRetry.idempotent).toBe(true);
    expect(terminalRetry.state.revision).toBe(completed.state.revision);
    const continued = await store.addTask({
      sessionId: "session-runtime",
      expectedRevision: completed.state.revision,
      idempotencyKey: "continue-second",
      task: {
        schemaVersion: 1,
        taskId: "task-second",
        sessionId: "session-runtime",
        status: "pending",
        content: "Second turn",
        createdAt: at(4_000),
        updatedAt: at(4_000),
      },
      turn: {
        schemaVersion: 1,
        turnId: "turn-user-second",
        kind: "user",
        content: "Second turn",
        createdAt: at(4_000),
      },
    });
    expect(continued.state.session.status).toBe("pending");
    const next = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-second",
      leaseId: "lease-second",
      now: at(5_000),
      leaseDurationMs: 20_000,
    });
    expect(next?.task.taskId).toBe("task-second");
    expect(next?.session.turns.map((turn) => turn.kind)).toEqual(["assistant", "user"]);
    const secondAck = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-second",
      leaseId: "lease-second",
      runtimeId: "runtime-a",
      expectedRevision: next!.revision,
      idempotencyKey: "ack-first",
      at: at(6_000),
    });
    const secondCompletion = await store.setRuntimeStatus({
      sessionId: "session-runtime",
      taskId: "task-second",
      leaseId: "lease-second",
      runtimeId: "runtime-a",
      expectedRevision: secondAck.state.revision,
      idempotencyKey: "terminal-shared",
      at: at(7_000),
      status: "completed",
      reason: "second turn completed",
    });
    expect(secondCompletion.state).toMatchObject({
      session: { status: "idle" },
      tasks: [
        { taskId: "task-runtime", status: "completed" },
        { taskId: "task-second", status: "completed" },
      ],
    });
  });

  it("fences one worker and fails acknowledged work for reconciliation instead of re-leasing it", async () => {
    const { store } = await setup();
    const first = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "lease-a",
      now: at(1_000),
      leaseDurationMs: 5_000,
    });
    expect(first?.lease.generation).toBe(1);
    expect(
      await store.leaseNextRuntimeWork({
        runtimeId: "runtime-b",
        claimId: "claim-b",
        leaseId: "lease-b",
        now: at(2_000),
        leaseDurationMs: 5_000,
      })
    ).toBeNull();
    const retried = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "new-lease-id-is-ignored",
      now: at(2_000),
      leaseDurationMs: 5_000,
    });
    expect(retried?.lease.leaseId).toBe("lease-a");

    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-a",
      runtimeId: "runtime-a",
      expectedRevision: first!.revision,
      idempotencyKey: "ack-a",
      at: at(2_100),
    });
    const ackRetry = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-a",
      runtimeId: "runtime-a",
      expectedRevision: first!.revision,
      idempotencyKey: "ack-a",
      at: at(2_100),
    });
    expect(ackRetry.idempotent).toBe(true);
    const renewed = await store.renewRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-a",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "renew-a",
      at: at(3_000),
      leaseDurationMs: 5_000,
    });
    const renewedRetry = await store.renewRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-a",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "renew-a",
      at: at(8_100),
      leaseDurationMs: 5_000,
    });
    expect(renewedRetry.idempotent).toBe(true);
    expect(renewedRetry.state.tasks[0].lease?.expiresAt).toBe(renewed.state.tasks[0].lease?.expiresAt);
    await expect(
      store.publishRuntimeEvents({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-a",
        runtimeId: "runtime-a",
        expectedRevision: renewed.state.revision,
        idempotencyKey: "stale-publication",
        at: at(8_200),
        drafts: [
          {
            schemaVersion: 1,
            draftId: "draft-stale",
            ordinal: 1,
            timestamp: at(7_999),
            kind: "model",
            payload: { text: "stale" },
          },
        ],
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
    const takeover = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-b",
      claimId: "claim-b",
      leaseId: "lease-b",
      now: at(8_201),
      leaseDurationMs: 5_000,
    });
    expect(takeover).toBeNull();
    const reconciled = await store.getSession("session-runtime");
    expect(reconciled).toMatchObject({
      session: { status: "failed" },
      tasks: [{ status: "failed" }],
    });
    expect(reconciled?.tasks[0]).not.toHaveProperty("lease");
    const acknowledgedRetry = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-a",
      runtimeId: "runtime-a",
      expectedRevision: first!.revision,
      idempotencyKey: "ack-a",
      at: at(8_202),
    });
    expect(acknowledgedRetry.idempotent).toBe(true);
    expect(acknowledgedRetry.state.session.status).toBe("failed");
  });

  it("publishes authenticated committed evidence after lease expiry without restoring execution authority", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-late-recovery",
      leaseId: "lease-late-recovery",
      now: at(1_000),
      leaseDurationMs: 5_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-late-recovery",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-late-recovery",
      at: at(2_000),
    });
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-late-recovery",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-late-recovery",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-late-recovery",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-late-recovery",
            invocationDigest: CANCELLATION_INVOCATION_DIGEST,
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    expect(
      await store.leaseNextRuntimeWork({
        runtimeId: "runtime-b",
        claimId: "claim-expire-late-recovery",
        leaseId: "lease-expire-late-recovery",
        now: at(6_001),
        leaseDurationMs: 5_000,
      })
    ).toBeNull();
    const result: ToolResult = {
      schemaVersion: 1,
      invocationId: "invocation-late-recovery",
      status: "succeeded",
      completedAt: at(6_100),
      summary: "Host mutation committed.",
      output: { committed: true },
      evidence: [],
      mutationCommit: { committed: true, point: "atomic-rename" },
    };
    const digest = resultDigest(result);
    const receipt = recoveryReceipt({
      runtimeId: "runtime-a",
      leaseId: "lease-late-recovery",
      leaseGeneration: 1,
      sessionId: "session-runtime",
      taskId: "task-runtime",
      invocationId: result.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 42,
      resultDigest: digest,
      outcome: "committed",
    });
    const input = {
      sessionId: "session-runtime",
      taskId: "task-runtime",
      runtimeId: "runtime-a",
      leaseId: "lease-late-recovery",
      leaseGeneration: 1,
      invocationId: result.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 42,
      resultDigest: digest,
      result,
      terminalReceipt: receipt,
      idempotencyKey: "late-recovery-publication",
      at: at(6_200),
    } as const;
    const published = await store.publishRuntimeRecovery(input);
    const duplicate = await store.publishRuntimeRecovery({ ...input, idempotencyKey: "late-recovery-duplicate" });
    expect(published.state.tasks[0]).toMatchObject({
      status: "completed",
      runtimeRecoveries: [
        {
          outcome: "committed",
          leaseGeneration: 1,
          journalSequence: 42,
          resultDigest: digest,
          taskStatus: "completed",
          sessionStatus: "idle",
        },
      ],
    });
    expect(published.state.tasks[0]).not.toHaveProperty("lease");
    expect(published.event.eventId).toBe(duplicate.event.eventId);
    expect(duplicate.idempotent).toBe(true);
    expect(published.state.events.filter((event) => event.kind === "tool-result")).toHaveLength(1);
    expect((await store.getSession("session-runtime"))?.tasks[0].activeRuntimeInvocation).toBeUndefined();
    expect(proposal.state.tasks[0].activeRuntimeInvocation?.invocationId).toBe("invocation-late-recovery");
    const continued = await store.addTask({
      sessionId: "session-runtime",
      expectedRevision: duplicate.state.revision,
      idempotencyKey: "continue-after-late-recovery",
      task: {
        schemaVersion: 1,
        taskId: "task-after-late-recovery",
        sessionId: "session-runtime",
        status: "pending",
        content: "Continue after the authenticated terminal publication.",
        createdAt: at(6_300),
        updatedAt: at(6_300),
      },
    });
    const lostResponseRetry = await store.publishRuntimeRecovery({
      ...input,
      idempotencyKey: "late-recovery-after-continuation",
      at: at(6_400),
    });
    expect(continued.state.session.status).toBe("pending");
    expect(lostResponseRetry.idempotent).toBe(true);
    expect(lostResponseRetry.state.session.status).toBe("pending");
    expect(lostResponseRetry.state.tasks[0].runtimeRecoveries?.[0]).toMatchObject({
      taskStatus: "completed",
      sessionStatus: "idle",
      publicationRevision: published.state.revision,
    });
  });

  it("replaces a synthetic indeterminate event with exact terminal evidence before acknowledgement", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-synthetic-recovery",
      leaseId: "lease-synthetic-recovery",
      now: at(1_000),
      leaseDurationMs: 5_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-synthetic-recovery",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-synthetic-recovery",
      at: at(2_000),
    });
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-synthetic-recovery",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-synthetic-recovery",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-synthetic-recovery",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-synthetic-recovery",
            invocationDigest: CANCELLATION_INVOCATION_DIGEST,
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const synthetic: ToolResult = {
      schemaVersion: 1,
      invocationId: "invocation-synthetic-recovery",
      status: "indeterminate",
      completedAt: at(3_500),
      summary: "transport response was lost",
      output: { code: "indeterminate-effect", reconciliation: "required" },
      evidence: [],
    };
    const syntheticPublished = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-synthetic-recovery",
      runtimeId: "runtime-a",
      expectedRevision: proposal.state.revision,
      idempotencyKey: "synthetic-result-recovery",
      at: at(3_500),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "synthetic-result-recovery",
          ordinal: 2,
          timestamp: at(3_500),
          kind: "tool-result",
          payload: synthetic as unknown as JsonObject,
        },
      ],
    });
    const terminal: ToolResult = {
      ...synthetic,
      status: "succeeded",
      completedAt: at(4_000),
      summary: "authoritative terminal result Bearer secret-recovery-canary",
      output: { committed: true, message: "Bearer secret-recovery-canary" },
      mutationCommit: { committed: true, point: "atomic-rename" },
    };
    const digest = resultDigest(terminal);
    const recoveryInput = {
      sessionId: "session-runtime",
      taskId: "task-runtime",
      runtimeId: "runtime-a",
      leaseId: "lease-synthetic-recovery",
      leaseGeneration: 1,
      invocationId: terminal.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 42,
      resultDigest: digest,
      result: terminal,
      terminalReceipt: recoveryReceipt({
        runtimeId: "runtime-a",
        leaseId: "lease-synthetic-recovery",
        leaseGeneration: 1,
        sessionId: "session-runtime",
        taskId: "task-runtime",
        invocationId: terminal.invocationId,
        invocationDigest: CANCELLATION_INVOCATION_DIGEST,
        journalSequence: 42,
        resultDigest: digest,
        outcome: "committed",
      }),
      idempotencyKey: "terminal-synthetic-recovery",
      at: at(4_100),
    } as const;
    const published = await store.publishRuntimeRecovery(recoveryInput);
    const duplicate = await store.publishRuntimeRecovery({
      ...recoveryInput,
      idempotencyKey: "terminal-synthetic-recovery-retry",
      at: at(4_200),
    });
    const toolResults = published.state.events.filter((event) => event.kind === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.eventId).toBe(
      syntheticPublished.state.events.find((event) => event.eventId === "synthetic-result-recovery")?.eventId
    );
    expect(toolResults[0]?.payload.data).toMatchObject({ status: "succeeded", mutationCommit: { committed: true } });
    const recovery = published.state.tasks[0].runtimeRecoveries?.[0];
    expect(recovery?.resultDigest).toBe(digest);
    expect(recovery?.persistedResultDigest).toBe(resultDigest(recovery!.result));
    expect(recovery?.persistedResultDigest).not.toBe(digest);
    expect(JSON.stringify(recovery?.result)).not.toContain("secret-recovery-canary");
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.event.eventId).toBe(published.event.eventId);
  });

  it("replaces authenticated indeterminate recovery only with a newer clean-start epoch proof", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-clean-start-recovery",
      leaseId: "lease-clean-start-recovery",
      now: at(1_000),
      leaseDurationMs: 5_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-clean-start-recovery",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-clean-start-recovery",
      at: at(2_000),
    });
    await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-clean-start-recovery",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-clean-start-recovery",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-clean-start-recovery",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-clean-start-recovery",
            invocationDigest: CANCELLATION_INVOCATION_DIGEST,
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const indeterminate: ToolResult = {
      schemaVersion: 1,
      invocationId: "invocation-clean-start-recovery",
      status: "indeterminate",
      completedAt: at(4_000),
      summary: "effect truth is unresolved",
      output: { code: "indeterminate-effect", reconciliation: "required" },
      evidence: [],
    };
    const indeterminateDigest = resultDigest(indeterminate);
    const firstReceipt = recoveryReceipt({
      runtimeId: "runtime-a",
      leaseId: "lease-clean-start-recovery",
      leaseGeneration: 1,
      sessionId: "session-runtime",
      taskId: "task-runtime",
      invocationId: indeterminate.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 42,
      resultDigest: indeterminateDigest,
      outcome: "indeterminate",
    });
    const first = await store.publishRuntimeRecovery({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      runtimeId: "runtime-a",
      leaseId: "lease-clean-start-recovery",
      leaseGeneration: 1,
      invocationId: indeterminate.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 42,
      resultDigest: indeterminateDigest,
      result: indeterminate,
      terminalReceipt: firstReceipt,
      idempotencyKey: "indeterminate-clean-start-recovery",
      at: at(4_100),
    });
    const cleanStart: ToolResult = {
      schemaVersion: 1,
      invocationId: indeterminate.invocationId,
      status: "failed",
      completedAt: at(5_000),
      summary: "root-authorized clean start proved no active effect",
      output: { code: "reconciliation-clean-start", reconciliation: "completed", noActiveEffect: true },
      evidence: [],
      mutationCommit: { committed: false },
    };
    const cleanStartDigest = resultDigest(cleanStart);
    const cleanReceipt: BackupTerminalReceipt = {
      ...recoveryReceipt({
        runtimeId: "runtime-a",
        leaseId: "lease-clean-start-recovery",
        leaseGeneration: 1,
        sessionId: "session-runtime",
        taskId: "task-runtime",
        invocationId: cleanStart.invocationId,
        invocationDigest: CANCELLATION_INVOCATION_DIGEST,
        journalSequence: 43,
        resultDigest: cleanStartDigest,
        outcome: "failed",
      }),
      proofKind: "clean-start-no-active",
      executorEpoch: "executor-epoch-after-clean-start",
    };
    const recovered = await store.publishRuntimeRecovery({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      runtimeId: "runtime-a",
      leaseId: "lease-clean-start-recovery",
      leaseGeneration: 1,
      invocationId: cleanStart.invocationId,
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      journalSequence: 43,
      resultDigest: cleanStartDigest,
      result: cleanStart,
      terminalReceipt: cleanReceipt,
      idempotencyKey: "clean-start-recovery",
      at: at(5_100),
    });

    expect(first.state.tasks[0].runtimeRecoveries?.[0]?.outcome).toBe("indeterminate");
    expect(recovered.state.tasks[0].runtimeRecoveries).toEqual([
      expect.objectContaining({
        outcome: "failed",
        journalSequence: 43,
        resultDigest: cleanStartDigest,
        terminalReceipt: expect.objectContaining({ proofKind: "clean-start-no-active" }),
      }),
    ]);
    expect(recovered.state.events.filter((event) => event.kind === "tool-result")).toHaveLength(1);
    expect(recovered.event.payload.data).toMatchObject({
      status: "failed",
      output: { code: "reconciliation-clean-start", noActiveEffect: true },
    });
  });

  it("rejects late evidence when a replacement invocation owns the durable task handoff", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-replacement-recovery",
      leaseId: "lease-replacement-recovery",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-replacement-recovery",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-replacement-recovery",
      at: at(2_000),
    });
    const first = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-replacement-recovery",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-old-recovery",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-old-recovery",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-old-recovery",
            invocationDigest: "b".repeat(64),
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const oldResult: ToolResult = {
      schemaVersion: 1,
      invocationId: "invocation-old-recovery",
      status: "failed",
      completedAt: at(4_000),
      summary: "old result",
      output: { code: "failed" },
      evidence: [],
    };
    const second = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-replacement-recovery",
      runtimeId: "runtime-a",
      expectedRevision: first.state.revision,
      idempotencyKey: "result-old-recovery",
      at: at(4_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "result-old-recovery",
          ordinal: 2,
          timestamp: at(4_000),
          kind: "tool-result",
          payload: oldResult as unknown as JsonObject,
        },
      ],
    });
    const replacement = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-replacement-recovery",
      runtimeId: "runtime-a",
      expectedRevision: second.state.revision,
      idempotencyKey: "proposal-new-recovery",
      at: at(5_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-new-recovery",
          ordinal: 3,
          timestamp: at(5_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-new-recovery",
            invocationDigest: "c".repeat(64),
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const oldDigest = resultDigest(oldResult);
    await expect(
      store.publishRuntimeRecovery({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        runtimeId: "runtime-a",
        leaseId: "lease-replacement-recovery",
        leaseGeneration: 1,
        invocationId: oldResult.invocationId,
        invocationDigest: "b".repeat(64),
        journalSequence: 9,
        resultDigest: oldDigest,
        result: oldResult,
        terminalReceipt: recoveryReceipt({
          runtimeId: "runtime-a",
          leaseId: "lease-replacement-recovery",
          leaseGeneration: 1,
          sessionId: "session-runtime",
          taskId: "task-runtime",
          invocationId: oldResult.invocationId,
          invocationDigest: "b".repeat(64),
          journalSequence: 9,
          resultDigest: oldDigest,
          outcome: "failed",
        }),
        idempotencyKey: "old-after-replacement",
        at: at(6_000),
      })
    ).rejects.toThrow(/replacement/i);
    expect(replacement.state.tasks[0].activeRuntimeInvocation?.invocationId).toBe("invocation-new-recovery");
  });

  it("reassigns only expired pending work that was never acknowledged", async () => {
    const { store } = await setup();
    await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "lease-a",
      now: at(1_000),
      leaseDurationMs: 5_000,
    });
    const takeover = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-b",
      claimId: "claim-b",
      leaseId: "lease-b",
      now: at(6_001),
      leaseDurationMs: 5_000,
    });
    expect(takeover?.lease).toMatchObject({ runtimeId: "runtime-b", generation: 2 });
    expect(takeover?.task.status).toBe("pending");
  });

  it("sequences redacted drafts server-side and rejects gaps without exposing runtime internals publicly", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-events",
      leaseId: "lease-events",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const ack = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-events",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-events",
      at: at(2_000),
    });
    const publication = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-events",
      runtimeId: "runtime-a",
      expectedRevision: ack.state.revision,
      idempotencyKey: "publish-events",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "draft-1",
          ordinal: 1,
          timestamp: at(2_100),
          kind: "model",
          payload: { text: "Bearer secret-canary-value" },
        },
        {
          schemaVersion: 1,
          draftId: "draft-2",
          ordinal: 2,
          timestamp: at(2_200),
          kind: "completion",
          payload: { status: "completed" },
        },
      ],
    });
    expect(publication.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(publication.state)).not.toContain("secret-canary-value");
    const retry = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-events",
      runtimeId: "runtime-a",
      expectedRevision: ack.state.revision,
      idempotencyKey: "publish-events",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "draft-1",
          ordinal: 1,
          timestamp: at(2_100),
          kind: "model",
          payload: { text: "Bearer secret-canary-value" },
        },
        {
          schemaVersion: 1,
          draftId: "draft-2",
          ordinal: 2,
          timestamp: at(2_200),
          kind: "completion",
          payload: { status: "completed" },
        },
      ],
    });
    expect(retry.idempotent).toBe(true);
    await expect(
      store.publishRuntimeEvents({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-events",
        runtimeId: "runtime-a",
        expectedRevision: publication.state.revision,
        idempotencyKey: "publish-gap",
        at: at(4_000),
        drafts: [
          {
            schemaVersion: 1,
            draftId: "draft-4",
            ordinal: 4,
            timestamp: at(4_000),
            kind: "model",
            payload: { text: "gap" },
          },
        ],
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
  });

  it("durably records a committed tool result that reconciles after session cancellation", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-cancel-race",
      leaseId: "lease-cancel-race",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const ack = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-cancel-race",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-cancel-race",
      at: at(2_000),
    });
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-cancel-race",
      runtimeId: "runtime-a",
      expectedRevision: ack.state.revision,
      idempotencyKey: "proposal-cancel-race",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-cancel-race",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-cancel-race",
            invocationDigest: CANCELLATION_INVOCATION_DIGEST,
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    const cancelled = await store.cancelSession({
      sessionId: "session-runtime",
      expectedRevision: proposal.state.revision,
      idempotencyKey: "cancel-after-commit",
      requestedAt: at(4_000),
      requestedBy: "actor-runtime",
      reason: "Cancellation raced with a committed mutation.",
    });
    const publicationInput = {
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-cancel-race",
      runtimeId: "runtime-a",
      expectedRevision: cancelled.state.revision,
      idempotencyKey: "result-cancel-race",
      at: at(5_000),
      drafts: [
        {
          schemaVersion: 1 as const,
          draftId: "result-cancel-race",
          ordinal: 2,
          timestamp: at(5_000),
          kind: "tool-result" as const,
          payload: {
            schemaVersion: 1,
            invocationId: "invocation-cancel-race",
            status: "succeeded",
            completedAt: at(4_500),
            summary: "Mutation committed.",
            output: { committed: true },
            evidence: [],
            mutationCommit: { committed: true, point: "atomic-rename" },
          },
        },
      ],
    };
    await expect(
      store.publishRuntimeEvents({
        ...publicationInput,
        idempotencyKey: "expired-result-cancel-race",
        at: at(1_805_000),
      })
    ).rejects.toThrow(/expired/);
    await expect(
      store.publishRuntimeEvents({
        ...publicationInput,
        idempotencyKey: "different-result-cancel-race",
        drafts: [
          {
            ...publicationInput.drafts[0],
            draftId: "different-result-cancel-race",
            payload: { ...publicationInput.drafts[0].payload, invocationId: "different-invocation" },
          },
        ],
      })
    ).rejects.toThrow(/receipt/);
    const reconciled = await store.publishRuntimeEvents(publicationInput);
    const retry = await store.publishRuntimeEvents(publicationInput);

    expect(reconciled.state.session.status).toBe("cancelled");
    expect(reconciled.events[0]).toMatchObject({
      kind: "tool-result",
      payload: { data: { status: "succeeded", mutationCommit: { committed: true, point: "atomic-rename" } } },
    });
    expect(retry.idempotent).toBe(true);
    expect(reconciled.state.tasks[0]).not.toHaveProperty("lease");
    expect(reconciled.state.tasks[0].cancellationReconciliation).toMatchObject({
      invocationId: "invocation-cancel-race",
      invocationDigest: CANCELLATION_INVOCATION_DIGEST,
      resultDraftId: "result-cancel-race",
      consumedAt: at(5_000),
    });
    await expect(
      store.publishRuntimeEvents({
        ...publicationInput,
        expectedRevision: reconciled.state.revision,
        idempotencyKey: "second-result-cancel-race",
        drafts: [
          {
            ...publicationInput.drafts[0],
            draftId: "second-result-cancel-race",
            ordinal: 3,
          },
        ],
      })
    ).rejects.toThrow(/receipt/);
  });

  it("tracks one exact in-flight invocation per task and clears it only with the matching result", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-single-flight",
      leaseId: "lease-single-flight",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const ack = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-single-flight",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-single-flight",
      at: at(2_000),
    });
    const first = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-single-flight",
      runtimeId: "runtime-a",
      expectedRevision: ack.state.revision,
      idempotencyKey: "proposal-single-flight-a",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-single-flight-a",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-a",
            invocationDigest: "a".repeat(64),
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    await expect(
      store.publishRuntimeEvents({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-single-flight",
        runtimeId: "runtime-a",
        expectedRevision: first.state.revision,
        idempotencyKey: "proposal-single-flight-b-early",
        at: at(4_000),
        drafts: [
          {
            schemaVersion: 1,
            draftId: "proposal-single-flight-b-early",
            ordinal: 2,
            timestamp: at(4_000),
            kind: "tool-proposal",
            payload: {
              invocationId: "invocation-b",
              invocationDigest: "b".repeat(64),
              capability: "workspace.write",
              targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
            },
          },
        ],
      })
    ).rejects.toThrow(/more than one in-flight/);
    const result = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-single-flight",
      runtimeId: "runtime-a",
      expectedRevision: first.state.revision,
      idempotencyKey: "result-single-flight-a",
      at: at(5_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "result-single-flight-a",
          ordinal: 2,
          timestamp: at(5_000),
          kind: "tool-result",
          payload: { invocationId: "invocation-a", status: "failed" },
        },
      ],
    });
    const second = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-single-flight",
      runtimeId: "runtime-a",
      expectedRevision: result.state.revision,
      idempotencyKey: "proposal-single-flight-b",
      at: at(6_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-single-flight-b",
          ordinal: 3,
          timestamp: at(6_000),
          kind: "tool-proposal",
          payload: {
            invocationId: "invocation-b",
            invocationDigest: "b".repeat(64),
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      ],
    });
    expect(second.state.tasks[0].activeRuntimeInvocation).toMatchObject({
      invocationId: "invocation-b",
      invocationDigest: "b".repeat(64),
      proposalOrdinal: 3,
    });
  });

  it("accepts only server-controlled pending approvals bound to a persisted proposal digest", async () => {
    const { store } = await setup();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-approval",
      leaseId: "lease-approval",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const ack = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-approval",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-approval",
      at: at(2_000),
    });
    const digest = "d".repeat(64);
    const invocationSummary = {
      schemaVersion: 1 as const,
      invocationId: "invocation-runtime",
      invocationDigest: digest,
      toolId: "workspace.write",
      capability: "workspace.write" as const,
      targetScope: { schemaVersion: 1 as const, kind: "workspace" as const, normalizedTarget: "server.properties" },
      risk: "risky" as const,
      sanitizedArguments: { path: "server.properties" },
      diffSummary: "File target: server.properties",
    };
    const invocationSummaryDigest = await createInvocationSummaryDigest(invocationSummary);
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-approval",
      runtimeId: "runtime-a",
      expectedRevision: ack.state.revision,
      idempotencyKey: "proposal-approval",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-approval",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId: invocationSummary.invocationId,
            invocationDigest: digest,
            invocationSummaryDigest,
            toolId: invocationSummary.toolId,
            capability: "workspace.write",
            targetScope: invocationSummary.targetScope,
          },
        },
      ],
    });
    const pending: AgentApproval = {
      schemaVersion: 1,
      approvalId: "approval-runtime",
      actorId: "actor-runtime",
      sessionId: "session-runtime",
      policyId: "policy-runtime",
      policyRevision: 1,
      invocationDigest: digest,
      invocationSummary,
      invocationSummaryDigest,
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: "workspace.write",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
        risk: "risky",
      },
      expiresAt: at(19_000),
      decision: "pending",
      reason: "runtime request",
    };
    await expect(
      store.putRuntimeApproval({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-approval",
        runtimeId: "runtime-a",
        expectedRevision: proposal.state.revision,
        idempotencyKey: "wrong-digest",
        at: at(4_000),
        approval: {
          ...pending,
          invocationDigest: "e".repeat(64),
          invocationSummary: { ...invocationSummary, invocationDigest: "e".repeat(64) },
          invocationSummaryDigest: await createInvocationSummaryDigest({
            ...invocationSummary,
            invocationDigest: "e".repeat(64),
          }),
        },
      })
    ).rejects.toThrow(/persisted proposal/i);
    const tamperedSummary = { ...invocationSummary, toolId: "workspace.delete" };
    await expect(
      store.putRuntimeApproval({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-approval",
        runtimeId: "runtime-a",
        expectedRevision: proposal.state.revision,
        idempotencyKey: "tampered-tool",
        at: at(4_000),
        approval: {
          ...pending,
          invocationSummary: tamperedSummary,
          invocationSummaryDigest: await createInvocationSummaryDigest(tamperedSummary),
        },
      })
    ).rejects.toThrow(/persisted proposal/i);
    await expect(
      store.putRuntimeApproval({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: "lease-approval",
        runtimeId: "runtime-a",
        expectedRevision: proposal.state.revision,
        idempotencyKey: "pre-decided",
        at: at(4_000),
        approval: { ...pending, decision: "approved", decidedAt: at(3_500) },
      })
    ).rejects.toThrow(/pending approval/i);
    const accepted = await store.putRuntimeApproval({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-approval",
      runtimeId: "runtime-a",
      expectedRevision: proposal.state.revision,
      idempotencyKey: "pending-approval",
      at: at(4_000),
      approval: pending,
    });
    expect(accepted.state.approvals[0]).toMatchObject({
      actorId: "actor-runtime",
      policyId: "policy-runtime",
      decision: "pending",
    });
    expect(accepted.state.approvals[0]).not.toHaveProperty("decidedAt");
    expect(accepted.state.approvals[0]).not.toHaveProperty("consumedAt");

    const decided = await store.decideApproval({
      sessionId: "session-runtime",
      approvalId: pending.approvalId,
      expectedRevision: accepted.state.revision,
      idempotencyKey: "operator-approval",
      decision: "approved",
      reason: "approved exact invocation",
      at: at(5_000),
    });
    const consumption = {
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-approval",
      runtimeId: "runtime-a",
      expectedRevision: decided.state.revision,
      idempotencyKey: "consume-after-ambiguous-response",
      approvalId: pending.approvalId,
      invocationDigest: digest,
    };
    const consumed = await store.consumeRuntimeApproval({ ...consumption, at: at(6_000) });
    const retry = await store.consumeRuntimeApproval({ ...consumption, at: at(7_000) });
    expect(retry.idempotent).toBe(true);
    expect(retry.state.revision).toBe(consumed.state.revision);
    expect(retry.state.approvals[0].consumedAt).toBe(at(6_000));
  });

  it.each([
    ["workspace.write", "workspace.write", "allow"],
    ["workspace.write", "workspace.write", "ask-once"],
    ["workspace.delete", "workspace.delete", "allow"],
    ["workspace.delete", "workspace.delete", "ask-once"],
    ["network.download", "network.outbound", "allow"],
    ["network.download", "network.outbound", "ask-once"],
  ] as const)(
    "authorizes destructive server.properties %s (%s) with base %s only by exact digest",
    async (toolId, capability, baseDecision) => {
      const { store } = await setup({ capability, decision: baseDecision });
      const leaseId = `lease-${toolId.replace(".", "-")}-${baseDecision}`;
      const work = await store.leaseNextRuntimeWork({
        runtimeId: "runtime-a",
        claimId: `claim-${toolId.replace(".", "-")}-${baseDecision}`,
        leaseId,
        now: at(1_000),
        leaseDurationMs: 20_000,
      });
      const acknowledged = await store.acknowledgeRuntimeWork({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId,
        runtimeId: "runtime-a",
        expectedRevision: work!.revision,
        idempotencyKey: `ack-${toolId}-${baseDecision}`,
        at: at(2_000),
      });
      const invocationId = `invocation-${toolId.replace(".", "-")}-${baseDecision}`;
      const downloadInvocation = (id: string): ToolInvocation => ({
        schemaVersion: 1,
        invocationId: id,
        sessionId: "session-runtime",
        toolId: "network.download",
        capability: "network.outbound",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
        arguments: {
          url: "https://downloads.example.invalid/server.properties",
          destination: "server.properties",
          maxBytes: 1_024,
          expectedSha256: "a".repeat(64),
          expectedBytes: 1,
        },
        requestedAt: at(3_000),
      });
      const invocationDigest =
        toolId === "network.download" ? await createInvocationDigest(downloadInvocation(invocationId)) : "d".repeat(64);
      const differingDigest =
        toolId === "network.download"
          ? await createInvocationDigest(downloadInvocation(`${invocationId}-later-content`))
          : "e".repeat(64);
      const destination: TargetScope = {
        schemaVersion: 1,
        kind: "workspace",
        normalizedTarget: "server.properties",
      };
      const targetScope =
        toolId === "network.download"
          ? networkDownloadApprovalScope("https://downloads.example.invalid/server.properties", destination, {
              expectedSha256: "a".repeat(64),
              expectedBytes: 1,
            })
          : destination;
      const sanitizedArguments: JsonObject =
        toolId === "network.download"
          ? {
              sourceResource: "https://downloads.example.invalid/server.properties",
              destination: "server.properties",
              maxBytes: 1_024,
              expectedSha256: "a".repeat(64),
              expectedBytes: 1,
            }
          : { path: "server.properties" };
      const summary: ProposedInvocationSummary = {
        schemaVersion: 1 as const,
        invocationId,
        invocationDigest,
        toolId,
        capability,
        targetScope,
        risk: "destructive" as const,
        sanitizedArguments,
      };
      const summaryDigest = await createInvocationSummaryDigest(summary);
      const proposal = await store.publishRuntimeEvents({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId,
        runtimeId: "runtime-a",
        expectedRevision: acknowledged.state.revision,
        idempotencyKey: `proposal-${toolId}-${baseDecision}`,
        at: at(3_000),
        drafts: [
          {
            schemaVersion: 1,
            draftId: `proposal-${toolId.replace(".", "-")}-${baseDecision}`,
            ordinal: 1,
            timestamp: at(3_000),
            kind: "tool-proposal",
            payload: {
              invocationId,
              invocationDigest,
              invocationSummaryDigest: summaryDigest,
              toolId,
              capability,
              targetScope: targetScope as unknown as JsonObject,
            },
          },
        ],
      });

      let revision = proposal.state.revision;
      if (baseDecision === "ask-once") {
        const broadId = `approval-broad-${toolId.replace(".", "-")}`;
        const broadPending = await store.putRuntimeApproval({
          sessionId: "session-runtime",
          taskId: "task-runtime",
          leaseId,
          runtimeId: "runtime-a",
          expectedRevision: revision,
          idempotencyKey: `pending-broad-${toolId}`,
          at: at(4_000),
          approval: {
            schemaVersion: 1,
            approvalId: broadId,
            actorId: "actor-runtime",
            sessionId: "session-runtime",
            policyId: "policy-runtime",
            policyRevision: 1,
            invocationDigest,
            invocationSummary: summary,
            invocationSummaryDigest: summaryDigest,
            scope: { schemaVersion: 1, kind: "session-capability", capability, targetScope, risk: "destructive" },
            expiresAt: at(19_000),
            decision: "pending",
            reason: "runtime request",
          },
        });
        const broadApproved = await store.decideApproval({
          sessionId: "session-runtime",
          approvalId: broadId,
          expectedRevision: broadPending.state.revision,
          idempotencyKey: `approve-broad-${toolId}`,
          decision: "approved",
          reason: "session grant must not cover destructive work",
          at: at(5_000),
        });
        revision = broadApproved.state.revision;
        await expect(
          store.authorizeRuntimeInvocation({
            sessionId: "session-runtime",
            taskId: "task-runtime",
            leaseId,
            runtimeId: "runtime-a",
            expectedRevision: revision,
            idempotencyKey: `authorize-broad-${toolId}`,
            authorizationId: `authorization-broad-${toolId.replace(".", "-")}`,
            invocationId,
            invocationDigest,
            approvalId: broadId,
            capability,
            targetScope,
            risk: "destructive",
            at: at(6_000),
          })
        ).rejects.toThrow(/does not match/i);
      }

      const approvalId = `approval-exact-${toolId.replace(".", "-")}-${baseDecision}`;
      const exactPending = await store.putRuntimeApproval({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId,
        runtimeId: "runtime-a",
        expectedRevision: revision,
        idempotencyKey: `pending-exact-${toolId}-${baseDecision}`,
        at: at(7_000),
        approval: {
          schemaVersion: 1,
          approvalId,
          actorId: "actor-runtime",
          sessionId: "session-runtime",
          policyId: "policy-runtime",
          policyRevision: 1,
          invocationDigest,
          invocationSummary: summary,
          invocationSummaryDigest: summaryDigest,
          scope: { schemaVersion: 1, kind: "single-invocation", capability, targetScope, risk: "destructive" },
          expiresAt: at(19_000),
          decision: "pending",
          reason: "runtime request",
        },
      });
      const exactApproved = await store.decideApproval({
        sessionId: "session-runtime",
        approvalId,
        expectedRevision: exactPending.state.revision,
        idempotencyKey: `approve-exact-${toolId}-${baseDecision}`,
        decision: "approved",
        reason: "approved exact invocation",
        at: at(8_000),
      });
      await expect(
        store.authorizeRuntimeInvocation({
          sessionId: "session-runtime",
          taskId: "task-runtime",
          leaseId,
          runtimeId: "runtime-a",
          expectedRevision: exactApproved.state.revision,
          idempotencyKey: `authorize-other-digest-${toolId}-${baseDecision}`,
          authorizationId: `authorization-other-${toolId.replace(".", "-")}-${baseDecision}`,
          invocationId,
          invocationDigest: differingDigest,
          approvalId,
          capability,
          targetScope,
          risk: "destructive",
          at: at(9_000),
        })
      ).rejects.toThrow(/does not match/i);
      const authorized = await store.authorizeRuntimeInvocation({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId,
        runtimeId: "runtime-a",
        expectedRevision: exactApproved.state.revision,
        idempotencyKey: `authorize-exact-${toolId}-${baseDecision}`,
        authorizationId: `authorization-exact-${toolId.replace(".", "-")}-${baseDecision}`,
        invocationId,
        invocationDigest,
        approvalId,
        capability,
        targetScope,
        risk: "destructive",
        at: at(9_000),
      });
      expect(authorized.authorization).toMatchObject({
        approvalKind: "ask-always",
        invocationDigest,
        approvalId,
      });
    }
  );

  it("requires the exact active runtime invocation and preserves the fence across continuation", async () => {
    const { store } = await setup();
    const targetScope: TargetScope = {
      schemaVersion: 1,
      kind: "workspace",
      normalizedTarget: "server.properties",
    };
    const digest = "f".repeat(64);
    const invocationId = "invocation-exact-active";
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-exact-active",
      leaseId: "lease-exact-active",
      now: at(1_000),
      leaseDurationMs: 20_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: work!.revision,
      idempotencyKey: "ack-exact-active",
      at: at(2_000),
    });
    const summary = {
      schemaVersion: 1 as const,
      invocationId,
      invocationDigest: digest,
      toolId: "workspace.write",
      capability: "workspace.write" as const,
      targetScope,
      risk: "risky" as const,
      sanitizedArguments: { path: "server.properties" },
    };
    const summaryDigest = await createInvocationSummaryDigest(summary);
    const proposal = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: acknowledged.state.revision,
      idempotencyKey: "proposal-exact-active",
      at: at(3_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "proposal-exact-active",
          ordinal: 1,
          timestamp: at(3_000),
          kind: "tool-proposal",
          payload: {
            invocationId,
            invocationDigest: digest,
            invocationSummaryDigest: summaryDigest,
            toolId: "workspace.write",
            capability: "workspace.write",
            targetScope: targetScope as unknown as JsonObject,
          },
        },
      ],
    });
    const pending = await store.putRuntimeApproval({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: proposal.state.revision,
      idempotencyKey: "pending-exact-active",
      at: at(4_000),
      approval: {
        schemaVersion: 1,
        approvalId: "approval-exact-active",
        actorId: "actor-runtime",
        sessionId: "session-runtime",
        policyId: "policy-runtime",
        policyRevision: 1,
        invocationDigest: digest,
        invocationSummary: summary,
        invocationSummaryDigest: summaryDigest,
        scope: {
          schemaVersion: 1,
          kind: "session-capability",
          capability: "workspace.write",
          targetScope,
          risk: "risky",
        },
        expiresAt: at(19_000),
        decision: "pending",
        reason: "exact active invocation",
      },
    });
    const approved = await store.decideApproval({
      sessionId: "session-runtime",
      approvalId: "approval-exact-active",
      expectedRevision: pending.state.revision,
      idempotencyKey: "approve-exact-active",
      decision: "approved",
      reason: "approved exact active invocation",
      at: at(5_000),
    });
    const authorization = {
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: approved.state.revision,
      idempotencyKey: "authorize-exact-active",
      authorizationId: "authorization-exact-active",
      invocationId,
      invocationDigest: digest,
      approvalId: "approval-exact-active",
      capability: "workspace.write" as const,
      targetScope,
      risk: "risky" as const,
      at: at(6_000),
    };
    for (const [name, change] of [
      ["runtime", { runtimeId: "runtime-b" }],
      ["session", { sessionId: "session-other" }],
      ["task", { taskId: "task-other" }],
      ["lease", { leaseId: "lease-other" }],
      ["invocation", { invocationId: "invocation-other" }],
      ["digest", { invocationDigest: "e".repeat(64) }],
      ["capability", { capability: "workspace.delete" as const }],
      ["scope", { targetScope: { ...targetScope, normalizedTarget: "other.properties" } }],
    ] as const) {
      await expect(
        store.authorizeRuntimeInvocation({
          ...authorization,
          ...change,
          idempotencyKey: `authorize-transplant-${name}`,
          authorizationId: `authorization-transplant-${name}`,
        })
      ).rejects.toThrow();
    }
    await expect(store.authorizeRuntimeInvocation(authorization)).resolves.toMatchObject({
      authorization: {
        runtimeId: "runtime-a",
        leaseId: "lease-exact-active",
        taskId: "task-runtime",
        invocationId,
        invocationDigest: digest,
        capability: "workspace.write",
        targetScope,
      },
    });
    const resumed = await store.setRuntimeStatus({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: approved.state.revision + 1,
      idempotencyKey: "resume-exact-active",
      at: at(6_500),
      status: "running",
      reason: "resume exact invocation",
    });

    const result = await store.publishRuntimeEvents({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: resumed.state.revision,
      idempotencyKey: "result-exact-active",
      at: at(7_000),
      drafts: [
        {
          schemaVersion: 1,
          draftId: "result-exact-active",
          ordinal: 2,
          timestamp: at(7_000),
          kind: "tool-result",
          payload: { invocationId, status: "succeeded" },
        },
      ],
    });
    const continued = await store.setRuntimeStatus({
      sessionId: "session-runtime",
      taskId: "task-runtime",
      leaseId: "lease-exact-active",
      runtimeId: "runtime-a",
      expectedRevision: result.state.revision,
      idempotencyKey: "complete-exact-active",
      at: at(8_000),
      status: "completed",
      reason: "exact invocation completed",
    });
    const next = await store.addTask({
      sessionId: "session-runtime",
      expectedRevision: continued.state.revision,
      idempotencyKey: "add-continuation",
      task: {
        schemaVersion: 1,
        taskId: "task-continuation",
        sessionId: "session-runtime",
        status: "pending",
        content: "Continue the exact session",
        createdAt: at(9_000),
        updatedAt: at(9_000),
      },
    });
    const continuedWork = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-b",
      claimId: "claim-continuation",
      leaseId: "lease-continuation",
      now: at(10_000),
      leaseDurationMs: 20_000,
    });
    expect(continuedWork?.task.taskId).toBe("task-continuation");
    expect(next.state.tasks.some((task) => task.taskId === "task-continuation")).toBe(true);
  });

  it.each(["revocation-first", "authorization-first"] as const)(
    "linearizes ask-once invocation authorization against %s ordering",
    async (ordering) => {
      const { store } = await setup();
      const work = await store.leaseNextRuntimeWork({
        runtimeId: "runtime-a",
        claimId: `claim-${ordering}`,
        leaseId: `lease-${ordering}`,
        now: at(1_000),
        leaseDurationMs: 20_000,
      });
      const ack = await store.acknowledgeRuntimeWork({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: `lease-${ordering}`,
        runtimeId: "runtime-a",
        expectedRevision: work!.revision,
        idempotencyKey: `ack-${ordering}`,
        at: at(2_000),
      });
      const digest = ordering === "revocation-first" ? "a".repeat(64) : "b".repeat(64);
      const invocationId = `invocation-${ordering}`;
      const targetScope = {
        schemaVersion: 1 as const,
        kind: "workspace" as const,
        normalizedTarget: "config/server.properties",
      };
      const summary = {
        schemaVersion: 1 as const,
        invocationId,
        invocationDigest: digest,
        toolId: "workspace.write",
        capability: "workspace.write" as const,
        targetScope,
        risk: "risky" as const,
        sanitizedArguments: { path: "config/server.properties" },
      };
      const summaryDigest = await createInvocationSummaryDigest(summary);
      const proposal = await store.publishRuntimeEvents({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: `lease-${ordering}`,
        runtimeId: "runtime-a",
        expectedRevision: ack.state.revision,
        idempotencyKey: `proposal-${ordering}`,
        at: at(3_000),
        drafts: [
          {
            schemaVersion: 1,
            draftId: `proposal-${ordering}`,
            ordinal: 1,
            timestamp: at(3_000),
            kind: "tool-proposal",
            payload: {
              invocationId,
              invocationDigest: digest,
              invocationSummaryDigest: summaryDigest,
              toolId: "workspace.write",
              capability: "workspace.write",
              targetScope,
            },
          },
        ],
      });
      const approvalId = `approval-${ordering}`;
      const pending = await store.putRuntimeApproval({
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: `lease-${ordering}`,
        runtimeId: "runtime-a",
        expectedRevision: proposal.state.revision,
        idempotencyKey: `pending-${ordering}`,
        at: at(4_000),
        approval: {
          schemaVersion: 1,
          approvalId,
          actorId: "actor-runtime",
          sessionId: "session-runtime",
          policyId: "policy-runtime",
          policyRevision: 1,
          invocationDigest: digest,
          invocationSummary: summary,
          invocationSummaryDigest: summaryDigest,
          scope: {
            schemaVersion: 1,
            kind: "session-capability",
            capability: "workspace.write",
            targetScope,
            risk: "risky",
          },
          expiresAt: at(19_000),
          decision: "pending",
          reason: "runtime request",
        },
      });
      const approved = await store.decideApproval({
        sessionId: "session-runtime",
        approvalId,
        expectedRevision: pending.state.revision,
        idempotencyKey: `approve-${ordering}`,
        decision: "approved",
        reason: "approved session grant",
        at: at(5_000),
      });
      const authorizationInput = {
        sessionId: "session-runtime",
        taskId: "task-runtime",
        leaseId: `lease-${ordering}`,
        runtimeId: "runtime-a",
        idempotencyKey: `authorize-${ordering}`,
        authorizationId: `authorization-${ordering}`,
        invocationId,
        invocationDigest: digest,
        approvalId,
        capability: "workspace.write" as const,
        targetScope,
        risk: "risky" as const,
      };

      if (ordering === "revocation-first") {
        const revoked = await store.revokeApproval({
          sessionId: "session-runtime",
          approvalId,
          expectedRevision: approved.state.revision,
          idempotencyKey: "revoke-before-authorization",
          reason: "operator revoked before execution",
          at: at(6_000),
        });
        await expect(
          store.authorizeRuntimeInvocation({
            ...authorizationInput,
            expectedRevision: revoked.state.revision,
            at: at(7_000),
          })
        ).rejects.toThrow(/no longer active/i);
      } else {
        const authorized = await store.authorizeRuntimeInvocation({
          ...authorizationInput,
          expectedRevision: approved.state.revision,
          at: at(6_000),
        });
        const revoked = await store.revokeApproval({
          sessionId: "session-runtime",
          approvalId,
          expectedRevision: authorized.state.revision,
          idempotencyKey: "revoke-after-authorization",
          reason: "operator revoked after execution authorization",
          at: at(7_000),
        });
        expect(authorized.authorization).toMatchObject({
          invocationId,
          invocationDigest: digest,
          approvalId,
          approvalKind: "ask-once",
          leaseGeneration: 1,
        });
        expect(revoked.state.approvals.find((item) => item.approvalId === approvalId)?.decision).toBe("revoked");
        expect(revoked.state.tasks[0].invocationAuthorizations).toContainEqual(authorized.authorization);
      }
    }
  );
});
