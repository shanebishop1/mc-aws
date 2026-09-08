import { createHash } from "node:crypto";
import type { AgentHarnessAdapter, AgentToolExecutorAdapter } from "@/lib/agent/adapters";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type {
  AgentApproval,
  AgentEvent,
  BackupMode,
  BackupTerminalReceipt,
  JsonObject,
  PermissionDecision,
  PermissionPolicy,
  TerminalPublicationAuthorization,
  ToolInvocation,
  ToolResult,
} from "@/lib/agent/contracts";
import { createDirectLiveExecutor } from "@/lib/agent/executor";
import type { DirectLiveExecutor, DirectLiveHostEffects, RuntimeExecutionContext } from "@/lib/agent/executor";
import { createInvocationDigest } from "@/lib/agent/policy";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import type {
  RuntimeApprovalConsumptionRequest,
  RuntimeApprovalPublicationRequest,
  RuntimeDecisionPollRequest,
  RuntimeDecisionSnapshot,
  RuntimeEventPublicationRequest,
  RuntimeInvocationAuthorizationRequest,
  RuntimeLeaseMutationRequest,
  RuntimeRecoveryPublicationRequest,
  RuntimeRecoveryPublicationResult,
  RuntimeRenewRequest,
  RuntimeStatusPublicationRequest,
  RuntimeWorkLeaseDto,
  RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime/contracts";
import { RUNTIME_WORK_RESPONSE_MAX_BYTES, projectRuntimeWork } from "@/lib/agent/runtime/contracts";
import { AgentRuntimeService } from "@/lib/agent/runtime/service";
import { AgentStateConflictError, InMemoryAgentSessionStore, InMemoryAgentStateRepository } from "@/lib/agent/state";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeGateway,
  HttpRuntimeControlTransport,
  type RuntimeControlTransport,
  type RuntimeGatewayBackupAdapter,
  RuntimeTransportError,
  buildHarnessContinuationPrompt,
} from "./gateway";

const NOW = "2099-09-02T12:00:00.000Z";
const GATEWAY_SECRET = "gateway/provider+secret=canary-value";

function recoveryPublication(input: RuntimeRecoveryPublicationRequest): RuntimeRecoveryPublicationResult {
  const outcome = input.result.status === "succeeded" ? "committed" : input.result.status;
  return {
    schemaVersion: 1,
    revision: 100,
    event: {
      schemaVersion: 1,
      eventId: `recovery-${input.invocationId}`,
      sessionId: input.sessionId,
      sequence: 1,
      timestamp: input.result.completedAt,
      kind: "tool-result",
      payload: { schemaVersion: 1, redacted: true, data: input.result as unknown as JsonObject },
      replayCursor: `${input.sessionId}:1`,
    },
    ...(outcome === "indeterminate"
      ? {}
      : {
          acknowledgementAuthorization: {
            schemaVersion: 1 as const,
            source: "control-plane-terminal-publication" as const,
            runtimeId: input.runtimeId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            leaseId: input.leaseId,
            leaseGeneration: input.leaseGeneration,
            invocationId: input.invocationId,
            invocationDigest: input.invocationDigest,
            journalSequence: input.journalSequence,
            resultDigest: input.resultDigest,
            terminalReceiptDigest: createHash("sha256")
              .update(canonicalJson(input.terminalReceipt as never))
              .digest("hex"),
            outcome,
            taskStatus: outcome === "committed" ? ("completed" as const) : ("failed" as const),
            sessionStatus: outcome === "committed" ? ("idle" as const) : ("failed" as const),
            publicationRevision: 100,
            publishedAt: input.result.completedAt,
            signature: "B".repeat(86),
          },
        }),
  };
}

function executorTerminalReceipt(
  request: import("@/lib/agent/executor").ExecuteInvocationRequest,
  result: ToolResult,
  journalSequence = 1
): BackupTerminalReceipt {
  const fence = request.backupAuthorization?.status === "succeeded" ? request.backupAuthorization : undefined;
  return {
    schemaVersion: 1,
    source: "executor-journal",
    proofKind: "terminal",
    outcome: result.status === "succeeded" ? "committed" : result.status,
    executorKeyId: "executor-receipt-test",
    executorEpoch: "executor-epoch-test",
    runtimeId: request.runtimeContext!.runtimeId,
    leaseId: request.runtimeContext!.leaseId,
    leaseGeneration: request.runtimeContext!.leaseGeneration,
    sessionId: request.invocation.sessionId,
    taskId: request.runtimeContext!.taskId,
    invocationId: request.invocation.invocationId,
    invocationDigest: createHash("sha256")
      .update(canonicalJson(request.invocation as never))
      .digest("hex"),
    ...(fence
      ? {
          backupId: fence.backupId,
          lifecycleLockId: fence.lifecycleLockId,
          lifecycleFencingToken: fence.lifecycleFencingToken,
          lifecycleLeaseGeneration: fence.lifecycleLeaseGeneration,
          fenceIssuedAt: fence.issuedAt,
        }
      : {}),
    resultDigest: createHash("sha256")
      .update(canonicalJson(result as never))
      .digest("hex"),
    journalSequence,
    completedAt: result.completedAt,
    signature: "A".repeat(86),
  };
}

describe("runtime continuation context", () => {
  it("restores persisted redacted turns and the current task into a bounded harness prompt", () => {
    const selected = work(policy("never"));
    selected.session.turns = [
      { schemaVersion: 1, turnId: "turn-1", kind: "task", content: "Inspect configuration", createdAt: NOW },
      { schemaVersion: 1, turnId: "turn-2", kind: "assistant", content: "Prior result", createdAt: NOW },
      { schemaVersion: 1, turnId: "turn-3", kind: "user", content: "Continue safely", createdAt: NOW },
    ];
    const prompt = buildHarnessContinuationPrompt(selected.session, "Continue safely");
    expect(prompt).toContain("TASK: Inspect configuration");
    expect(prompt).toContain("ASSISTANT: Prior result");
    expect(prompt.match(/USER: Continue safely/g)).toHaveLength(1);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(65_000);
  });

  it("projects a 32k-turn multibyte history below the encoded gateway response budget", () => {
    const selected = work(policy("never"));
    selected.session.turns = Array.from({ length: 32_000 }, (_, index) => ({
      schemaVersion: 1 as const,
      turnId: `turn-${index}`,
      kind: "assistant" as const,
      content: "履歴🙂é".repeat(20),
      createdAt: NOW,
    }));
    const projected = projectRuntimeWork(selected);
    const encoded = new TextEncoder().encode(
      JSON.stringify({ success: true, data: projected, timestamp: NOW })
    ).byteLength;
    expect(projected.session.turns.length).toBeLessThanOrEqual(128);
    expect(projected.sessionSummary?.omittedTurnCount).toBeGreaterThan(31_000);
    expect(encoded).toBeLessThanOrEqual(RUNTIME_WORK_RESPONSE_MAX_BYTES);
  });
});

function policy(backupMode: BackupMode, decision: PermissionDecision = "allow"): PermissionPolicy {
  const base = createPolicyFromPreset("autopilot", "runtime-policy");
  return createCustomPolicy(
    base,
    "runtime-policy",
    2,
    Object.fromEntries(base.rules.map((rule) => [rule.capability, decision])),
    backupMode
  );
}

function invocation(toolId = "workspace.write"): ToolInvocation {
  const target = "config/server.properties";
  return {
    schemaVersion: 1,
    invocationId: "invocation-runtime",
    sessionId: "session-runtime",
    toolId,
    capability: toolId === "workspace.delete" ? "workspace.delete" : "workspace.write",
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: target },
    arguments:
      toolId === "workspace.delete" ? { path: target, recursive: false } : { path: target, content: "motd=Safe" },
    requestedAt: NOW,
  };
}

function serverPropertiesInvocation(toolId = "workspace.write"): ToolInvocation {
  return {
    ...invocation(toolId),
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
    arguments:
      toolId === "workspace.delete"
        ? { path: "server.properties", recursive: false }
        : { path: "server.properties", content: "motd=Safe" },
  };
}

function backupInvocation(): ToolInvocation {
  return {
    schemaVersion: 1,
    invocationId: "invocation-backup-request",
    sessionId: "session-runtime",
    toolId: "backup.request",
    capability: "backup.create",
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "." },
    arguments: { label: "before-agent-change" },
    requestedAt: NOW,
  };
}

function networkInvocation(): ToolInvocation {
  return {
    schemaVersion: 1,
    invocationId: "invocation-network-download",
    sessionId: "session-runtime",
    toolId: "network.download",
    capability: "network.outbound",
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "downloads/example.dat" },
    arguments: {
      url: "https://downloads.example.invalid/releases/example.jar",
      destination: "downloads/example.dat",
      maxBytes: 1_024,
      timeoutMs: 1_000,
      expectedSha256: "a".repeat(64),
      expectedBytes: 1,
    },
    requestedAt: NOW,
  };
}

function serverPropertiesDownloadInvocation(): ToolInvocation {
  return {
    ...networkInvocation(),
    invocationId: "invocation-server-properties-download",
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
    arguments: {
      url: "https://downloads.example.invalid/server.properties",
      destination: "server.properties",
      maxBytes: 1_024,
      timeoutMs: 1_000,
      expectedSha256: "a".repeat(64),
      expectedBytes: 1,
    },
  };
}

function work(selectedPolicy: PermissionPolicy): RuntimeWorkLeaseDto {
  return {
    schemaVersion: 1,
    revision: 3,
    providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    session: {
      schemaVersion: 1,
      sessionId: "session-runtime",
      actorId: "actor-runtime",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      policyId: selectedPolicy.policyId,
      policyRevision: selectedPolicy.revision,
      harness: {
        schemaVersion: 1,
        adapterId: "fake-runtime",
        adapterVersion: "1.0.0",
        providerProfileId: "fake-profile",
        providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        model: "fake-model",
      },
      turns: [],
    },
    policySnapshot: selectedPolicy,
    task: {
      schemaVersion: 1,
      taskId: "task-runtime",
      sessionId: "session-runtime",
      status: "pending",
      content: "Run the deterministic local task",
      createdAt: NOW,
      updatedAt: NOW,
    },
    approvals: [],
    lease: {
      schemaVersion: 1,
      leaseId: "lease-runtime",
      claimId: "claim-runtime",
      runtimeId: "runtime-local",
      generation: 1,
      acquiredAt: NOW,
      expiresAt: "2099-09-02T12:02:00.000Z",
    },
  };
}

type DecisionBehavior = "approve" | "deny" | "revoke" | "expire" | "cancel" | "cancel-running" | "tamper-summary";

class FakeControl implements RuntimeControlTransport {
  revision = 3;
  approvals: AgentApproval[] = [];
  events: RuntimeEventPublicationRequest["drafts"] = [];
  statuses: string[] = [];
  statusRequests: RuntimeStatusPublicationRequest[] = [];
  consumeCount = 0;
  authorizeCount = 0;

  constructor(
    private readonly assignment: RuntimeWorkLeaseDto,
    private readonly behavior: DecisionBehavior = "approve"
  ) {
    this.approvals = structuredClone(assignment.approvals);
  }

