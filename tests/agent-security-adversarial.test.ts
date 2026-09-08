import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolExecutorAdapter } from "@/lib/agent/adapters";
import type {
  AgentApproval,
  AgentEvent,
  AgentExtensionBundle,
  PermissionPolicy,
  ToolInvocation,
} from "@/lib/agent/contracts";
import { createDirectLiveExecutor } from "@/lib/agent/executor";
import { computeExtensionIntegrity, loadAgentExtensionRegistry } from "@/lib/agent/extensions";
import { canonicalAgentFixtures } from "@/lib/agent/fixtures";
import { PiHarnessAdapter, type PiRuntime, createSecretAwareEventRedactor } from "@/lib/agent/harness";
import {
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
} from "@/lib/agent/policy";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import { validateProviderEndpoint } from "@/lib/agent/providers/endpoint-security";
import { OpenAiCompatibleProviderAdapter } from "@/lib/agent/providers/openai-compatible";
import type { PinnedProviderFetch } from "@/lib/agent/providers/types";
import { StreamingSecretRedactor } from "@/lib/agent/redaction";
import { AgentStateConflictError, InMemoryAgentSessionStore, InMemoryAgentStateRepository } from "@/lib/agent/state";
import { describe, expect, it, vi } from "vitest";
import { PinnedHttpsTransport } from "../agent-runtime/src/pinned-https";
import { ProviderResponseGuard } from "../agent-runtime/src/provider-response-guard";
import { agentE2eNetworkAttempts } from "./agent-e2e-network.setup";
import { ADVERSARIAL_PROMPT, ADVERSARIAL_TOOL_FIXTURES } from "./fixtures/agent-adversarial";
import { LocalAgentTestHost } from "./support/local-agent-test-host";

const NOW = "2099-09-02T12:00:00.000Z";
const SECRET = "configured-secret-canary-42";

function policy(decision: "allow" | "ask-always" = "allow"): PermissionPolicy {
  const base = createPolicyFromPreset("autopilot", "security-policy");
  return createCustomPolicy(
    base,
    "security-policy",
    2,
    Object.fromEntries(base.rules.map((rule) => [rule.capability, decision])),
    "never"
  );
}

function invocation(
  sessionId: string,
  fixture: (typeof ADVERSARIAL_TOOL_FIXTURES)[number],
  invocationId: string
): ToolInvocation {
  return {
    schemaVersion: 1,
    invocationId,
    sessionId,
    toolId: fixture.toolId,
    capability: fixture.capability,
    targetScope: fixture.scope,
    arguments: fixture.arguments,
    requestedAt: NOW,
  };
}

