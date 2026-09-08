import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAdapter, AgentToolExecutorAdapter } from "@/lib/agent/adapters";
import type { AgentEvent, JsonObject, PermissionPolicy, ToolInvocation, ToolResult } from "@/lib/agent/contracts";
import { AgentControlPlaneService, deriveOpaqueActorId } from "@/lib/agent/control-plane";
import { createDirectLiveExecutor } from "@/lib/agent/executor";
import { createInvocationDigest } from "@/lib/agent/policy";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import {
  AgentRuntimeService,
  DeterministicRuntimeBackupControlAdapter,
  type RuntimeApprovalConsumptionRequest,
  type RuntimeApprovalPublicationRequest,
  type RuntimeDecisionPollRequest,
  type RuntimeEventPublicationRequest,
  type RuntimeInvocationAuthorizationRequest,
  type RuntimeLeaseMutationRequest,
  type RuntimeRenewRequest,
  type RuntimeStatusPublicationRequest,
  type RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime";
import { AgentStateConflictError, InMemoryAgentSessionStore, InMemoryAgentStateRepository } from "@/lib/agent/state";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeGateway, type RuntimeControlTransport, RuntimeTransportError } from "../agent-runtime/src/gateway";
import { agentE2eNetworkAttempts } from "./agent-e2e-network.setup";
import { LocalAgentTestHost } from "./support/local-agent-test-host";

const NOW = "2099-09-02T12:00:00.000Z";

class LocalRuntimeControl implements RuntimeControlTransport {
  private approvalPersistedResolve: (() => void) | undefined;
  private approvalPublicationRelease: (() => void) | undefined;
  private readonly approvalPersisted = new Promise<void>((resolve) => {
    this.approvalPersistedResolve = resolve;
  });
  private readonly approvalPublicationReleased = new Promise<void>((resolve) => {
    this.approvalPublicationRelease = resolve;
  });

  constructor(
    private readonly service: AgentRuntimeService,
    private readonly runtimeId: string
  ) {}

  waitForPersistedApproval(): Promise<void> {
    return this.approvalPersisted;
  }

  releaseApprovalPublication(): void {
    this.approvalPublicationRelease?.();
  }

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
      // Match the HTTP transport contract so the gateway can refresh after an operator decision races publication.
      if (error instanceof AgentStateConflictError) throw new RuntimeTransportError(409, false);
      throw error;
    }
  }
  async publishApproval(leaseId: string, input: RuntimeApprovalPublicationRequest) {
    const result = await this.service.publishApproval(this.runtimeId, leaseId, input);
    this.approvalPersistedResolve?.();
    await this.approvalPublicationReleased;
    return result.state.revision;
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

function event(
  sessionId: string,
  sequence: number,
  kind: AgentEvent["kind"],
  data: JsonObject,
  id: string
): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    sessionId,
    sequence,
    timestamp: NOW,
    kind,
    payload: { schemaVersion: 1, redacted: true, data },
    replayCursor: `${sessionId}:${sequence}`,
  };
}

class VerticalSliceHarness implements AgentHarnessAdapter {
  readonly adapterId = "deterministic-local-simulator";
  readonly adapterVersion = "1.0.0";
  readonly invocations: ToolInvocation[] = [];

  constructor(private readonly tools: AgentToolExecutorAdapter) {}

