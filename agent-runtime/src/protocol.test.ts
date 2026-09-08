import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type { AgentApproval, TerminalPublicationAuthorization, ToolResult } from "@/lib/agent/contracts";
import { type ExecuteInvocationRequest, IndeterminateHostEffectError } from "@/lib/agent/executor";
import {
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
} from "@/lib/agent/policy";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { signBackupFenceAuthorization } from "@/lib/agent/runtime/backup-fence";
import { terminalPublicationSignedContent } from "@/lib/agent/runtime/terminal-publication";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayDownloadRelayClient, GatewayDownloadRelayServer } from "./download-relay";
import {
  ExecutorProtocolClient,
  ExecutorProtocolServer as RuntimeExecutorProtocolServer,
  systemdSocketActivationFd,
} from "./protocol";

const roots: string[] = [];
const JOURNAL_KEY = Buffer.alloc(32, 0x5a);
const RECEIPT_KEYS = generateKeyPairSync("ed25519");
const CONTROL_KEYS = generateKeyPairSync("ed25519");
const RECEIPT_KEY_ID = `executor-receipt-${createHash("sha256")
  .update(RECEIPT_KEYS.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")}`;

class ExecutorProtocolServer extends RuntimeExecutorProtocolServer {
  constructor(
    options: Omit<
      ConstructorParameters<typeof RuntimeExecutorProtocolServer>[0],
      "journalAuthenticationKey" | "executorReceiptPrivateKey" | "executorReceiptKeyId" | "executorEpoch"
    > & {
      journalAuthenticationKey?: Uint8Array;
      executorReceiptPrivateKey?: ConstructorParameters<
        typeof RuntimeExecutorProtocolServer
      >[0]["executorReceiptPrivateKey"];
      executorReceiptKeyId?: string;
      executorEpoch?: string;
    }
  ) {
    super({
      ...options,
      journalAuthenticationKey: options.journalAuthenticationKey ?? JOURNAL_KEY,
      executorReceiptPrivateKey: options.executorReceiptPrivateKey ?? RECEIPT_KEYS.privateKey,
      executorReceiptKeyId: options.executorReceiptKeyId ?? RECEIPT_KEY_ID,
      executorEpoch: options.executorEpoch ?? "test-executor-epoch",
      backupFencePublicKey: options.backupFencePublicKey ?? CONTROL_KEYS.publicKey,
    });
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-"));
  roots.push(root);
  return path.join(root, "executor.sock");
}

function journalPath(socket: string): string {
  return path.join(path.dirname(socket), "executor-effect-journal.json");
}

async function irrelevantApproval(input: ExecuteInvocationRequest): Promise<AgentApproval> {
  const invocationDigest = await createInvocationDigest(input.invocation);
  const invocationSummary = await createProposedInvocationSummary(input.invocation, "low");
  return {
    schemaVersion: 1,
    approvalId: "approval-added-on-replay",
    actorId: input.actorId,
    sessionId: input.invocation.sessionId,
    policyId: input.policy.policyId,
    policyRevision: input.policy.revision,
    invocationDigest,
    invocationSummary,
    invocationSummaryDigest: await createInvocationSummaryDigest(invocationSummary),
    scope: {
      schemaVersion: 1,
      kind: "session-capability",
      capability: input.invocation.capability,
      targetScope: input.invocation.targetScope,
      risk: "low",
    },
    expiresAt: "2099-09-02T12:15:00.000Z",
    decision: "approved",
    reason: "unrelated changed approval set",
    decidedAt: "2099-09-02T12:00:00.000Z",
  };
}

async function backupProceedRequest(): Promise<ExecuteInvocationRequest> {
  const input = request();
  input.invocation = {
    ...input.invocation,
    invocationId: "invocation-backup-proceed",
    toolId: "workspace.write",
    capability: "workspace.write",
    arguments: { path: "server.properties", content: "motd=Safe" },
  };
  const invocationDigest = await createInvocationDigest(input.invocation);
  const invocationSummary = await createProposedInvocationSummary(input.invocation, "risky", {
    backupFailureStatus: "failed",
  });
  const consumedAt = "2026-09-02T12:00:00.500Z";
  const approval: AgentApproval = {
    schemaVersion: 1,
    approvalId: "backup-proceed-approval",
    actorId: input.actorId,
    sessionId: input.invocation.sessionId,
    policyId: input.policy.policyId,
    policyRevision: input.policy.revision,
    invocationDigest,
    invocationSummary,
    invocationSummaryDigest: await createInvocationSummaryDigest(invocationSummary),
    scope: {
      schemaVersion: 1,
      kind: "single-invocation",
      capability: "backup.create",
      targetScope: input.invocation.targetScope,
      risk: "risky",
    },
    expiresAt: "2099-09-02T12:15:00.000Z",
    decision: "approved",
    reason: "proceed after backup failure",
    decidedAt: "2026-09-02T12:00:00.000Z",
    consumedAt,
  };
  input.approvals = [approval];
  input.backupAuthorization = {
    schemaVersion: 1,
    invocationDigest,
    status: "proceed-without-backup",
    approvalId: approval.approvalId,
    consumedAt,
  };
  return input;
}

function request(): ExecuteInvocationRequest {
  return {
    actorId: "actor-runtime",
    invocation: {
      schemaVersion: 1,
      invocationId: "invocation-protocol",
      sessionId: "session-runtime",
      toolId: "workspace.read",
      capability: "workspace.read",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: { path: "server.properties" },
      requestedAt: "2026-09-02T12:00:00.000Z",
    },
    policy: createPolicyFromPreset("autopilot", "protocol-policy"),
    approvals: [],
    runtimeContext: {
      runtimeId: "runtime-protocol",
      leaseId: "lease-protocol",
      leaseGeneration: 1,
      taskId: "task-protocol",
    },
  };
}

function successfulResult(invocationId: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "succeeded",
    completedAt: "2026-09-02T12:00:01.000Z",
    summary: "committed",
    output: { committed: true },
    evidence: [],
  };
}

async function terminalPublicationAuthorization(
  client: ExecutorProtocolClient,
  input: ExecuteInvocationRequest,
  result: ToolResult
): Promise<TerminalPublicationAuthorization> {
  const receipt = await client.terminalReceiptFor(input, result);
  if (!receipt) throw new Error("test terminal receipt is missing");
  const unsigned = {
    schemaVersion: 1 as const,
    source: "control-plane-terminal-publication" as const,
    runtimeId: receipt.runtimeId,
    sessionId: receipt.sessionId,
    taskId: receipt.taskId,
    leaseId: receipt.leaseId,
    leaseGeneration: receipt.leaseGeneration,
    invocationId: receipt.invocationId,
    invocationDigest: receipt.invocationDigest,
    journalSequence: receipt.journalSequence,
    resultDigest: receipt.resultDigest,
    terminalReceiptDigest: createHash("sha256")
      .update(canonicalJson(receipt as never))
      .digest("hex"),
    outcome: receipt.outcome as "committed" | "failed" | "cancelled",
    taskStatus: receipt.outcome === "committed" ? ("completed" as const) : ("failed" as const),
    sessionStatus: receipt.outcome === "committed" ? ("idle" as const) : ("failed" as const),
    publicationRevision: 1,
    publishedAt: receipt.completedAt,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(terminalPublicationSignedContent(unsigned)),
      process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8
        ? createPrivateKey({
            key: Buffer.from(process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8, "base64"),
            format: "der",
            type: "pkcs8",
          })
        : CONTROL_KEYS.privateKey
    ).toString("base64url"),
  };
}

