import type { AgentApproval } from "@/lib/agent/contracts";
import { AgentStateConflictError } from "@/lib/agent/state/contracts";
import type { DurableAgentSessionState } from "@/lib/agent/state/contracts";
import type { AgentSessionSummaryRecord } from "@/lib/agent/state/repository-metadata";
import type { AgentRuntimeWorkClaim } from "@/lib/agent/state/repository-metadata";
import { projectAgentSessionSummary } from "@/lib/agent/state/repository-metadata";
import {
  AGENT_STATE_MAX_SERIALIZED_BYTES,
  AgentStateSerializationError,
  deserializeAgentSessionState,
  serializeAgentSessionState,
  serializedUtf8Bytes,
} from "@/lib/agent/state/serialization";

interface DurableObjectTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStorageLike extends DurableObjectTransactionLike {
  transaction<T>(callback: (transaction: DurableObjectTransactionLike) => Promise<T>): Promise<T>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

interface AgentSessionShardEnvironment {
  AGENT_SESSION_INDEX_DURABLE_OBJECT?: DurableObjectNamespaceLike;
}

interface LegacyMigrationSource {
  schemaVersion: 1;
  kind: "legacy-singleton-v1";
  epoch: number;
  revision: number;
  digest: string;
}

interface LegacyMigrationWatermark extends LegacyMigrationSource {}

interface TerminalFactRecord {
  schemaVersion: 1;
  session: null | {
    status: "cancelled" | "failed" | "completed";
    cancellation?: DurableAgentSessionState["cancellation"];
  };
  tasks: Array<{
    taskId: string;
    status: "cancelled" | "failed" | "completed";
    at: string;
  }>;
  approvals: AgentApproval[];
}

interface MigrationQuarantineRecord {
  schemaVersion: 1;
  reason: "migration-merge-over-budget";
  source: LegacyMigrationSource;
  currentRevision: number;
  currentDigest: string;
  attemptedMergedRevision: number;
  currentBytes: number;
  sourceBytes: number;
  recordedAt: string;
}

const ACTIVE_RECORD_KEY = "agent-session-active-v2";
const ARCHIVE_RECORD_KEY = "agent-session-archive-v2";
const INDEX_OUTBOX_KEY = "agent-session-index-outbox-v2";
const MIGRATION_WATERMARK_KEY = "agent-session-migration-watermark-v2";
const TERMINAL_FACTS_KEY = "agent-session-terminal-facts-v2";
const MIGRATION_QUARANTINE_KEY = "agent-session-migration-quarantine-v2";
const MIGRATION_QUARANTINE_SOURCE_KEY = "agent-session-migration-quarantine-source-v2";
const INDEX_COORDINATOR_NAME = "mc-aws-agent-session-index-v2";
const INDEX_RETRY_MS = 1_000;
const MAX_WAIT_MS = 30_000;
const MAX_INTERNAL_BODY_BYTES = 1_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVED_STATUSES = new Set(["idle", "cancelled", "failed", "completed"]);
const TERMINAL_STATUSES = new Set(["cancelled", "failed", "completed"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function migrationSource(value: unknown): LegacyMigrationSource | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "digest"]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "legacy-singleton-v1" ||
    !validInteger(value.epoch, 1) ||
    !validInteger(value.revision, 1) ||
    typeof value.digest !== "string" ||
    !SHA256_PATTERN.test(value.digest)
  ) {
    return null;
  }
  return value as unknown as LegacyMigrationSource;
}

function mergeDistinctByKey<T>(
  preferred: readonly T[],
  other: readonly T[],
  key: (value: T) => string,
  rejectDivergentDuplicate = false
): T[] {
  const preferredByKey = new Map(preferred.map((value) => [key(value), value]));
  if (rejectDivergentDuplicate) {
    for (const value of other) {
      const existing = preferredByKey.get(key(value));
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new AgentStateConflictError(`Migration lineage reused ${key(value)} with different content`);
      }
    }
  }
  return [...preferred, ...other.filter((value) => !preferredByKey.has(key(value)))].map((value) =>
    structuredClone(value)
  );
}

function approvalIdentity(approval: AgentApproval): string {
  const {
    decision: _decision,
    reason: _reason,
    decidedAt: _decidedAt,
    consumedAt: _consumedAt,
    ...identity
  } = approval;
  return JSON.stringify(identity);
}

