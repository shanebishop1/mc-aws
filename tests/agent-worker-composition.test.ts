import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type {
  AgentApproval,
  AgentEvent,
  AgentSession,
  BackupTerminalReceipt,
  ToolInvocation,
} from "@/lib/agent/contracts";
import { deriveOpaqueActorId } from "@/lib/agent/control-plane";
import type { CreateAgentSessionRequestDto } from "@/lib/agent/control-plane/contracts";
import {
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
} from "@/lib/agent/policy";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import type {
  RuntimeApprovalPublicationRequest,
  RuntimeDecisionPollRequest,
  RuntimeDecisionSnapshot,
  RuntimeEventPublicationRequest,
  RuntimeInvocationAuthorizationRequest,
  RuntimeLeaseMutationRequest,
  RuntimeRecoveryPublicationRequest,
  RuntimeRenewRequest,
  RuntimeStatusPublicationRequest,
  RuntimeWorkLeaseDto,
  RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime";
import { executorReceiptSignedContent } from "@/lib/agent/runtime/executor-receipt";
import { describe, expect, it } from "vitest";
import type { RuntimeControlTransport } from "../agent-runtime/src/gateway";

const CONFIG = path.join(process.cwd(), "tests/fixtures/agent-worker/wrangler.jsonc");
const NOW = "2026-09-09T12:00:00.000Z";
const ACTOR_EMAIL = "agent-worker-fixture@example.invalid";
const RUNTIME_ID = "fixture-runtime";

type WorkerEnvelope<T> = { success: boolean; data?: T; error?: string; timestamp: string };
const REQUEST_DEADLINE_MS = 10_000;
const STARTUP_DEADLINE_MS = 15_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForWorker(child: ChildProcess, origin: string): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/fixture/health`, { method: "POST", signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wrangler needs a short interval to start workerd and the local SQLite DO service.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the local workerd fixture after ${STARTUP_DEADLINE_MS}ms`);
}

async function request<T>(origin: string, route: string, input: unknown, token?: string): Promise<T> {
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
  const envelope = (await response.json()) as WorkerEnvelope<T>;
  if (!response.ok || !envelope.success) throw new Error(`${route}: ${response.status} ${envelope.error ?? "failed"}`);
  return envelope.data as T;
}

/** HTTP shape used by the fixture; this is not the production HttpRuntimeControlTransport. */
class FixtureHttpRuntimeTransport implements RuntimeControlTransport {
  constructor(
    private readonly origin: string,
    private readonly bearer: string
  ) {}

  leaseWork(input: RuntimeWorkLeaseRequest, signal?: AbortSignal) {
    return this.call<RuntimeWorkLeaseDto>("/api/agent/runtime/work", input, signal);
  }

  async acknowledge(leaseId: string, input: RuntimeLeaseMutationRequest): Promise<number> {
    const result = await this.call<{ state: { revision: number } }>(`/api/agent/runtime/leases/${leaseId}/ack`, input);
    return result.state.revision;
  }

  async publishEvents(leaseId: string, input: RuntimeEventPublicationRequest): Promise<number> {
    const result = await this.call<{ revision: number }>(`/api/agent/runtime/leases/${leaseId}/events`, input);
    return result.revision;
  }

  async renew(leaseId: string, input: RuntimeRenewRequest) {
    const result = await this.call<{
      state: { revision: number; tasks: Array<{ taskId: string; lease?: { expiresAt: string } }> };
    }>(`/api/agent/runtime/leases/${leaseId}/renew`, input);
    const task = result.state.tasks.find((candidate) => candidate.taskId === input.taskId);
    return { revision: result.state.revision, expiresAt: task?.lease?.expiresAt ?? "" };
  }

  async consumeApproval(
    leaseId: string,
    input: Parameters<NonNullable<RuntimeControlTransport["consumeApproval"]>>[1]
  ) {
    const result = await this.call<{ state: { revision: number; approvals: AgentApproval[] } }>(
      `/api/agent/runtime/leases/${leaseId}/consume-approval`,
      input
    );
    const approval = result.state.approvals.find((candidate) => candidate.approvalId === input.approvalId);
    return { revision: result.state.revision, consumedAt: approval?.consumedAt ?? "" };
  }

  async publishApproval(leaseId: string, input: RuntimeApprovalPublicationRequest): Promise<number> {
    const result = await this.call<{ state: { revision: number } }>(
      `/api/agent/runtime/leases/${leaseId}/approval`,
      input
    );
    return result.state.revision;
  }

  async authorizeInvocation(leaseId: string, input: RuntimeInvocationAuthorizationRequest) {
    return await this.call<Awaited<ReturnType<RuntimeControlTransport["authorizeInvocation"]>>>(
      `/api/agent/runtime/leases/${leaseId}/authorize`,
      input
    );
  }

