import {
  AGENT_CAPABILITIES,
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentSession,
  type JsonObject,
  type JsonValue,
} from "@/lib/agent/contracts";
import { redactSecretAwareJson, redactSensitiveText } from "@/lib/agent/redaction";
import { parseBackupTerminalReceipt } from "@/lib/agent/runtime/executor-receipt";
import { isSensitiveKey } from "@/lib/agent/sensitive-keys";
import type {
  AgentCancellationState,
  AgentStateIdempotencyRecord,
  AgentTaskRecord,
  AgentWorkLease,
  DurableAgentSessionState,
} from "@/lib/agent/state/contracts";
import { agentSchemas } from "@/lib/agent/validators";

const STATE_KEYS = [
  "schemaVersion",
  "revision",
  "session",
  "policySnapshot",
  "statusHistory",
  "tasks",
  "approvals",
  "cancellation",
  "events",
  "nextEventSequence",
  "retainedFromSequence",
  "idempotency",
] as const;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Leaves enough transport room for the repository envelope even for escape-heavy JSON. */
export const AGENT_STATE_MAX_SERIALIZED_BYTES = 900_000;
export const AGENT_STATE_RESERVED_TERMINAL_BYTES = 128_000;
/** Ordinary writes stop here so a terminal result can still be durably recorded. */
export const AGENT_STATE_STANDARD_MAX_SERIALIZED_BYTES =
  AGENT_STATE_MAX_SERIALIZED_BYTES - AGENT_STATE_RESERVED_TERMINAL_BYTES;

export function serializedUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class AgentStateSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateSerializationError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AgentStateSerializationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) assert(keys.includes(key), `${path}.${key}: unknown field`);
}

function assertTimestamp(value: unknown, path: string): asserts value is string {
  assert(
    typeof value === "string" && ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
    `${path}: invalid timestamp`
  );
}

function assertId(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string" && ID.test(value), `${path}: invalid identifier`);
}

/** Rejects credential-shaped keys and redacts common raw credential values. */
export function redactPersistedJson(value: JsonObject): JsonObject {
  const rejectSensitiveKeys = (item: JsonValue, path: string): void => {
    if (item === null || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => rejectSensitiveKeys(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (isSensitiveKey(key)) {
        throw new AgentStateSerializationError(`${path}.${key}: raw credential fields cannot be persisted`);
      }
      rejectSensitiveKeys(child, `${path}.${key}`);
    }
  };
  rejectSensitiveKeys(value, "payload");
  return redactSecretAwareJson(value);
}

export function redactSessionForPersistence(session: AgentSession): AgentSession {
  return {
    ...session,
    turns: session.turns.map((turn) => ({ ...turn, content: redactSensitiveText(turn.content) })),
  };
}

export function redactTaskForPersistence(task: AgentTaskRecord): AgentTaskRecord {
  return { ...task, content: redactSensitiveText(task.content) };
}

export function redactReasonForPersistence(reason: string): string {
  return redactSensitiveText(reason);
}

function parseTask(value: unknown, sessionId: string, path: string): AgentTaskRecord {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "taskId",
      "sessionId",
      "status",
      "content",
      "createdAt",
      "updatedAt",
      "runtimeEventOrdinal",
      "lease",
      "cancellationReconciliation",
      "invocationAuthorizations",
      "activeRuntimeInvocation",
      "runtimeRecoveries",
    ],
    path
  );
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assertId(value.taskId, `${path}.taskId`);
  assert(value.sessionId === sessionId, `${path}.sessionId: does not match session`);
  assert(
    ["pending", "running", "waiting-approval", "cancelled", "failed", "completed"].includes(String(value.status)),
    `${path}.status: invalid status`
  );
  assert(typeof value.content === "string" && value.content.length > 0, `${path}.content: must be non-empty`);
  assertTimestamp(value.createdAt, `${path}.createdAt`);
  assertTimestamp(value.updatedAt, `${path}.updatedAt`);
  if (value.runtimeEventOrdinal !== undefined) {
    assert(
      Number.isSafeInteger(value.runtimeEventOrdinal) && Number(value.runtimeEventOrdinal) >= 0,
      `${path}.runtimeEventOrdinal: invalid ordinal`
    );
  }
  const lease = value.lease === undefined ? undefined : parseLease(value.lease, `${path}.lease`);
  const cancellationReconciliation =
    value.cancellationReconciliation === undefined
      ? undefined
      : parseCancellationReconciliation(value.cancellationReconciliation, `${path}.cancellationReconciliation`);
  const invocationAuthorizations =
    value.invocationAuthorizations === undefined
      ? undefined
      : parseInvocationAuthorizations(value.invocationAuthorizations, `${path}.invocationAuthorizations`, value);
  const activeRuntimeInvocation =
    value.activeRuntimeInvocation === undefined
      ? undefined
      : parseActiveRuntimeInvocation(value.activeRuntimeInvocation, `${path}.activeRuntimeInvocation`);
  const runtimeRecoveries =
    value.runtimeRecoveries === undefined
      ? undefined
      : parseRuntimeRecoveries(value.runtimeRecoveries, `${path}.runtimeRecoveries`, sessionId, value.taskId as string);
  assert(
    runtimeRecoveries?.every((recovery) => recovery.taskStatus === value.status) ?? true,
    `${path}.runtimeRecoveries: task status mismatch`
  );
  return {
    ...(value as unknown as AgentTaskRecord),
    lease,
    cancellationReconciliation,
    invocationAuthorizations,
    activeRuntimeInvocation,
    runtimeRecoveries,
  };
}

