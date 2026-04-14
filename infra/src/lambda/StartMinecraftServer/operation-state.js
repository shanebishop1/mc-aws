import { getParameter, putParameter } from "./ssm.js";

const operationStateParamPrefix = "/minecraft/operations";
const operationTypes = new Set(["start", "stop", "backup", "restore", "hibernate", "resume"]);
const operationStatuses = new Set(["accepted", "running", "completed", "failed"]);
const transitionSources = new Set(["api", "lambda"]);
const operationStatusPriority = {
  accepted: 1,
  running: 2,
  completed: 3,
  failed: 3,
};

function getOperationStateParameterName(operationId) {
  return `${operationStateParamPrefix}/${operationId}`;
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTerminalOperationStatus(status) {
  return status === "completed" || status === "failed";
}

function shouldApplyStatusTransition(existing, nextStatus, source) {
  if (!existing) {
    return true;
  }

  const currentStatus = existing.status;

  if (currentStatus === nextStatus) {
    return true;
  }

  if (isTerminalOperationStatus(currentStatus)) {
    return false;
  }

  if (currentStatus === "running" && nextStatus === "accepted") {
    const latestSource = existing.history.at(-1)?.source;
    return latestSource === "api" && source === "api";
  }

  return operationStatusPriority[nextStatus] >= operationStatusPriority[currentStatus];
}

function parseOperationState(raw) {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!isObject(parsed)) {
      return null;
    }

    if (
      typeof parsed.id !== "string" ||
      typeof parsed.type !== "string" ||
      typeof parsed.route !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.requestedAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    if (!operationTypes.has(parsed.type) || !operationStatuses.has(parsed.status)) {
      return null;
    }

    const history = Array.isArray(parsed.history)
      ? parsed.history.flatMap((entry) => {
          if (!isObject(entry)) {
            return [];
          }

          if (
            typeof entry.status !== "string" ||
            typeof entry.at !== "string" ||
            typeof entry.source !== "string" ||
            !operationStatuses.has(entry.status) ||
            !transitionSources.has(entry.source)
          ) {
            return [];
          }

          return [
            {
              status: entry.status,
              at: entry.at,
              source: entry.source,
              error: normalizeOptionalText(entry.error),
              code: normalizeOptionalText(entry.code),
            },
          ];
        })
      : [];

    return {
      id: parsed.id,
      type: parsed.type,
      route: parsed.route,
      status: parsed.status,
      requestedAt: parsed.requestedAt,
      updatedAt: parsed.updatedAt,
      requestedBy: normalizeOptionalText(parsed.requestedBy),
      lockId: normalizeOptionalText(parsed.lockId),
      instanceId: normalizeOptionalText(parsed.instanceId),
      lastError: normalizeOptionalText(parsed.lastError),
      code: normalizeOptionalText(parsed.code),
      history,
    };
  } catch {
    return null;
  }
}

function buildNextOperationState(existing, input, now) {
  const route = existing?.route || input.route || `/api/${input.command}`;
  const requestedAt = existing?.requestedAt || input.requestedAt || now;
  const requestedBy = normalizeOptionalText(input.userEmail) || existing?.requestedBy;
  const lockId = normalizeOptionalText(input.lockId) || existing?.lockId;
  const instanceId = normalizeOptionalText(input.instanceId) || existing?.instanceId;

  const { applyIncomingStatus, nextStatus } = resolveNextStatus(existing, input);
  const normalizedError = normalizeOptionalText(input.error);
  const normalizedCode = normalizeOptionalText(input.code);
  const history = buildNextTransitionHistory({
    existingHistory: existing?.history || [],
    applyIncomingStatus,
    nextStatus,
    source: input.source,
    now,
    error: normalizedError,
    code: normalizedCode,
  });
  const { lastError, code } = resolveLastErrorMetadata({
    existing,
    applyIncomingStatus,
    nextStatus,
    error: normalizedError,
    code: normalizedCode,
  });

  return {
    id: existing?.id || input.operationId,
    type: existing?.type || input.command,
    route,
    status: nextStatus,
    requestedAt,
    updatedAt: now,
    requestedBy,
    lockId,
    instanceId,
    lastError,
    code,
    history,
  };
}

function resolveNextStatus(existing, input) {
  const currentStatus = existing?.status || input.status;
  const applyIncomingStatus = shouldApplyStatusTransition(existing, input.status, input.source);

  return {
    applyIncomingStatus,
    nextStatus: applyIncomingStatus ? input.status : currentStatus,
  };
}

function shouldAppendTransition(history, nextStatus, source, error, code) {
  const lastTransition = history.at(-1);
  if (!lastTransition) {
    return true;
  }

  return (
    lastTransition.status !== nextStatus ||
    lastTransition.source !== source ||
    lastTransition.error !== error ||
    lastTransition.code !== code
  );
}

function buildNextTransitionHistory(input) {
  const history = [...input.existingHistory];
  if (!input.applyIncomingStatus) {
    return history;
  }

  if (!shouldAppendTransition(history, input.nextStatus, input.source, input.error, input.code)) {
    return history;
  }

  history.push({
    status: input.nextStatus,
    at: input.now,
    source: input.source,
    error: input.nextStatus === "failed" ? input.error : undefined,
    code: input.nextStatus === "failed" ? input.code : undefined,
  });

  return history;
}

function resolveLastErrorMetadata(input) {
  if (!input.applyIncomingStatus) {
    return {
      lastError: input.existing?.lastError,
      code: input.existing?.code,
    };
  }

  if (input.nextStatus !== "failed") {
    return {
      lastError: undefined,
      code: undefined,
    };
  }

  return {
    lastError: input.error || input.existing?.lastError || "Operation failed",
    code: input.code || input.existing?.code,
  };
}

async function updateOperationState(input) {
  const operationId = normalizeOptionalText(input?.operationId);
  if (!operationId) {
    return null;
  }

  const status = normalizeOptionalText(input?.status);
  if (!status || !operationStatuses.has(status)) {
    return null;
  }

  const command = normalizeOptionalText(input?.command);
  if (!command || !operationTypes.has(command)) {
    return null;
  }

  const source = normalizeOptionalText(input?.source) || "lambda";
  if (!transitionSources.has(source)) {
    return null;
  }

  const now = normalizeOptionalText(input?.timestamp) || new Date().toISOString();
  const parameterName = getOperationStateParameterName(operationId);

  const existing = parseOperationState(await getParameter(parameterName));
  const nextState = buildNextOperationState(existing, { ...input, operationId, status, source, command }, now);

  await putParameter(parameterName, JSON.stringify(nextState), "String");
  return nextState;
}

export { updateOperationState };