function approvalAuthorityRank(approval: AgentApproval): number {
  if (approval.decision === "revoked") return 6;
  if (approval.decision === "denied") return 5;
  if (approval.decision === "cancelled") return 4;
  if (approval.consumedAt !== undefined) return 3;
  if (approval.decision === "approved") return 2;
  return 1;
}

/** Merge one logical approval as a monotonic authority-removal fact. */
function mergeApproval(existing: AgentApproval, candidate: AgentApproval): AgentApproval {
  if (approvalIdentity(existing) !== approvalIdentity(candidate)) {
    throw new AgentStateConflictError(`Migration lineage reused ${existing.approvalId} with different approval scope`);
  }
  const existingRank = approvalAuthorityRank(existing);
  const candidateRank = approvalAuthorityRank(candidate);
  if (existingRank !== candidateRank) {
    return structuredClone(existingRank > candidateRank ? existing : candidate);
  }
  if (existing.consumedAt && candidate.consumedAt && existing.consumedAt !== candidate.consumedAt) {
    return structuredClone(existing.consumedAt < candidate.consumedAt ? existing : candidate);
  }
  return structuredClone(JSON.stringify(existing) <= JSON.stringify(candidate) ? existing : candidate);
}

function mergeApprovals(preferred: readonly AgentApproval[], other: readonly AgentApproval[]): AgentApproval[] {
  const merged = preferred.map((approval) => structuredClone(approval));
  const positions = new Map(merged.map((approval, index) => [approval.approvalId, index]));
  for (const approval of other) {
    const position = positions.get(approval.approvalId);
    if (position === undefined) {
      positions.set(approval.approvalId, merged.length);
      merged.push(structuredClone(approval));
    } else {
      merged[position] = mergeApproval(merged[position], approval);
    }
  }
  return merged;
}

function terminalStatus(value: string): value is "cancelled" | "failed" | "completed" {
  return TERMINAL_STATUSES.has(value);
}

function terminalRank(value: string): number {
  if (value === "cancelled") return 3;
  if (value === "failed") return 2;
  if (value === "completed") return 1;
  return 0;
}

function preferredLineage(
  current: DurableAgentSessionState,
  imported: DurableAgentSessionState
): [DurableAgentSessionState, DurableAgentSessionState] {
  const currentRank = terminalRank(current.session.status);
  const importedRank = terminalRank(imported.session.status);
  if (currentRank !== importedRank) return currentRank > importedRank ? [current, imported] : [imported, current];
  return imported.session.updatedAt.localeCompare(current.session.updatedAt) > 0
    ? [imported, current]
    : [current, imported];
}

function mergeTasks(
  preferred: DurableAgentSessionState["tasks"],
  other: DurableAgentSessionState["tasks"]
): DurableAgentSessionState["tasks"] {
  const merged = preferred.map((task) => structuredClone(task));
  const positions = new Map(merged.map((task, index) => [task.taskId, index]));
  for (const candidate of other) {
    const position = positions.get(candidate.taskId);
    if (position === undefined) {
      positions.set(candidate.taskId, merged.length);
      merged.push(structuredClone(candidate));
      continue;
    }
    const existing = merged[position];
    const existingRank = terminalRank(existing.status);
    const candidateRank = terminalRank(candidate.status);
    if (
      candidateRank > existingRank ||
      (candidateRank === existingRank && candidate.updatedAt.localeCompare(existing.updatedAt) > 0)
    ) {
      merged[position] = structuredClone(candidate);
    }
  }
  return merged;
}

function applySessionTerminalFact(
  state: DurableAgentSessionState,
  terminal: DurableAgentSessionState
): DurableAgentSessionState {
  if (!terminalStatus(terminal.session.status)) return state;
  const status = terminal.session.status;
  const at = terminal.cancellation?.requestedAt ?? terminal.session.updatedAt;
  const tasks = state.tasks.map((task) =>
    terminalStatus(task.status)
      ? task
      : {
          ...task,
          status,
          updatedAt: at,
          lease: undefined,
          activeRuntimeInvocation: undefined,
          invocationAuthorizations: undefined,
        }
  );
  const approvals = state.approvals.map((approval) =>
    approval.decision === "pending" || (approval.decision === "approved" && approval.consumedAt === undefined)
      ? { ...approval, decision: "cancelled" as const, reason: "terminal migration fact", decidedAt: at }
      : approval
  );
  return {
    ...state,
    session: structuredClone(terminal.session),
    statusHistory: structuredClone(terminal.statusHistory),
    tasks,
    approvals,
    ...(status === "cancelled"
      ? { cancellation: structuredClone(terminal.cancellation) }
      : { cancellation: undefined }),
  };
}

