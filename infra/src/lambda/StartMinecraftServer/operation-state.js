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
 * @property {string} [hibernatePhase]
 * @property {string} [resumeVolumeClientToken]
 * @property {string} [resumeVolumeId]
 * @property {string} [resumeSnapshotId]
 * @property {string} [sideEffectCompletedAt]
 * @property {string} [sideEffectKey]
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
 * @property {string} [hibernatePhase]
 * @property {string} [resumeVolumeClientToken]
 * @property {string} [resumeVolumeId]
 * @property {string} [resumeSnapshotId]
 * @property {string} [sideEffectCompletedAt]
 * @property {string} [sideEffectKey]
 * @property {string} [error]
 * @property {string} [code]
 * @property {OperationPhase} [phase]
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
    const executionAttempt = state.executionAttempt;
    if (
      executionAttempt !== undefined &&
      (typeof executionAttempt !== "number" || !Number.isSafeInteger(executionAttempt) || executionAttempt < 1)
    ) {
      return null;
    }
    for (const candidate of [state.executionClaimedAt, state.executionLeaseExpiresAt, state.sideEffectCompletedAt]) {
      if (candidate !== undefined && !isIsoDate(candidate)) return null;
    }
    if (state.remoteCommandFinal !== undefined && typeof state.remoteCommandFinal !== "boolean") return null;
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
      hibernatePhase: normalizeText(state.hibernatePhase),
      resumeVolumeClientToken: normalizeText(state.resumeVolumeClientToken),
      resumeVolumeId: normalizeText(state.resumeVolumeId),
      resumeSnapshotId: normalizeText(state.resumeSnapshotId),
      sideEffectCompletedAt: isIsoDate(state.sideEffectCompletedAt) ? state.sideEffectCompletedAt : undefined,
      sideEffectKey: normalizeText(state.sideEffectKey),
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

/** @param {OperationState} state @param {number} expectedVersion @returns {Promise<OperationState>} */
async function writeRecord(state, expectedVersion) {
  const nextVersion = expectedVersion + 1;
  const nextState = { ...state, version: nextVersion };
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { operationId: { S: state.id } },
      ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(operationId)" : "#version = :expected",
      UpdateExpression:
        "SET payload = :payload, #version = :next, #status = :status, phase = :phase, updatedAt = :updatedAt, ttlEpochSeconds = :ttl",
      ExpressionAttributeNames: { "#version": "version", "#status": "status" },
      ExpressionAttributeValues: {
        ...(expectedVersion === 0 ? {} : { ":expected": { N: String(expectedVersion) } }),
        ":payload": { S: JSON.stringify(nextState) },
        ":next": { N: String(nextVersion) },
        ":status": { S: nextState.status },
        ":phase": { S: nextState.phase },
        ":updatedAt": { S: nextState.updatedAt },
        ":ttl": { N: String(Math.floor(Date.now() / 1000) + retentionSeconds()) },
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
    hibernatePhase: normalizeText(input.hibernatePhase) || existing?.hibernatePhase,
    resumeVolumeClientToken: normalizeText(input.resumeVolumeClientToken) || existing?.resumeVolumeClientToken,
    resumeVolumeId: normalizeText(input.resumeVolumeId) || existing?.resumeVolumeId,
    resumeSnapshotId: normalizeText(input.resumeSnapshotId) || existing?.resumeSnapshotId,
    sideEffectCompletedAt: isIsoDate(input.sideEffectCompletedAt)
      ? input.sideEffectCompletedAt
      : existing?.sideEffectCompletedAt,
    sideEffectKey: normalizeText(input.sideEffectKey) || existing?.sideEffectKey,
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
  getOperationState,
  heartbeatOperationExecution,
  isValidOperationRoute,
  recordOperationRemoteCommand,
  recordOperationRemoteCommandIdentity,
  recordOperationSideEffectCompleted,
  updateOperationState,
};
