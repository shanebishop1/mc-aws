import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type { BackupTerminalReceipt, TerminalPublicationAuthorization, ToolResult } from "@/lib/agent/contracts";
import { parseBackupTerminalReceipt } from "@/lib/agent/runtime/executor-receipt";
import { parseTerminalPublicationAuthorization } from "@/lib/agent/runtime/terminal-publication";
import { agentSchemas } from "@/lib/agent/validators";
import hostOperationContract from "../../infra/src/ec2/host-operation-contract.json";
import { MAX_TOOL_RESULT_BYTES, boundToolResult } from "../../lib/agent/response-limits";

const EXECUTOR_CONTRACT = hostOperationContract.executorJournal;
const MAX_ENTRIES = EXECUTOR_CONTRACT.maxEntries;
const MAX_CANCELLATION_TOMBSTONES = EXECUTOR_CONTRACT.maxCancellationTombstones;
const DEFAULT_CANCELLATION_TOMBSTONE_TTL_MS = 35 * 60_000;
const MAX_CANCELLATION_TOMBSTONE_TTL_MS = 60 * 60_000;
const MAX_STATE_BYTES = EXECUTOR_CONTRACT.maxBytes;
const MAX_GENERATION = EXECUTOR_CONTRACT.maxGeneration;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const JOURNAL_SCHEMA_VERSION = EXECUTOR_CONTRACT.schemaVersion as 3;
const FORMAT = EXECUTOR_CONTRACT.format;
const RESERVATION_OVERHEAD_BYTES = 8 * 1024;
const REPLAY_FILTER_BYTES = EXECUTOR_CONTRACT.replayFilterBytes;
const REPLAY_FILTER_HASHES = EXECUTOR_CONTRACT.replayFilterHashes;
type JournalStatus = "reserved" | "in-progress" | "waiting" | "committed";
type MacDomain = "entry" | "tombstone" | "evidence" | "checkpoint" | "transaction" | "manifest" | "floor";
export type JournalCompactionStage =
  | "checkpoint-temp-written"
  | "checkpoint-file-synced"
  | "checkpoint-renamed"
  | "checkpoint-directory-synced"
  | "append-temp-written"
  | "append-file-synced"
  | "append-reset"
  | "append-directory-synced"
  | "manifest-temp-written"
  | "manifest-file-synced"
  | "manifest-switched"
  | "manifest-directory-synced"
  | "floor-temp-written"
  | "floor-file-synced"
  | "floor-written"
  | "floor-directory-synced"
  | "transaction-written"
  | "transaction-synced"
  | "old-append-cleaned";

const ATOMIC_PUBLICATION_STAGES: Partial<
  Record<JournalCompactionStage, readonly [JournalCompactionStage, JournalCompactionStage, JournalCompactionStage]>
> = {
  "checkpoint-renamed": ["checkpoint-temp-written", "checkpoint-file-synced", "checkpoint-directory-synced"],
  "append-reset": ["append-temp-written", "append-file-synced", "append-directory-synced"],
  "manifest-switched": ["manifest-temp-written", "manifest-file-synced", "manifest-directory-synced"],
  "floor-written": ["floor-temp-written", "floor-file-synced", "floor-directory-synced"],
};

interface PublicationAcknowledgement {
  invocationId: string;
  invocationDigest: string;
  taskId: string;
  leaseGeneration: number;
  journalSequence: number;
  resultDigest: string;
  authorization: TerminalPublicationAuthorization;
  acknowledgedAt: string;
}

interface JournalEntry {
  schemaVersion: 3;
  recordSequence: number;
  invocationId: string;
  invocationDigest: string;
  effectFingerprint: string;
  taskId?: string;
  leaseGeneration?: number;
  behaviorFingerprint?: string;
  approvalsFingerprint?: string;
  approvalsWithoutAuthorizationFingerprint?: string;
  approvalAuthorizationFingerprint?: string;
  backupAuthorizationFingerprint?: string;
  executorEpoch?: string;
  status: JournalStatus;
  updatedAt: string;
  result?: ToolResult;
  terminalReceipt?: BackupTerminalReceipt;
  publicationAcknowledgement?: PublicationAcknowledgement;
  mac: string;
}

interface CancellationTombstone {
  schemaVersion: 3;
  recordSequence: number;
  invocationId: string;
  taskId?: string;
  leaseGeneration?: number;
  requestedAt: string;
  expiresAt: string;
  mac: string;
}

interface JournalEvidence {
  schemaVersion: 3;
  recordSequence: number;
  acknowledgedCount: number;
  latestTerminalSequence: number;
  aggregateDigest: string;
  replayFilter: string;
  mac: string;
}

interface JournalState {
  schemaVersion: 3;
  generation: number;
  entries: JournalEntry[];
  cancellationTombstones: CancellationTombstone[];
  evidence: JournalEvidence[];
  mac: string;
}

interface JournalManifest {
  schemaVersion: 3;
  format: string;
  generation: number;
  checkpointGeneration: number;
  appendGeneration: number;
  generationFloor: number;
  checkpointSlot: 0 | 1;
  appendSlot: 0 | 1;
  mac: string;
}

interface JournalCheckpoint extends JournalState {
  format: string;
}

interface JournalMutation {
  operation:
    | "upsert-entry"
    | "delete-entry"
    | "upsert-tombstone"
    | "delete-tombstone"
    | "upsert-evidence"
    | "delete-evidence";
  key: string;
  value: JournalEntry | CancellationTombstone | JournalEvidence | null;
}

interface JournalTransaction {
  schemaVersion: 3;
  generation: number;
  mutations: JournalMutation[];
  mac: string;
}

interface ParsedAppendLog {
  transactions: JournalTransaction[];
  completeBytes: number;
  totalBytes: number;
}

interface JournalFloor {
  schemaVersion: 3;
  generationFloor: number;
  mac: string;
}

export type JournalBeginResult =
  | { outcome: "execute" }
  | { outcome: "replay"; result: ToolResult }
  | { outcome: "runtime-fenced"; owner: JournalInFlightIdentity }
  | { outcome: "reject" };

export type JournalReservationResult =
  | { outcome: "reserved"; journalSequence: number }
  | { outcome: "runtime-fenced"; owner: JournalInFlightIdentity }
  | { outcome: "reject" };

export type JournalReconciliationResult =
  | { outcome: "not-started" }
  | { outcome: "reserved" }
  | { outcome: "active" }
  | { outcome: "pending" }
  | { outcome: "terminal"; result: ToolResult; proofKind: "terminal" | "clean-start-no-active" }
  | { outcome: "reject" };

export interface JournalAttemptContext {
  taskId: string;
  leaseGeneration: number;
  behaviorFingerprint: string;
  approvalsFingerprint: string;
  approvalsWithoutAuthorizationFingerprint: string;
  approvalAuthorizationFingerprint?: string;
  backupAuthorizationFingerprint?: string;
  executorEpoch?: string;
}

export interface JournalTerminalAttestation {
  journalSequence: number;
  terminalReceipt?: BackupTerminalReceipt;
}

export interface JournalTerminalPublicationAcknowledgement {
  invocationId: string;
  invocationDigest: string;
  taskId: string;
  leaseGeneration: number;
  journalSequence: number;
  resultDigest: string;
  authorization: TerminalPublicationAuthorization;
}

export interface JournalCancellationResult {
  result?: ToolResult;
  journalSequence?: number;
}

function inFlightIdentity(entry: JournalEntry): JournalInFlightIdentity | undefined {
  const status =
    entry.status === "reserved"
      ? "reserved"
      : entry.status === "in-progress"
        ? "in-progress"
        : entry.status === "committed" && entry.publicationAcknowledgement === undefined
          ? entry.result?.status === "indeterminate"
            ? "indeterminate"
            : "terminal-pending"
          : undefined;
  if (!status) return undefined;
  return {
    invocationId: entry.invocationId,
    invocationDigest: entry.invocationDigest,
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.leaseGeneration ? { leaseGeneration: entry.leaseGeneration } : {}),
    status,
    updatedAt: entry.updatedAt,
  };
}

export interface JournalInFlightIdentity {
  invocationId: string;
  invocationDigest: string;
  taskId?: string;
  leaseGeneration?: number;
  status: "reserved" | "in-progress" | "indeterminate" | "terminal-pending";
  updatedAt: string;
}

function isWaitingResult(result: ToolResult): boolean {
  if (
    result.status !== "failed" ||
    !result.output ||
    typeof result.output !== "object" ||
    Array.isArray(result.output)
  ) {
    return false;
  }
  return (
    result.output.code === "approval-required" ||
    result.output.code === "backup-required" ||
    result.output.code === "invocation-authorization-required" ||
    result.output.code === "download-authorization-required"
  );
}

function waitingCode(result: ToolResult | undefined): string | undefined {
  return isWaitingResult(result as ToolResult) &&
    result?.output &&
    typeof result.output === "object" &&
    !Array.isArray(result.output)
    ? typeof result.output.code === "string"
      ? result.output.code
      : undefined
    : undefined;
}

function sameScope(
  value: { invocationId: string; taskId?: string; leaseGeneration?: number },
  invocationId: string,
  context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">
): boolean {
  if (value.invocationId !== invocationId) return false;
  if (!context) return value.taskId === undefined && value.leaseGeneration === undefined;
  return value.taskId === context.taskId && value.leaseGeneration === context.leaseGeneration;
}