function collectTerminalFacts(state: DurableAgentSessionState, previous?: TerminalFactRecord): TerminalFactRecord {
  const taskFacts = new Map((previous?.tasks ?? []).map((fact) => [fact.taskId, fact]));
  for (const task of state.tasks) {
    if (!terminalStatus(task.status)) continue;
    const existing = taskFacts.get(task.taskId);
    if (!existing || terminalRank(task.status) > terminalRank(existing.status)) {
      taskFacts.set(task.taskId, { taskId: task.taskId, status: task.status, at: task.updatedAt });
    }
  }
  const priorSession = previous?.session ?? null;
  const stateSession = terminalStatus(state.session.status)
    ? {
        status: state.session.status,
        ...(state.cancellation ? { cancellation: structuredClone(state.cancellation) } : {}),
      }
    : null;
  const session =
    stateSession && (!priorSession || terminalRank(stateSession.status) > terminalRank(priorSession.status))
      ? stateSession
      : priorSession;
  const approvalFacts = mergeApprovals(
    previous?.approvals ?? [],
    state.approvals.filter(
      (approval) =>
        approval.decision === "denied" ||
        approval.decision === "cancelled" ||
        approval.decision === "revoked" ||
        approval.consumedAt !== undefined
    )
  );
  return { schemaVersion: 1, session, tasks: Array.from(taskFacts.values()), approvals: approvalFacts };
}

function assertTerminalFacts(facts: TerminalFactRecord, candidate: DurableAgentSessionState): void {
  if (facts.session && candidate.session.status !== facts.session.status) {
    throw new AgentStateConflictError("Terminal session migration fact cannot be reversed");
  }
  if (
    facts.session?.status === "cancelled" &&
    JSON.stringify(candidate.cancellation) !== JSON.stringify(facts.session.cancellation)
  ) {
    throw new AgentStateConflictError("Session cancellation fact cannot be replaced");
  }
  const tasks = new Map(candidate.tasks.map((task) => [task.taskId, task]));
  for (const fact of facts.tasks) {
    const task = tasks.get(fact.taskId);
    if (task && task.status !== fact.status) {
      throw new AgentStateConflictError(`Terminal task migration fact cannot be reversed: ${fact.taskId}`);
    }
  }
  const approvals = new Map(candidate.approvals.map((approval) => [approval.approvalId, approval]));
  for (const fact of facts.approvals ?? []) {
    const approval = approvals.get(fact.approvalId);
    if (approval && JSON.stringify(mergeApproval(fact, approval)) !== JSON.stringify(approval)) {
      throw new AgentStateConflictError(`Approval migration fact cannot be reversed: ${fact.approvalId}`);
    }
  }
}

function applyTerminalTaskFacts(
  facts: TerminalFactRecord,
  candidate: DurableAgentSessionState
): DurableAgentSessionState {
  if (facts.session) assertTerminalFacts({ ...facts, tasks: [] }, candidate);
  const taskFacts = new Map(facts.tasks.map((fact) => [fact.taskId, fact]));
  const tasks = candidate.tasks.map((task) => {
    const fact = taskFacts.get(task.taskId);
    if (!fact || task.status === fact.status) return task;
    return {
      ...task,
      status: fact.status,
      updatedAt: fact.at,
      lease: undefined,
      activeRuntimeInvocation: undefined,
      invocationAuthorizations: undefined,
    };
  });
  const reconciled = { ...candidate, tasks, approvals: mergeApprovals(candidate.approvals, facts.approvals ?? []) };
  assertTerminalFacts(facts, reconciled);
  return reconciled;
}

/**
 * Rejoins writes made on both sides of a deployment boundary without replacing
 * the newer branch wholesale. Mutable scalar/task state follows the branch with
 * the latest session timestamp; append-only turns, events, and operation
 * idempotency evidence from both branches are retained.
 */
