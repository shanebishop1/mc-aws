// @ts-check

import { GetItemCommand, UpdateItemCommand, dynamodb } from "./clients.js";

/** @typedef {"start"|"stop"|"backup"|"restore"|"hibernate"|"resume"|"allowlist"} OperationType */
/** @typedef {"accepted"|"running"|"completed"|"failed"} OperationStatus */
/** @typedef {"api"|"lambda"} TransitionSource */
/** @typedef {"validating"|"dispatching"|"dispatched"|"executing"|"terminal"} OperationPhase */
/** @typedef {{status: OperationStatus, at: string, source: TransitionSource, error?: string, code?: string}} OperationTransition */
/**
 * @typedef {Object} OperationState
 * @property {1} schemaVersion
 * @property {string} id
 * @property {OperationType} type
 * @property {string} route
 * @property {OperationStatus} status
 * @property {OperationPhase} phase
 * @property {string} requestedAt
 * @property {string} updatedAt
 * @property {string} [requestedBy]
 * @property {string} [lockId]
 * @property {number} [fencingToken]
 * @property {number} [lockLeaseGeneration]
 * @property {string} [lockLeaseExpiresAt]
 * @property {string} [requestIdempotencyKey]
 * @property {string} [dispatchOwnerId]
 * @property {"awaiting-executor"|"active"|"needed"|"resolved"} [agentEffectReconciliationStatus]
 * @property {string} [agentEffectReconciliationUpdatedAt]
 * @property {string} [agentEffectSafetyExpiresAt]
 * @property {Record<string, unknown>} [agentFenceAuthorization]
 * @property {Record<string, unknown>} [agentTerminalReceipt]
 * @property {string} [instanceId]
 * @property {string} [executionToken]
 * @property {number} [executionAttempt]
 * @property {string} [executionClaimedAt]
 * @property {string} [executionLeaseExpiresAt]
 * @property {string} [remoteCommandId]
 * @property {string} [remoteCommandIdentity]
 * @property {string} [remoteCommandInstanceId]
 * @property {string} [remoteCommandStep]
 * @property {boolean} [remoteCommandFinal]
 * @property {string} [remoteCommandStatus]
 * @property {string} [managedVolumeId]
 * @property {string} [managedVolumeDevice]
 * @property {string} [hibernateOriginalInstanceId]
 * @property {string} [hibernateSourceImageId]
 * @property {string} [hibernateReconstructionSnapshotId]
 * @property {string} [hibernatePhase]
 * @property {string} [hibernateBackupId]
 * @property {string} [hibernateBackupDigest]
 * @property {number} [hibernateBackupSize]
 * @property {number} [hibernateBackupGeneration]
 * @property {string} [hibernateBackupCreatedAt]
 * @property {string} [hibernateBackupOperationKey]
 * @property {string} [hibernateBackupInstanceId]
 * @property {string} [hibernateBackupServerId]
 * @property {string} [hibernateBackupArchiveName]
 * @property {string} [hibernateBackupAuthenticationKeyId]
 * @property {Record<string, unknown>} [hibernateQuiescenceEvidence]
 * @property {string} [resumeVolumeClientToken]
 * @property {string} [resumeVolumeId]
 * @property {string} [resumeSnapshotId]
 * @property {string} [sideEffectCompletedAt]
 * @property {string} [sideEffectKey]
 * @property {{mode: "fresh"|"latest"|"named", backupArchiveName?: string|null}} [resumeIntent]
 * @property {string} [agentRuntimeId]
 * @property {string} [agentSessionId]
 * @property {string} [agentTaskId]
 * @property {string} [agentLeaseId]
 * @property {number} [agentLeaseGeneration]
 * @property {string} [agentInvocationId]
 * @property {string} [agentInvocationDigest]
 * @property {string} [lastError]
 * @property {string} [code]
 * @property {number} maxDurationMs
 * @property {string} deadlineAt
 * @property {number} [version]
 * @property {OperationTransition[]} history
 */
/**
 * @typedef {Object} OperationInput
 * @property {string} [operationId]
 * @property {string} [command]
 * @property {string} [status]
 * @property {string} [source]
 * @property {string} [route]
 * @property {string} [requestedAt]
 * @property {string} [timestamp]
 * @property {string} [userEmail]
 * @property {string} [lockId]
 * @property {number} [fencingToken]
 * @property {string} [instanceId]
 * @property {string} [executionToken]
 * @property {string} [expectedExecutionToken]
 * @property {string} [staleExecutionToken]
 * @property {number} [executionAttempt]
 * @property {string} [executionClaimedAt]
 * @property {string} [executionLeaseExpiresAt]
 * @property {string} [remoteCommandId]
 * @property {string} [remoteCommandIdentity]
 * @property {string} [remoteCommandInstanceId]
 * @property {string} [remoteCommandStep]
 * @property {boolean} [remoteCommandFinal]
 * @property {string} [remoteCommandStatus]
 * @property {string} [managedVolumeId]
 * @property {string} [managedVolumeDevice]
 * @property {string} [hibernateOriginalInstanceId]
 * @property {string} [hibernateSourceImageId]
 * @property {string} [hibernateReconstructionSnapshotId]
 * @property {string} [hibernatePhase]
 * @property {string} [hibernateBackupId]
 * @property {string} [hibernateBackupDigest]
 * @property {number} [hibernateBackupSize]
 * @property {number} [hibernateBackupGeneration]
 * @property {string} [hibernateBackupCreatedAt]
 * @property {string} [hibernateBackupOperationKey]
 * @property {string} [hibernateBackupInstanceId]
 * @property {string} [hibernateBackupServerId]
 * @property {string} [hibernateBackupArchiveName]
 * @property {string} [hibernateBackupAuthenticationKeyId]
 * @property {Record<string, unknown>} [hibernateQuiescenceEvidence]
 * @property {string} [resumeVolumeClientToken]
 * @property {string} [resumeVolumeId]
 * @property {string} [resumeSnapshotId]
 * @property {string} [sideEffectCompletedAt]
 * @property {string} [sideEffectKey]
 * @property {string} [error]
 * @property {string} [code]
 * @property {OperationPhase} [phase]
 * @property {Record<string, unknown>} [agentTerminalReceipt]
 * @property {{mode: "fresh"|"latest"|"named", backupArchiveName?: string|null}} [resumeIntent]
 */