function downloadRequest(): ExecuteInvocationRequest {
  const value = request();
  value.invocation = {
    ...value.invocation,
    invocationId: "invocation-download-retry",
    toolId: "network.download",
    capability: "network.outbound",
    targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "plugin.jar" },
    arguments: {
      url: "https://downloads.example.invalid/plugin.jar",
      destination: "plugin.jar",
      maxBytes: 1024,
      timeoutMs: 5000,
      expectedSha256: "938ddacda7bef74499ab2db1e009d235c61b88c598789d7deebb03b4c0a64d94",
      expectedBytes: 14,
    },
  };
  return value;
}

function consoleRequest(): ExecuteInvocationRequest {
  const value = request();
  value.invocation = {
    ...value.invocation,
    invocationId: "invocation-console-dispatch",
    toolId: "console.execute",
    capability: "console.execute",
    targetScope: { schemaVersion: 1, kind: "console", normalizedTarget: "server" },
    arguments: { command: "list", timeoutMs: 1_000 },
  };
  return value;
}

describe("authenticated executor Unix protocol", () => {
  it("requires exactly one correctly named systemd activation descriptor", () => {
    expect(
      systemdSocketActivationFd("executor", { LISTEN_PID: "42", LISTEN_FDS: "1", LISTEN_FDNAMES: "executor" }, 42)
    ).toBe(3);
    expect(() =>
      systemdSocketActivationFd("executor", { LISTEN_PID: "42", LISTEN_FDS: "1", LISTEN_FDNAMES: "other" }, 42)
    ).toThrow(/exactly one named/i);
    expect(() =>
      systemdSocketActivationFd("executor", { LISTEN_PID: "42", LISTEN_FDS: "2", LISTEN_FDNAMES: "executor" }, 42)
    ).toThrow(/exactly one named/i);
  });

  it("accepts only a control-plane-signed exact backup fence and rejects gateway widening before execution", async () => {
    const socket = await socketPath();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let executions = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: gatewayKeys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      statePath: journalPath(socket),
      executorReceiptKeyEpoch: 1,
      executor: {
        async execute(input): Promise<ToolResult> {
          executions += 1;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: new Date().toISOString(),
            summary: "authorized",
            output: {},
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: gatewayKeys.privateKey });
    const input = request();
    const digest = await createInvocationDigest(input.invocation);
    const authorization = await signBackupFenceAuthorization({
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "fence-protocol",
      runtimeId: "runtime-protocol",
      leaseId: input.runtimeContext!.leaseId,
      leaseGeneration: input.runtimeContext!.leaseGeneration,
      sessionId: input.invocation.sessionId,
      taskId: input.runtimeContext!.taskId,
      invocationId: input.invocation.invocationId,
      invocationDigest: digest,
      backupId: "backup-protocol",
      lifecycleLockId: "lock-protocol",
      lifecycleFencingToken: 1,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      executorKeyId: RECEIPT_KEY_ID,
      executorKeyEpoch: 1,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    input.backupAuthorization = { ...authorization, taskId: "task-widened-by-gateway" };
    await expect(client.execute(input)).rejects.toThrow(/failed closed/i);
    expect(executions).toBe(0);
    input.backupAuthorization = authorization;
    const result = await client.execute(input);
    expect(result).toMatchObject({ status: "succeeded" });
    await expect(client.terminalReceiptFor(input, result)).resolves.toMatchObject({
      source: "executor-journal",
      outcome: "committed",
      proofKind: "terminal",
      executorKeyId: RECEIPT_KEY_ID,
      executorKeyEpoch: 1,
      executorEpoch: "test-executor-epoch",
      backupId: authorization.backupId,
      lifecycleLeaseGeneration: authorization.lifecycleLeaseGeneration,
      journalSequence: expect.any(Number),
      completedAt: expect.any(String),
      signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
    });
    expect(executions).toBe(1);
    await server.close();
  });

  it("rejects a current fence authorized for a retired receipt key before any host effect", async () => {
    const socket = await socketPath();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let executions = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: gatewayKeys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      executorReceiptKeyId: RECEIPT_KEY_ID,
      executorReceiptKeyEpoch: 2,
      statePath: journalPath(socket),
      executor: {
        async execute(): Promise<ToolResult> {
          executions += 1;
          throw new Error("retired-key fence must not execute");
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: gatewayKeys.privateKey });
      const input = request();
      input.backupAuthorization = await signBackupFenceAuthorization({
        schemaVersion: 1,
        status: "succeeded",
        authorizationId: "fence-retired-key",
        runtimeId: "runtime-protocol",
        leaseId: input.runtimeContext!.leaseId,
        leaseGeneration: input.runtimeContext!.leaseGeneration,
        sessionId: input.invocation.sessionId,
        taskId: input.runtimeContext!.taskId,
        invocationId: input.invocation.invocationId,
        invocationDigest: await createInvocationDigest(input.invocation),
        backupId: "backup-retired-key",
        lifecycleLockId: "lock-retired-key",
        lifecycleFencingToken: 1,
        lifecycleLeaseGeneration: 1,
        lifecycleLeaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        executorKeyId: "executor-receipt-retired",
        executorKeyEpoch: 1,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await expect(client.execute(input)).rejects.toThrow(/failed closed/i);
      expect(executions).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("recovers a released-but-unpublished terminal result with its retained old receipt after key rotation", async () => {
    const socket = await socketPath();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const oldReceiptKeys = generateKeyPairSync("ed25519");
    const newReceiptKeys = generateKeyPairSync("ed25519");
    const oldReceiptKeyId = `executor-receipt-old-${createHash("sha256")
      .update(oldReceiptKeys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`;
    const newReceiptKeyId = `executor-receipt-new-${createHash("sha256")
      .update(newReceiptKeys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`;
    let executions = 0;
    const firstServer = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: gatewayKeys.publicKey,
      statePath: journalPath(socket),
      executorReceiptPrivateKey: oldReceiptKeys.privateKey,
      executorReceiptKeyId: oldReceiptKeyId,
      executorReceiptKeyEpoch: 1,
      dropCommittedResponse: () => true,
      executor: {
        async execute(input): Promise<ToolResult> {
          executions += 1;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "committed before response loss",
            output: { executions },
            evidence: [],
          };
        },
      },
    });
    await firstServer.listen();
    const client = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: gatewayKeys.privateKey,
      reconciliationAttempts: 1,
      reconciliationDelayMs: 1,
    });
    const input = request();
    try {
      await expect(client.execute(input)).resolves.toMatchObject({ status: "indeterminate" });
      expect(executions).toBe(1);
    } finally {
      await firstServer.close();
    }

    const rotatedServer = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: gatewayKeys.publicKey,
      statePath: journalPath(socket),
      executorReceiptPrivateKey: newReceiptKeys.privateKey,
      executorReceiptKeyId: newReceiptKeyId,
      executorReceiptKeyEpoch: 2,
      executor: {
        async execute(): Promise<ToolResult> {
          executions += 1;
          throw new Error("recovery must not execute the host effect twice");
        },
      },
    });
    await rotatedServer.listen();
    try {
      const recovered = await client.execute(input);
      expect(recovered).toMatchObject({ status: "succeeded", output: { executions: 1 } });
      await expect(client.terminalReceiptFor(input, recovered)).resolves.toMatchObject({
        executorKeyId: oldReceiptKeyId,
        executorKeyEpoch: 1,
      });
      expect(executions).toBe(1);
    } finally {
      await rotatedServer.close();
    }
  });

  it("prevents a not-yet-entered commit after renewable fence ownership is lost", async () => {
    const socket = await socketPath();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredCommit = 0;
    let invocationStarted = false;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: gatewayKeys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      statePath: journalPath(socket),
      executor: {
        async execute(input): Promise<ToolResult> {
          invocationStarted = true;
          await blocked;
          await input.assertCommitAllowed?.();
          enteredCommit++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: new Date().toISOString(),
            summary: "committed",
            output: {},
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: gatewayKeys.privateKey });
      const input = request();
      const now = Date.now();
      input.backupAuthorization = await signBackupFenceAuthorization({
        schemaVersion: 1,
        status: "succeeded",
        authorizationId: "fence-ownership-loss",
        runtimeId: "runtime-protocol",
        leaseId: input.runtimeContext!.leaseId,
        leaseGeneration: input.runtimeContext!.leaseGeneration,
        sessionId: input.invocation.sessionId,
        taskId: input.runtimeContext!.taskId,
        invocationId: input.invocation.invocationId,
        invocationDigest: await createInvocationDigest(input.invocation),
        backupId: "backup-ownership-loss",
        lifecycleLockId: "lock-ownership-loss",
        lifecycleFencingToken: 17,
        lifecycleLeaseGeneration: 3,
        lifecycleLeaseExpiresAt: new Date(now + 60 * 60_000).toISOString(),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
      const running = client.execute(input);
      await vi.waitFor(() => expect(invocationStarted).toBe(true));
      await client.revokeFence(input.invocation.invocationId, input.runtimeContext);
      release?.();

      await expect(running).resolves.toMatchObject({ status: "indeterminate" });
      expect(enteredCommit).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("deduplicates an exact invocation and never includes gateway canaries in executor requests or output", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    const seen: ExecuteInvocationRequest[] = [];
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          effects++;
          seen.push(input);
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "read completed",
            output: { safe: true },
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const gatewayCanary = "gateway-runtime-and-provider-secret-canary";
      process.env.MC_AGENT_RUNTIME_TOKEN = gatewayCanary;
      const first = await client.execute(request());
      const retry = await client.execute(request());
      expect(retry).toEqual(first);
      expect(effects).toBe(1);
      expect(JSON.stringify(seen)).not.toContain(gatewayCanary);
      expect(JSON.stringify(first)).not.toContain(gatewayCanary);
      expect(seen[0].signal).toBeInstanceOf(AbortSignal);
      expect("env" in seen[0]).toBe(false);
    } finally {
      process.env.MC_AGENT_RUNTIME_TOKEN = undefined;
      await server.close();
    }
  });

  it("retries an ask-once grant only after authoritative invocation authorization without repeating a host effect", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input): Promise<ToolResult> {
          const digest = await createInvocationDigest(input.invocation);
          if (!input.approvalAuthorization) {
            return {
              schemaVersion: 1,
              invocationId: input.invocation.invocationId,
              status: "failed",
              completedAt: "2026-09-02T12:00:00.500Z",
              summary: "Invocation authorization required.",
              output: { code: "invocation-authorization-required", invocationDigest: digest },
              evidence: [],
            };
          }
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "authorized effect",
            output: { effects },
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const input = request();
      const approval = await irrelevantApproval(input);
      input.approvals = [approval];
      const waiting = await client.execute(input);
      expect(waiting).toMatchObject({ output: { code: "invocation-authorization-required" } });
      expect(effects).toBe(0);

      const digest = await createInvocationDigest(input.invocation);
      const authorized = structuredClone(input);
      authorized.approvalAuthorization = {
        schemaVersion: 1,
        authorizationId: "authorization-ask-once",
        runtimeId: "runtime-protocol",
        leaseId: input.runtimeContext!.leaseId,
        leaseGeneration: input.runtimeContext!.leaseGeneration,
        taskId: input.runtimeContext!.taskId,
        sessionId: input.invocation.sessionId,
        actorId: input.actorId,
        policyId: input.policy.policyId,
        policyRevision: input.policy.revision,
        invocationId: input.invocation.invocationId,
        invocationDigest: digest,
        approvalId: approval.approvalId,
        approvalKind: "ask-once",
        capability: input.invocation.capability,
        targetScope: input.invocation.targetScope,
        risk: "low",
        issuedAt: "2026-09-02T12:00:00.750Z",
        expiresAt: "2099-09-02T12:15:00.000Z",
      };
      const behaviorChanged = structuredClone(authorized);
      behaviorChanged.policy.revision += 1;
      behaviorChanged.approvalAuthorization!.policyRevision += 1;
      await expect(client.execute(behaviorChanged)).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(0);
      const approvalsChanged = structuredClone(authorized);
      approvalsChanged.approvals[0].reason = "Changed authorization context.";
      await expect(client.execute(approvalsChanged)).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(0);
      const completed = await client.execute(authorized);
      await expect(client.execute(authorized)).resolves.toStrictEqual(completed);
      expect(effects).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("scopes committed invocation journal entries to continuation task and lease generation", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    const observed: Array<{ requestId: string; body: unknown }> = [];
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "task-scoped effect",
            output: { effects },
            evidence: [],
          };
        },
      },
      observeAuthenticatedRequest: (request) => observed.push(request),
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const first = request();
      const firstResult = await client.execute(first);
      await expect(client.execute(first)).resolves.toStrictEqual(firstResult);
      expect(observed.some((item) => (item.body as { command?: unknown }).command === "acknowledge-terminal")).toBe(
        false
      );
      await client.completeReconciliation(
        first.invocation.invocationId,
        first.runtimeContext,
        await terminalPublicationAuthorization(client, first, firstResult)
      );
      expect(observed.at(-1)).toMatchObject({
        body: {
          command: "acknowledge-terminal",
          payload: {
            invocationId: first.invocation.invocationId,
            invocationDigest: await createInvocationDigest(first.invocation),
            taskId: first.runtimeContext?.taskId,
            leaseGeneration: first.runtimeContext?.leaseGeneration,
            journalSequence: expect.any(Number),
            resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      const continuation = request();
      continuation.runtimeContext = {
        runtimeId: "runtime-protocol",
        leaseId: "lease-continuation",
        leaseGeneration: 1,
        taskId: "task-continuation",
      };
      const continuationResult = await client.execute(continuation);
      expect(continuationResult.output).toEqual({ effects: 2 });
      await expect(client.execute(continuation)).resolves.toStrictEqual(continuationResult);
      await client.completeReconciliation(
        continuation.invocation.invocationId,
        continuation.runtimeContext,
        await terminalPublicationAuthorization(client, continuation, continuationResult)
      );
      expect(effects).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("rejects a client that cannot authenticate with the pinned gateway public key", async () => {
    const socket = await socketPath();
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: trusted.publicKey,
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "unexpected",
            output: null,
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: attacker.privateKey });
      await expect(client.execute(request())).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("returns the original committed result after executor restart and rejects changed invocation fingerprints", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const executor = {
      async execute(input: ExecuteInvocationRequest) {
        effects++;
        return {
          schemaVersion: 1 as const,
          invocationId: input.invocation.invocationId,
          status: "succeeded" as const,
          completedAt: "2026-09-02T12:00:01.000Z",
          summary: "committed once",
          output: { effects },
          evidence: [],
        };
      },
    };
    const firstServer = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
    });
    await firstServer.listen();
    const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
    const first = await client.execute(request());
    await firstServer.close();

    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
    });
    await restarted.listen();
    try {
      await expect(client.execute(request())).resolves.toStrictEqual(first);
      const changedInvocation = request();
      changedInvocation.invocation.arguments = { path: "different.properties" };
      await expect(client.execute(changedInvocation)).rejects.toThrow(/failed closed/i);
      const changedApprovals = request();
      changedApprovals.approvals = [await irrelevantApproval(changedApprovals)];
      await expect(client.execute(changedApprovals)).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it("backs off across RestartSec and queries the durable exact result after reconnect", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const keys = generateKeyPairSync("ed25519");
    const observed: Array<{ requestId: string; body: unknown }> = [];
    let effects = 0;
    const executor = {
      async execute(input: ExecuteInvocationRequest) {
        effects++;
        return {
          schemaVersion: 1 as const,
          invocationId: input.invocation.invocationId,
          status: "succeeded" as const,
          completedAt: "2026-09-02T12:00:01.000Z",
          summary: "committed before restart",
          output: { effects },
          evidence: [],
        };
      },
    };
    const first = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
      dropCommittedResponse: () => true,
      observeAuthenticatedRequest: (request) => observed.push(request),
    });
    await first.listen();
    let restarted: ExecutorProtocolServer | undefined;
    const delays: number[] = [];
    const client = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 3,
      responseTimeoutMs: 100,
      reconciliationDelayMs: 1_100,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 1) await first.close();
        if (delays.reduce((sum, value) => sum + value, 0) >= 2_000 && !restarted) {
          restarted = new ExecutorProtocolServer({
            socketPath: socket,
            statePath,
            gatewayPublicKey: keys.publicKey,
            executor,
            observeAuthenticatedRequest: (request) => observed.push(request),
          });
          await restarted.listen();
        }
      },
    });
    try {
      await expect(client.execute(request())).resolves.toMatchObject({
        status: "succeeded",
        summary: "committed before restart",
      });
      expect(delays).toEqual([1_100, 2_200]);
      expect(effects).toBe(1);
      const firstExecute = observed.find((item) => (item.body as { command?: unknown }).command === "execute");
      expect(observed.at(-1)).toMatchObject({
        body: expect.objectContaining({
          command: "reconcile",
          payload: (firstExecute?.body as { payload: unknown }).payload,
        }),
      });
    } finally {
      await restarted?.close();
      await first.close();
    }
  });

  it("persists an uncertain console dispatch across process restart instead of executing it twice", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const crashing = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute() {
          effects++;
          throw new IndeterminateHostEffectError("console-dispatch");
        },
      },
    });
    await crashing.listen();
    const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
    const uncertain = await client.execute(consoleRequest());
    expect(uncertain).toMatchObject({
      status: "indeterminate",
      output: { code: "indeterminate-effect", commitPoint: "console-dispatch" },
    });
    await crashing.close();

    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute() {
          effects++;
          throw new Error("must remain fenced");
        },
      },
    });
    await restarted.listen();
    try {
      await expect(client.execute(consoleRequest())).resolves.toStrictEqual(uncertain);
      expect(effects).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it("makes a backup-failure proceed authorization single-use even when approvals change", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "proceed effect committed",
            output: { effects },
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const approved = await backupProceedRequest();
      const first = await client.execute(approved);
      await expect(client.execute(approved)).resolves.toStrictEqual(first);
      const changed = structuredClone(approved);
      changed.approvals.push(await irrelevantApproval(request()));
      await expect(client.execute(changed)).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("replays a committed download after a lost response without a second upstream GET", async () => {
    const socket = await socketPath();
    const relaySocket = path.join(path.dirname(socket), "download.sock");
    const statePath = journalPath(socket);
    const keys = generateKeyPairSync("ed25519");
    let gets = 0;
    const relayServer = new GatewayDownloadRelayServer({
      socketPath: relaySocket,
      gatewayPrivateKey: keys.privateKey,
      transport: {
        async fetchWithMetadata(input) {
          gets++;
          return {
            response: new Response("download bytes", {
              status: 200,
              headers: { "content-type": "application/octet-stream", "content-length": "14" },
            }),
            finalUrl: new URL(String(input)),
          };
        },
      },
    });
    await relayServer.listen();
    const relayClient = new GatewayDownloadRelayClient({ socketPath: relaySocket, gatewayPublicKey: keys.publicKey });
    const executor = {
      async execute(input: ExecuteInvocationRequest) {
        if (!input.downloadAuthorization) throw new Error("missing relay authorization");
        const chunks: Uint8Array[] = [];
        const relayed = await relayClient.download(
          input.downloadAuthorization,
          input.signal ?? new AbortController().signal,
          async (chunk) => void chunks.push(chunk)
        );
        return {
          schemaVersion: 1 as const,
          invocationId: input.invocation.invocationId,
          status: "succeeded" as const,
          completedAt: "2026-09-02T12:00:01.000Z",
          summary: "download committed",
          output: { bytes: Buffer.concat(chunks).byteLength, sha256: relayed.contentDigest },
          evidence: [],
        };
      },
    };
    let loseResponse = true;
    const observedRequests: Array<{ requestId: string; body: unknown }> = [];
    const firstServer = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
      observeAuthenticatedRequest: (observed) => observedRequests.push(observed),
      dropCommittedResponse: () => {
        if (loseResponse) {
          loseResponse = false;
          return true;
        }
        return false;
      },
    });
    await firstServer.listen();
    const client = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      downloadRelay: relayServer,
    });
    const recovered = await client.execute(downloadRequest());
    expect(recovered).toMatchObject({ status: "succeeded", output: { bytes: 14 } });
    expect(gets).toBe(1);
    expect(observedRequests).toHaveLength(3);
    expect(observedRequests[2]).toMatchObject({
      body: expect.objectContaining({
        command: "reconcile",
        payload: (observedRequests[1]?.body as { payload: unknown }).payload,
      }),
    });
    await firstServer.close();

    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
    });
    await restarted.listen();
    try {
      await expect(client.execute(downloadRequest())).resolves.toMatchObject({
        status: "succeeded",
        output: { bytes: 14, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      expect(gets).toBe(1);
    } finally {
      await restarted.close();
      await relayServer.close();
    }
  });

  it("durably refuses an invocation cancelled before registration, including after restart", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const executor = {
      async execute(input: ExecuteInvocationRequest) {
        effects++;
        return {
          schemaVersion: 1 as const,
          invocationId: input.invocation.invocationId,
          status: "succeeded" as const,
          completedAt: "2026-09-02T12:00:01.000Z",
          summary: "must not execute",
          output: null,
          evidence: [],
        };
      },
    };
    const first = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
    });
    await first.listen();
    const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
    await client.cancel(request().invocation.invocationId, request().runtimeContext);
    const cancelled = await client.execute(request());
    expect(cancelled.status).toBe("cancelled");
    expect(effects).toBe(0);
    await first.close();

    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executor,
    });
    await restarted.listen();
    try {
      await expect(client.execute(request())).resolves.toStrictEqual(cancelled);
      expect(effects).toBe(0);
    } finally {
      await restarted.close();
    }
  });

  it("registers cancellation before asynchronous journal work can allow an effect", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    let releaseBegin: (() => void) | undefined;
    let markBeginHeld: (() => void) | undefined;
    const beginHeld = new Promise<void>((resolve) => {
      markBeginHeld = resolve;
    });
    const beginRelease = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      beforeJournalBegin: async () => {
        markBeginHeld?.();
        await beginRelease;
      },
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "must not execute",
            output: null,
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const running = client.execute(request());
      await beginHeld;
      await client.cancel(request().invocation.invocationId, request().runtimeContext);
      releaseBegin?.();
      await expect(running).resolves.toMatchObject({ status: "cancelled" });
      expect(effects).toBe(0);
    } finally {
      releaseBegin?.();
      await server.close();
    }
  });

  it("preserves committed success when cancellation races with the executor response", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          markStarted?.();
          await new Promise<void>((resolve) =>
            input.signal?.addEventListener("abort", () => resolve(), { once: true })
          );
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "mutation committed",
            output: { committed: true },
            evidence: [],
            mutationCommit: { committed: true as const, point: "atomic-rename" as const },
          };
        },
      },
    });
    await server.listen();
    try {
      const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      const running = client.execute(request());
      await started;
      await client.cancel(request().invocation.invocationId, request().runtimeContext);
      await expect(running).resolves.toMatchObject({
        status: "succeeded",
        mutationCommit: { committed: true, point: "atomic-rename" },
      });
      await expect(client.execute(request())).resolves.toMatchObject({ status: "succeeded" });
    } finally {
      await server.close();
    }
  });

  it("reconciles a socket timeout during a long pre-commit delete to the authoritative committed result", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let releaseEffect: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      executor: {
        async execute(input) {
          markStarted?.();
          await held;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "delete committed",
            output: { committed: true },
            evidence: [],
            mutationCommit: { committed: true as const, point: "atomic-rename" as const },
          };
        },
      },
    });
    await server.listen();
    const input = request();
    input.invocation = {
      ...input.invocation,
      invocationId: "invocation-long-delete",
      toolId: "workspace.delete",
      capability: "workspace.delete",
      arguments: { path: "server.properties", recursive: false },
    };
    const digest = await createInvocationDigest(input.invocation);
    input.backupAuthorization = await signBackupFenceAuthorization({
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "fence-long-delete",
      runtimeId: "runtime-protocol",
      leaseId: input.runtimeContext!.leaseId,
      leaseGeneration: input.runtimeContext!.leaseGeneration,
      sessionId: input.invocation.sessionId,
      taskId: input.runtimeContext!.taskId,
      invocationId: input.invocation.invocationId,
      invocationDigest: digest,
      backupId: "backup-long-delete",
      lifecycleLockId: "lock-long-delete",
      lifecycleFencingToken: 2,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const delays: number[] = [];
    const client = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 4,
      responseTimeoutMs: 500,
      reconciliationDelayMs: 1,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 1) {
          releaseEffect?.();
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      },
    });
    try {
      const running = client.execute(input);
      await started;
      await expect(running).resolves.toMatchObject({
        status: "succeeded",
        summary: "delete committed",
        mutationCommit: { committed: true, point: "atomic-rename" },
      });
      expect(delays.length).toBeGreaterThanOrEqual(1);
    } finally {
      releaseEffect?.();
      await server.close();
    }
  });

  it("resumes persisted fence renewal after restart and never terminalizes from elapsed time", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const reconciliationStatePath = path.join(path.dirname(socket), "gateway-reconciliations.json");
    const keys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let now = new Date("2026-09-02T12:00:00.000Z");
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      now: () => now,
      executor: {
        async execute() {
          markStarted?.();
          return await new Promise<ToolResult>(() => undefined);
        },
      },
    });
    await first.listen();
    const input = request();
    input.invocation = {
      ...input.invocation,
      invocationId: "invocation-persisted-reconciliation",
      toolId: "workspace.delete",
      capability: "workspace.delete",
      arguments: { path: "server.properties", recursive: false },
    };
    const digest = await createInvocationDigest(input.invocation);
    input.backupAuthorization = await signBackupFenceAuthorization({
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "fence-persisted-reconciliation",
      runtimeId: "runtime-protocol",
      leaseId: input.runtimeContext!.leaseId,
      leaseGeneration: input.runtimeContext!.leaseGeneration,
      sessionId: input.invocation.sessionId,
      taskId: input.runtimeContext!.taskId,
      invocationId: input.invocation.invocationId,
      invocationDigest: digest,
      backupId: "backup-persisted-reconciliation",
      lifecycleLockId: "lock-persisted-reconciliation",
      lifecycleFencingToken: 3,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      issuedAt: "2026-09-02T11:59:59.000Z",
      expiresAt: "2026-09-02T12:05:00.000Z",
    });
    const firstClient = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 2,
      responseTimeoutMs: 500,
      reconciliationDelayMs: 1,
      reconciliationStatePath,
      now: () => now,
      sleep: async () => undefined,
    });
    const running = firstClient.execute(input);
    await started;
    await expect(running).resolves.toMatchObject({ status: "indeterminate" });
    await expect(firstClient.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ result: expect.objectContaining({ status: "indeterminate" }) }),
    ]);
    await first.close();

    now = new Date("2026-09-02T12:01:00.000Z");
    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      now: () => now,
      executor: {
        async execute() {
          throw new Error("reconciliation must not repeat the effect");
        },
      },
    });
    await restarted.listen();
    const restartedClient = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 2,
      responseTimeoutMs: 500,
      reconciliationDelayMs: 1,
      reconciliationStatePath,
      now: () => now,
      sleep: async () => undefined,
    });
    try {
      const { signature: _signature, ...unsignedAuthorization } = input.backupAuthorization as Extract<
        NonNullable<ExecuteInvocationRequest["backupAuthorization"]>,
        { status: "succeeded" }
      >;
      const renewedAuthorization = await signBackupFenceAuthorization({
        ...unsignedAuthorization,
        lifecycleLeaseGeneration: 2,
        lifecycleLeaseExpiresAt: "2026-09-02T13:30:00.000Z",
        issuedAt: "2026-09-02T12:01:00.000Z",
        expiresAt: "2026-09-02T12:02:00.000Z",
      });
      await restartedClient.replacePendingFence(input, renewedAuthorization);
      await expect(restartedClient.reconcilePending()).resolves.toEqual([
        expect.objectContaining({ result: expect.objectContaining({ status: "indeterminate" }) }),
      ]);
      now = new Date("2036-09-02T12:03:00.000Z");
      const reconciled = await restartedClient.reconcilePending();
      expect(reconciled).toEqual([
        expect.objectContaining({
          result: expect.objectContaining({ status: "indeterminate" }),
        }),
      ]);
    } finally {
      await restarted.close();
    }
  });

  it("replaces cached indeterminate evidence after a root-authorized clean executor epoch", async () => {
    const socket = await socketPath();
    const statePath = journalPath(socket);
    const reconciliationStatePath = path.join(path.dirname(socket), "gateway-clean-start-reconciliation.json");
    const keys = generateKeyPairSync("ed25519");
    const input = request();
    input.invocation = { ...input.invocation, invocationId: "invocation-clean-start-recovery" };
    const first = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executorEpoch: "executor-epoch-before-clean-start",
      executor: {
        async execute() {
          throw new IndeterminateHostEffectError("atomic-rename");
        },
      },
    });
    await first.listen();
    const firstClient = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 1,
      responseTimeoutMs: 500,
      reconciliationDelayMs: 1,
      reconciliationStatePath,
      sleep: async () => undefined,
    });
    const indeterminate = await firstClient.execute(input);
    expect(indeterminate.status).toBe("indeterminate");
    expect(await firstClient.terminalReceiptFor(input, indeterminate)).toMatchObject({ outcome: "indeterminate" });
    await first.close();

    const restarted = new ExecutorProtocolServer({
      socketPath: socket,
      statePath,
      gatewayPublicKey: keys.publicKey,
      executorEpoch: "executor-epoch-after-clean-start",
      executor: {
        async execute() {
          throw new Error("clean-start reconciliation must not repeat the effect");
        },
      },
    });
    await restarted.listen();
    const restartedClient = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 1,
      responseTimeoutMs: 500,
      reconciliationDelayMs: 1,
      reconciliationStatePath,
      sleep: async () => undefined,
    });
    try {
      const [recovered] = await restartedClient.reconcilePending();
      expect(recovered).toMatchObject({
        executorStatus: "terminal",
        result: {
          status: "failed",
          output: { code: "reconciliation-clean-start", noActiveEffect: true },
        },
        terminalReceipt: { proofKind: "clean-start-no-active", outcome: "failed" },
      });
      await restartedClient.completeReconciliation(
        input.invocation.invocationId,
        input.runtimeContext,
        await terminalPublicationAuthorization(restartedClient, input, recovered!.result!)
      );
      await expect(restartedClient.reconcilePending()).resolves.toEqual([]);
    } finally {
      await restarted.close();
    }
  });

  it("durably claims a backup handoff before any protocol call and dispatches it once after restart", async () => {
    const socket = await socketPath();
    const reconciliationStatePath = path.join(path.dirname(socket), "gateway-handoff.json");
    const keys = generateKeyPairSync("ed25519");
    const fenceKeys = generateKeyPairSync("ed25519");
    vi.stubEnv(
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    );
    let executions = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      backupFencePublicKey: fenceKeys.publicKey,
      executor: {
        async execute(input) {
          executions++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: new Date().toISOString(),
            summary: "one recovered effect",
            output: {},
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    const input = request();
    input.invocation = { ...input.invocation, invocationId: "invocation-prepared-handoff" };
    const first = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationStatePath,
    });
    await first.prepareBackupHandoff(input, "runtime-protocol");
    const digest = await createInvocationDigest(input.invocation);

    const afterPreparation = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationStatePath,
    });
    await expect(afterPreparation.reconcilePending()).resolves.toEqual([
      expect.objectContaining({
        state: "awaiting-backup",
        runtimeId: "runtime-protocol",
        sessionId: input.invocation.sessionId,
        taskId: input.runtimeContext!.taskId,
        leaseId: input.runtimeContext!.leaseId,
        leaseGeneration: input.runtimeContext!.leaseGeneration,
        invocationId: input.invocation.invocationId,
        invocationDigest: digest,
      }),
    ]);
    expect(executions).toBe(0);

    const authorization = await signBackupFenceAuthorization({
      schemaVersion: 1,
      status: "succeeded",
      authorizationId: "fence-prepared-handoff",
      runtimeId: "runtime-protocol",
      leaseId: input.runtimeContext!.leaseId,
      leaseGeneration: input.runtimeContext!.leaseGeneration,
      sessionId: input.invocation.sessionId,
      taskId: input.runtimeContext!.taskId,
      invocationId: input.invocation.invocationId,
      invocationDigest: digest,
      backupId: "backup-prepared-handoff",
      lifecycleLockId: "lock-prepared-handoff",
      lifecycleFencingToken: 11,
      lifecycleLeaseGeneration: 1,
      lifecycleLeaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await afterPreparation.authorizeBackupHandoff(input, authorization);

    const afterAuthorization = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationStatePath,
    });
    const [handoff] = await afterAuthorization.reconcilePending();
    expect(handoff).toMatchObject({ state: "awaiting-executor", executorStatus: "not-started" });
    expect(executions).toBe(0);
    const handoffResult = await afterAuthorization.execute(handoff!.request);
    expect(handoffResult).toMatchObject({ status: "succeeded" });
    await expect(afterAuthorization.execute(handoff!.request)).resolves.toMatchObject({ status: "succeeded" });
    expect(executions).toBe(1);
    await afterAuthorization.completeReconciliation(
      input.invocation.invocationId,
      input.runtimeContext,
      await terminalPublicationAuthorization(afterAuthorization, handoff!.request, handoffResult)
    );
    await expect(afterAuthorization.reconcilePending()).resolves.toEqual([]);
    await server.close();
  });

  it.each(["deleted", "replayed", "forged", "truncated", "wrong-key"] as const)(
    "keeps a dispatched durable handoff indeterminate when the executor journal is %s",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One table verifies every authenticated multi-file journal loss/corruption mode against the same durable handoff.
    async (failure) => {
      const socket = await socketPath();
      const statePath = journalPath(socket);
      const reconciliationStatePath = path.join(path.dirname(socket), "gateway-authenticated-handoff.json");
      const gatewayKeys = generateKeyPairSync("ed25519");
      const fenceKeys = generateKeyPairSync("ed25519");
      vi.stubEnv(
        "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
        fenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
      );
      let effects = 0;
      const first = new ExecutorProtocolServer({
        socketPath: socket,
        statePath,
        gatewayPublicKey: gatewayKeys.publicKey,
        backupFencePublicKey: fenceKeys.publicKey,
        executor: {
          async execute(input) {
            effects++;
            return {
              schemaVersion: 1,
              invocationId: input.invocation.invocationId,
              status: "succeeded",
              completedAt: new Date().toISOString(),
              summary: "authenticated commit",
              output: { effects },
              evidence: [],
            };
          },
        },
        dropCommittedResponse: (result) => result.invocationId === "invocation-authenticated-handoff",
      });
      await first.listen();
      const client = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: gatewayKeys.privateKey,
        reconciliationStatePath,
        reconciliationAttempts: 1,
        responseTimeoutMs: 500,
      });
      const seed = request();
      seed.invocation = { ...seed.invocation, invocationId: "invocation-sequence-seed" };
      const seedResult = await client.execute(seed);
      expect(seedResult).toMatchObject({ status: "succeeded" });
      await client.completeReconciliation(
        seed.invocation.invocationId,
        seed.runtimeContext,
        await terminalPublicationAuthorization(client, seed, seedResult)
      );
      const journalFiles = [
        statePath,
        `${statePath}.checkpoint.0`,
        `${statePath}.checkpoint.1`,
        `${statePath}.append.0`,
        `${statePath}.append.1`,
        `${statePath}.generation-floor`,
      ];
      const oldSnapshot = new Map<string, Buffer>();
      for (const file of journalFiles) {
        try {
          oldSnapshot.set(file, await readFile(file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      const input = request();
      input.invocation = { ...input.invocation, invocationId: "invocation-authenticated-handoff" };
      const now = Date.now();
      input.backupAuthorization = await signBackupFenceAuthorization({
        schemaVersion: 1,
        status: "succeeded",
        authorizationId: "fence-authenticated-handoff",
        runtimeId: "runtime-protocol",
        leaseId: input.runtimeContext!.leaseId,
        leaseGeneration: input.runtimeContext!.leaseGeneration,
        sessionId: input.invocation.sessionId,
        taskId: input.runtimeContext!.taskId,
        invocationId: input.invocation.invocationId,
        invocationDigest: await createInvocationDigest(input.invocation),
        backupId: "backup-authenticated-handoff",
        lifecycleLockId: "lock-authenticated-handoff",
        lifecycleFencingToken: 41,
        lifecycleLeaseGeneration: 1,
        lifecycleLeaseExpiresAt: new Date(now + 60 * 60_000).toISOString(),
        issuedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      });
      await expect(client.execute(input)).resolves.toMatchObject({ status: "indeterminate" });
      expect(effects).toBe(2);
      await first.close();

      if (failure === "deleted") {
        await Promise.all(journalFiles.map(async (file) => await rm(file, { force: true })));
      }
      if (failure === "replayed") {
        await Promise.all(
          journalFiles.map(async (file) => {
            const bytes = oldSnapshot.get(file);
            if (bytes) await writeFile(file, bytes);
            else await rm(file, { force: true });
          })
        );
      }
      if (failure === "forged") {
        const manifest = JSON.parse(await readFile(statePath, "utf8")) as { appendSlot: number };
        const appendPath = `${statePath}.append.${manifest.appendSlot}`;
        const records = (await readFile(appendPath, "utf8")).trimEnd().split("\n");
        const index = records.findIndex((record) => record.includes(input.invocation.invocationId));
        const transaction = JSON.parse(records[index]!) as {
          mutations: Array<{ operation: string; value?: { invocationDigest?: string } }>;
        };
        const mutation = transaction.mutations.find(
          (candidate) => candidate.operation === "upsert-entry" && candidate.value?.invocationDigest
        );
        if (!mutation?.value) throw new Error("Expected an upsert-entry transaction mutation.");
        mutation.value.invocationDigest = "0".repeat(64);
        records[index] = JSON.stringify(transaction);
        await writeFile(appendPath, `${records.join("\n")}\n`);
      }
      if (failure === "truncated") {
        const manifest = JSON.parse(await readFile(statePath, "utf8")) as { appendSlot: number };
        const appendPath = `${statePath}.append.${manifest.appendSlot}`;
        const bytes = await readFile(appendPath);
        await writeFile(appendPath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
      }

      const restarted = new ExecutorProtocolServer({
        socketPath: socket,
        statePath,
        gatewayPublicKey: gatewayKeys.publicKey,
        backupFencePublicKey: fenceKeys.publicKey,
        journalAuthenticationKey: failure === "wrong-key" ? Buffer.alloc(32, 0x6b) : JOURNAL_KEY,
        executor: {
          async execute() {
            throw new Error("durable handoff must never redispatch");
          },
        },
      });
      const canStart = failure === "deleted" || failure === "replayed" || failure === "truncated";
      if (canStart) await restarted.listen();
      else await expect(restarted.listen()).rejects.toThrow();
      try {
        const recovered = new ExecutorProtocolClient({
          socketPath: socket,
          gatewayPrivateKey: gatewayKeys.privateKey,
          reconciliationStatePath,
          reconciliationAttempts: 1,
          responseTimeoutMs: 50,
        });
        await expect(recovered.reconcilePending()).resolves.toEqual([
          expect.objectContaining({
            state: "dispatching",
            executorStatus: "pending",
            result: expect.objectContaining({ status: "indeterminate" }),
            expectedJournalSequence: expect.any(Number),
          }),
        ]);
        expect(effects).toBe(2);
      } finally {
        await restarted.close();
      }
    }
  );

  it("returns a distinct indeterminate result when bounded reconciliation cannot reach the executor", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    const client = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationAttempts: 2,
    });
    await expect(client.execute(request())).resolves.toMatchObject({
      status: "indeterminate",
      output: { code: "indeterminate-effect", reconciliation: "required" },
    });
  });

  it("persists one runtime-wide owner across gateway restart and rejects a second session until terminal release", async () => {
    const socket = await socketPath();
    const gatewayStatePath = path.join(path.dirname(socket), "gateway-execution-fence.json");
    const keys = generateKeyPairSync("ed25519");
    let releaseEffect: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          effects++;
          if (input.invocation.invocationId === "invocation-protocol") {
            markStarted?.();
            await held;
          }
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "serialized terminal",
            output: { effects },
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const firstClient = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      const first = request();
      await firstClient.prepareExecutionHandoff(first, "runtime-protocol");
      const running = firstClient.execute(first);
      await started;

      const restarted = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      await expect(restarted.inspectEffectSlot()).resolves.toMatchObject({
        invocationId: first.invocation.invocationId,
        taskId: first.runtimeContext?.taskId,
        leaseGeneration: first.runtimeContext?.leaseGeneration,
        status: "in-progress",
      });
      await expect(restarted.reconcilePending()).resolves.toEqual([
        expect.objectContaining({ executorStatus: "active" }),
      ]);

      const second = request();
      second.invocation = {
        ...second.invocation,
        invocationId: "invocation-second-session",
        sessionId: "session-second",
      };
      second.runtimeContext = {
        runtimeId: "runtime-protocol",
        leaseId: "lease-second",
        leaseGeneration: 7,
        taskId: "task-second",
      };
      const secondClient = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
      await expect(secondClient.execute(second)).rejects.toThrow(/runtime-wide effect fence/i);
      expect(effects).toBe(1);

      releaseEffect?.();
      const firstResult = await running;
      expect(firstResult).toMatchObject({ status: "succeeded" });
      await expect(restarted.reconcilePending()).resolves.toEqual([
        expect.objectContaining({
          executorStatus: "terminal",
          result: expect.objectContaining({ status: "succeeded" }),
        }),
      ]);
      await restarted.completeReconciliation(
        first.invocation.invocationId,
        first.runtimeContext,
        await terminalPublicationAuthorization(restarted, first, firstResult)
      );
      const nextLease = structuredClone(second);
      nextLease.invocation.invocationId = "invocation-after-terminal-release";
      nextLease.runtimeContext = {
        runtimeId: "runtime-protocol",
        leaseId: "lease-after-release",
        leaseGeneration: 8,
        taskId: "task-after-release",
      };
      await expect(secondClient.execute(nextLease)).resolves.toMatchObject({ status: "succeeded" });
      expect(effects).toBe(2);
    } finally {
      releaseEffect?.();
      await server.close();
    }
  });

  it("restarts safely after reservation but before begin and redispatches the exact effect once", async () => {
    const socket = await socketPath();
    const gatewayStatePath = path.join(path.dirname(socket), "gateway-execution-fence.json");
    const keys = generateKeyPairSync("ed25519");
    const input = request();
    let effects = 0;
    const crashing = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: keys.publicKey,
      statePath: journalPath(socket),
      beforeJournalBegin() {
        throw new Error("injected crash after reservation");
      },
      executor: {
        async execute() {
          effects++;
          return successfulResult(input.invocation.invocationId);
        },
      },
    });
    await crashing.listen();
    const first = new ExecutorProtocolClient({
      socketPath: socket,
      gatewayPrivateKey: keys.privateKey,
      reconciliationStatePath: gatewayStatePath,
      reconciliationAttempts: 1,
    });
    try {
      await first.prepareExecutionHandoff(input, "runtime-protocol");
      await expect(first.execute(input)).rejects.toThrow(/failed closed/i);
      expect(effects).toBe(0);
      await expect(first.inspectEffectSlot()).resolves.toMatchObject({
        invocationId: input.invocation.invocationId,
        status: "reserved",
      });
      expect(JSON.parse(await readFile(gatewayStatePath, "utf8")).entries[0]).toMatchObject({
        state: "dispatching",
        expectedJournalSequence: expect.any(Number),
      });
    } finally {
      await crashing.close();
    }

    const recoveredServer = new ExecutorProtocolServer({
      socketPath: socket,
      gatewayPublicKey: keys.publicKey,
      statePath: journalPath(socket),
      executor: {
        async execute() {
          effects++;
          return successfulResult(input.invocation.invocationId);
        },
      },
    });
    await recoveredServer.listen();
    try {
      const restarted = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      await expect(restarted.reconcilePending()).resolves.toEqual([
        expect.objectContaining({
          state: "dispatching",
          executorStatus: "reserved",
        }),
      ]);
      const recoveredResult = await restarted.execute(input);
      expect(recoveredResult).toMatchObject({ status: "succeeded" });
      expect(effects).toBe(1);
      await expect(restarted.reconcilePending()).resolves.toEqual([
        expect.objectContaining({ executorStatus: "terminal" }),
      ]);
      await restarted.completeReconciliation(
        input.invocation.invocationId,
        input.runtimeContext,
        await terminalPublicationAuthorization(restarted, input, recoveredResult)
      );
      await expect(restarted.reconcilePending()).resolves.toEqual([]);
    } finally {
      await recoveredServer.close();
    }
  });

  it("recovers a no-backup invocation claimed before dispatch with its exact runtime generation", async () => {
    const socket = await socketPath();
    const gatewayStatePath = path.join(path.dirname(socket), "gateway-execution-fence.json");
    const keys = generateKeyPairSync("ed25519");
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "recovered exact precommit claim",
            output: { effects },
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const input = request();
      input.runtimeContext!.runtimeId = "runtime-precommit";
      const beforeRestart = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      await beforeRestart.prepareExecutionHandoff(input, "runtime-precommit");
      expect(effects).toBe(0);

      const restarted = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      const [pending] = await restarted.reconcilePending();
      expect(pending).toMatchObject({
        runtimeId: "runtime-precommit",
        state: "awaiting-executor",
        executorStatus: "not-started",
      });
      const recoveredResult = await restarted.execute(pending.request);
      expect(recoveredResult).toMatchObject({
        status: "succeeded",
        summary: "recovered exact precommit claim",
      });
      expect(effects).toBe(1);
      await restarted.completeReconciliation(
        input.invocation.invocationId,
        input.runtimeContext,
        await terminalPublicationAuthorization(restarted, pending.request, recoveredResult)
      );
    } finally {
      await server.close();
    }
  });

  it("recovers a SIGTERM cancellation while the effect is durably dispatched but still precommit", async () => {
    const socket = await socketPath();
    const gatewayStatePath = path.join(path.dirname(socket), "gateway-execution-fence.json");
    const keys = generateKeyPairSync("ed25519");
    let releaseBegin: (() => void) | undefined;
    let markBeginHeld: (() => void) | undefined;
    const beginHeld = new Promise<void>((resolve) => {
      markBeginHeld = resolve;
    });
    const beginRelease = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    let effects = 0;
    const server = new ExecutorProtocolServer({
      socketPath: socket,
      statePath: journalPath(socket),
      gatewayPublicKey: keys.publicKey,
      beforeJournalBegin: async () => {
        markBeginHeld?.();
        await beginRelease;
      },
      executor: {
        async execute(input) {
          effects++;
          return {
            schemaVersion: 1,
            invocationId: input.invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "must not execute",
            output: {},
            evidence: [],
          };
        },
      },
    });
    await server.listen();
    try {
      const controller = new AbortController();
      const first = request();
      first.signal = controller.signal;
      const client = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      await client.prepareExecutionHandoff(first, "runtime-protocol");
      const running = client.execute(first);
      await beginHeld;

      const restarted = new ExecutorProtocolClient({
        socketPath: socket,
        gatewayPrivateKey: keys.privateKey,
        reconciliationStatePath: gatewayStatePath,
      });
      await expect(restarted.inspectEffectSlot()).resolves.toMatchObject({
        invocationId: first.invocation.invocationId,
        status: "reserved",
      });
      controller.abort(new DOMException("SIGTERM", "AbortError"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      releaseBegin?.();
      const cancelledResult = await running;
      expect(cancelledResult).toMatchObject({ status: "cancelled" });
      expect(effects).toBe(0);
      await expect(restarted.reconcilePending()).resolves.toEqual([
        expect.objectContaining({
          executorStatus: "terminal",
          result: expect.objectContaining({ status: "cancelled" }),
        }),
      ]);
      await restarted.completeReconciliation(
        first.invocation.invocationId,
        first.runtimeContext,
        await terminalPublicationAuthorization(restarted, first, cancelledResult)
      );
    } finally {
      releaseBegin?.();
      await server.close();
    }
  });

  it("returns cancelled without sending when the execute signal is already aborted", async () => {
    const socket = await socketPath();
    const keys = generateKeyPairSync("ed25519");
    const controller = new AbortController();
    controller.abort();
    const input = request();
    input.signal = controller.signal;
    const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });

    await expect(client.execute(input)).resolves.toMatchObject({ status: "cancelled", output: { code: "cancelled" } });
  });

  it.each([
    ["committed-success", "succeeded", { committed: true, point: "atomic-rename" }],
    ["cancelled-before-effect", "cancelled", { committed: false }],
    ["cancelled-after-commit", "cancelled", { committed: true, point: "atomic-rename" }],
    ["failed-before-effect", "failed", { committed: false }],
    ["failed-after-commit", "failed", { committed: true, point: "console-dispatch" }],
    ["indeterminate-after-commit", "indeterminate", { committed: true, point: "atomic-rename" }],
  ] as const)(
    "emits a signed terminal receipt for %s with exact mutation truth",
    async (label, status, mutationCommit) => {
      const socket = await socketPath();
      const keys = generateKeyPairSync("ed25519");
      const server = new ExecutorProtocolServer({
        socketPath: socket,
        gatewayPublicKey: keys.publicKey,
        executor: {
          async execute(input) {
            return {
              schemaVersion: 1,
              invocationId: input.invocation.invocationId,
              status,
              completedAt: "2026-09-02T12:00:01.000Z",
              summary: label,
              output: { label },
              evidence: [],
              mutationCommit,
            } as ToolResult;
          },
        },
      });
      await server.listen();
      try {
        const client = new ExecutorProtocolClient({ socketPath: socket, gatewayPrivateKey: keys.privateKey });
        const input = request();
        input.invocation = { ...input.invocation, invocationId: `invocation-${label}` };
        const result = await client.execute(input);
        expect(result).toMatchObject({ status, mutationCommit });
        const receipt = await client.terminalReceiptFor(input, result);
        expect(receipt).toMatchObject({
          source: "executor-journal",
          outcome: status === "succeeded" ? "committed" : status,
          proofKind: "terminal",
          runtimeId: input.runtimeContext?.runtimeId,
          invocationId: input.invocation.invocationId,
          invocationDigest: await createInvocationDigest(input.invocation),
          journalSequence: expect.any(Number),
          resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
        });
        expect(receipt).not.toHaveProperty("backupId");
      } finally {
        await server.close();
      }
    }
  );
});
