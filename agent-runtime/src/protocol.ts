import { type KeyLike, createHash, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type {
  AgentApproval,
  BackupTerminalReceipt,
  JsonValue,
  MutationCommit,
  PermissionPolicy,
  TerminalPublicationAuthorization,
  ToolInvocation,
  ToolResult,
} from "@/lib/agent/contracts";
import type {
  DirectLiveExecutor,
  ExecuteInvocationRequest,
  GatewayApprovalAuthorization,
  GatewayBackupAuthorization,
  GatewayDownloadAuthorization,
  RuntimeExecutionContext,
} from "@/lib/agent/executor";
import { IndeterminateHostEffectError } from "@/lib/agent/executor";
import { createInvocationDigest } from "@/lib/agent/policy";
import { backupFenceSignedContent, parseBackupFenceAuthorization } from "@/lib/agent/runtime/backup-fence";
import {
  type UnsignedBackupTerminalReceipt,
  executorReceiptSignedContent,
  parseBackupTerminalReceipt,
} from "@/lib/agent/runtime/executor-receipt";
import {
  parseTerminalPublicationAuthorization,
  terminalPublicationSignedContent,
} from "@/lib/agent/runtime/terminal-publication";
import { agentSchemas } from "@/lib/agent/validators";
import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_PROTOCOL_APPROVALS,
  MAX_PROTOCOL_PAYLOAD_BYTES,
  MAX_TERMINAL_RECEIPT_BYTES,
  assertJsonBytes,
  boundToolResult,
  encodedJsonLine,
} from "../../lib/agent/response-limits";
import {
  type GatewayDownloadRelayAuthorizer,
  MAX_GATEWAY_DOWNLOAD_BYTES,
  MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS,
} from "./download-relay";
import {
  ExecutorEffectJournal,
  type JournalInFlightIdentity,
  type JournalTerminalPublicationAcknowledgement,
} from "./executor-journal";
import { removeOwnedStaleUnixSocket } from "./unix-socket";

const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_REPLAY_ENTRIES = 1_024;
const DEFAULT_RECONCILIATION_ATTEMPTS = 3;
const MAX_RECONCILIATION_ATTEMPTS = 5;
const DEFAULT_RESPONSE_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_RECONCILIATION_DELAY_MS = 1_100;
const MAX_RECONCILIATION_DELAY_MS = 5_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PENDING_RECONCILIATIONS = 128;
const MAX_PENDING_RECONCILIATION_BYTES = 16 * 1024 * 1024;

interface ExecuteWirePayload {
  actorId: string;
  invocation: ToolInvocation;
  policy: PermissionPolicy;
  approvals: AgentApproval[];
  approvalAuthorization?: GatewayApprovalAuthorization;
  backupAuthorization?: GatewayBackupAuthorization;
  runtimeContext: RuntimeExecutionContext;
  downloadAuthorization?: GatewayDownloadAuthorization;
}

type WireCommand =
  | { schemaVersion: 1; command: "reserve"; payload: ExecuteWirePayload }
  | { schemaVersion: 1; command: "execute"; payload: ExecuteWirePayload }
  | { schemaVersion: 1; command: "reconcile"; payload: ExecuteWirePayload }
  | { schemaVersion: 1; command: "checkpoint"; payload: Record<string, never> }
  | { schemaVersion: 1; command: "effect-status"; payload: Record<string, never> }
  | {
      schemaVersion: 1;
      command: "acknowledge-terminal";
      payload: JournalTerminalPublicationAcknowledgement;
    }
  | {
      schemaVersion: 1;
      command: "renew-fence";
      payload: {
        invocationId: string;
        runtimeContext: RuntimeExecutionContext;
        authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
      };
    }
  | {
      schemaVersion: 1;
      command: "revoke-fence";
      payload: { invocationId: string; runtimeContext: RuntimeExecutionContext };
    }
  | {
      schemaVersion: 1;
      command: "cancel";
      payload: {
        invocationId: string;
        runtimeContext: RuntimeExecutionContext;
        invocationDigest?: string;
        effectFingerprint?: string;
        invocation?: ToolInvocation;
        backupAuthorization?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
      };
    };

interface SignedRequest {
  schemaVersion: 1;
  requestId: string;
  nonce: string;
  issuedAt: string;
  body: WireCommand;
  signature: string;
}

interface WireResponse {
  schemaVersion: 1;
  requestId: string;
  ok: boolean;
  result?: ToolResult;
  reconciliation?: "active" | "pending" | "reserved" | "not-started";
  journalSequence?: number;
  terminalJournalSequence?: number;
  terminalReceipt?: BackupTerminalReceipt;
  inFlight?: JournalInFlightIdentity | null;
  error?: "invalid-request" | "unauthorized" | "replay" | "runtime-fenced" | "executor-failed";
}

const canonicalize = canonicalJson;

function signedContent(request: Omit<SignedRequest, "signature">): string {
  return canonicalize(request as unknown as JsonValue);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAuthorization(value: unknown): GatewayApprovalAuthorization | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "schemaVersion",
      "authorizationId",
      "runtimeId",
      "leaseId",
      "leaseGeneration",
      "taskId",
      "sessionId",
      "actorId",
      "policyId",
      "policyRevision",
      "invocationId",
      "invocationDigest",
      "approvalId",
      "approvalKind",
      "capability",
      "targetScope",
      "risk",
      "issuedAt",
      "expiresAt",
    ]) ||
    item.schemaVersion !== 1 ||
    typeof item.authorizationId !== "string" ||
    !ID.test(item.authorizationId) ||
    typeof item.runtimeId !== "string" ||
    !ID.test(item.runtimeId) ||
    typeof item.leaseId !== "string" ||
    !ID.test(item.leaseId) ||
    typeof item.leaseGeneration !== "number" ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    item.leaseGeneration < 1 ||
    typeof item.taskId !== "string" ||
    !ID.test(item.taskId) ||
    typeof item.sessionId !== "string" ||
    !ID.test(item.sessionId) ||
    typeof item.actorId !== "string" ||
    !ID.test(item.actorId) ||
    typeof item.policyId !== "string" ||
    !ID.test(item.policyId) ||
    typeof item.policyRevision !== "number" ||
    !Number.isSafeInteger(item.policyRevision) ||
    item.policyRevision < 1 ||
    typeof item.invocationId !== "string" ||
    !ID.test(item.invocationId) ||
    typeof item.approvalId !== "string" ||
    !ID.test(item.approvalId) ||
    typeof item.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.invocationDigest) ||
    (item.approvalKind !== "ask-once" && item.approvalKind !== "ask-always") ||
    typeof item.capability !== "string" ||
    ![
      "workspace.read",
      "workspace.write",
      "workspace.delete",
      "shell.execute",
      "console.execute",
      "network.outbound",
      "backup.create",
      "extension.load",
    ].includes(item.capability) ||
    (item.risk !== "low" && item.risk !== "risky" && item.risk !== "destructive") ||
    typeof item.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(item.issuedAt)) ||
    typeof item.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.expiresAt))
  ) {
    throw new Error("invalid-request");
  }
  agentSchemas.targetScope.parse(item.targetScope);
  return item as unknown as GatewayApprovalAuthorization;
}

function parseBackupAuthorization(value: unknown): GatewayBackupAuthorization | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (item?.status === "succeeded") return parseBackupFenceAuthorization(item);
  const keys = ["schemaVersion", "invocationDigest", "status", "approvalId", "consumedAt"];
  if (
    !item ||
    !Object.keys(item).every((key) => keys.includes(key)) ||
    !["schemaVersion", "invocationDigest", "status"].every((key) => key in item) ||
    item.schemaVersion !== 1 ||
    typeof item.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.invocationDigest) ||
    item.status !== "proceed-without-backup" ||
    (item.approvalId !== undefined && (typeof item.approvalId !== "string" || !ID.test(item.approvalId))) ||
    (item.consumedAt !== undefined &&
      (typeof item.consumedAt !== "string" || !Number.isFinite(Date.parse(item.consumedAt)))) ||
    item.approvalId === undefined ||
    item.consumedAt === undefined
  ) {
    throw new Error("invalid-request");
  }
  return item as unknown as GatewayBackupAuthorization;
}

function parseRuntimeContext(value: unknown): RuntimeExecutionContext | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (
    !item ||
    !exact(item, ["runtimeId", "leaseId", "leaseGeneration", "taskId"]) ||
    typeof item.runtimeId !== "string" ||
    !ID.test(item.runtimeId) ||
    typeof item.leaseId !== "string" ||
    !ID.test(item.leaseId) ||
    typeof item.leaseGeneration !== "number" ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    item.leaseGeneration < 1 ||
    typeof item.taskId !== "string" ||
    !ID.test(item.taskId)
  ) {
    throw new Error("invalid-request");
  }
  return item as unknown as RuntimeExecutionContext;
}

function parseInFlightIdentity(value: unknown): JournalInFlightIdentity | null {
  if (value === null) return null;
  const item = record(value);
  if (
    !item ||
    !Object.keys(item).every((key) =>
      ["invocationId", "invocationDigest", "taskId", "leaseGeneration", "status", "updatedAt"].includes(key)
    ) ||
    !["invocationId", "invocationDigest", "status", "updatedAt"].every((key) => key in item) ||
    typeof item.invocationId !== "string" ||
    !ID.test(item.invocationId) ||
    typeof item.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.invocationDigest) ||
    !["reserved", "in-progress", "indeterminate", "terminal-pending"].includes(String(item.status)) ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.updatedAt)) ||
    (item.taskId === undefined) !== (item.leaseGeneration === undefined) ||
    (item.taskId !== undefined && (typeof item.taskId !== "string" || !ID.test(item.taskId))) ||
    (item.leaseGeneration !== undefined &&
      (typeof item.leaseGeneration !== "number" ||
        !Number.isSafeInteger(item.leaseGeneration) ||
        item.leaseGeneration < 1))
  ) {
    throw new Error("Executor returned an invalid in-flight identity.");
  }
  return item as unknown as JournalInFlightIdentity;
}

function parseDownloadAuthorization(value: unknown): GatewayDownloadAuthorization | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  const keys = [
    "schemaVersion",
    "authorizationId",
    "invocationId",
    "sessionId",
    "invocationDigest",
    "requestFingerprint",
    "url",
    "expectedSha256",
    "expectedBytes",
    "maxBytes",
    "timeoutMs",
    "expiresAt",
    "token",
    "signature",
  ];
  if (
    !item ||
    !exact(item, keys) ||
    item.schemaVersion !== 1 ||
    typeof item.authorizationId !== "string" ||
    !ID.test(item.authorizationId) ||
    typeof item.invocationId !== "string" ||
    !ID.test(item.invocationId) ||
    typeof item.sessionId !== "string" ||
    !ID.test(item.sessionId) ||
    typeof item.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.invocationDigest) ||
    typeof item.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.requestFingerprint) ||
    typeof item.url !== "string" ||
    item.url.length > 8192 ||
    typeof item.expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.expectedSha256) ||
    typeof item.expectedBytes !== "number" ||
    !Number.isSafeInteger(item.expectedBytes) ||
    item.expectedBytes < 1 ||
    typeof item.maxBytes !== "number" ||
    !Number.isSafeInteger(item.maxBytes) ||
    item.maxBytes < 1 ||
    item.maxBytes > MAX_GATEWAY_DOWNLOAD_BYTES ||
    item.expectedBytes > item.maxBytes ||
    typeof item.timeoutMs !== "number" ||
    !Number.isSafeInteger(item.timeoutMs) ||
    item.timeoutMs < 1 ||
    item.timeoutMs > MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS ||
    typeof item.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    typeof item.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(item.token) ||
    typeof item.signature !== "string" ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(item.signature)
  ) {
    throw new Error("invalid-request");
  }
  return item as unknown as GatewayDownloadAuthorization;
}

