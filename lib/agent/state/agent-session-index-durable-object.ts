import type { AgentSessionStatus } from "@/lib/agent/state/contracts";
import {
  type AgentRuntimeWorkClaim,
  type AgentSessionSummaryRecord,
  type AgentWorkCandidateQuery,
  type AgentWorkIndexRecord,
  orderedWorkCandidateSessionIds,
} from "@/lib/agent/state/repository-metadata";
import { agentSchemas } from "@/lib/agent/validators";

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

interface StoredSummary {
  indexSequence: number;
  summary: AgentSessionSummaryRecord;
}

interface IndexMeta {
  page: number;
  entries: number;
  sequence: number;
}

interface IndexEntry {
  sessionId: string;
  sequence: number;
}

interface MigrationState {
  schemaVersion: 1;
  sourceEpoch: number;
  scanEpoch: number;
  cursor: number;
  complete: boolean;
  nextRescanAt: string;
}

interface WorkQueueMeta {
  headPage: number;
  tailPage: number;
  tailEntries: number;
}

interface WorkQueueEntry {
  sessionId: string;
  revision: number;
}

interface WorkQuarantine {
  schemaVersion: 1;
  revision: number;
  reason: "runtime-response-over-budget" | "migration-merge-over-budget";
}

const SUMMARY_PREFIX = "agent-summary-v2:";
const GLOBAL_INDEX = "global";
const INDEX_META_PREFIX = "agent-summary-index-meta-v2:";
const INDEX_PAGE_PREFIX = "agent-summary-index-page-v2:";
const WORK_QUEUE_META_KEY = "agent-work-queue-meta-v3";
const WORK_QUEUE_PAGE_PREFIX = "agent-work-queue-page-v3:";
const CLAIM_PREFIX = "agent-work-claim-v3:";
const RUNTIME_CLAIM_PREFIX = "agent-runtime-claim-v4:";
const CLAIM_TOKEN_PREFIX = "agent-runtime-claim-token-v4:";
const SESSION_CLAIM_PREFIX = "agent-runtime-session-claim-v4:";
const WORK_QUARANTINE_PREFIX = "agent-work-quarantine-v3:";
const MIGRATION_STATE_KEY = "agent-singleton-migration-v2";
const INDEX_PAGE_ENTRIES = 100;
const MAX_LIST_LIMIT = 100;
const MAX_LIST_SCAN = 2_000;
const WORK_QUEUE_PAGE_ENTRIES = 100;
const MAX_WORK_QUEUE_PAGES_PER_POLL = 4;
const MAX_WORK_CANDIDATES = 4;
const MAX_INTERNAL_BODY_BYTES = 256_000;
const MIGRATION_RESCAN_MS = 5 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_STATUSES = new Set<AgentSessionStatus>([
  "pending",
  "running",
  "waiting-approval",
  "idle",
  "cancelled",
  "failed",
  "completed",
]);
const ARCHIVED_SESSION_STATUSES = new Set<AgentSessionStatus>(["idle", "cancelled", "failed", "completed"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function validInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) throw new Error("invalid_input");
  const body = JSON.parse(text) as unknown;
  if (!isRecord(body)) throw new Error("invalid_input");
  return body;
}