  async *run(input: Parameters<AgentHarnessAdapter["run"]>[0]): AsyncIterable<AgentEvent> {
    let sequence = 0;
    const invoke = async (invocation: ToolInvocation): Promise<ToolResult> => {
      this.invocations.push(structuredClone(invocation));
      return await this.tools.invoke(invocation, () => undefined, input.signal ?? new AbortController().signal);
    };
    const invocation = (value: Omit<ToolInvocation, "schemaVersion" | "sessionId" | "requestedAt">) => ({
      schemaVersion: 1 as const,
      sessionId: input.session.sessionId,
      requestedAt: NOW,
      ...value,
    });

    yield event(
      input.session.sessionId,
      ++sequence,
      "model",
      { delta: "Inspecting the confined live fixture." },
      "vs-model"
    );
    const inspect = invocation({
      invocationId: "vs-inspect",
      toolId: "workspace.read",
      capability: "workspace.read",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: { path: "server.properties", maxBytes: 4_096 },
    });
    yield event(
      input.session.sessionId,
      ++sequence,
      "tool-proposal",
      {
        invocationId: inspect.invocationId,
        invocationDigest: await createInvocationDigest(inspect),
        capability: inspect.capability,
        targetScope: inspect.targetScope as unknown as JsonObject,
      },
      "vs-inspect-proposal"
    );
    const inspected = await invoke(inspect);
    yield event(
      input.session.sessionId,
      ++sequence,
      "tool-result",
      inspected as unknown as JsonObject,
      "vs-inspect-result"
    );

    const edit = invocation({
      invocationId: "vs-edit",
      toolId: "workspace.write",
      capability: "workspace.write",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: { path: "server.properties", content: "motd=Locally verified\nmax-players=12\n" },
    });
    yield event(
      input.session.sessionId,
      ++sequence,
      "tool-proposal",
      {
        invocationId: edit.invocationId,
        invocationDigest: await createInvocationDigest(edit),
        capability: edit.capability,
        targetScope: edit.targetScope as unknown as JsonObject,
        target: "server.properties",
      },
      "vs-edit-proposal"
    );
    const edited = await invoke(edit);
    yield event(input.session.sessionId, ++sequence, "tool-result", edited as unknown as JsonObject, "vs-edit-result");

    const consoleAction = invocation({
      invocationId: "vs-console",
      toolId: "console.execute",
      capability: "console.execute",
      targetScope: { schemaVersion: 1, kind: "console", normalizedTarget: "server" },
      arguments: { command: "list", timeoutMs: 1_000 },
    });
    yield event(
      input.session.sessionId,
      ++sequence,
      "tool-proposal",
      {
        invocationId: consoleAction.invocationId,
        invocationDigest: await createInvocationDigest(consoleAction),
        capability: consoleAction.capability,
        targetScope: consoleAction.targetScope as unknown as JsonObject,
      },
      "vs-console-proposal"
    );
    const consoleResult = await invoke(consoleAction);
    yield event(
      input.session.sessionId,
      ++sequence,
      "tool-result",
      consoleResult as unknown as JsonObject,
      "vs-console-result"
    );
    yield event(
      input.session.sessionId,
      ++sequence,
      "completion",
      { status: "completed", evidenceCount: 3 },
      "vs-completion"
    );
  }
}

function verticalPolicy(): PermissionPolicy {
  const base = createPolicyFromPreset("maintainer", "ignored");
  return createCustomPolicy(
    base,
    "ignored",
    1,
    Object.fromEntries(
      base.rules.map((rule) => [rule.capability, rule.capability === "workspace.write" ? "ask-always" : "allow"])
    ),
    "before-risky"
  );
}

