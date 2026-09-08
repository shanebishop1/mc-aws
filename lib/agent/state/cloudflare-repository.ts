import {
  AgentStateConflictError,
  type AgentStateRepository,
  type VersionedAgentStateRecord,
} from "@/lib/agent/state/contracts";
import {
  type AgentRuntimeWorkClaim,
  type AgentSessionSummaryRecord,
  type AgentWorkCandidateQuery,
  projectAgentSessionSummary,
} from "@/lib/agent/state/repository-metadata";
import { deserializeAgentSessionState } from "@/lib/agent/state/serialization";

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

const LEGACY_SINGLETON_NAME = "mc-aws-agent-control-plane-v1";
const INDEX_COORDINATOR_NAME = "mc-aws-agent-session-index-v2";
const SESSION_SHARD_PREFIX = "mc-aws-agent-session-v2:";
const LEGACY_MIGRATION_BATCH = 1;
const LEGACY_MIGRATION_SOURCE_EPOCH = 2;
const MAX_REPOSITORY_REQUEST_BYTES = 1_000_000;

interface LegacyMigrationSource {
  schemaVersion: 1;
  kind: "legacy-singleton-v1";
  epoch: number;
  revision: number;
  digest: string;
}

interface CloudflareAgentStateRepositoryOptions {
  now?: () => Date;
}

export class AgentStateConfigurationError extends Error {
  constructor() {
    super("Agent session state service is unavailable");
    this.name = "AgentStateConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSummary(value: unknown): AgentSessionSummaryRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    typeof value.actorId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.status !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.archived !== "boolean"
  ) {
    throw new AgentStateConfigurationError();
  }
  return value as unknown as AgentSessionSummaryRecord;
}

function parseMigrationSource(value: unknown, epoch: number): LegacyMigrationSource {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "legacy-singleton-v1" ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  ) {
    throw new AgentStateConfigurationError();
  }
  return { ...(value as unknown as Omit<LegacyMigrationSource, "epoch">), epoch };
}

function parseRuntimeWorkClaim(value: unknown): AgentRuntimeWorkClaim {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    ![
      value.token,
      value.runtimeId,
      value.claimId,
      value.sessionId,
      value.taskId,
      value.issuedAt,
      value.expiresAt,
    ].every((item) => typeof item === "string") ||
    !Number.isSafeInteger(value.revision)
  ) {
    throw new AgentStateConfigurationError();
  }
  return value as unknown as AgentRuntimeWorkClaim;
}

/** Per-session authoritative shards plus one compact summary/work coordinator and bounded legacy migration. */
export class CloudflareAgentStateRepository implements AgentStateRepository {
  private readonly legacyStub: DurableObjectStubLike;
  private readonly indexStub: DurableObjectStubLike;

  constructor(
    private readonly legacyNamespace: DurableObjectNamespaceLike,
    private readonly indexNamespace: DurableObjectNamespaceLike,
    private readonly sessionNamespace: DurableObjectNamespaceLike,
    private readonly options: CloudflareAgentStateRepositoryOptions = {}
  ) {
    try {
      this.legacyStub = legacyNamespace.get(legacyNamespace.idFromName(LEGACY_SINGLETON_NAME));
      this.indexStub = indexNamespace.get(indexNamespace.idFromName(INDEX_COORDINATOR_NAME));
    } catch {
      throw new AgentStateConfigurationError();
    }
  }

  async read(sessionId: string): Promise<VersionedAgentStateRecord | null> {
    const stub = this.sessionStub(sessionId);
    const sourcePayload = await this.call(this.legacyStub, "repository", "migration-version", { sessionId });
    if (!("source" in sourcePayload)) throw new AgentStateConfigurationError();
    if (sourcePayload.source !== null) {
      await this.reconcileLegacy(sessionId, parseMigrationSource(sourcePayload.source, LEGACY_MIGRATION_SOURCE_EPOCH));
    }
    return await this.readRawRecord(stub, sessionId);
  }