function parseRuntimeRecoveries(
  value: unknown,
  path: string,
  sessionId: string,
  taskId: string
): NonNullable<AgentTaskRecord["runtimeRecoveries"]> {
  assert(Array.isArray(value) && value.length <= 64, `${path}: invalid bound`);
  const recoveries = value.map((candidate, index) =>
    parseRuntimeRecovery(candidate, `${path}[${index}]`, sessionId, taskId)
  );
  assert(
    new Set(recoveries.map((candidate) => candidate.invocationId)).size === recoveries.length,
    `${path}: duplicate invocation`
  );
  return recoveries;
}

function parseRuntimeRecovery(
  value: unknown,
  path: string,
  sessionId: string,
  taskId: string
): NonNullable<AgentTaskRecord["runtimeRecoveries"]>[number] {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "runtimeId",
      "sessionId",
      "taskId",
      "leaseId",
      "leaseGeneration",
      "invocationId",
      "invocationDigest",
      "journalSequence",
      "resultDigest",
      "persistedResultDigest",
      "outcome",
      "result",
      "terminalReceipt",
      "taskStatus",
      "sessionStatus",
      "publishedAt",
      "publicationRevision",
    ],
    path
  );
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  for (const field of ["runtimeId", "sessionId", "taskId", "leaseId", "invocationId"] as const) {
    assertId(value[field], `${path}.${field}`);
  }
  assert(
    Number.isSafeInteger(value.leaseGeneration) && Number(value.leaseGeneration) >= 1,
    `${path}.leaseGeneration: invalid generation`
  );
  assert(
    Number.isSafeInteger(value.journalSequence) && Number(value.journalSequence) >= 1,
    `${path}.journalSequence: invalid sequence`
  );
  for (const field of ["invocationDigest", "resultDigest", "persistedResultDigest"] as const) {
    assert(typeof value[field] === "string" && DIGEST.test(value[field]), `${path}.${field}: invalid digest`);
  }
  assert(
    value.outcome === "committed" ||
      value.outcome === "failed" ||
      value.outcome === "cancelled" ||
      value.outcome === "indeterminate",
    `${path}.outcome: invalid outcome`
  );
  const result = agentSchemas.toolResult.parse(value.result);
  assert(result.invocationId === value.invocationId, `${path}.result: invocation mismatch`);
  assert(value.sessionId === sessionId && value.taskId === taskId, `${path}: parent binding mismatch`);
  const expectedOutcome = result.status === "succeeded" ? "committed" : result.status;
  assert(value.outcome === expectedOutcome, `${path}.outcome: result mismatch`);
  assert(
    value.taskStatus === "completed" || value.taskStatus === "failed" || value.taskStatus === "cancelled",
    `${path}.taskStatus: invalid status`
  );
  assert(
    value.sessionStatus === "idle" ||
      value.sessionStatus === "completed" ||
      value.sessionStatus === "failed" ||
      value.sessionStatus === "cancelled",
    `${path}.sessionStatus: invalid status`
  );
  assertTimestamp(value.publishedAt, `${path}.publishedAt`);
  assert(
    Number.isSafeInteger(value.publicationRevision) && Number(value.publicationRevision) >= 1,
    `${path}.publicationRevision: invalid revision`
  );
  const terminalReceipt = parseBackupTerminalReceipt(value.terminalReceipt);
  assert(terminalReceipt.outcome === expectedOutcome, `${path}.terminalReceipt: outcome mismatch`);
  assert(
    terminalReceipt.runtimeId === value.runtimeId &&
      terminalReceipt.sessionId === value.sessionId &&
      terminalReceipt.taskId === value.taskId &&
      terminalReceipt.leaseId === value.leaseId &&
      terminalReceipt.leaseGeneration === value.leaseGeneration &&
      terminalReceipt.invocationId === value.invocationId &&
      terminalReceipt.invocationDigest === value.invocationDigest &&
      terminalReceipt.journalSequence === value.journalSequence &&
      terminalReceipt.resultDigest === value.resultDigest,
    `${path}.terminalReceipt: binding mismatch`
  );
  return {
    ...(value as unknown as NonNullable<AgentTaskRecord["runtimeRecoveries"]>[number]),
    result,
    terminalReceipt,
  };
}

