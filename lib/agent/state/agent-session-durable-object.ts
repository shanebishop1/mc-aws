import { AgentStateConflictError } from "@/lib/agent/state/contracts";
import { projectAgentSessionSummary } from "@/lib/agent/state/repository-metadata";
import {
  AGENT_STATE_MAX_SERIALIZED_BYTES,
  AgentStateSerializationError,
  deserializeAgentSessionState,
  serializedUtf8Bytes,
} from "@/lib/agent/state/serialization";

interface DurableObjectTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStorageLike extends DurableObjectTransactionLike {
  transaction<T>(callback: (transaction: DurableObjectTransactionLike) => Promise<T>): Promise<T>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

interface AgentSessionLegacyEnvironment {
  AGENT_SESSION_SHARD_DURABLE_OBJECT?: DurableObjectNamespaceLike;
}

interface LegacyMigrationSource {
  schemaVersion: 1;
  kind: "legacy-singleton-v1";
  epoch: number;
  revision: number;
  digest: string;
}

interface RevisionWaiter {
  sessionId: string;
  afterRevision: number;
  resolve: () => void;
}

const INDEX_KEY = "agent-session-index-v1";
const RECORD_PREFIX = "agent-session-v1:";
const WRITE_FENCE_PREFIX = "agent-session-write-fence-v2:";
const MIGRATION_SOURCE_PREFIX = "agent-session-migration-source-v2:";
const SESSION_SHARD_PREFIX = "mc-aws-agent-session-v2:";
const WRITE_FENCE_SENTINEL = '{"schemaVersion":0,"kind":"agent-session-write-fence-v2"}';
const MAX_SESSIONS = 500;
const MAX_LIST_LIMIT = 500;
const MAX_MIGRATION_BATCH = 1;
const MAX_WAIT_MS = 30_000;
const MAX_INTERNAL_BODY_BYTES = 2_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) throw new Error("body_too_large");
  return JSON.parse(text) as unknown;
}

/**
 * Legacy v1 singleton retained for bounded migration and rollback compatibility.
 * The production v2 repository never creates or mutates sessions here.
 */