  async publishStatus(leaseId: string, input: RuntimeStatusPublicationRequest): Promise<number> {
    const result = await this.call<{ state: { revision: number } }>(
      `/api/agent/runtime/leases/${leaseId}/status`,
      input
    );
    return result.state.revision;
  }

  async publishRecovery(leaseId: string, input: RuntimeRecoveryPublicationRequest) {
    return await this.call<Awaited<ReturnType<NonNullable<RuntimeControlTransport["publishRecovery"]>>>>(
      `/api/agent/runtime/leases/${leaseId}/recovery`,
      input
    );
  }

  waitForDecision(leaseId: string, input: RuntimeDecisionPollRequest, signal?: AbortSignal) {
    return this.call<RuntimeDecisionSnapshot>(`/api/agent/runtime/leases/${leaseId}/decisions`, input, signal);
  }

  private async call<T>(route: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.origin}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearer}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)])
        : AbortSignal.timeout(REQUEST_DEADLINE_MS),
    });
    const envelope = (await response.json()) as WorkerEnvelope<T>;
    if (!response.ok || !envelope.success)
      throw new Error(`${route}: ${response.status} ${envelope.error ?? "failed"}`);
    return envelope.data as T;
  }
}

function policy(): CreateAgentSessionRequestDto["policy"] {
  const preset = createPolicyFromPreset("copilot", "agent-worker-fixture-policy");
  return {
    schemaVersion: 1,
    preset: preset.preset,
    rules: preset.rules,
    backupMode: preset.backupMode,
  };
}

function sessionRequest(inputPolicy: CreateAgentSessionRequestDto["policy"]) {
  return {
    schemaVersion: 1 as const,
    expectedRevision: 0,
    idempotencyKey: "worker-composition-create",
    task: "Publish one approved tool result and keep the task live.",
    providerProfileId: "local-fake",
    model: "deterministic-v1",
    policy: inputPolicy,
  };
}

function resultDigest(result: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(result as never))
    .digest("hex");
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", () => finish(true));
    child.once("error", () => finish(true));
  });
}

async function terminateProcessGroup(child: ChildProcess): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signalGroup("SIGTERM");
  const exited = await waitForExit(child, 5_000);
  signalGroup("SIGKILL");
  if (!exited && !(await waitForExit(child, 5_000))) {
    throw new Error("Local Wrangler process group did not exit");
  }
}