function parseExecutePayload(value: unknown): ExecuteWirePayload {
  const payload = record(value);
  const allowed = [
    "actorId",
    "invocation",
    "policy",
    "approvals",
    "approvalAuthorization",
    "backupAuthorization",
    "runtimeContext",
    "downloadAuthorization",
  ];
  if (
    !payload ||
    !Object.keys(payload).every((key) => allowed.includes(key)) ||
    !["actorId", "invocation", "policy", "approvals", "runtimeContext"].every((key) => key in payload) ||
    typeof payload.actorId !== "string" ||
    !ID.test(payload.actorId) ||
    !Array.isArray(payload.approvals)
  ) {
    throw new Error("invalid-request");
  }
  if (payload.approvals.length > MAX_PROTOCOL_APPROVALS) throw new Error("invalid-request");
  assertJsonBytes(payload, MAX_PROTOCOL_PAYLOAD_BYTES, "executor payload");
  agentSchemas.toolInvocation.parse(payload.invocation);
  agentSchemas.permissionPolicy.parse(payload.policy);
  payload.approvals.forEach((approval) => agentSchemas.agentApproval.parse(approval));
  parseAuthorization(payload.approvalAuthorization);
  parseBackupAuthorization(payload.backupAuthorization);
  parseRuntimeContext(payload.runtimeContext);
  parseDownloadAuthorization(payload.downloadAuthorization);
  return payload as unknown as ExecuteWirePayload;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One strict parser validates every signed execute, cancel, reconcile, and fence-management variant.
function parseRequest(value: unknown): SignedRequest {
  const envelope = record(value);
  if (
    !envelope ||
    !exact(envelope, ["schemaVersion", "requestId", "nonce", "issuedAt", "body", "signature"]) ||
    envelope.schemaVersion !== 1 ||
    typeof envelope.requestId !== "string" ||
    !ID.test(envelope.requestId) ||
    typeof envelope.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(envelope.nonce) ||
    typeof envelope.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(envelope.issuedAt)) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(envelope.signature)
  ) {
    throw new Error("invalid-request");
  }
  const body = record(envelope.body);
  if (!body || !exact(body, ["schemaVersion", "command", "payload"]) || body.schemaVersion !== 1) {
    throw new Error("invalid-request");
  }
  const payload = record(body.payload);
  if (!payload) throw new Error("invalid-request");
  if (body.command === "cancel" || body.command === "revoke-fence") {
    if (
      !Object.keys(payload).every((key) =>
        (body.command === "cancel"
          ? [
              "invocationId",
              "runtimeContext",
              "invocationDigest",
              "effectFingerprint",
              "invocation",
              "backupAuthorization",
            ]
          : ["invocationId", "runtimeContext"]
        ).includes(key)
      ) ||
      !["invocationId", "runtimeContext"].every((key) => key in payload) ||
      typeof payload.invocationId !== "string" ||
      !ID.test(payload.invocationId)
    ) {
      throw new Error("invalid-request");
    }
    parseRuntimeContext(payload.runtimeContext);
    if (body.command === "cancel") {
      if (
        (payload.invocationDigest !== undefined &&
          (typeof payload.invocationDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.invocationDigest))) ||
        (payload.effectFingerprint !== undefined &&
          (typeof payload.effectFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(payload.effectFingerprint)))
      ) {
        throw new Error("invalid-request");
      }
      if (payload.invocation !== undefined) {
        const invocation = agentSchemas.toolInvocation.parse(payload.invocation);
        if (invocation.invocationId !== payload.invocationId) throw new Error("invalid-request");
      }
      parseBackupAuthorization(payload.backupAuthorization);
    }
  } else if (body.command === "renew-fence") {
    if (
      !exact(payload, ["invocationId", "runtimeContext", "authorization"]) ||
      typeof payload.invocationId !== "string" ||
      !ID.test(payload.invocationId)
    ) {
      throw new Error("invalid-request");
    }
    parseRuntimeContext(payload.runtimeContext);
    const authorization = parseBackupAuthorization(payload.authorization);
    if (authorization?.status !== "succeeded" || authorization.invocationId !== payload.invocationId) {
      throw new Error("invalid-request");
    }
  } else if (body.command === "acknowledge-terminal") {
    if (
      !exact(payload, [
        "invocationId",
        "invocationDigest",
        "taskId",
        "leaseGeneration",
        "journalSequence",
        "resultDigest",
        "authorization",
      ]) ||
      typeof payload.invocationId !== "string" ||
      !ID.test(payload.invocationId) ||
      typeof payload.invocationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.invocationDigest) ||
      typeof payload.taskId !== "string" ||
      !ID.test(payload.taskId) ||
      typeof payload.leaseGeneration !== "number" ||
      !Number.isSafeInteger(payload.leaseGeneration) ||
      payload.leaseGeneration < 1 ||
      typeof payload.journalSequence !== "number" ||
      !Number.isSafeInteger(payload.journalSequence) ||
      payload.journalSequence < 1 ||
      typeof payload.resultDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.resultDigest)
    ) {
      throw new Error("invalid-request");
    }
    parseTerminalPublicationAuthorization(payload.authorization);
  } else if (body.command === "reserve" || body.command === "execute" || body.command === "reconcile") {
    parseExecutePayload(payload);
  } else if (body.command === "checkpoint" || body.command === "effect-status") {
    if (!exact(payload, [])) throw new Error("invalid-request");
  } else {
    throw new Error("invalid-request");
  }
  return envelope as unknown as SignedRequest;
}

function encode(value: unknown): Uint8Array {
  return encodedJsonLine(value, MAX_AGENT_MESSAGE_BYTES);
}

async function readOne(socket: Socket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };
    const onError = () => {
      cleanup();
      reject(new Error("socket-failed"));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("truncated-message"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket-closed"));
    };
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > MAX_AGENT_MESSAGE_BYTES) {
        cleanup();
        reject(new Error("message-too-large"));
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      cleanup();
      if (newline !== bytes.byteLength - 1) return reject(new Error("multiple-messages"));
      try {
        resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        reject(new Error("invalid-json"));
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onClose);
  });
}

