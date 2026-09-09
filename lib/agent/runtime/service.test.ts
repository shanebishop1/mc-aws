import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type { BackupTerminalReceipt, ToolResult } from "@/lib/agent/contracts";
import { type AgentSessionStateStore, AgentStateConflictError, type DurableAgentSessionState } from "@/lib/agent/state";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBackupCreateRequest, RuntimeRecoveryPublicationRequest } from "./contracts";
import { AgentRuntimeService } from "./service";

const NOW = "2026-09-04T12:00:00.000Z";
const input: RuntimeBackupCreateRequest & { runtimeId: string } = {
  schemaVersion: 1,
  action: "create",
  runtimeId: "runtime-service",
  sessionId: "session-service",
  taskId: "task-service",
  leaseId: "lease-service",
  leaseGeneration: 3,
  invocationId: "invocation-service",
  invocationDigest: "a".repeat(64),
};

function state(overrides: Record<string, unknown> = {}): DurableAgentSessionState {
  return {
    schemaVersion: 1,
    revision: 8,
    session: { status: "running" },
    tasks: [
      {
        taskId: input.taskId,
        status: "running",
        lease: {
          runtimeId: input.runtimeId,
          leaseId: input.leaseId,
          generation: input.leaseGeneration,
          expiresAt: "2026-09-04T12:01:00.000Z",
        },
        activeRuntimeInvocation: {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          leaseId: input.leaseId,
          leaseGeneration: input.leaseGeneration,
          invocationId: input.invocationId,
          invocationDigest: input.invocationDigest,
          capability: "workspace.write",
          targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          proposalOrdinal: 1,
        },
      },
    ],
    events: [
      {
        kind: "tool-proposal",
        payload: {
          data: {
            invocationId: input.invocationId,
            invocationDigest: input.invocationDigest,
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
          },
        },
      },
      {
        kind: "backup",
        payload: {
          data: { invocationId: input.invocationId, invocationDigest: input.invocationDigest, status: "requested" },
        },
      },
    ],
    approvals: [],
    ...overrides,
  } as unknown as DurableAgentSessionState;
}

function service(current: DurableAgentSessionState): AgentRuntimeService {
  const store = {
    waitForRuntimeState: vi.fn(async () => current),
  } as unknown as AgentSessionStateStore;
  return new AgentRuntimeService(store, { now: () => new Date(NOW) });
}

describe("runtime backup authority", () => {
  it("accepts only the exact active invocation and lease binding", async () => {
    await expect(service(state()).assertBackupBinding(input.runtimeId, input)).resolves.toBeUndefined();
  });

  it.each([
    ["cancelled", state({ session: { status: "cancelled" } })],
    [
      "replaced",
      state({
        tasks: [
          {
            ...state().tasks[0],
            activeRuntimeInvocation: {
              ...state().tasks[0].activeRuntimeInvocation,
              invocationId: "invocation-replaced",
            },
          },
        ],
      }),
    ],
    [
      "expired lease",
      state({
        tasks: [
          {
            ...state().tasks[0],
            lease: { ...state().tasks[0].lease, expiresAt: "2026-09-04T11:59:59.000Z" },
          },
        ],
      }),
    ],
    ["revoked approval", state({ approvals: [{ invocationDigest: input.invocationDigest, decision: "revoked" }] })],
  ] as const)("fences a delayed request for a %s invocation before operation lookup", async (_reason, current) => {
    await expect(service(current).assertBackupBinding(input.runtimeId, input)).rejects.toBeInstanceOf(
      AgentStateConflictError
    );
  });
});