function mergeDivergentStates(
  current: DurableAgentSessionState,
  imported: DurableAgentSessionState
): DurableAgentSessionState {
  const [preferred, other] = preferredLineage(current, imported);
  const events = mergeDistinctByKey(preferred.events, other.events, (event) => event.eventId, true);
  // Keep the preferred branch's published cursors stable; unseen events from
  // the other branch continue after its current stream.
  const retainedFromSequence = preferred.retainedFromSequence;
  const resequencedEvents = events.map((event, index) => ({
    ...event,
    sequence: retainedFromSequence + index,
    replayCursor: `${preferred.session.sessionId}:${retainedFromSequence + index}`,
  }));
  const merged: DurableAgentSessionState = {
    ...structuredClone(preferred),
    revision: Math.max(current.revision, imported.revision) + 1,
    session: {
      ...structuredClone(preferred.session),
      turns: mergeDistinctByKey(preferred.session.turns, other.session.turns, (turn) => turn.turnId, true),
    },
    tasks: mergeTasks(preferred.tasks, other.tasks),
    approvals: mergeApprovals(preferred.approvals, other.approvals),
    events: resequencedEvents,
    retainedFromSequence,
    nextEventSequence: retainedFromSequence + resequencedEvents.length,
    idempotency: mergeDistinctByKey(preferred.idempotency, other.idempotency, (entry) => entry.key, true),
  };
  return terminalStatus(preferred.session.status) ? applySessionTerminalFact(merged, preferred) : merged;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
  const body = JSON.parse(text) as unknown;
  if (!isRecord(body)) throw new Error("invalid_input");
  return body;
}

