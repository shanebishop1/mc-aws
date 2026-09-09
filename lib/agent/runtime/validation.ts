import type { AgentApproval, AgentEventKind, AgentTurn, JsonObject, TargetScope } from "@/lib/agent/contracts";
import { parseBackupFenceAuthorization, parseBackupTerminalReceipt } from "@/lib/agent/runtime/backup-fence";
import type {
  RuntimeApprovalConsumptionRequest,
  RuntimeApprovalPublicationRequest,
  RuntimeBackupFinalizeRequest,
  RuntimeBackupRenewRequest,
  RuntimeBackupRequest,
  RuntimeDecisionPollRequest,
  RuntimeEventPublicationRequest,
  RuntimeInvocationAuthorizationRequest,
  RuntimeLeaseMutationRequest,
  RuntimeRecoveryPublicationRequest,
  RuntimeRenewRequest,
  RuntimeStatusPublicationRequest,
  RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime/contracts";
import { isSensitiveKey } from "@/lib/agent/sensitive-keys";
import { agentSchemas } from "@/lib/agent/validators";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVENT_KINDS = new Set<AgentEventKind>([
  "model",
  "reasoning-summary",
  "tool-proposal",
  "tool-progress",
  "tool-result",
  "policy",
  "backup",
  "approval",
  "error",
  "cancellation",
  "completion",
]);
export const RUNTIME_API_BODY_LIMIT_BYTES = 128_000;

export class AgentRuntimeValidationError extends Error {
  constructor() {
    super("Invalid agent runtime request");
    this.name = "AgentRuntimeValidationError";
  }
}

function fail(): never {
  throw new AgentRuntimeValidationError();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function assertPublishableJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertPublishableJson(child);
    return;
  }
  if (typeof value !== "object") fail();
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) fail();
    assertPublishableJson(child);
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value)) fail();
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) fail();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail();
  return Number(value);
}

function base(value: Record<string, unknown>): RuntimeLeaseMutationRequest {
  if (value.schemaVersion !== 1) fail();
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)) fail();
  return {
    schemaVersion: 1,
    sessionId: id(value.sessionId),
    taskId: id(value.taskId),
    expectedRevision: integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: value.idempotencyKey,
  };
}

export async function readRuntimeJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RUNTIME_API_BODY_LIMIT_BYTES) fail();
  let text: string;
  try {
    text = await request.text();
  } catch {
    fail();
  }
  if (new TextEncoder().encode(text).byteLength > RUNTIME_API_BODY_LIMIT_BYTES) fail();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail();
  }
}

export function parseWorkLeaseRequest(value: unknown): RuntimeWorkLeaseRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "claimId", "leaseDurationMs", "waitMs"]);
  if (input.schemaVersion !== 1) fail();
  return {
    schemaVersion: 1,
    claimId: id(input.claimId),
    leaseDurationMs: integer(input.leaseDurationMs, 5_000, 120_000),
    waitMs: integer(input.waitMs, 0, 25_000),
  };
}

export function parseLeaseMutation(value: unknown): RuntimeLeaseMutationRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "sessionId", "taskId", "expectedRevision", "idempotencyKey"]);
  return base(input);
}

export function parseRenew(value: unknown): RuntimeRenewRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "sessionId", "taskId", "expectedRevision", "idempotencyKey", "leaseDurationMs"]);
  return { ...base(input), leaseDurationMs: integer(input.leaseDurationMs, 5_000, 120_000) };
}

export function parseEvents(value: unknown): RuntimeEventPublicationRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "sessionId", "taskId", "expectedRevision", "idempotencyKey", "drafts"]);
  if (!Array.isArray(input.drafts) || input.drafts.length < 1 || input.drafts.length > 64) fail();
  const drafts = input.drafts.map((raw) => {
    const draft = record(raw);
    exact(draft, ["schemaVersion", "draftId", "ordinal", "timestamp", "kind", "payload"]);
    if (
      draft.schemaVersion !== 1 ||
      typeof draft.timestamp !== "string" ||
      !ISO_TIMESTAMP.test(draft.timestamp) ||
      !Number.isFinite(Date.parse(draft.timestamp)) ||
      typeof draft.kind !== "string" ||
      !EVENT_KINDS.has(draft.kind as AgentEventKind)
    ) {
      fail();
    }
    const payload = record(draft.payload) as JsonObject;
    assertPublishableJson(payload);
    return {
      schemaVersion: 1 as const,
      draftId: id(draft.draftId),
      ordinal: integer(draft.ordinal, 1, Number.MAX_SAFE_INTEGER),
      timestamp: draft.timestamp,
      kind: draft.kind as AgentEventKind,
      payload,
    };
  });
  return { ...base(input), drafts };
}