function fingerprint(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function executePayloadFingerprint(payload: ExecuteWirePayload): string {
  const { downloadAuthorization: _downloadAuthorization, ...bound } = payload;
  return fingerprint({
    ...bound,
    ...(bound.backupAuthorization?.status === "succeeded"
      ? { backupAuthorization: stableBackupFenceBinding(bound.backupAuthorization) }
      : {}),
  } as unknown as JsonValue);
}

function stableBackupFenceBinding(
  authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
): Omit<
  typeof authorization,
  "issuedAt" | "expiresAt" | "signature" | "lifecycleLeaseGeneration" | "lifecycleLeaseExpiresAt"
> {
  const {
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    signature: _signature,
    lifecycleLeaseGeneration: _lifecycleLeaseGeneration,
    lifecycleLeaseExpiresAt: _lifecycleLeaseExpiresAt,
    executorKeyId: _executorKeyId,
    executorKeyEpoch: _executorKeyEpoch,
    ...stable
  } = authorization;
  return stable;
}

function executionBehaviorFingerprint(payload: ExecuteWirePayload): string {
  const {
    approvals: _approvals,
    approvalAuthorization: _approvalAuthorization,
    backupAuthorization: _backupAuthorization,
    downloadAuthorization: _downloadAuthorization,
    ...behavior
  } = payload;
  return fingerprint(behavior as unknown as JsonValue);
}

function approvalsWithoutNewAuthorizationFingerprint(payload: ExecuteWirePayload): string {
  const authorizedApprovalIds = new Set<string>();
  if (payload.approvalAuthorization) authorizedApprovalIds.add(payload.approvalAuthorization.approvalId);
  if (payload.backupAuthorization?.status === "proceed-without-backup") {
    authorizedApprovalIds.add(payload.backupAuthorization.approvalId);
  }
  return fingerprint(
    payload.approvals.filter((approval) => !authorizedApprovalIds.has(approval.approvalId)) as unknown as JsonValue
  );
}

function optionalFingerprint(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : fingerprint(value);
}

function journalAttemptContext(payload: ExecuteWirePayload, executorEpoch?: string) {
  return {
    taskId: payload.runtimeContext.taskId,
    leaseGeneration: payload.runtimeContext.leaseGeneration,
    behaviorFingerprint: executionBehaviorFingerprint(payload),
    approvalsFingerprint: fingerprint(payload.approvals as unknown as JsonValue),
    approvalsWithoutAuthorizationFingerprint: approvalsWithoutNewAuthorizationFingerprint(payload),
    approvalAuthorizationFingerprint: optionalFingerprint(
      payload.approvalAuthorization as unknown as JsonValue | undefined
    ),
    backupAuthorizationFingerprint: optionalFingerprint(
      (payload.backupAuthorization?.status === "succeeded"
        ? stableBackupFenceBinding(payload.backupAuthorization)
        : payload.backupAuthorization) as unknown as JsonValue | undefined
    ),
    ...(executorEpoch ? { executorEpoch } : {}),
  };
}

function scopedInvocationKey(runtimeContext: RuntimeExecutionContext, invocationId: string): string {
  return `${runtimeContext.runtimeId}:${runtimeContext.taskId}:${runtimeContext.leaseId}:${runtimeContext.leaseGeneration}:${invocationId}`;
}

interface PendingReconciliationEntry {
  schemaVersion: 1;
  key: string;
  runtimeId: string;
  sessionId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  state: "awaiting-backup" | "awaiting-executor" | "dispatching";
  payload: ExecuteWirePayload;
  updatedAt: string;
  expectedJournalSequence?: number;
  /** Authenticated terminal evidence retained until the executor journal is acknowledged. */
  terminalJournalSequence?: number;
  terminalResult?: ToolResult;
  terminalReceipt?: BackupTerminalReceipt;
}

class ClientReconciliationJournal {
  private readonly entries = new Map<string, PendingReconciliationEntry>();
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly statePath?: string) {
    if (statePath !== undefined && !path.isAbsolute(statePath)) {
      throw new TypeError("Gateway reconciliation journal path must be absolute.");
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Fail-closed journal loading validates file safety, schema, exact entries, and invocation bindings together.
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.entries.clear();
    if (this.statePath) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.statePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.uid !== process.getuid?.() ||
          metadata.size > MAX_PENDING_RECONCILIATION_BYTES ||
          (metadata.mode & 0o077) !== 0
        ) {
          throw new Error("Gateway reconciliation journal file is unsafe.");
        }
        const parsed = JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid journal");
        const state = parsed as Record<string, unknown>;
        if (
          state.schemaVersion !== 1 ||
          !Array.isArray(state.entries) ||
          state.entries.length > MAX_PENDING_RECONCILIATIONS
        ) {
          throw new Error("Gateway reconciliation journal schema is invalid.");
        }
        for (const raw of state.entries) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid journal entry");
          const entry = raw as Record<string, unknown>;
          if (
            !Object.keys(entry).every((key) =>
              [
                "schemaVersion",
                "key",
                "runtimeId",
                "sessionId",
                "taskId",
                "leaseId",
                "leaseGeneration",
                "invocationId",
                "invocationDigest",
                "state",
                "payload",
                "updatedAt",
                "expectedJournalSequence",
                "terminalJournalSequence",
                "terminalResult",
                "terminalReceipt",
              ].includes(key)
            ) ||
            ![
              "schemaVersion",
              "key",
              "runtimeId",
              "sessionId",
              "taskId",
              "leaseId",
              "leaseGeneration",
              "invocationId",
              "invocationDigest",
              "state",
              "payload",
              "updatedAt",
            ].every((key) => key in entry) ||
            entry.schemaVersion !== 1 ||
            typeof entry.key !== "string" ||
            typeof entry.runtimeId !== "string" ||
            !ID.test(entry.runtimeId) ||
            typeof entry.sessionId !== "string" ||
            !ID.test(entry.sessionId) ||
            typeof entry.taskId !== "string" ||
            !ID.test(entry.taskId) ||
            typeof entry.leaseId !== "string" ||
            !ID.test(entry.leaseId) ||
            typeof entry.leaseGeneration !== "number" ||
            !Number.isSafeInteger(entry.leaseGeneration) ||
            entry.leaseGeneration < 1 ||
            typeof entry.invocationId !== "string" ||
            !ID.test(entry.invocationId) ||
            typeof entry.invocationDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.invocationDigest) ||
            !["awaiting-backup", "awaiting-executor", "dispatching"].includes(String(entry.state)) ||
            typeof entry.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.updatedAt))
          ) {
            throw new Error("Gateway reconciliation journal entry is invalid.");
          }
          const payload = parseExecutePayload(entry.payload);
          const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
          const invocationDigest = await createInvocationDigest(payload.invocation);
          if (
            entry.key !== key ||
            this.entries.has(key) ||
            entry.runtimeId !== payload.runtimeContext.runtimeId ||
            entry.sessionId !== payload.invocation.sessionId ||
            entry.taskId !== payload.runtimeContext.taskId ||
            entry.leaseId !== payload.runtimeContext.leaseId ||
            entry.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
            entry.invocationId !== payload.invocation.invocationId ||
            entry.invocationDigest !== invocationDigest
          )
            throw new Error("Gateway reconciliation journal binding changed.");
          if (
            (entry.state === "awaiting-backup" && payload.backupAuthorization !== undefined) ||
            (entry.state === "dispatching" &&
              (typeof entry.expectedJournalSequence !== "number" ||
                !Number.isSafeInteger(entry.expectedJournalSequence) ||
                entry.expectedJournalSequence < 0)) ||
            (entry.state !== "dispatching" && entry.expectedJournalSequence !== undefined)
          ) {
            throw new Error("Gateway reconciliation journal handoff state is invalid.");
          }
          const hasTerminalEvidence =
            entry.terminalJournalSequence !== undefined ||
            entry.terminalResult !== undefined ||
            entry.terminalReceipt !== undefined;
          if (
            hasTerminalEvidence &&
            (entry.state !== "dispatching" ||
              typeof entry.terminalJournalSequence !== "number" ||
              !Number.isSafeInteger(entry.terminalJournalSequence) ||
              entry.terminalJournalSequence < 1 ||
              entry.terminalResult === undefined ||
              entry.terminalReceipt === undefined)
          ) {
            throw new Error("Gateway reconciliation journal terminal evidence is invalid.");
          }
          const terminalResult =
            entry.terminalResult === undefined ? undefined : agentSchemas.toolResult.parse(entry.terminalResult);
          const terminalReceipt =
            entry.terminalReceipt === undefined ? undefined : parseBackupTerminalReceipt(entry.terminalReceipt);
          if (terminalResult && terminalReceipt) {
            if (
              terminalReceipt.outcome !==
                (terminalResult.status === "succeeded" ? "committed" : terminalResult.status) ||
              terminalResult.invocationId !== entry.invocationId ||
              terminalReceipt.invocationId !== entry.invocationId ||
              terminalReceipt.invocationDigest !== entry.invocationDigest ||
              terminalReceipt.journalSequence !== entry.terminalJournalSequence ||
              terminalReceipt.resultDigest !== fingerprint(terminalResult as unknown as JsonValue)
            ) {
              throw new Error("Gateway reconciliation journal terminal evidence changed its exact binding.");
            }
          }
          this.entries.set(key, {
            schemaVersion: 1,
            key,
            runtimeId: entry.runtimeId,
            sessionId: entry.sessionId as string,
            taskId: entry.taskId as string,
            leaseId: entry.leaseId as string,
            leaseGeneration: entry.leaseGeneration as number,
            invocationId: entry.invocationId as string,
            invocationDigest: entry.invocationDigest as string,
            state: entry.state,
            payload,
            updatedAt: entry.updatedAt,
            ...(entry.expectedJournalSequence !== undefined
              ? { expectedJournalSequence: entry.expectedJournalSequence as number }
              : {}),
            ...(entry.terminalJournalSequence !== undefined
              ? { terminalJournalSequence: entry.terminalJournalSequence as number }
              : {}),
            ...(terminalResult ? { terminalResult } : {}),
            ...(terminalReceipt ? { terminalReceipt } : {}),
          } as PendingReconciliationEntry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        await handle?.close();
      }
    }
    this.initialized = true;
  }

  async prepare(payload: ExecuteWirePayload, runtimeId: string, updatedAt: string): Promise<void> {
    await this.initialize();
    if (
      !ID.test(runtimeId) ||
      runtimeId !== payload.runtimeContext.runtimeId ||
      payload.backupAuthorization !== undefined
    ) {
      throw new Error("Gateway backup handoff preparation is invalid.");
    }
    assertJsonBytes(payload, MAX_PROTOCOL_PAYLOAD_BYTES, "gateway backup handoff");
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    await this.exclusive(async () => {
      if (this.hasConflictingRuntimeOwner(key)) {
        throw new Error("Gateway runtime execution fence is owned by another invocation.");
      }
      const existing = this.entries.get(key);
      if (!existing && this.entries.size >= MAX_PENDING_RECONCILIATIONS) {
        throw new Error("Gateway reconciliation journal capacity is exhausted.");
      }
      if (existing) {
        if (
          existing.runtimeId !== runtimeId ||
          existing.sessionId !== payload.invocation.sessionId ||
          existing.taskId !== payload.runtimeContext.taskId ||
          existing.leaseId !== payload.runtimeContext.leaseId ||
          existing.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
          existing.invocationId !== payload.invocation.invocationId ||
          existing.invocationDigest !== invocationDigest ||
          executionBehaviorFingerprint(existing.payload) !== executionBehaviorFingerprint(payload) ||
          existing.payload.invocation.sessionId !== payload.invocation.sessionId ||
          fingerprint(existing.payload.invocation as unknown as JsonValue) !==
            fingerprint(payload.invocation as unknown as JsonValue)
        ) {
          throw new Error("Gateway backup handoff preparation changed its exact binding.");
        }
        existing.state = "awaiting-backup";
        existing.payload = structuredClone(payload);
        existing.updatedAt = updatedAt;
        existing.expectedJournalSequence = undefined;
        await this.persist();
        return;
      }
      this.entries.set(key, {
        schemaVersion: 1,
        key,
        runtimeId,
        sessionId: payload.invocation.sessionId,
        taskId: payload.runtimeContext.taskId,
        leaseId: payload.runtimeContext.leaseId,
        leaseGeneration: payload.runtimeContext.leaseGeneration,
        invocationId: payload.invocation.invocationId,
        invocationDigest,
        state: "awaiting-backup",
        payload: structuredClone(payload),
        updatedAt,
      });
      await this.persist();
    });
  }

  async claim(payload: ExecuteWirePayload, runtimeId: string, updatedAt: string): Promise<void> {
    await this.initialize();
    if (!ID.test(runtimeId) || runtimeId !== payload.runtimeContext.runtimeId) {
      throw new Error("Gateway runtime execution claim is invalid.");
    }
    if (payload.approvals.length > MAX_PROTOCOL_APPROVALS) {
      throw new Error("Gateway execution approvals exceed the bound.");
    }
    assertJsonBytes(payload, MAX_PROTOCOL_PAYLOAD_BYTES, "gateway execution handoff");
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One atomic durable transition validates the runtime-wide owner and every exact authorization binding.
    await this.exclusive(async () => {
      if (this.hasConflictingRuntimeOwner(key)) {
        throw new Error("Gateway runtime execution fence is owned by another invocation.");
      }
      const existing = this.entries.get(key);
      if (!existing) {
        this.entries.set(key, {
          schemaVersion: 1,
          key,
          runtimeId,
          sessionId: payload.invocation.sessionId,
          taskId: payload.runtimeContext.taskId,
          leaseId: payload.runtimeContext.leaseId,
          leaseGeneration: payload.runtimeContext.leaseGeneration,
          invocationId: payload.invocation.invocationId,
          invocationDigest,
          state: "awaiting-executor",
          payload: structuredClone(payload),
          updatedAt,
        });
        await this.persist();
        return;
      }
      if (
        existing.runtimeId !== runtimeId ||
        existing.sessionId !== payload.invocation.sessionId ||
        existing.taskId !== payload.runtimeContext.taskId ||
        existing.leaseId !== payload.runtimeContext.leaseId ||
        existing.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
        existing.invocationId !== payload.invocation.invocationId ||
        existing.invocationDigest !== invocationDigest ||
        executionBehaviorFingerprint(existing.payload) !== executionBehaviorFingerprint(payload) ||
        (fingerprint(existing.payload.approvals as unknown as JsonValue) !==
          fingerprint(payload.approvals as unknown as JsonValue) &&
          fingerprint(existing.payload.approvals as unknown as JsonValue) !==
            approvalsWithoutNewAuthorizationFingerprint(payload)) ||
        (existing.payload.approvalAuthorization !== undefined &&
          optionalFingerprint(existing.payload.approvalAuthorization as unknown as JsonValue) !==
            optionalFingerprint(payload.approvalAuthorization as unknown as JsonValue | undefined)) ||
        (existing.payload.backupAuthorization !== undefined &&
          optionalFingerprint(
            (existing.payload.backupAuthorization.status === "succeeded"
              ? stableBackupFenceBinding(existing.payload.backupAuthorization)
              : existing.payload.backupAuthorization) as unknown as JsonValue
          ) !==
            optionalFingerprint(
              (payload.backupAuthorization?.status === "succeeded"
                ? stableBackupFenceBinding(payload.backupAuthorization)
                : payload.backupAuthorization) as unknown as JsonValue | undefined
            )) ||
        fingerprint(existing.payload.invocation as unknown as JsonValue) !==
          fingerprint(payload.invocation as unknown as JsonValue)
      ) {
        throw new Error("Gateway runtime execution claim changed its exact generation-fenced binding.");
      }
      if (existing.state === "dispatching") {
        if (executePayloadFingerprint(existing.payload) !== executePayloadFingerprint(payload)) {
          throw new Error("Gateway runtime execution claim changed after durable dispatch.");
        }
        return;
      }
      existing.payload = structuredClone(payload);
      existing.state = "awaiting-executor";
      existing.updatedAt = updatedAt;
      existing.expectedJournalSequence = undefined;
      await this.persist();
    });
  }

  async authorize(payload: ExecuteWirePayload, runtimeId: string, updatedAt: string): Promise<void> {
    await this.initialize();
    if (
      !ID.test(runtimeId) ||
      runtimeId !== payload.runtimeContext.runtimeId ||
      payload.backupAuthorization?.status !== "succeeded"
    ) {
      throw new Error("Gateway backup handoff authorization is invalid.");
    }
    if (payload.approvals.length > MAX_PROTOCOL_APPROVALS) {
      throw new Error("Gateway execution approvals exceed the bound.");
    }
    assertJsonBytes(payload, MAX_PROTOCOL_PAYLOAD_BYTES, "gateway backup authorization handoff");
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    await this.exclusive(async () => {
      if (this.hasConflictingRuntimeOwner(key)) {
        throw new Error("Gateway runtime execution fence is owned by another invocation.");
      }
      const existing = this.entries.get(key);
      if (
        !existing ||
        existing.runtimeId !== runtimeId ||
        existing.sessionId !== payload.invocation.sessionId ||
        existing.taskId !== payload.runtimeContext.taskId ||
        existing.leaseId !== payload.runtimeContext.leaseId ||
        existing.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
        existing.invocationId !== payload.invocation.invocationId ||
        existing.invocationDigest !== invocationDigest
      ) {
        throw new Error("Gateway backup handoff was not durably prepared.");
      }
      const priorFence = existing.payload.backupAuthorization;
      if (
        executionBehaviorFingerprint(existing.payload) !== executionBehaviorFingerprint(payload) ||
        fingerprint(existing.payload.approvals as unknown as JsonValue) !==
          fingerprint(payload.approvals as unknown as JsonValue) ||
        optionalFingerprint(existing.payload.approvalAuthorization as unknown as JsonValue | undefined) !==
          optionalFingerprint(payload.approvalAuthorization as unknown as JsonValue | undefined) ||
        fingerprint(existing.payload.invocation as unknown as JsonValue) !==
          fingerprint(payload.invocation as unknown as JsonValue) ||
        (priorFence?.status === "succeeded" && payload.backupAuthorization?.status !== "succeeded") ||
        (priorFence?.status === "succeeded" &&
          payload.backupAuthorization?.status === "succeeded" &&
          fingerprint(stableBackupFenceBinding(priorFence) as unknown as JsonValue) !==
            fingerprint(stableBackupFenceBinding(payload.backupAuthorization) as unknown as JsonValue))
      ) {
        throw new Error("Gateway backup handoff authorization changed its exact binding.");
      }
      existing.payload = structuredClone(payload);
      if (existing.state === "awaiting-backup") existing.state = "awaiting-executor";
      existing.updatedAt = updatedAt;
      await this.persist();
    });
  }

  async markDispatching(
    payload: ExecuteWirePayload,
    runtimeId: string,
    updatedAt: string,
    expectedJournalSequence: number
  ): Promise<number> {
    await this.initialize();
    if (!ID.test(runtimeId) || !Number.isSafeInteger(expectedJournalSequence) || expectedJournalSequence < 0) {
      throw new Error("Gateway backup dispatch binding is invalid.");
    }
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    await this.exclusive(async () => {
      const existing = this.entries.get(key);
      if (!existing) throw new Error("Gateway backup dispatch has no durable handoff.");
      if (
        existing.runtimeId !== runtimeId ||
        existing.sessionId !== payload.invocation.sessionId ||
        existing.taskId !== payload.runtimeContext.taskId ||
        existing.leaseId !== payload.runtimeContext.leaseId ||
        existing.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
        existing.invocationId !== payload.invocation.invocationId ||
        existing.invocationDigest !== invocationDigest ||
        executePayloadFingerprint(existing.payload) !== executePayloadFingerprint(payload)
      ) {
        throw new Error("Gateway backup dispatch changed its exact handoff.");
      }
      if (existing.state === "dispatching") {
        if (existing.expectedJournalSequence === undefined) {
          throw new Error("Gateway backup dispatch lost its journal sequence checkpoint.");
        }
        return;
      }
      existing.state = "dispatching";
      existing.payload = structuredClone(payload);
      existing.updatedAt = updatedAt;
      existing.expectedJournalSequence = expectedJournalSequence;
      await this.persist();
    });
    const entry = this.entries.get(key);
    if (entry?.expectedJournalSequence === undefined) {
      throw new Error("Gateway backup dispatch lost its journal sequence checkpoint.");
    }
    return entry.expectedJournalSequence;
  }

  async markReady(payload: ExecuteWirePayload, runtimeId: string, updatedAt: string): Promise<void> {
    await this.initialize();
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    await this.exclusive(async () => {
      const existing = this.entries.get(key);
      if (
        !existing ||
        existing.runtimeId !== runtimeId ||
        existing.sessionId !== payload.invocation.sessionId ||
        existing.taskId !== payload.runtimeContext.taskId ||
        existing.leaseId !== payload.runtimeContext.leaseId ||
        existing.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
        existing.invocationId !== payload.invocation.invocationId ||
        existing.invocationDigest !== invocationDigest ||
        executePayloadFingerprint(existing.payload) !== executePayloadFingerprint(payload)
      ) {
        throw new Error("Gateway runtime execution terminal transition was fenced.");
      }
      existing.state = "awaiting-executor";
      existing.updatedAt = updatedAt;
      existing.expectedJournalSequence = undefined;
      await this.persist();
    });
  }

  async recordTerminal(
    payload: ExecuteWirePayload,
    result: ToolResult,
    journalSequence: number,
    terminalReceipt: BackupTerminalReceipt,
    updatedAt: string
  ): Promise<void> {
    await this.initialize();
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    const invocationDigest = await createInvocationDigest(payload.invocation);
    const parsedReceipt = parseBackupTerminalReceipt(terminalReceipt);
    if (
      result.invocationId !== payload.invocation.invocationId ||
      parsedReceipt.outcome !== (result.status === "succeeded" ? "committed" : result.status) ||
      parsedReceipt.invocationId !== payload.invocation.invocationId ||
      parsedReceipt.invocationDigest !== invocationDigest ||
      parsedReceipt.journalSequence !== journalSequence ||
      parsedReceipt.resultDigest !== fingerprint(result as unknown as JsonValue)
    ) {
      throw new Error("Gateway terminal evidence is not exact.");
    }
    await this.exclusive(async () => {
      const entry = this.entries.get(key);
      if (
        !entry ||
        entry.invocationDigest !== invocationDigest ||
        entry.runtimeId !== payload.runtimeContext.runtimeId ||
        entry.sessionId !== payload.invocation.sessionId ||
        entry.taskId !== payload.runtimeContext.taskId ||
        entry.leaseId !== payload.runtimeContext.leaseId ||
        entry.leaseGeneration !== payload.runtimeContext.leaseGeneration
      ) {
        throw new Error("Gateway terminal evidence changed its exact handoff binding.");
      }
      if (entry.terminalResult || entry.terminalReceipt || entry.terminalJournalSequence !== undefined) {
        const replacesIndeterminateWithCleanStart =
          entry.terminalResult?.status === "indeterminate" &&
          result.status === "failed" &&
          parsedReceipt.proofKind === "clean-start-no-active" &&
          typeof result.output === "object" &&
          result.output !== null &&
          !Array.isArray(result.output) &&
          result.output.code === "reconciliation-clean-start";
        if (
          canonicalJson(entry.terminalResult as unknown as JsonValue) !==
            canonicalJson(result as unknown as JsonValue) ||
          canonicalJson(entry.terminalReceipt as unknown as JsonValue) !==
            canonicalJson(parsedReceipt as unknown as JsonValue) ||
          entry.terminalJournalSequence !== journalSequence
        ) {
          if (!replacesIndeterminateWithCleanStart) {
            throw new Error("Gateway terminal evidence conflicts with durable evidence.");
          }
          entry.terminalJournalSequence = journalSequence;
          entry.terminalResult = structuredClone(result);
          entry.terminalReceipt = structuredClone(parsedReceipt);
          entry.updatedAt = updatedAt;
          await this.persist();
        }
        return;
      }
      entry.terminalJournalSequence = journalSequence;
      entry.terminalResult = structuredClone(result);
      entry.terminalReceipt = structuredClone(parsedReceipt);
      entry.updatedAt = updatedAt;
      await this.persist();
    });
  }

  async remove(key: string): Promise<void> {
    await this.initialize();
    await this.exclusive(async () => {
      if (!this.entries.delete(key)) return;
      await this.persist();
    });
  }

  async list(): Promise<PendingReconciliationEntry[]> {
    await this.initialize();
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  private hasConflictingRuntimeOwner(key: string): boolean {
    // A retained handoff is the runtime-wide owner until publication, fence
    // release, executor acknowledgement, and durable removal all complete.
    return [...this.entries.values()].some((candidate) => candidate.key !== key);
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      const before = new Map([...this.entries].map(([key, entry]) => [key, structuredClone(entry)] as const));
      try {
        await operation();
      } catch (error) {
        this.entries.clear();
        if (this.statePath) {
          this.initialized = false;
          await this.initialize();
        } else {
          for (const [key, entry] of before) this.entries.set(key, entry);
        }
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries: [...this.entries.values()] })}\n`);
    if (bytes.byteLength > MAX_PENDING_RECONCILIATION_BYTES) {
      throw new Error("Gateway reconciliation journal byte capacity is exhausted.");
    }
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.statePath);
      const directory = await open(path.dirname(this.statePath), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function commandFingerprint(body: WireCommand): string {
  return body.command === "reserve" || body.command === "execute" || body.command === "reconcile"
    ? executePayloadFingerprint(body.payload)
    : fingerprint(body as unknown as JsonValue);
}

function cancelledResult(invocationId: string, completedAt: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "cancelled",
    completedAt,
    summary: "Invocation cancelled.",
    output: { code: "cancelled" },
    evidence: [],
    mutationCommit: { committed: false },
  };
}

function reconciledNoEffectResult(invocationId: string, completedAt: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "cancelled",
    completedAt,
    summary: "Executor journal authoritatively established that the host effect never started.",
    output: { code: "reconciliation-no-effect", reconciliation: "completed", noEffect: true },
    evidence: [],
    mutationCommit: { committed: false },
  };
}

function indeterminateResult(invocationId: string, completedAt: string, point?: MutationCommit["point"]): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "indeterminate",
    completedAt,
    summary: "Host effect completion is indeterminate; automatic retry is fenced.",
    output: {
      code: "indeterminate-effect",
      reconciliation: "required",
      ...(point ? { commitPoint: point } : {}),
    },
    evidence: [],
    ...(point ? { mutationCommit: { committed: true, point } } : {}),
  };
}

function isWaitingResult(result: ToolResult): boolean {
  const output = result.output;
  return (
    result.status === "failed" &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    (output.code === "approval-required" ||
      output.code === "backup-required" ||
      output.code === "invocation-authorization-required")
  );
}

export interface ExecutorProtocolServerOptions {
  socketPath: string;
  gatewayPublicKey: KeyLike;
  /** Control-plane public key; unlike the gateway key, its private half never exists on EC2. */
  backupFencePublicKey?: KeyLike;
  executor: DirectLiveExecutor;
  /** Atomic journal file inside the executor StateDirectory. */
  statePath?: string;
  /** Exact 32-byte HMAC key loaded only into the executor credential namespace. */
  journalAuthenticationKey: Uint8Array;
  /** Executor-only Ed25519 key loaded through this service's credential namespace. */
  executorReceiptPrivateKey: KeyLike;
  /** SHA-256-derived ID pinned with the public verifier in Worker configuration. */
  executorReceiptKeyId: string;
  /** Monotonic receipt-key epoch pinned with executorReceiptKeyId. */
  executorReceiptKeyEpoch?: number;
  /** Root-rotated epoch proving an earlier executor cgroup was deliberately hard-stopped. */
  executorEpoch: string;
  /** Test-only fault seam used to prove committed results survive a lost socket response. */
  dropCommittedResponse?: (result: ToolResult) => boolean;
  /** Test-only seam used to hold journal registration after the invocation is cancellation-visible. */
  beforeJournalBegin?: (invocationId: string) => void | Promise<void>;
  /** Test-only observer for proving transport retries retain the exact request identity and body. */
  observeAuthenticatedRequest?: (request: { requestId: string; body: JsonValue }) => void;
  now?: () => Date;
  /** PID 1-owned systemd socket activation descriptor. Tests may omit it and bind a private path. */
  listenFd?: number;
}

export function systemdSocketActivationFd(
  expectedName: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  pid = process.pid
): number {
  if (
    environment.LISTEN_PID !== String(pid) ||
    environment.LISTEN_FDS !== "1" ||
    environment.LISTEN_FDNAMES !== expectedName
  ) {
    throw new Error("Exactly one named systemd socket activation descriptor is required.");
  }
  return 3;
}

export class ExecutorProtocolServer {
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      fence?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
      fenceRevoked: boolean;
    }
  >();
  private readonly requests = new Map<string, { fingerprint: string; response: Promise<WireResponse> }>();
  private readonly invocations = new Map<
    string,
    {
      invocationDigest: string;
      effectFingerprint: string;
      identity: JournalInFlightIdentity;
      response: Promise<WireResponse>;
    }
  >();
  private readonly nonces = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private readonly now: () => Date;
  private readonly journal: ExecutorEffectJournal;

  constructor(private readonly options: ExecutorProtocolServerOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new TypeError("Executor socket path must be absolute.");
    if (options.listenFd !== undefined && (!Number.isSafeInteger(options.listenFd) || options.listenFd < 3)) {
      throw new TypeError("Executor inherited socket descriptor is invalid.");
    }
    if (
      !ID.test(options.executorReceiptKeyId) ||
      !ID.test(options.executorEpoch) ||
      (options.executorReceiptKeyEpoch !== undefined &&
        (!Number.isSafeInteger(options.executorReceiptKeyEpoch) || options.executorReceiptKeyEpoch < 1))
    ) {
      throw new TypeError("Executor receipt signing identity is invalid.");
    }
    this.now = options.now ?? (() => new Date());
    this.journal = new ExecutorEffectJournal(options.statePath, {
      now: this.now,
      authenticationKey: options.journalAuthenticationKey,
    });
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error("Executor protocol server is already listening.");
    await this.journal.initialize();
    if (this.options.listenFd === undefined) await removeOwnedStaleUnixSocket(this.options.socketPath);
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void this.handle(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server?.once("error", onError);
      this.server?.listen(
        this.options.listenFd === undefined ? this.options.socketPath : { fd: this.options.listenFd },
        () => {
          this.server?.off("error", onError);
          resolve();
        }
      );
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const active of this.active.values()) active.controller.abort();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(socket: Socket): Promise<void> {
    let requestId = "invalid";
    try {
      const request = parseRequest(await readOne(socket));
      requestId = request.requestId;
      const unsigned = {
        schemaVersion: request.schemaVersion,
        requestId: request.requestId,
        nonce: request.nonce,
        issuedAt: request.issuedAt,
        body: request.body,
      } as const;
      const signature = Buffer.from(request.signature, "base64url");
      if (!verify(null, Buffer.from(signedContent(unsigned)), this.options.gatewayPublicKey, signature)) {
        return this.send(socket, { schemaVersion: 1, requestId, ok: false, error: "unauthorized" });
      }
      const now = this.now().getTime();
      if (Math.abs(now - Date.parse(request.issuedAt)) > MAX_CLOCK_SKEW_MS || this.nonces.has(request.nonce)) {
        return this.send(socket, { schemaVersion: 1, requestId, ok: false, error: "replay" });
      }
      this.nonces.set(request.nonce, now);
      while (this.nonces.size > MAX_REPLAY_ENTRIES) this.nonces.delete(this.nonces.keys().next().value as string);
      this.options.observeAuthenticatedRequest?.({
        requestId: request.requestId,
        body: structuredClone(request.body) as unknown as JsonValue,
      });

      const bodyFingerprint = commandFingerprint(request.body);
      const prior = this.requests.get(request.requestId);
      if (prior) {
        if (!timingSafeEqual(Buffer.from(prior.fingerprint), Buffer.from(bodyFingerprint))) {
          return this.send(socket, { schemaVersion: 1, requestId, ok: false, error: "replay" });
        }
        return this.send(socket, await prior.response);
      }
      const response = this.execute(request.requestId, request.body);
      this.requests.set(request.requestId, { fingerprint: bodyFingerprint, response });
      while (this.requests.size > MAX_REPLAY_ENTRIES) this.requests.delete(this.requests.keys().next().value as string);
      return this.send(socket, await response);
    } catch {
      return this.send(socket, { schemaVersion: 1, requestId, ok: false, error: "invalid-request" });
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact protocol authorization, replay binding, reconciliation, and execution registration must remain visibly fail-closed in one dispatcher.
  private async execute(requestId: string, body: WireCommand): Promise<WireResponse> {
    if (body.command === "checkpoint") {
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        journalSequence: await this.journal.currentSequence(),
      };
    }
    if (body.command === "effect-status") {
      const journalIdentity = await this.journal.inFlight();
      const activeIdentities = [...this.invocations.values()].map((invocation) => invocation.identity);
      if (activeIdentities.length > 1) throw new Error("Executor has multiple active runtime effects.");
      const activeIdentity = activeIdentities[0];
      if (
        journalIdentity &&
        activeIdentity &&
        (journalIdentity.invocationId !== activeIdentity.invocationId ||
          journalIdentity.invocationDigest !== activeIdentity.invocationDigest ||
          journalIdentity.taskId !== activeIdentity.taskId ||
          journalIdentity.leaseGeneration !== activeIdentity.leaseGeneration)
      ) {
        throw new Error("Executor active effect and authenticated journal identity diverged.");
      }
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        inFlight: journalIdentity ?? activeIdentity ?? null,
        journalSequence: await this.journal.currentSequence(),
      };
    }
    if (body.command === "acknowledge-terminal") {
      const authorization = parseTerminalPublicationAuthorization(body.payload.authorization);
      const { signature, ...unsignedAuthorization } = authorization;
      if (
        !this.options.backupFencePublicKey ||
        !verify(
          null,
          Buffer.from(terminalPublicationSignedContent(unsignedAuthorization)),
          this.options.backupFencePublicKey,
          Buffer.from(signature, "base64url")
        )
      ) {
        return { schemaVersion: 1, requestId, ok: false, error: "unauthorized" };
      }
      await this.journal.acknowledgeTerminal(body.payload);
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        journalSequence: await this.journal.currentSequence(),
      };
    }
    if (body.command === "cancel") {
      const invocationKey = scopedInvocationKey(body.payload.runtimeContext, body.payload.invocationId);
      const active = this.active.get(invocationKey);
      active?.controller.abort();
      const invocation = body.payload.invocation;
      const invocationDigest = body.payload.invocationDigest;
      if (invocation && (!invocationDigest || fingerprint(invocation as unknown as JsonValue) !== invocationDigest)) {
        return { schemaVersion: 1, requestId, ok: false, error: "replay" };
      }
      const cancelled = await this.journal.cancel(
        body.payload.invocationId,
        this.now().toISOString(),
        body.payload.runtimeContext,
        invocationDigest && body.payload.effectFingerprint
          ? { invocationDigest, effectFingerprint: body.payload.effectFingerprint }
          : undefined
      );
      if (!cancelled.result || !invocation) return { schemaVersion: 1, requestId, ok: true };
      const cancellationPayload = {
        actorId: "executor-cancellation",
        invocation,
        policy: {} as ExecuteWirePayload["policy"],
        approvals: [],
        runtimeContext: body.payload.runtimeContext,
        ...(body.payload.backupAuthorization ? { backupAuthorization: body.payload.backupAuthorization } : {}),
      } as ExecuteWirePayload;
      const terminalReceipt = await this.terminalReceipt(
        cancellationPayload,
        cancelled.result,
        "terminal",
        active?.fence ?? body.payload.backupAuthorization
      );
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        result: cancelled.result,
        ...(terminalReceipt ? { terminalReceipt } : {}),
        ...(cancelled.journalSequence ? { terminalJournalSequence: cancelled.journalSequence } : {}),
        journalSequence: await this.journal.currentSequence(),
      };
    }
    if (body.command === "revoke-fence") {
      const invocationKey = scopedInvocationKey(body.payload.runtimeContext, body.payload.invocationId);
      const active = this.active.get(invocationKey);
      if (active) {
        active.fenceRevoked = true;
        active.controller.abort();
      }
      return { schemaVersion: 1, requestId, ok: true };
    }
    if (body.command === "renew-fence") {
      const invocationKey = scopedInvocationKey(body.payload.runtimeContext, body.payload.invocationId);
      const active = this.active.get(invocationKey);
      const authorization = body.payload.authorization;
      if (
        !active?.fence ||
        active.fenceRevoked ||
        !this.options.backupFencePublicKey ||
        !this.verifyFenceSignature(authorization) ||
        fingerprint(stableBackupFenceBinding(active.fence) as unknown as JsonValue) !==
          fingerprint(stableBackupFenceBinding(authorization) as unknown as JsonValue) ||
        authorization.lifecycleLeaseGeneration < active.fence.lifecycleLeaseGeneration ||
        (authorization.lifecycleLeaseGeneration === active.fence.lifecycleLeaseGeneration &&
          authorization.signature !== active.fence.signature) ||
        Date.parse(authorization.expiresAt) <= this.now().getTime()
      ) {
        return { schemaVersion: 1, requestId, ok: false, error: "unauthorized" };
      }
      if (!this.fenceUsesCurrentReceiptKey(authorization)) {
        return { schemaVersion: 1, requestId, ok: false, error: "unauthorized" };
      }
      active.fence = authorization;
      return { schemaVersion: 1, requestId, ok: true };
    }
    const invocation = body.payload.invocation;
    const invocationDigest = fingerprint(invocation as unknown as JsonValue);
    const effectFingerprint = executePayloadFingerprint(body.payload);
    const downloadAuthorization = body.payload.downloadAuthorization;
    const backupAuthorization = body.payload.backupAuthorization;
    const approvalAuthorization = body.payload.approvalAuthorization;
    if (
      approvalAuthorization &&
      (approvalAuthorization.runtimeId !== body.payload.runtimeContext.runtimeId ||
        approvalAuthorization.leaseId !== body.payload.runtimeContext.leaseId ||
        approvalAuthorization.leaseGeneration !== body.payload.runtimeContext.leaseGeneration ||
        approvalAuthorization.taskId !== body.payload.runtimeContext.taskId ||
        approvalAuthorization.sessionId !== invocation.sessionId ||
        approvalAuthorization.invocationId !== invocation.invocationId ||
        approvalAuthorization.invocationDigest !== invocationDigest)
    ) {
      return { schemaVersion: 1, requestId, ok: false, error: "unauthorized" };
    }
    if (backupAuthorization?.status === "succeeded") {
      const { signature, ...unsigned } = backupAuthorization;
      if (
        !this.options.backupFencePublicKey ||
        !verify(
          null,
          Buffer.from(backupFenceSignedContent(unsigned)),
          this.options.backupFencePublicKey,
          Buffer.from(signature, "base64url")
        ) ||
        !body.payload.runtimeContext ||
        backupAuthorization.runtimeId !== body.payload.runtimeContext.runtimeId ||
        backupAuthorization.leaseId !== body.payload.runtimeContext.leaseId ||
        backupAuthorization.leaseGeneration !== body.payload.runtimeContext.leaseGeneration ||
        backupAuthorization.taskId !== body.payload.runtimeContext.taskId ||
        backupAuthorization.sessionId !== invocation.sessionId ||
        backupAuthorization.invocationId !== invocation.invocationId ||
        backupAuthorization.invocationDigest !== invocationDigest ||
        ((body.command === "reserve" || body.command === "execute") &&
          Date.parse(backupAuthorization.expiresAt) <= this.now().getTime()) ||
        (body.command !== "reconcile" && !this.fenceUsesCurrentReceiptKey(backupAuthorization))
      ) {
        return { schemaVersion: 1, requestId, ok: false, error: "unauthorized" };
      }
    }
    if (
      (invocation.toolId === "network.download" &&
        invocation.capability === "network.outbound" &&
        !downloadAuthorization) ||
      (downloadAuthorization &&
        (!verify(
          null,
          Buffer.from(
            canonicalize(
              Object.fromEntries(
                Object.entries(downloadAuthorization).filter(([key]) => key !== "signature")
              ) as unknown as JsonValue
            )
          ),
          this.options.gatewayPublicKey,
          Buffer.from(downloadAuthorization.signature, "base64url")
        ) ||
          downloadAuthorization.invocationId !== invocation.invocationId ||
          downloadAuthorization.sessionId !== invocation.sessionId ||
          downloadAuthorization.invocationDigest !== invocationDigest ||
          downloadAuthorization.requestFingerprint !== effectFingerprint))
    ) {
      return { schemaVersion: 1, requestId, ok: false, error: "invalid-request" };
    }
    const invocationKey = scopedInvocationKey(body.payload.runtimeContext, invocation.invocationId);
    if (body.command === "reserve") {
      const reserved = await this.journal.reserve(
        invocation.invocationId,
        invocationDigest,
        effectFingerprint,
        journalAttemptContext(body.payload, this.options.executorEpoch)
      );
      if (reserved.outcome === "reject") {
        return { schemaVersion: 1, requestId, ok: false, error: "replay" };
      }
      if (reserved.outcome === "runtime-fenced") {
        return { schemaVersion: 1, requestId, ok: false, error: "runtime-fenced", inFlight: reserved.owner };
      }
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        reconciliation: "reserved",
        journalSequence: reserved.journalSequence,
      };
    }
    const active = this.invocations.get(invocationKey);
    const activeFence = this.active.get(invocationKey)?.fence;
    if (body.command === "reconcile") {
      if (active && (active.invocationDigest !== invocationDigest || active.effectFingerprint !== effectFingerprint)) {
        return { schemaVersion: 1, requestId, ok: false, error: "replay" };
      }
      const reconciled = await this.journal.reconcile(
        invocation.invocationId,
        invocationDigest,
        effectFingerprint,
        journalAttemptContext(body.payload, this.options.executorEpoch),
        Boolean(active)
      );
      if (reconciled.outcome === "reject") {
        return { schemaVersion: 1, requestId, ok: false, error: "replay" };
      }
      if (reconciled.outcome === "terminal") {
        const terminal = await this.journal.terminalAttestation(
          body.payload.invocation.invocationId,
          body.payload.runtimeContext,
          reconciled.result
        );
        const receiptFence = activeFence ?? body.payload.backupAuthorization;
        const terminalReceipt = await this.terminalReceipt(
          body.payload,
          reconciled.result,
          reconciled.proofKind,
          receiptFence?.status === "succeeded" && this.fenceUsesCurrentReceiptKey(receiptFence)
            ? receiptFence
            : undefined
        );
        return {
          schemaVersion: 1,
          requestId,
          ok: true,
          result: reconciled.result,
          ...(terminalReceipt ? { terminalReceipt } : {}),
          terminalJournalSequence: terminal.journalSequence,
          journalSequence: await this.journal.currentSequence(),
        };
      }
      if (reconciled.outcome === "not-started") {
        return {
          schemaVersion: 1,
          requestId,
          ok: true,
          reconciliation: "not-started",
          journalSequence: await this.journal.currentSequence(),
        };
      }
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        reconciliation: reconciled.outcome,
        journalSequence: await this.journal.currentSequence(),
      };
    }
    if (active) {
      if (active.invocationDigest !== invocationDigest || active.effectFingerprint !== effectFingerprint) {
        return { schemaVersion: 1, requestId, ok: false, error: "replay" };
      }
      const response = await active.response;
      return { ...response, requestId };
    }
    const activeInvocation = {
      controller: new AbortController(),
      fence: backupAuthorization?.status === "succeeded" ? backupAuthorization : undefined,
      fenceRevoked: false,
    };
    this.active.set(invocationKey, activeInvocation);
    const run = this.executeInvocation(requestId, body.payload, invocationDigest, effectFingerprint, activeInvocation);
    this.invocations.set(invocationKey, {
      invocationDigest,
      effectFingerprint,
      identity: {
        invocationId: invocation.invocationId,
        invocationDigest,
        taskId: body.payload.runtimeContext.taskId,
        leaseGeneration: body.payload.runtimeContext.leaseGeneration,
        status: "in-progress",
        updatedAt: this.now().toISOString(),
      },
      response: run,
    });
    try {
      return await run;
    } finally {
      this.invocations.delete(invocationKey);
      if (this.active.get(invocationKey) === activeInvocation) this.active.delete(invocationKey);
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Journal terminalization and receipt construction must remain one fail-closed boundary.
  private async executeInvocation(
    requestId: string,
    payload: ExecuteWirePayload,
    invocationDigest: string,
    effectFingerprint: string,
    activeInvocation: {
      controller: AbortController;
      fence?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
      fenceRevoked: boolean;
    }
  ): Promise<WireResponse> {
    await this.options.beforeJournalBegin?.(payload.invocation.invocationId);
    let committedFence: Extract<GatewayBackupAuthorization, { status: "succeeded" }> | undefined;
    const journalContext = journalAttemptContext(payload, this.options.executorEpoch);
    const begun = await this.journal.begin(
      payload.invocation.invocationId,
      invocationDigest,
      effectFingerprint,
      journalContext
    );
    if (begun.outcome === "reject") return { schemaVersion: 1, requestId, ok: false, error: "replay" };
    if (begun.outcome === "runtime-fenced") {
      return { schemaVersion: 1, requestId, ok: false, error: "runtime-fenced", inFlight: begun.owner };
    }
    if (begun.outcome === "replay") {
      const terminal = isWaitingResult(begun.result)
        ? undefined
        : await this.journal.terminalAttestation(payload.invocation.invocationId, payload.runtimeContext, begun.result);
      const terminalReceipt = await this.terminalReceipt(payload, begun.result, "terminal", activeInvocation.fence);
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        result: begun.result,
        ...(terminalReceipt ? { terminalReceipt } : {}),
        ...(terminal ? { terminalJournalSequence: terminal.journalSequence } : {}),
        journalSequence: await this.journal.currentSequence(),
      };
    }
    try {
      const result = agentSchemas.toolResult.parse(
        await boundToolResult(
          await this.options.executor.execute({
            ...payload,
            signal: activeInvocation.controller.signal,
            assertCommitAllowed:
              payload.backupAuthorization?.status === "succeeded"
                ? async () => {
                    await this.assertCommitFence(activeInvocation, payload);
                    // Snapshot the exact signed authorization which passed the
                    // immediate pre-commit check. A later renewal must not
                    // relabel an already-entered host commit.
                    committedFence = structuredClone(activeInvocation.fence);
                  }
                : undefined,
          })
        )
      );
      try {
        await this.journal.commit(
          payload.invocation.invocationId,
          invocationDigest,
          effectFingerprint,
          result,
          payload.runtimeContext
        );
        const terminal = isWaitingResult(result)
          ? undefined
          : await this.journal.terminalAttestation(payload.invocation.invocationId, payload.runtimeContext, result);
        const terminalReceipt = await this.terminalReceipt(
          payload,
          result,
          "terminal",
          committedFence ?? activeInvocation.fence
        );
        return {
          schemaVersion: 1,
          requestId,
          ok: true,
          result,
          ...(terminalReceipt ? { terminalReceipt } : {}),
          ...(terminal ? { terminalJournalSequence: terminal.journalSequence } : {}),
          journalSequence: await this.journal.currentSequence(),
        };
      } catch {
        const uncertain = indeterminateResult(payload.invocation.invocationId, this.now().toISOString());
        await this.journal
          .commit(
            payload.invocation.invocationId,
            invocationDigest,
            effectFingerprint,
            uncertain,
            payload.runtimeContext
          )
          .catch(() => undefined);
        const terminal = await this.journal.terminalAttestation(
          payload.invocation.invocationId,
          payload.runtimeContext,
          uncertain
        );
        const terminalReceipt = await this.terminalReceipt(
          payload,
          uncertain,
          "terminal",
          committedFence ?? activeInvocation.fence
        );
        return {
          schemaVersion: 1,
          requestId,
          ok: true,
          result: uncertain,
          ...(terminalReceipt ? { terminalReceipt } : {}),
          terminalJournalSequence: terminal.journalSequence,
          journalSequence: await this.journal.currentSequence(),
        };
      }
    } catch (error) {
      const result =
        error instanceof DOMException && error.name === "AbortError"
          ? cancelledResult(payload.invocation.invocationId, this.now().toISOString())
          : indeterminateResult(
              payload.invocation.invocationId,
              this.now().toISOString(),
              error instanceof IndeterminateHostEffectError ? error.point : undefined
            );
      await this.journal
        .commit(payload.invocation.invocationId, invocationDigest, effectFingerprint, result, payload.runtimeContext)
        .catch(() => undefined);
      const terminal = await this.journal.terminalAttestation(
        payload.invocation.invocationId,
        payload.runtimeContext,
        result
      );
      const terminalReceipt = await this.terminalReceipt(
        payload,
        result,
        "terminal",
        committedFence ?? activeInvocation.fence
      );
      return {
        schemaVersion: 1,
        requestId,
        ok: true,
        result,
        ...(terminalReceipt ? { terminalReceipt } : {}),
        terminalJournalSequence: terminal.journalSequence,
        journalSequence: await this.journal.currentSequence(),
      };
    }
  }

  private verifyFenceSignature(authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>): boolean {
    if (!this.options.backupFencePublicKey) return false;
    const { signature, ...unsigned } = authorization;
    return verify(
      null,
      Buffer.from(backupFenceSignedContent(unsigned)),
      this.options.backupFencePublicKey,
      Buffer.from(signature, "base64url")
    );
  }

  private async terminalReceipt(
    payload: ExecuteWirePayload,
    result: ToolResult,
    proofKind: BackupTerminalReceipt["proofKind"] = "terminal",
    committedFence?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<BackupTerminalReceipt | undefined> {
    if (isWaitingResult(result)) return undefined;
    const authorization = committedFence;
    const attestation = await this.journal.terminalAttestation(
      payload.invocation.invocationId,
      payload.runtimeContext,
      result
    );
    if (attestation.terminalReceipt) return attestation.terminalReceipt;
    if (payload.backupAuthorization?.status === "succeeded" && !authorization) {
      throw new Error("Executor terminal receipt for a rotated fence was not retained.");
    }
    const outcome =
      result.status === "succeeded"
        ? "committed"
        : result.status === "failed"
          ? "failed"
          : result.status === "cancelled"
            ? "cancelled"
            : "indeterminate";
    const unsigned = {
      schemaVersion: 1,
      source: "executor-journal",
      proofKind,
      outcome,
      executorKeyId: this.options.executorReceiptKeyId,
      ...(this.options.executorReceiptKeyEpoch !== undefined
        ? { executorKeyEpoch: this.options.executorReceiptKeyEpoch }
        : {}),
      executorEpoch: this.options.executorEpoch,
      runtimeId: payload.runtimeContext.runtimeId,
      leaseId: payload.runtimeContext.leaseId,
      leaseGeneration: payload.runtimeContext.leaseGeneration,
      sessionId: payload.invocation.sessionId,
      taskId: payload.runtimeContext.taskId,
      invocationId: payload.invocation.invocationId,
      invocationDigest: fingerprint(payload.invocation as unknown as JsonValue),
      ...(authorization
        ? {
            backupId: authorization.backupId,
            lifecycleLockId: authorization.lifecycleLockId,
            lifecycleFencingToken: authorization.lifecycleFencingToken,
            lifecycleLeaseGeneration: authorization.lifecycleLeaseGeneration,
          }
        : {}),
      resultDigest: fingerprint(result as unknown as JsonValue),
      journalSequence: attestation.journalSequence,
      completedAt: result.completedAt,
      ...(authorization ? { fenceIssuedAt: authorization.issuedAt } : {}),
    } as const;
    const signature = sign(
      null,
      Buffer.from(executorReceiptSignedContent(unsigned as UnsignedBackupTerminalReceipt)),
      this.options.executorReceiptPrivateKey
    ).toString("base64url");
    const receipt = { ...unsigned, signature };
    parseBackupTerminalReceipt(receipt);
    encodedJsonLine(receipt, MAX_TERMINAL_RECEIPT_BYTES);
    await this.journal.recordTerminalReceipt(payload.invocation.invocationId, payload.runtimeContext, result, receipt);
    return receipt;
  }

  private async assertCommitFence(
    active: {
      fence?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
      fenceRevoked: boolean;
    },
    payload: ExecuteWirePayload
  ): Promise<void> {
    const fence = active.fence;
    if (
      active.fenceRevoked ||
      !fence ||
      !this.verifyFenceSignature(fence) ||
      !this.fenceUsesCurrentReceiptKey(fence) ||
      fence.invocationId !== payload.invocation.invocationId ||
      fence.taskId !== payload.runtimeContext.taskId ||
      fence.leaseGeneration !== payload.runtimeContext.leaseGeneration ||
      Date.parse(fence.expiresAt) <= this.now().getTime()
    ) {
      throw new Error("Renewable lifecycle fence ownership was lost before commit.");
    }
  }

  private fenceUsesCurrentReceiptKey(fence: Extract<GatewayBackupAuthorization, { status: "succeeded" }>): boolean {
    if (this.options.executorReceiptKeyEpoch === undefined) {
      // Legacy/unit-test servers do not have a provisioned key-epoch file. A
      // production executor always supplies the epoch and therefore never
      // takes this compatibility path.
      return fence.executorKeyId === undefined && fence.executorKeyEpoch === undefined;
    }
    return (
      fence.executorKeyId === this.options.executorReceiptKeyId &&
      this.options.executorReceiptKeyEpoch !== undefined &&
      fence.executorKeyEpoch === this.options.executorReceiptKeyEpoch
    );
  }

  private send(socket: Socket, response: WireResponse): void {
    try {
      if (response.result && this.options.dropCommittedResponse?.(response.result)) {
        socket.destroy();
        return;
      }
      socket.end(encode(response));
    } catch {
      // Never leave a peer retrying an unencodable terminal payload. The
      // fallback is intentionally small and contains no reflected data.
      try {
        socket.end(
          encode({
            schemaVersion: 1,
            requestId: response.requestId,
            ok: false,
            error: "executor-failed",
          })
        );
      } catch {
        socket.destroy();
      }
    }
  }
}

export interface ExecutorProtocolClientOptions {
  socketPath: string;
  gatewayPrivateKey: KeyLike;
  now?: () => Date;
  createId?: () => string;
  downloadRelay?: GatewayDownloadRelayAuthorizer;
  reconciliationAttempts?: number;
  responseTimeoutMs?: number;
  reconciliationDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Protected gateway StateDirectory file used to resume fence reconciliation after restart. */
  reconciliationStatePath?: string;
}

export interface PendingExecutorReconciliation {
  key: string;
  runtimeId: string;
  sessionId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  state: PendingReconciliationEntry["state"];
  request: ExecuteInvocationRequest;
  executorStatus?: "active" | "pending" | "reserved" | "terminal" | "not-started";
  result?: ToolResult;
  expectedJournalSequence?: number;
  terminalReceipt?: BackupTerminalReceipt;
}

export interface ExecutorCancellationResult {
  result?: ToolResult;
  terminalReceipt?: BackupTerminalReceipt;
  terminalJournalSequence?: number;
}

export class ExecutorProtocolClient implements DirectLiveExecutor {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly reconciliationAttempts: number;
  private readonly responseTimeoutMs: number;
  private readonly reconciliationDelayMs: number;
  private readonly pause: (milliseconds: number) => Promise<void>;
  private readonly pendingBodies = new Map<string, WireCommand & { command: "execute" }>();
  private readonly pendingJournalSequences = new Map<string, number>();
  private readonly terminalReceipts = new Map<string, BackupTerminalReceipt>();
  private readonly terminalAcknowledgements = new Map<
    string,
    Omit<JournalTerminalPublicationAcknowledgement, "authorization"> & { status: ToolResult["status"] }
  >();
  private readonly runtimeIds = new Map<string, string>();
  private readonly reconciliationJournal: ClientReconciliationJournal;
  private readonly durableReconciliation: boolean;
  readonly reconciliationTimeoutMs: number;

  constructor(private readonly options: ExecutorProtocolClientOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new TypeError("Executor socket path must be absolute.");
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString("hex"));
    this.reconciliationAttempts = options.reconciliationAttempts ?? DEFAULT_RECONCILIATION_ATTEMPTS;
    if (
      !Number.isSafeInteger(this.reconciliationAttempts) ||
      this.reconciliationAttempts < 1 ||
      this.reconciliationAttempts > MAX_RECONCILIATION_ATTEMPTS
    ) {
      throw new TypeError("Executor reconciliation attempt bound is invalid.");
    }
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.responseTimeoutMs) ||
      this.responseTimeoutMs < 1 ||
      this.responseTimeoutMs > MAX_RESPONSE_TIMEOUT_MS
    ) {
      throw new TypeError("Executor response timeout bound is invalid.");
    }
    this.reconciliationDelayMs = options.reconciliationDelayMs ?? DEFAULT_RECONCILIATION_DELAY_MS;
    if (
      !Number.isSafeInteger(this.reconciliationDelayMs) ||
      this.reconciliationDelayMs < 1 ||
      this.reconciliationDelayMs > MAX_RECONCILIATION_DELAY_MS
    ) {
      throw new TypeError("Executor reconciliation delay bound is invalid.");
    }
    this.pause = options.sleep ?? ((milliseconds) => this.sleep(milliseconds));
    this.reconciliationJournal = new ClientReconciliationJournal(options.reconciliationStatePath);
    this.durableReconciliation = options.reconciliationStatePath !== undefined;
    this.reconciliationTimeoutMs =
      this.responseTimeoutMs * this.reconciliationAttempts +
      this.reconciliationDelayMs * (2 ** (this.reconciliationAttempts - 1) - 1);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact authorization construction, cancellation, transport reconciliation, and relay revocation form one request lifecycle.
  async execute(request: ExecuteInvocationRequest): Promise<ToolResult> {
    if (request.signal?.aborted) {
      return cancelledResult(request.invocation.invocationId, this.now().toISOString());
    }
    if (!request.runtimeContext) throw new Error("Executor protocol requires task-scoped runtime context.");
    const payload = this.executionPayload(request);
    const requestFingerprint = executePayloadFingerprint(payload);
    const invocationDigest = fingerprint(request.invocation as unknown as JsonValue);
    const backupAuthorization = request.backupAuthorization;
    const approvalAuthorization = request.approvalAuthorization;
    if (
      approvalAuthorization &&
      (approvalAuthorization.runtimeId !== request.runtimeContext.runtimeId ||
        approvalAuthorization.leaseId !== request.runtimeContext.leaseId ||
        approvalAuthorization.leaseGeneration !== request.runtimeContext.leaseGeneration ||
        approvalAuthorization.taskId !== request.runtimeContext.taskId ||
        approvalAuthorization.sessionId !== request.invocation.sessionId ||
        approvalAuthorization.invocationId !== request.invocation.invocationId ||
        approvalAuthorization.invocationDigest !== invocationDigest)
    ) {
      throw new Error("Executor protocol failed closed.");
    }
    if (
      backupAuthorization?.status === "succeeded" &&
      (backupAuthorization.leaseId !== request.runtimeContext.leaseId ||
        backupAuthorization.leaseGeneration !== request.runtimeContext.leaseGeneration ||
        backupAuthorization.taskId !== request.runtimeContext.taskId ||
        backupAuthorization.sessionId !== request.invocation.sessionId ||
        backupAuthorization.invocationId !== request.invocation.invocationId ||
        backupAuthorization.invocationDigest !== invocationDigest)
    ) {
      throw new Error("Executor protocol failed closed.");
    }
    const downloadAuthorization = this.authorizeDownload(request, invocationDigest, requestFingerprint);
    const body: WireCommand = {
      schemaVersion: 1,
      command: "execute",
      payload: { ...payload, ...(downloadAuthorization ? { downloadAuthorization } : {}) },
    };
    // Do this before claiming/persisting a handoff. A payload that cannot fit
    // the signed envelope must never become a durable entry which reconciliation
    // would retry forever.
    assertJsonBytes(body, MAX_PROTOCOL_PAYLOAD_BYTES, "executor request");
    const pendingKey = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    const runtimeId = this.runtimeIds.get(pendingKey) ?? request.runtimeContext.runtimeId;
    try {
      await this.reconciliationJournal.claim(body.payload, runtimeId, this.now().toISOString());
    } catch (error) {
      throw new Error("Executor protocol failed closed.", { cause: error });
    }
    this.runtimeIds.set(pendingKey, runtimeId);
    let reservationSequence: number;
    try {
      reservationSequence = await this.reserveJournalEntry(body.payload);
    } catch (error) {
      if (error instanceof Error && error.message.includes("runtime-wide effect fence")) {
        await this.completeReconciliation(request.invocation.invocationId, request.runtimeContext);
        throw error;
      }
      if (error instanceof Error && error.message === "Executor protocol failed closed.") throw error;
      if (downloadAuthorization) this.options.downloadRelay?.revoke(downloadAuthorization.authorizationId);
      return indeterminateResult(request.invocation.invocationId, this.now().toISOString());
    }
    const expectedJournalSequence = await this.reconciliationJournal.markDispatching(
      body.payload,
      runtimeId,
      this.now().toISOString(),
      reservationSequence
    );
    this.pendingBodies.set(pendingKey, body as WireCommand & { command: "execute" });
    this.pendingJournalSequences.set(pendingKey, expectedJournalSequence);
    const requestId = `execute-${requestFingerprint}`;
    const onAbort = () => void this.cancel(request.invocation.invocationId, request.runtimeContext);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let needsReconciliation = false;
      for (let attempt = 1; attempt <= this.reconciliationAttempts; attempt++) {
        try {
          const outbound: WireCommand = needsReconciliation ? { ...body, command: "reconcile" } : body;
          const response = await this.send(
            needsReconciliation ? `reconcile-${requestFingerprint.slice(0, 48)}-${this.createId()}` : requestId,
            outbound
          );
          if (!response.ok && response.error === "runtime-fenced") {
            await this.completeReconciliation(request.invocation.invocationId, request.runtimeContext);
            throw new Error("Executor runtime-wide effect fence rejected a distinct concurrent invocation.");
          }
          if (!response.ok) throw new Error("Executor protocol failed closed.");
          const expectedJournalSequence = this.pendingJournalSequences.get(pendingKey);
          if (
            expectedJournalSequence !== undefined &&
            (response.journalSequence === undefined || response.journalSequence < expectedJournalSequence)
          ) {
            needsReconciliation = true;
          } else if (response.result) {
            const result = agentSchemas.toolResult.parse(response.result);
            if (isWaitingResult(result)) {
              await this.reconciliationJournal.markReady(body.payload, runtimeId, this.now().toISOString());
              this.pendingJournalSequences.delete(pendingKey);
            }
            if (response.terminalReceipt) this.terminalReceipts.set(pendingKey, response.terminalReceipt);
            this.rememberTerminalAcknowledgement(body.payload, result, response.terminalJournalSequence);
            if (response.terminalReceipt) {
              await this.reconciliationJournal.recordTerminal(
                body.payload,
                result,
                response.terminalJournalSequence as number,
                response.terminalReceipt,
                this.now().toISOString()
              );
            }
            return result;
          } else if (!needsReconciliation || !response.reconciliation) {
            throw new Error("Executor protocol failed closed.");
          } else if (response.reconciliation === "reserved") {
            needsReconciliation = false;
          } else if (response.reconciliation === "not-started" && expectedJournalSequence === undefined) {
            needsReconciliation = false;
          } else {
            needsReconciliation = true;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message === "Executor protocol failed closed." ||
              error.message === "Executor protocol message exceeded the encoded byte budget." ||
              error.message.includes("runtime-wide effect fence"))
          ) {
            throw error;
          }
          needsReconciliation = true;
        }
        if (attempt === this.reconciliationAttempts) {
          return indeterminateResult(request.invocation.invocationId, this.now().toISOString());
        }
        await this.pause(this.reconciliationDelayMs * 2 ** (attempt - 1));
      }
      return indeterminateResult(request.invocation.invocationId, this.now().toISOString());
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (downloadAuthorization) this.options.downloadRelay?.revoke(downloadAuthorization.authorizationId);
    }
  }

  async prepareExecutionHandoff(request: ExecuteInvocationRequest, runtimeId: string): Promise<void> {
    if (!request.runtimeContext) throw new Error("Execution handoff preparation requires task-scoped runtime context.");
    if (request.runtimeContext.runtimeId !== runtimeId) throw new Error("Execution handoff runtime binding changed.");
    const payload = this.executionPayload(request);
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    await this.reconciliationJournal.claim(payload, runtimeId, this.now().toISOString());
    this.runtimeIds.set(key, runtimeId);
  }

  async prepareBackupHandoff(request: ExecuteInvocationRequest, runtimeId: string): Promise<void> {
    if (!request.runtimeContext) throw new Error("Backup handoff preparation requires task-scoped runtime context.");
    if (request.runtimeContext.runtimeId !== runtimeId) throw new Error("Backup handoff runtime binding changed.");
    const payload = this.executionPayload({ ...request, backupAuthorization: undefined });
    await this.reconciliationJournal.prepare(payload, runtimeId, this.now().toISOString());
    this.runtimeIds.set(scopedInvocationKey(request.runtimeContext, request.invocation.invocationId), runtimeId);
  }

  async authorizeBackupHandoff(
    request: ExecuteInvocationRequest,
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<void> {
    if (!request.runtimeContext) throw new Error("Backup handoff authorization requires task-scoped runtime context.");
    if (authorization.runtimeId.length === 0 || authorization.runtimeId !== request.runtimeContext.runtimeId)
      throw new Error("Backup handoff runtime binding is invalid.");
    const payload = this.executionPayload({ ...request, backupAuthorization: authorization });
    await this.reconciliationJournal.authorize(payload, authorization.runtimeId, this.now().toISOString());
    this.runtimeIds.set(
      scopedInvocationKey(request.runtimeContext, request.invocation.invocationId),
      authorization.runtimeId
    );
  }

  async abandonBackupHandoff(invocationId: string, runtimeContext?: RuntimeExecutionContext): Promise<void> {
    if (!runtimeContext) throw new Error("Backup handoff removal requires task-scoped runtime context.");
    await this.completeReconciliation(invocationId, runtimeContext);
  }

  private executionPayload(request: ExecuteInvocationRequest): ExecuteWirePayload {
    if (!request.runtimeContext) throw new Error("Executor protocol requires task-scoped runtime context.");
    return {
      actorId: request.actorId,
      invocation: request.invocation,
      policy: request.policy,
      approvals: request.approvals,
      ...(request.approvalAuthorization ? { approvalAuthorization: request.approvalAuthorization } : {}),
      ...(request.backupAuthorization ? { backupAuthorization: request.backupAuthorization } : {}),
      runtimeContext: request.runtimeContext,
    };
  }

  private authorizeDownload(
    request: ExecuteInvocationRequest,
    invocationDigest: string,
    requestFingerprint: string
  ): GatewayDownloadAuthorization | undefined {
    if (
      !this.options.downloadRelay ||
      request.invocation.toolId !== "network.download" ||
      request.invocation.capability !== "network.outbound"
    ) {
      return undefined;
    }
    const args = request.invocation.arguments;
    const url = args.url;
    const expectedSha256 = args.expectedSha256;
    const expectedBytes = args.expectedBytes;
    const maxBytes = args.maxBytes ?? MAX_GATEWAY_DOWNLOAD_BYTES;
    const timeoutMs = args.timeoutMs ?? MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS;
    if (
      typeof url !== "string" ||
      typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      typeof expectedBytes !== "number" ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      expectedBytes > maxBytes ||
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs)
    ) {
      return undefined;
    }
    return this.options.downloadRelay.authorize({
      invocationId: request.invocation.invocationId,
      sessionId: request.invocation.sessionId,
      invocationDigest,
      requestFingerprint,
      url,
      expectedSha256,
      expectedBytes,
      maxBytes,
      timeoutMs,
    });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation keeps exact payload binding, bounded retry, and durable terminal evidence in one protocol operation.
  async cancel(
    invocationId: string,
    runtimeContext?: RuntimeExecutionContext,
    request?: ExecuteInvocationRequest
  ): Promise<ExecutorCancellationResult> {
    if (!runtimeContext) throw new Error("Executor cancellation requires task-scoped runtime context.");
    const requestId = `cancel-${this.createId()}`;
    const key = scopedInvocationKey(runtimeContext, invocationId);
    const pending = this.pendingBodies.get(key);
    const exactPayload = pending?.payload ?? (request ? this.executionPayload(request) : undefined);
    const exactInvocation = exactPayload?.invocation;
    const body: WireCommand = {
      schemaVersion: 1,
      command: "cancel",
      payload: {
        invocationId,
        runtimeContext,
        ...(exactInvocation
          ? {
              invocationDigest: fingerprint(exactInvocation as unknown as JsonValue),
              effectFingerprint: executePayloadFingerprint(exactPayload as ExecuteWirePayload),
              invocation: exactInvocation,
              ...(exactPayload?.backupAuthorization?.status === "succeeded"
                ? { backupAuthorization: exactPayload.backupAuthorization }
                : {}),
            }
          : {}),
      },
    };
    for (let attempt = 1; attempt <= this.reconciliationAttempts; attempt++) {
      try {
        const response = await this.send(requestId, body);
        if (response.ok) {
          if (response.result) {
            const result = agentSchemas.toolResult.parse(response.result);
            if (
              result.invocationId !== invocationId ||
              !response.terminalReceipt ||
              response.terminalJournalSequence === undefined
            ) {
              throw new Error("Executor cancellation returned incomplete terminal evidence.");
            }
            if (!exactPayload) throw new Error("Executor cancellation returned unbound terminal evidence.");
            this.rememberTerminalAcknowledgement(exactPayload, result, response.terminalJournalSequence);
            this.terminalReceipts.set(key, response.terminalReceipt);
            await this.reconciliationJournal.recordTerminal(
              exactPayload,
              result,
              response.terminalJournalSequence,
              response.terminalReceipt,
              this.now().toISOString()
            );
            return {
              result,
              terminalReceipt: response.terminalReceipt,
              terminalJournalSequence: response.terminalJournalSequence,
            };
          }
          return {};
        }
        throw new Error("Executor cancellation was not durably recorded.");
      } catch (error) {
        if (attempt === this.reconciliationAttempts) throw error;
        await this.pause(this.reconciliationDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new Error("Executor cancellation was not durably recorded.");
  }

  async renewFence(
    request: ExecuteInvocationRequest,
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<void> {
    if (!request.runtimeContext) throw new Error("Executor fence renewal requires task-scoped runtime context.");
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    let execute = this.pendingBodies.get(key);
    if (!execute) {
      const persisted = (await this.reconciliationJournal.list()).find((entry) => entry.key === key);
      if (persisted) execute = { schemaVersion: 1, command: "execute", payload: persisted.payload };
    }
    if (
      !execute ||
      execute.payload.backupAuthorization?.status !== "succeeded" ||
      fingerprint(stableBackupFenceBinding(execute.payload.backupAuthorization) as unknown as JsonValue) !==
        fingerprint(stableBackupFenceBinding(authorization) as unknown as JsonValue)
    ) {
      throw new Error("Executor fence renewal changed its exact invocation binding.");
    }
    execute = {
      ...execute,
      payload: { ...execute.payload, backupAuthorization: authorization },
    };
    this.pendingBodies.set(key, execute);
    const persistedEntry = (await this.reconciliationJournal.list()).find((entry) => entry.key === key);
    if (!persistedEntry) throw new Error("Executor fence renewal lost its durable handoff.");
    await this.reconciliationJournal.authorize(execute.payload, persistedEntry.runtimeId, this.now().toISOString());
    const response = await this.send(`renew-fence-${this.createId()}`, {
      schemaVersion: 1,
      command: "renew-fence",
      payload: {
        invocationId: request.invocation.invocationId,
        runtimeContext: request.runtimeContext,
        authorization,
      },
    });
    if (!response.ok) throw new Error("Executor rejected renewed lifecycle fence ownership.");
  }

  async probeFence(
    request: ExecuteInvocationRequest
  ): Promise<"active" | "pending" | "reserved" | "terminal" | "not-started"> {
    if (!request.runtimeContext) throw new Error("Executor fence probe requires task-scoped runtime context.");
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    const persisted = (await this.reconciliationJournal.list()).find((entry) => entry.key === key);
    const execute =
      this.pendingBodies.get(key) ??
      (persisted
        ? {
            schemaVersion: 1 as const,
            command: "execute" as const,
            payload: persisted.payload,
          }
        : undefined);
    if (!execute) return "not-started";
    const response = await this.send(`probe-fence-${this.createId()}`, { ...execute, command: "reconcile" });
    if (!response.ok) throw new Error("Executor fence probe failed closed.");
    if (
      persisted?.expectedJournalSequence !== undefined &&
      (response.journalSequence === undefined || response.journalSequence < persisted.expectedJournalSequence)
    ) {
      return "pending";
    }
    if (response.result) return "terminal";
    if (persisted?.state === "dispatching" && response.reconciliation === "not-started") return "pending";
    return response.reconciliation ?? "not-started";
  }

  async replacePendingFence(
    request: ExecuteInvocationRequest,
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<void> {
    if (!request.runtimeContext) throw new Error("Pending executor fence replacement requires runtime context.");
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    const persisted = (await this.reconciliationJournal.list()).find((entry) => entry.key === key);
    if (
      !persisted ||
      persisted.payload.backupAuthorization?.status !== "succeeded" ||
      fingerprint(stableBackupFenceBinding(persisted.payload.backupAuthorization) as unknown as JsonValue) !==
        fingerprint(stableBackupFenceBinding(authorization) as unknown as JsonValue)
    ) {
      throw new Error("Pending executor fence replacement changed its exact binding.");
    }
    const payload = { ...persisted.payload, backupAuthorization: authorization };
    this.pendingBodies.set(key, { schemaVersion: 1, command: "execute", payload });
    await this.reconciliationJournal.authorize(payload, persisted.runtimeId, this.now().toISOString());
  }

  async revokeFence(invocationId: string, runtimeContext?: RuntimeExecutionContext): Promise<void> {
    if (!runtimeContext) throw new Error("Executor fence revocation requires task-scoped runtime context.");
    const response = await this.send(`revoke-fence-${this.createId()}`, {
      schemaVersion: 1,
      command: "revoke-fence",
      payload: { invocationId, runtimeContext },
    });
    if (!response.ok) throw new Error("Executor fence revocation was not accepted.");
  }

  async reconcile(request: ExecuteInvocationRequest): Promise<ToolResult> {
    if (!request.runtimeContext) throw new Error("Executor reconciliation requires task-scoped runtime context.");
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    let execute = this.pendingBodies.get(key);
    if (!execute) {
      const persisted = (await this.reconciliationJournal.list()).find((entry) => entry.key === key);
      if (persisted) {
        execute = { schemaVersion: 1, command: "execute", payload: persisted.payload };
        this.pendingBodies.set(key, execute);
      }
    }
    if (!execute) return indeterminateResult(request.invocation.invocationId, this.now().toISOString());
    return await this.reconcilePayload(execute);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery intentionally keeps persisted terminal replay, executor probing, and bounded state projection together.
  async reconcilePending(): Promise<PendingExecutorReconciliation[]> {
    const pending = await this.reconciliationJournal.list();
    const results: PendingExecutorReconciliation[] = [];
    for (const entry of pending) {
      this.runtimeIds.set(entry.key, entry.runtimeId);
      if (
        entry.terminalResult?.status !== "indeterminate" &&
        entry.terminalResult &&
        entry.terminalReceipt &&
        entry.terminalJournalSequence !== undefined
      ) {
        this.pendingBodies.set(entry.key, {
          schemaVersion: 1,
          command: "execute",
          payload: entry.payload,
        });
        this.pendingJournalSequences.set(entry.key, entry.expectedJournalSequence ?? entry.terminalJournalSequence);
        this.terminalReceipts.set(entry.key, entry.terminalReceipt);
        this.rememberTerminalAcknowledgement(entry.payload, entry.terminalResult, entry.terminalJournalSequence);
        results.push({
          key: entry.key,
          runtimeId: entry.runtimeId,
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          leaseId: entry.leaseId,
          leaseGeneration: entry.leaseGeneration,
          invocationId: entry.invocationId,
          invocationDigest: entry.invocationDigest,
          state: entry.state,
          request: { ...entry.payload },
          executorStatus: "terminal",
          result: structuredClone(entry.terminalResult),
          terminalReceipt: structuredClone(entry.terminalReceipt),
          ...(entry.expectedJournalSequence !== undefined
            ? { expectedJournalSequence: entry.expectedJournalSequence }
            : {}),
        });
        continue;
      }
      if (entry.state === "awaiting-backup") {
        results.push({
          key: entry.key,
          runtimeId: entry.runtimeId,
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          leaseId: entry.leaseId,
          leaseGeneration: entry.leaseGeneration,
          invocationId: entry.invocationId,
          invocationDigest: entry.invocationDigest,
          state: entry.state,
          request: { ...entry.payload },
        });
        continue;
      }
      const execute: WireCommand & { command: "execute" } = {
        schemaVersion: 1,
        command: "execute",
        payload: entry.payload,
      };
      this.pendingBodies.set(entry.key, execute);
      if (entry.expectedJournalSequence !== undefined) {
        this.pendingJournalSequences.set(entry.key, entry.expectedJournalSequence);
      }
      const reconciled = await this.probePayload(execute, entry.expectedJournalSequence, entry.state);
      results.push({
        key: entry.key,
        runtimeId: entry.runtimeId,
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        leaseId: entry.leaseId,
        leaseGeneration: entry.leaseGeneration,
        invocationId: entry.invocationId,
        invocationDigest: entry.invocationDigest,
        state: entry.state,
        request: { ...entry.payload },
        executorStatus: reconciled.status,
        ...(reconciled.result
          ? { result: reconciled.result }
          : reconciled.status === "active" || reconciled.status === "pending"
            ? { result: indeterminateResult(entry.payload.invocation.invocationId, this.now().toISOString()) }
            : {}),
        ...(reconciled.terminalReceipt ? { terminalReceipt: reconciled.terminalReceipt } : {}),
        ...(entry.expectedJournalSequence !== undefined
          ? { expectedJournalSequence: entry.expectedJournalSequence }
          : {}),
      });
    }
    return results;
  }

  async inspectEffectSlot(): Promise<JournalInFlightIdentity | null> {
    await this.reconciliationJournal.initialize();
    const response = await this.send(`effect-status-${this.createId()}`, {
      schemaVersion: 1,
      command: "effect-status",
      payload: {},
    });
    if (!response.ok || response.inFlight === undefined) {
      throw new Error("Executor effect status failed closed.");
    }
    return parseInFlightIdentity(response.inFlight);
  }

  private async reconcilePayload(execute: WireCommand & { command: "execute" }): Promise<ToolResult> {
    const key = scopedInvocationKey(execute.payload.runtimeContext, execute.payload.invocation.invocationId);
    const reconciled = await this.probePayload(execute, this.pendingJournalSequences.get(key), "dispatching");
    if (reconciled.result) return reconciled.result;
    if (reconciled.status === "not-started") {
      return reconciledNoEffectResult(execute.payload.invocation.invocationId, this.now().toISOString());
    }
    return indeterminateResult(execute.payload.invocation.invocationId, this.now().toISOString());
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Authenticated sequence floors, durable dispatch state, bounded transport retry, and exact terminal parsing stay in one fail-closed probe.
  private async probePayload(
    execute: WireCommand & { command: "execute" },
    expectedJournalSequence?: number,
    handoffState?: PendingReconciliationEntry["state"]
  ): Promise<{
    status: "active" | "pending" | "reserved" | "terminal" | "not-started";
    result?: ToolResult;
    terminalReceipt?: BackupTerminalReceipt;
  }> {
    const requestFingerprint = executePayloadFingerprint(execute.payload);
    for (let attempt = 1; attempt <= this.reconciliationAttempts; attempt++) {
      try {
        const response = await this.send(`reconcile-${requestFingerprint.slice(0, 48)}-${this.createId()}`, {
          ...execute,
          command: "reconcile",
        });
        if (!response.ok) throw new Error("Executor protocol failed closed.");
        if (
          expectedJournalSequence !== undefined &&
          (response.journalSequence === undefined || response.journalSequence < expectedJournalSequence)
        ) {
          return { status: "pending" };
        }
        if (response.result) {
          const result = agentSchemas.toolResult.parse(response.result);
          this.rememberTerminalAcknowledgement(execute.payload, result, response.terminalJournalSequence);
          if (response.terminalReceipt) {
            this.terminalReceipts.set(
              scopedInvocationKey(execute.payload.runtimeContext, execute.payload.invocation.invocationId),
              response.terminalReceipt
            );
            await this.reconciliationJournal.recordTerminal(
              execute.payload,
              result,
              response.terminalJournalSequence as number,
              response.terminalReceipt,
              this.now().toISOString()
            );
          }
          return {
            status: "terminal",
            result,
            ...(response.terminalReceipt ? { terminalReceipt: response.terminalReceipt } : {}),
          };
        }
        if (handoffState === "dispatching" && response.reconciliation === "not-started") {
          return { status: "pending" };
        }
        if (response.reconciliation) return { status: response.reconciliation };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "Executor protocol failed closed." ||
            error.message === "Executor protocol message exceeded the encoded byte budget.")
        )
          throw error;
      }
      if (attempt < this.reconciliationAttempts) {
        await this.pause(this.reconciliationDelayMs * 2 ** (attempt - 1));
      }
    }
    return { status: "pending" };
  }

  private async reserveJournalEntry(payload: ExecuteWirePayload): Promise<number> {
    const requestId = `reserve-${executePayloadFingerprint(payload)}`;
    for (let attempt = 1; attempt <= this.reconciliationAttempts; attempt++) {
      try {
        const response = await this.send(requestId, { schemaVersion: 1, command: "reserve", payload });
        if (!response.ok && response.error === "runtime-fenced") {
          throw new Error("Executor runtime-wide effect fence rejected a distinct concurrent invocation.");
        }
        if (!response.ok) throw new Error("Executor protocol failed closed.");
        if (
          response.reconciliation !== "reserved" ||
          typeof response.journalSequence !== "number" ||
          !Number.isSafeInteger(response.journalSequence) ||
          response.journalSequence < 1
        ) {
          throw new Error("Executor journal reservation failed closed.");
        }
        return response.journalSequence;
      } catch (error) {
        if (attempt === this.reconciliationAttempts) throw error;
        await this.pause(this.reconciliationDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new Error("Executor journal reservation failed closed.");
  }

  async completeReconciliation(
    invocationId: string,
    runtimeContext?: RuntimeExecutionContext,
    authorization?: TerminalPublicationAuthorization
  ): Promise<void> {
    if (!runtimeContext) throw new Error("Executor reconciliation completion requires task-scoped runtime context.");
    const key = scopedInvocationKey(runtimeContext, invocationId);
    const acknowledgement = this.terminalAcknowledgements.get(key);
    if (acknowledgement?.status === "indeterminate") {
      throw new Error("Indeterminate executor evidence cannot be acknowledged as published terminal state.");
    }
    if (acknowledgement) {
      if (
        !authorization ||
        authorization.runtimeId !== runtimeContext.runtimeId ||
        authorization.sessionId.length === 0 ||
        authorization.taskId !== acknowledgement.taskId ||
        authorization.leaseId !== runtimeContext.leaseId ||
        authorization.leaseGeneration !== acknowledgement.leaseGeneration ||
        authorization.invocationId !== acknowledgement.invocationId ||
        authorization.invocationDigest !== acknowledgement.invocationDigest ||
        authorization.journalSequence !== acknowledgement.journalSequence ||
        authorization.resultDigest !== acknowledgement.resultDigest
      ) {
        throw new Error("Executor terminal acknowledgement lacks exact control-plane publication authority.");
      }
      const { status: _status, ...payload } = acknowledgement;
      const response = await this.send(`acknowledge-terminal-${this.createId()}`, {
        schemaVersion: 1,
        command: "acknowledge-terminal",
        payload: { ...payload, authorization },
      });
      if (
        !response.ok ||
        response.journalSequence === undefined ||
        response.journalSequence < payload.journalSequence
      ) {
        throw new Error("Executor terminal publication acknowledgement failed closed.");
      }
    }
    await this.reconciliationJournal.remove(key);
    this.pendingBodies.delete(key);
    this.pendingJournalSequences.delete(key);
    this.terminalReceipts.delete(key);
    this.terminalAcknowledgements.delete(key);
    this.runtimeIds.delete(key);
  }

  private rememberTerminalAcknowledgement(
    payload: ExecuteWirePayload,
    result: ToolResult,
    journalSequence: number | undefined
  ): void {
    if (isWaitingResult(result)) return;
    if (journalSequence === undefined || !Number.isSafeInteger(journalSequence) || journalSequence < 1) {
      throw new Error("Executor terminal result lost its authenticated journal sequence.");
    }
    const key = scopedInvocationKey(payload.runtimeContext, payload.invocation.invocationId);
    this.terminalAcknowledgements.set(key, {
      invocationId: payload.invocation.invocationId,
      invocationDigest: fingerprint(payload.invocation as unknown as JsonValue),
      taskId: payload.runtimeContext.taskId,
      leaseGeneration: payload.runtimeContext.leaseGeneration,
      journalSequence,
      resultDigest: fingerprint(result as unknown as JsonValue),
      status: result.status,
    });
  }

  async terminalReceiptFor(
    request: ExecuteInvocationRequest,
    result: ToolResult
  ): Promise<BackupTerminalReceipt | undefined> {
    if (!request.runtimeContext || isWaitingResult(result)) return undefined;
    const key = scopedInvocationKey(request.runtimeContext, request.invocation.invocationId);
    const receipt = this.terminalReceipts.get(key);
    if (!receipt || receipt.resultDigest !== fingerprint(result as unknown as JsonValue)) return undefined;
    return structuredClone(receipt);
  }

  private async send(requestId: string, body: WireCommand): Promise<WireResponse> {
    const unsigned = {
      schemaVersion: 1 as const,
      requestId,
      nonce: this.createId().slice(0, 32).padEnd(32, "0"),
      issuedAt: this.now().toISOString(),
      body,
    };
    const signature = sign(null, Buffer.from(signedContent(unsigned)), this.options.gatewayPrivateKey).toString(
      "base64url"
    );
    let encodedRequest: Uint8Array;
    try {
      encodedRequest = encode({ ...unsigned, signature });
    } catch {
      throw new Error("Executor protocol message exceeded the encoded byte budget.");
    }
    const socket = createConnection(this.options.socketPath);
    try {
      socket.setTimeout(this.responseTimeoutMs, () => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off("connect", onConnect);
          reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
      socket.write(encodedRequest);
      const parsed = record(await readOne(socket));
      if (
        !parsed ||
        parsed.schemaVersion !== 1 ||
        parsed.requestId !== requestId ||
        typeof parsed.ok !== "boolean" ||
        !Object.keys(parsed).every((key) =>
          [
            "schemaVersion",
            "requestId",
            "ok",
            "result",
            "error",
            "reconciliation",
            "journalSequence",
            "terminalJournalSequence",
            "terminalReceipt",
            "inFlight",
          ].includes(key)
        )
      ) {
        throw new Error("Executor returned an invalid response.");
      }
      if (
        parsed.journalSequence !== undefined &&
        (typeof parsed.journalSequence !== "number" ||
          !Number.isSafeInteger(parsed.journalSequence) ||
          parsed.journalSequence < 0)
      ) {
        throw new Error("Executor returned an invalid response.");
      }
      if (
        parsed.terminalJournalSequence !== undefined &&
        (typeof parsed.terminalJournalSequence !== "number" ||
          !Number.isSafeInteger(parsed.terminalJournalSequence) ||
          parsed.terminalJournalSequence < 1)
      ) {
        throw new Error("Executor returned an invalid response.");
      }
      if (
        parsed.reconciliation !== undefined &&
        !["active", "pending", "reserved", "not-started"].includes(String(parsed.reconciliation))
      ) {
        throw new Error("Executor returned an invalid response.");
      }
      if (parsed.result !== undefined) agentSchemas.toolResult.parse(parsed.result);
      if (parsed.terminalReceipt !== undefined) parseBackupTerminalReceipt(parsed.terminalReceipt);
      if (parsed.inFlight !== undefined) parseInFlightIdentity(parsed.inFlight);
      return parsed as unknown as WireResponse;
    } finally {
      socket.destroy();
    }
  }

  private async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
  }
}