function validSummary(value: unknown): value is AgentSessionSummaryRecord {
  if (!isRecord(value)) return false;
  const work = value.work;
  return (
    exactKeys(value, [
      "schemaVersion",
      "sessionId",
      "actorId",
      "revision",
      "status",
      "createdAt",
      "updatedAt",
      "policySnapshot",
      "taskCount",
      "pendingApprovalCount",
      "lastEventSequence",
      "providerProfileId",
      "model",
      "archived",
      "work",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.sessionId === "string" &&
    ID_PATTERN.test(value.sessionId) &&
    typeof value.actorId === "string" &&
    value.actorId.length > 0 &&
    value.actorId.length <= 320 &&
    validInteger(value.revision, 1) &&
    typeof value.status === "string" &&
    SESSION_STATUSES.has(value.status as AgentSessionStatus) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    agentSchemas.permissionPolicy.safeParse(value.policySnapshot).success &&
    validInteger(value.taskCount, 0) &&
    validInteger(value.pendingApprovalCount, 0) &&
    validInteger(value.lastEventSequence, 0) &&
    typeof value.providerProfileId === "string" &&
    typeof value.model === "string" &&
    typeof value.archived === "boolean" &&
    value.archived === ARCHIVED_SESSION_STATUSES.has(value.status as AgentSessionStatus) &&
    (work === null || validWork(work, value.sessionId))
  );
}

function validWork(value: unknown, sessionId: unknown): boolean {
  if (!isRecord(value)) return false;
  const lease = value.lease;
  return (
    Object.keys(value).every((key) =>
      ["schemaVersion", "sessionId", "taskId", "orderAt", "availableAt", "lease"].includes(key)
    ) &&
    value.schemaVersion === 1 &&
    value.sessionId === sessionId &&
    typeof value.taskId === "string" &&
    typeof value.orderAt === "string" &&
    Number.isFinite(Date.parse(value.orderAt)) &&
    typeof value.availableAt === "string" &&
    Number.isFinite(Date.parse(value.availableAt)) &&
    (lease === undefined ||
      (isRecord(lease) &&
        exactKeys(lease, ["schemaVersion", "runtimeId", "claimId", "expiresAt"]) &&
        lease.schemaVersion === 1 &&
        typeof lease.runtimeId === "string" &&
        typeof lease.claimId === "string" &&
        typeof lease.expiresAt === "string" &&
        Number.isFinite(Date.parse(lease.expiresAt))))
  );
}

/** Bounded derived coordinator: compact summaries plus only pending/running work candidates. */
export class AgentSessionIndexDurableObject {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);
    try {
      const body = await readBody(request);
      switch (new URL(request.url).pathname) {
        case "/index/upsert":
          return await this.upsert(body);
        case "/index/list":
          return await this.list(body);
        case "/index/work-candidates":
          return await this.workCandidates(body);
        case "/index/work-claim":
          return await this.workClaim(body);
        case "/index/work-claim-validate":
          return await this.validateWorkClaim(body);
        case "/index/work-claim-release":
          return await this.releaseWorkClaim(body);
        case "/index/work-claim-renew":
          return await this.renewWorkClaim(body);
        case "/index/work-quarantine":
          return await this.workQuarantine(body);
        case "/index/migration-state":
          return await this.migrationState(body);
        case "/index/migration-advance":
          return await this.advanceMigration(body);
        default:
          return json({ ok: false, code: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "invalid_input")) {
        return json({ ok: false, code: "invalid_input" }, 400);
      }
      return json({ ok: false, code: "unavailable" }, 503);
    }
  }

  private async upsert(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["summary"]) || !validSummary(body.summary)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const summary = body.summary;
    let applied = false;
    await this.state.storage.transaction(async (transaction) => {
      const key = `${SUMMARY_PREFIX}${summary.sessionId}`;
      const current = await transaction.get<StoredSummary>(key);
      if (current && current.summary.revision > summary.revision) return;
      if (current?.summary.revision === summary.revision) {
        if (JSON.stringify(current.summary) !== JSON.stringify(summary)) throw new Error("invalid_input");
        return;
      }

      const globalMeta = await this.appendIndex(transaction, GLOBAL_INDEX, summary.sessionId);
      await this.appendIndex(transaction, this.actorIndex(summary.actorId), summary.sessionId, globalMeta.sequence);
      await transaction.put(key, { indexSequence: globalMeta.sequence, summary } satisfies StoredSummary);
      const quarantineKey = `${WORK_QUARANTINE_PREFIX}${summary.sessionId}`;
      const quarantine = await transaction.get<WorkQuarantine>(quarantineKey);
      if (
        quarantine &&
        summary.revision > quarantine.revision &&
        quarantine.reason === "runtime-response-over-budget"
      ) {
        await transaction.delete(quarantineKey);
      }
      await this.updateClaimPointer(transaction, current?.summary.work ?? null, summary.work);
      await this.reconcileRuntimeClaim(transaction, summary);
      if (summary.work) await this.appendWorkQueue(transaction, summary.sessionId, summary.revision);
      applied = true;
    });
    return json({ ok: true, applied });
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Bounded newest-first page traversal rejects stale index entries inline.
  private async list(body: Record<string, unknown>): Promise<Response> {
    if (
      !Object.keys(body).every((key) => ["limit", "actorId"].includes(key)) ||
      !validInteger(body.limit, 1, MAX_LIST_LIMIT) ||
      (body.actorId !== undefined && (typeof body.actorId !== "string" || body.actorId.length > 320))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const indexName = typeof body.actorId === "string" ? this.actorIndex(body.actorId) : GLOBAL_INDEX;
    const meta = await this.state.storage.get<IndexMeta>(`${INDEX_META_PREFIX}${indexName}`);
    if (!meta) return json({ ok: true, summaries: [] });
    const summaries: AgentSessionSummaryRecord[] = [];
    let scanned = 0;
    for (let page = meta.page; page >= 0 && summaries.length < body.limit && scanned < MAX_LIST_SCAN; page--) {
      const entries = (await this.state.storage.get<IndexEntry[]>(`${INDEX_PAGE_PREFIX}${indexName}:${page}`)) ?? [];
      for (let position = entries.length - 1; position >= 0 && summaries.length < body.limit; position--) {
        if (++scanned > MAX_LIST_SCAN) break;
        const entry = entries[position];
        const stored = await this.state.storage.get<StoredSummary>(`${SUMMARY_PREFIX}${entry.sessionId}`);
        if (stored?.indexSequence !== entry.sequence) continue;
        if (body.actorId !== undefined && stored.summary.actorId !== body.actorId) continue;
        summaries.push(stored.summary);
      }
    }
    return json({ ok: true, summaries });
  }

  private async workCandidates(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["runtimeId", "claimId", "now", "limit"]) ||
      typeof body.runtimeId !== "string" ||
      typeof body.claimId !== "string" ||
      typeof body.now !== "string" ||
      !Number.isFinite(Date.parse(body.now)) ||
      !validInteger(body.limit, 1, MAX_WORK_CANDIDATES)
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const query = body as unknown as AgentWorkCandidateQuery;
    const workIndex: AgentWorkIndexRecord[] = [];
    const exactClaimSessionId = await this.state.storage.get<string>(this.claimKey(query.runtimeId, query.claimId));
    if (exactClaimSessionId) {
      const stored = await this.state.storage.get<StoredSummary>(`${SUMMARY_PREFIX}${exactClaimSessionId}`);
      const quarantine = await this.state.storage.get<WorkQuarantine>(
        `${WORK_QUARANTINE_PREFIX}${exactClaimSessionId}`
      );
      if (
        stored?.summary.work?.lease?.runtimeId === query.runtimeId &&
        stored.summary.work.lease.claimId === query.claimId &&
        !this.quarantines(quarantine, stored.summary.revision)
      ) {
        workIndex.push(stored.summary.work);
      }
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One bounded transaction cleans stale queue revisions while advancing contiguous empty pages.
    await this.state.storage.transaction(async (transaction) => {
      const meta = await transaction.get<WorkQueueMeta>(WORK_QUEUE_META_KEY);
      if (!meta) return;
      let headPage = meta.headPage;
      const seen = new Set(workIndex.map((work) => work.sessionId));
      for (
        let page = meta.headPage;
        page <= meta.tailPage && page < meta.headPage + MAX_WORK_QUEUE_PAGES_PER_POLL;
        page++
      ) {
        const key = `${WORK_QUEUE_PAGE_PREFIX}${page}`;
        const entries = (await transaction.get<WorkQueueEntry[]>(key)) ?? [];
        const retained: WorkQueueEntry[] = [];
        for (const entry of entries) {
          const stored = await transaction.get<StoredSummary>(`${SUMMARY_PREFIX}${entry.sessionId}`);
          const quarantine = await transaction.get<WorkQuarantine>(`${WORK_QUARANTINE_PREFIX}${entry.sessionId}`);
          if (
            stored?.summary.revision !== entry.revision ||
            !stored.summary.work ||
            stored.summary.work.sessionId !== entry.sessionId ||
            this.quarantines(quarantine, entry.revision)
          ) {
            continue;
          }
          retained.push(entry);
          if (!seen.has(entry.sessionId)) {
            seen.add(entry.sessionId);
            workIndex.push(stored.summary.work);
          }
        }
        if (retained.length === 0) {
          await transaction.delete(key);
          if (page === headPage) headPage++;
        } else if (retained.length !== entries.length) {
          await transaction.put(key, retained);
        }
      }
      if (headPage !== meta.headPage) {
        await transaction.put(
          WORK_QUEUE_META_KEY,
          headPage > meta.tailPage ? { headPage, tailPage: headPage, tailEntries: 0 } : { ...meta, headPage }
        );
      }
    });
    return json({ ok: true, sessionIds: orderedWorkCandidateSessionIds(workIndex, query) });
  }

  private async workQuarantine(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["sessionId", "revision", "reason"]) ||
      typeof body.sessionId !== "string" ||
      !ID_PATTERN.test(body.sessionId) ||
      !validInteger(body.revision, 1) ||
      !["runtime-response-over-budget", "migration-merge-over-budget"].includes(String(body.reason))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<StoredSummary>(`${SUMMARY_PREFIX}${body.sessionId}`);
      if (!stored || stored.summary.revision !== body.revision) return;
      await transaction.put(`${WORK_QUARANTINE_PREFIX}${body.sessionId}`, {
        schemaVersion: 1,
        revision: body.revision as number,
        reason: body.reason as WorkQuarantine["reason"],
      } satisfies WorkQuarantine);
    });
    return json({ ok: true });
  }

  private async workClaim(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["runtimeId", "claimId", "now", "limit", "claimDurationMs"]) ||
      typeof body.runtimeId !== "string" ||
      !ID_PATTERN.test(body.runtimeId) ||
      typeof body.claimId !== "string" ||
      !ID_PATTERN.test(body.claimId) ||
      typeof body.now !== "string" ||
      !Number.isFinite(Date.parse(body.now)) ||
      !validInteger(body.limit, 1, MAX_WORK_CANDIDATES) ||
      !validInteger(body.claimDurationMs, 5_000, 120_000)
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const query = body as unknown as AgentWorkCandidateQuery & { claimDurationMs: number };
    const runtimeKey = `${RUNTIME_CLAIM_PREFIX}${encodeURIComponent(query.runtimeId)}`;
    let claim: AgentRuntimeWorkClaim | null = null;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Selection and one-runtime grant publication must share one coordinator transaction.
    await this.state.storage.transaction(async (transaction) => {
      const existingToken = await transaction.get<string>(runtimeKey);
      const existing = existingToken
        ? await transaction.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${existingToken}`)
        : undefined;
      if (existing && Date.parse(existing.expiresAt) > Date.parse(query.now)) {
        if (existing.claimId === query.claimId) claim = existing;
        return;
      }
      if (existingToken) await this.deleteRuntimeClaim(transaction, existingToken, existing);

      const workIndex: AgentWorkIndexRecord[] = [];
      const exactSessionId = await transaction.get<string>(this.claimKey(query.runtimeId, query.claimId));
      if (exactSessionId) {
        const stored = await transaction.get<StoredSummary>(`${SUMMARY_PREFIX}${exactSessionId}`);
        const quarantine = await transaction.get<WorkQuarantine>(`${WORK_QUARANTINE_PREFIX}${exactSessionId}`);
        if (
          stored?.summary.work?.lease?.runtimeId === query.runtimeId &&
          stored.summary.work.lease.claimId === query.claimId &&
          !this.quarantines(quarantine, stored.summary.revision)
        ) {
          workIndex.push(stored.summary.work);
        }
      }
      const meta = await transaction.get<WorkQueueMeta>(WORK_QUEUE_META_KEY);
      if (meta) {
        const seen = new Set(workIndex.map((work) => work.sessionId));
        for (
          let page = meta.headPage;
          page <= meta.tailPage && page < meta.headPage + MAX_WORK_QUEUE_PAGES_PER_POLL;
          page++
        ) {
          const entries = (await transaction.get<WorkQueueEntry[]>(`${WORK_QUEUE_PAGE_PREFIX}${page}`)) ?? [];
          for (const entry of entries) {
            const stored = await transaction.get<StoredSummary>(`${SUMMARY_PREFIX}${entry.sessionId}`);
            const quarantine = await transaction.get<WorkQuarantine>(`${WORK_QUARANTINE_PREFIX}${entry.sessionId}`);
            if (
              stored?.summary.revision === entry.revision &&
              stored.summary.work?.sessionId === entry.sessionId &&
              !this.quarantines(quarantine, entry.revision) &&
              !seen.has(entry.sessionId)
            ) {
              seen.add(entry.sessionId);
              workIndex.push(stored.summary.work);
            }
          }
        }
      }
      const selectedSessionId = orderedWorkCandidateSessionIds(workIndex, { ...query, limit: 1 })[0];
      if (!selectedSessionId) return;
      const stored = await transaction.get<StoredSummary>(`${SUMMARY_PREFIX}${selectedSessionId}`);
      if (!stored?.summary.work) return;
      const token = `claim-token-${crypto.randomUUID()}`;
      claim = {
        schemaVersion: 1,
        token,
        runtimeId: query.runtimeId,
        claimId: query.claimId,
        sessionId: selectedSessionId,
        taskId: stored.summary.work.taskId,
        revision: stored.summary.revision,
        issuedAt: query.now,
        expiresAt: new Date(Date.parse(query.now) + query.claimDurationMs).toISOString(),
      };
      await transaction.put(`${CLAIM_TOKEN_PREFIX}${token}`, claim);
      await transaction.put(runtimeKey, token);
      await transaction.put(`${SESSION_CLAIM_PREFIX}${encodeURIComponent(selectedSessionId)}`, token);
    });
    return json({ ok: true, claim });
  }

  private async validateWorkClaim(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["schemaVersion", "token", "runtimeId", "claimId", "sessionId", "taskId", "revision", "at"]) ||
      body.schemaVersion !== 1 ||
      ![body.token, body.runtimeId, body.claimId, body.sessionId, body.taskId].every(
        (value) => typeof value === "string" && ID_PATTERN.test(value)
      ) ||
      !validInteger(body.revision, 1) ||
      typeof body.at !== "string" ||
      !Number.isFinite(Date.parse(body.at))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const claim = await this.state.storage.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${body.token}`);
    const valid =
      claim !== undefined &&
      claim.runtimeId === body.runtimeId &&
      claim.claimId === body.claimId &&
      claim.sessionId === body.sessionId &&
      claim.taskId === body.taskId &&
      claim.revision === body.revision &&
      Date.parse(claim.expiresAt) > Date.parse(body.at as string) &&
      (await this.state.storage.get<string>(`${RUNTIME_CLAIM_PREFIX}${encodeURIComponent(claim.runtimeId)}`)) ===
        claim.token;
    return json({ ok: true, valid });
  }

  private async releaseWorkClaim(body: Record<string, unknown>): Promise<Response> {
    if (!exactKeys(body, ["token"]) || typeof body.token !== "string" || !ID_PATTERN.test(body.token)) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    await this.state.storage.transaction(async (transaction) => {
      const claim = await transaction.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${body.token}`);
      if (claim) await this.deleteRuntimeClaim(transaction, body.token as string, claim);
    });
    return json({ ok: true });
  }

  private async renewWorkClaim(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["runtimeId", "claimId", "sessionId", "taskId", "now", "expiresAt"]) ||
      ![body.runtimeId, body.claimId, body.sessionId, body.taskId].every(
        (value) => typeof value === "string" && ID_PATTERN.test(value)
      ) ||
      typeof body.now !== "string" ||
      !Number.isFinite(Date.parse(body.now)) ||
      typeof body.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(body.expiresAt)) ||
      Date.parse(body.expiresAt) <= Date.parse(body.now)
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    let renewed = false;
    await this.state.storage.transaction(async (transaction) => {
      const runtimeKey = `${RUNTIME_CLAIM_PREFIX}${encodeURIComponent(body.runtimeId as string)}`;
      const token = await transaction.get<string>(runtimeKey);
      const claim = token ? await transaction.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${token}`) : undefined;
      if (
        !claim ||
        claim.claimId !== body.claimId ||
        claim.sessionId !== body.sessionId ||
        claim.taskId !== body.taskId ||
        Date.parse(claim.expiresAt) <= Date.parse(body.now as string)
      ) {
        return;
      }
      await transaction.put(`${CLAIM_TOKEN_PREFIX}${token}`, { ...claim, expiresAt: body.expiresAt as string });
      renewed = true;
    });
    return json({ ok: true, renewed });
  }

  private async migrationState(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["sourceEpoch", "now"]) ||
      !validInteger(body.sourceEpoch, 1) ||
      typeof body.now !== "string" ||
      !Number.isFinite(Date.parse(body.now))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    const sourceEpoch = body.sourceEpoch as number;
    let migration!: MigrationState;
    await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<MigrationState>(MIGRATION_STATE_KEY);
      if (!this.validMigrationState(stored) || stored.sourceEpoch < sourceEpoch) {
        migration = this.freshMigration(sourceEpoch, 1, body.now as string);
        await transaction.put(MIGRATION_STATE_KEY, migration);
        return;
      }
      if (stored.sourceEpoch > sourceEpoch) {
        migration = stored;
        return;
      }
      if (stored.complete && Date.parse(body.now as string) >= Date.parse(stored.nextRescanAt)) {
        migration = this.freshMigration(stored.sourceEpoch, stored.scanEpoch + 1, body.now as string);
        await transaction.put(MIGRATION_STATE_KEY, migration);
        return;
      }
      migration = stored;
    });
    return json({ ok: true, migration });
  }

  private async advanceMigration(body: Record<string, unknown>): Promise<Response> {
    if (
      !exactKeys(body, ["sourceEpoch", "scanEpoch", "expectedCursor", "cursor", "complete", "now"]) ||
      !validInteger(body.sourceEpoch, 1) ||
      !validInteger(body.scanEpoch, 1) ||
      !validInteger(body.expectedCursor, 0) ||
      !validInteger(body.cursor, body.expectedCursor) ||
      typeof body.complete !== "boolean" ||
      typeof body.now !== "string" ||
      !Number.isFinite(Date.parse(body.now))
    ) {
      return json({ ok: false, code: "invalid_input" }, 400);
    }
    await this.state.storage.transaction(async (transaction) => {
      const current = await transaction.get<MigrationState>(MIGRATION_STATE_KEY);
      if (
        !this.validMigrationState(current) ||
        current.complete ||
        current.sourceEpoch !== body.sourceEpoch ||
        current.scanEpoch !== body.scanEpoch ||
        current.cursor !== body.expectedCursor
      ) {
        return;
      }
      await transaction.put(MIGRATION_STATE_KEY, {
        ...current,
        cursor: body.cursor as number,
        complete: body.complete as boolean,
        nextRescanAt: new Date(Date.parse(body.now as string) + MIGRATION_RESCAN_MS).toISOString(),
      });
    });
    return json({ ok: true });
  }

  private async appendIndex(
    transaction: DurableObjectTransactionLike,
    indexName: string,
    sessionId: string,
    fixedSequence?: number
  ): Promise<IndexMeta> {
    const metaKey = `${INDEX_META_PREFIX}${indexName}`;
    const previous = (await transaction.get<IndexMeta>(metaKey)) ?? { page: 0, entries: 0, sequence: 0 };
    const page = previous.entries >= INDEX_PAGE_ENTRIES ? previous.page + 1 : previous.page;
    const entries = previous.entries >= INDEX_PAGE_ENTRIES ? 0 : previous.entries;
    const sequence = fixedSequence ?? previous.sequence + 1;
    const pageKey = `${INDEX_PAGE_PREFIX}${indexName}:${page}`;
    const currentPage = entries === 0 ? [] : ((await transaction.get<IndexEntry[]>(pageKey)) ?? []);
    await transaction.put(pageKey, [...currentPage, { sessionId, sequence }]);
    const next = { page, entries: entries + 1, sequence: fixedSequence ?? sequence };
    await transaction.put(metaKey, next);
    return next;
  }

  private actorIndex(actorId: string): string {
    return `actor:${encodeURIComponent(actorId)}`;
  }

  private async appendWorkQueue(
    transaction: DurableObjectTransactionLike,
    sessionId: string,
    revision: number
  ): Promise<void> {
    const previous = (await transaction.get<WorkQueueMeta>(WORK_QUEUE_META_KEY)) ?? {
      headPage: 0,
      tailPage: 0,
      tailEntries: 0,
    };
    const drained = previous.headPage > previous.tailPage;
    const tailPage = drained
      ? previous.headPage
      : previous.tailEntries >= WORK_QUEUE_PAGE_ENTRIES
        ? previous.tailPage + 1
        : previous.tailPage;
    const entries = drained || previous.tailEntries >= WORK_QUEUE_PAGE_ENTRIES ? 0 : previous.tailEntries;
    const key = `${WORK_QUEUE_PAGE_PREFIX}${tailPage}`;
    const page = entries === 0 ? [] : ((await transaction.get<WorkQueueEntry[]>(key)) ?? []);
    await transaction.put(key, [...page, { sessionId, revision }]);
    await transaction.put(WORK_QUEUE_META_KEY, {
      headPage: drained ? tailPage : previous.headPage,
      tailPage,
      tailEntries: entries + 1,
    });
  }

  private async updateClaimPointer(
    transaction: DurableObjectTransactionLike,
    previous: AgentWorkIndexRecord | null,
    next: AgentWorkIndexRecord | null
  ): Promise<void> {
    if (previous?.lease) {
      const oldKey = this.claimKey(previous.lease.runtimeId, previous.lease.claimId);
      if (!next?.lease || oldKey !== this.claimKey(next.lease.runtimeId, next.lease.claimId)) {
        await transaction.delete(oldKey);
      }
    }
    if (next?.lease) await transaction.put(this.claimKey(next.lease.runtimeId, next.lease.claimId), next.sessionId);
  }

  private async reconcileRuntimeClaim(
    transaction: DurableObjectTransactionLike,
    summary: AgentSessionSummaryRecord
  ): Promise<void> {
    const sessionKey = `${SESSION_CLAIM_PREFIX}${encodeURIComponent(summary.sessionId)}`;
    const token = await transaction.get<string>(sessionKey);
    if (!token) return;
    const claim = await transaction.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${token}`);
    if (!claim) {
      await transaction.delete(sessionKey);
      return;
    }
    const lease = summary.work?.lease;
    if (
      summary.work?.taskId === claim.taskId &&
      lease?.runtimeId === claim.runtimeId &&
      lease.claimId === claim.claimId
    ) {
      if (Date.parse(lease.expiresAt) > Date.parse(claim.expiresAt)) {
        await transaction.put(`${CLAIM_TOKEN_PREFIX}${token}`, { ...claim, expiresAt: lease.expiresAt });
      }
      return;
    }
    if (summary.revision > claim.revision) await this.deleteRuntimeClaim(transaction, token, claim);
  }

  private async deleteRuntimeClaim(
    transaction: DurableObjectTransactionLike,
    token: string,
    claim?: AgentRuntimeWorkClaim
  ): Promise<void> {
    const stored = claim ?? (await transaction.get<AgentRuntimeWorkClaim>(`${CLAIM_TOKEN_PREFIX}${token}`));
    await transaction.delete(`${CLAIM_TOKEN_PREFIX}${token}`);
    if (!stored) return;
    const runtimeKey = `${RUNTIME_CLAIM_PREFIX}${encodeURIComponent(stored.runtimeId)}`;
    if ((await transaction.get<string>(runtimeKey)) === token) await transaction.delete(runtimeKey);
    const sessionKey = `${SESSION_CLAIM_PREFIX}${encodeURIComponent(stored.sessionId)}`;
    if ((await transaction.get<string>(sessionKey)) === token) await transaction.delete(sessionKey);
  }

  private claimKey(runtimeId: string, claimId: string): string {
    return `${CLAIM_PREFIX}${encodeURIComponent(runtimeId)}:${encodeURIComponent(claimId)}`;
  }

  private quarantines(quarantine: WorkQuarantine | undefined, revision: number): boolean {
    return (
      quarantine !== undefined &&
      (quarantine.reason === "migration-merge-over-budget" || quarantine.revision === revision)
    );
  }

  private validMigrationState(value: MigrationState | undefined): value is MigrationState {
    return (
      value?.schemaVersion === 1 &&
      validInteger(value.sourceEpoch, 1) &&
      validInteger(value.scanEpoch, 1) &&
      validInteger(value.cursor, 0) &&
      typeof value.complete === "boolean" &&
      typeof value.nextRescanAt === "string" &&
      Number.isFinite(Date.parse(value.nextRescanAt))
    );
  }

  private freshMigration(sourceEpoch: number, scanEpoch: number, now: string): MigrationState {
    return {
      schemaVersion: 1,
      sourceEpoch,
      scanEpoch,
      cursor: 0,
      complete: false,
      nextRescanAt: new Date(Date.parse(now) + MIGRATION_RESCAN_MS).toISOString(),
    };
  }
}