export function parseRecoveryPublication(value: unknown): RuntimeRecoveryPublicationRequest {
  const input = record(value);
  const required = [
    "schemaVersion",
    "sessionId",
    "taskId",
    "runtimeId",
    "leaseId",
    "leaseGeneration",
    "invocationId",
    "invocationDigest",
    "journalSequence",
    "resultDigest",
    "result",
    "terminalReceipt",
    "idempotencyKey",
  ];
  if (
    Object.keys(input).some((key) => ![...required, "displayResult", "taskDisposition"].includes(key)) ||
    required.some((key) => !(key in input))
  )
    fail();
  if (
    input.schemaVersion !== 1 ||
    typeof input.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.invocationDigest) ||
    typeof input.resultDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.resultDigest)
  )
    fail();
  let result: RuntimeRecoveryPublicationRequest["result"];
  let displayResult: RuntimeRecoveryPublicationRequest["displayResult"];
  let terminalReceipt: RuntimeRecoveryPublicationRequest["terminalReceipt"];
  try {
    result = agentSchemas.toolResult.parse(input.result);
    if (input.displayResult !== undefined) displayResult = agentSchemas.toolResult.parse(input.displayResult);
    terminalReceipt = parseBackupTerminalReceipt(input.terminalReceipt);
  } catch {
    fail();
  }
  return {
    schemaVersion: 1,
    sessionId: id(input.sessionId),
    taskId: id(input.taskId),
    runtimeId: id(input.runtimeId),
    leaseId: id(input.leaseId),
    leaseGeneration: integer(input.leaseGeneration, 1, Number.MAX_SAFE_INTEGER),
    invocationId: id(input.invocationId),
    invocationDigest: input.invocationDigest,
    journalSequence: integer(input.journalSequence, 1, Number.MAX_SAFE_INTEGER),
    resultDigest: input.resultDigest,
    result,
    ...(displayResult ? { displayResult } : {}),
    terminalReceipt,
    taskDisposition:
      input.taskDisposition === undefined
        ? "terminate"
        : input.taskDisposition === "continue" || input.taskDisposition === "terminate"
          ? input.taskDisposition
          : fail(),
    idempotencyKey:
      typeof input.idempotencyKey === "string" && IDEMPOTENCY_KEY.test(input.idempotencyKey)
        ? input.idempotencyKey
        : fail(),
  };
}

export function parseApproval(value: unknown): RuntimeApprovalPublicationRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "sessionId", "taskId", "expectedRevision", "idempotencyKey", "approval"]);
  let approval: AgentApproval;
  try {
    approval = agentSchemas.agentApproval.parse(input.approval);
  } catch {
    fail();
  }
  if (approval.decision !== "pending" || approval.decidedAt !== undefined || approval.consumedAt !== undefined) fail();
  return { ...base(input), approval };
}

export function parseStatus(value: unknown): RuntimeStatusPublicationRequest {
  const input = record(value);
  const required = ["schemaVersion", "sessionId", "taskId", "expectedRevision", "idempotencyKey", "status", "reason"];
  if (
    Object.keys(input).some((key) => ![...required, "assistantTurn"].includes(key)) ||
    required.some((key) => !(key in input))
  )
    fail();
  if (
    typeof input.status !== "string" ||
    !["running", "waiting-approval", "completed", "failed", "cancelled"].includes(input.status) ||
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 512
  ) {
    fail();
  }
  let assistantTurn: AgentTurn | undefined;
  if (input.assistantTurn !== undefined) {
    try {
      assistantTurn = agentSchemas.agentTurn.parse(input.assistantTurn);
    } catch {
      fail();
    }
    if (assistantTurn.kind !== "assistant" || assistantTurn.content.length > 32_000 || input.status !== "completed")
      fail();
  }
  return {
    ...base(input),
    status: input.status as RuntimeStatusPublicationRequest["status"],
    reason: input.reason,
    ...(assistantTurn ? { assistantTurn } : {}),
  };
}

export function parseApprovalConsumption(value: unknown): RuntimeApprovalConsumptionRequest {
  const input = record(value);
  exact(input, [
    "schemaVersion",
    "sessionId",
    "taskId",
    "expectedRevision",
    "idempotencyKey",
    "approvalId",
    "invocationDigest",
  ]);
  if (typeof input.invocationDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.invocationDigest)) {
    fail();
  }
  return {
    ...base(input),
    approvalId: id(input.approvalId),
    invocationDigest: input.invocationDigest,
  };
}