  async list(limit: number): Promise<VersionedAgentStateRecord[]> {
    const summaries = await this.listSummaries(limit);
    const records = await Promise.all(summaries.map((summary) => this.read(summary.sessionId)));
    return records.filter((record): record is VersionedAgentStateRecord => record !== null);
  }

  async listSummaries(limit: number, actorId?: string): Promise<AgentSessionSummaryRecord[]> {
    await this.migrateLegacyBatch();
    const payload = await this.call(this.indexStub, "index", "list", {
      limit,
      ...(actorId === undefined ? {} : { actorId }),
    });
    if (!Array.isArray(payload.summaries)) throw new AgentStateConfigurationError();
    return payload.summaries.map(parseSummary);
  }

  async listWorkCandidateSessionIds(query: AgentWorkCandidateQuery): Promise<string[]> {
    await this.migrateLegacyBatch();
    const payload = await this.call(this.indexStub, "index", "work-candidates", { ...query });
    if (!Array.isArray(payload.sessionIds) || payload.sessionIds.some((id) => typeof id !== "string")) {
      throw new AgentStateConfigurationError();
    }
    return payload.sessionIds as string[];
  }

  async claimRuntimeWorkCandidate(
    query: AgentWorkCandidateQuery & { claimDurationMs: number }
  ): Promise<AgentRuntimeWorkClaim | null> {
    await this.migrateLegacyBatch();
    const payload = await this.call(this.indexStub, "index", "work-claim", { ...query });
    return payload.claim === null ? null : parseRuntimeWorkClaim(payload.claim);
  }

  async releaseRuntimeWorkClaim(claim: AgentRuntimeWorkClaim): Promise<void> {
    await this.call(this.indexStub, "index", "work-claim-release", { token: claim.token });
  }