function parseActiveRuntimeInvocation(
  value: unknown,
  path: string
): NonNullable<AgentTaskRecord["activeRuntimeInvocation"]> {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "runtimeId",
      "sessionId",
      "taskId",
      "leaseId",
      "leaseGeneration",
      "invocationId",
      "invocationDigest",
      "capability",
      "targetScope",
      "proposalOrdinal",
    ],
    path
  );
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assertId(value.runtimeId, `${path}.runtimeId`);
  assertId(value.sessionId, `${path}.sessionId`);
  assertId(value.taskId, `${path}.taskId`);
  assertId(value.leaseId, `${path}.leaseId`);
  assert(
    Number.isSafeInteger(value.leaseGeneration) && Number(value.leaseGeneration) >= 1,
    `${path}.leaseGeneration: invalid generation`
  );
  assertId(value.invocationId, `${path}.invocationId`);
  assert(
    typeof value.invocationDigest === "string" && DIGEST.test(value.invocationDigest),
    `${path}.invocationDigest: invalid digest`
  );
  assert(
    typeof value.capability === "string" &&
      AGENT_CAPABILITIES.includes(value.capability as (typeof AGENT_CAPABILITIES)[number]),
    `${path}.capability: invalid capability`
  );
  agentSchemas.targetScope.parse(value.targetScope);
  assert(
    Number.isSafeInteger(value.proposalOrdinal) && Number(value.proposalOrdinal) >= 1,
    `${path}.proposalOrdinal: invalid ordinal`
  );
  return value as unknown as NonNullable<AgentTaskRecord["activeRuntimeInvocation"]>;
}