export function parseInvocationAuthorization(value: unknown): RuntimeInvocationAuthorizationRequest {
  const input = record(value);
  exact(input, [
    "schemaVersion",
    "sessionId",
    "taskId",
    "expectedRevision",
    "idempotencyKey",
    "authorizationId",
    "invocationId",
    "invocationDigest",
    "approvalId",
    "capability",
    "targetScope",
    "risk",
  ]);
  if (typeof input.invocationDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.invocationDigest)) fail();
  let targetScope: TargetScope;
  try {
    targetScope = agentSchemas.targetScope.parse(input.targetScope);
  } catch {
    fail();
  }
  if (
    typeof input.capability !== "string" ||
    ![
      "workspace.read",
      "workspace.write",
      "workspace.delete",
      "shell.execute",
      "console.execute",
      "network.outbound",
      "backup.create",
      "extension.load",
    ].includes(input.capability) ||
    (input.risk !== "low" && input.risk !== "risky" && input.risk !== "destructive")
  ) {
    fail();
  }
  return {
    ...base(input),
    authorizationId: id(input.authorizationId),
    invocationId: id(input.invocationId),
    invocationDigest: input.invocationDigest,
    approvalId: id(input.approvalId),
    capability: input.capability as RuntimeInvocationAuthorizationRequest["capability"],
    targetScope,
    risk: input.risk,
  };
}

export function parseDecisionPoll(value: unknown): RuntimeDecisionPollRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "sessionId", "taskId", "afterRevision", "waitMs"]);
  if (input.schemaVersion !== 1) fail();
  return {
    schemaVersion: 1,
    sessionId: id(input.sessionId),
    taskId: id(input.taskId),
    afterRevision: integer(input.afterRevision, 1, Number.MAX_SAFE_INTEGER),
    waitMs: integer(input.waitMs, 0, 25_000),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One exact-schema boundary validates availability, create, finalize, and renewal variants.
export function parseRuntimeBackupRequest(value: unknown): RuntimeBackupRequest {
  const input = record(value);
  if (input.action === "availability") {
    exact(input, ["schemaVersion", "action"]);
    if (input.schemaVersion !== 1) fail();
    return { schemaVersion: 1, action: "availability" };
  }
  if (input.action === "finalize") {
    const keys = ["schemaVersion", "action", "authorization", "outcome", "terminalReceipt"];
    if (Object.keys(input).some((key) => !keys.includes(key)) || !keys.slice(0, 4).every((key) => key in input)) fail();
    if (
      input.schemaVersion !== 1 ||
      !["committed", "failed", "cancelled", "indeterminate"].includes(String(input.outcome))
    ) {
      fail();
    }
    let authorization: RuntimeBackupFinalizeRequest["authorization"];
    try {
      authorization = parseBackupFenceAuthorization(input.authorization);
    } catch {
      fail();
    }
    let terminalReceipt: RuntimeBackupFinalizeRequest["terminalReceipt"];
    if (input.terminalReceipt !== undefined) {
      try {
        terminalReceipt = parseBackupTerminalReceipt(input.terminalReceipt);
      } catch {
        fail();
      }
    }
    if (input.outcome !== "indeterminate" && !terminalReceipt) fail();
    return {
      schemaVersion: 1,
      action: "finalize",
      authorization,
      outcome: input.outcome as RuntimeBackupFinalizeRequest["outcome"],
      ...(terminalReceipt ? { terminalReceipt } : {}),
    };
  }
  if (input.action === "renew") {
    exact(input, ["schemaVersion", "action", "authorization"]);
    if (input.schemaVersion !== 1) fail();
    let authorization: RuntimeBackupRenewRequest["authorization"];
    try {
      authorization = parseBackupFenceAuthorization(input.authorization);
    } catch {
      fail();
    }
    return { schemaVersion: 1, action: "renew", authorization };
  }
  exact(input, [
    "schemaVersion",
    "action",
    "leaseId",
    "leaseGeneration",
    "sessionId",
    "taskId",
    "invocationId",
    "invocationDigest",
  ]);
  if (
    input.schemaVersion !== 1 ||
    input.action !== "create" ||
    typeof input.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.invocationDigest)
  ) {
    fail();
  }
  return {
    schemaVersion: 1,
    action: "create",
    leaseId: id(input.leaseId),
    leaseGeneration: integer(input.leaseGeneration, 1, Number.MAX_SAFE_INTEGER),
    sessionId: id(input.sessionId),
    taskId: id(input.taskId),
    invocationId: id(input.invocationId),
    invocationDigest: input.invocationDigest,
  };
}