async function createState(selectedPolicy = policy()) {
  const store = new InMemoryAgentSessionStore(new InMemoryAgentStateRepository());
  let result = await store.createSession({
    session: {
      schemaVersion: 1,
      sessionId: "session-adversarial",
      actorId: "actor-adversarial",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      policyId: selectedPolicy.policyId,
      policyRevision: selectedPolicy.revision,
      harness: {
        schemaVersion: 1,
        adapterId: "fake-security",
        adapterVersion: "1.0.0",
        providerProfileId: "fake-profile",
        providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        model: "fake-model",
      },
      turns: [],
    },
    policySnapshot: selectedPolicy,
  });
  result = await store.addTask({
    sessionId: "session-adversarial",
    expectedRevision: result.state.revision,
    idempotencyKey: "security-task",
    task: {
      schemaVersion: 1,
      taskId: "task-adversarial",
      sessionId: "session-adversarial",
      status: "pending",
      content: ADVERSARIAL_PROMPT,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return { store, state: result.state };
}

async function collect(stream: AsyncIterable<Record<string, unknown>>) {
  const output: Array<Record<string, unknown>> = [];
  for await (const item of stream) output.push(item);
  return output;
}

describe("adversarial agent immutable boundaries", () => {
  it("denies prompt-directed tool, path, shell/interpreter, console, metadata, and AWS abuse before effects", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-adversarial-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    const outside = path.join(fixtureRoot, "outside-sentinel.txt");
    await mkdir(workspace);
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    await writeFile(outside, "unchanged", "utf8");
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: { sh: "/bin/sh", python3: "/usr/bin/python3" },
      maxTimeoutMs: 1_000,
    });
    try {
      const denials = [];
      for (const [index, attack] of ADVERSARIAL_TOOL_FIXTURES.entries()) {
        const item = invocation("session-adversarial", attack, `attack-${index}`);
        const first = await executor.execute({
          actorId: "actor-adversarial",
          invocation: item,
          policy: policy(),
          approvals: [],
        });
        const second = await executor.execute({
          actorId: "actor-adversarial",
          invocation: item,
          policy: policy(),
          approvals: [],
        });
        expect(second).toMatchObject({ status: first.status, summary: first.summary, output: first.output });
        expect(first).toMatchObject({ status: "failed", evidence: [] });
        expect(JSON.stringify(first)).not.toContain(ADVERSARIAL_PROMPT);
        denials.push(first);
      }
      expect(host.effects).toEqual([]);
      expect(host.networkAttempts).toBe(0);
      expect(await readFile(outside, "utf8")).toBe("unchanged");

      const { store, state } = await createState();
      let revision = state.revision;
      for (const [index, denial] of denials.entries()) {
        const appended = await store.appendEvent({
          sessionId: "session-adversarial",
          expectedRevision: revision,
          idempotencyKey: `audit-denial-${index}`,
          eventId: `audit-denial-${index}`,
          timestamp: NOW,
          kind: "tool-result",
          payload: denial as unknown as Record<string, never>,
        });
        revision = appended.state.revision;
      }
      const audit = await store.replayEvents("session-adversarial");
      expect(audit.events).toHaveLength(denials.length);
      expect(audit.events.every((item) => item.payload.redacted)).toBe(true);
      expect(audit.events.map((item) => item.sequence)).toEqual(audit.events.map((_, index) => index + 1));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects an actual symlink escape before descriptor I/O", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-symlink-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    const outside = path.join(fixtureRoot, "outside.txt");
    await mkdir(workspace);
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    await writeFile(outside, "sentinel", "utf8");
    await symlink(outside, path.join(workspace, "escape"));
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
    });
    try {
      const result = await executor.execute({
        actorId: "actor-adversarial",
        invocation: {
          schemaVersion: 1,
          invocationId: "symlink-escape",
          sessionId: "session-adversarial",
          toolId: "workspace.write",
          capability: "workspace.write",
          targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "escape" },
          arguments: { path: "escape", content: "owned" },
          requestedAt: NOW,
        },
        policy: policy(),
        approvals: [],
      });
      expect(result).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
      expect(host.effects).toEqual([]);
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("leaves access control unchanged while Autopilot awaits destructive approval", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-access-control-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    await mkdir(workspace);
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    const target = path.join(workspace, "ops.json");
    await writeFile(target, "[]\n", "utf8");
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
    });
    try {
      const result = await executor.execute({
        actorId: "actor-adversarial",
        invocation: {
          schemaVersion: 1,
          invocationId: "autopilot-ops-write",
          sessionId: "session-adversarial",
          toolId: "workspace.write",
          capability: "workspace.write",
          targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "ops.json" },
          arguments: { path: "ops.json", content: '[{"name":"attacker"}]\n' },
          requestedAt: NOW,
        },
        policy: createPolicyFromPreset("autopilot", "autopilot-access-control"),
        approvals: [],
      });
      expect(result).toMatchObject({
        status: "failed",
        output: { code: "approval-required", decision: { risk: "destructive", approvalKind: "ask-always" } },
      });
      expect(host.effects).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("[]\n");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("denies generic writes, deletes, and downloads for executable assets before any host effect", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-immutable-assets-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    await mkdir(path.join(workspace, "plugins"), { recursive: true });
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    await writeFile(path.join(workspace, "paper.jar"), "paper", "utf8");
    await writeFile(path.join(workspace, "plugins", "Example.jar"), "plugin", "utf8");
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
    });
    const requests: ToolInvocation[] = [
      {
        schemaVersion: 1,
        invocationId: "immutable-paper-write",
        sessionId: "session-adversarial",
        toolId: "workspace.write",
        capability: "workspace.write",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "paper.jar" },
        arguments: { path: "paper.jar", content: "unreviewed" },
        requestedAt: NOW,
      },
      {
        schemaVersion: 1,
        invocationId: "immutable-plugin-delete",
        sessionId: "session-adversarial",
        toolId: "workspace.delete",
        capability: "workspace.delete",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "plugins/Example.jar" },
        arguments: { path: "plugins/Example.jar", recursive: false },
        requestedAt: NOW,
      },
      {
        schemaVersion: 1,
        invocationId: "immutable-start-download",
        sessionId: "session-adversarial",
        toolId: "network.download",
        capability: "network.outbound",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "scripts/start.sh" },
        arguments: {
          url: "https://downloads.example.invalid/start.sh",
          destination: "scripts/start.sh",
          expectedSha256: "a".repeat(64),
          expectedBytes: 1,
        },
        requestedAt: NOW,
      },
    ];
    try {
      for (const request of requests) {
        const result = await executor.execute({
          actorId: "actor-adversarial",
          invocation: request,
          policy: policy("allow"),
          approvals: [],
        });
        expect(result).toMatchObject({
          status: "failed",
          output: { code: "denied", decision: { immutableBoundary: "an immutable runtime or profile asset" } },
        });
      }
      expect(host.effects).toEqual([]);
      expect(host.networkAttempts).toBe(0);
      expect(await readFile(path.join(workspace, "paper.jar"), "utf8")).toBe("paper");
      expect(await readFile(path.join(workspace, "plugins", "Example.jar"), "utf8")).toBe("plugin");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("adversarial authorization, event, lease, and cancellation handling", () => {
  it("rejects duplicate, policy-revision, actor, scope, and digest approval tampering", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-approval-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    await mkdir(workspace);
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    const target = path.join(workspace, "server.properties");
    await writeFile(target, "motd=safe\n", "utf8");
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
    });
    const item: ToolInvocation = {
      schemaVersion: 1,
      invocationId: "approval-target",
      sessionId: "session-adversarial",
      toolId: "workspace.write",
      capability: "workspace.write",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: { path: "server.properties", content: "motd=changed\n" },
      requestedAt: NOW,
    };
    const validSummary = await createProposedInvocationSummary(item, "risky");
    const valid: AgentApproval = {
      schemaVersion: 1,
      approvalId: "approval-valid",
      actorId: "actor-adversarial",
      sessionId: item.sessionId,
      policyId: "security-policy",
      policyRevision: 2,
      invocationDigest: await createInvocationDigest(item),
      invocationSummary: validSummary,
      invocationSummaryDigest: await createInvocationSummaryDigest(validSummary),
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: item.capability,
        targetScope: item.targetScope,
        risk: "risky",
      },
      expiresAt: "2099-09-02T13:00:00.000Z",
      decision: "approved",
      reason: "approved",
      decidedAt: NOW,
    };
    try {
      const tampered = [
        { ...valid, actorId: "actor-attacker" },
        { ...valid, policyRevision: 1 },
        { ...valid, invocationDigest: "b".repeat(64) },
        { ...valid, scope: { ...valid.scope, targetScope: { ...valid.scope.targetScope, normalizedTarget: "other" } } },
      ];
      for (const approval of tampered) {
        const result = await executor.execute({
          actorId: "actor-adversarial",
          invocation: item,
          policy: policy("ask-always"),
          approvals: [approval],
        });
        expect(result.status).toBe("failed");
        expect(["approval-required", "executor-failed"]).toContain((result.output as { code?: string }).code);
      }
      const duplicate = await executor.execute({
        actorId: "actor-adversarial",
        invocation: item,
        policy: policy("ask-always"),
        approvals: [valid, valid],
      });
      expect(duplicate).toMatchObject({ status: "failed", summary: "Executor failed closed." });
      expect(host.effects).toEqual([]);
      expect(await readFile(target, "utf8")).toBe("motd=safe\n");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("allows only one exact approval consumer to win a replay race", async () => {
    const selectedPolicy = policy("ask-always");
    const { store, state } = await createState(selectedPolicy);
    const fixture = ADVERSARIAL_TOOL_FIXTURES[0];
    const item = invocation(
      "session-adversarial",
      {
        ...fixture,
        scope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "safe.txt" },
        arguments: { path: "safe.txt", content: "safe" },
      },
      "race-target"
    );
    const approvalSummary = await createProposedInvocationSummary(item, "risky");
    const approval: AgentApproval = {
      schemaVersion: 1,
      approvalId: "approval-race",
      actorId: "actor-adversarial",
      sessionId: "session-adversarial",
      policyId: selectedPolicy.policyId,
      policyRevision: selectedPolicy.revision,
      invocationDigest: await createInvocationDigest(item),
      invocationSummary: approvalSummary,
      invocationSummaryDigest: await createInvocationSummaryDigest(approvalSummary),
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: "workspace.write",
        targetScope: item.targetScope,
        risk: "risky",
      },
      expiresAt: "2099-09-02T13:00:00.000Z",
      decision: "approved",
      reason: "approved",
      decidedAt: NOW,
    };
    const put = await store.putApproval({
      sessionId: "session-adversarial",
      expectedRevision: state.revision,
      idempotencyKey: "put-race-approval",
      approval,
    });
    const consume = (key: string) =>
      store.consumeApproval({
        sessionId: "session-adversarial",
        approvalId: approval.approvalId,
        expectedRevision: put.state.revision,
        idempotencyKey: key,
        invocationDigest: approval.invocationDigest,
        at: "2099-09-02T12:00:01.000Z",
      });
    const results = await Promise.allSettled([consume("race-a"), consume("race-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects event ordinal gaps/forgery and stale lease fencing before persistence", async () => {
    const { store, state } = await createState();
    const work = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "lease-a",
      now: NOW,
      leaseDurationMs: 60_000,
    });
    const acknowledged = await store.acknowledgeRuntimeWork({
      sessionId: "session-adversarial",
      taskId: "task-adversarial",
      runtimeId: "runtime-a",
      leaseId: "lease-a",
      expectedRevision: work?.revision ?? state.revision,
      idempotencyKey: "ack-security",
      at: NOW,
    });
    const draft = {
      schemaVersion: 1 as const,
      draftId: "forged-draft",
      ordinal: 2,
      timestamp: NOW,
      kind: "model" as const,
      payload: { text: "forged" },
    };
    await expect(
      store.publishRuntimeEvents({
        sessionId: "session-adversarial",
        taskId: "task-adversarial",
        runtimeId: "runtime-a",
        leaseId: "lease-a",
        expectedRevision: acknowledged.state.revision,
        idempotencyKey: "ordinal-gap",
        at: NOW,
        drafts: [draft],
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
    await expect(
      store.publishRuntimeEvents({
        sessionId: "session-adversarial",
        taskId: "task-adversarial",
        runtimeId: "runtime-forged",
        leaseId: "lease-forged",
        expectedRevision: acknowledged.state.revision,
        idempotencyKey: "lease-forgery",
        at: NOW,
        drafts: [{ ...draft, ordinal: 1 }],
      })
    ).rejects.toBeInstanceOf(AgentStateConflictError);
    expect((await store.getSession("session-adversarial"))?.events).toEqual([]);
  });

  it("honors cancellation before a host effect", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-agent-cancel-"));
    const workspace = path.join(fixtureRoot, "workspace");
    const scratch = path.join(fixtureRoot, "scratch");
    await mkdir(workspace);
    await mkdir(path.join(scratch, "session-adversarial"), { recursive: true });
    await writeFile(path.join(workspace, "file.txt"), "safe", "utf8");
    const host = new LocalAgentTestHost([workspace, scratch]);
    const executor = createDirectLiveExecutor(host, {
      workspaceRoot: workspace,
      scratchRoot: scratch,
      allowedExecutables: {},
    });
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await executor.execute({
        actorId: "actor-adversarial",
        invocation: {
          schemaVersion: 1,
          invocationId: "cancelled-read",
          sessionId: "session-adversarial",
          toolId: "workspace.read",
          capability: "workspace.read",
          targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "file.txt" },
          arguments: { path: "file.txt" },
          requestedAt: NOW,
        },
        policy: policy(),
        approvals: [],
        signal: controller.signal,
      });
      expect(result.status).toBe("cancelled");
      expect(host.effects).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("adversarial secrets, providers, and extension boundaries", () => {
  it("redacts configured canaries across chunks and nested events, errors, and evidence", () => {
    const stream = new StreamingSecretRedactor([SECRET]);
    const chunks = ["prefix configured-", "secret-can", "ary-42 suffix"];
    const output = chunks.map((chunk) => stream.push(chunk)).join("") + stream.flush();
    expect(output).toBe("prefix [REDACTED] suffix");

    const redactor = createSecretAwareEventRedactor({ exactSecrets: [SECRET] });
    const redacted = redactor.redact({
      event: `event:${SECRET}`,
      error: { message: `failed ${SECRET}` },
      evidence: [{ description: `proof ${SECRET}`, uri: "agent-evidence://safe" }],
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    const eventChunks = ["configured-", "secret-canary-", "42"].map((chunk) =>
      redactor.redactStreamChunk?.("model", chunk)
    );
    eventChunks.push(redactor.flushStream?.("model"));
    expect(eventChunks.join("")).toBe("[REDACTED]");
  });

  it("redacts a provider credential split across SSE events without real DNS or network", async () => {
    const encoder = new TextEncoder();
    const frames = ["configured-secret-", "canary-42"].map(
      (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] })}\n\n`
    );
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n");
    const pinnedFetch = vi.fn<PinnedProviderFetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const frame of frames) controller.enqueue(encoder.encode(frame));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    );
    const adapter = new OpenAiCompatibleProviderAdapter(
      "fake-provider",
      { endpoint: "https://models.example.invalid/v1", maxAttempts: 1 },
      {
        resolveDns: vi.fn(async () => ["93.184.216.34"]),
        pinnedFetch,
        secretResolver: { resolve: vi.fn(async () => SECRET) },
      }
    );
    const events = await collect(
      adapter.stream(
        {
          schemaVersion: 1,
          profileId: "fake-profile",
          providerId: "fake-provider",
          model: "fake-model",
          credentialRef: "secret-ref:test/provider",
          timeoutMs: 1_000,
        },
        {}
      ) as AsyncIterable<Record<string, unknown>>
    );
    expect(events.map((item) => item.delta ?? "").join("")).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(pinnedFetch).toHaveBeenCalledOnce();
    expect(agentE2eNetworkAttempts()).toBe(0);
  });

  it("audits a split tool-argument overflow, destroys the response, and permits no host effect afterward", async () => {
    const encoder = new TextEncoder();
    const transportCancelled = vi.fn();
    let next = 0;
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "workspace_patch", arguments: '{"content":"12345678' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `90123456${SECRET}` } }] } }] })}\n\n`,
    ];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames[next++];
          if (frame !== undefined) controller.enqueue(encoder.encode(frame));
        },
        cancel: transportCancelled,
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const guard = new ProviderResponseGuard({
      fetch: vi.fn(async () => response),
      limits: {
        responseBytes: 1_024,
        sseLineBytes: 512,
        sseEventBytes: 768,
        toolArgumentBytes: 24,
      },
    });
    const hostEffects: string[] = [];
    const executor: AgentToolExecutorAdapter = {
      async invoke() {
        hostEffects.push("invoked");
        throw new Error("must not execute");
      },
      async cancel() {},
    };
    const abort = vi.fn(async () => undefined);
    const runtime: PiRuntime = {
      async createSession(input) {
        return {
          subscribe: () => () => undefined,
          async prompt() {
            const guardedResponse = await guard.fetch("https://models.example.invalid/v1");
            const reader = guardedResponse.body!.getReader();
            await expect(
              (async () => {
                while (!(await reader.read()).done) {
                  // Pull the exact production guard; parsing remains behind Pi in production.
                }
              })()
            ).rejects.toMatchObject({ code: "provider-response-limit" });
            await expect(
              input.tools[0].execute("after-provider-overflow", {
                path: "server.properties",
                content: "must-not-run",
              })
            ).rejects.toThrow(/fenced/);
          },
          abort,
          dispose() {},
        };
      },
    };
    const adapter = new PiHarnessAdapter({
      runtime,
      toolExecutor: executor,
      tools: [
        {
          name: "workspace_patch",
          definition: canonicalAgentFixtures.toolDefinition,
          resolveTargetScope: () => canonicalAgentFixtures.targetScope,
        },
      ],
      eventRedactor: createSecretAwareEventRedactor({ exactSecrets: [SECRET] }),
      providerResponseLimitSignal: guard.signal,
      cancellationTimeoutMs: 10,
      now: () => new Date(NOW),
      createId: (() => {
        let id = 0;
        return () => `overflow-${++id}`;
      })(),
    });
    const events = await collect(
      adapter.run({
        session: canonicalAgentFixtures.agentSession,
        provider: canonicalAgentFixtures.providerConfiguration,
        prompt: "Attempt an oversized tool call.",
      }) as unknown as AsyncIterable<Record<string, unknown>>
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "error",
      payload: { data: { code: "provider-response-limit" } },
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(transportCancelled).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(hostEffects).toEqual([]);
    expect(agentE2eNetworkAttempts()).toBe(0);
  });

  it("fails closed on metadata/private endpoints, DNS failure, and simulated DNS rebinding", async () => {
    await expect(
      validateProviderEndpoint("https://169.254.169.254/latest/meta-data", async () => ["169.254.169.254"], {
        providerId: "security",
      })
    ).rejects.toMatchObject({ code: "security" });
    await expect(
      validateProviderEndpoint("https://private.example.invalid", async () => ["10.0.0.7"], {
        providerId: "security",
      })
    ).rejects.toMatchObject({ code: "security" });
    await expect(
      validateProviderEndpoint(
        "https://failed.example.invalid",
        async () => {
          throw new Error(`DNS leaked ${SECRET}`);
        },
        { providerId: "security" }
      )
    ).rejects.toMatchObject({ code: "security", message: "Provider endpoint DNS resolution failed closed." });
    const reboundFetch = vi.fn<PinnedProviderFetch>(async () => {
      throw new Error(`rebound to 10.0.0.9 with ${SECRET}`);
    });
    const provider = new OpenAiCompatibleProviderAdapter(
      "security",
      { endpoint: "https://models.example.invalid/v1", maxAttempts: 1 },
      {
        resolveDns: vi.fn(async () => ["93.184.216.34"]),
        pinnedFetch: reboundFetch,
        secretResolver: { resolve: vi.fn(async () => SECRET) },
      }
    );
    const failure = await collect(
      provider.stream(
        {
          schemaVersion: 1,
          profileId: "security-profile",
          providerId: "security",
          model: "fake",
          credentialRef: "secret-ref:test/security",
          timeoutMs: 1_000,
        },
        {}
      ) as AsyncIterable<Record<string, unknown>>
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "network", message: "Provider network request failed." });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it("injects the network-disabled request into the direct undici-based pinned transport", async () => {
    const blockedUndici = vi.fn(async () => {
      throw new Error("direct undici blocked by injected E2E boundary");
    });
    const transport = new PinnedHttpsTransport({
      resolveDns: async () => ["93.184.216.34"],
      request: blockedUndici as never,
    });
    try {
      await expect(transport.fetchWithMetadata("https://models.example.invalid/v1", {})).rejects.toThrow(
        /direct undici blocked/
      );
      expect(blockedUndici).toHaveBeenCalledOnce();
      expect(agentE2eNetworkAttempts()).toBe(0);
    } finally {
      await transport.close();
    }
  });

  it("rejects extension provenance, integrity, raw credentials, and callback attempts without execution", async () => {
    const sample = JSON.parse(
      readFileSync(path.join(process.cwd(), "examples/agent-extensions/status-report/extension.json"), "utf8")
    ) as AgentExtensionBundle;
    const callback = vi.fn();
    await expect(loadAgentExtensionRegistry([{ ...sample, callback }])).rejects.toThrow("unknown field");
    const altered = structuredClone(sample);
    altered.version = "1.0.1";
    await expect(loadAgentExtensionRegistry([altered])).rejects.toThrow("integrity mismatch");
    const thirdParty = structuredClone(sample);
    thirdParty.provenance.source = "third-party";
    for (const skill of thirdParty.skills) skill.provenance.source = "third-party";
    thirdParty.provenance.integrity = await computeExtensionIntegrity(thirdParty);
    for (const skill of thirdParty.skills) skill.provenance.integrity = thirdParty.provenance.integrity;
    await expect(loadAgentExtensionRegistry([thirdParty])).rejects.toThrow("not explicitly trusted");
    await expect(
      loadAgentExtensionRegistry([
        {
          ...sample,
          tools: [{ ...sample.tools[0], inputSchema: { type: "object", properties: { token: { type: "string" } } } }],
        },
      ])
    ).rejects.toThrow("raw credential fields are forbidden");
    expect(callback).not.toHaveBeenCalled();
    expect(agentE2eNetworkAttempts()).toBe(0);
  });
});