/** @type {Set<OperationType>} */
const operationTypes = new Set(["start", "stop", "backup", "restore", "hibernate", "resume", "allowlist"]);
/** @type {Set<OperationStatus>} */
const operationStatuses = new Set(["accepted", "running", "completed", "failed"]);
/** @type {Set<TransitionSource>} */
const transitionSources = new Set(["api", "lambda"]);
/** @type {Record<OperationStatus, number>} */
const statusPriority = { accepted: 1, running: 2, completed: 3, failed: 3 };
/** @type {Record<OperationPhase, number>} */
const phasePriority = { validating: 1, dispatching: 2, dispatched: 3, executing: 4, terminal: 5 };
const defaultRetentionDays = 30;
const maxRetentionDays = 3650;
const defaultExecutionLeaseSeconds = 120;
const minExecutionLeaseSeconds = 30;
const maxExecutionLeaseSeconds = 15 * 60;
const maxDurationMs = 17 * 60 * 1000;
const apiOperationTypes = new Set(["start", "stop", "backup", "restore", "hibernate", "resume"]);
const emailOperationTypes = new Set(["start", "backup", "restore", "hibernate", "resume", "allowlist"]);
const resumeIntentPointerId = "mc-aws-resume-intent";

/** @typedef {{schemaVersion: 1, kind: "mc-aws-resume-intent", operationId: string, ownerToken: string, status: "active"|"completed"|"failed", intent: {mode: "fresh"|"latest"|"named"|"replacement-convergence", backupArchiveName?: string|null, backupId?: string, generation?: number}, version: number, updatedAt: string}} ResumeIntentPointer */

function tableName() {
  const value = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!value) throw new Error("MC_OPERATION_STATE_TABLE_NAME is required for durable operation state");
  return value;
}

/** @param {unknown} value @param {number} fallback @param {number} minimum @param {number} maximum */
function parseBoundedInteger(value, fallback, minimum, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]*$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function retentionSeconds() {
  return (
    parseBoundedInteger(process.env.MC_OPERATION_STATE_RETENTION_DAYS, defaultRetentionDays, 1, maxRetentionDays) *
    24 *
    60 *
    60
  );
}

function executionLeaseMs() {
  return (
    parseBoundedInteger(
      process.env.MC_OPERATION_EXECUTION_LEASE_SECONDS,
      defaultExecutionLeaseSeconds,
      minExecutionLeaseSeconds,
      maxExecutionLeaseSeconds
    ) * 1000
  );
}

/** @param {unknown} route @param {OperationType} type */
function isValidOperationRoute(route, type) {
  if (typeof route !== "string") return false;
  if (route === "/api/agent/runtime/backups") return type === "backup";
  if (route === `/api/${type}`) return apiOperationTypes.has(type);
  if (route === `/email/${type}`) return emailOperationTypes.has(type);
  return route === "/scheduled/backup" && type === "backup";
}

/** @param {unknown} value */
function normalizeText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** @param {OperationStatus} status */
function isTerminal(status) {
  return status === "completed" || status === "failed";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value @returns {value is string} */
function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @returns {OperationTransition[] | null} */
function parseHistory(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  /** @type {OperationTransition[]} */
  const history = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.status !== "string" || typeof entry.source !== "string") return null;
    if (
      !operationStatuses.has(/** @type {OperationStatus} */ (entry.status)) ||
      !transitionSources.has(/** @type {TransitionSource} */ (entry.source)) ||
      !isIsoDate(entry.at) ||
      (entry.error !== undefined && typeof entry.error !== "string") ||
      (entry.code !== undefined && typeof entry.code !== "string")
    )
      return null;
    history.push({
      status: /** @type {OperationStatus} */ (entry.status),
      source: /** @type {TransitionSource} */ (entry.source),
      at: entry.at,
      ...(normalizeText(entry.error) ? { error: normalizeText(entry.error) } : {}),
      ...(normalizeText(entry.code) ? { code: normalizeText(entry.code) } : {}),
    });
  }
  return history.slice(-50);
}