function parseInvocationAuthorizations(
  value: unknown,
  path: string,
  task: Record<string, unknown>
): NonNullable<AgentTaskRecord["invocationAuthorizations"]> {
  assert(Array.isArray(value) && value.length <= 64, `${path}: invalid bound`);
  const authorizations = value.map((raw, index) => {
    const itemPath = `${path}[${index}]`;
    assert(isRecord(raw), `${itemPath}: must be an object`);
    assertExactKeys(
      raw,
      [
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
      ],
      itemPath
    );
    assert(raw.schemaVersion === 1, `${itemPath}.schemaVersion: unsupported version`);
    for (const key of [
      "authorizationId",
      "runtimeId",
      "leaseId",
      "taskId",
      "sessionId",
      "actorId",
      "policyId",
      "invocationId",
      "approvalId",
    ]) {
      assertId(raw[key], `${itemPath}.${key}`);
    }
    assert(raw.taskId === task.taskId && raw.sessionId === task.sessionId, `${itemPath}: wrong task or session`);
    assert(
      Number.isSafeInteger(raw.leaseGeneration) && Number(raw.leaseGeneration) >= 1,
      `${itemPath}: invalid generation`
    );
    assert(
      Number.isSafeInteger(raw.policyRevision) && Number(raw.policyRevision) >= 1,
      `${itemPath}: invalid revision`
    );
    assert(
      typeof raw.invocationDigest === "string" && DIGEST.test(raw.invocationDigest),
      `${itemPath}: invalid digest`
    );
    assert(raw.approvalKind === "ask-once" || raw.approvalKind === "ask-always", `${itemPath}: invalid approval kind`);
    assert(
      typeof raw.capability === "string" && AGENT_CAPABILITIES.some((capability) => capability === raw.capability),
      `${itemPath}: invalid capability`
    );
    agentSchemas.targetScope.parse(raw.targetScope);
    assert(raw.risk === "low" || raw.risk === "risky" || raw.risk === "destructive", `${itemPath}: invalid risk`);
    assertTimestamp(raw.issuedAt, `${itemPath}.issuedAt`);
    assertTimestamp(raw.expiresAt, `${itemPath}.expiresAt`);
    return raw as unknown as NonNullable<AgentTaskRecord["invocationAuthorizations"]>[number];
  });
  assert(
    new Set(authorizations.map((item) => item.authorizationId)).size === authorizations.length,
    `${path}: duplicate ID`
  );
  return authorizations;
}

function parseCancellationReconciliation(
  value: unknown,
  path: string
): NonNullable<AgentTaskRecord["cancellationReconciliation"]> {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "leaseId",
      "runtimeId",
      "generation",
      "invocationId",
      "invocationDigest",
      "nextOrdinal",
      "expiresAt",
      "consumedAt",
      "resultDraftId",
    ],
    path
  );
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assertId(value.leaseId, `${path}.leaseId`);
  assertId(value.runtimeId, `${path}.runtimeId`);
  assertId(value.invocationId, `${path}.invocationId`);
  assert(
    typeof value.invocationDigest === "string" && DIGEST.test(value.invocationDigest),
    `${path}.invocationDigest: invalid digest`
  );
  assert(Number.isSafeInteger(value.generation) && Number(value.generation) >= 1, `${path}.generation: invalid`);
  assert(Number.isSafeInteger(value.nextOrdinal) && Number(value.nextOrdinal) >= 1, `${path}.nextOrdinal: invalid`);
  assertTimestamp(value.expiresAt, `${path}.expiresAt`);
  if (value.consumedAt !== undefined) assertTimestamp(value.consumedAt, `${path}.consumedAt`);
  if (value.resultDraftId !== undefined) assertId(value.resultDraftId, `${path}.resultDraftId`);
  assert(
    (value.consumedAt === undefined) === (value.resultDraftId === undefined),
    `${path}: consumedAt and resultDraftId must appear together`
  );
  return value as unknown as NonNullable<AgentTaskRecord["cancellationReconciliation"]>;
}

function parseLease(value: unknown, path: string): AgentWorkLease {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(
    value,
    ["schemaVersion", "leaseId", "claimId", "runtimeId", "generation", "acquiredAt", "expiresAt", "acknowledgedAt"],
    path
  );
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assertId(value.leaseId, `${path}.leaseId`);
  assertId(value.claimId, `${path}.claimId`);
  assertId(value.runtimeId, `${path}.runtimeId`);
  assert(Number.isSafeInteger(value.generation) && Number(value.generation) >= 1, `${path}.generation: invalid`);
  assertTimestamp(value.acquiredAt, `${path}.acquiredAt`);
  assertTimestamp(value.expiresAt, `${path}.expiresAt`);
  assert(Date.parse(value.expiresAt as string) > Date.parse(value.acquiredAt as string), `${path}: invalid expiry`);
  if (value.acknowledgedAt !== undefined) {
    assertTimestamp(value.acknowledgedAt, `${path}.acknowledgedAt`);
  }
  return value as unknown as AgentWorkLease;
}