  async renewRuntimeWorkClaim(input: {
    runtimeId: string;
    claimId: string;
    sessionId: string;
    taskId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    const result = await this.call(this.indexStub, "index", "work-claim-renew", { ...input });
    if (result.renewed !== true) throw new AgentStateConflictError("Runtime lease renewal lost its coordinator claim");
  }

  async quarantineWorkCandidate(input: {
    sessionId: string;
    revision: number;
    reason: "runtime-response-over-budget" | "migration-merge-over-budget";
  }): Promise<void> {
    await this.call(this.indexStub, "index", "work-quarantine", input);
  }

  async create(sessionId: string, value: string): Promise<void> {
    await this.callRawState(this.sessionStub(sessionId), "session", "create-value", value, {
      "x-agent-session-id": sessionId,
    });
    await this.upsertSummaryAfterCommit(value);
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: number,
    value: string,
    runtimeWorkClaim?: AgentRuntimeWorkClaim
  ): Promise<void> {
    await this.callRawState(this.sessionStub(sessionId), "session", "cas-value", value, {
      "x-agent-session-id": sessionId,
      "x-agent-expected-revision": String(expectedRevision),
      ...(runtimeWorkClaim
        ? {
            "x-agent-runtime-claim-token": runtimeWorkClaim.token,
            "x-agent-runtime-id": runtimeWorkClaim.runtimeId,
            "x-agent-runtime-claim-id": runtimeWorkClaim.claimId,
            "x-agent-runtime-claim-task": runtimeWorkClaim.taskId,
            "x-agent-runtime-claim-revision": String(runtimeWorkClaim.revision),
          }
        : {}),
    });
    await this.upsertSummaryAfterCommit(value);
  }

  async waitForRevision(sessionId: string, afterRevision: number, timeoutMs: number, signal?: AbortSignal) {
    // Lazy migration ensures waits always target the authoritative per-session shard.
    if ((await this.read(sessionId)) === null) return { changed: false, revision: null };
    const payload = await this.call(
      this.sessionStub(sessionId),
      "session",
      "wait",
      { sessionId, afterRevision, timeoutMs },
      signal
    );
    if (
      typeof payload.changed !== "boolean" ||
      (payload.revision !== null && !Number.isSafeInteger(payload.revision))
    ) {
      throw new AgentStateConfigurationError();
    }
    return { changed: payload.changed, revision: payload.revision as number | null };
  }

  private async upsertSummary(value: string): Promise<void> {
    const summary = projectAgentSessionSummary(deserializeAgentSessionState(value));
    await this.call(this.indexStub, "index", "upsert", { summary });
  }

  private async upsertSummaryAfterCommit(value: string): Promise<void> {
    try {
      await this.upsertSummary(value);
    } catch (error) {
      if (!(error instanceof AgentStateConfigurationError)) throw error;
      // The shard committed the same summary to its durable outbox before acknowledging the write.
    }
  }

  private async migrateLegacyBatch(): Promise<void> {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const status = await this.call(this.indexStub, "index", "migration-state", {
      sourceEpoch: LEGACY_MIGRATION_SOURCE_EPOCH,
      now,
    });
    if (
      !isRecord(status.migration) ||
      !Number.isSafeInteger(status.migration.cursor) ||
      !Number.isSafeInteger(status.migration.scanEpoch) ||
      status.migration.sourceEpoch !== LEGACY_MIGRATION_SOURCE_EPOCH
    ) {
      throw new AgentStateConfigurationError();
    }
    if (status.migration.complete === true) return;
    const cursor = status.migration.cursor as number;
    const batch = await this.call(this.legacyStub, "repository", "migration-summaries", {
      cursor,
      limit: LEGACY_MIGRATION_BATCH,
    });
    if (!Array.isArray(batch.entries) || !Number.isSafeInteger(batch.cursor) || typeof batch.complete !== "boolean") {
      throw new AgentStateConfigurationError();
    }
    for (const entry of batch.entries) {
      if (!isRecord(entry) || !("source" in entry) || !("summary" in entry)) {
        throw new AgentStateConfigurationError();
      }
      const summary = parseSummary(entry.summary);
      const source = parseMigrationSource(entry.source, LEGACY_MIGRATION_SOURCE_EPOCH);
      if (summary.sessionId === "" || summary.revision !== source.revision) throw new AgentStateConfigurationError();
      await this.reconcileLegacy(summary.sessionId, source);
    }
    await this.call(this.indexStub, "index", "migration-advance", {
      sourceEpoch: LEGACY_MIGRATION_SOURCE_EPOCH,
      scanEpoch: status.migration.scanEpoch,
      expectedCursor: cursor,
      cursor: batch.cursor,
      complete: batch.complete,
      now,
    });
  }

  private async reconcileLegacy(sessionId: string, source: LegacyMigrationSource): Promise<void> {
    const stub = this.sessionStub(sessionId);
    const probe = await this.call(stub, "session", "migration-probe", { sessionId, source });
    if (typeof probe.needsImport !== "boolean") throw new AgentStateConfigurationError();
    if (!probe.needsImport) {
      if (probe.summary !== null)
        await this.call(this.indexStub, "index", "upsert", { summary: parseSummary(probe.summary) });
      await this.fenceLegacyWrites(sessionId, source);
      return;
    }
    const record = await this.readLegacyMigrationValue(sessionId, source);
    if (record.revision !== source.revision) throw new AgentStateConfigurationError();
    const imported = await this.callRawState(stub, "session", "import-value", record.value, {
      "x-agent-session-id": sessionId,
      "x-agent-migration-epoch": String(source.epoch),
      "x-agent-migration-revision": String(source.revision),
      "x-agent-migration-digest": source.digest,
    });
    if (!Number.isSafeInteger(imported.revision) || !("summary" in imported)) throw new AgentStateConfigurationError();
    const summary = parseSummary(imported.summary);
    await this.call(this.indexStub, "index", "upsert", { summary });
    if (imported.quarantined === true) {
      await this.quarantineWorkCandidate({
        sessionId,
        revision: summary.revision,
        reason: "migration-merge-over-budget",
      });
    }
    await this.fenceLegacyWrites(sessionId, source);
  }

  private async fenceLegacyWrites(sessionId: string, source: LegacyMigrationSource): Promise<void> {
    const result = await this.call(this.legacyStub, "repository", "migration-fence", { sessionId, source });
    if (result.fenced !== true) throw new AgentStateConfigurationError();
  }

  private async readLegacyMigrationValue(
    sessionId: string,
    source: LegacyMigrationSource
  ): Promise<VersionedAgentStateRecord> {
    const response = await this.fetch(
      this.legacyStub,
      "repository",
      "migration-value",
      JSON.stringify({ sessionId, source }),
      { "content-type": "application/json" }
    );
    if (!response.ok) throw new AgentStateConfigurationError();
    const revision = Number(response.headers.get("x-agent-state-revision"));
    const value = await response.text();
    if (!Number.isSafeInteger(revision) || serializedBytes(value) > MAX_REPOSITORY_REQUEST_BYTES) {
      throw new AgentStateConfigurationError();
    }
    return { revision, value };
  }

  private async readRawRecord(
    stub: DurableObjectStubLike,
    sessionId: string
  ): Promise<VersionedAgentStateRecord | null> {
    const response = await this.fetch(stub, "session", "read-value", JSON.stringify({ sessionId }), {
      "content-type": "application/json",
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new AgentStateConfigurationError();
    const revision = Number(response.headers.get("x-agent-state-revision"));
    const value = await response.text();
    if (!Number.isSafeInteger(revision) || serializedBytes(value) > MAX_REPOSITORY_REQUEST_BYTES) {
      throw new AgentStateConfigurationError();
    }
    return { revision, value };
  }

  private async callRawState(
    stub: DurableObjectStubLike,
    service: "session",
    operation: string,
    value: string,
    headers: Record<string, string>
  ): Promise<Record<string, unknown>> {
    if (serializedBytes(value) > MAX_REPOSITORY_REQUEST_BYTES) throw new AgentStateConfigurationError();
    const response = await this.fetch(stub, service, operation, value, {
      "content-type": "application/json",
      ...headers,
    });
    return await this.parseJsonResponse(response);
  }

  private sessionStub(sessionId: string): DurableObjectStubLike {
    try {
      return this.sessionNamespace.get(this.sessionNamespace.idFromName(`${SESSION_SHARD_PREFIX}${sessionId}`));
    } catch {
      throw new AgentStateConfigurationError();
    }
  }

  private async call(
    stub: DurableObjectStubLike,
    service: "repository" | "session" | "index",
    operation: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const encodedBody = JSON.stringify(body);
    if (new TextEncoder().encode(encodedBody).byteLength > MAX_REPOSITORY_REQUEST_BYTES) {
      throw new AgentStateConfigurationError();
    }
    const response = await this.fetch(
      stub,
      service,
      operation,
      encodedBody,
      { "content-type": "application/json" },
      signal
    );
    return await this.parseJsonResponse(response);
  }

  private async fetch(
    stub: DurableObjectStubLike,
    service: "repository" | "session" | "index",
    operation: string,
    body: string,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    if (serializedBytes(body) > MAX_REPOSITORY_REQUEST_BYTES) throw new AgentStateConfigurationError();
    try {
      return await stub.fetch(`https://agent-session.internal/${service}/${operation}`, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AgentStateConfigurationError();
    }
  }

  private async parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new AgentStateConfigurationError();
    }
    if (response.status === 409) throw new AgentStateConflictError("Agent session state conflict");
    if (!response.ok || !isRecord(payload) || payload.ok !== true) throw new AgentStateConfigurationError();
    return payload;
  }
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespaceLike {
  return isRecord(value) && typeof value.idFromName === "function" && typeof value.get === "function";
}