  async leaseWork(_input: RuntimeWorkLeaseRequest): Promise<RuntimeWorkLeaseDto | null> {
    return structuredClone(this.assignment);
  }
  async acknowledge(_leaseId: string, _input: RuntimeLeaseMutationRequest): Promise<number> {
    this.statuses.push("ack");
    return ++this.revision;
  }
  async renew(_leaseId: string, _input: RuntimeRenewRequest) {
    return { revision: ++this.revision, expiresAt: "2099-09-02T12:02:00.000Z" };
  }
  async publishEvents(_leaseId: string, input: RuntimeEventPublicationRequest): Promise<number> {
    const next = input.drafts[0];
    const existing = this.events.find((draft) => draft.draftId === next.draftId);
    if (!existing) this.events.push(...input.drafts);
    return existing ? this.revision : ++this.revision;
  }
  async publishRecovery(_leaseId: string, input: RuntimeRecoveryPublicationRequest) {
    return recoveryPublication(input);
  }
  async publishApproval(_leaseId: string, input: RuntimeApprovalPublicationRequest): Promise<number> {
    let approval = structuredClone(input.approval);
    if (this.behavior === "approve" || this.behavior === "revoke" || this.behavior === "tamper-summary") {
      approval = { ...approval, decision: "approved", decidedAt: NOW };
      if (this.behavior === "revoke") approval = { ...approval, decision: "revoked" };
      if (this.behavior === "tamper-summary") {
        approval.invocationSummary = {
          ...approval.invocationSummary,
          sanitizedArguments: {
            ...approval.invocationSummary.sanitizedArguments,
            sourceResource: "https://downloads.example.invalid/releases/other.jar",
          },
        };
      }
    } else if (this.behavior === "deny") approval = { ...approval, decision: "denied", decidedAt: NOW };
    else if (this.behavior === "expire") approval = { ...approval, expiresAt: "2099-09-02T11:59:59.000Z" };
    this.approvals.push(approval);
    return ++this.revision;
  }
  async consumeApproval(_leaseId: string, input: RuntimeApprovalConsumptionRequest) {
    this.consumeCount++;
    const consumedAt = "2099-09-02T12:00:01.000Z";
    this.approvals = this.approvals.map((approval) =>
      approval.approvalId === input.approvalId ? { ...approval, consumedAt } : approval
    );
    return { revision: ++this.revision, consumedAt };
  }
  async authorizeInvocation(leaseId: string, input: RuntimeInvocationAuthorizationRequest) {
    this.authorizeCount++;
    const approval = this.approvals.find((candidate) => candidate.approvalId === input.approvalId);
    if (!approval) throw new Error("missing approval");
    const issuedAt = "2099-09-02T12:00:01.000Z";
    if (approval.scope.kind === "single-invocation") approval.consumedAt = issuedAt;
    return {
      schemaVersion: 1 as const,
      revision: ++this.revision,
      authorization: {
        schemaVersion: 1 as const,
        authorizationId: input.authorizationId,
        runtimeId: this.assignment.lease.runtimeId,
        leaseId,
        leaseGeneration: this.assignment.lease.generation,
        taskId: input.taskId,
        sessionId: input.sessionId,
        actorId: this.assignment.session.actorId,
        policyId: this.assignment.policySnapshot.policyId,
        policyRevision: this.assignment.policySnapshot.revision,
        invocationId: input.invocationId,
        invocationDigest: input.invocationDigest,
        approvalId: input.approvalId,
        approvalKind: approval.scope.kind === "session-capability" ? ("ask-once" as const) : ("ask-always" as const),
        capability: input.capability,
        targetScope: input.targetScope,
        risk: input.risk,
        issuedAt,
        expiresAt: "2099-09-02T12:15:00.000Z",
      },
    };
  }
  async publishStatus(_leaseId: string, input: RuntimeStatusPublicationRequest): Promise<number> {
    this.statuses.push(input.status);
    this.statusRequests.push(structuredClone(input));
    return ++this.revision;
  }
  async waitForDecision(_leaseId: string, _input: RuntimeDecisionPollRequest): Promise<RuntimeDecisionSnapshot> {
    return {
      schemaVersion: 1,
      revision: this.revision,
      sessionStatus:
        this.behavior === "cancel-running" || (this.behavior === "cancel" && this.approvals.length > 0)
          ? "cancelled"
          : "waiting-approval",
      taskStatus:
        this.behavior === "cancel-running" || (this.behavior === "cancel" && this.approvals.length > 0)
          ? "cancelled"
          : "waiting-approval",
      leaseGeneration: this.assignment.lease.generation,
      runtimeEventOrdinal: this.assignment.task.runtimeEventOrdinal ?? 0,
      activeRuntimeInvocation: this.assignment.task.activeRuntimeInvocation,
      approvals: structuredClone(this.approvals),
      ...(this.behavior === "cancel-running" || (this.behavior === "cancel" && this.approvals.length > 0)
        ? { cancellation: { schemaVersion: 1 as const, requestedAt: NOW } }
        : {}),
    };
  }
}

class StoreControl implements RuntimeControlTransport {
  constructor(
    private readonly service: AgentRuntimeService,
    private readonly runtimeId: string
  ) {}

  leaseWork(input: RuntimeWorkLeaseRequest, signal?: AbortSignal) {
    return this.service.leaseWork(this.runtimeId, input, signal);
  }
  async acknowledge(leaseId: string, input: RuntimeLeaseMutationRequest) {
    return (await this.service.acknowledge(this.runtimeId, leaseId, input)).state.revision;
  }
  async renew(leaseId: string, input: RuntimeRenewRequest) {
    const result = await this.service.renew(this.runtimeId, leaseId, input);
    const task = result.state.tasks.find((candidate) => candidate.taskId === input.taskId);
    return { revision: result.state.revision, expiresAt: task?.lease?.expiresAt ?? "" };
  }
  async publishEvents(leaseId: string, input: RuntimeEventPublicationRequest) {
    try {
      return (await this.service.publishEvents(this.runtimeId, leaseId, input)).revision;
    } catch (error) {
      if (error instanceof AgentStateConflictError) throw new RuntimeTransportError(409, false);
      throw error;
    }
  }
  async publishApproval(leaseId: string, input: RuntimeApprovalPublicationRequest) {
    return (await this.service.publishApproval(this.runtimeId, leaseId, input)).state.revision;
  }
  async consumeApproval(leaseId: string, input: RuntimeApprovalConsumptionRequest) {
    const result = await this.service.consumeApproval(this.runtimeId, leaseId, input);
    const approval = result.state.approvals.find((candidate) => candidate.approvalId === input.approvalId);
    return { revision: result.state.revision, consumedAt: approval?.consumedAt ?? "" };
  }
  authorizeInvocation(leaseId: string, input: RuntimeInvocationAuthorizationRequest) {
    return this.service.authorizeInvocation(this.runtimeId, leaseId, input);
  }
  async publishStatus(leaseId: string, input: RuntimeStatusPublicationRequest) {
    return (await this.service.publishStatus(this.runtimeId, leaseId, input)).state.revision;
  }
  waitForDecision(leaseId: string, input: RuntimeDecisionPollRequest, signal?: AbortSignal) {
    return this.service.waitForDecision(this.runtimeId, leaseId, input, signal);
  }
}

function effects() {
  const calls: string[] = [];
  const host: DirectLiveHostEffects = {
    securityCapabilities: {
      descriptorRelativeWorkspaceConfinement: true,
      workspaceRootedCommandBoundary: true,
      pinnedDnsRedirectEgressEnforcement: true,
    },
    async canonicalize(value) {
      if (["/fixture/server", "/fixture/scratch", "/fixture/scratch/session-runtime"].includes(value)) {
        return { path: value, kind: "directory" };
      }
      return { path: value, kind: "file" };
    },
    async readFile() {
      calls.push("read");
      return { summary: "read", output: {}, evidence: [] };
    },
    async writeFile() {
      calls.push("write");
      return {
        summary: "write",
        output: { changed: true },
        evidence: [],
        mutationCommit: { committed: true as const, point: "atomic-rename" as const },
      };
    },
    async deletePath() {
      calls.push("delete");
      return { summary: "delete", output: { changed: true }, evidence: [] };
    },
    async executeProcess() {
      calls.push("shell");
      return { summary: "shell", output: {}, evidence: [] };
    },
    async executeConsole() {
      calls.push("console");
      return { summary: "console", output: {}, evidence: [] };
    },
    async download() {
      calls.push("download");
      return { summary: "download", output: {}, evidence: [] };
    },
    async requestBackup() {
      throw new Error("Gateway-owned backup adapter must be used");
    },
    async loadExtension() {
      calls.push("extension");
      return { summary: "extension", output: {}, evidence: [] };
    },
  };
  return { calls, host };
}

class FakeHarness implements AgentHarnessAdapter {
  readonly adapterId = "fake-runtime";
  readonly adapterVersion = "1.0.0";

  constructor(
    private readonly tools: AgentToolExecutorAdapter,
    private readonly item: ToolInvocation,
    private readonly exactSecrets: readonly string[]
  ) {}

  async *run(input: Parameters<AgentHarnessAdapter["run"]>[0]): AsyncIterable<AgentEvent> {
    const redact = (value: string) =>
      this.exactSecrets.reduce((current, secret) => current.split(secret).join("[REDACTED]"), value);
    const invocationDigest = await createInvocationDigest(this.item);
    yield {
      schemaVersion: 1,
      eventId: "event-model",
      sessionId: "session-runtime",
      sequence: 99,
      timestamp: NOW,
      kind: "model",
      payload: { schemaVersion: 1, redacted: true, data: { delta: redact(`starting ${GATEWAY_SECRET}`) } },
      replayCursor: "ignored:99",
    };
    if (input.signal?.aborted) {
      yield {
        schemaVersion: 1,
        eventId: "event-cancelled",
        sessionId: "session-runtime",
        sequence: 100,
        timestamp: NOW,
        kind: "cancellation",
        payload: { schemaVersion: 1, redacted: true, data: { reason: "cancelled" } },
        replayCursor: "ignored:100",
      };
      return;
    }
    yield {
      schemaVersion: 1,
      eventId: "event-proposal",
      sessionId: "session-runtime",
      sequence: 100,
      timestamp: NOW,
      kind: "tool-proposal",
      payload: {
        schemaVersion: 1,
        redacted: true,
        data: {
          invocationId: this.item.invocationId,
          invocationDigest,
          capability: this.item.capability,
          targetScope: this.item.targetScope as unknown as JsonObject,
        },
      },
      replayCursor: "ignored:100",
    };
    const result = await this.tools.invoke(this.item, () => undefined, input.signal ?? new AbortController().signal);
    yield {
      schemaVersion: 1,
      eventId: "event-result",
      sessionId: "session-runtime",
      sequence: 101,
      timestamp: NOW,
      kind: "tool-result",
      payload: { schemaVersion: 1, redacted: true, data: result as unknown as JsonObject },
      replayCursor: "ignored:101",
    };
    yield {
      schemaVersion: 1,
      eventId: "event-complete",
      sessionId: "session-runtime",
      sequence: 102,
      timestamp: NOW,
      kind: "completion",
      payload: { schemaVersion: 1, redacted: true, data: { status: "completed" } },
      replayCursor: "ignored:102",
    };
  }
}