function validAuthorizationTransition(entry: JournalEntry, context: JournalAttemptContext): boolean {
  if (entry.behaviorFingerprint !== context.behaviorFingerprint) return false;
  if (
    entry.approvalsFingerprint !== context.approvalsFingerprint &&
    entry.approvalsFingerprint !== context.approvalsWithoutAuthorizationFingerprint
  )
    return false;
  if (
    entry.approvalAuthorizationFingerprint &&
    entry.approvalAuthorizationFingerprint !== context.approvalAuthorizationFingerprint
  )
    return false;
  if (
    entry.backupAuthorizationFingerprint &&
    entry.backupAuthorizationFingerprint !== context.backupAuthorizationFingerprint
  )
    return false;
  const code = waitingCode(entry.result);
  if (code === "approval-required" || code === "invocation-authorization-required") {
    return (
      !entry.approvalAuthorizationFingerprint &&
      Boolean(context.approvalAuthorizationFingerprint) &&
      entry.backupAuthorizationFingerprint === context.backupAuthorizationFingerprint
    );
  }
  if (code === "backup-required") {
    return (
      !entry.backupAuthorizationFingerprint &&
      Boolean(context.backupAuthorizationFingerprint) &&
      entry.approvalAuthorizationFingerprint === context.approvalAuthorizationFingerprint
    );
  }
  return false;
}

function cancellationResult(invocationId: string, completedAt: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "cancelled",
    completedAt,
    summary: "Invocation was cancelled before execution started.",
    output: { code: "cancelled" },
    evidence: [],
    mutationCommit: { committed: false },
  };
}

function indeterminateResult(invocationId: string, completedAt = new Date().toISOString()): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status: "indeterminate",
    completedAt,
    summary: "Host effect completion is indeterminate; automatic retry is fenced.",
    output: { code: "indeterminate-effect", reconciliation: "required" },
    evidence: [],
  };
}

const canonicalize = canonicalJson;

function unsigned(value: Record<string, unknown>): Record<string, unknown> {
  const { mac: _mac, ...withoutMac } = value;
  return withoutMac;
}

function authenticatedContent(domain: MacDomain, value: Record<string, unknown>): string {
  return `${EXECUTOR_CONTRACT.macPrefix}:${domain}:v${JOURNAL_SCHEMA_VERSION}\n${canonicalize(unsigned(value))}`;
}

function createMac(key: Buffer, domain: MacDomain, value: Record<string, unknown>): string {
  return createHmac("sha256", key).update(authenticatedContent(domain, value)).digest("base64url");
}