describe("cloud-free local agent vertical slice", () => {
  it("inspects, pauses for exact approval, backs up, edits, runs console, replays, and completes locally", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "mc-agent-vertical-"));
    const workspace = path.join(fixture, "workspace");
    const scratch = path.join(fixture, "scratch");
    const outside = path.join(fixture, "outside-sentinel.txt");
    await mkdir(workspace);
    await mkdir(scratch);
    await writeFile(path.join(workspace, "server.properties"), "motd=Before\nmax-players=8\n", "utf8");
    await writeFile(outside, "outside-must-not-change", "utf8");

    try {
      const actorId = await deriveOpaqueActorId("local-operator@example.invalid");
      const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
      const controlPlane = new AgentControlPlaneService(store, () => new Date(NOW), false, {
        schemaVersion: 1,
        profiles: [
          {
            schemaVersion: 1,
            profileId: "fake-local-profile",
            providerId: "fake",
            providerKind: "fake",
            displayName: "Local vertical slice",
            endpointOrigin: "local://fake",
            endpointDisplay: "Local only",
            allowedModels: ["deterministic-local-v1"],
            supportedFeatures: ["streaming", "tools"],
          },
        ],
      });
      const selectedPolicy = verticalPolicy();
      const created = await controlPlane.createSession(actorId, {
        schemaVersion: 1,
        expectedRevision: 0,
        idempotencyKey: "vertical-slice",
        task: "Inspect server.properties, propose an exact edit, then run a bounded console check.",
        providerProfileId: "fake-local-profile",
        model: "deterministic-local-v1",
        policy: {
          schemaVersion: 1,
          preset: selectedPolicy.preset,
          rules: selectedPolicy.rules,
          backupMode: selectedPolicy.backupMode,
        },
      });
      await mkdir(path.join(scratch, created.sessionId));

      const runtimeId = "runtime-local-e2e";
      const runtimeService = new AgentRuntimeService(store, {
        now: () => new Date(NOW),
        createId: () => "vertical-slice",
        sleep: async () => undefined,
      });
      const host = new LocalAgentTestHost([workspace, scratch]);
      const directExecutor = createDirectLiveExecutor(host, {
        workspaceRoot: workspace,
        scratchRoot: scratch,
        allowedExecutables: { grep: "/usr/bin/grep" },
        maxTimeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        acceptGatewayAuthorizations: true,
        externalBackupCoordinator: true,
      });
      const directExecute = directExecutor.execute.bind(directExecutor);
      const executor = Object.assign(directExecutor, {
        execute: async (request: Parameters<typeof directExecutor.execute>[0]) =>
          await directExecute({
            ...request,
            assertCommitAllowed: request.assertCommitAllowed ?? (async () => undefined),
          }),
        probeFence: async () => "terminal" as const,
        renewFence: async () => undefined,
        revokeFence: async () => undefined,
        prepareBackupHandoff: async () => undefined,
        authorizeBackupHandoff: async () => undefined,
        terminalReceiptFor: async (request: Parameters<typeof directExecutor.execute>[0], result: ToolResult) => {
          const authorization = request.backupAuthorization;
          if (authorization?.status !== "succeeded") return undefined;
          return {
            schemaVersion: 1 as const,
            source: "executor-journal" as const,
            proofKind: "terminal" as const,
            outcome:
              result.status === "succeeded"
                ? ("committed" as const)
                : result.status === "failed"
                  ? ("failed" as const)
                  : result.status,
            executorKeyId: "executor-receipt-deterministic",
            executorKeyEpoch: 1,
            executorEpoch: "epoch-vertical-slice",
            runtimeId: authorization.runtimeId,
            leaseId: authorization.leaseId,
            leaseGeneration: authorization.leaseGeneration,
            sessionId: authorization.sessionId,
            taskId: authorization.taskId,
            invocationId: authorization.invocationId,
            invocationDigest: authorization.invocationDigest,
            backupId: authorization.backupId,
            lifecycleLockId: authorization.lifecycleLockId,
            lifecycleFencingToken: authorization.lifecycleFencingToken,
            lifecycleLeaseGeneration: authorization.lifecycleLeaseGeneration,
            resultDigest: "0".repeat(64),
            journalSequence: 1,
            completedAt: result.completedAt,
            signature: "A".repeat(86),
            fenceIssuedAt: authorization.issuedAt,
          };
        },
      });
      const typedBackup = new DeterministicRuntimeBackupControlAdapter("succeeded", () => new Date(NOW));
      const backupCalls = vi.fn();
      const awsSdkCalls = vi.fn();
      const providerCalls = vi.fn();
      let harness: VerticalSliceHarness | undefined;
      const runtimeControl = new LocalRuntimeControl(runtimeService, runtimeId);
      const gateway = new AgentRuntimeGateway({
        control: runtimeControl,
        executor,
        backup: {
          async evaluateAvailability() {
            return await typedBackup.evaluateAvailability();
          },
          async create(request) {
            backupCalls(request);
            await runtimeService.assertBackupBinding(runtimeId, request);
            return await typedBackup.startOrPoll({ ...request, runtimeId });
          },
          async finalize(request) {
            return await typedBackup.finalize({ ...request, runtimeId });
          },
          async renew(request) {
            return await typedBackup.renew({ ...request, runtimeId });
          },
        },
        providers: {
          async resolve(profileId, _profileFingerprint, model) {
            return {
              configuration: {
                schemaVersion: 1,
                profileId,
                providerId: "fake",
                model,
                credentialRef: "secret-ref:test/local-fake",
                timeoutMs: 1_000,
              },
              exactSecrets: ["local-provider-canary-never-exposed"],
            };
          },
        },
        harnesses: {
          create({ toolExecutor }) {
            harness = new VerticalSliceHarness(toolExecutor);
            return harness;
          },
        },
        leaseDurationMs: 120_000,
        workWaitMs: 0,
        decisionWaitMs: 25,
        now: () => new Date(NOW),
        createId: () => "vertical-slice",
        monitorLease: false,
      });

      const running = gateway.runOnce();
      await runtimeControl.waitForPersistedApproval();
      await vi.waitFor(async () => {
        const state = await store.getSession(created.sessionId);
        expect(state?.session.status).toBe("waiting-approval");
        expect(state?.approvals).toHaveLength(1);
      });
      const waiting = await store.getSession(created.sessionId);
      const approval = waiting?.approvals[0];
      const editInvocation = harness?.invocations.find((candidate) => candidate.invocationId === "vs-edit");
      expect(approval?.scope.kind).toBe("single-invocation");
      expect(approval?.invocationDigest).toBe(await createInvocationDigest(editInvocation as ToolInvocation));
      try {
        await controlPlane.decideApproval(actorId, created.sessionId, approval!.approvalId, {
          schemaVersion: 1,
          expectedRevision: waiting!.revision,
          idempotencyKey: "operator-approves-exact-edit",
          decision: "approve",
          reason: "Approved exact local fixture edit.",
        });
      } finally {
        runtimeControl.releaseApprovalPublication();
      }
      await expect(running).resolves.toBe(true);

      const completed = await store.getSession(created.sessionId);
      expect(completed?.session.status).toBe("idle");
      expect(completed?.tasks[0].status).toBe("completed");
      expect(completed?.approvals).toEqual([
        expect.objectContaining({
          approvalId: approval?.approvalId,
          invocationDigest: await createInvocationDigest(editInvocation as ToolInvocation),
          decision: "approved",
          consumedAt: NOW,
        }),
      ]);
      expect(completed?.events.filter((item) => item.kind === "approval")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            data: expect.objectContaining({ approvalId: approval?.approvalId, decision: "pending" }),
          }),
        }),
      ]);
      expect(await readFile(path.join(workspace, "server.properties"), "utf8")).toBe(
        "motd=Locally verified\nmax-players=12\n"
      );
      expect(await readFile(outside, "utf8")).toBe("outside-must-not-change");
      expect(host.effects.map((effect) => effect.kind)).toEqual(["read", "write", "console"]);
      expect(host.consoleCommands).toEqual(["list"]);
      expect(backupCalls).toHaveBeenCalledTimes(1);
      expect(
        completed?.events.filter((item) => item.kind === "backup").map((item) => item.payload.data.status)
      ).toEqual(["requested", "succeeded"]);
      expect(
        completed?.events.some((item) => item.kind === "tool-result" && Array.isArray(item.payload.data.evidence))
      ).toBe(true);
      expect(
        completed?.events
          .filter((item) => item.kind === "tool-result")
          .map((item) => item.payload.data.mutationCommit)
          .filter(Boolean)
      ).toEqual([
        { committed: true, point: "atomic-rename" },
        { committed: true, point: "console-dispatch" },
      ]);
      const backupCompletedAt = completed?.events.findIndex(
        (item) => item.kind === "backup" && item.payload.data.status === "succeeded"
      );
      const editEvidenceAt = completed?.events.findIndex((item) => item.eventId === "vs-edit-result");
      expect(backupCompletedAt).toBeGreaterThanOrEqual(0);
      expect(editEvidenceAt).toBeGreaterThan(backupCompletedAt ?? Number.MAX_SAFE_INTEGER);
      expect(
        completed?.events
          .filter((item) => item.kind === "tool-result")
          .flatMap((item) => (Array.isArray(item.payload.data.evidence) ? item.payload.data.evidence : []))
      ).toHaveLength(3);

      const all = await controlPlane.waitForEvents(actorId, created.sessionId, undefined, 100, 0);
      const split = all.events[3];
      const reconnected = await controlPlane.waitForEvents(actorId, created.sessionId, split.replayCursor, 100, 0);
      expect([...all.events.slice(0, 4), ...reconnected.events].map((item) => item.sequence)).toEqual(
        all.events.map((item) => item.sequence)
      );
      expect(new Set(all.events.map((item) => item.eventId)).size).toBe(all.events.length);
      expect(all.events.map((item) => item.sequence)).toEqual(all.events.map((_, index) => index + 1));
      expect(JSON.stringify(all.events)).not.toContain("local-provider-canary-never-exposed");
      expect(host.networkAttempts).toBe(0);
      expect(agentE2eNetworkAttempts()).toBe(0);
      expect(providerCalls).not.toHaveBeenCalled();
      expect(awsSdkCalls).not.toHaveBeenCalled();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