describe("runtime recovery publication", () => {
  const result: ToolResult = {
    schemaVersion: 1,
    invocationId: input.invocationId,
    status: "succeeded",
    completedAt: NOW,
    summary: "committed",
    output: { committed: true },
    evidence: [],
  };
  const resultDigest = createHash("sha256")
    .update(canonicalJson(result as never))
    .digest("hex");
  const terminalReceipt: BackupTerminalReceipt = {
    schemaVersion: 1,
    source: "executor-journal",
    proofKind: "terminal",
    outcome: "committed",
    executorKeyId: "executor-key",
    executorEpoch: "executor-epoch",
    runtimeId: input.runtimeId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    leaseId: input.leaseId,
    leaseGeneration: input.leaseGeneration,
    invocationId: input.invocationId,
    invocationDigest: input.invocationDigest,
    journalSequence: 7,
    resultDigest,
    completedAt: NOW,
    signature: "A".repeat(86),
  };
  const recoveryInput: RuntimeRecoveryPublicationRequest = {
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    leaseId: input.leaseId,
    leaseGeneration: input.leaseGeneration,
    invocationId: input.invocationId,
    invocationDigest: input.invocationDigest,
    journalSequence: 7,
    resultDigest,
    result,
    terminalReceipt,
    idempotencyKey: "recovery-service-test",
  };

  it("fails closed when authenticated receipt verification is unavailable", async () => {
    const publishRuntimeRecovery = vi.fn();
    const runtimeService = new AgentRuntimeService({ publishRuntimeRecovery } as unknown as AgentSessionStateStore);

    await expect(runtimeService.publishRecovery(input.runtimeId, input.leaseId, recoveryInput)).rejects.toBeInstanceOf(
      AgentStateConflictError
    );
    expect(publishRuntimeRecovery).not.toHaveBeenCalled();
  });

  it("reissues lost acknowledgement authority from immutable publication status after continuation", async () => {
    const persistedResultDigest = resultDigest;
    const recoveredState = state({
      session: { status: "pending" },
      tasks: [
        {
          ...state().tasks[0],
          status: "completed",
          lease: undefined,
          activeRuntimeInvocation: undefined,
          runtimeRecoveries: [
            {
              schemaVersion: 1,
              runtimeId: input.runtimeId,
              sessionId: input.sessionId,
              taskId: input.taskId,
              leaseId: input.leaseId,
              leaseGeneration: input.leaseGeneration,
              invocationId: input.invocationId,
              invocationDigest: input.invocationDigest,
              journalSequence: 7,
              resultDigest,
              persistedResultDigest,
              outcome: "committed",
              result,
              terminalReceipt,
              taskStatus: "completed",
              sessionStatus: "idle",
              publishedAt: NOW,
              publicationRevision: 9,
            },
          ],
        },
        { taskId: "task-continuation", status: "pending" },
      ],
    });
    const publishRuntimeRecovery = vi.fn(async () => ({
      state: recoveredState,
      idempotent: true,
      event: { eventId: "event-recovery" },
    }));
    const issueTerminalAcknowledgement = vi.fn(async (authorization) => ({
      ...authorization,
      signature: "A".repeat(86),
    }));
    const runtimeService = new AgentRuntimeService({ publishRuntimeRecovery } as unknown as AgentSessionStateStore, {
      verifyRecoveryReceipt: async () => true,
      issueTerminalAcknowledgement,
    });

    await expect(runtimeService.publishRecovery(input.runtimeId, input.leaseId, recoveryInput)).resolves.toMatchObject({
      acknowledgementAuthorization: { taskStatus: "completed", sessionStatus: "idle", publicationRevision: 9 },
    });
    expect(issueTerminalAcknowledgement).toHaveBeenCalledWith(
      expect.objectContaining({ taskStatus: "completed", sessionStatus: "idle", publicationRevision: 9 })
    );
  });

  it("signs the immutable running projection for a live invocation completion", async () => {
    const liveInput: RuntimeRecoveryPublicationRequest = {
      ...recoveryInput,
      taskDisposition: "continue",
      idempotencyKey: "live-recovery-service-test",
    };
    const recoveredState = state({
      session: { status: "running" },
      tasks: [
        {
          ...state().tasks[0],
          status: "running",
          runtimeRecoveries: [
            {
              schemaVersion: 1,
              runtimeId: input.runtimeId,
              sessionId: input.sessionId,
              taskId: input.taskId,
              leaseId: input.leaseId,
              leaseGeneration: input.leaseGeneration,
              invocationId: input.invocationId,
              invocationDigest: input.invocationDigest,
              journalSequence: 7,
              resultDigest,
              persistedResultDigest: resultDigest,
              outcome: "committed",
              result,
              terminalReceipt,
              taskDisposition: "continue",
              taskStatus: "running",
              sessionStatus: "running",
              publishedAt: NOW,
              publicationRevision: 11,
            },
          ],
        },
      ],
    });
    const issueTerminalAcknowledgement = vi.fn(async (authorization) => ({
      ...authorization,
      signature: "A".repeat(86),
    }));
    const runtimeService = new AgentRuntimeService(
      {
        publishRuntimeRecovery: vi.fn(async () => ({
          state: recoveredState,
          idempotent: false,
          event: { eventId: "event-live-recovery" },
        })),
      } as unknown as AgentSessionStateStore,
      {
        verifyRecoveryReceipt: async () => true,
        issueTerminalAcknowledgement,
      }
    );

    await expect(runtimeService.publishRecovery(input.runtimeId, input.leaseId, liveInput)).resolves.toMatchObject({
      acknowledgementAuthorization: {
        taskDisposition: "continue",
        taskStatus: "running",
        sessionStatus: "running",
        publicationRevision: 11,
      },
    });
  });
});