/** @param {unknown} raw @returns {OperationState | null} */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fail-closed boundary validates every persisted field before use.
function parseState(raw) {
  if (!raw) return null;
  try {
    const state = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isRecord(state)) return null;
    if (state.schemaVersion !== undefined && state.schemaVersion !== 1) return null;
    if (
      typeof state.id !== "string" ||
      typeof state.type !== "string" ||
      !operationTypes.has(/** @type {OperationType} */ (state.type)) ||
      typeof state.route !== "string" ||
      typeof state.status !== "string" ||
      !operationStatuses.has(/** @type {OperationStatus} */ (state.status)) ||
      !isValidOperationRoute(state.route, /** @type {OperationType} */ (state.type)) ||
      !isIsoDate(state.requestedAt) ||
      !isIsoDate(state.updatedAt)
    )
      return null;
    const status = /** @type {OperationStatus} */ (state.status);
    const rawPhase = typeof state.phase === "string" ? state.phase : "";
    const phase = Object.hasOwn(phasePriority, rawPhase)
      ? /** @type {OperationPhase} */ (rawPhase)
      : isTerminal(status)
        ? "terminal"
        : "validating";
    const history = parseHistory(state.history);
    if (!history) return null;
    if (state.fencingToken !== undefined && !Number.isSafeInteger(state.fencingToken)) return null;
    const lockLeaseGeneration = state.lockLeaseGeneration;
    if (
      lockLeaseGeneration !== undefined &&
      (typeof lockLeaseGeneration !== "number" || !Number.isSafeInteger(lockLeaseGeneration) || lockLeaseGeneration < 1)
    )
      return null;
    const executionAttempt = state.executionAttempt;
    if (
      executionAttempt !== undefined &&
      (typeof executionAttempt !== "number" || !Number.isSafeInteger(executionAttempt) || executionAttempt < 1)
    ) {
      return null;
    }
    for (const candidate of [
      state.executionClaimedAt,
      state.executionLeaseExpiresAt,
      state.sideEffectCompletedAt,
      state.lockLeaseExpiresAt,
      state.agentEffectReconciliationUpdatedAt,
      state.agentEffectSafetyExpiresAt,
    ]) {
      if (candidate !== undefined && !isIsoDate(candidate)) return null;
    }
    if (
      state.hibernateBackupGeneration !== undefined &&
      (typeof state.hibernateBackupGeneration !== "number" ||
        !Number.isSafeInteger(state.hibernateBackupGeneration) ||
        state.hibernateBackupGeneration < 1)
    )
      return null;
    if (
      state.hibernateBackupSize !== undefined &&
      (typeof state.hibernateBackupSize !== "number" ||
        !Number.isSafeInteger(state.hibernateBackupSize) ||
        state.hibernateBackupSize < 1)
    )
      return null;
    if (state.remoteCommandFinal !== undefined && typeof state.remoteCommandFinal !== "boolean") return null;
    const reconciliationStatus =
      typeof state.agentEffectReconciliationStatus === "string" ? state.agentEffectReconciliationStatus : undefined;
    if (
      state.agentEffectReconciliationStatus !== undefined &&
      !["awaiting-executor", "active", "needed", "resolved"].includes(reconciliationStatus ?? "")
    ) {
      return null;
    }
    if (
      state.agentFenceAuthorization !== undefined &&
      (!isRecord(state.agentFenceAuthorization) ||
        state.agentFenceAuthorization.status !== "succeeded" ||
        !Number.isSafeInteger(state.agentFenceAuthorization.lifecycleLeaseGeneration))
    ) {
      return null;
    }
    if (state.agentTerminalReceipt !== undefined && !isRecord(state.agentTerminalReceipt)) return null;
    if (
      state.resumeIntent !== undefined &&
      (!isRecord(state.resumeIntent) ||
        typeof state.resumeIntent.mode !== "string" ||
        !["fresh", "latest", "named"].includes(state.resumeIntent.mode) ||
        (state.resumeIntent.backupArchiveName !== undefined &&
          state.resumeIntent.backupArchiveName !== null &&
          typeof state.resumeIntent.backupArchiveName !== "string"))
    )
      return null;
    const agentBinding = [
      state.agentRuntimeId,
      state.agentSessionId,
      state.agentTaskId,
      state.agentLeaseId,
      state.agentLeaseGeneration,
      state.agentInvocationId,
      state.agentInvocationDigest,
    ];
    const hasAgentBinding = agentBinding.some((value) => value !== undefined);
    const agentLeaseGeneration = state.agentLeaseGeneration;
    if (
      hasAgentBinding &&
      (!agentBinding
        .slice(0, 4)
        .every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) ||
        typeof agentLeaseGeneration !== "number" ||
        !Number.isSafeInteger(agentLeaseGeneration) ||
        agentLeaseGeneration < 1 ||
        typeof state.agentInvocationId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(state.agentInvocationId) ||
        typeof state.agentInvocationDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.agentInvocationDigest))
    )
      return null;
    const configuredDuration = typeof state.maxDurationMs === "number" ? state.maxDurationMs : Number.NaN;
    const duration =
      Number.isSafeInteger(configuredDuration) && configuredDuration > 0 ? configuredDuration : maxDurationMs;
    const deadlineAt = isIsoDate(state.deadlineAt)
      ? state.deadlineAt
      : new Date(Date.parse(state.requestedAt) + duration).toISOString();
    return {
      schemaVersion: 1,
      id: state.id,
      type: /** @type {OperationType} */ (state.type),
      route: /** @type {string} */ (state.route),
      status,
      phase,
      requestedAt: state.requestedAt,
      updatedAt: state.updatedAt,
      requestedBy: normalizeText(state.requestedBy),
      lockId: normalizeText(state.lockId),
      fencingToken: Number.isSafeInteger(state.fencingToken) ? /** @type {number} */ (state.fencingToken) : undefined,
      lockLeaseGeneration,
      lockLeaseExpiresAt: isIsoDate(state.lockLeaseExpiresAt) ? state.lockLeaseExpiresAt : undefined,
      requestIdempotencyKey: normalizeText(state.requestIdempotencyKey),
      dispatchOwnerId: normalizeText(state.dispatchOwnerId),
      agentEffectReconciliationStatus:
        /** @type {"awaiting-executor" | "active" | "needed" | "resolved" | undefined} */ (reconciliationStatus),
      agentEffectReconciliationUpdatedAt: isIsoDate(state.agentEffectReconciliationUpdatedAt)
        ? state.agentEffectReconciliationUpdatedAt
        : undefined,
      agentEffectSafetyExpiresAt: isIsoDate(state.agentEffectSafetyExpiresAt)
        ? state.agentEffectSafetyExpiresAt
        : undefined,
      agentFenceAuthorization: isRecord(state.agentFenceAuthorization) ? state.agentFenceAuthorization : undefined,
      agentTerminalReceipt: isRecord(state.agentTerminalReceipt) ? state.agentTerminalReceipt : undefined,
      instanceId: normalizeText(state.instanceId),
      executionToken: normalizeText(state.executionToken),
      executionAttempt: Number.isSafeInteger(state.executionAttempt)
        ? /** @type {number} */ (state.executionAttempt)
        : undefined,
      executionClaimedAt: isIsoDate(state.executionClaimedAt) ? state.executionClaimedAt : undefined,
      executionLeaseExpiresAt: isIsoDate(state.executionLeaseExpiresAt) ? state.executionLeaseExpiresAt : undefined,
      remoteCommandId: normalizeText(state.remoteCommandId),
      remoteCommandIdentity: normalizeText(state.remoteCommandIdentity),
      remoteCommandInstanceId: normalizeText(state.remoteCommandInstanceId),
      remoteCommandStep: normalizeText(state.remoteCommandStep),
      remoteCommandFinal: typeof state.remoteCommandFinal === "boolean" ? state.remoteCommandFinal : undefined,
      remoteCommandStatus: normalizeText(state.remoteCommandStatus),
      managedVolumeId: normalizeText(state.managedVolumeId),
      managedVolumeDevice: normalizeText(state.managedVolumeDevice),
      hibernateOriginalInstanceId: normalizeText(state.hibernateOriginalInstanceId),
      hibernateSourceImageId: normalizeText(state.hibernateSourceImageId),
      hibernateReconstructionSnapshotId: normalizeText(state.hibernateReconstructionSnapshotId),
      hibernatePhase: normalizeText(state.hibernatePhase),
      hibernateBackupId: normalizeText(state.hibernateBackupId),
      hibernateBackupDigest: normalizeText(state.hibernateBackupDigest),
      hibernateBackupSize:
        typeof state.hibernateBackupSize === "number" && Number.isSafeInteger(state.hibernateBackupSize)
          ? state.hibernateBackupSize
          : undefined,
      hibernateBackupGeneration: Number.isSafeInteger(state.hibernateBackupGeneration)
        ? /** @type {number} */ (state.hibernateBackupGeneration)
        : undefined,
      hibernateBackupCreatedAt: isIsoDate(state.hibernateBackupCreatedAt) ? state.hibernateBackupCreatedAt : undefined,
      hibernateBackupOperationKey: normalizeText(state.hibernateBackupOperationKey),
      hibernateBackupInstanceId: normalizeText(state.hibernateBackupInstanceId),
      hibernateBackupServerId: normalizeText(state.hibernateBackupServerId),
      hibernateBackupArchiveName: normalizeText(state.hibernateBackupArchiveName),
      hibernateBackupAuthenticationKeyId: normalizeText(state.hibernateBackupAuthenticationKeyId),
      hibernateQuiescenceEvidence: isRecord(state.hibernateQuiescenceEvidence)
        ? state.hibernateQuiescenceEvidence
        : undefined,
      resumeVolumeClientToken: normalizeText(state.resumeVolumeClientToken),
      resumeVolumeId: normalizeText(state.resumeVolumeId),
      resumeSnapshotId: normalizeText(state.resumeSnapshotId),
      sideEffectCompletedAt: isIsoDate(state.sideEffectCompletedAt) ? state.sideEffectCompletedAt : undefined,
      sideEffectKey: normalizeText(state.sideEffectKey),
      resumeIntent: isRecord(state.resumeIntent)
        ? /** @type {{mode: "fresh"|"latest"|"named", backupArchiveName?: string|null}} */ (state.resumeIntent)
        : undefined,
      agentRuntimeId: normalizeText(state.agentRuntimeId),
      agentSessionId: normalizeText(state.agentSessionId),
      agentTaskId: normalizeText(state.agentTaskId),
      agentLeaseId: normalizeText(state.agentLeaseId),
      agentLeaseGeneration: typeof agentLeaseGeneration === "number" ? agentLeaseGeneration : undefined,
      agentInvocationId: normalizeText(state.agentInvocationId),
      agentInvocationDigest: normalizeText(state.agentInvocationDigest),
      lastError: normalizeText(state.lastError),
      code: normalizeText(state.code),
      maxDurationMs: duration,
      deadlineAt,
      history,
    };
  } catch {
    return null;
  }
}

