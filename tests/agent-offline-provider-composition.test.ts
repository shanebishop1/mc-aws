import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonObject, PermissionPolicy } from "@/lib/agent/contracts";
import { AgentControlPlaneService, deriveOpaqueActorId } from "@/lib/agent/control-plane";
import { createDirectLiveExecutor } from "@/lib/agent/executor";
import { loadAgentExtensionRegistry } from "@/lib/agent/extensions";
import { PiHarnessAdapter, createPiSdkRuntime, createSecretAwareEventRedactor } from "@/lib/agent/harness";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import {
  AgentRuntimeService,
  type RuntimeApprovalConsumptionRequest,
  type RuntimeApprovalPublicationRequest,
  type RuntimeDecisionPollRequest,
  type RuntimeEventPublicationRequest,
  type RuntimeInvocationAuthorizationRequest,
  type RuntimeLeaseMutationRequest,
  type RuntimeRecoveryPublicationRequest,
  type RuntimeRenewRequest,
  type RuntimeStatusPublicationRequest,
  type RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime";
import { signBackupFenceAuthorization } from "@/lib/agent/runtime/backup-fence";
import { verifyExecutorTerminalReceipt } from "@/lib/agent/runtime/executor-receipt";
import { InMemoryAgentSessionStore, InMemoryAgentStateRepository } from "@/lib/agent/state";
import { DIRECT_LIVE_TOOL_DEFINITIONS } from "@/lib/agent/tool-definitions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeGateway, type RuntimeControlTransport } from "../agent-runtime/src/gateway";
import { ExecutorProtocolClient, ExecutorProtocolServer } from "../agent-runtime/src/protocol";
import { ProviderResponseGuard } from "../agent-runtime/src/provider-response-guard";
import {
  OFFLINE_PROVIDER_CREDENTIAL,
  OFFLINE_PROVIDER_ENDPOINT,
  SAMPLE_TOOL_NAME,
  ScriptedOfflineProviderTransport,
} from "./fixtures/agent-offline-provider/scripted-transport";
import { LocalAgentTestHost } from "./support/local-agent-test-host";

const NOW = "2099-09-02T12:00:00.000Z";

class LocalRuntimeControl implements RuntimeControlTransport {
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
    return (await this.service.publishEvents(this.runtimeId, leaseId, input)).revision;
  }
  async publishRecovery(leaseId: string, input: RuntimeRecoveryPublicationRequest) {
    return await this.service.publishRecovery(this.runtimeId, leaseId, input);
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

function policy(): PermissionPolicy {
  const base = createPolicyFromPreset("maintainer", "offline-composition-policy");
  return createCustomPolicy(
    base,
    "offline-composition-policy",
    2,
    Object.fromEntries(
      base.rules.map((rule) => [rule.capability, rule.capability === "workspace.write" ? "ask-always" : "allow"])
    ),
    "never"
  );
}

function keyId(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return `executor-receipt-${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}

async function createFence(
  input: Parameters<NonNullable<AgentRuntimeGateway["runOnce"]>>[0] extends never
    ? never
    : {
        runtimeId: string;
        leaseId: string;
        leaseGeneration: number;
        sessionId: string;
        taskId: string;
        invocationId: string;
        invocationDigest: string;
        backupId: string;
        executorKeyId: string;
      }
) {
  const issuedAt = new Date(NOW);
  return await signBackupFenceAuthorization({
    schemaVersion: 1,
    status: "succeeded",
    authorizationId: `fence-${input.invocationId}`,
    runtimeId: input.runtimeId,
    leaseId: input.leaseId,
    leaseGeneration: input.leaseGeneration,
    sessionId: input.sessionId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    invocationDigest: input.invocationDigest,
    backupId: input.backupId,
    lifecycleLockId: `lock-${input.invocationId}`,
    lifecycleFencingToken: 1,
    lifecycleLeaseGeneration: 1,
    lifecycleLeaseExpiresAt: new Date(issuedAt.getTime() + 30 * 60_000).toISOString(),
    executorKeyId: input.executorKeyId,
    executorKeyEpoch: 1,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
  });
}

describe("offline scripted provider and production Pi composition", () => {
  it("uses real Pi to inspect, obtain exact approval, and write sequentially through one authenticated executor", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-offline-provider-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    const piWork = path.join(fixtureRoot, "pi-work");
    const piAgent = path.join(fixtureRoot, "pi-agent");
    const socket = path.join(fixtureRoot, "executor.sock");
    const reconciliationState = path.join(fixtureRoot, "gateway-reconciliation.json");
    const runtimeId = "runtime-offline-composition";
    let idSequence = 0;
    const nextId = () => `offline-composition-id-${++idSequence}`;
    const transport = new ScriptedOfflineProviderTransport();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const controlKeys = generateKeyPairSync("ed25519");
    const receiptKeys = generateKeyPairSync("ed25519");
    const receiptKeyId = keyId(receiptKeys.publicKey);
    const previousFenceKey = process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8;

    await mkdir(workspace);
    await mkdir(scratch);
    await mkdir(piWork);
    await mkdir(piAgent);
    await mkdir(path.join(scratch, "session-placeholder"));
    await writeFile(path.join(workspace, "status.txt"), "status=before\n", "utf8");
    process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8 = controlKeys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");

    const sample = JSON.parse(
      await readFile(path.join(process.cwd(), "examples/agent-extensions/status-report/extension.json"), "utf8")
    ) as JsonObject;
    const registry = await loadAgentExtensionRegistry([sample]);
    const sampleTool = registry.tools.find((tool) => tool.toolId === "example.status-report.read");
    if (!sampleTool) throw new Error("enabled sample tool was not loaded");
    const actorId = await deriveOpaqueActorId("offline-composition@example.invalid");
    const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
    const controlPlane = new AgentControlPlaneService(store, () => new Date(NOW), false, {
      schemaVersion: 1,
      profiles: [
        {
          schemaVersion: 1,
          profileId: "offline-scripted-profile",
          providerId: "fake",
          providerKind: "fake",
          displayName: "Offline scripted provider",
          endpointOrigin: "local://fake",
          endpointDisplay: "Local only",
          allowedModels: ["offline-scripted-model"],
          supportedFeatures: ["streaming", "tools"],
        },
      ],
    });
    const created = await controlPlane.createSession(actorId, {
      schemaVersion: 1,
      expectedRevision: 0,
      idempotencyKey: "offline-composition",
      task: "Inspect status.txt with the enabled sample tool, then update it to status=updated after approval.",
      providerProfileId: "offline-scripted-profile",
      model: "offline-scripted-model",
      policy: policy(),
    });
    await mkdir(path.join(scratch, created.sessionId));

    const host = new LocalAgentTestHost([workspace, scratch]);
    const directExecutorBase = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
      acceptGatewayAuthorizations: true,
      externalBackupCoordinator: true,
      extensionTools: [sampleTool],
    });
    const directExecutor = directExecutorBase;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: path.join(fixtureRoot, "executor-journal.json"),
      gatewayPublicKey: gatewayKeys.publicKey,
      backupFencePublicKey: controlKeys.publicKey,
      journalAuthenticationKey: Buffer.alloc(32, 0x51),
      executorReceiptPrivateKey: receiptKeys.privateKey,
      executorReceiptKeyId: receiptKeyId,
      executorReceiptKeyEpoch: 1,
      executorEpoch: "offline-composition-epoch",
      executor: directExecutor,
      now: () => new Date(NOW),
    });
    await server.listen();
    const executor = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: gatewayKeys.privateKey,
      reconciliationStatePath: reconciliationState,
      now: () => new Date(NOW),
      reconciliationAttempts: 2,
      reconciliationDelayMs: 1,
      sleep: async () => undefined,
    });
    const verifierSet = {
      schemaVersion: 1 as const,
      currentKeyId: receiptKeyId,
      verifiers: [
        {
          schemaVersion: 1 as const,
          keyId: receiptKeyId,
          publicKeySpki: receiptKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
          keyEpoch: 1,
        },
      ],
    };
    const runtimeService = new AgentRuntimeService(store, {
      now: () => new Date(NOW),
      createId: nextId,
      sleep: async () => undefined,
      verifyRecoveryReceipt: async (receipt) => await verifyExecutorTerminalReceipt(receipt, verifierSet),
    });
    const runtimeControl = new LocalRuntimeControl(runtimeService, runtimeId);
    const typedBackup = {
      async evaluateAvailability() {
        return "available" as const;
      },
      async create(
        request: Parameters<NonNullable<import("@/agent-runtime/src/gateway").RuntimeGatewayBackupAdapter["create"]>>[0]
      ) {
        const backupId = `backup-${request.invocationId}`;
        return {
          ...request,
          status: "succeeded" as const,
          backupId,
          createdAt: NOW,
          fenceAuthorization: await createFence({
            runtimeId,
            leaseId: request.leaseId,
            leaseGeneration: request.leaseGeneration,
            sessionId: request.sessionId,
            taskId: request.taskId,
            invocationId: request.invocationId,
            invocationDigest: request.invocationDigest,
            backupId,
            executorKeyId: receiptKeyId,
          }),
        };
      },
      async finalize(input: import("@/lib/agent/runtime/contracts").RuntimeBackupFinalizeRequest) {
        return {
          schemaVersion: 1 as const,
          authorizationId: input.authorization.authorizationId,
          status: "finalized" as const,
          released: true,
        };
      },
      async renew(input: import("@/lib/agent/runtime/contracts").RuntimeBackupRenewRequest) {
        return {
          schemaVersion: 1 as const,
          authorizationId: input.authorization.authorizationId,
          status: "renewed" as const,
          authorization: input.authorization,
        };
      },
    };

    const providerGuard = new ProviderResponseGuard({ fetch: transport.fetch });
    let piSessionCwd = "";
    const gateway = new AgentRuntimeGateway({
      control: runtimeControl,
      executor,
      backup: typedBackup,
      providers: {
        async resolve(profileId, _fingerprint, model) {
          return {
            configuration: {
              schemaVersion: 1,
              profileId,
              providerId: "scripted-openai",
              model,
              credentialRef: "secret-ref:offline/provider",
              timeoutMs: 1_000,
            },
            exactSecrets: [OFFLINE_PROVIDER_CREDENTIAL],
          };
        },
      },
      harnesses: {
        create({ toolExecutor, exactSecrets }) {
          const runtime = createPiSdkRuntime({
            cwd: piWork,
            agentDir: piAgent,
            systemPrompt: "Use only the explicitly provided mc-aws tools.",
            resolveSessionConfiguration: async () => {
              piSessionCwd = piWork;
              const modelRuntime = await ModelRuntime.create({
                allowModelNetwork: false,
                refreshOnCreate: false,
                modelsPath: null,
              });
              modelRuntime.registerProvider("openai", {
                name: "Offline scripted OpenAI-compatible provider",
                baseUrl: OFFLINE_PROVIDER_ENDPOINT,
                api: "openai-completions",
                apiKey: OFFLINE_PROVIDER_CREDENTIAL,
                models: [
                  {
                    id: "offline-scripted-model",
                    name: "Offline scripted model",
                    api: "openai-completions",
                    baseUrl: OFFLINE_PROVIDER_ENDPOINT,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 512,
                  },
                ],
              });
              const model = modelRuntime.getModel("openai", "offline-scripted-model");
              if (!model) throw new Error("offline scripted model was not registered");
              return { model, modelRuntime };
            },
          });
          return new PiHarnessAdapter({
            runtime,
            toolExecutor,
            tools: [sampleTool, DIRECT_LIVE_TOOL_DEFINITIONS.find((tool) => tool.toolId === "workspace.write")!].map(
              (definition) => ({
                name: definition.toolId.replaceAll(/[^A-Za-z0-9_-]/g, "_"),
                definition,
                resolveTargetScope: (arguments_: JsonObject) => ({
                  schemaVersion: 1 as const,
                  kind: "workspace" as const,
                  normalizedTarget: String(arguments_.path ?? "."),
                }),
              })
            ),
            eventRedactor: createSecretAwareEventRedactor({ exactSecrets }),
            providerResponseLimitSignal: providerGuard.signal,
          });
        },
      },
      extensionHooks: registry.hooks,
      runtimeExactSecrets: [OFFLINE_PROVIDER_CREDENTIAL],
      workWaitMs: 0,
      decisionWaitMs: 5_000,
      now: () => new Date(NOW),
      createId: nextId,
      monitorLease: false,
      fenceRenewIntervalMs: 1_000,
    });

    try {
      vi.stubGlobal("fetch", providerGuard.fetch);
      expect(await store.getSession(created.sessionId)).not.toBeNull();
      const running = gateway.runOnce();
      await vi.waitFor(async () => {
        const waiting = await store.getSession(created.sessionId);
        expect(waiting?.approvals).toHaveLength(1);
        expect(waiting?.session.status).toBe("waiting-approval");
      });
      const waiting = await store.getSession(created.sessionId);
      const approval = waiting?.approvals[0];
      if (!waiting || !approval) throw new Error("write approval was not durably published");
      await controlPlane.decideApproval(actorId, created.sessionId, approval.approvalId, {
        schemaVersion: 1,
        expectedRevision: waiting.revision,
        idempotencyKey: "approve-offline-composition-write",
        decision: "approve",
        reason: "Approve the exact scripted status.txt update.",
      });
      await expect(running).resolves.toBe(true);
      const inspected = await store.getSession(created.sessionId);
      if (!inspected) throw new Error("inspection session was not persisted");
      expect(inspected.session.status).toBe("idle");
      expect(inspected.tasks[0]?.status).toBe("completed");
      expect(inspected.tasks[0]?.runtimeRecoveries).toEqual([
        expect.objectContaining({ taskDisposition: "continue", taskStatus: "running", sessionStatus: "running" }),
      ]);
      expect(await readFile(path.join(workspace, "status.txt"), "utf8")).toBe("status=updated\n");

      const completed = await store.getSession(created.sessionId);
      const events = completed?.events ?? [];
      const toolResults = events.filter((event) => event.kind === "tool-result");
      const readProposal = events.find(
        (event) => event.kind === "tool-proposal" && event.payload.data.toolId === "example.status-report.read"
      );
      const readResult = toolResults.find(
        (event) => event.payload.data.invocationId === readProposal?.payload.data.invocationId
      );
      expect(completed?.session.status).toBe("idle");
      expect(completed?.tasks[0]?.status).toBe("completed");
      expect(piSessionCwd).toBe(piWork);
      expect(
        events.some((event) => event.kind === "model" && String(event.payload.data.delta).includes("Inspecting"))
      ).toBe(true);
      const proposals = events.filter((event) => event.kind === "tool-proposal");
      expect(proposals.map((event) => event.payload.data.toolId)).toEqual([
        "example.status-report.read",
        "workspace.write",
        "workspace.write",
      ]);
      expect(
        new Set(
          proposals
            .filter((event) => event.payload.data.toolId === "workspace.write")
            .map((event) => event.payload.data.invocationId)
        ).size
      ).toBe(1);
      expect(toolResults.some((event) => Array.isArray(event.payload.data.evidence))).toBe(true);
      const readEvidence = readResult?.payload.data.evidence;
      expect(readEvidence).toHaveLength(2);
      expect(await readFile(path.join(workspace, "status.txt"), "utf8")).toBe("status=updated\n");
      expect(host.effects.map((effect) => effect.kind)).toEqual(["read", "write"]);
      expect(completed?.approvals).toEqual([
        expect.objectContaining({ approvalId: approval.approvalId, decision: "approved", consumedAt: NOW }),
      ]);
      expect(transport.requests).toHaveLength(3);
      expect(transport.requests.every((request) => request.body.stream === true)).toBe(true);
      expect(transport.requests[0].body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: SAMPLE_TOOL_NAME }) }),
        ])
      );
      expect(transport.externalNetworkAttempts).toBe(0);
      expect(providerGuard.signal.aborted).toBe(false);
      expect(JSON.stringify(events)).not.toContain(OFFLINE_PROVIDER_CREDENTIAL);
      expect(JSON.stringify(events)).not.toContain("secret-ref:offline/provider");
      expect(executor).toBeInstanceOf(ExecutorProtocolClient);
    } finally {
      vi.unstubAllGlobals();
      await server.close();
      if (previousFenceKey === undefined) process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8 = undefined;
      else process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8 = previousFenceKey;
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });
});