/** One authoritative aggregate per object name. Idle/terminal detail is moved to the object's lazy archive slot. */
export class AgentSessionShardDurableObject {
  private readonly waiters = new Set<{ afterRevision: number; resolve: () => void }>();

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly environment: AgentSessionShardEnvironment = {}
  ) {}

  async alarm(): Promise<void> {
    await this.flushIndexOutbox();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/session/create-value") return await this.createValue(request);
      if (path === "/session/cas-value") return await this.compareAndSwapValue(request);
      if (path === "/session/import-value") return await this.importLegacyValueRequest(request);
      const body = await readBody(request);
      switch (path) {
        case "/session/read":
          return await this.read(body);
        case "/session/read-value":
          return await this.readValue(body);
        case "/session/create":
          return await this.create(body);
        case "/session/cas":
          return await this.compareAndSwap(body);
        case "/session/wait":
          return await this.wait(body, request.signal);
        case "/session/migration-probe":
          return await this.migrationProbe(body);
        case "/session/migration-quarantine":
          return await this.migrationQuarantine(body);
        case "/session/migration-quarantine-value":
          return await this.migrationQuarantineValue(body);
        case "/session/import":
          return await this.importLegacy(body);
        default:
          return json({ ok: false, code: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof AgentStateConflictError) return json({ ok: false, code: "conflict" }, 409);
      if (
        error instanceof SyntaxError ||
        error instanceof AgentStateSerializationError ||
        (error instanceof Error && ["body_too_large", "invalid_input"].includes(error.message))
      ) {
        return json({ ok: false, code: "invalid_input" }, 400);
      }
      return json({ ok: false, code: "unavailable" }, 503);
    }
  }

  private async read(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["sessionId"]) || !validSessionId(body.sessionId)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const value = await this.current(this.state.storage);
    if (value === undefined) return json({ ok: true, record: null });
    const parsed = deserializeAgentSessionState(value);
    if (parsed.session.sessionId !== body.sessionId) return json({ ok: false, code: "conflict" }, 409);
    return json({ ok: true, record: { revision: parsed.revision, value } });
  }

  private async readValue(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["sessionId"]) || !validSessionId(body.sessionId)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const value = await this.current(this.state.storage);
    if (value === undefined) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    const parsed = deserializeAgentSessionState(value);
    if (parsed.session.sessionId !== body.sessionId) return json({ ok: false, code: "conflict" }, 409);
    return new Response(value, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Agent-State-Revision": String(parsed.revision),
      },
    });
  }

  private async createValue(request: Request): Promise<Response> {
    if (request.headers.has("x-agent-migration-epoch")) {
      return json({ ok: false, code: "conflict" }, 409);
    }
    const sessionId = request.headers.get("x-agent-session-id");
    const value = await this.readRawValue(request);
    return await this.create({ sessionId, value });
  }

  private async compareAndSwapValue(request: Request): Promise<Response> {
    const sessionId = request.headers.get("x-agent-session-id");
    const expectedRevision = Number(request.headers.get("x-agent-expected-revision"));
    const epochHeader = request.headers.get("x-agent-migration-epoch");
    const claimToken = request.headers.get("x-agent-runtime-claim-token");
    const runtimeId = request.headers.get("x-agent-runtime-id");
    const claimId = request.headers.get("x-agent-runtime-claim-id");
    const claimTask = request.headers.get("x-agent-runtime-claim-task");
    const claimRevision = request.headers.get("x-agent-runtime-claim-revision");
    const claimHeaders = [claimToken, runtimeId, claimId, claimTask, claimRevision];
    if (claimHeaders.some((value) => value !== null) && claimHeaders.some((value) => value === null)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const value = await this.readRawValue(request);
    return await this.compareAndSwap({
      sessionId,
      expectedRevision,
      value,
      ...(epochHeader === null ? {} : { migrationEpoch: Number(epochHeader) }),
      ...(claimToken === null
        ? {}
        : {
            runtimeWorkClaim: {
              schemaVersion: 1,
              token: claimToken,
              runtimeId,
              claimId,
              sessionId,
              taskId: claimTask,
              revision: Number(claimRevision),
            },
          }),
    });
  }

  private async importLegacyValueRequest(request: Request): Promise<Response> {
    const source = {
      schemaVersion: 1,
      kind: "legacy-singleton-v1",
      epoch: Number(request.headers.get("x-agent-migration-epoch")),
      revision: Number(request.headers.get("x-agent-migration-revision")),
      digest: request.headers.get("x-agent-migration-digest"),
    };
    const sessionId = request.headers.get("x-agent-session-id");
    const value = await this.readRawValue(request);
    return await this.importLegacyValue({ sessionId, value, source });
  }

  private async readRawValue(request: Request): Promise<string> {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
    const value = await request.text();
    if (serializedUtf8Bytes(value) > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
    return value;
  }

  private async create(body: Record<string, unknown>): Promise<Response> {
    const parsed = this.validateWrite(body, 1);
    await this.state.storage.transaction(async (transaction) => {
      if ((await this.current(transaction)) !== undefined) throw new AgentStateConflictError("Session already exists");
      await this.putRecord(transaction, body.value as string, parsed.session.status);
      await transaction.put(TERMINAL_FACTS_KEY, collectTerminalFacts(parsed));
      await transaction.put(INDEX_OUTBOX_KEY, projectAgentSessionSummary(parsed));
    });
    await this.flushIndexOutbox();
    this.notify(parsed.revision);
    return json({ ok: true, archived: ARCHIVED_STATUSES.has(parsed.session.status) });
  }

  private async compareAndSwap(body: Record<string, unknown>): Promise<Response> {
    if (
      !validInteger(body.expectedRevision, 1) ||
      (body.migrationEpoch !== undefined && !validInteger(body.migrationEpoch, 1))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const parsed = this.validateWrite(body, (body.expectedRevision as number) + 1, true);
    const currentValue = await this.current(this.state.storage);
    const currentState = currentValue ? deserializeAgentSessionState(currentValue) : undefined;
    const acquiredLease = currentState
      ? parsed.tasks.find((task) => {
          const prior = currentState.tasks.find((candidate) => candidate.taskId === task.taskId);
          return task.lease && (!prior?.lease || prior.lease.leaseId !== task.lease.leaseId);
        })
      : undefined;
    if (acquiredLease) {
      const claim = body.runtimeWorkClaim;
      if (!this.validRuntimeWorkClaim(claim) || !(await this.coordinatorAcceptsClaim(claim, acquiredLease))) {
        throw new AgentStateConflictError("Runtime lease acquisition lacks an active coordinator claim");
      }
    } else if (body.runtimeWorkClaim !== undefined) {
      throw new AgentStateConflictError("Coordinator claim was supplied for a non-acquisition CAS");
    }
    await this.state.storage.transaction(async (transaction) => {
      const current = await this.current(transaction);
      if (current === undefined || deserializeAgentSessionState(current).revision !== body.expectedRevision) {
        throw new AgentStateConflictError("Session revision conflict");
      }
      if (body.migrationEpoch !== undefined) {
        const watermark = await transaction.get<LegacyMigrationWatermark>(MIGRATION_WATERMARK_KEY);
        if (!watermark || watermark.epoch !== body.migrationEpoch) {
          throw new AgentStateConflictError("Legacy facade migration epoch is stale");
        }
      }
      const currentState = deserializeAgentSessionState(current);
      const facts =
        (await transaction.get<TerminalFactRecord>(TERMINAL_FACTS_KEY)) ?? collectTerminalFacts(currentState);
      assertTerminalFacts(facts, parsed);
      await this.putRecord(transaction, body.value as string, parsed.session.status);
      await transaction.put(TERMINAL_FACTS_KEY, collectTerminalFacts(parsed, facts));
      await transaction.put(INDEX_OUTBOX_KEY, projectAgentSessionSummary(parsed));
    });
    await this.flushIndexOutbox();
    this.notify(parsed.revision);
    return json({ ok: true, archived: ARCHIVED_STATUSES.has(parsed.session.status) });
  }

  private async migrationProbe(body: Record<string, unknown>): Promise<Response> {
    const source = migrationSource(body.source);
    if (!exactKeys(body, ["sessionId", "source"]) || !validSessionId(body.sessionId) || !source) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const value = await this.current(this.state.storage);
    if (value === undefined) return json({ ok: true, needsImport: true, summary: null });
    const current = deserializeAgentSessionState(value);
    if (current.session.sessionId !== body.sessionId) return json({ ok: false, code: "conflict" }, 409);
    const watermark = await this.state.storage.get<LegacyMigrationWatermark>(MIGRATION_WATERMARK_KEY);
    if (
      watermark &&
      source.epoch > watermark.epoch &&
      source.revision === watermark.revision &&
      source.digest === watermark.digest
    ) {
      await this.state.storage.transaction(async (transaction) => {
        const latest = await transaction.get<LegacyMigrationWatermark>(MIGRATION_WATERMARK_KEY);
        if (
          latest &&
          source.epoch > latest.epoch &&
          source.revision === latest.revision &&
          source.digest === latest.digest
        ) {
          await transaction.put(MIGRATION_WATERMARK_KEY, { ...source });
        }
      });
    }
    const needsImport =
      !watermark ||
      (source.epoch >= watermark.epoch &&
        (source.revision > watermark.revision ||
          (source.revision === watermark.revision && source.digest !== watermark.digest)));
    return json({ ok: true, needsImport, summary: projectAgentSessionSummary(current) });
  }

  private async migrationQuarantine(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["sessionId"]) || !validSessionId(body.sessionId)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const current = await this.current(this.state.storage);
    if (current === undefined || deserializeAgentSessionState(current).session.sessionId !== body.sessionId) {
      return json({ ok: false, code: "not_found" }, 404);
    }
    const quarantine = await this.state.storage.get<MigrationQuarantineRecord>(MIGRATION_QUARANTINE_KEY);
    return json({ ok: true, quarantine: quarantine ?? null });
  }

  private async migrationQuarantineValue(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["sessionId"]) || !validSessionId(body.sessionId)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const quarantine = await this.state.storage.get<MigrationQuarantineRecord>(MIGRATION_QUARANTINE_KEY);
    const value = await this.state.storage.get<string>(MIGRATION_QUARANTINE_SOURCE_KEY);
    if (!quarantine || value === undefined) return json({ ok: false, code: "not_found" }, 404);
    if (deserializeAgentSessionState(value).session.sessionId !== body.sessionId) {
      return json({ ok: false, code: "conflict" }, 409);
    }
    return new Response(value, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Agent-Migration-Revision": String(quarantine.source.revision),
        "X-Agent-Migration-Digest": quarantine.source.digest,
      },
    });
  }

  private async importLegacy(body: Record<string, unknown>): Promise<Response> {
    return await this.importLegacyValue(body);
  }

  private async importLegacyValue(body: Record<string, unknown>): Promise<Response> {
    const source = migrationSource(body.source);
    if (
      !exactKeys(body, ["sessionId", "value", "source"]) ||
      !validSessionId(body.sessionId) ||
      typeof body.value !== "string" ||
      serializedUtf8Bytes(body.value) > AGENT_STATE_MAX_SERIALIZED_BYTES ||
      !source
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const imported = deserializeAgentSessionState(body.value);
    if (
      imported.session.sessionId !== body.sessionId ||
      imported.revision !== source.revision ||
      (await sha256(body.value)) !== source.digest
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }

    let authoritative!: DurableAgentSessionState;
    let applied = false;
    let quarantined = false;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Import reconciliation deliberately compares epoch, source watermark, and both CAS lineages in one transaction.
    await this.state.storage.transaction(async (transaction) => {
      const currentValue = await this.current(transaction);
      const current = currentValue === undefined ? null : deserializeAgentSessionState(currentValue);
      const watermark = await transaction.get<LegacyMigrationWatermark>(MIGRATION_WATERMARK_KEY);
      const facts =
        (await transaction.get<TerminalFactRecord>(TERMINAL_FACTS_KEY)) ??
        (current ? collectTerminalFacts(current) : undefined);
      if (
        current &&
        watermark &&
        (source.epoch < watermark.epoch ||
          source.revision < watermark.revision ||
          (source.revision === watermark.revision && source.digest === watermark.digest))
      ) {
        authoritative = current;
        if (source.epoch > watermark.epoch && source.digest === watermark.digest) {
          await transaction.put(MIGRATION_WATERMARK_KEY, { ...source });
        }
        if (facts) await transaction.put(TERMINAL_FACTS_KEY, collectTerminalFacts(current, facts));
        return;
      }

      if (!current) {
        authoritative = imported;
      } else if (currentValue === body.value) {
        authoritative = current;
      } else {
        authoritative = mergeDivergentStates(current, imported);
      }
      if (facts) authoritative = applyTerminalTaskFacts(facts, authoritative);
      const authoritativeValue =
        authoritative === imported ? (body.value as string) : serializeAgentSessionState(authoritative);
      if (serializedUtf8Bytes(authoritativeValue) > AGENT_STATE_MAX_SERIALIZED_BYTES) {
        if (!current || currentValue === undefined) {
          throw new AgentStateSerializationError("Merged agent state exceeds its serialized byte budget");
        }
        authoritative = current;
        await transaction.put(MIGRATION_QUARANTINE_SOURCE_KEY, body.value as string);
        await transaction.put(MIGRATION_QUARANTINE_KEY, {
          schemaVersion: 1,
          reason: "migration-merge-over-budget",
          source: { ...source },
          currentRevision: current.revision,
          currentDigest: await sha256(currentValue),
          attemptedMergedRevision: Math.max(current.revision, imported.revision) + 1,
          currentBytes: serializedUtf8Bytes(currentValue),
          sourceBytes: serializedUtf8Bytes(body.value as string),
          recordedAt: imported.session.updatedAt,
        } satisfies MigrationQuarantineRecord);
        await transaction.put(MIGRATION_WATERMARK_KEY, { ...source });
        await transaction.put(TERMINAL_FACTS_KEY, collectTerminalFacts(current, facts));
        await transaction.put(INDEX_OUTBOX_KEY, projectAgentSessionSummary(current));
        quarantined = true;
        return;
      }
      if (facts) assertTerminalFacts(facts, authoritative);
      await this.putRecord(transaction, authoritativeValue, authoritative.session.status);
      await transaction.put(MIGRATION_WATERMARK_KEY, { ...source });
      await transaction.put(TERMINAL_FACTS_KEY, collectTerminalFacts(authoritative, facts));
      await transaction.put(INDEX_OUTBOX_KEY, projectAgentSessionSummary(authoritative));
      applied = currentValue !== authoritativeValue;
    });
    await this.flushIndexOutbox();
    if (applied) this.notify(authoritative.revision);
    return json({
      ok: true,
      applied,
      quarantined,
      revision: authoritative.revision,
      summary: projectAgentSessionSummary(authoritative),
    });
  }

  private async wait(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (
      !exactKeys(body, ["sessionId", "afterRevision", "timeoutMs"]) ||
      !validSessionId(body.sessionId) ||
      !validInteger(body.afterRevision, 0) ||
      !validInteger(body.timeoutMs, 0, MAX_WAIT_MS)
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const current = await this.revision(body.sessionId);
    if (current === null || current > body.afterRevision || body.timeoutMs === 0 || signal.aborted) {
      return json({ ok: true, changed: current !== null && current > body.afterRevision, revision: current });
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const waiter = { afterRevision: body.afterRevision as number, resolve: () => finish() };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.waiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(finish, body.timeoutMs as number);
      this.waiters.add(waiter);
      signal.addEventListener("abort", finish, { once: true });
      void this.revision(body.sessionId as string).then((revision) => {
        if (revision === null || revision > (body.afterRevision as number)) finish();
      });
    });
    const revision = await this.revision(body.sessionId);
    return json({ ok: true, changed: revision !== null && revision > body.afterRevision, revision });
  }

  private validateWrite(body: Record<string, unknown>, revision: number, cas = false) {
    const keys = cas
      ? body.migrationEpoch === undefined
        ? body.runtimeWorkClaim === undefined
          ? ["sessionId", "expectedRevision", "value"]
          : ["sessionId", "expectedRevision", "value", "runtimeWorkClaim"]
        : ["sessionId", "expectedRevision", "value", "migrationEpoch"]
      : ["sessionId", "value"];
    if (
      !exactKeys(body, keys) ||
      !validSessionId(body.sessionId) ||
      typeof body.value !== "string" ||
      serializedUtf8Bytes(body.value) > AGENT_STATE_MAX_SERIALIZED_BYTES
    ) {
      throw new Error("invalid_input");
    }
    const parsed = deserializeAgentSessionState(body.value);
    if (parsed.session.sessionId !== body.sessionId || parsed.revision !== revision) throw new Error("invalid_input");
    return parsed;
  }

  private validRuntimeWorkClaim(value: unknown): value is Omit<AgentRuntimeWorkClaim, "issuedAt" | "expiresAt"> {
    return (
      isRecord(value) &&
      exactKeys(value, ["schemaVersion", "token", "runtimeId", "claimId", "sessionId", "taskId", "revision"]) &&
      value.schemaVersion === 1 &&
      [value.token, value.runtimeId, value.claimId, value.sessionId, value.taskId].every(
        (item) => typeof item === "string" && ID_PATTERN.test(item)
      ) &&
      validInteger(value.revision, 1)
    );
  }

  private async coordinatorAcceptsClaim(
    claim: Omit<AgentRuntimeWorkClaim, "issuedAt" | "expiresAt">,
    task: DurableAgentSessionState["tasks"][number]
  ): Promise<boolean> {
    const namespace = this.environment.AGENT_SESSION_INDEX_DURABLE_OBJECT;
    if (
      !namespace ||
      claim.sessionId !== task.sessionId ||
      claim.taskId !== task.taskId ||
      task.lease?.runtimeId !== claim.runtimeId ||
      task.lease.claimId !== claim.claimId
    ) {
      return false;
    }
    const stub = namespace.get(namespace.idFromName(INDEX_COORDINATOR_NAME));
    const response = await stub.fetch("https://agent-session.internal/index/work-claim-validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...claim, at: task.lease.acquiredAt }),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { valid?: unknown };
    return result.valid === true;
  }

  private async putRecord(transaction: DurableObjectTransactionLike, value: string, status: string): Promise<void> {
    const archive = ARCHIVED_STATUSES.has(status);
    await transaction.put(archive ? ARCHIVE_RECORD_KEY : ACTIVE_RECORD_KEY, value);
    await transaction.delete(archive ? ACTIVE_RECORD_KEY : ARCHIVE_RECORD_KEY);
  }

  private async current(storage: DurableObjectTransactionLike): Promise<string | undefined> {
    return (await storage.get<string>(ACTIVE_RECORD_KEY)) ?? (await storage.get<string>(ARCHIVE_RECORD_KEY));
  }

  private async revision(sessionId: string): Promise<number | null> {
    const value = await this.current(this.state.storage);
    if (value === undefined) return null;
    const parsed = deserializeAgentSessionState(value);
    return parsed.session.sessionId === sessionId ? parsed.revision : null;
  }

  private notify(revision: number): void {
    for (const waiter of this.waiters) if (revision > waiter.afterRevision) waiter.resolve();
  }

  private async flushIndexOutbox(): Promise<void> {
    const summary = await this.state.storage.get<AgentSessionSummaryRecord>(INDEX_OUTBOX_KEY);
    if (!summary) return;
    const namespace = this.environment.AGENT_SESSION_INDEX_DURABLE_OBJECT;
    if (!namespace) return;
    try {
      const stub = namespace.get(namespace.idFromName(INDEX_COORDINATOR_NAME));
      const response = await stub.fetch("https://agent-session.internal/index/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      if (!response.ok) throw new Error("index_unavailable");
      await this.state.storage.transaction(async (transaction) => {
        const current = await transaction.get<AgentSessionSummaryRecord>(INDEX_OUTBOX_KEY);
        if (current?.revision === summary.revision) await transaction.delete(INDEX_OUTBOX_KEY);
      });
    } catch {
      await this.state.storage.setAlarm?.(Date.now() + INDEX_RETRY_MS);
    }
  }
}