/** @param {string} operationId @returns {Promise<{state: OperationState, version: number} | null>} */
async function readRecord(operationId) {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: operationId } },
      ConsistentRead: true,
    })
  );
  if (!response.Item) return null;
  const state = parseState(response.Item.payload?.S);
  const version = Number(response.Item?.version?.N ?? Number.NaN);
  if (!state || !Number.isSafeInteger(version)) {
    throw new Error(`Operation ${operationId} has malformed durable state`);
  }
  return { state: { ...state, version }, version };
}

/** @param {unknown} raw @returns {ResumeIntentPointer | null} */
function parseResumeIntentPointer(raw) {
  if (!raw) return null;
  try {
    const pointer = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isRecord(pointer) || pointer.schemaVersion !== 1 || pointer.kind !== "mc-aws-resume-intent") return null;
    const status = pointer.status;
    const version = pointer.version;
    const intent = pointer.intent;
    if (
      typeof pointer.operationId !== "string" ||
      typeof pointer.ownerToken !== "string" ||
      typeof status !== "string" ||
      !["active", "completed", "failed"].includes(status) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !isIsoDate(pointer.updatedAt) ||
      !isRecord(intent) ||
      typeof intent.mode !== "string" ||
      !["fresh", "latest", "named", "replacement-convergence"].includes(intent.mode)
    )
      return null;
    if (
      isRecord(intent) &&
      intent.backupArchiveName !== undefined &&
      intent.backupArchiveName !== null &&
      typeof intent.backupArchiveName !== "string"
    )
      return null;
    return /** @type {ResumeIntentPointer} */ (pointer);
  } catch {
    return null;
  }
}