export class AgentSessionDurableObject {
  private readonly waiters = new Set<RevisionWaiter>();

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly environment: AgentSessionLegacyEnvironment = {}
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);
    const path = new URL(request.url).pathname;
    try {
      const body = await readBody(request);
      if (!isRecord(body)) return json({ ok: false, code: "invalid_input" }, 400);
      switch (path) {
        case "/repository/read":
          return await this.read(body);
        case "/repository/list":
          return await this.list(body);
        case "/repository/create":
          return await this.create(body);
        case "/repository/cas":
          return await this.compareAndSwap(body);
        case "/repository/wait":
          return await this.wait(body, request.signal);
        case "/repository/migration-summaries":
          return await this.migrationSummaries(body);
        case "/repository/migration-version":
          return await this.migrationVersion(body);
        case "/repository/migration-value":
          return await this.migrationValue(body);
        case "/repository/migration-fence":
          return await this.migrationFence(body);
        default:
          return json({ ok: false, code: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof AgentStateConflictError) return json({ ok: false, code: "conflict" }, 409);
      if (
        error instanceof SyntaxError ||
        error instanceof AgentStateSerializationError ||
        (error instanceof Error && error.message === "body_too_large")
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
    const forwarded = await this.forwardJsonIfFenced(body.sessionId, "read", body);
    if (forwarded) return forwarded;
    const value = await this.state.storage.get<string>(this.recordKey(body.sessionId));
    return json({ ok: true, record: value === undefined ? null : this.record(value) });
  }

  private async list(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["limit"]) || !validInteger(body.limit, 1, MAX_LIST_LIMIT)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const index = (await this.state.storage.get<string[]>(INDEX_KEY)) ?? [];
    return json({
      ok: true,
      sessionIds: index.slice(-body.limit).reverse(),
    });
  }

  private async create(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["sessionId", "value"]) ||
      !validSessionId(body.sessionId) ||
      typeof body.value !== "string" ||
      serializedUtf8Bytes(body.value) > AGENT_STATE_MAX_SERIALIZED_BYTES
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const parsed = deserializeAgentSessionState(body.value);
    if (parsed.session.sessionId !== body.sessionId || parsed.revision !== 1) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const forwarded = await this.forwardRawIfFenced(body.sessionId, "create-value", body.value);
    if (forwarded) return forwarded;
    let fencedDuringWrite = false;
    await this.state.storage.transaction(async (transaction) => {
      if (await transaction.get<LegacyMigrationSource>(this.fenceKey(body.sessionId as string))) {
        fencedDuringWrite = true;
        return;
      }
      const key = this.recordKey(body.sessionId as string);
      if ((await transaction.get<string>(key)) !== undefined) {
        throw new AgentStateConflictError("Agent session already exists");
      }
      const index = (await transaction.get<string[]>(INDEX_KEY)) ?? [];
      const retained = await this.evictTerminalSessions(transaction, index);
      if (retained.length >= MAX_SESSIONS) {
        throw new AgentStateConflictError("Agent session retention is full of active sessions");
      }
      await transaction.put(key, body.value as string);
      await transaction.put(INDEX_KEY, [...retained, body.sessionId as string]);
    });
    if (fencedDuringWrite) {
      return (
        (await this.forwardRawIfFenced(body.sessionId, "create-value", body.value)) ??
        json({ ok: false, code: "unavailable" }, 503)
      );
    }
    this.notify(body.sessionId, 1);
    return json({ ok: true });
  }

  private async migrationSummaries(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["cursor", "limit"]) ||
      !validInteger(body.cursor, 0) ||
      !validInteger(body.limit, 1, MAX_MIGRATION_BATCH)
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const index = (await this.state.storage.get<string[]>(INDEX_KEY)) ?? [];
    const end = Math.min(index.length, body.cursor + body.limit);
    const entries = [];
    for (let position = body.cursor; position < end; position++) {
      if (await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(index[position]))) continue;
      const value = await this.state.storage.get<string>(this.recordKey(index[position]));
      if (value !== undefined) {
        const state = deserializeAgentSessionState(value);
        entries.push({
          summary: projectAgentSessionSummary(state),
          source: {
            schemaVersion: 1,
            kind: "legacy-singleton-v1",
            revision: state.revision,
            digest: await sha256(value),
          },
        });
      }
    }
    return json({ ok: true, entries, cursor: end, complete: end >= index.length });
  }

  private async migrationVersion(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["sessionId"]) || !validSessionId(body.sessionId)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    if (await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(body.sessionId))) {
      return json({ ok: true, source: null });
    }
    const value = await this.state.storage.get<string>(this.recordKey(body.sessionId));
    if (value === undefined) return json({ ok: true, source: null });
    const state = deserializeAgentSessionState(value);
    return json({
      ok: true,
      source: {
        schemaVersion: 1,
        kind: "legacy-singleton-v1",
        revision: state.revision,
        digest: await sha256(value),
      },
    });
  }

  private async migrationValue(body: Record<string, unknown>): Promise<Response> {
    const source = migrationSource(body.source);
    if (!exactKeys(body, ["sessionId", "source"]) || !validSessionId(body.sessionId) || !source) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    if (await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(body.sessionId))) {
      return json({ ok: false, code: "conflict" }, 409);
    }
    const value = await this.state.storage.get<string>(this.recordKey(body.sessionId));
    if (value === undefined) return json({ ok: false, code: "not_found" }, 404);
    const state = deserializeAgentSessionState(value);
    if (state.revision !== source.revision || (await sha256(value)) !== source.digest) {
      return json({ ok: false, code: "conflict" }, 409);
    }
    return new Response(value, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Agent-State-Revision": String(state.revision),
      },
    });
  }

  private async migrationFence(body: Record<string, unknown>): Promise<Response> {
    const source = migrationSource(body.source);
    if (!exactKeys(body, ["sessionId", "source"]) || !validSessionId(body.sessionId) || !source) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const existingFence = await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(body.sessionId));
    if (existingFence) {
      return json({ ok: true, fenced: JSON.stringify(existingFence) === JSON.stringify(source) });
    }
    const key = this.recordKey(body.sessionId);
    const observed = await this.state.storage.get<string>(key);
    if (observed === undefined) return json({ ok: true, fenced: false });
    const state = deserializeAgentSessionState(observed);
    if (state.revision !== source.revision || (await sha256(observed)) !== source.digest) {
      return json({ ok: true, fenced: false });
    }
    let fenced = false;
    await this.state.storage.transaction(async (transaction) => {
      if ((await transaction.get<string>(key)) !== observed) return;
      await transaction.put(`${MIGRATION_SOURCE_PREFIX}${body.sessionId as string}`, observed);
      // Historical Worker versions do not understand the fence key. Leaving an
      // intentionally invalid aggregate in their v1 slot makes read/CAS fail
      // closed and create conflict instead of reopening a split-brain lineage.
      await transaction.put(key, WRITE_FENCE_SENTINEL);
      await transaction.put(this.fenceKey(body.sessionId as string), source);
      fenced = true;
    });
    return json({ ok: true, fenced });
  }

  private async compareAndSwap(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["sessionId", "expectedRevision", "value"]) ||
      !validSessionId(body.sessionId) ||
      !validInteger(body.expectedRevision, 1) ||
      typeof body.value !== "string" ||
      serializedUtf8Bytes(body.value) > AGENT_STATE_MAX_SERIALIZED_BYTES
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const parsed = deserializeAgentSessionState(body.value);
    if (parsed.session.sessionId !== body.sessionId || parsed.revision !== body.expectedRevision + 1) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const forwarded = await this.forwardRawIfFenced(
      body.sessionId,
      "cas-value",
      body.value,
      body.expectedRevision as number
    );
    if (forwarded) return forwarded;
    let fencedDuringWrite = false;
    await this.state.storage.transaction(async (transaction) => {
      if (await transaction.get<LegacyMigrationSource>(this.fenceKey(body.sessionId as string))) {
        fencedDuringWrite = true;
        return;
      }
      const key = this.recordKey(body.sessionId as string);
      const current = await transaction.get<string>(key);
      if (current === undefined || deserializeAgentSessionState(current).revision !== body.expectedRevision) {
        throw new AgentStateConflictError("Agent session revision conflict");
      }
      await transaction.put(key, body.value as string);
    });
    if (fencedDuringWrite) {
      return (
        (await this.forwardRawIfFenced(body.sessionId, "cas-value", body.value, body.expectedRevision as number)) ??
        json({ ok: false, code: "unavailable" }, 503)
      );
    }
    this.notify(body.sessionId, parsed.revision);
    return json({ ok: true });
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
    const forwarded = await this.forwardJsonIfFenced(body.sessionId, "wait", body, signal);
    if (forwarded) return forwarded;
    const current = await this.revision(body.sessionId);
    if (current === null || current > body.afterRevision || body.timeoutMs === 0 || signal.aborted) {
      return json({ ok: true, changed: current !== null && current > body.afterRevision, revision: current });
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const waiter: RevisionWaiter = {
        sessionId: body.sessionId as string,
        afterRevision: body.afterRevision as number,
        resolve: () => finish(),
      };
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

  private record(value: string) {
    return { revision: deserializeAgentSessionState(value).revision, value };
  }

  private async evictTerminalSessions(transaction: DurableObjectTransactionLike, index: string[]): Promise<string[]> {
    if (index.length < MAX_SESSIONS) return index;
    const retained = [...index];
    for (let position = 0; position < retained.length && retained.length >= MAX_SESSIONS; ) {
      const sessionId = retained[position];
      const key = this.recordKey(sessionId);
      const value = await transaction.get<string>(key);
      if (
        value !== undefined &&
        ["cancelled", "failed", "completed"].includes(deserializeAgentSessionState(value).session.status)
      ) {
        await transaction.delete(key);
        retained.splice(position, 1);
      } else {
        position++;
      }
    }
    return retained;
  }

  private async revision(sessionId: string): Promise<number | null> {
    const value = await this.state.storage.get<string>(this.recordKey(sessionId));
    return value === undefined ? null : deserializeAgentSessionState(value).revision;
  }

  private recordKey(sessionId: string): string {
    return `${RECORD_PREFIX}${sessionId}`;
  }

  private fenceKey(sessionId: string): string {
    return `${WRITE_FENCE_PREFIX}${sessionId}`;
  }

  private async forwardJsonIfFenced(
    sessionId: string,
    operation: "read" | "wait",
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response | null> {
    if (!(await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(sessionId)))) return null;
    const stub = this.shardStub(sessionId);
    if (!stub) return json({ ok: false, code: "unavailable" }, 503);
    return await stub.fetch(`https://agent-session.internal/session/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async forwardRawIfFenced(
    sessionId: string,
    operation: "create-value" | "cas-value",
    value: string,
    expectedRevision?: number
  ): Promise<Response | null> {
    const fence = await this.state.storage.get<LegacyMigrationSource>(this.fenceKey(sessionId));
    if (!fence) return null;
    const stub = this.shardStub(sessionId);
    if (!stub) return json({ ok: false, code: "unavailable" }, 503);
    return await stub.fetch(`https://agent-session.internal/session/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-session-id": sessionId,
        "x-agent-migration-epoch": String(fence.epoch),
        ...(expectedRevision === undefined ? {} : { "x-agent-expected-revision": String(expectedRevision) }),
      },
      body: value,
    });
  }

  private shardStub(sessionId: string) {
    const namespace = this.environment.AGENT_SESSION_SHARD_DURABLE_OBJECT;
    if (!namespace) return null;
    return namespace.get(namespace.idFromName(`${SESSION_SHARD_PREFIX}${sessionId}`));
  }

  private notify(sessionId: string, revision: number): void {
    for (const waiter of this.waiters) {
      if (waiter.sessionId === sessionId && revision > waiter.afterRevision) waiter.resolve();
    }
  }
}