function gateway(input: {
  selectedPolicy: PermissionPolicy;
  assignment?: RuntimeWorkLeaseDto;
  behavior?: DecisionBehavior;
  backupAvailable?: boolean;
  backupFails?: boolean;
  backupStatus?: "pending" | "cancelled" | "ambiguous" | "unavailable";
  item?: ToolInvocation;
  executor?: DirectLiveExecutor;
  monitorLease?: boolean;
  fenceRenewIntervalMs?: number;
}) {
  const assignment = input.assignment ?? work(input.selectedPolicy);
  const control = new FakeControl(assignment, input.behavior);
  const host = effects();
  const executor = createDirectLiveExecutor(host.host, {
    workspaceRoot: "/fixture/server",
    scratchRoot: "/fixture/scratch",
    allowedExecutables: {},
    acceptGatewayAuthorizations: true,
    externalBackupCoordinator: true,
  });
  const selectedExecutor = input.executor ?? executor;
  const execute = selectedExecutor.execute.bind(selectedExecutor);
  const managedExecutor = Object.assign(selectedExecutor, {
    execute: async (request: Parameters<DirectLiveExecutor["execute"]>[0]) =>
      await execute({ ...request, assertCommitAllowed: request.assertCommitAllowed ?? (async () => undefined) }),
    probeFence:
      (selectedExecutor as typeof selectedExecutor & { probeFence?: () => Promise<"terminal"> }).probeFence ??
      (async () => "terminal" as const),
    renewFence:
      (selectedExecutor as typeof selectedExecutor & { renewFence?: () => Promise<void> }).renewFence ??
      (async () => undefined),
    revokeFence:
      (selectedExecutor as typeof selectedExecutor & { revokeFence?: () => Promise<void> }).revokeFence ??
      (async () => undefined),
    prepareBackupHandoff:
      (selectedExecutor as typeof selectedExecutor & { prepareBackupHandoff?: () => Promise<void> })
        .prepareBackupHandoff ?? (async () => undefined),
    authorizeBackupHandoff:
      (selectedExecutor as typeof selectedExecutor & { authorizeBackupHandoff?: () => Promise<void> })
        .authorizeBackupHandoff ?? (async () => undefined),
    abandonBackupHandoff:
      (selectedExecutor as typeof selectedExecutor & { abandonBackupHandoff?: () => Promise<void> })
        .abandonBackupHandoff ?? (async () => undefined),
    terminalReceiptFor:
      (
        selectedExecutor as typeof selectedExecutor & {
          terminalReceiptFor?: (
            request: import("@/lib/agent/executor").ExecuteInvocationRequest,
            result: ToolResult
          ) => Promise<BackupTerminalReceipt | undefined>;
        }
      ).terminalReceiptFor ??
      (async (request: import("@/lib/agent/executor").ExecuteInvocationRequest, result: ToolResult) => ({
        schemaVersion: 1 as const,
        source: "executor-journal" as const,
        proofKind: "terminal" as const,
        outcome: result.status === "succeeded" ? ("committed" as const) : result.status,
        executorKeyId: "executor-receipt-test",
        executorEpoch: "executor-epoch-test",
        runtimeId: request.runtimeContext!.runtimeId,
        leaseId: request.runtimeContext!.leaseId,
        leaseGeneration: request.runtimeContext!.leaseGeneration,
        sessionId: request.invocation.sessionId,
        taskId: request.runtimeContext!.taskId,
        invocationId: request.invocation.invocationId,
        invocationDigest: await createInvocationDigest(request.invocation),
        resultDigest: createHash("sha256")
          .update(canonicalJson(result as never))
          .digest("hex"),
        journalSequence: 1,
        completedAt: result.completedAt,
        signature: "A".repeat(86),
      })),
    completeReconciliation:
      (
        selectedExecutor as typeof selectedExecutor & {
          completeReconciliation?: (...args: never[]) => Promise<void>;
        }
      ).completeReconciliation ?? (async () => undefined),
  });
  const backupCalls: string[] = [];
  const finalizeCalls: string[] = [];
  const finalizeLeaseGenerations: number[] = [];
  const finalizeHostSnapshots: string[][] = [];
  const renewalCalls: number[] = [];
  const runtime = new AgentRuntimeGateway({
    control,
    executor: managedExecutor,
    backup: {
      async evaluateAvailability() {
        return input.backupAvailable === false ? "unavailable" : "available";
      },
      async create(request) {
        backupCalls.push(`${request.sessionId}:${request.invocationId}`);
        if (input.backupFails) return { ...request, status: "failed" as const };
        if (input.backupStatus) return { ...request, status: input.backupStatus };
        return {
          ...request,
          status: "succeeded" as const,
          backupId: "backup-runtime",
          createdAt: NOW,
          fenceAuthorization: {
            schemaVersion: 1,
            status: "succeeded" as const,
            authorizationId: "fence-runtime",
            runtimeId: "runtime-local",
            leaseId: request.leaseId,
            leaseGeneration: request.leaseGeneration,
            sessionId: request.sessionId,
            taskId: request.taskId,
            invocationId: request.invocationId,
            invocationDigest: request.invocationDigest,
            backupId: "backup-runtime",
            lifecycleLockId: "lock-runtime",
            lifecycleFencingToken: 7,
            lifecycleLeaseGeneration: 1,
            lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
            issuedAt: NOW,
            expiresAt: "2099-09-02T12:05:00.000Z",
            signature: "A".repeat(86),
          },
        };
      },
      async finalize(request) {
        finalizeCalls.push(request.outcome);
        finalizeLeaseGenerations.push(request.authorization.lifecycleLeaseGeneration);
        finalizeHostSnapshots.push([...host.calls]);
        if (request.outcome === "indeterminate") {
          return {
            schemaVersion: 1,
            authorizationId: request.authorization.authorizationId,
            status: "reconciliation-needed" as const,
            released: false,
          };
        }
        return {
          schemaVersion: 1,
          authorizationId: request.authorization.authorizationId,
          status: "finalized" as const,
          released: true,
        };
      },
      async renew(request) {
        renewalCalls.push(request.authorization.lifecycleLeaseGeneration);
        return {
          schemaVersion: 1,
          authorizationId: request.authorization.authorizationId,
          status: "renewed" as const,
          authorization: {
            ...request.authorization,
            lifecycleLeaseGeneration: request.authorization.lifecycleLeaseGeneration + 1,
          },
        };
      },
    },
    providers: {
      async resolve() {
        return {
          configuration: {
            schemaVersion: 1,
            profileId: "fake-profile",
            providerId: "fake",
            model: "fake-model",
            credentialRef: "secret-ref:test/fake",
            timeoutMs: 1_000,
          },
          exactSecrets: [GATEWAY_SECRET],
        };
      },
    },
    harnesses: {
      create({ toolExecutor, exactSecrets }) {
        return new FakeHarness(toolExecutor, input.item ?? invocation(), exactSecrets);
      },
    },
    now: () => new Date(NOW),
    createId: () => "runtime-id",
    workWaitMs: 0,
    monitorLease: input.monitorLease ?? false,
    fenceRenewIntervalMs: input.fenceRenewIntervalMs,
  });
  return {
    runtime,
    control,
    hostCalls: host.calls,
    backupCalls,
    finalizeCalls,
    finalizeLeaseGenerations,
    finalizeHostSnapshots,
    renewalCalls,
  };
}