async function readResumeIntentPointer() {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: resumeIntentPointerId } },
      ConsistentRead: true,
    })
  );
  if (!response.Item) return null;
  const pointer = parseResumeIntentPointer(response.Item.payload?.S);
  if (!pointer || pointer.version !== Number(response.Item.version?.N ?? Number.NaN)) {
    throw new Error("Resume intent pointer is malformed");
  }
  return pointer;
}

/** @param {{operationId: string, ownerToken: string, operationVersion: number, intent: ResumeIntentPointer["intent"]}} input */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single conditional-write fence for the durable resume pointer.
async function claimResumeIntentPointer(input) {
  if (!input.operationId || !input.ownerToken || !Number.isSafeInteger(input.operationVersion) || !input.intent?.mode) {
    throw new Error("Resume intent identity is invalid");
  }
  const operationRecord = await readRecord(input.operationId);
  if (
    !operationRecord ||
    operationRecord.version !== input.operationVersion ||
    operationRecord.state.type !== "resume" ||
    operationRecord.state.status !== "running" ||
    operationRecord.state.executionToken !== input.ownerToken
  ) {
    throw new Error("Resume operation execution ownership changed");
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readResumeIntentPointer();
    if (current?.status === "active" && current.operationId !== input.operationId) {
      throw new Error("Another resume intent is active");
    }
    const nextVersion = (current?.version || 0) + 1;
    const pointer = {
      schemaVersion: 1,
      kind: "mc-aws-resume-intent",
      operationId: input.operationId,
      ownerToken: input.ownerToken,
      status: "active",
      intent: input.intent,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };
    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName(),
          Key: { operationId: { S: resumeIntentPointerId } },
          ConditionExpression:
            current?.version === undefined
              ? "attribute_not_exists(operationId)"
              : "#version = :expected AND (#status <> :active OR (operationIdOwner = :operationId AND ownerToken = :previousOwnerToken))",
          UpdateExpression:
            "SET payload = :payload, #version = :version, #status = :status, operationIdOwner = :operationId, ownerToken = :ownerToken, updatedAt = :updatedAt REMOVE ttlEpochSeconds",
          ExpressionAttributeNames: { "#version": "version", "#status": "status" },
          ExpressionAttributeValues: {
            ...(current?.version === undefined ? {} : { ":expected": { N: String(current.version) } }),
            ":active": { S: "active" },
            ":payload": { S: JSON.stringify(pointer) },
            ":version": { N: String(nextVersion) },
            ":status": { S: "active" },
            ":operationId": { S: input.operationId },
            ":ownerToken": { S: input.ownerToken },
            ":updatedAt": { S: pointer.updatedAt },
            ...(current?.version === undefined ? {} : { ":previousOwnerToken": { S: current.ownerToken } }),
          },
        })
      );
      return pointer;
    } catch (error) {
      if (!isRecord(error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error("Resume intent pointer contention exceeded retry budget");
}

/** @param {{operationId: string, ownerToken: string, status: "completed"|"failed"}} input */
async function completeResumeIntentPointer(input) {
  const current = await readResumeIntentPointer();
  if (!current) return null;
  if (
    current.status !== "active" &&
    current.operationId === input.operationId &&
    current.ownerToken === input.ownerToken
  )
    return current;
  if (current.operationId !== input.operationId || current.ownerToken !== input.ownerToken) {
    throw new Error("Resume intent successor owns the pointer");
  }
  const next = { ...current, status: input.status, version: current.version + 1, updatedAt: new Date().toISOString() };
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: resumeIntentPointerId } },
      ConditionExpression:
        "#version = :expected AND #status = :active AND operationIdOwner = :operationId AND ownerToken = :ownerToken",
      UpdateExpression: "SET payload = :payload, #version = :version, #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#version": "version", "#status": "status" },
      ExpressionAttributeValues: {
        ":expected": { N: String(current.version) },
        ":active": { S: "active" },
        ":operationId": { S: input.operationId },
        ":ownerToken": { S: input.ownerToken },
        ":payload": { S: JSON.stringify(next) },
        ":version": { N: String(next.version) },
        ":status": { S: input.status },
        ":updatedAt": { S: next.updatedAt },
      },
    })
  );
  return next;
}

/** @param {OperationState} state @param {number} expectedVersion @returns {Promise<OperationState>} */
async function writeRecord(state, expectedVersion) {
  const nextVersion = expectedVersion + 1;
  const nextState = { ...state, version: nextVersion };
  const ttlEligible = isTerminal(nextState.status) && !nextState.lockId;
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: state.id } },
      ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(operationId)" : "#version = :expected",
      UpdateExpression: ttlEligible
        ? "SET payload = :payload, #version = :next, #status = :status, phase = :phase, updatedAt = :updatedAt, ttlEpochSeconds = :ttl"
        : "SET payload = :payload, #version = :next, #status = :status, phase = :phase, updatedAt = :updatedAt REMOVE ttlEpochSeconds",
      ExpressionAttributeNames: { "#version": "version", "#status": "status" },
      ExpressionAttributeValues: {
        ...(expectedVersion === 0 ? {} : { ":expected": { N: String(expectedVersion) } }),
        ":payload": { S: JSON.stringify(nextState) },
        ":next": { N: String(nextVersion) },
        ":status": { S: nextState.status },
        ":phase": { S: nextState.phase },
        ":updatedAt": { S: nextState.updatedAt },
        ...(ttlEligible ? { ":ttl": { N: String(Math.floor(Date.now() / 1000) + retentionSeconds()) } } : {}),
      },
    })
  );
  return nextState;
}