function parseCancellation(value: unknown, path: string): AgentCancellationState {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(value, ["schemaVersion", "requestedAt", "requestedBy", "reason"], path);
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assertTimestamp(value.requestedAt, `${path}.requestedAt`);
  assertId(value.requestedBy, `${path}.requestedBy`);
  assert(typeof value.reason === "string" && value.reason.length > 0, `${path}.reason: must be non-empty`);
  return value as unknown as AgentCancellationState;
}

function parseIdempotency(value: unknown, path: string): AgentStateIdempotencyRecord {
  assert(isRecord(value), `${path}: must be an object`);
  assertExactKeys(value, ["schemaVersion", "key", "operation", "fingerprint", "recordedAt"], path);
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, `${path}.schemaVersion: unsupported version`);
  assert(typeof value.key === "string" && IDEMPOTENCY_KEY.test(value.key), `${path}.key: invalid idempotency key`);
  assert(typeof value.operation === "string" && value.operation.length > 0, `${path}.operation: must be non-empty`);
  assert(
    typeof value.fingerprint === "string" && DIGEST.test(value.fingerprint),
    `${path}.fingerprint: invalid digest`
  );
  assertTimestamp(value.recordedAt, `${path}.recordedAt`);
  return value as unknown as AgentStateIdempotencyRecord;
}

function parsePolicySnapshot(value: unknown, session: AgentSession) {
  const policy = agentSchemas.permissionPolicy.parse(value);
  assert(
    policy.policyId === session.policyId && policy.revision === session.policyRevision,
    "agentState.policySnapshot: does not match session policy"
  );
  return policy;
}

function assertSessionChildren(session: AgentSession, tasks: AgentTaskRecord[], approvals: AgentApproval[]): void {
  const tasksAreTerminal = tasks.every((task) => ["cancelled", "failed", "completed"].includes(task.status));
  if (["cancelled", "failed", "completed"].includes(session.status)) {
    assert(tasksAreTerminal, "agentState.tasks: terminal session has active tasks");
    assert(
      approvals.every(
        (approval) =>
          approval.decision !== "pending" &&
          !(
            approval.decision === "approved" &&
            (approval.scope.kind === "session-capability" || approval.consumedAt === undefined)
          )
      ),
      "agentState.approvals: terminal session has active approvals"
    );
  }
  if (session.status === "idle") assert(tasksAreTerminal, "agentState.tasks: idle session has active tasks");
}