describe("runtime gateway orchestration", () => {
  it.each([
    ["never", 0],
    ["before-destructive", 0],
    ["before-risky", 1],
    ["before-any-mutation", 1],
  ] as const)("applies %s backup mode through the typed adapter", async (mode, expectedBackups) => {
    const test = gateway({ selectedPolicy: policy(mode) });
    expect(await test.runtime.runOnce()).toBe(true);
    expect(test.backupCalls).toHaveLength(expectedBackups);
    expect(test.hostCalls).toEqual(["write"]);
    expect(test.finalizeCalls).toEqual(expectedBackups ? ["committed"] : []);
    if (expectedBackups) expect(test.finalizeHostSnapshots).toEqual([["write"]]);
    expect(test.control.events.map((event) => event.ordinal)).toEqual(test.control.events.map((_, index) => index + 1));
    expect(JSON.stringify(test.control.events)).not.toContain(GATEWAY_SECRET);
  });

  it("backs up destructive work in before-destructive mode", async () => {
    const test = gateway({ selectedPolicy: policy("before-destructive"), item: invocation("workspace.delete") });
    await test.runtime.runOnce();
    expect(test.backupCalls).toHaveLength(1);
    expect(test.hostCalls).toEqual(["delete"]);
  });

  it("renews the lifecycle fence while the authoritative executor journal remains active", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renewFence = vi.fn(async () => undefined);
    const executor = {
      async execute(request: Parameters<DirectLiveExecutor["execute"]>[0]): Promise<ToolResult> {
        if (!request.backupAuthorization) {
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status: "failed",
            completedAt: NOW,
            summary: "backup required",
            output: {
              code: "backup-required",
              invocationDigest: await createInvocationDigest(request.invocation),
              risk: "risky",
            },
            evidence: [],
          };
        }
        await blocked;
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "succeeded",
          completedAt: NOW,
          summary: "committed",
          output: {},
          evidence: [],
          mutationCommit: { committed: true, point: "atomic-rename" },
        };
      },
      async probeFence() {
        return "active" as const;
      },
      renewFence,
      async revokeFence() {},
    };
    const test = gateway({
      selectedPolicy: policy("before-risky"),
      executor,
      fenceRenewIntervalMs: 1,
    });
    const running = test.runtime.runOnce();
    await vi.waitFor(() => expect(test.renewalCalls.length).toBeGreaterThan(0));
    expect(renewFence).toHaveBeenCalled();
    release?.();
    await expect(running).resolves.toBe(true);
    expect(test.finalizeCalls).toEqual(["committed"]);
    expect(test.finalizeLeaseGenerations[0]).toBeGreaterThan(1);
  });

  it("finalizes the latest generation when renewal delivery races executor completion", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probeCount = 0;
    const revokeFence = vi.fn(async () => undefined);
    const renewFence = vi.fn(async () => {
      throw new Error("renewal response lost after executor completion");
    });
    const executor = {
      async execute(request: Parameters<DirectLiveExecutor["execute"]>[0]): Promise<ToolResult> {
        if (!request.backupAuthorization) {
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status: "failed",
            completedAt: NOW,
            summary: "backup required",
            output: {
              code: "backup-required",
              invocationDigest: await createInvocationDigest(request.invocation),
              risk: "risky",
            },
            evidence: [],
          };
        }
        await blocked;
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "succeeded",
          completedAt: NOW,
          summary: "committed",
          output: {},
          evidence: [],
          mutationCommit: { committed: true, point: "atomic-rename" },
        };
      },
      async probeFence() {
        probeCount += 1;
        return probeCount === 1 ? ("active" as const) : ("terminal" as const);
      },
      renewFence,
      revokeFence,
    };
    const test = gateway({
      selectedPolicy: policy("before-risky"),
      executor,
      fenceRenewIntervalMs: 1,
    });
    const running = test.runtime.runOnce();
    await vi.waitFor(() => expect(probeCount).toBeGreaterThanOrEqual(2));
    release?.();
    await expect(running).resolves.toBe(true);
    expect(renewFence).toHaveBeenCalledTimes(1);
    expect(revokeFence).not.toHaveBeenCalled();
    expect(test.finalizeCalls).toEqual(["committed"]);
    expect(test.finalizeLeaseGenerations[0]).toBeGreaterThan(1);
  });

  it("pauses Autopilot for exact approval and backup before a root server.properties write", async () => {
    const item = {
      ...serverPropertiesInvocation(),
      arguments: {
        path: "server.properties",
        content: "online-mode=true\nonline-mode-backup=false\nenforce-whitelist=true",
      },
    };
    const test = gateway({ selectedPolicy: createPolicyFromPreset("autopilot", "runtime-policy"), item });
    await test.runtime.runOnce();
    expect(test.control.approvals).toEqual([
      expect.objectContaining({
        decision: "approved",
        scope: expect.objectContaining({ kind: "single-invocation", risk: "destructive" }),
        invocationSummary: expect.objectContaining({
          diffSummary: expect.stringContaining(
            "Destructive permission/access-control configuration: this mutation targets the canonical workspace-root server.properties"
          ),
        }),
      }),
    ]);
    expect(test.backupCalls).toEqual(["session-runtime:invocation-runtime"]);
    expect(test.hostCalls).toEqual(["write"]);
    const approvalEvent = test.control.events.findIndex((event) => event.kind === "approval");
    const backupEvent = test.control.events.findIndex(
      (event) => event.kind === "backup" && event.payload.status === "succeeded"
    );
    expect(approvalEvent).toBeGreaterThanOrEqual(0);
    expect(backupEvent).toBeGreaterThan(approvalEvent);
  });

  it.each([
    ["write", "allow", serverPropertiesInvocation()],
    ["write", "ask-once", serverPropertiesInvocation()],
    ["delete", "allow", serverPropertiesInvocation("workspace.delete")],
    ["delete", "ask-once", serverPropertiesInvocation("workspace.delete")],
    ["download", "allow", serverPropertiesDownloadInvocation()],
    ["download", "ask-once", serverPropertiesDownloadInvocation()],
  ] as const)(
    "uses an exact durable authorization for a destructive server.properties %s with base %s",
    async (effect, baseDecision, item) => {
      const test = gateway({ selectedPolicy: policy("never", baseDecision), item });
      await test.runtime.runOnce();
      expect(test.control.approvals).toEqual([
        expect.objectContaining({
          decision: "approved",
          invocationDigest: await createInvocationDigest(item),
          scope: expect.objectContaining({ kind: "single-invocation", risk: "destructive" }),
        }),
      ]);
      expect(test.control.authorizeCount).toBe(1);
      expect(test.hostCalls).toEqual([effect]);
    }
  );

  it("fulfills an explicit backup capability through the gateway adapter rather than executor credentials", async () => {
    const test = gateway({ selectedPolicy: policy("never"), item: backupInvocation() });
    await test.runtime.runOnce();
    expect(test.backupCalls).toEqual(["session-runtime:invocation-backup-request"]);
    expect(test.hostCalls).toEqual([]);
    expect(test.finalizeCalls).toEqual(["committed"]);
    const result = test.control.events.find((event) => event.kind === "tool-result");
    expect(result?.payload).toMatchObject({ status: "succeeded" });
  });

  it.each(["failed", "cancelled"] as const)(
    "finalizes and releases the backup fence after a %s executor outcome",
    async (status) => {
      const executor: DirectLiveExecutor = {
        async execute(request): Promise<ToolResult> {
          if (!request.backupAuthorization) {
            return {
              schemaVersion: 1,
              invocationId: request.invocation.invocationId,
              status: "failed",
              completedAt: NOW,
              summary: "backup required",
              output: {
                code: "backup-required",
                invocationDigest: await createInvocationDigest(request.invocation),
                risk: "risky",
              },
              evidence: [],
            };
          }
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status,
            completedAt: NOW,
            summary: `executor ${status}`,
            output: { code: status },
            evidence: [],
          };
        },
      };
      const test = gateway({ selectedPolicy: policy("before-risky"), executor });
      await test.runtime.runOnce();
      expect(test.finalizeCalls).toEqual([status]);
    }
  );

  it("persists unresolved indeterminate backup-fence reconciliation without releasing", async () => {
    const executor: DirectLiveExecutor = {
      async execute(request): Promise<ToolResult> {
        if (!request.backupAuthorization) {
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status: "failed",
            completedAt: NOW,
            summary: "backup required",
            output: {
              code: "backup-required",
              invocationDigest: await createInvocationDigest(request.invocation),
              risk: "destructive",
            },
            evidence: [],
          };
        }
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "indeterminate",
          completedAt: NOW,
          summary: "executor still requires reconciliation",
          output: { code: "indeterminate-effect", reconciliation: "required" },
          evidence: [],
        };
      },
    };
    const test = gateway({ selectedPolicy: policy("before-destructive"), executor });
    await test.runtime.runOnce();
    expect(test.finalizeCalls).toEqual(["indeterminate"]);
    expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
      status: "indeterminate",
    });
  });

  it("finalizes only the authoritative committed result after executor reconciliation", async () => {
    let authorizedAttempts = 0;
    const reconcile = vi.fn(
      async (request: Parameters<DirectLiveExecutor["execute"]>[0]): Promise<ToolResult> => ({
        schemaVersion: 1,
        invocationId: request.invocation.invocationId,
        status: "succeeded",
        completedAt: NOW,
        summary: "journal committed",
        output: { committed: true },
        evidence: [],
        mutationCommit: { committed: true, point: "atomic-rename" },
      })
    );
    const executor: DirectLiveExecutor & { reconcile: typeof reconcile } = {
      async execute(request): Promise<ToolResult> {
        if (!request.backupAuthorization) {
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status: "failed",
            completedAt: NOW,
            summary: "backup required",
            output: {
              code: "backup-required",
              invocationDigest: await createInvocationDigest(request.invocation),
              risk: "destructive",
            },
            evidence: [],
          };
        }
        authorizedAttempts++;
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "indeterminate",
          completedAt: NOW,
          summary: "socket response was lost",
          output: { code: "indeterminate-effect", reconciliation: "required" },
          evidence: [],
        };
      },
      reconcile,
    };
    const test = gateway({ selectedPolicy: policy("before-destructive"), executor });
    await test.runtime.runOnce();
    expect(authorizedAttempts).toBe(1);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(test.finalizeCalls).toEqual(["committed"]);
    expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
  });

  it("retains a stale durable handoff while unresolved and eventually releases after exact no-effect proof", async () => {
    const item = invocation();
    const digest = await createInvocationDigest(item);
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-stale",
        leaseGeneration: 7,
        taskId: "task-runtime",
      },
      backupAuthorization: {
        schemaVersion: 1 as const,
        status: "succeeded" as const,
        authorizationId: "fence-stale",
        runtimeId: "runtime-local",
        leaseId: "lease-stale",
        leaseGeneration: 7,
        sessionId: item.sessionId,
        taskId: "task-runtime",
        invocationId: item.invocationId,
        invocationDigest: digest,
        backupId: "backup-stale",
        lifecycleLockId: "lock-stale",
        lifecycleFencingToken: 4,
        lifecycleLeaseGeneration: 2,
        lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
        issuedAt: NOW,
        expiresAt: "2099-09-02T12:05:00.000Z",
        signature: "A".repeat(86),
      },
    };
    const cancelled: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "cancelled",
      completedAt: NOW,
      summary: "executor proved the reserved effect was not started",
      output: { code: "cancelled" },
      evidence: [],
      mutationCommit: { committed: false },
    };
    const cancelledDigest = createHash("sha256")
      .update(canonicalJson(cancelled as never))
      .digest("hex");
    const cancellationReceipt: BackupTerminalReceipt = {
      schemaVersion: 1,
      source: "executor-journal",
      proofKind: "terminal",
      outcome: "cancelled",
      executorKeyId: "executor-receipt-old",
      executorKeyEpoch: 1,
      executorEpoch: "executor-epoch",
      runtimeId: request.runtimeContext.runtimeId,
      leaseId: request.runtimeContext.leaseId,
      leaseGeneration: request.runtimeContext.leaseGeneration,
      sessionId: item.sessionId,
      taskId: request.runtimeContext.taskId,
      invocationId: item.invocationId,
      invocationDigest: digest,
      backupId: request.backupAuthorization.backupId,
      lifecycleLockId: request.backupAuthorization.lifecycleLockId,
      lifecycleFencingToken: request.backupAuthorization.lifecycleFencingToken,
      lifecycleLeaseGeneration: request.backupAuthorization.lifecycleLeaseGeneration,
      resultDigest: cancelledDigest,
      journalSequence: 42,
      completedAt: NOW,
      signature: "A".repeat(86),
    };
    let retained = true;
    let probes = 0;
    const execute = vi.fn<DirectLiveExecutor["execute"]>();
    const completeReconciliation = vi.fn(async () => {
      retained = false;
    });
    const executor = {
      execute,
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        probes++;
        return retained
          ? [
              {
                key: "task-runtime:7:invocation-runtime",
                runtimeId: "runtime-local",
                state: "awaiting-executor" as const,
                request,
                executorStatus: probes === 1 ? ("pending" as const) : ("not-started" as const),
                ...(probes === 1
                  ? {
                      result: {
                        schemaVersion: 1 as const,
                        invocationId: item.invocationId,
                        status: "indeterminate" as const,
                        completedAt: NOW,
                        summary: "still inside executor safety horizon",
                        output: { reconciliation: "required" },
                        evidence: [],
                      },
                    }
                  : {}),
              },
            ]
          : [];
      },
      async cancel() {
        return probes === 1 ? {} : { result: cancelled, terminalReceipt: cancellationReceipt };
      },
      completeReconciliation,
      async replacePendingFence() {},
      async authorizeBackupHandoff() {},
    };
    const finalize = vi.fn(async (input: Parameters<NonNullable<RuntimeGatewayBackupAdapter["finalize"]>>[0]) => ({
      schemaVersion: 1 as const,
      authorizationId: input.authorization.authorizationId,
      status: "finalized" as const,
      released: true,
    }));
    const control = {
      async leaseWork() {
        return null;
      },
      async waitForDecision() {
        throw new RuntimeTransportError(409, false);
      },
      acknowledge: vi.fn(),
      renew: vi.fn(),
      publishEvents: vi.fn(),
      publishApproval: vi.fn(),
      consumeApproval: vi.fn(),
      authorizeInvocation: vi.fn(),
      publishStatus: vi.fn(),
      publishRecovery: vi.fn(async (_leaseId, input) => recoveryPublication(input)),
    } as unknown as RuntimeControlTransport;
    const runtime = new AgentRuntimeGateway({
      control,
      executor,
      backup: {
        async evaluateAvailability() {
          return "available";
        },
        async create(input) {
          return { ...input, status: "ambiguous" };
        },
        finalize,
        renew: vi.fn(),
      },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(completeReconciliation).not.toHaveBeenCalled();
    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
    expect(completeReconciliation).toHaveBeenCalledOnce();
  });

  it("withdraws reserved executor authority before publishing cancellation or releasing the lifecycle fence", async () => {
    const item = invocation();
    const invocationDigest = await createInvocationDigest(item);
    const cancelled: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "cancelled",
      completedAt: NOW,
      summary: "cancelled before host entry",
      output: { code: "cancelled" },
      evidence: [],
      mutationCommit: { committed: false },
    };
    const resultDigest = createHash("sha256")
      .update(canonicalJson(cancelled as never))
      .digest("hex");
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-cancel-order",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
      backupAuthorization: {
        schemaVersion: 1 as const,
        status: "succeeded" as const,
        authorizationId: "fence-cancel-order",
        runtimeId: "runtime-local",
        leaseId: "lease-cancel-order",
        leaseGeneration: 1,
        sessionId: item.sessionId,
        taskId: "task-runtime",
        invocationId: item.invocationId,
        invocationDigest,
        backupId: "backup-cancel-order",
        lifecycleLockId: "lock-cancel-order",
        lifecycleFencingToken: 1,
        lifecycleLeaseGeneration: 1,
        lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
        issuedAt: NOW,
        expiresAt: "2099-09-02T12:05:00.000Z",
        signature: "A".repeat(86),
      },
    };
    const order: string[] = [];
    let retained = true;
    const terminalReceipt: BackupTerminalReceipt = {
      schemaVersion: 1,
      source: "executor-journal",
      proofKind: "terminal",
      outcome: "cancelled",
      executorKeyId: "executor-receipt-old",
      executorKeyEpoch: 1,
      executorEpoch: "executor-epoch",
      runtimeId: request.runtimeContext.runtimeId,
      leaseId: request.runtimeContext.leaseId,
      leaseGeneration: request.runtimeContext.leaseGeneration,
      sessionId: item.sessionId,
      taskId: request.runtimeContext.taskId,
      invocationId: item.invocationId,
      invocationDigest,
      backupId: request.backupAuthorization.backupId,
      lifecycleLockId: request.backupAuthorization.lifecycleLockId,
      lifecycleFencingToken: request.backupAuthorization.lifecycleFencingToken,
      lifecycleLeaseGeneration: request.backupAuthorization.lifecycleLeaseGeneration,
      resultDigest,
      journalSequence: 4,
      completedAt: NOW,
      signature: "A".repeat(86),
    };
    const executor = {
      execute: vi.fn(),
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "runtime-local:task-runtime:lease-cancel-order:1:invocation-runtime",
                runtimeId: "runtime-local",
                state: "dispatching" as const,
                request,
                executorStatus: "reserved" as const,
              },
            ]
          : [];
      },
      async cancel() {
        order.push("cancel");
        return { result: cancelled, terminalReceipt };
      },
      async completeReconciliation() {
        order.push("ack");
        retained = false;
      },
    };
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) => {
      order.push("publish");
      return recoveryPublication(input);
    });
    const finalize = vi.fn(async () => {
      order.push("finalize");
      return {
        schemaVersion: 1 as const,
        authorizationId: request.backupAuthorization.authorizationId,
        status: "finalized" as const,
        released: true,
      };
    });
    const runtime = new AgentRuntimeGateway({
      control: {
        leaseWork: async () => null,
        waitForDecision: async () => ({
          schemaVersion: 1,
          revision: 9,
          sessionStatus: "cancelled",
          taskStatus: "cancelled",
          leaseGeneration: 1,
          runtimeEventOrdinal: 1,
          approvals: [],
        }),
        publishRecovery,
        acknowledge: vi.fn(),
        renew: vi.fn(),
        publishEvents: vi.fn(),
        publishApproval: vi.fn(),
        consumeApproval: vi.fn(),
        authorizeInvocation: vi.fn(),
        publishStatus: vi.fn(),
      },
      executor,
      backup: { evaluateAvailability: async () => "available", create: vi.fn(), finalize, renew: vi.fn() },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(order).toEqual(["cancel", "publish", "finalize", "ack"]);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(publishRecovery).toHaveBeenCalledOnce();
  });

  it("publishes and acknowledges no-backup cancellation evidence before removing its handoff", async () => {
    const item = invocation();
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("never"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-no-backup-cancel",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
    };
    const cancelled: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "cancelled",
      completedAt: NOW,
      summary: "cancelled before host entry",
      output: { code: "cancelled" },
      evidence: [],
      mutationCommit: { committed: false },
    };
    const terminalReceipt = executorTerminalReceipt(request, cancelled, 5);
    const order: string[] = [];
    let retained = true;
    const executor = {
      execute: vi.fn(),
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "runtime-local:task-runtime:lease-no-backup-cancel:1:invocation-runtime",
                runtimeId: "runtime-local",
                state: "dispatching" as const,
                request,
                executorStatus: "reserved" as const,
              },
            ]
          : [];
      },
      async cancel() {
        order.push("cancel");
        return { result: cancelled, terminalReceipt };
      },
      async completeReconciliation(
        _invocationId: string,
        _runtimeContext: RuntimeExecutionContext,
        authorization?: TerminalPublicationAuthorization
      ) {
        expect(authorization).toBeDefined();
        order.push("ack");
        retained = false;
      },
    };
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) => {
      order.push("publish");
      return recoveryPublication(input);
    });
    const finalize = vi.fn();
    const runtime = new AgentRuntimeGateway({
      control: {
        leaseWork: async () => null,
        waitForDecision: async () => {
          throw new RuntimeTransportError(409, false);
        },
        publishRecovery,
      } as unknown as RuntimeControlTransport,
      executor,
      backup: { evaluateAvailability: vi.fn(), create: vi.fn(), finalize },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(order).toEqual(["cancel", "publish", "ack"]);
    expect(retained).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("fails closed before leasing when executor authenticated state has no matching gateway handoff", async () => {
    const leaseWork = vi.fn(async () => null);
    const runtime = new AgentRuntimeGateway({
      control: {
        leaseWork,
        acknowledge: vi.fn(),
        renew: vi.fn(),
        publishEvents: vi.fn(),
        publishApproval: vi.fn(),
        consumeApproval: vi.fn(),
        authorizeInvocation: vi.fn(),
        publishStatus: vi.fn(),
        waitForDecision: vi.fn(),
      } as unknown as RuntimeControlTransport,
      executor: {
        execute: vi.fn(),
        async inspectEffectSlot() {
          return {
            invocationId: "invocation-orphaned",
            invocationDigest: "a".repeat(64),
            taskId: "task-orphaned",
            leaseGeneration: 11,
            status: "in-progress" as const,
            updatedAt: NOW,
          };
        },
        async reconcilePending() {
          return [];
        },
      } as DirectLiveExecutor,
      backup: {
        async evaluateAvailability() {
          return "available";
        },
        create: vi.fn(),
        finalize: vi.fn(),
      },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
    });

    await expect(runtime.runOnce()).rejects.toThrow(/no exact durable gateway handoff/i);
    expect(leaseWork).not.toHaveBeenCalled();
  });

  it("retains the lifecycle fence when a dispatched handoff reports a missing or rolled-back journal", async () => {
    const item = invocation();
    const digest = await createInvocationDigest(item);
    const authorization = {
      schemaVersion: 1 as const,
      status: "succeeded" as const,
      authorizationId: "fence-journal-rollback",
      runtimeId: "runtime-local",
      leaseId: "lease-runtime",
      leaseGeneration: 1,
      sessionId: item.sessionId,
      taskId: "task-runtime",
      invocationId: item.invocationId,
      invocationDigest: digest,
      backupId: "backup-journal-rollback",
      lifecycleLockId: "lock-journal-rollback",
      lifecycleFencingToken: 42,
      lifecycleLeaseGeneration: 3,
      lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
      issuedAt: NOW,
      expiresAt: "2099-09-02T12:05:00.000Z",
      signature: "A".repeat(86),
    };
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-runtime",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
      backupAuthorization: authorization,
    };
    const execute = vi.fn<DirectLiveExecutor["execute"]>();
    const completeReconciliation = vi.fn();
    const replacePendingFence = vi.fn();
    const executor = {
      execute,
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return [
          {
            key: "task-runtime:1:invocation-runtime",
            runtimeId: "runtime-local",
            state: "dispatching" as const,
            request,
            executorStatus: "not-started" as const,
          },
        ];
      },
      completeReconciliation,
      replacePendingFence,
    };
    const renew = vi.fn(async () => ({
      schemaVersion: 1 as const,
      authorizationId: authorization.authorizationId,
      status: "renewed" as const,
      authorization: { ...authorization, lifecycleLeaseGeneration: 4 },
    }));
    const finalize = vi.fn();
    const runtime = new AgentRuntimeGateway({
      control: {
        async leaseWork() {
          return null;
        },
        async waitForDecision(): Promise<RuntimeDecisionSnapshot> {
          return {
            schemaVersion: 1,
            revision: 9,
            sessionStatus: "running",
            taskStatus: "running",
            leaseGeneration: 1,
            runtimeEventOrdinal: 2,
            activeRuntimeInvocation: {
              schemaVersion: 1,
              runtimeId: "runtime-local",
              sessionId: item.sessionId,
              taskId: "task-runtime",
              leaseId: "lease-runtime",
              leaseGeneration: 1,
              invocationId: item.invocationId,
              invocationDigest: digest,
              capability: item.capability,
              targetScope: item.targetScope,
              proposalOrdinal: 1,
            },
            approvals: [],
          };
        },
      } as unknown as RuntimeControlTransport,
      executor,
      backup: { evaluateAvailability: vi.fn(), create: vi.fn(), finalize, renew },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(renew).toHaveBeenCalledOnce();
    expect(replacePendingFence).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(completeReconciliation).not.toHaveBeenCalled();
  });

  it("redispatches one exact reserved handoff after restart and releases it only after terminal publication", async () => {
    const item = invocation();
    const digest = await createInvocationDigest(item);
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-runtime",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
    };
    let retained = true;
    const terminal: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "succeeded",
      completedAt: NOW,
      summary: "committed once",
      output: { committed: true },
      evidence: [],
    };
    const execute = vi.fn(async () => terminal);
    const completeReconciliation = vi.fn(async () => {
      retained = false;
    });
    const executor = {
      execute,
      async inspectEffectSlot() {
        return retained
          ? {
              invocationId: item.invocationId,
              invocationDigest: digest,
              taskId: "task-runtime",
              leaseGeneration: 1,
              status: "reserved" as const,
              updatedAt: NOW,
            }
          : null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "runtime-local:task-runtime:lease-runtime:1:invocation-runtime",
                runtimeId: "runtime-local",
                sessionId: item.sessionId,
                taskId: "task-runtime",
                leaseId: "lease-runtime",
                leaseGeneration: 1,
                invocationId: item.invocationId,
                invocationDigest: digest,
                state: "dispatching" as const,
                request,
                executorStatus: "reserved" as const,
              },
            ]
          : [];
      },
      completeReconciliation,
      cancel: vi.fn(),
      terminalReceiptFor: vi.fn(async () => executorTerminalReceipt(request, terminal)),
    };
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) =>
      recoveryPublication(input)
    );
    const runtime = new AgentRuntimeGateway({
      control: {
        async leaseWork() {
          return null;
        },
        async waitForDecision(): Promise<RuntimeDecisionSnapshot> {
          return {
            schemaVersion: 1,
            revision: 9,
            sessionStatus: "running",
            taskStatus: "running",
            leaseGeneration: 1,
            runtimeEventOrdinal: 2,
            activeRuntimeInvocation: {
              schemaVersion: 1,
              runtimeId: "runtime-local",
              sessionId: item.sessionId,
              taskId: "task-runtime",
              leaseId: "lease-runtime",
              leaseGeneration: 1,
              invocationId: item.invocationId,
              invocationDigest: digest,
              capability: item.capability,
              targetScope: item.targetScope,
              proposalOrdinal: 1,
            },
            approvals: [],
          };
        },
        publishEvents: vi.fn(),
        publishRecovery,
      } as unknown as RuntimeControlTransport,
      executor,
      backup: { evaluateAvailability: vi.fn(), create: vi.fn(), finalize: vi.fn() },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    expect(publishRecovery).toHaveBeenCalledOnce();
    expect(completeReconciliation).toHaveBeenCalledOnce();
    expect(retained).toBe(false);
  });

  it("abandons a pre-backup handoff when stale authority and a 409 prove no bound backup exists", async () => {
    const item = invocation();
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-stale",
        leaseGeneration: 7,
        taskId: "task-runtime",
      },
    };
    let retained = true;
    const completeReconciliation = vi.fn(async () => {
      retained = false;
    });
    const executor = {
      execute: vi.fn<DirectLiveExecutor["execute"]>(),
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "task-runtime:7:invocation-runtime",
                runtimeId: "runtime-local",
                state: "awaiting-backup" as const,
                request,
                executorStatus: "not-started" as const,
              },
            ]
          : [];
      },
      completeReconciliation,
      authorizeBackupHandoff: vi.fn(),
    };
    const create = vi.fn(async () => {
      throw Object.assign(new Error("stale authority"), { status: 409 });
    });
    const runtime = new AgentRuntimeGateway({
      control: {
        async leaseWork() {
          return null;
        },
        async waitForDecision() {
          throw new RuntimeTransportError(409, false);
        },
      } as unknown as RuntimeControlTransport,
      executor,
      backup: { evaluateAvailability: vi.fn(), create, finalize: vi.fn(), renew: vi.fn() },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(create).toHaveBeenCalledOnce();
    expect(completeReconciliation).toHaveBeenCalledOnce();
  });

  it("keeps a terminal handoff across publication failure and retries finalization/publication without redispatch", async () => {
    const item = invocation();
    const digest = await createInvocationDigest(item);
    const result: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "succeeded",
      completedAt: NOW,
      summary: "recovered commit",
      output: {},
      evidence: [],
      mutationCommit: { committed: true, point: "atomic-rename" },
    };
    const authorization = {
      schemaVersion: 1 as const,
      status: "succeeded" as const,
      authorizationId: "fence-publication",
      runtimeId: "runtime-local",
      leaseId: "lease-runtime",
      leaseGeneration: 1,
      sessionId: item.sessionId,
      taskId: "task-runtime",
      invocationId: item.invocationId,
      invocationDigest: digest,
      backupId: "backup-publication",
      lifecycleLockId: "lock-publication",
      lifecycleFencingToken: 5,
      lifecycleLeaseGeneration: 3,
      lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
      issuedAt: NOW,
      expiresAt: "2099-09-02T12:05:00.000Z",
      signature: "A".repeat(86),
    };
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-runtime",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
      backupAuthorization: authorization,
    };
    const terminalReceipt = executorTerminalReceipt(request, result, 77);
    let retained = true;
    const execute = vi.fn<DirectLiveExecutor["execute"]>();
    const completeReconciliation = vi.fn(async () => {
      retained = false;
    });
    const executor = {
      execute,
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "task-runtime:1:invocation-runtime",
                runtimeId: "runtime-local",
                state: "dispatching" as const,
                request,
                executorStatus: "terminal" as const,
                result,
                terminalReceipt,
              },
            ]
          : [];
      },
      completeReconciliation,
      async replacePendingFence() {},
      async authorizeBackupHandoff() {},
    };
    let publicationAttempts = 0;
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) => {
      publicationAttempts++;
      if (publicationAttempts === 1) throw new RuntimeTransportError(503, true);
      return recoveryPublication(input);
    });
    const snapshot: RuntimeDecisionSnapshot = {
      schemaVersion: 1,
      revision: 9,
      sessionStatus: "running",
      taskStatus: "running",
      leaseGeneration: 1,
      runtimeEventOrdinal: 2,
      activeRuntimeInvocation: {
        schemaVersion: 1,
        runtimeId: "runtime-local",
        sessionId: item.sessionId,
        taskId: "task-runtime",
        leaseId: "lease-runtime",
        leaseGeneration: 1,
        invocationId: item.invocationId,
        invocationDigest: digest,
        capability: item.capability,
        targetScope: item.targetScope,
        proposalOrdinal: 1,
      },
      approvals: [],
    };
    const control = {
      async leaseWork() {
        return null;
      },
      async waitForDecision() {
        return snapshot;
      },
      publishEvents: vi.fn(),
      acknowledge: vi.fn(),
      renew: vi.fn(),
      publishApproval: vi.fn(),
      consumeApproval: vi.fn(),
      authorizeInvocation: vi.fn(),
      publishStatus: vi.fn(),
      publishRecovery,
    } as unknown as RuntimeControlTransport;
    const finalize = vi.fn(async () => ({
      schemaVersion: 1 as const,
      authorizationId: authorization.authorizationId,
      status: "finalized" as const,
      released: true,
    }));
    const runtime = new AgentRuntimeGateway({
      control,
      executor,
      backup: {
        async evaluateAvailability() {
          return "available";
        },
        async create(input) {
          return { ...input, status: "ambiguous" };
        },
        finalize,
        renew: vi.fn(),
      },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).rejects.toBeInstanceOf(RuntimeTransportError);
    expect(retained).toBe(true);
    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
    expect(publishRecovery).toHaveBeenCalledTimes(2);
    expect(completeReconciliation).toHaveBeenCalledOnce();
  });

  it("publishes expired-lease terminal evidence before releasing its lifecycle fence or acknowledging compaction", async () => {
    const item = invocation();
    const invocationDigest = await createInvocationDigest(item);
    const result: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "succeeded",
      completedAt: NOW,
      summary: "host mutation committed",
      output: { committed: true },
      evidence: [],
      mutationCommit: { committed: true, point: "atomic-rename" },
    };
    const resultDigest = createHash("sha256")
      .update(canonicalJson(result as never))
      .digest("hex");
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-expired-recovery",
        leaseGeneration: 4,
        taskId: "task-runtime",
      },
      backupAuthorization: {
        schemaVersion: 1 as const,
        status: "succeeded" as const,
        authorizationId: "fence-expired-recovery",
        runtimeId: "runtime-local",
        leaseId: "lease-expired-recovery",
        leaseGeneration: 4,
        sessionId: item.sessionId,
        taskId: "task-runtime",
        invocationId: item.invocationId,
        invocationDigest,
        backupId: "backup-expired-recovery",
        lifecycleLockId: "lock-expired-recovery",
        lifecycleFencingToken: 9,
        lifecycleLeaseGeneration: 2,
        lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
        issuedAt: NOW,
        expiresAt: "2099-09-02T12:05:00.000Z",
        signature: "A".repeat(86),
      },
    };
    const terminalReceipt: BackupTerminalReceipt = {
      schemaVersion: 1,
      source: "executor-journal",
      proofKind: "terminal",
      outcome: "committed",
      executorKeyId: "executor-receipt-test",
      executorKeyEpoch: 1,
      executorEpoch: "executor-epoch-test",
      runtimeId: request.runtimeContext.runtimeId,
      leaseId: request.runtimeContext.leaseId,
      leaseGeneration: request.runtimeContext.leaseGeneration,
      sessionId: item.sessionId,
      taskId: request.runtimeContext.taskId,
      invocationId: item.invocationId,
      invocationDigest,
      backupId: request.backupAuthorization.backupId,
      lifecycleLockId: request.backupAuthorization.lifecycleLockId,
      lifecycleFencingToken: request.backupAuthorization.lifecycleFencingToken,
      lifecycleLeaseGeneration: request.backupAuthorization.lifecycleLeaseGeneration,
      resultDigest,
      journalSequence: 77,
      completedAt: NOW,
      signature: "A".repeat(86),
    };
    const order: string[] = [];
    let retained = true;
    const executor = {
      execute: vi.fn(),
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "task-runtime:4:invocation-runtime",
                runtimeId: "runtime-local",
                state: "dispatching" as const,
                request,
                executorStatus: "terminal" as const,
                result,
                terminalReceipt,
              },
            ]
          : [];
      },
      async completeReconciliation() {
        order.push("ack");
        retained = false;
      },
      async replacePendingFence() {},
      async authorizeBackupHandoff() {},
    };
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) => {
      order.push("publish");
      return recoveryPublication(input);
    });
    const finalize = vi.fn(async () => {
      order.push("finalize");
      return {
        schemaVersion: 1 as const,
        authorizationId: request.backupAuthorization.authorizationId,
        status: "finalized" as const,
        released: true,
      };
    });
    const runtime = new AgentRuntimeGateway({
      control: {
        leaseWork: async () => null,
        waitForDecision: async () => {
          throw new RuntimeTransportError(409, false);
        },
        publishRecovery,
        acknowledge: vi.fn(),
        renew: vi.fn(),
        publishEvents: vi.fn(),
        publishApproval: vi.fn(),
        consumeApproval: vi.fn(),
        authorizeInvocation: vi.fn(),
        publishStatus: vi.fn(),
      },
      executor,
      backup: { evaluateAvailability: async () => "available", create: vi.fn(), finalize, renew: vi.fn() },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(publishRecovery).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(order).toEqual(["publish", "finalize", "ack"]);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("retains an indeterminate terminal handoff until safe fence recovery reports release", async () => {
    const item = invocation();
    const digest = await createInvocationDigest(item);
    const authorization = {
      schemaVersion: 1 as const,
      status: "succeeded" as const,
      authorizationId: "fence-indeterminate",
      runtimeId: "runtime-local",
      leaseId: "lease-runtime",
      leaseGeneration: 1,
      sessionId: item.sessionId,
      taskId: "task-runtime",
      invocationId: item.invocationId,
      invocationDigest: digest,
      backupId: "backup-indeterminate",
      lifecycleLockId: "lock-indeterminate",
      lifecycleFencingToken: 6,
      lifecycleLeaseGeneration: 3,
      lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
      issuedAt: NOW,
      expiresAt: "2099-09-02T12:05:00.000Z",
      signature: "A".repeat(86),
    };
    const result: ToolResult = {
      schemaVersion: 1,
      invocationId: item.invocationId,
      status: "indeterminate",
      completedAt: NOW,
      summary: "effect outcome remains uncertain",
      output: { reconciliation: "required" },
      evidence: [],
    };
    const request = {
      actorId: "actor-runtime",
      invocation: item,
      policy: policy("before-risky"),
      approvals: [],
      runtimeContext: {
        runtimeId: "runtime-local",
        leaseId: "lease-runtime",
        leaseGeneration: 1,
        taskId: "task-runtime",
      },
      backupAuthorization: authorization,
    };
    const terminalReceipt = executorTerminalReceipt(request, result, 88);
    let retained = true;
    const completeReconciliation = vi.fn(async () => {
      retained = false;
    });
    const executor = {
      execute: vi.fn<DirectLiveExecutor["execute"]>(),
      async inspectEffectSlot() {
        return null;
      },
      async reconcilePending() {
        return retained
          ? [
              {
                key: "task-runtime:1:invocation-runtime",
                runtimeId: "runtime-local",
                state: "dispatching" as const,
                request,
                executorStatus: "terminal" as const,
                result,
                terminalReceipt,
              },
            ]
          : [];
      },
      completeReconciliation,
    };
    const publishRecovery = vi.fn(async (_leaseId: string, input: RuntimeRecoveryPublicationRequest) =>
      recoveryPublication(input)
    );
    const control = {
      async leaseWork() {
        return null;
      },
      async waitForDecision(): Promise<RuntimeDecisionSnapshot> {
        return {
          schemaVersion: 1,
          revision: 9,
          sessionStatus: "failed",
          taskStatus: "failed",
          leaseGeneration: 1,
          runtimeEventOrdinal: 2,
          activeRuntimeInvocation: {
            schemaVersion: 1,
            runtimeId: "runtime-local",
            sessionId: item.sessionId,
            taskId: "task-runtime",
            leaseId: "lease-runtime",
            leaseGeneration: 1,
            invocationId: item.invocationId,
            invocationDigest: digest,
            capability: item.capability,
            targetScope: item.targetScope,
            proposalOrdinal: 1,
          },
          approvals: [],
        };
      },
      publishEvents: vi.fn(),
      publishRecovery,
    } as unknown as RuntimeControlTransport;
    let finalizeAttempts = 0;
    const finalize = vi.fn(async () => {
      finalizeAttempts++;
      return finalizeAttempts === 1
        ? {
            schemaVersion: 1 as const,
            authorizationId: authorization.authorizationId,
            status: "reconciliation-needed" as const,
            released: false,
          }
        : {
            schemaVersion: 1 as const,
            authorizationId: authorization.authorizationId,
            status: "finalized" as const,
            released: true,
          };
    });
    const runtime = new AgentRuntimeGateway({
      control,
      executor,
      backup: { evaluateAvailability: vi.fn(), create: vi.fn(), finalize },
      providers: { resolve: vi.fn() },
      harnesses: { create: vi.fn() },
      workWaitMs: 0,
      monitorLease: false,
      now: () => new Date(NOW),
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(retained).toBe(true);
    expect(publishRecovery).toHaveBeenCalledOnce();
    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(completeReconciliation).not.toHaveBeenCalled();
  });

  it.each(["approve", "deny", "revoke", "expire", "cancel"] as const)(
    "handles %s approval decisions without changing the exact invocation",
    async (behavior) => {
      const test = gateway({ selectedPolicy: policy("never", "ask-always"), behavior });
      await test.runtime.runOnce();
      expect(test.hostCalls).toHaveLength(behavior === "approve" ? 1 : 0);
      expect(test.control.authorizeCount).toBe(behavior === "approve" ? 1 : 0);
      expect(JSON.stringify(test.control.events)).not.toContain(GATEWAY_SECRET);
    }
  );

  it("executes a continuation task with a reused ask-once session grant and a new task-scoped authorization", async () => {
    const selectedPolicy = policy("never", "ask-once");
    const first = gateway({ selectedPolicy, behavior: "approve" });
    await first.runtime.runOnce();
    expect(first.hostCalls).toEqual(["write"]);
    expect(first.control.approvals).toHaveLength(1);

    const continuation = work(selectedPolicy);
    continuation.task = {
      ...continuation.task,
      taskId: "task-continuation",
      content: "Use the existing scoped grant",
    };
    continuation.lease = { ...continuation.lease, leaseId: "lease-continuation" };
    continuation.approvals = structuredClone(first.control.approvals);
    const continuedInvocation = {
      ...invocation(),
      invocationId: "invocation-continuation",
      requestedAt: "2099-09-02T12:00:01.000Z",
    };
    const second = gateway({ selectedPolicy, assignment: continuation, item: continuedInvocation });

    await second.runtime.runOnce();

    expect(second.control.approvals).toHaveLength(1);
    expect(second.control.authorizeCount).toBe(1);
    expect(second.hostCalls).toEqual(["write"]);
  });

  it("publishes bounded already-redacted assistant continuation context on task completion", async () => {
    const test = gateway({ selectedPolicy: policy("never") });
    await test.runtime.runOnce();
    const completion = test.control.statusRequests.find((request) => request.status === "completed");
    expect(completion?.assistantTurn).toMatchObject({ kind: "assistant", content: "starting [REDACTED]" });
    expect(JSON.stringify(completion)).not.toContain(GATEWAY_SECRET);
  });

  it("preserves committed host metadata through the executor, harness, and gateway event", async () => {
    const test = gateway({ selectedPolicy: policy("never") });
    await test.runtime.runOnce();
    expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
  });

  it.each([
    ["raw reflected content", { path: "server.properties", content: GATEWAY_SECRET }],
    ["URL-encoded content", { path: "server.properties", content: encodeURIComponent(GATEWAY_SECRET) }],
    ["base64 command argument", { command: ["printf", Buffer.from(GATEWAY_SECRET).toString("base64")] }],
    [
      "base64 split across argument leaves",
      (() => {
        const encoded = Buffer.from(GATEWAY_SECRET).toString("base64");
        const boundary = Math.floor(encoded.length / 2);
        return { chunks: [encoded.slice(0, boundary), encoded.slice(boundary)] };
      })(),
    ],
  ] satisfies Array<[string, JsonObject]>)(
    "rejects and audits %s before executor dispatch",
    async (_label, arguments_) => {
      const execute = vi.fn<DirectLiveExecutor["execute"]>();
      const item = { ...invocation(), arguments: arguments_ };
      const test = gateway({ selectedPolicy: policy("never"), item, executor: { execute } });

      await expect(test.runtime.runOnce()).resolves.toBe(true);

      expect(execute).not.toHaveBeenCalled();
      expect(test.hostCalls).toEqual([]);
      expect(test.control.events.find((event) => event.kind === "policy")?.payload).toMatchObject({
        outcome: "deny",
        code: "configured-secret-material",
      });
      expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
        status: "failed",
        output: { code: "configured-secret-material" },
      });
      expect(JSON.stringify(test.control.events)).not.toContain(GATEWAY_SECRET);
    }
  );

  it("terminalizes an indeterminate effect without accepting a harness completion", async () => {
    const test = gateway({
      selectedPolicy: policy("never"),
      executor: {
        async execute(request) {
          return {
            schemaVersion: 1,
            invocationId: request.invocation.invocationId,
            status: "indeterminate",
            completedAt: NOW,
            summary: "Effect is indeterminate.",
            output: { code: "indeterminate-effect" },
            evidence: [],
          };
        },
      },
    });
    await test.runtime.runOnce();
    expect(test.control.events.map((event) => event.kind)).not.toContain("completion");
    expect(test.control.statusRequests.at(-1)).toMatchObject({
      status: "failed",
      reason: "An indeterminate host effect requires operator reconciliation.",
    });
  });

  it("publishes the executor-canonical network scope and succeeds on the exact approval retry", async () => {
    const test = gateway({
      selectedPolicy: policy("never", "ask-always"),
      behavior: "approve",
      item: networkInvocation(),
    });
    await test.runtime.runOnce();
    expect(test.control.approvals).toHaveLength(1);
    expect(test.control.approvals[0]).toMatchObject({
      sessionId: "session-runtime",
      policyId: "runtime-policy",
      policyRevision: 2,
      scope: {
        capability: "network.outbound",
        risk: "risky",
        targetScope: {
          kind: "network",
          normalizedTarget:
            '{"destination":{"kind":"workspace","normalizedTarget":"downloads/example.dat","schemaVersion":1},"expectedBytes":1,"expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resource":"https://downloads.example.invalid/releases/example.jar","schemaVersion":1,"type":"network-download"}',
        },
      },
    });
    expect(test.control.approvals[0]?.invocationDigest).toBe(await createInvocationDigest(networkInvocation()));
    expect(test.control.approvals[0]).toMatchObject({
      invocationSummary: {
        invocationId: "invocation-network-download",
        sanitizedArguments: {
          sourceResource: "https://downloads.example.invalid/releases/example.jar",
          destination: "downloads/example.dat",
          maxBytes: 1_024,
          expectedSha256: "a".repeat(64),
          expectedBytes: 1,
        },
      },
      invocationSummaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(test.control.authorizeCount).toBe(1);
    expect(test.hostCalls).toEqual(["download"]);
  });

  it("rejects a tampered exact-resource summary before the approval retry", async () => {
    const test = gateway({
      selectedPolicy: policy("never", "ask-always"),
      behavior: "tamper-summary",
      item: networkInvocation(),
    });
    await test.runtime.runOnce();
    expect(test.hostCalls).toEqual([]);
    expect(test.control.consumeCount).toBe(0);
    expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
      output: { code: "approval-denied" },
    });
  });

  it("does not publish an approval when an executor decision binding is inconsistent", async () => {
    const untrustedExecutor: DirectLiveExecutor = {
      async execute(request) {
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "failed",
          completedAt: NOW,
          summary: "approval",
          output: {
            code: "approval-required",
            invocationDigest: await createInvocationDigest(request.invocation),
            sessionId: request.invocation.sessionId,
            policyId: request.policy.policyId,
            policyRevision: request.policy.revision + 1,
            decision: {
              schemaVersion: 1,
              outcome: "require-approval",
              capability: request.invocation.capability,
              targetScope: request.invocation.targetScope,
              risk: "risky",
              reason: "untrusted binding",
              approvalKind: "ask-always",
            },
          } as unknown as JsonObject,
          evidence: [],
        };
      },
    };
    const test = gateway({ selectedPolicy: policy("never", "ask-always"), executor: untrustedExecutor });
    await test.runtime.runOnce();
    expect(test.control.approvals).toEqual([]);
    expect(test.hostCalls).toEqual([]);
    expect(test.control.events.find((event) => event.kind === "tool-result")?.payload).toMatchObject({
      output: { code: "approval-invalid" },
    });
  });

  it("propagates durable cancellation into the harness before an executor side effect", async () => {
    const test = gateway({
      selectedPolicy: policy("never"),
      behavior: "cancel-running",
      monitorLease: true,
    });
    await test.runtime.runOnce();
    expect(test.hostCalls).toEqual([]);
    expect(test.control.statuses).toEqual(["ack"]);
  });

  it("persists committed mutation proof when durable cancellation races with the executor result", async () => {
    const selectedPolicy = policy("never");
    const assignment = work(selectedPolicy);
    const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
    await store.createSession({
      session: assignment.session,
      policySnapshot: selectedPolicy,
      initialTask: assignment.task,
      idempotencyKey: "create-committed-cancel-race",
    });
    const service = new AgentRuntimeService(store, {
      now: () => new Date(NOW),
      createId: () => "committed-cancel-race",
      sleep: async () => undefined,
    });
    let markCommitted: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    const executor: DirectLiveExecutor = {
      async execute(request) {
        markCommitted?.();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          schemaVersion: 1,
          invocationId: request.invocation.invocationId,
          status: "succeeded",
          completedAt: NOW,
          summary: "Mutation committed before cancellation.",
          output: { committed: true },
          evidence: [],
          mutationCommit: { committed: true, point: "atomic-rename" },
        };
      },
    };
    const runtime = new AgentRuntimeGateway({
      control: new StoreControl(service, "runtime-store"),
      executor,
      backup: {
        async evaluateAvailability() {
          return "available";
        },
        async create(request) {
          return {
            ...request,
            status: "succeeded",
            backupId: "unused",
            createdAt: NOW,
            fenceAuthorization: {
              schemaVersion: 1,
              status: "succeeded",
              authorizationId: "fence-unused",
              runtimeId: "runtime-store",
              leaseId: request.leaseId,
              leaseGeneration: request.leaseGeneration,
              sessionId: request.sessionId,
              taskId: request.taskId,
              invocationId: request.invocationId,
              invocationDigest: request.invocationDigest,
              backupId: "unused",
              lifecycleLockId: "lock-unused",
              lifecycleFencingToken: 1,
              lifecycleLeaseGeneration: 1,
              lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
              issuedAt: NOW,
              expiresAt: "2099-09-02T12:05:00.000Z",
              signature: "A".repeat(86),
            },
          };
        },
        async finalize(request) {
          return {
            schemaVersion: 1,
            authorizationId: request.authorization.authorizationId,
            status: "finalized",
            released: true,
          };
        },
        async renew() {
          throw new Error("Unused backup fence is never renewed");
        },
      },
      providers: {
        async resolve() {
          return {
            configuration: {
              schemaVersion: 1,
              profileId: "fake-profile",
              providerId: "fake",
              model: "fake-model",
              credentialRef: "secret-ref:test/fake",
              timeoutMs: 1_000,
            },
            exactSecrets: [],
          };
        },
      },
      harnesses: {
        create({ toolExecutor }) {
          return {
            adapterId: "queued-cancellation-race",
            adapterVersion: "1.0.0",
            async *run(input): AsyncIterableIterator<AgentEvent> {
              const item = invocation();
              const invocationDigest = await createInvocationDigest(item);
              yield {
                schemaVersion: 1,
                eventId: "event-proposal",
                sessionId: item.sessionId,
                sequence: 1,
                timestamp: NOW,
                kind: "tool-proposal",
                payload: {
                  schemaVersion: 1,
                  redacted: true,
                  data: {
                    invocationId: item.invocationId,
                    invocationDigest,
                    capability: item.capability,
                    targetScope: item.targetScope as unknown as JsonObject,
                  },
                },
                replayCursor: `${item.sessionId}:1`,
              };
              const execution = toolExecutor.invoke(
                item,
                () => undefined,
                input.signal ?? new AbortController().signal
              );
              await new Promise<void>((resolve) => {
                if (input.signal?.aborted) resolve();
                else input.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              for (const [sequence, kind] of [
                [2, "model"],
                [3, "tool-progress"],
                [4, "completion"],
              ] as const) {
                yield {
                  schemaVersion: 1,
                  eventId: `queued-${kind}`,
                  sessionId: item.sessionId,
                  sequence,
                  timestamp: NOW,
                  kind,
                  payload: { schemaVersion: 1, redacted: true, data: { queuedAfterCancellation: true } },
                  replayCursor: `${item.sessionId}:${sequence}`,
                };
              }
              const result = await execution;
              yield {
                schemaVersion: 1,
                eventId: "event-result",
                sessionId: item.sessionId,
                sequence: 5,
                timestamp: NOW,
                kind: "tool-result",
                payload: { schemaVersion: 1, redacted: true, data: result as unknown as JsonObject },
                replayCursor: `${item.sessionId}:5`,
              };
            },
          };
        },
      },
      now: () => new Date(NOW),
      createId: () => "committed-cancel-race",
      workWaitMs: 0,
      decisionWaitMs: 1,
      monitorLease: true,
    });

    const running = runtime.runOnce();
    await committed;
    await vi.waitFor(async () => {
      const beforeCancel = await store.getSession("session-runtime");
      await store.cancelSession({
        sessionId: "session-runtime",
        expectedRevision: beforeCancel!.revision,
        idempotencyKey: "operator-cancel-after-commit",
        requestedAt: NOW,
        requestedBy: "actor-runtime",
        reason: "Cancellation raced after commit.",
      });
    });
    await expect(running).resolves.toBe(true);

    const cancelled = await store.getSession("session-runtime");
    expect(cancelled?.session.status).toBe("cancelled");
    expect(cancelled?.events.find((event) => event.kind === "tool-result")?.payload.data).toMatchObject({
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
    expect(cancelled?.events.some((event) => event.payload.data.queuedAfterCancellation === true)).toBe(false);
  });

  it.each([
    ["approve", true],
    ["deny", false],
  ] as const)("requires digest-bound %s after a failed backup", async (behavior, effectExpected) => {
    const test = gateway({
      selectedPolicy: policy("before-risky"),
      behavior,
      backupFails: true,
    });
    await test.runtime.runOnce();
    expect(test.backupCalls).toHaveLength(1);
    expect(test.hostCalls).toHaveLength(effectExpected ? 1 : 0);
    expect(test.control.approvals[0]?.scope.capability).toBe("backup.create");
    expect(test.control.approvals[0]?.scope.kind).toBe("single-invocation");
  });

  it.each(["approve", "deny"] as const)(
    "never offers proceed-without-backup for unavailable state even when behavior is %s",
    async (behavior) => {
      const test = gateway({
        selectedPolicy: policy("before-risky"),
        behavior,
        backupAvailable: false,
      });
      await test.runtime.runOnce();
      expect(test.backupCalls).toHaveLength(0);
      expect(test.hostCalls).toHaveLength(0);
      expect(test.control.approvals).toHaveLength(0);
      expect(
        test.control.events.some((event) => event.kind === "backup" && event.payload.status === "unavailable")
      ).toBe(true);
    }
  );

  it.each(["pending", "cancelled", "ambiguous", "unavailable"] as const)(
    "never maps backup %s to proceed-without-backup approval",
    async (backupStatus) => {
      const test = gateway({
        selectedPolicy: policy("before-risky"),
        behavior: "approve",
        backupStatus,
      });
      await test.runtime.runOnce();
      expect(test.backupCalls).toHaveLength(1);
      expect(test.hostCalls).toHaveLength(0);
      expect(test.control.approvals).toHaveLength(0);
      expect(test.control.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "backup", payload: expect.objectContaining({ status: backupStatus }) }),
        ])
      );
    }
  );

  it.each([
    ["approved", true],
    ["denied", false],
  ] as const)(
    "publishes terminal backup-failure %s decisions through the authoritative store",
    async (decision, effectExpected) => {
      const selectedPolicy = policy("before-risky");
      const assignment = work(selectedPolicy);
      const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
      await store.createSession({
        session: assignment.session,
        policySnapshot: selectedPolicy,
        initialTask: assignment.task,
        idempotencyKey: `create-${decision}`,
      });
      const service = new AgentRuntimeService(store, {
        now: () => new Date(NOW),
        createId: () => decision,
        sleep: async () => undefined,
      });
      const host = effects();
      const executor = createDirectLiveExecutor(host.host, {
        workspaceRoot: "/fixture/server",
        scratchRoot: "/fixture/scratch",
        allowedExecutables: {},
        acceptGatewayAuthorizations: true,
        externalBackupCoordinator: true,
      });
      const runtime = new AgentRuntimeGateway({
        control: new StoreControl(service, "runtime-store"),
        executor,
        backup: {
          async evaluateAvailability() {
            return "available";
          },
          async create(request) {
            return { ...request, status: "failed" };
          },
          async finalize() {
            throw new Error("Failed backup has no fence to finalize");
          },
          async renew() {
            throw new Error("Failed backup has no fence to renew");
          },
        },
        providers: {
          async resolve() {
            return {
              configuration: {
                schemaVersion: 1,
                profileId: "fake-profile",
                providerId: "fake",
                model: "fake-model",
                credentialRef: "secret-ref:test/fake",
                timeoutMs: 1_000,
              },
              exactSecrets: [],
            };
          },
        },
        harnesses: {
          create({ toolExecutor }) {
            return new FakeHarness(toolExecutor, invocation(), []);
          },
        },
        now: () => new Date(NOW),
        createId: () => `store-${decision}`,
        workWaitMs: 0,
        decisionWaitMs: 1,
        monitorLease: false,
      });

      const running = runtime.runOnce();
      await vi.waitFor(async () => {
        expect((await store.getSession("session-runtime"))?.approvals).toHaveLength(1);
      });
      const waiting = await store.getSession("session-runtime");
      const pending = waiting!.approvals[0];
      expect(pending).toMatchObject({
        scope: { capability: "backup.create", kind: "single-invocation" },
        invocationSummary: {
          toolId: "workspace.write",
          capability: "workspace.write",
          backupFailureStatus: "failed",
        },
      });
      await store.decideApproval({
        sessionId: "session-runtime",
        approvalId: pending.approvalId,
        expectedRevision: waiting!.revision,
        idempotencyKey: `operator-${decision}`,
        decision,
        reason: `Operator ${decision} proceeding without backup.`,
        at: NOW,
      });
      await expect(running).resolves.toBe(true);

      const completed = await store.getSession("session-runtime");
      expect(host.calls).toHaveLength(effectExpected ? 1 : 0);
      expect(completed?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tool-proposal",
            payload: expect.objectContaining({
              data: expect.objectContaining({ toolId: "workspace.write", capability: "workspace.write" }),
            }),
          }),
        ])
      );
      expect(completed?.approvals[0].consumedAt !== undefined).toBe(effectExpected);
    }
  );

  it("retries identical outbound publication bodies after a network failure", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      throw new Error("reconnect");
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ success: true, data: { revision: 8 } }), { status: 200 });
    });
    const transport = new HttpRuntimeControlTransport({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-http-token-with-at-least-thirty-two-characters",
      fetch: fetchMock,
    });
    const revision = await transport.publishEvents("lease-runtime", {
      schemaVersion: 1,
      sessionId: "session-runtime",
      taskId: "task-runtime",
      expectedRevision: 7,
      idempotencyKey: "publish-retry",
      drafts: [
        {
          schemaVersion: 1,
          draftId: "draft-retry",
          ordinal: 1,
          timestamp: NOW,
          kind: "model",
          payload: { text: "same" },
        },
      ],
    });
    expect(revision).toBe(8);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("times out each control publication attempt and applies bounded retry backoff", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), {
          once: true,
        });
      });
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      throw new Error("delayed reconnect");
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ success: true, data: { revision: 8 } }), { status: 200 });
    });
    const transport = new HttpRuntimeControlTransport({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-http-token-with-at-least-thirty-two-characters",
      fetch: fetchMock,
      requestTimeoutMs: 5,
      retryBaseDelayMs: 10,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    await expect(
      transport.publishStatus("lease-runtime", {
        schemaVersion: 1,
        sessionId: "session-runtime",
        taskId: "task-runtime",
        expectedRevision: 7,
        idempotencyKey: "timeout-retry",
        status: "failed",
        reason: "bounded timeout test",
      })
    ).resolves.toBe(8);
    expect(delays).toEqual([10, 20]);
    expect(new Set(bodies).size).toBe(1);
  });

  it("retries approval consumption with one stable client fingerprint after an ambiguous response", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      throw new Error("response lost after commit");
    });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          data: { revision: 9, consumedAt: "2099-09-02T12:00:01.000Z" },
        }),
        { status: 200 }
      );
    });
    const transport = new HttpRuntimeControlTransport({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-http-token-with-at-least-thirty-two-characters",
      fetch: fetchMock,
    });
    const result = await transport.consumeApproval("lease-runtime", {
      schemaVersion: 1,
      sessionId: "session-runtime",
      taskId: "task-runtime",
      expectedRevision: 8,
      idempotencyKey: "consume-stable-retry",
      approvalId: "approval-runtime",
      invocationDigest: "d".repeat(64),
    });
    expect(result).toEqual({ revision: 9, consumedAt: "2099-09-02T12:00:01.000Z" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain("consumedAt");
  });

  it("stops reading and cancels an incrementally oversized control response", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new HttpRuntimeControlTransport({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-http-token-with-at-least-thirty-two-characters",
      fetch: vi.fn(async () => new Response(oversized, { status: 200 })),
    });

    await expect(
      transport.publishEvents("lease-runtime", {
        schemaVersion: 1,
        sessionId: "session-runtime",
        taskId: "task-runtime",
        expectedRevision: 7,
        idempotencyKey: "oversized-response",
        drafts: [
          {
            schemaVersion: 1,
            draftId: "draft-oversized",
            ordinal: 1,
            timestamp: NOW,
            kind: "model",
            payload: { text: "same" },
          },
        ],
      })
    ).rejects.toMatchObject({ status: 502, retryable: false });
    expect(cancelled).toBe(true);
  });
});