/** @param {OperationState | null} existing @param {OperationStatus} next */
function shouldApplyStatus(existing, next) {
  if (!existing || existing.status === next) return true;
  if (isTerminal(existing.status)) return false;
  return statusPriority[next] >= statusPriority[existing.status];
}

/** @param {OperationState | null} existing @param {OperationInput & {operationId: string, command: OperationType, status: OperationStatus, source: TransitionSource}} input @param {string} now @returns {OperationState} */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The state merge is centralized so every writer applies identical monotonic rules.
function buildState(existing, input, now) {
  const requestedAt = existing?.requestedAt || input.requestedAt || now;
  const applyStatus = shouldApplyStatus(existing, input.status);
  const status = applyStatus ? input.status : (existing?.status ?? input.status);
  const requestedPhase =
    input.phase || (isTerminal(status) ? "terminal" : status === "running" ? "executing" : "validating");
  const phase =
    existing && phasePriority[existing.phase] > phasePriority[requestedPhase] ? existing.phase : requestedPhase;
  const error = normalizeText(input.error);
  const code = normalizeText(input.code);
  const nextRemoteCommandIdentity = normalizeText(input.remoteCommandIdentity);
  const remoteCommandIdentityChanged =
    Boolean(nextRemoteCommandIdentity) && nextRemoteCommandIdentity !== existing?.remoteCommandIdentity;
  const history = [...(existing?.history || [])];
  const latest = history.at(-1);
  if (
    applyStatus &&
    (latest?.status !== status || latest?.source !== input.source || latest?.error !== error || latest?.code !== code)
  ) {
    history.push({ status, at: now, source: input.source, ...(status === "failed" ? { error, code } : {}) });
  }
  return {
    schemaVersion: 1,
    id: existing?.id || input.operationId,
    type: existing?.type || input.command,
    route: existing?.route || input.route || `/api/${input.command}`,
    status,
    phase,
    requestedAt,
    updatedAt: now,
    requestedBy: normalizeText(input.userEmail) || existing?.requestedBy,
    lockId: normalizeText(input.lockId) || existing?.lockId,
    fencingToken: Number.isSafeInteger(input.fencingToken) ? input.fencingToken : existing?.fencingToken,
    lockLeaseGeneration: existing?.lockLeaseGeneration,
    lockLeaseExpiresAt: existing?.lockLeaseExpiresAt,
    requestIdempotencyKey: existing?.requestIdempotencyKey,
    dispatchOwnerId: existing?.dispatchOwnerId,
    agentEffectReconciliationStatus: existing?.agentEffectReconciliationStatus,
    agentEffectReconciliationUpdatedAt: existing?.agentEffectReconciliationUpdatedAt,
    agentEffectSafetyExpiresAt: existing?.agentEffectSafetyExpiresAt,
    agentFenceAuthorization: existing?.agentFenceAuthorization,
    agentTerminalReceipt: existing?.agentTerminalReceipt,
    instanceId: normalizeText(input.instanceId) || existing?.instanceId,
    executionToken: normalizeText(input.executionToken) || existing?.executionToken,
    executionAttempt: Number.isSafeInteger(input.executionAttempt)
      ? input.executionAttempt
      : existing?.executionAttempt,
    executionClaimedAt: isIsoDate(input.executionClaimedAt) ? input.executionClaimedAt : existing?.executionClaimedAt,
    executionLeaseExpiresAt: isIsoDate(input.executionLeaseExpiresAt)
      ? input.executionLeaseExpiresAt
      : existing?.executionLeaseExpiresAt,
    remoteCommandId: remoteCommandIdentityChanged
      ? normalizeText(input.remoteCommandId)
      : normalizeText(input.remoteCommandId) || existing?.remoteCommandId,
    remoteCommandIdentity: nextRemoteCommandIdentity || existing?.remoteCommandIdentity,
    remoteCommandInstanceId: normalizeText(input.remoteCommandInstanceId) || existing?.remoteCommandInstanceId,
    remoteCommandStep: normalizeText(input.remoteCommandStep) || existing?.remoteCommandStep,
    remoteCommandFinal:
      typeof input.remoteCommandFinal === "boolean" ? input.remoteCommandFinal : existing?.remoteCommandFinal,
    remoteCommandStatus: remoteCommandIdentityChanged
      ? normalizeText(input.remoteCommandStatus)
      : normalizeText(input.remoteCommandStatus) || existing?.remoteCommandStatus,
    managedVolumeId: normalizeText(input.managedVolumeId) || existing?.managedVolumeId,
    managedVolumeDevice: normalizeText(input.managedVolumeDevice) || existing?.managedVolumeDevice,
    hibernateOriginalInstanceId:
      normalizeText(input.hibernateOriginalInstanceId) || existing?.hibernateOriginalInstanceId,
    hibernateSourceImageId: normalizeText(input.hibernateSourceImageId) || existing?.hibernateSourceImageId,
    hibernateReconstructionSnapshotId:
      normalizeText(input.hibernateReconstructionSnapshotId) || existing?.hibernateReconstructionSnapshotId,
    hibernatePhase: normalizeText(input.hibernatePhase) || existing?.hibernatePhase,
    hibernateBackupId: normalizeText(input.hibernateBackupId) || existing?.hibernateBackupId,
    hibernateBackupDigest: normalizeText(input.hibernateBackupDigest) || existing?.hibernateBackupDigest,
    hibernateBackupSize:
      typeof input.hibernateBackupSize === "number" && Number.isSafeInteger(input.hibernateBackupSize)
        ? input.hibernateBackupSize
        : existing?.hibernateBackupSize,
    hibernateBackupGeneration:
      typeof input.hibernateBackupGeneration === "number" && Number.isSafeInteger(input.hibernateBackupGeneration)
        ? input.hibernateBackupGeneration
        : existing?.hibernateBackupGeneration,
    hibernateBackupCreatedAt: isIsoDate(input.hibernateBackupCreatedAt)
      ? input.hibernateBackupCreatedAt
      : existing?.hibernateBackupCreatedAt,
    hibernateBackupOperationKey:
      normalizeText(input.hibernateBackupOperationKey) || existing?.hibernateBackupOperationKey,
    hibernateBackupInstanceId: normalizeText(input.hibernateBackupInstanceId) || existing?.hibernateBackupInstanceId,
    hibernateBackupServerId: normalizeText(input.hibernateBackupServerId) || existing?.hibernateBackupServerId,
    hibernateBackupArchiveName: normalizeText(input.hibernateBackupArchiveName) || existing?.hibernateBackupArchiveName,
    hibernateBackupAuthenticationKeyId:
      normalizeText(input.hibernateBackupAuthenticationKeyId) || existing?.hibernateBackupAuthenticationKeyId,
    hibernateQuiescenceEvidence: isRecord(input.hibernateQuiescenceEvidence)
      ? input.hibernateQuiescenceEvidence
      : existing?.hibernateQuiescenceEvidence,
    resumeVolumeClientToken: normalizeText(input.resumeVolumeClientToken) || existing?.resumeVolumeClientToken,
    resumeVolumeId: normalizeText(input.resumeVolumeId) || existing?.resumeVolumeId,
    resumeSnapshotId: normalizeText(input.resumeSnapshotId) || existing?.resumeSnapshotId,
    sideEffectCompletedAt: isIsoDate(input.sideEffectCompletedAt)
      ? input.sideEffectCompletedAt
      : existing?.sideEffectCompletedAt,
    sideEffectKey: normalizeText(input.sideEffectKey) || existing?.sideEffectKey,
    resumeIntent: isRecord(input.resumeIntent) ? input.resumeIntent : existing?.resumeIntent,
    agentRuntimeId: existing?.agentRuntimeId,
    agentSessionId: existing?.agentSessionId,
    agentTaskId: existing?.agentTaskId,
    agentLeaseId: existing?.agentLeaseId,
    agentLeaseGeneration: existing?.agentLeaseGeneration,
    agentInvocationId: existing?.agentInvocationId,
    agentInvocationDigest: existing?.agentInvocationDigest,
    lastError: status === "failed" ? error || existing?.lastError || "Operation failed" : undefined,
    code: status === "failed" ? code || existing?.code : undefined,
    maxDurationMs: existing?.maxDurationMs || maxDurationMs,
    deadlineAt: existing?.deadlineAt || new Date(Date.parse(requestedAt) + maxDurationMs).toISOString(),
    history: history.slice(-50),
  };
}