function validMac(key: Buffer, domain: MacDomain, value: Record<string, unknown>): boolean {
  if (typeof value.mac !== "string" || !MAC.test(value.mac)) return false;
  const expected = Buffer.from(createMac(key, domain, value), "base64url");
  const actual = Buffer.from(value.mac, "base64url");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function resultDigest(result: ToolResult): string {
  return createHash("sha256").update(canonicalize(result)).digest("hex");
}

function scopeKey(value: { invocationId: string; taskId?: string; leaseGeneration?: number }): string {
  return `${value.taskId ?? "legacy"}:${value.leaseGeneration ?? 0}:${value.invocationId}`;
}

function evidenceKey(): string {
  return "acknowledged-terminal-aggregate";
}

function aggregateBinding(entry: JournalEntry): Record<string, unknown> {
  const acknowledgement = entry.publicationAcknowledgement;
  if (!acknowledgement || !entry.result) throw new Error("Executor journal acknowledgement is missing.");
  return {
    invocationId: acknowledgement.invocationId,
    invocationDigest: acknowledgement.invocationDigest,
    taskId: acknowledgement.taskId,
    leaseGeneration: acknowledgement.leaseGeneration,
    journalSequence: acknowledgement.journalSequence,
    resultDigest: acknowledgement.resultDigest,
    authorizationDigest: createHash("sha256").update(canonicalize(acknowledgement.authorization)).digest("hex"),
  };
}

function replayIdentity(
  invocationId: string,
  invocationDigest: string,
  effectFingerprint: string,
  context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">
): Record<string, unknown> {
  return {
    invocationId,
    invocationDigest,
    effectFingerprint,
    ...(context ? { taskId: context.taskId, leaseGeneration: context.leaseGeneration } : {}),
  };
}

function filterIndexes(identity: Record<string, unknown>): number[] {
  const digest = createHash("sha256").update(canonicalize(identity)).digest();
  const bitCount = REPLAY_FILTER_BYTES * 8;
  return Array.from({ length: REPLAY_FILTER_HASHES }, (_, index) => digest.readUInt32BE((index * 4) % 28) % bitCount);
}

function filterHas(filter: Uint8Array, indexes: number[]): boolean {
  return indexes.every((index) => (filter[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0);
}

function filterSet(filter: Uint8Array, indexes: number[]): void {
  for (const index of indexes) filter[Math.floor(index / 8)]! |= 1 << (index % 8);
}

function aggregateDigest(previous: string, binding: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${previous}\n${canonicalize(binding)}`)
    .digest("hex");
}

function withoutMac(value: Record<string, unknown>): Record<string, unknown> {
  return unsigned(value);
}

function validateScope(value: Record<string, unknown>, allowLegacy: boolean): void {
  const scoped = value.taskId !== undefined || value.leaseGeneration !== undefined;
  if (!scoped && !allowLegacy) throw new Error("Executor journal scope is invalid.");
  if (
    scoped &&
    (typeof value.taskId !== "string" ||
      !ID.test(value.taskId) ||
      typeof value.leaseGeneration !== "number" ||
      !Number.isSafeInteger(value.leaseGeneration) ||
      value.leaseGeneration < 1)
  ) {
    throw new Error("Executor journal scope is invalid.");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact entry validation stays centralized at the authenticated journal boundary.
function parseEntry(value: unknown, key: Buffer, generation: number): JournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal entry is invalid.");
  const entry = value as Record<string, unknown>;
  if (
    entry.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof entry.recordSequence !== "number" ||
    !Number.isSafeInteger(entry.recordSequence) ||
    entry.recordSequence < 1 ||
    entry.recordSequence > generation ||
    typeof entry.invocationId !== "string" ||
    !ID.test(entry.invocationId) ||
    typeof entry.invocationDigest !== "string" ||
    !DIGEST.test(entry.invocationDigest) ||
    typeof entry.effectFingerprint !== "string" ||
    !DIGEST.test(entry.effectFingerprint) ||
    !["reserved", "in-progress", "waiting", "committed"].includes(String(entry.status)) ||
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt)) ||
    Object.keys(entry).some((field) => !EXECUTOR_CONTRACT.entryFields.includes(field)) ||
    !validMac(key, "entry", entry)
  )
    throw new Error("Executor journal entry schema or authentication is invalid.");
  validateScope(entry, true);
  if (
    entry.taskId !== undefined &&
    (typeof entry.behaviorFingerprint !== "string" ||
      !DIGEST.test(entry.behaviorFingerprint) ||
      typeof entry.approvalsFingerprint !== "string" ||
      !DIGEST.test(entry.approvalsFingerprint) ||
      typeof entry.approvalsWithoutAuthorizationFingerprint !== "string" ||
      !DIGEST.test(entry.approvalsWithoutAuthorizationFingerprint))
  )
    throw new Error("Executor journal entry scope is invalid.");
  for (const field of [
    "behaviorFingerprint",
    "approvalsFingerprint",
    "approvalsWithoutAuthorizationFingerprint",
    "approvalAuthorizationFingerprint",
    "backupAuthorizationFingerprint",
  ]) {
    if (entry[field] !== undefined && (typeof entry[field] !== "string" || !DIGEST.test(entry[field])))
      throw new Error("Executor journal fingerprint is invalid.");
  }
  if (entry.executorEpoch !== undefined && (typeof entry.executorEpoch !== "string" || !ID.test(entry.executorEpoch)))
    throw new Error("Executor journal entry epoch is invalid.");
  if ((entry.status === "reserved" || entry.status === "in-progress") && entry.result !== undefined)
    throw new Error("Reserved or in-progress executor journal entry cannot contain a result.");
  if (entry.status !== "reserved" && entry.status !== "in-progress" && entry.result === undefined)
    throw new Error("Completed executor journal entry requires a result.");
  const parsedResult = entry.result === undefined ? undefined : agentSchemas.toolResult.parse(entry.result);
  if (parsedResult && parsedResult.invocationId !== entry.invocationId)
    throw new Error("Executor journal result belongs to another invocation.");
  const terminalReceipt =
    entry.terminalReceipt === undefined ? undefined : parseBackupTerminalReceipt(entry.terminalReceipt);
  const expectedReceiptOutcome = parsedResult?.status === "succeeded" ? "committed" : parsedResult?.status;
  if (
    terminalReceipt &&
    (!parsedResult ||
      terminalReceipt.outcome !== expectedReceiptOutcome ||
      terminalReceipt.invocationId !== entry.invocationId ||
      terminalReceipt.invocationDigest !== entry.invocationDigest ||
      terminalReceipt.journalSequence !== entry.recordSequence ||
      terminalReceipt.resultDigest !== resultDigest(parsedResult))
  ) {
    throw new Error("Executor journal terminal receipt binding is invalid.");
  }
  if (
    parsedResult &&
    ((entry.status === "waiting" && !isWaitingResult(parsedResult)) ||
      (entry.status === "committed" && isWaitingResult(parsedResult)))
  )
    throw new Error("Executor journal result status is inconsistent.");
  if (entry.publicationAcknowledgement !== undefined) {
    const acknowledgement = entry.publicationAcknowledgement;
    if (
      !acknowledgement ||
      typeof acknowledgement !== "object" ||
      Array.isArray(acknowledgement) ||
      Object.keys(acknowledgement).length !== EXECUTOR_CONTRACT.acknowledgementFields.length ||
      Object.keys(acknowledgement).some((field) => !EXECUTOR_CONTRACT.acknowledgementFields.includes(field))
    )
      throw new Error("Executor journal acknowledgement schema is invalid.");
    const ack = acknowledgement as Record<string, unknown>;
    const authorization = parseTerminalPublicationAuthorization(ack.authorization);
    if (
      typeof ack.invocationId !== "string" ||
      ack.invocationId !== entry.invocationId ||
      typeof ack.invocationDigest !== "string" ||
      ack.invocationDigest !== entry.invocationDigest ||
      typeof ack.taskId !== "string" ||
      ack.taskId !== entry.taskId ||
      typeof ack.leaseGeneration !== "number" ||
      ack.leaseGeneration !== entry.leaseGeneration ||
      ack.journalSequence !== entry.recordSequence ||
      typeof ack.resultDigest !== "string" ||
      !DIGEST.test(ack.resultDigest) ||
      typeof ack.acknowledgedAt !== "string" ||
      !Number.isFinite(Date.parse(ack.acknowledgedAt)) ||
      !parsedResult ||
      ack.resultDigest !== resultDigest(parsedResult) ||
      authorization.invocationId !== entry.invocationId ||
      authorization.invocationDigest !== entry.invocationDigest ||
      authorization.taskId !== entry.taskId ||
      authorization.leaseGeneration !== entry.leaseGeneration ||
      authorization.journalSequence !== entry.recordSequence ||
      authorization.resultDigest !== ack.resultDigest ||
      authorization.outcome !== (parsedResult.status === "succeeded" ? "committed" : parsedResult.status) ||
      !terminalReceipt ||
      authorization.runtimeId !== terminalReceipt.runtimeId ||
      authorization.sessionId !== terminalReceipt.sessionId ||
      authorization.leaseId !== terminalReceipt.leaseId ||
      authorization.terminalReceiptDigest !== createHash("sha256").update(canonicalize(terminalReceipt)).digest("hex")
    )
      throw new Error("Executor journal acknowledgement binding is invalid.");
  }
  return {
    ...entry,
    ...(parsedResult ? { result: parsedResult } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
  } as JournalEntry;
}

function parseTombstone(value: unknown, key: Buffer, generation: number): CancellationTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal cancellation tombstone is invalid.");
  const tombstone = value as Record<string, unknown>;
  if (
    tombstone.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof tombstone.recordSequence !== "number" ||
    !Number.isSafeInteger(tombstone.recordSequence) ||
    tombstone.recordSequence < 1 ||
    tombstone.recordSequence > generation ||
    typeof tombstone.invocationId !== "string" ||
    !ID.test(tombstone.invocationId) ||
    typeof tombstone.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(tombstone.requestedAt)) ||
    typeof tombstone.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(tombstone.expiresAt)) ||
    Object.keys(tombstone).some((field) => !EXECUTOR_CONTRACT.tombstoneFields.includes(field)) ||
    !validMac(key, "tombstone", tombstone)
  )
    throw new Error("Executor journal cancellation tombstone schema or authentication is invalid.");
  validateScope(tombstone, true);
  return tombstone as unknown as CancellationTombstone;
}

function parseEvidence(value: unknown, key: Buffer, generation: number): JournalEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal evidence is invalid.");
  const evidence = value as Record<string, unknown>;
  if (
    evidence.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof evidence.recordSequence !== "number" ||
    !Number.isSafeInteger(evidence.recordSequence) ||
    evidence.recordSequence < 1 ||
    evidence.recordSequence > generation ||
    typeof evidence.acknowledgedCount !== "number" ||
    !Number.isSafeInteger(evidence.acknowledgedCount) ||
    evidence.acknowledgedCount < 1 ||
    typeof evidence.latestTerminalSequence !== "number" ||
    !Number.isSafeInteger(evidence.latestTerminalSequence) ||
    evidence.latestTerminalSequence < 1 ||
    typeof evidence.aggregateDigest !== "string" ||
    !DIGEST.test(evidence.aggregateDigest) ||
    typeof evidence.replayFilter !== "string" ||
    Buffer.from(evidence.replayFilter, "base64url").byteLength !== REPLAY_FILTER_BYTES ||
    Buffer.from(evidence.replayFilter, "base64url").toString("base64url") !== evidence.replayFilter ||
    Object.keys(evidence).length !== EXECUTOR_CONTRACT.evidenceFields.length ||
    Object.keys(evidence).some((field) => !EXECUTOR_CONTRACT.evidenceFields.includes(field)) ||
    !validMac(key, "evidence", evidence)
  )
    throw new Error("Executor journal evidence schema or authentication is invalid.");
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    recordSequence: evidence.recordSequence as number,
    acknowledgedCount: evidence.acknowledgedCount as number,
    latestTerminalSequence: evidence.latestTerminalSequence as number,
    aggregateDigest: evidence.aggregateDigest as string,
    replayFilter: evidence.replayFilter as string,
    mac: evidence.mac as string,
  };
}

function parseState(value: unknown, key: Buffer): JournalState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal checkpoint is invalid.");
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    checkpoint.format !== FORMAT ||
    typeof checkpoint.generation !== "number" ||
    !Number.isSafeInteger(checkpoint.generation) ||
    checkpoint.generation < 1 ||
    !Array.isArray(checkpoint.entries) ||
    !Array.isArray(checkpoint.cancellationTombstones) ||
    !Array.isArray(checkpoint.evidence) ||
    checkpoint.evidence.length > 1 ||
    Object.keys(checkpoint).length !== EXECUTOR_CONTRACT.checkpointFields.length ||
    Object.keys(checkpoint).some((field) => !EXECUTOR_CONTRACT.checkpointFields.includes(field)) ||
    !validMac(key, "checkpoint", checkpoint)
  )
    throw new Error("Executor journal checkpoint authentication failed.");
  if (checkpoint.entries.length > MAX_ENTRIES || checkpoint.cancellationTombstones.length > MAX_CANCELLATION_TOMBSTONES)
    throw new Error("Executor journal logical capacity is invalid.");
  const generation = checkpoint.generation as number;
  const ids = new Set<string>();
  const entries = checkpoint.entries.map((value) => {
    const entry = parseEntry(value, key, generation);
    const scope = scopeKey(entry);
    if (ids.has(scope)) throw new Error("Executor journal contains a replayed entry.");
    ids.add(scope);
    return entry;
  });
  const tombstoneIds = new Set<string>();
  const cancellationTombstones = checkpoint.cancellationTombstones.map((value) => {
    const tombstone = parseTombstone(value, key, generation);
    const scope = scopeKey(tombstone);
    if (tombstoneIds.has(scope)) throw new Error("Executor journal contains a replayed cancellation tombstone.");
    tombstoneIds.add(scope);
    return tombstone;
  });
  const evidence = checkpoint.evidence.map((value) => parseEvidence(value, key, generation));
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    generation,
    entries,
    cancellationTombstones,
    evidence,
    mac: checkpoint.mac as string,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One boundary validates the complete authenticated transaction before recovery can apply any mutation.
function parseTransaction(value: unknown, key: Buffer): JournalTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal transaction frame is invalid.");
  const transaction = value as Record<string, unknown>;
  if (
    transaction.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof transaction.generation !== "number" ||
    !Number.isSafeInteger(transaction.generation) ||
    transaction.generation < 1 ||
    !Array.isArray(transaction.mutations) ||
    transaction.mutations.length < 1 ||
    Object.keys(transaction).length !== EXECUTOR_CONTRACT.appendFields.length ||
    !Object.keys(transaction).every((field) => EXECUTOR_CONTRACT.appendFields.includes(field)) ||
    !validMac(key, "transaction", transaction)
  )
    throw new Error("Executor journal transaction frame schema or authentication is invalid.");
  for (const raw of transaction.mutations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Executor journal transaction mutation is invalid.");
    const mutation = raw as Record<string, unknown>;
    if (
      Object.keys(mutation).length !== EXECUTOR_CONTRACT.mutationFields.length ||
      !Object.keys(mutation).every((field) => EXECUTOR_CONTRACT.mutationFields.includes(field)) ||
      typeof mutation.operation !== "string" ||
      !EXECUTOR_CONTRACT.mutationOperations.includes(mutation.operation as never) ||
      typeof mutation.key !== "string" ||
      !mutation.key
    )
      throw new Error("Executor journal transaction mutation schema is invalid.");
    const deletes = mutation.operation.startsWith("delete-");
    if (deletes ? mutation.value !== null : !mutation.value || typeof mutation.value !== "object")
      throw new Error("Executor journal transaction mutation value is invalid.");
  }
  return transaction as unknown as JournalTransaction;
}

function parseManifest(value: unknown, key: Buffer): JournalManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal manifest is invalid.");
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    manifest.format !== FORMAT ||
    typeof manifest.generation !== "number" ||
    !Number.isSafeInteger(manifest.generation) ||
    manifest.generation < 1 ||
    typeof manifest.checkpointGeneration !== "number" ||
    !Number.isSafeInteger(manifest.checkpointGeneration) ||
    manifest.checkpointGeneration < 1 ||
    manifest.checkpointGeneration > manifest.generation ||
    typeof manifest.appendGeneration !== "number" ||
    !Number.isSafeInteger(manifest.appendGeneration) ||
    manifest.appendGeneration !== manifest.generation ||
    typeof manifest.generationFloor !== "number" ||
    !Number.isSafeInteger(manifest.generationFloor) ||
    manifest.generationFloor < 1 ||
    manifest.generationFloor > manifest.generation ||
    manifest.generationFloor !== manifest.checkpointGeneration ||
    ![0, 1].includes(Number(manifest.checkpointSlot)) ||
    ![0, 1].includes(Number(manifest.appendSlot)) ||
    Object.keys(manifest).length !== EXECUTOR_CONTRACT.manifestFields.length ||
    Object.keys(manifest).some((field) => !EXECUTOR_CONTRACT.manifestFields.includes(field)) ||
    !validMac(key, "manifest", manifest)
  )
    throw new Error("Executor journal manifest authentication failed.");
  return manifest as unknown as JournalManifest;
}

function parseFloor(value: unknown, key: Buffer): JournalFloor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor journal generation floor is invalid.");
  const floor = value as Record<string, unknown>;
  if (
    floor.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof floor.generationFloor !== "number" ||
    !Number.isSafeInteger(floor.generationFloor) ||
    floor.generationFloor < 1 ||
    Object.keys(floor).length !== EXECUTOR_CONTRACT.floorFields.length ||
    Object.keys(floor).some((field) => !EXECUTOR_CONTRACT.floorFields.includes(field)) ||
    !validMac(key, "floor", floor)
  )
    throw new Error("Executor journal generation floor authentication failed.");
  return floor as unknown as JournalFloor;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Atomic transaction replay keeps all collection-specific key, generation, and MAC checks in one mutation boundary.
function applyMutation(state: JournalState, mutation: JournalMutation, key: Buffer, generation: number): void {
  if (mutation.operation === "upsert-entry" || mutation.operation === "delete-entry") {
    const index = state.entries.findIndex((entry) => scopeKey(entry) === mutation.key);
    if (mutation.operation === "delete-entry") {
      if (index < 0) throw new Error("Executor journal append deletion is invalid.");
      state.entries.splice(index, 1);
    } else {
      const entry = parseEntry(mutation.value, key, generation);
      if (scopeKey(entry) !== mutation.key) throw new Error("Executor journal append key is invalid.");
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
    }
  } else if (mutation.operation === "upsert-tombstone" || mutation.operation === "delete-tombstone") {
    const index = state.cancellationTombstones.findIndex((item) => scopeKey(item) === mutation.key);
    if (mutation.operation === "delete-tombstone") {
      if (index < 0) throw new Error("Executor journal append deletion is invalid.");
      state.cancellationTombstones.splice(index, 1);
    } else {
      const item = parseTombstone(mutation.value, key, generation);
      if (scopeKey(item) !== mutation.key) throw new Error("Executor journal append key is invalid.");
      if (index < 0) state.cancellationTombstones.push(item);
      else state.cancellationTombstones[index] = item;
    }
  } else {
    const index = state.evidence.findIndex(() => mutation.key === evidenceKey());
    if (mutation.operation === "delete-evidence") {
      if (index < 0) throw new Error("Executor journal append deletion is invalid.");
      state.evidence.splice(index, 1);
    } else {
      const item = parseEvidence(mutation.value, key, generation);
      if (mutation.key !== evidenceKey()) throw new Error("Executor journal append key is invalid.");
      if (index < 0) state.evidence.push(item);
      else state.evidence[index] = item;
    }
  }
}

function applyTransaction(state: JournalState, transaction: JournalTransaction, key: Buffer): JournalState {
  const next = structuredClone(state);
  for (const mutation of transaction.mutations) applyMutation(next, mutation, key, transaction.generation);
  next.generation = transaction.generation;
  return next;
}

export class ExecutorEffectJournal {
  private state: JournalState = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    generation: 0,
    entries: [],
    cancellationTombstones: [],
    evidence: [],
    mac: "",
  };
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxCancellationTombstones: number;
  private readonly cancellationTombstoneTtlMs: number;
  private readonly now: () => Date;
  private readonly authenticationKey: Buffer;
  private checkpointSlot: 0 | 1 = 0;
  private appendSlot: 0 | 1 = 0;
  private checkpointGeneration = 0;
  private appendBytes = 0;

  constructor(
    private readonly statePath: string | undefined,
    options: {
      maxEntries?: number;
      maxBytes?: number;
      maxResultBytes?: number;
      maxCancellationTombstones?: number;
      cancellationTombstoneTtlMs?: number;
      now?: () => Date;
      authenticationKey: Uint8Array;
      onCompactionStage?: (stage: JournalCompactionStage) => void;
      crashAtCompactionStage?: JournalCompactionStage;
    }
  ) {
    if (statePath !== undefined && !path.isAbsolute(statePath))
      throw new TypeError("Executor journal path must be absolute.");
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? MAX_STATE_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? MAX_TOOL_RESULT_BYTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ENTRIES)
      throw new TypeError("Executor journal entry bound is invalid.");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_STATE_BYTES)
      throw new TypeError("Executor journal byte bound is invalid.");
    if (
      !Number.isSafeInteger(this.maxResultBytes) ||
      this.maxResultBytes < 256 ||
      this.maxResultBytes > MAX_TOOL_RESULT_BYTES
    )
      throw new TypeError("Executor journal result bound is invalid.");
    this.maxCancellationTombstones = options.maxCancellationTombstones ?? MAX_CANCELLATION_TOMBSTONES;
    if (
      !Number.isSafeInteger(this.maxCancellationTombstones) ||
      this.maxCancellationTombstones < 1 ||
      this.maxCancellationTombstones > MAX_CANCELLATION_TOMBSTONES
    )
      throw new TypeError("Executor cancellation tombstone bound is invalid.");
    this.cancellationTombstoneTtlMs = options.cancellationTombstoneTtlMs ?? DEFAULT_CANCELLATION_TOMBSTONE_TTL_MS;
    if (
      !Number.isSafeInteger(this.cancellationTombstoneTtlMs) ||
      this.cancellationTombstoneTtlMs < 1 ||
      this.cancellationTombstoneTtlMs > MAX_CANCELLATION_TOMBSTONE_TTL_MS
    )
      throw new TypeError("Executor cancellation tombstone lifetime is invalid.");
    this.now = options.now ?? (() => new Date());
    if (options.authenticationKey.byteLength !== 32)
      throw new TypeError("Executor journal authentication key must contain exactly 32 bytes.");
    this.authenticationKey = Buffer.from(options.authenticationKey);
    this.compactionStage = (stage) => {
      options.onCompactionStage?.(stage);
      if (options.crashAtCompactionStage === stage) throw new Error(`injected compaction crash at ${stage}`);
    };
  }

  private readonly compactionStage: (stage: JournalCompactionStage) => void;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Restart recovery deliberately validates manifest, sidecars, floors, and append ordering together.
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.statePath) {
      try {
        await this.recoverDurableState(true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          for (const sidecar of this.sidecarPaths()) {
            try {
              await stat(sidecar);
              throw new Error("Executor journal sidecar exists without its manifest.");
            } catch (sideError) {
              if ((sideError as NodeJS.ErrnoException).code !== "ENOENT") throw sideError;
            }
          }
          this.initialized = true;
          return;
        }
        throw error;
      }
    }
    this.initialized = true;
  }

  private parseAppendLog(raw: Buffer): ParsedAppendLog {
    const transactions: JournalTransaction[] = [];
    let completeBytes = 0;
    while (completeBytes < raw.byteLength) {
      const newline = raw.indexOf(0x0a, completeBytes);
      if (newline < 0) break;
      const frame = raw.subarray(completeBytes, newline);
      transactions.push(parseTransaction(JSON.parse(frame.toString("utf8")) as unknown, this.authenticationKey));
      completeBytes = newline + 1;
    }
    return { transactions, completeBytes, totalBytes: raw.byteLength };
  }

  private async syncAppendBoundary(file: string, boundary: number): Promise<void> {
    const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== process.getuid?.() ||
        metadata.nlink !== 1 ||
        metadata.size > this.maxBytes ||
        (metadata.mode & 0o077) !== 0 ||
        boundary < 0 ||
        boundary > metadata.size
      ) {
        throw new Error("Executor journal append file is unsafe to repair.");
      }
      if (metadata.size !== boundary) await handle.truncate(boundary);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Durable recovery jointly selects authenticated checkpoint/transaction candidates and repairs their publication boundary.
  private async recoverDurableState(repairPublication: boolean): Promise<void> {
    if (!this.statePath) return;
    const manifest = parseManifest(
      JSON.parse((await this.readSafe(this.statePath, true)).toString("utf8")) as unknown,
      this.authenticationKey
    );
    const floor = parseFloor(
      JSON.parse((await this.readSafe(this.floorPath(), true)).toString("utf8")) as unknown,
      this.authenticationKey
    );
    const checkpoints: Array<{ slot: 0 | 1; state: JournalState }> = [];
    for (const [slot, file] of this.checkpointPaths().entries()) {
      try {
        const raw = JSON.parse((await this.readSafe(file, true)).toString("utf8")) as JournalCheckpoint;
        checkpoints.push({ slot: slot as 0 | 1, state: parseState(raw, this.authenticationKey) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const activeCheckpoint = checkpoints.find(({ slot }) => slot === manifest.checkpointSlot)?.state;
    if (!activeCheckpoint || activeCheckpoint.generation !== manifest.checkpointGeneration) {
      throw new Error("Executor journal manifest checkpoint is missing, stale, or below its generation floor.");
    }
    const appends: Array<ParsedAppendLog | undefined> = [];
    for (const file of this.appendPaths()) {
      try {
        appends.push(this.parseAppendLog(await this.readSafe(file, true)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") appends.push(undefined);
        else throw error;
      }
    }
    if (appends[manifest.appendSlot] === undefined) {
      throw new Error("Executor journal manifest append log is missing.");
    }
    let recovered: JournalState | undefined;
    let recoveredCheckpoint = 0;
    let recoveredCheckpointSlot: 0 | 1 = manifest.checkpointSlot;
    let recoveredAppendSlot: 0 | 1 = manifest.appendSlot;
    let recoveredPreference = -1;
    const requiredGeneration = Math.max(floor.generationFloor, manifest.generationFloor);
    for (const { slot: checkpointSlot, state: checkpoint } of checkpoints) {
      if (checkpoint.generation < floor.generationFloor) continue;
      for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
        let candidate = structuredClone(checkpoint);
        const append = appends[slot];
        if (!append) continue;
        let currentGeneration = candidate.generation;
        let valid = true;
        for (const transaction of append.transactions) {
          if (transaction.generation <= checkpoint.generation) continue;
          if (transaction.generation !== currentGeneration + 1) {
            valid = false;
            break;
          }
          try {
            candidate = applyTransaction(candidate, transaction, this.authenticationKey);
          } catch {
            valid = false;
            break;
          }
          currentGeneration = transaction.generation;
        }
        if (!valid || candidate.generation < requiredGeneration) continue;
        const preference =
          Number(checkpointSlot === manifest.checkpointSlot) * 2 + Number(slot === manifest.appendSlot);
        if (
          !recovered ||
          candidate.generation > recovered.generation ||
          (candidate.generation === recovered.generation && preference > recoveredPreference)
        ) {
          recovered = candidate;
          recoveredCheckpoint = checkpoint.generation;
          recoveredCheckpointSlot = checkpointSlot;
          recoveredAppendSlot = slot as 0 | 1;
          recoveredPreference = preference;
        }
      }
    }
    if (!recovered || recovered.generation < requiredGeneration) {
      throw new Error("Executor journal recovery found no generation at or above its authenticated floor.");
    }
    const selectedAppend = appends[recoveredAppendSlot];
    if (!selectedAppend) throw new Error("Executor journal recovered append log is missing.");
    const appendBoundary = recoveredCheckpoint === recovered.generation ? 0 : selectedAppend.completeBytes;
    if (repairPublication) {
      await this.syncAppendBoundary(this.appendPaths()[recoveredAppendSlot], appendBoundary);
      const repairedManifest = this.makeManifest(
        recovered.generation,
        recoveredCheckpoint,
        recovered.generation,
        recoveredCheckpointSlot,
        recoveredAppendSlot
      );
      if (canonicalize(manifest) !== canonicalize(repairedManifest)) {
        await this.atomicWrite(this.statePath, Buffer.from(`${canonicalize(repairedManifest)}\n`));
      }
      const repairedFloor = this.makeFloor(recoveredCheckpoint);
      if (canonicalize(floor) !== canonicalize(repairedFloor)) {
        await this.atomicWrite(this.floorPath(), Buffer.from(`${canonicalize(repairedFloor)}\n`));
      }
    }
    this.state = recovered;
    this.checkpointGeneration = recoveredCheckpoint;
    this.checkpointSlot = recoveredCheckpointSlot;
    this.appendSlot = recoveredAppendSlot;
    this.appendBytes = appendBoundary;
  }

  private async reconcileAfterFailure(before: JournalState): Promise<void> {
    if (!this.statePath) {
      this.state = before;
      return;
    }
    await this.recoverDurableState(true);
  }

  currentSequence(): Promise<number> {
    return this.exclusive(async () => this.state.generation);
  }

  inFlight(): Promise<JournalInFlightIdentity | null> {
    return this.exclusive(async () => {
      const identities = this.state.entries.flatMap((entry) => {
        const identity = inFlightIdentity(entry);
        return identity ? [identity] : [];
      });
      if (identities.length > 1)
        throw new Error("Executor journal contains multiple in-flight effects; execution is disabled.");
      return identities[0] ? structuredClone(identities[0]) : null;
    });
  }

  terminalAttestation(
    invocationId: string,
    context: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">,
    result: ToolResult
  ): Promise<JournalTerminalAttestation> {
    return this.exclusive(async () => {
      const entry = this.state.entries.find((candidate) => sameScope(candidate, invocationId, context));
      if (
        !entry ||
        entry.status !== "committed" ||
        !entry.result ||
        entry.result.invocationId !== result.invocationId ||
        canonicalize(entry.result) !== canonicalize(result)
      )
        throw new Error("Executor journal terminal attestation was not found.");
      return {
        journalSequence: entry.recordSequence,
        ...(entry.terminalReceipt ? { terminalReceipt: structuredClone(entry.terminalReceipt) } : {}),
      };
    });
  }

  recordTerminalReceipt(
    invocationId: string,
    context: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">,
    result: ToolResult,
    receipt: BackupTerminalReceipt
  ): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.state.entries.find((candidate) => sameScope(candidate, invocationId, context));
      const parsedReceipt = parseBackupTerminalReceipt(receipt);
      if (
        !entry ||
        entry.status !== "committed" ||
        !entry.result ||
        canonicalize(entry.result) !== canonicalize(result) ||
        parsedReceipt.invocationId !== invocationId ||
        parsedReceipt.outcome !== (result.status === "succeeded" ? "committed" : result.status) ||
        parsedReceipt.invocationDigest !== entry.invocationDigest ||
        parsedReceipt.journalSequence !== entry.recordSequence ||
        parsedReceipt.resultDigest !== resultDigest(result)
      ) {
        throw new Error("Executor terminal receipt binding was rejected.");
      }
      if (entry.terminalReceipt) {
        if (canonicalize(entry.terminalReceipt) !== canonicalize(parsedReceipt)) {
          throw new Error("Executor terminal receipt changed its durable identity.");
        }
        return;
      }
      const before = structuredClone(this.state);
      try {
        entry.terminalReceipt = structuredClone(parsedReceipt);
        await this.persist(before);
      } catch (error) {
        await this.reconcileAfterFailure(before);
        throw error;
      }
    });
  }

  acknowledgeTerminal(acknowledgement: JournalTerminalPublicationAcknowledgement): Promise<void> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact publication authority, receipt, result, and journal bindings are validated in one fail-closed transaction.
    return this.exclusive(async () => {
      if (
        !ID.test(acknowledgement.invocationId) ||
        !DIGEST.test(acknowledgement.invocationDigest) ||
        !ID.test(acknowledgement.taskId) ||
        !Number.isSafeInteger(acknowledgement.leaseGeneration) ||
        acknowledgement.leaseGeneration < 1 ||
        !Number.isSafeInteger(acknowledgement.journalSequence) ||
        acknowledgement.journalSequence < 1 ||
        !DIGEST.test(acknowledgement.resultDigest)
      )
        throw new TypeError("Executor terminal acknowledgement is invalid.");
      const authorization = parseTerminalPublicationAuthorization(acknowledgement.authorization);
      const entry = this.state.entries.find(
        (candidate) =>
          candidate.recordSequence === acknowledgement.journalSequence &&
          sameScope(candidate, acknowledgement.invocationId, acknowledgement)
      );
      if (
        !entry ||
        entry.invocationDigest !== acknowledgement.invocationDigest ||
        entry.status !== "committed" ||
        !entry.result ||
        entry.result.status === "indeterminate" ||
        isWaitingResult(entry.result) ||
        resultDigest(entry.result) !== acknowledgement.resultDigest ||
        authorization.invocationId !== acknowledgement.invocationId ||
        authorization.invocationDigest !== acknowledgement.invocationDigest ||
        authorization.taskId !== acknowledgement.taskId ||
        authorization.leaseGeneration !== acknowledgement.leaseGeneration ||
        authorization.journalSequence !== acknowledgement.journalSequence ||
        authorization.resultDigest !== acknowledgement.resultDigest ||
        authorization.outcome !== (entry.result.status === "succeeded" ? "committed" : entry.result.status) ||
        !entry.terminalReceipt ||
        authorization.runtimeId !== entry.terminalReceipt.runtimeId ||
        authorization.sessionId !== entry.terminalReceipt.sessionId ||
        authorization.leaseId !== entry.terminalReceipt.leaseId ||
        authorization.terminalReceiptDigest !==
          createHash("sha256").update(canonicalize(entry.terminalReceipt)).digest("hex")
      )
        throw new Error("Executor terminal acknowledgement binding was rejected.");
      if (entry.publicationAcknowledgement) {
        if (
          entry.publicationAcknowledgement.invocationId !== acknowledgement.invocationId ||
          entry.publicationAcknowledgement.invocationDigest !== acknowledgement.invocationDigest ||
          entry.publicationAcknowledgement.taskId !== acknowledgement.taskId ||
          entry.publicationAcknowledgement.leaseGeneration !== acknowledgement.leaseGeneration ||
          entry.publicationAcknowledgement.journalSequence !== acknowledgement.journalSequence ||
          entry.publicationAcknowledgement.resultDigest !== acknowledgement.resultDigest ||
          canonicalize(entry.publicationAcknowledgement.authorization) !== canonicalize(authorization)
        )
          throw new Error("Executor terminal acknowledgement binding was rejected.");
        return;
      }
      const before = structuredClone(this.state);
      try {
        entry.publicationAcknowledgement = {
          invocationId: acknowledgement.invocationId,
          invocationDigest: acknowledgement.invocationDigest,
          taskId: acknowledgement.taskId,
          leaseGeneration: acknowledgement.leaseGeneration,
          journalSequence: acknowledgement.journalSequence,
          resultDigest: acknowledgement.resultDigest,
          authorization: structuredClone(authorization),
          acknowledgedAt: this.now().toISOString(),
        };
        await this.persist(before);
      } catch (error) {
        await this.reconcileAfterFailure(before);
        throw error;
      }
    });
  }

  reserve(
    invocationId: string,
    invocationDigest: string,
    effectFingerprint: string,
    context: JournalAttemptContext
  ): Promise<JournalReservationResult> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reservation mirrors begin's exact replay, cancellation, authorization, capacity, and runtime-owner fencing without entering the effect.
    return this.exclusive(async () => {
      const beforeAll = structuredClone(this.state);
      try {
        this.pruneCancellationTombstones(this.now().getTime());
        await this.compactAcknowledged(true);
        const prior = this.state.entries.find((entry) => sameScope(entry, invocationId, context));
        const evidence = this.state.evidence.some((item) =>
          filterHas(
            Buffer.from(item.replayFilter, "base64url"),
            filterIndexes(replayIdentity(invocationId, invocationDigest, effectFingerprint, context))
          )
        );
        const foreignOwner = this.state.entries.find(
          (entry) => !sameScope(entry, invocationId, context) && inFlightIdentity(entry) !== undefined
        );
        if (foreignOwner) {
          return { outcome: "runtime-fenced", owner: inFlightIdentity(foreignOwner) as JournalInFlightIdentity };
        }
        if (evidence) return { outcome: "reject" };
        let beforePersist = structuredClone(this.state);
        if (prior) {
          if (prior.invocationDigest !== invocationDigest) return { outcome: "reject" };
          if (prior.status === "reserved" || prior.status === "in-progress" || prior.status === "committed") {
            return prior.effectFingerprint === effectFingerprint
              ? { outcome: "reserved", journalSequence: this.state.generation }
              : { outcome: "reject" };
          }
          const tombstone = this.state.cancellationTombstones.find((item) => sameScope(item, invocationId, context));
          if (tombstone) {
            const replay = cancellationResult(invocationId, tombstone.requestedAt);
            prior.status = "committed";
            prior.result = replay;
            prior.updatedAt = tombstone.requestedAt;
            this.removeCancellationTombstone(invocationId, context);
          } else if (prior.effectFingerprint === effectFingerprint && prior.result) {
            return { outcome: "reserved", journalSequence: this.state.generation };
          } else {
            if (!validAuthorizationTransition(prior, context)) return { outcome: "reject" };
            prior.effectFingerprint = effectFingerprint;
            prior.behaviorFingerprint = context.behaviorFingerprint;
            prior.approvalsFingerprint = context.approvalsFingerprint;
            prior.approvalsWithoutAuthorizationFingerprint = context.approvalsWithoutAuthorizationFingerprint;
            prior.approvalAuthorizationFingerprint = context.approvalAuthorizationFingerprint;
            prior.backupAuthorizationFingerprint = context.backupAuthorizationFingerprint;
            prior.executorEpoch = context.executorEpoch;
            prior.status = "reserved";
            prior.result = undefined;
            prior.updatedAt = this.now().toISOString();
          }
        } else {
          const tombstone = this.state.cancellationTombstones.find((item) => sameScope(item, invocationId, context));
          if (tombstone) {
            const replay = cancellationResult(invocationId, tombstone.requestedAt);
            this.state.entries.push({
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              recordSequence: 0,
              invocationId,
              invocationDigest,
              effectFingerprint,
              ...context,
              status: "committed",
              updatedAt: tombstone.requestedAt,
              result: replay,
              mac: "",
            });
            this.removeCancellationTombstone(invocationId, context);
          } else {
            if (this.state.entries.length >= this.maxEntries || !this.canReserveNewEffect(invocationId, context)) {
              await this.compactAcknowledged(false);
              await this.ensureCheckpointForCapacity();
            }
            if (this.state.entries.length >= this.maxEntries) {
              throw new Error("Executor journal capacity is exhausted; effect was not reserved.");
            }
            beforePersist = structuredClone(this.state);
            this.state.entries.push({
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              recordSequence: 0,
              invocationId,
              invocationDigest,
              effectFingerprint,
              ...context,
              status: "reserved",
              updatedAt: this.now().toISOString(),
              mac: "",
            });
            if (!this.canReserveNewEffect(invocationId, context)) {
              throw new Error("Executor journal capacity is exhausted; effect was not reserved.");
            }
          }
        }
        await this.persist(beforePersist);
        return { outcome: "reserved", journalSequence: this.state.generation };
      } catch (error) {
        await this.reconcileAfterFailure(beforeAll);
        throw error;
      }
    });
  }

  begin(
    invocationId: string,
    invocationDigest: string,
    effectFingerprint: string,
    context?: JournalAttemptContext
  ): Promise<JournalBeginResult> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Begin keeps fencing, replay, cancellation, capacity, and durable transition guards in one boundary.
    return this.exclusive(async () => {
      const beforeAll = structuredClone(this.state);
      try {
        this.pruneCancellationTombstones(this.now().getTime());
        await this.compactAcknowledged(true);
        const prior =
          this.state.entries.find((entry) => sameScope(entry, invocationId, context)) ??
          (context
            ? this.state.entries.find(
                (entry) =>
                  entry.invocationId === invocationId &&
                  entry.taskId === undefined &&
                  entry.leaseGeneration === undefined
              )
            : undefined);
        const evidence = this.state.evidence.some((item) =>
          filterHas(
            Buffer.from(item.replayFilter, "base64url"),
            filterIndexes(replayIdentity(invocationId, invocationDigest, effectFingerprint, context))
          )
        );
        const foreignOwner = this.state.entries.find(
          (entry) => !sameScope(entry, invocationId, context) && inFlightIdentity(entry) !== undefined
        );
        if (foreignOwner)
          return { outcome: "runtime-fenced", owner: inFlightIdentity(foreignOwner) as JournalInFlightIdentity };
        if (evidence) return { outcome: "reject" };
        let beforePersist = structuredClone(this.state);
        if (prior) {
          if (prior.invocationDigest !== invocationDigest || (context && !sameScope(prior, invocationId, context)))
            return { outcome: "reject" };
          if (prior.status === "reserved") {
            if (prior.effectFingerprint !== effectFingerprint) return { outcome: "reject" };
            prior.status = "in-progress";
            prior.updatedAt = this.now().toISOString();
          } else if (prior.status === "in-progress") {
            if (prior.effectFingerprint !== effectFingerprint) return { outcome: "reject" };
            return { outcome: "replay", result: indeterminateResult(invocationId, this.now().toISOString()) };
          } else if (prior.status === "committed" && prior.effectFingerprint === effectFingerprint && prior.result)
            return { outcome: "replay", result: structuredClone(prior.result) };
          else {
            if (prior.status !== "waiting") return { outcome: "reject" };
            const tombstone = this.state.cancellationTombstones.find((item) => sameScope(item, invocationId, context));
            if (tombstone) {
              const replay = cancellationResult(invocationId, tombstone.requestedAt);
              const before = structuredClone(this.state);
              prior.effectFingerprint = effectFingerprint;
              prior.status = "committed";
              prior.result = replay;
              prior.updatedAt = tombstone.requestedAt;
              this.removeCancellationTombstone(invocationId, context);
              await this.persist(before);
              return { outcome: "replay", result: structuredClone(replay) };
            }
            if (prior.effectFingerprint === effectFingerprint && prior.result)
              return { outcome: "replay", result: structuredClone(prior.result) };
            if (!context || !validAuthorizationTransition(prior, context)) return { outcome: "reject" };
            if (this.state.cancellationTombstones.length >= this.maxCancellationTombstones)
              return { outcome: "reject" };
            prior.effectFingerprint = effectFingerprint;
            prior.behaviorFingerprint = context.behaviorFingerprint;
            prior.approvalsFingerprint = context.approvalsFingerprint;
            prior.approvalsWithoutAuthorizationFingerprint = context.approvalsWithoutAuthorizationFingerprint;
            prior.approvalAuthorizationFingerprint = context.approvalAuthorizationFingerprint;
            prior.backupAuthorizationFingerprint = context.backupAuthorizationFingerprint;
            prior.status = "in-progress";
            prior.result = undefined;
            prior.updatedAt = this.now().toISOString();
          }
        } else {
          const tombstone = this.state.cancellationTombstones.find((item) => sameScope(item, invocationId, context));
          if (tombstone) {
            const replay = cancellationResult(invocationId, tombstone.requestedAt);
            const before = structuredClone(this.state);
            this.state.entries.push({
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              recordSequence: 0,
              invocationId,
              invocationDigest,
              effectFingerprint,
              ...(context ?? {}),
              status: "committed",
              updatedAt: tombstone.requestedAt,
              result: replay,
              mac: "",
            });
            this.removeCancellationTombstone(invocationId, context);
            await this.persist(before);
            return { outcome: "replay", result: structuredClone(replay) };
          }
          if (this.state.cancellationTombstones.length >= this.maxCancellationTombstones) return { outcome: "reject" };
          if (this.state.entries.length >= this.maxEntries || !this.canReserveNewEffect(invocationId, context)) {
            await this.compactAcknowledged(false);
            await this.ensureCheckpointForCapacity();
          }
          if (this.state.entries.length >= this.maxEntries)
            throw new Error("Executor journal capacity is exhausted; effect was not started.");
          beforePersist = structuredClone(this.state);
          const entry: JournalEntry = {
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            recordSequence: 0,
            invocationId,
            invocationDigest,
            effectFingerprint,
            ...(context ?? {}),
            status: "in-progress",
            updatedAt: this.now().toISOString(),
            mac: "",
          };
          this.state.entries.push(entry);
          if (!this.canReserveNewEffect(invocationId, context))
            throw new Error("Executor journal capacity is exhausted; effect was not started.");
        }
        await this.persist(beforePersist);
        return { outcome: "execute" };
      } catch (error) {
        await this.reconcileAfterFailure(beforeAll);
        throw error;
      }
    });
  }

  reconcile(
    invocationId: string,
    invocationDigest: string,
    effectFingerprint: string,
    context: JournalAttemptContext,
    active: boolean
  ): Promise<JournalReconciliationResult> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reconciliation intentionally keeps terminal, active, and authorization outcomes ordered in one boundary.
    return this.exclusive(async () => {
      const entry = this.state.entries.find((candidate) => sameScope(candidate, invocationId, context));
      if (!entry) return active ? { outcome: "active" } : { outcome: "not-started" };
      if (entry.invocationDigest !== invocationDigest) return { outcome: "reject" };
      if (entry.effectFingerprint !== effectFingerprint) {
        if (entry.status !== "waiting" || !validAuthorizationTransition(entry, context)) return { outcome: "reject" };
        return active ? { outcome: "active" } : { outcome: "not-started" };
      }
      if (entry.status === "reserved") return active ? { outcome: "active" } : { outcome: "reserved" };
      if (entry.status !== "in-progress" && entry.result?.status !== "indeterminate")
        return entry.result
          ? {
              outcome: "terminal",
              result: structuredClone(entry.result),
              proofKind:
                entry.result.output &&
                typeof entry.result.output === "object" &&
                !Array.isArray(entry.result.output) &&
                entry.result.output.code === "reconciliation-clean-start"
                  ? "clean-start-no-active"
                  : "terminal",
            }
          : { outcome: "reject" };
      if (active) return { outcome: "active" };
      if (context.executorEpoch === undefined || entry.executorEpoch === context.executorEpoch)
        return { outcome: "pending" };
      const result: ToolResult = {
        schemaVersion: 1,
        invocationId,
        status: "failed",
        completedAt: this.now().toISOString(),
        summary: "A root-authorized clean executor epoch established that no prior host effect remains active.",
        output: {
          code: "reconciliation-clean-start",
          reconciliation: "completed",
          noActiveEffect: true,
          priorExecutorEpoch: entry.executorEpoch ?? "legacy-pre-epoch",
          ...(context.executorEpoch ? { executorEpoch: context.executorEpoch } : {}),
        },
        evidence: [],
        mutationCommit: { committed: false },
      };
      const before = structuredClone(this.state);
      try {
        entry.status = "committed";
        entry.result = result;
        // The prior receipt authenticated the indeterminate result. It cannot
        // authenticate the replacement clean-start result, which is persisted
        // at a new journal sequence and receives a new signed receipt.
        entry.terminalReceipt = undefined;
        entry.publicationAcknowledgement = undefined;
        entry.updatedAt = result.completedAt;
        await this.persist(before);
        return { outcome: "terminal", result: structuredClone(result), proofKind: "clean-start-no-active" };
      } catch (error) {
        await this.reconcileAfterFailure(before);
        throw error;
      }
    });
  }

  cancel(
    invocationId: string,
    requestedAt = new Date().toISOString(),
    context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">,
    identity?: { invocationDigest: string; effectFingerprint: string }
  ): Promise<JournalCancellationResult> {
    if (!ID.test(invocationId) || !Number.isFinite(Date.parse(requestedAt)))
      return Promise.reject(new TypeError("Executor cancellation tombstone is invalid."));
    if (identity && (!DIGEST.test(identity.invocationDigest) || !DIGEST.test(identity.effectFingerprint))) {
      return Promise.reject(new TypeError("Executor cancellation identity is invalid."));
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation keeps exact identity, durable tombstone, capacity, and rollback handling in one journal transaction.
    return this.exclusive(async () => {
      const entry = this.state.entries.find((candidate) => sameScope(candidate, invocationId, context));
      if (
        entry &&
        identity &&
        (entry.invocationDigest !== identity.invocationDigest || entry.effectFingerprint !== identity.effectFingerprint)
      ) {
        throw new Error("Executor cancellation identity does not match the durable invocation.");
      }
      if (entry?.status === "committed") {
        return entry.result ? { result: structuredClone(entry.result), journalSequence: entry.recordSequence } : {};
      }
      const before = structuredClone(this.state);
      try {
        this.pruneCancellationTombstones(Date.parse(requestedAt));
        if (entry?.status === "reserved") {
          const result = cancellationResult(invocationId, requestedAt);
          entry.status = "committed";
          entry.result = result;
          entry.updatedAt = requestedAt;
          await this.persist(before);
          return { result: structuredClone(result), journalSequence: entry.recordSequence };
        }
        if (!entry && identity) {
          if (this.state.entries.length >= this.maxEntries || !this.canReserveNewEffect(invocationId, context)) {
            await this.compactAcknowledged(false);
            await this.ensureCheckpointForCapacity();
          }
          if (this.state.entries.length >= this.maxEntries || !this.canReserveNewEffect(invocationId, context)) {
            throw new Error("Executor journal capacity is exhausted; cancellation was not recorded.");
          }
          const result = cancellationResult(invocationId, requestedAt);
          this.state.entries.push({
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            recordSequence: 0,
            invocationId,
            invocationDigest: identity.invocationDigest,
            effectFingerprint: identity.effectFingerprint,
            ...(context ?? {}),
            status: "committed",
            updatedAt: requestedAt,
            result,
            mac: "",
          });
          await this.persist(before);
          return { result: structuredClone(result), journalSequence: this.state.entries.at(-1)?.recordSequence };
        }
        if (this.state.cancellationTombstones.some((item) => sameScope(item, invocationId, context))) {
          return {};
        }
        if (this.state.cancellationTombstones.length >= this.maxCancellationTombstones)
          throw new Error("Executor cancellation tombstone capacity is temporarily exhausted.");
        this.state.cancellationTombstones.push({
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          recordSequence: 0,
          invocationId,
          ...(context ? { taskId: context.taskId, leaseGeneration: context.leaseGeneration } : {}),
          requestedAt,
          expiresAt: new Date(Date.parse(requestedAt) + this.cancellationTombstoneTtlMs).toISOString(),
          mac: "",
        });
        await this.persist(before);
        return {};
      } catch (error) {
        await this.reconcileAfterFailure(before);
        throw error;
      }
    });
  }

  commit(
    invocationId: string,
    invocationDigest: string,
    effectFingerprint: string,
    result: ToolResult,
    context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">
  ): Promise<void> {
    return this.exclusive(async () => {
      const before = structuredClone(this.state);
      try {
        const entry = this.state.entries.find((candidate) => sameScope(candidate, invocationId, context));
        if (
          !entry ||
          entry.status !== "in-progress" ||
          entry.invocationDigest !== invocationDigest ||
          entry.effectFingerprint !== effectFingerprint ||
          result.invocationId !== invocationId
        )
          throw new Error("Executor journal commit was fenced.");
        entry.status = isWaitingResult(result) ? "waiting" : "committed";
        const bounded = await boundToolResult(result);
        if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > this.maxResultBytes)
          throw new Error("Executor journal result exceeds its reserved test budget.");
        entry.result = structuredClone(agentSchemas.toolResult.parse(bounded));
        entry.updatedAt = this.now().toISOString();
        if (result.status === "cancelled") this.removeCancellationTombstone(invocationId, context);
        await this.persist(before);
      } catch (error) {
        await this.reconcileAfterFailure(before);
        throw error;
      }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  private sidecarPaths(): string[] {
    return [...this.checkpointPaths(), ...this.appendPaths(), this.floorPath()];
  }
  private checkpointPaths(): [string, string] {
    return EXECUTOR_CONTRACT.checkpointSuffixes.map((suffix: string) => `${this.statePath as string}${suffix}`) as [
      string,
      string,
    ];
  }
  private appendPaths(): [string, string] {
    return EXECUTOR_CONTRACT.appendSuffixes.map((suffix: string) => `${this.statePath as string}${suffix}`) as [
      string,
      string,
    ];
  }
  private floorPath(): string {
    return `${this.statePath as string}${EXECUTOR_CONTRACT.floorSuffix}`;
  }

  private async readSafe(file: string, allowEmpty: boolean): Promise<Buffer> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== process.getuid?.() ||
        metadata.size > this.maxBytes ||
        (metadata.mode & 0o077) !== 0 ||
        (!allowEmpty && metadata.size < 1)
      )
        throw new Error("Executor journal storage file is unsafe.");
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(file: string, bytes: Buffer, stage?: JournalCompactionStage): Promise<void> {
    if (bytes.byteLength > this.maxBytes)
      throw new Error("Executor journal byte capacity is exhausted; execution is disabled.");
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const publicationStages = stage ? ATOMIC_PUBLICATION_STAGES[stage] : undefined;
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(bytes);
      this.compactionStageIf(publicationStages?.[0]);
      await handle.sync();
      this.compactionStageIf(publicationStages?.[1]);
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      this.compactionStageIf(stage);
      const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
        this.compactionStageIf(publicationStages?.[2]);
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private compactionStageIf(stage: JournalCompactionStage | undefined): void {
    if (stage) this.compactionStage(stage);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Persistence keeps capacity, authenticated append, checkpoint rotation, and floor publication ordered.
  private async persist(before: JournalState, forceCheckpoint = false): Promise<void> {
    if (
      this.state.entries.length > this.maxEntries ||
      this.state.cancellationTombstones.length > this.maxCancellationTombstones
    )
      throw new Error("Executor journal logical capacity is exhausted; execution is disabled.");
    if (this.state.generation >= MAX_GENERATION)
      throw new Error("Executor journal generation is exhausted; execution is disabled.");
    this.state.generation += 1;
    const generation = this.state.generation;
    const mutations = this.diff(before, generation);
    const checkpointBytes = Buffer.from(
      `${canonicalize({ ...this.state, format: FORMAT, mac: createMac(this.authenticationKey, "checkpoint", { ...this.state, format: FORMAT, mac: "" }) })}\n`
    );
    if (checkpointBytes.byteLength > this.maxBytes)
      throw new Error("Executor journal byte capacity is exhausted; execution is disabled.");
    if (!this.statePath) return;
    const transaction = mutations.length > 0 ? this.makeTransaction(generation, mutations) : undefined;
    const appendBytes = Buffer.from(transaction ? `${canonicalize(transaction)}\n` : "");
    const checkpointNeeded =
      forceCheckpoint ||
      this.checkpointGeneration === 0 ||
      this.appendBytes + appendBytes.byteLength + MAX_TOOL_RESULT_BYTES > this.maxBytes;
    if (checkpointNeeded) {
      const nextCheckpointSlot = this.checkpointGeneration === 0 ? 0 : ((1 - this.checkpointSlot) as 0 | 1);
      const nextAppendSlot = this.checkpointGeneration === 0 ? 0 : ((1 - this.appendSlot) as 0 | 1);
      await this.atomicWrite(this.checkpointPaths()[nextCheckpointSlot], checkpointBytes, "checkpoint-renamed");
      await this.atomicWrite(this.appendPaths()[nextAppendSlot], Buffer.alloc(0), "append-reset");
      const manifest = this.makeManifest(generation, generation, generation, nextCheckpointSlot, nextAppendSlot);
      await this.atomicWrite(this.statePath, Buffer.from(`${canonicalize(manifest)}\n`), "manifest-switched");
      const floor = this.makeFloor(generation);
      await this.atomicWrite(this.floorPath(), Buffer.from(`${canonicalize(floor)}\n`), "floor-written");
      const oldAppend = this.appendPaths()[this.appendSlot];
      if (oldAppend !== this.appendPaths()[nextAppendSlot]) {
        await this.atomicWrite(oldAppend, Buffer.alloc(0));
        this.compactionStageIf("old-append-cleaned");
      }
      this.checkpointSlot = nextCheckpointSlot;
      this.appendSlot = nextAppendSlot;
      this.checkpointGeneration = generation;
      this.appendBytes = 0;
      return;
    }
    if (appendBytes.byteLength === 0) throw new Error("Executor journal mutation produced no append record.");
    const appendPath = this.appendPaths()[this.appendSlot];
    const appendHandle = await open(
      appendPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const metadata = await appendHandle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > this.maxBytes
      )
        throw new Error("Executor journal append file is unsafe.");
      await appendHandle.writeFile(appendBytes);
      this.compactionStageIf("transaction-written");
      await appendHandle.sync();
      this.compactionStageIf("transaction-synced");
    } finally {
      await appendHandle.close();
    }
    this.appendBytes += appendBytes.byteLength;
    const manifest = this.makeManifest(
      generation,
      this.checkpointGeneration,
      generation,
      this.checkpointSlot,
      this.appendSlot
    );
    await this.atomicWrite(this.statePath, Buffer.from(`${canonicalize(manifest)}\n`), "manifest-switched");
    await this.atomicWrite(
      this.floorPath(),
      Buffer.from(`${canonicalize(this.makeFloor(this.checkpointGeneration))}\n`),
      "floor-written"
    );
  }

  private makeManifest(
    generation: number,
    checkpointGeneration: number,
    appendGeneration: number,
    checkpointSlot: 0 | 1,
    appendSlot: 0 | 1
  ): JournalManifest {
    const value = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      format: FORMAT,
      generation,
      checkpointGeneration,
      appendGeneration,
      generationFloor: checkpointGeneration,
      checkpointSlot,
      appendSlot,
      mac: "",
    } as JournalManifest;
    value.mac = createMac(this.authenticationKey, "manifest", value as unknown as Record<string, unknown>);
    return value;
  }

  private makeFloor(generationFloor: number): JournalFloor {
    const value = { schemaVersion: JOURNAL_SCHEMA_VERSION, generationFloor, mac: "" } as JournalFloor;
    value.mac = createMac(this.authenticationKey, "floor", value as unknown as Record<string, unknown>);
    return value;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Diff generation keeps exact collection keys and authenticated mutation ordering together.
  private diff(before: JournalState, generation: number): JournalMutation[] {
    const mutations: JournalMutation[] = [];
    const collections = [
      ["entry", before.entries, this.state.entries] as const,
      ["tombstone", before.cancellationTombstones, this.state.cancellationTombstones] as const,
      ["evidence", before.evidence, this.state.evidence] as const,
    ];
    for (const [kind, prior, current] of collections) {
      const keyFor = (item: JournalEntry | CancellationTombstone | JournalEvidence): string =>
        kind === "evidence" ? evidenceKey() : scopeKey(item as JournalEntry | CancellationTombstone);
      const priorMap = new Map(prior.map((item) => [keyFor(item), item]));
      const currentMap = new Map(current.map((item) => [keyFor(item), item]));
      for (const [key] of priorMap)
        if (!currentMap.has(key))
          mutations.push({ operation: `delete-${kind}` as JournalMutation["operation"], key, value: null });
      for (const [key, item] of currentMap) {
        const old = priorMap.get(key);
        if (
          !old ||
          canonicalize(withoutMac(old as unknown as Record<string, unknown>)) !==
            canonicalize(withoutMac(item as unknown as Record<string, unknown>))
        ) {
          const mutable = item as JournalEntry & CancellationTombstone & JournalEvidence;
          const metadataOnly =
            kind === "entry" &&
            old &&
            canonicalize(
              withoutMac({
                ...(old as unknown as Record<string, unknown>),
                publicationAcknowledgement: undefined,
                terminalReceipt: undefined,
              })
            ) ===
              canonicalize(
                withoutMac({
                  ...(item as unknown as Record<string, unknown>),
                  publicationAcknowledgement: undefined,
                  terminalReceipt: undefined,
                })
              );
          mutable.recordSequence = metadataOnly ? old.recordSequence : generation;
          mutable.mac = createMac(
            this.authenticationKey,
            kind === "entry" ? "entry" : kind === "tombstone" ? "tombstone" : "evidence",
            mutable as unknown as Record<string, unknown>
          );
          mutations.push({
            operation: `upsert-${kind}` as JournalMutation["operation"],
            key,
            value: mutable,
          });
        }
      }
    }
    return mutations;
  }

  private makeTransaction(generation: number, mutations: JournalMutation[]): JournalTransaction {
    const transaction = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      generation,
      mutations,
      mac: "",
    } as JournalTransaction;
    transaction.mac = createMac(
      this.authenticationKey,
      "transaction",
      transaction as unknown as Record<string, unknown>
    );
    return transaction;
  }

  private canReserveNewEffect(
    invocationId: string,
    context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">
  ): boolean {
    if (this.state.entries.length > this.maxEntries) return false;
    const candidate: JournalEntry = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      recordSequence: Math.max(1, this.state.generation + 1),
      invocationId,
      invocationDigest: "0".repeat(64),
      effectFingerprint: "0".repeat(64),
      ...(context ?? {}),
      status: "in-progress",
      updatedAt: this.now().toISOString(),
      mac: "0".repeat(43),
    };
    const estimated =
      Buffer.byteLength(canonicalize({ ...this.state, entries: [...this.state.entries, candidate] })) +
      this.maxResultBytes +
      RESERVATION_OVERHEAD_BYTES;
    return (
      estimated <= this.maxBytes && this.appendBytes + this.maxResultBytes + RESERVATION_OVERHEAD_BYTES <= this.maxBytes
    );
  }

  private async ensureCheckpointForCapacity(): Promise<void> {
    if (!this.statePath || this.appendBytes === 0) return;
    const before = structuredClone(this.state);
    await this.persist(before, true);
  }

  private async compactAcknowledged(retainLatest: boolean): Promise<void> {
    const acknowledged = this.state.entries.filter(
      (entry) =>
        entry.status === "committed" &&
        entry.result &&
        entry.result.status !== "indeterminate" &&
        !isWaitingResult(entry.result) &&
        entry.publicationAcknowledgement
    );
    const keep = retainLatest
      ? acknowledged.toSorted((left, right) => right.recordSequence - left.recordSequence)[0]
      : undefined;
    const removable = acknowledged.filter((entry) => entry !== keep);
    if (removable.length === 0) return;
    const before = structuredClone(this.state);
    let aggregate = this.state.evidence[0];
    if (!aggregate) {
      aggregate = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        recordSequence: 0,
        acknowledgedCount: 0,
        latestTerminalSequence: 0,
        aggregateDigest: "0".repeat(64),
        replayFilter: Buffer.alloc(REPLAY_FILTER_BYTES).toString("base64url"),
        mac: "",
      };
      this.state.evidence.push(aggregate);
    }
    const filter = Buffer.from(aggregate.replayFilter, "base64url");
    for (const entry of removable) {
      if (!entry.result || !entry.publicationAcknowledgement) continue;
      const binding = aggregateBinding(entry);
      const indexes = filterIndexes(
        replayIdentity(
          entry.invocationId,
          entry.invocationDigest,
          entry.effectFingerprint,
          entry.taskId !== undefined && entry.leaseGeneration !== undefined
            ? { taskId: entry.taskId, leaseGeneration: entry.leaseGeneration }
            : undefined
        )
      );
      filterSet(filter, indexes);
      aggregate.acknowledgedCount += 1;
      aggregate.latestTerminalSequence = Math.max(aggregate.latestTerminalSequence, entry.recordSequence);
      aggregate.aggregateDigest = aggregateDigest(aggregate.aggregateDigest, binding);
      this.state.entries = this.state.entries.filter((candidate) => candidate !== entry);
    }
    aggregate.replayFilter = filter.toString("base64url");
    // Evidence and deletions must become visible as one atomic checkpoint swap.
    // They are never emitted as independently recoverable append mutations.
    await this.persist(before, true);
  }

  private pruneCancellationTombstones(now: number): void {
    this.state.cancellationTombstones = this.state.cancellationTombstones.filter(
      (tombstone) => Date.parse(tombstone.expiresAt) > now
    );
  }
  private removeCancellationTombstone(
    invocationId: string,
    context?: Pick<JournalAttemptContext, "taskId" | "leaseGeneration">
  ): void {
    this.state.cancellationTombstones = this.state.cancellationTombstones.filter(
      (tombstone) => !sameScope(tombstone, invocationId, context)
    );
  }
}