describe("actual local Worker and Durable Object agent composition", () => {
  it("publishes one approved tool result with taskDisposition continue and replays authoritative events", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mc-aws-agent-worker-"));
    const persistRoot = path.join(fixtureRoot, "wrangler-state");
    await mkdir(persistRoot);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const bearer = `worker-fixture-bearer-${"x".repeat(32)}`;
    const bearerHash = createHash("sha256").update(bearer).digest("hex");
    const receiptKeys = generateKeyPairSync("ed25519");
    const publicKeySpki = receiptKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const receiptKeyId = `executor-receipt-${createHash("sha256").update(Buffer.from(publicKeySpki, "base64")).digest("hex")}`;
    const nodeNetworkGuard = path.join(process.cwd(), "tests/fixtures/agent-worker/node-network-guard.cjs");
    // Do not inherit the test runner environment: no AWS/provider/Cloudflare
    // credentials or real ~/.wrangler configuration enter this child.
    const childEnvironment: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: fixtureRoot,
      TMPDIR: fixtureRoot,
      XDG_CONFIG_HOME: fixtureRoot,
      XDG_CACHE_HOME: fixtureRoot,
      NO_COLOR: "1",
      NO_UPDATE_NOTIFIER: "1",
      WRANGLER_SEND_METRICS: "false",
      NODE_OPTIONS: `--require=${nodeNetworkGuard}`,
    };
    expect(Object.keys(childEnvironment)).toEqual([
      "PATH",
      "HOME",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "NO_COLOR",
      "NO_UPDATE_NOTIFIER",
      "WRANGLER_SEND_METRICS",
      "NODE_OPTIONS",
    ]);
    const child = spawn(
      path.join(process.cwd(), "node_modules/.bin/wrangler"),
      [
        "dev",
        "--local",
        "--config",
        CONFIG,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        persistRoot,
        "--var",
        `MC_AGENT_RUNTIME_TOKEN_SHA256:${bearerHash}`,
        "--var",
        `FIXTURE_RECEIPT_PUBLIC_KEY:${publicKeySpki}`,
        "--show-interactive-dev-session=false",
        "--log-level",
        "error",
      ],
      {
        cwd: fixtureRoot,
        detached: true,
        env: childEnvironment as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ) as ChildProcess;
    let output = "";
    let outputBytes = 0;
    const captureOutput = (chunk: Buffer) => {
      if (outputBytes >= MAX_CHILD_OUTPUT_BYTES) return;
      const retained = chunk.subarray(0, MAX_CHILD_OUTPUT_BYTES - outputBytes);
      output += retained.toString();
      outputBytes += retained.byteLength;
      if (outputBytes >= MAX_CHILD_OUTPUT_BYTES) output += "\n[child output truncated at 64 KiB]";
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    try {
      await waitForWorker(child, origin);
      const health = await request<{
        execution: string;
        durableObjectBindings: number;
        runtime: string;
        networkEnforcement: { workerFetch: string; workerdOsEgress: string };
      }>(origin, "/fixture/health", {});
      expect(health.execution).toBe("worker-http");
      expect(health.durableObjectBindings).toBe(3);
      expect(health.runtime).toMatch(/cloudflare|workerd/i);
      expect(health.networkEnforcement).toEqual({
        workerFetch: "loopback-only",
        workerdOsEgress: "not-qualified",
      });
      expect(await request<{ blocked: boolean }>(origin, "/fixture/network-probe", {})).toEqual({ blocked: true });
      const unauthorized = await fetch(`${origin}/api/agent/runtime/work`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-worker-fixture-bearer-xxxxxxxxxxxxxxxxxxxxxxxx",
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, claimId: "unauthorized", leaseDurationMs: 30_000, waitMs: 0 }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      expect(unauthorized.status).toBe(401);

      const actorId = await deriveOpaqueActorId(ACTOR_EMAIL);
      const created = await request<{ sessionId: string; session: AgentSession }>(origin, "/fixture/create", {
        actorId,
        request: sessionRequest(policy()),
      });
      const transport = new FixtureHttpRuntimeTransport(origin, bearer);
      const leased = await transport.leaseWork({
        schemaVersion: 1,
        claimId: "worker-composition-claim",
        leaseDurationMs: 30_000,
        waitMs: 0,
      });
      if (!leased) throw new Error("worker did not lease the created task");
      expect(leased.session.sessionId).toBe(created.sessionId);

      const common = {
        schemaVersion: 1 as const,
        sessionId: leased.session.sessionId,
        taskId: leased.task.taskId,
        expectedRevision: leased.revision,
        idempotencyKey: "worker-composition-ack",
      };
      let revision = await transport.acknowledge(leased.lease.leaseId, common);
      const targetScope = {
        schemaVersion: 1 as const,
        kind: "workspace" as const,
        normalizedTarget: "server.properties",
      };
      const invocation: ToolInvocation = {
        schemaVersion: 1,
        invocationId: "worker-composition-invocation",
        sessionId: leased.session.sessionId,
        toolId: "workspace.write",
        capability: "workspace.write",
        targetScope,
        arguments: { path: "server.properties", content: "motd=New message\n" },
        requestedAt: NOW,
      };
      const invocationDigest = await createInvocationDigest(invocation);
      const summary = await createProposedInvocationSummary(invocation, "destructive");
      const invocationSummaryDigest = await createInvocationSummaryDigest(summary);
      revision = await transport.publishEvents(leased.lease.leaseId, {
        ...common,
        expectedRevision: revision,
        idempotencyKey: "worker-composition-proposal",
        drafts: [
          {
            schemaVersion: 1,
            draftId: "worker-composition-proposal-draft",
            ordinal: 1,
            timestamp: NOW,
            kind: "tool-proposal",
            payload: {
              invocationId: invocation.invocationId,
              invocationDigest,
              invocationSummaryDigest,
              toolId: invocation.toolId,
              capability: invocation.capability,
              targetScope,
              risk: "destructive",
              sanitizedArguments: summary.sanitizedArguments,
            },
          },
        ],
      });
      const approval: AgentApproval = {
        schemaVersion: 1,
        approvalId: "worker-composition-approval",
        actorId,
        sessionId: leased.session.sessionId,
        policyId: leased.policySnapshot.policyId,
        policyRevision: leased.policySnapshot.revision,
        invocationDigest,
        invocationSummary: summary,
        invocationSummaryDigest,
        scope: {
          schemaVersion: 1,
          kind: "single-invocation",
          capability: "workspace.write",
          targetScope,
          risk: "destructive",
        },
        expiresAt: "2026-09-09T13:00:00.000Z",
        decision: "pending",
        reason: "",
      };
      revision = await transport.publishApproval(leased.lease.leaseId, {
        ...common,
        expectedRevision: revision,
        idempotencyKey: "worker-composition-approval-publication",
        approval,
      });
      const approved = await request<{ revision: number }>(origin, "/fixture/approve", {
        actorId,
        sessionId: leased.session.sessionId,
        approvalId: approval.approvalId,
        request: {
          schemaVersion: 1,
          expectedRevision: revision,
          idempotencyKey: "worker-composition-operator-approval",
          decision: "approve",
          reason: "Approve this exact local fixture invocation.",
        },
      });
      revision = approved.revision;
      await transport.authorizeInvocation(leased.lease.leaseId, {
        ...common,
        expectedRevision: revision,
        idempotencyKey: "worker-composition-authorize",
        authorizationId: "worker-composition-authorization",
        invocationId: invocation.invocationId,
        invocationDigest,
        approvalId: approval.approvalId,
        capability: invocation.capability,
        targetScope,
        risk: "destructive",
      });
      const runningRevision = await transport.publishStatus(leased.lease.leaseId, {
        ...common,
        expectedRevision: revision + 1,
        idempotencyKey: "worker-composition-resume",
        status: "running",
        reason: "Operator approval resumed the exact task.",
      });
      const result = {
        schemaVersion: 1 as const,
        invocationId: invocation.invocationId,
        status: "failed" as const,
        completedAt: NOW,
        summary: "Fixture-signed terminal receipt only; no executor effect was run.",
        output: { code: "fixture-receipt-only", executorEffect: false },
        evidence: [],
      };
      const digest = resultDigest(result);
      const unsignedReceipt: Omit<BackupTerminalReceipt, "signature"> = {
        schemaVersion: 1,
        source: "executor-journal",
        proofKind: "terminal",
        outcome: "failed",
        executorKeyId: receiptKeyId,
        executorKeyEpoch: 1,
        executorEpoch: "worker-composition-epoch",
        runtimeId: RUNTIME_ID,
        leaseId: leased.lease.leaseId,
        leaseGeneration: leased.lease.generation,
        sessionId: leased.session.sessionId,
        taskId: leased.task.taskId,
        invocationId: invocation.invocationId,
        invocationDigest,
        resultDigest: digest,
        journalSequence: 1,
        completedAt: NOW,
      };
      const terminalReceipt: BackupTerminalReceipt = {
        ...unsignedReceipt,
        signature: sign(
          null,
          Buffer.from(executorReceiptSignedContent(unsignedReceipt)),
          receiptKeys.privateKey
        ).toString("base64url"),
      };
      const recovery: RuntimeRecoveryPublicationRequest = {
        schemaVersion: 1,
        sessionId: leased.session.sessionId,
        taskId: leased.task.taskId,
        runtimeId: RUNTIME_ID,
        leaseId: leased.lease.leaseId,
        leaseGeneration: leased.lease.generation,
        invocationId: invocation.invocationId,
        invocationDigest,
        journalSequence: 1,
        resultDigest: digest,
        result,
        terminalReceipt,
        taskDisposition: "continue",
        idempotencyKey: "worker-composition-recovery",
      };
      const published = await transport.publishRecovery(leased.lease.leaseId, recovery);
      const duplicate = await transport.publishRecovery(leased.lease.leaseId, recovery);
      expect(published.event.eventId).toBe(duplicate.event.eventId);
      expect(published.acknowledgementAuthorization).toEqual(
        expect.objectContaining({ taskDisposition: "continue", outcome: "failed" })
      );

      const stored = await request<
        Awaited<ReturnType<import("@/lib/agent/state").AgentSessionStateStore["getSession"]>>
      >(origin, "/fixture/read", { sessionId: leased.session.sessionId });
      expect(stored?.revision).toBe(runningRevision + 1);
      expect(stored?.session.status).toBe("running");
      expect(stored?.tasks[0]?.status).toBe("running");
      expect(stored?.tasks[0]?.runtimeRecoveries).toEqual([
        expect.objectContaining({ taskDisposition: "continue", outcome: "failed" }),
      ]);
      const replay = await request<{ events: AgentEvent[]; cursor: string; truncated: boolean }>(
        origin,
        "/fixture/replay",
        {
          sessionId: leased.session.sessionId,
        }
      );
      expect(replay.truncated).toBe(false);
      expect(replay.events.filter((event) => event.kind === "tool-result")).toHaveLength(1);
      expect(replay.events.map((event) => event.kind)).toEqual(["tool-proposal", "tool-result"]);
      const replayFromCursor = await request<{ events: AgentEvent[] }>(origin, "/fixture/replay", {
        sessionId: leased.session.sessionId,
        afterCursor: replay.events[0].replayCursor,
      });
      expect(replayFromCursor.events.map((event) => event.eventId)).toEqual([published.event.eventId]);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
    } finally {
      await terminateProcessGroup(child);
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 60_000);
});