/** @param {OperationInput} input @returns {Promise<OperationState | null>} */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation and bounded optimistic retries intentionally remain one transaction boundary.
async function updateOperationState(input) {
  const operationId = normalizeText(input?.operationId);
  const command = normalizeText(input?.command);
  const status = normalizeText(input?.status);
  const source = normalizeText(input?.source) || "lambda";
  if (
    !operationId ||
    !command ||
    !operationTypes.has(/** @type {OperationType} */ (command)) ||
    !status ||
    !operationStatuses.has(/** @type {OperationStatus} */ (status))
  ) {
    throw new Error("Invalid operation state transition identity or status");
  }
  if (!transitionSources.has(/** @type {TransitionSource} */ (source))) {
    throw new Error(`Invalid operation transition source '${source}'`);
  }
  const route = normalizeText(input.route);
  if (route && !isValidOperationRoute(route, /** @type {OperationType} */ (command))) {
    throw new Error(`Invalid operation route '${route}' for command '${command}'`);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await readRecord(operationId);
    if (record?.state.lockId && input.lockId && record.state.lockId !== input.lockId) {
      throw new Error(`Operation ${operationId} lifecycle lock ownership changed`);
    }
    if (
      record?.state.fencingToken !== undefined &&
      input.fencingToken !== undefined &&
      record.state.fencingToken !== input.fencingToken
    ) {
      throw new Error(`Operation ${operationId} lifecycle fencing ownership changed`);
    }
    if (record && input.lockId && !record.state.lockId) {
      throw new Error(`Operation ${operationId} is missing lifecycle lock proof`);
    }
    if (input.expectedExecutionToken && record?.state.executionToken !== input.expectedExecutionToken) {
      throw new Error(`Operation ${operationId} execution ownership changed`);
    }
    if (command === "hibernate" && status === "completed" && record?.state.hibernatePhase !== "deleted") {
      throw new Error(`Operation ${operationId} cannot complete before managed root deletion is durable`);
    }
    const next = buildState(
      record?.state || null,
      {
        ...input,
        operationId,
        command: /** @type {OperationType} */ (command),
        status: /** @type {OperationStatus} */ (status),
        source: /** @type {TransitionSource} */ (source),
      },
      input.timestamp || new Date().toISOString()
    );
    try {
      return await writeRecord(next, record?.version || 0);
    } catch (error) {
      if (!isRecord(error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error(`Operation state contention exceeded retry budget for ${operationId}`);
}

/** @param {OperationInput & {operationId: string, command: string, executionToken: string}} input */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Identity checks, active leases, and conditional stale takeover are one ownership boundary.
async function claimOperationExecution(input) {
  const executionToken = normalizeText(input.executionToken);
  const command = normalizeText(input.command);
  if (!executionToken || !command || !operationTypes.has(/** @type {OperationType} */ (command))) {
    throw new Error("Operation execution claim requires a valid command and attempt token");
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await readRecord(input.operationId);
    if (!record) return { claimed: false, reason: "missing", state: null };
    if (record.state.type !== command) {
      throw new Error(`Operation ${input.operationId} command identity changed`);
    }
    if (record.state.lockId && input.lockId && record.state.lockId !== input.lockId) {
      throw new Error(`Operation ${input.operationId} lock identity changed`);
    }
    if (
      Number.isSafeInteger(record.state.fencingToken) &&
      Number.isSafeInteger(input.fencingToken) &&
      record.state.fencingToken !== input.fencingToken
    ) {
      throw new Error(`Operation ${input.operationId} fencing token changed`);
    }
    if (record.state.phase === "terminal") {
      return { claimed: false, reason: "terminal", state: record.state };
    }
    if (record.state.phase === "executing") {
      const leaseExpiresAt = Date.parse(record.state.executionLeaseExpiresAt || "");
      if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) {
        return { claimed: false, reason: "active", state: record.state };
      }
      if (!input.staleExecutionToken || input.staleExecutionToken !== record.state.executionToken) {
        return { claimed: false, reason: "stale", state: record.state };
      }
    }
    if (
      record.state.phase !== "dispatching" &&
      record.state.phase !== "dispatched" &&
      record.state.phase !== "executing"
    ) {
      return { claimed: false, reason: "not_dispatchable", state: record.state };
    }
    const claimedAt = new Date().toISOString();
    const nextAttempt = (record.state.executionAttempt || 0) + 1;
    const next = buildState(
      record.state,
      {
        operationId: input.operationId,
        command: /** @type {OperationType} */ (command),
        status: "running",
        source: "lambda",
        phase: "executing",
        executionToken,
        executionAttempt: nextAttempt,
        executionClaimedAt: claimedAt,
        executionLeaseExpiresAt: new Date(Date.now() + executionLeaseMs()).toISOString(),
        lockId: input.lockId,
        fencingToken: input.fencingToken,
        instanceId: input.instanceId,
        userEmail: input.userEmail,
      },
      claimedAt
    );
    next.remoteCommandId = undefined;
    next.remoteCommandIdentity = undefined;
    next.remoteCommandInstanceId = undefined;
    next.remoteCommandStep = undefined;
    next.remoteCommandFinal = undefined;
    next.remoteCommandStatus = undefined;
    try {
      return {
        claimed: true,
        reason: input.staleExecutionToken ? "reclaimed" : "claimed",
        state: await writeRecord(next, record.version),
      };
    } catch (error) {
      if (!isRecord(error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new Error(`Operation execution claim contention exceeded retry budget for ${input.operationId}`);
}

/** @param {{operationId: string, command: string, executionToken: string}} input */
async function heartbeatOperationExecution(input) {
  return await updateOperationState({
    operationId: input.operationId,
    command: input.command,
    status: "running",
    phase: "executing",
    expectedExecutionToken: input.executionToken,
    executionLeaseExpiresAt: new Date(Date.now() + executionLeaseMs()).toISOString(),
  });
}

/** @param {{operationId: string, command: string, executionToken: string, commandId: string, identity?: string, instanceId: string, step?: string, final?: boolean, status?: string}} input */
async function recordOperationRemoteCommand(input) {
  return await updateOperationState({
    operationId: input.operationId,
    command: input.command,
    status: "running",
    phase: "executing",
    expectedExecutionToken: input.executionToken,
    executionLeaseExpiresAt: new Date(Date.now() + executionLeaseMs()).toISOString(),
    remoteCommandId: input.commandId,
    remoteCommandIdentity: input.identity,
    remoteCommandInstanceId: input.instanceId,
    remoteCommandStep: input.step || "remote-command",
    remoteCommandFinal: input.final === true,
    remoteCommandStatus: input.status || "Pending",
  });
}

/** @param {{operationId: string, command: string, executionToken: string, identity: string, instanceId: string, step?: string, final?: boolean}} input */
async function recordOperationRemoteCommandIdentity(input) {
  return await updateOperationState({
    operationId: input.operationId,
    command: input.command,
    status: "running",
    phase: "executing",
    expectedExecutionToken: input.executionToken,
    executionLeaseExpiresAt: new Date(Date.now() + executionLeaseMs()).toISOString(),
    remoteCommandIdentity: input.identity,
    remoteCommandInstanceId: input.instanceId,
    remoteCommandStep: input.step || "remote-command",
    remoteCommandFinal: input.final === true,
    remoteCommandStatus: "Dispatching",
  });
}

/** @param {{operationId: string, command: string, executionToken: string, sideEffectKey: string}} input */
async function recordOperationSideEffectCompleted(input) {
  return await updateOperationState({
    operationId: input.operationId,
    command: input.command,
    status: "running",
    phase: "executing",
    expectedExecutionToken: input.executionToken,
    executionLeaseExpiresAt: new Date(Date.now() + executionLeaseMs()).toISOString(),
    sideEffectCompletedAt: new Date().toISOString(),
    sideEffectKey: input.sideEffectKey,
  });
}

/** @param {string} operationId @returns {Promise<OperationState | null>} */
async function getOperationState(operationId) {
  return (await readRecord(operationId))?.state || null;
}

export {
  claimOperationExecution,
  claimResumeIntentPointer,
  completeResumeIntentPointer,
  getOperationState,
  readResumeIntentPointer,
  heartbeatOperationExecution,
  isValidOperationRoute,
  recordOperationRemoteCommand,
  recordOperationRemoteCommandIdentity,
  recordOperationSideEffectCompleted,
  updateOperationState,
};