export function validateDurableAgentSessionState(value: unknown): DurableAgentSessionState {
  assert(isRecord(value), "agentState: must be an object");
  assertExactKeys(value, STATE_KEYS, "agentState");
  assert(value.schemaVersion === AGENT_SCHEMA_VERSION, "agentState.schemaVersion: unsupported version");
  assert(Number.isSafeInteger(value.revision) && Number(value.revision) >= 1, "agentState.revision: invalid revision");
  const session = agentSchemas.agentSession.parse(value.session);
  const policySnapshot = parsePolicySnapshot(value.policySnapshot, session);
  assert(Array.isArray(value.statusHistory) && value.statusHistory.length > 0, "agentState.statusHistory: required");
  for (const [index, transition] of value.statusHistory.entries()) {
    const path = `agentState.statusHistory[${index}]`;
    assert(isRecord(transition), `${path}: must be an object`);
    assertExactKeys(transition, ["schemaVersion", "from", "to", "at", "reason"], path);
    assert(transition.schemaVersion === 1, `${path}.schemaVersion: unsupported version`);
    assert(
      transition.from === null ||
        ["pending", "running", "waiting-approval", "idle", "cancelled", "failed", "completed"].includes(
          String(transition.from)
        ),
      `${path}.from: invalid status`
    );
    assert(
      ["pending", "running", "waiting-approval", "idle", "cancelled", "failed", "completed"].includes(
        String(transition.to)
      ),
      `${path}.to: invalid status`
    );
    assertTimestamp(transition.at, `${path}.at`);
    assert(typeof transition.reason === "string", `${path}.reason: must be a string`);
    if (transition.from !== null) {
      const legal: Record<string, readonly string[]> = {
        pending: ["running", "cancelled", "failed"],
        running: ["waiting-approval", "idle", "cancelled", "failed", "completed"],
        "waiting-approval": ["running", "cancelled", "failed"],
        idle: ["pending", "cancelled", "failed"],
        cancelled: [],
        failed: ["idle"],
        completed: [],
      };
      assert(legal[String(transition.from)].includes(String(transition.to)), `${path}: illegal state transition`);
    }
    if (index > 0) {
      assert(
        value.statusHistory[index - 1].to === transition.from,
        `${path}.from: does not continue the preceding transition`
      );
    }
  }
  assert(value.statusHistory.at(-1)?.to === session.status, "agentState.statusHistory: does not match session status");
  assert(Array.isArray(value.tasks), "agentState.tasks: must be an array");
  const tasks = value.tasks.map((task, index) => parseTask(task, session.sessionId, `agentState.tasks[${index}]`));
  assert(new Set(tasks.map((task) => task.taskId)).size === tasks.length, "agentState.tasks: duplicate task ID");
  assert(Array.isArray(value.approvals), "agentState.approvals: must be an array");
  const approvals = value.approvals.map((approval) => agentSchemas.agentApproval.parse(approval));
  assert(
    approvals.every(
      (approval) =>
        approval.sessionId === session.sessionId &&
        approval.actorId === session.actorId &&
        approval.policyId === session.policyId &&
        approval.policyRevision === session.policyRevision
    ),
    "agentState.approvals: wrong session actor or policy"
  );
  assert(
    new Set(approvals.map((approval) => approval.approvalId)).size === approvals.length,
    "agentState.approvals: duplicate approval ID"
  );
  const cancellation =
    value.cancellation === undefined ? undefined : parseCancellation(value.cancellation, "agentState.cancellation");
  assert(
    (session.status === "cancelled") === Boolean(cancellation),
    "agentState.cancellation: inconsistent session state"
  );
  assertSessionChildren(session, tasks, approvals);
  assert(Array.isArray(value.events), "agentState.events: must be an array");
  const events = value.events.map((event) => agentSchemas.agentEvent.parse(event));
  assert(
    events.every((event) => event.sessionId === session.sessionId),
    "agentState.events: wrong session"
  );
  assert(new Set(events.map((event) => event.eventId)).size === events.length, "agentState.events: duplicate event ID");
  for (let index = 1; index < events.length; index++) {
    assert(events[index].sequence === events[index - 1].sequence + 1, "agentState.events: sequence gap");
  }
  assert(
    Number.isSafeInteger(value.nextEventSequence) && Number(value.nextEventSequence) >= 1,
    "agentState.nextEventSequence: invalid"
  );
  assert(
    Number.isSafeInteger(value.retainedFromSequence) && Number(value.retainedFromSequence) >= 1,
    "agentState.retainedFromSequence: invalid"
  );
  const expectedNext = events.length > 0 ? events.at(-1)!.sequence + 1 : Number(value.retainedFromSequence);
  assert(value.nextEventSequence === expectedNext, "agentState.nextEventSequence: inconsistent with events");
  if (events.length > 0)
    assert(events[0].sequence === value.retainedFromSequence, "agentState.events: invalid retention floor");
  assert(Array.isArray(value.idempotency), "agentState.idempotency: must be an array");
  const idempotency = value.idempotency.map((entry, index) =>
    parseIdempotency(entry, `agentState.idempotency[${index}]`)
  );
  assert(
    new Set(idempotency.map((entry) => entry.key)).size === idempotency.length,
    "agentState.idempotency: duplicate key"
  );
  return {
    ...(value as unknown as DurableAgentSessionState),
    session,
    policySnapshot,
    tasks,
    approvals,
    cancellation,
    events,
    idempotency,
  };
}

export function serializeAgentSessionState(state: DurableAgentSessionState): string {
  return JSON.stringify(validateDurableAgentSessionState(state));
}

export function deserializeAgentSessionState(value: string): DurableAgentSessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AgentStateSerializationError("agentState: malformed JSON");
  }
  return validateDurableAgentSessionState(parsed);
}
