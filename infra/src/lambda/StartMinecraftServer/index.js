import { createHash, randomUUID } from "node:crypto";
// AWS SDK clients and commands
// EC2 operations
import { ensureInstanceRunning, ensureInstanceStopped, getInstanceState, getPublicIp } from "./ec2.js";

import { getOperationExecutionContext, runWithOperationExecutionContext } from "./execution-context.js";
import { RetryableLifecycleError, TerminalLifecycleError, classifyLifecycleFailure } from "./failure-classification.js";
import {
  LifecycleLockConflictError,
  acquireLifecycleLock,
  assertLifecycleLockOwned,
  releaseLifecycleLock,
} from "./lifecycle-lock.js";
// Notifications
import { getSanitizedErrorMessage, sendNotification } from "./notifications.js";
import {
  claimOperationExecution,
  claimResumeIntentPointer,
  completeResumeIntentPointer,
  getOperationState,
  updateOperationState,
} from "./operation-state.js";

// SSM command execution
import {
  executeSSMCommand,
  getParameter,
  putParameter,
  reconcileRemoteCommand,
  shouldRetainLifecycleLock,
} from "./ssm.js";

import { quotePosixShellArgument } from "./posix-shell.js";
import { resolveResumeRestoreStrategy } from "./restore-contract.js";
import { buildResumeCommand } from "./resume-command.js";
import {
  LAMBDA_FINALIZATION_MARGIN_MS,
  MAX_OPERATION_RUNTIME_MS,
  READINESS_SSM_MAX_ATTEMPTS,
  READINESS_SSM_TIMEOUT_SECONDS,
  RESUME_SSM_MAX_ATTEMPTS,
  RESUME_SSM_TIMEOUT_SECONDS,
} from "./runtime-budgets.js";

// Command handlers
import { handleBackup } from "./handlers/backup.js";
import { handleRefreshBackups } from "./handlers/backups.js";
import { handleHibernate } from "./handlers/hibernate.js";
import { handleRestore } from "./handlers/restore.js";
import { handleResume } from "./handlers/resume.js";

function invocationAttemptContext(context) {
  const remainingMs =
    typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 900_000;
  return {
    requestId: context?.awsRequestId || randomUUID(),
    deadlineMs:
      Date.now() + Math.max(30_000, Math.min(MAX_OPERATION_RUNTIME_MS, remainingMs - LAMBDA_FINALIZATION_MARGIN_MS)),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Claim ownership, stale-side-effect reconciliation, and takeover must remain one auditable boundary.
async function claimExecutionAttempt(input, attempt) {
  const executionToken = `${input.operationId}:${attempt.requestId}`;
  let claim = await claimOperationExecution({ ...input, executionToken });
  if (claim.claimed || claim.reason === "terminal") return { ...claim, executionToken };
  if (claim.reason === "active") {
    throw new RetryableLifecycleError("Operation execution claim is still active", {
      code: "execution_claim_active",
      retainLifecycleLock: true,
    });
  }
  if (claim.reason !== "stale" || !claim.state?.executionToken) {
    throw new RetryableLifecycleError(`Operation execution cannot be claimed (${claim.reason})`, {
      code: `execution_claim_${claim.reason}`,
      retainLifecycleLock: true,
    });
  }

  if (claim.state.sideEffectCompletedAt) {
    await updateOperationState({
      operationId: input.operationId,
      command: input.command,
      status: "completed",
      phase: "terminal",
      expectedExecutionToken: claim.state.executionToken,
      lockId: input.lockId,
      fencingToken: input.fencingToken,
      instanceId: input.instanceId,
      userEmail: input.userEmail,
      route: input.route,
      requestedAt: input.requestedAt,
    });
    return { claimed: false, reason: "reconciled_side_effect", state: claim.state, executionToken };
  }

  if (input.command === "stop" && (await getInstanceState(input.instanceId)) === "stopped") {
    await updateOperationState({
      operationId: input.operationId,
      command: input.command,
      status: "completed",
      phase: "terminal",
      expectedExecutionToken: claim.state.executionToken,
      lockId: input.lockId,
      fencingToken: input.fencingToken,
      instanceId: input.instanceId,
      userEmail: input.userEmail,
      route: input.route,
      requestedAt: input.requestedAt,
    });
    return { claimed: false, reason: "reconciled_stopped", state: claim.state, executionToken };
  }

  const restoreMustBeDispatched =
    input.command === "resume" && ["latest", "named"].includes(claim.state.resumeIntent?.mode);
  if (
    !claim.state.remoteCommandId &&
    (input.command === "start" || (input.command === "resume" && !restoreMustBeDispatched))
  ) {
    const state = await getInstanceState(input.instanceId);
    if (state === "running") {
      const publicIp = await getPublicIp(input.instanceId);
      await runWithOperationExecutionContext(
        {
          operationId: input.operationId,
          command: input.command,
          instanceId: input.instanceId,
          executionToken: claim.state.executionToken,
          deadlineMs: attempt.deadlineMs,
        },
        async () => await waitForMinecraftReadiness(input.instanceId, publicIp)
      );
      await updateOperationState({
        operationId: input.operationId,
        command: input.command,
        status: "completed",
        phase: "terminal",
        expectedExecutionToken: claim.state.executionToken,
        lockId: input.lockId,
        fencingToken: input.fencingToken,
        instanceId: input.instanceId,
        userEmail: input.userEmail,
        route: input.route,
        requestedAt: input.requestedAt,
      });
      return { claimed: false, reason: "reconciled_game_ready", state: claim.state, executionToken };
    }
  }

  const reconciliation =
    claim.state.remoteCommandId || claim.state.remoteCommandIdentity
      ? await reconcileRemoteCommand(claim.state)
      : {
          terminal:
            input.command === "start" ||
            input.command === "resume" ||
            (input.command === "hibernate" && Boolean(claim.state.managedVolumeId)),
          success: false,
          status: "not-started",
        };
  if (!reconciliation.terminal) {
    throw new RetryableLifecycleError("Previous remote command has not reached a confirmed terminal state", {
      code: "remote_reconciliation_pending",
      retainLifecycleLock: true,
    });
  }
  const canTerminalizeRemoteSuccess =
    reconciliation.success &&
    claim.state.remoteCommandFinal === true &&
    (input.command !== "hibernate" || claim.state.hibernatePhase === "deleted");
  if (canTerminalizeRemoteSuccess) {
    await updateOperationState({
      operationId: input.operationId,
      command: input.command,
      status: "completed",
      phase: "terminal",
      expectedExecutionToken: claim.state.executionToken,
      lockId: input.lockId,
      fencingToken: input.fencingToken,
      instanceId: input.instanceId,
      userEmail: input.userEmail,
      route: input.route,
      requestedAt: input.requestedAt,
    });
    return { claimed: false, reason: "reconciled_terminal", state: claim.state, executionToken };
  }
  claim = await claimOperationExecution({
    ...input,
    executionToken,
    staleExecutionToken: claim.state.executionToken,
  });
  if (!claim.claimed) {
    throw new RetryableLifecycleError(`Stale operation claim takeover lost (${claim.reason})`, {
      code: "execution_claim_takeover_lost",
      retainLifecycleLock: true,
    });
  }
  return { ...claim, executionToken };
}

export const handler = async (event, context) => {
  console.log("=== LAMBDA INVOKED ===");
  const attempt = invocationAttemptContext(context);

  // Route to appropriate handler based on invocation type
  if (event.invocationType === "api") {
    return handleApiInvocation(event, attempt);
  }
  if (event.invocationType === "serviceStatus") {
    return handleServiceStatusInvocation(event);
  }
  if (event.invocationType === "scheduledBackup") {
    return handleScheduledBackupInvocation(event, attempt);
  }
  if (event.invocationType === "backupFreshnessCheck") {
    return handleBackupFreshnessCheck(event);
  }
  if (event.invocationType === "emailCommand") {
    return handleSanitizedEmailCommandInvocation(event, attempt);
  }

  return { statusCode: 400, body: "Unsupported invocation payload." };
};

/**
 * Handle API invocation for async commands
 */
function validateApiInvocation(event) {
  const lifecycleCommands = new Set(["start", "stop", "backup", "restore", "hibernate", "resume"]);
  const managedInstanceId = process.env.INSTANCE_ID?.trim();
  if (
    !managedInstanceId ||
    typeof event?.instanceId !== "string" ||
    event.instanceId !== managedInstanceId ||
    typeof event?.userEmail !== "string" ||
    typeof event?.command !== "string" ||
    !Array.isArray(event?.args ?? []) ||
    !(event?.args ?? []).every((value) => typeof value === "string")
  ) {
    return false;
  }
  if (event.command === "refreshBackups") return true;
  const agentBackup = event.command === "backup" && event.operationRoute === "/api/agent/runtime/backups";
  if (event.operationRoute !== undefined && !agentBackup) {
    return false;
  }
  if (
    agentBackup
      ? event.requireAlreadyRunning !== true ||
        event.requireServiceActive !== true ||
        event.retainLockForAgentEffect !== true ||
        event.agentTwoPhase !== true
      : event.requireAlreadyRunning !== undefined ||
        event.requireServiceActive !== undefined ||
        event.retainLockForAgentEffect !== undefined
  ) {
    return false;
  }
  return (
    lifecycleCommands.has(event.command) &&
    typeof event.operationId === "string" &&
    event.operationId.length > 0 &&
    event.operationId.length <= 256 &&
    typeof event.lockId === "string" &&
    (event.fencingToken === undefined || Number.isSafeInteger(event.fencingToken))
  );
}

async function handleServiceStatusInvocation(event) {
  const managedInstanceId = process.env.INSTANCE_ID?.trim();
  if (!managedInstanceId || event?.instanceId !== managedInstanceId) {
    return { statusCode: 400, body: "Unsupported service-status payload." };
  }

  const instanceState = await getInstanceState(managedInstanceId);
  const instanceRunning = instanceState === "running";
  let serviceActive = false;
  if (instanceRunning) {
    serviceActive = await isMinecraftServiceActive(managedInstanceId);
  }

  // This response is an intentionally small allowlisted projection. Never
  // return the SSM command ID, stdout, stderr, or the command error itself.
  return {
    statusCode: 200,
    body: JSON.stringify({ instanceState, instanceRunning, serviceActive }),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep retry classification, durable terminal persistence, and lock finalization auditable in one orchestrator.
async function handleApiInvocation(event, attempt) {
  const { instanceId, userEmail, command, args, lockId, fencingToken, operationId } = event;
  const operationRoute = event.operationRoute ?? `/api/${command}`;
  const retainLockForAgentEffect =
    command === "backup" &&
    operationRoute === "/api/agent/runtime/backups" &&
    event.requireAlreadyRunning === true &&
    event.requireServiceActive === true &&
    event.retainLockForAgentEffect === true;
  const isLifecycleCommand = command !== "refreshBackups";
  console.log(`[API] Authorized async command '${command}' received`);

  if (!validateApiInvocation(event)) {
    console.error("[API] Invalid API payload; payload omitted");
    return { statusCode: 400, body: "Invalid payload" };
  }

  const envResult = validateEnvironment();
  if (envResult.error) {
    await persistOperationStateSafely({
      operationId,
      command,
      status: "failed",
      userEmail,
      instanceId,
      lockId,
      error: "Configuration error",
      code: "configuration_error",
    });
    if (lockId && command) await releaseServerActionLockIfOwned(lockId, fencingToken, command, userEmail, operationId);

    return envResult.error;
  }

  if (!isLifecycleCommand) {
    await executeApiCommand(command, instanceId, userEmail, "", args, event.restoreMode);
    return { statusCode: 202, body: "Backup refresh accepted" };
  }

  const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase();
  let executionError;
  let retainLock = false;
  let executionToken;
  const lifecycleFencingToken = fencingToken;

  try {
    if (isLifecycleCommand) {
      if (!lockId) throw new Error(`Lifecycle command '${command}' requires a lockId`);
      if (Number.isSafeInteger(fencingToken)) {
        await assertLifecycleLockOwned(lockId, fencingToken, command);
      } else {
        throw new LifecycleLockConflictError(null);
      }
      const claim = await claimExecutionAttempt(
        {
          operationId,
          command,
          lockId,
          fencingToken: lifecycleFencingToken,
          instanceId,
          userEmail,
          route: operationRoute,
        },
        attempt
      );
      executionToken = claim.executionToken;
      if (!claim.claimed) {
        console.log(`[API] Duplicate invocation skipped (${claim.reason})`);
        retainLock = retainLockForAgentEffect && claim.state?.status === "completed";
        return { statusCode: 202, body: `Async command '${command}' already recorded` };
      }
    }

    await runWithOperationExecutionContext(
      {
        operationId,
        command,
        instanceId,
        executionToken,
        deadlineMs: attempt.deadlineMs,
        lockId,
        fencingToken: lifecycleFencingToken,
      },
      async () =>
        await executeApiCommand(command, instanceId, userEmail, notificationEmail, args, event.restoreMode, {
          ...(retainLockForAgentEffect
            ? { requireAlreadyRunning: true, requireServiceActive: true, strictAgentBackup: true, agentTwoPhase: true }
            : {}),
        })
    );

    try {
      await updateOperationState({
        operationId,
        command,
        status: "completed",
        phase: "terminal",
        userEmail,
        instanceId,
        lockId,
        fencingToken: lifecycleFencingToken,
        expectedExecutionToken: executionToken,
      });
      if (retainLockForAgentEffect) retainLock = true;
    } catch (error) {
      retainLock = true;
      throw new RetryableLifecycleError("Terminal operation state persistence failed", {
        code: "terminal_state_persist_failed",
        cause: error,
        retainLifecycleLock: true,
      });
    }
  } catch (error) {
    executionError = error;
    console.error(`[API] Command '${command}' failed`);
    console.error("LIFECYCLE_OPERATION_FAILED", JSON.stringify({ command, source: "api" }));

    const classification = classifyLifecycleFailure(error);
    if (classification.retryable) {
      retainLock = true;
      throw error;
    }
    try {
      await updateOperationState({
        operationId,
        command,
        status: "failed",
        phase: "terminal",
        userEmail,
        instanceId,
        lockId,
        fencingToken: lifecycleFencingToken,
        expectedExecutionToken: executionToken,
        error: getSanitizedErrorMessage(command),
        code: classification.code,
      });
      if (command === "resume") await failResumeIntentPointerIfOwned(operationId, executionToken);
    } catch (persistenceError) {
      retainLock = true;
      throw new RetryableLifecycleError("Terminal failure state persistence failed", {
        code: "terminal_state_persist_failed",
        cause: persistenceError,
        retainLifecycleLock: true,
      });
    }
  } finally {
    if (isLifecycleCommand) {
      if (retainLock || shouldRetainLifecycleLock(executionError)) {
        console.error(`[API] Retaining lifecycle lock for unresolved remote command in '${command}'`);
      } else {
        await releaseServerActionLockIfOwned(lockId, lifecycleFencingToken, command, userEmail, operationId);
      }
    }
  }

  return { statusCode: 202, body: `Async command '${command}' accepted` };
}

const SCHEDULED_BACKUP_OWNER = "scheduled-backup@mc-aws.internal";
const LAST_SCHEDULED_BACKUP_SUCCESS_PARAMETER = "/minecraft/last-scheduled-backup-success";
const SCHEDULED_BACKUP_BASELINE_PARAMETER = "/minecraft/scheduled-backup-enabled-at";

function scheduledEventTime(event) {
  const candidate = typeof event.scheduledAt === "string" ? event.scheduledAt : "";
  return candidate && !Number.isNaN(Date.parse(candidate))
    ? new Date(candidate).toISOString()
    : new Date().toISOString();
}

function createScheduledBackupOperationId(event) {
  const identity = event.eventId || event.id || scheduledEventTime(event);
  return `scheduled-backup-${createHash("sha256").update(String(identity)).digest("hex").slice(0, 40)}`;
}

function logScheduledBackupOutcome(outcome, reason, _operationId, scheduledAt) {
  console.log(
    "SCHEDULED_BACKUP_OUTCOME",
    JSON.stringify({ outcome, reason, scheduledAt, observedAt: new Date().toISOString() })
  );
}

function emitCountMetric(name, value) {
  const namespace = process.env.MC_METRIC_NAMESPACE?.trim() || "McAws/Minecraft";
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: "Count" }] }],
      },
      [name]: value,
    })
  );
}

async function completeScheduledBackupOperation(input) {
  await updateOperationState({
    operationId: input.operationId,
    command: "backup",
    status: "completed",
    phase: "terminal",
    userEmail: SCHEDULED_BACKUP_OWNER,
    instanceId: input.instanceId,
    lockId: input.lock?.lockId,
    fencingToken: input.lock?.fencingToken,
    expectedExecutionToken: input.executionToken,
    route: "/scheduled/backup",
    requestedAt: input.scheduledAt,
  });
}

// EventBridge enters through the lifecycle Lambda so scheduled backups use the
// same global lock, fencing token, durable state, idempotency, and concurrency=1 boundary.
async function isMinecraftServiceActive(instanceId) {
  const output = await executeSSMCommand(
    instanceId,
    ["if systemctl is-active --quiet minecraft.service; then echo active; else echo inactive; fi"],
    { maxAttempts: 15, timeoutSeconds: 30 }
  );
  return output.trim() === "active";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Locking, claim reconciliation, safe skips, and retry signaling remain visibly ordered as one transaction.
async function handleScheduledBackupInvocation(event, attempt) {
  const instanceId = process.env.INSTANCE_ID;
  if (!instanceId) throw new Error("INSTANCE_ID is required for scheduled backups");

  const operationId = createScheduledBackupOperationId(event);
  const scheduledAt = scheduledEventTime(event);
  const existing = await getOperationState(operationId);
  if (isTerminalOperation(existing)) {
    logScheduledBackupOutcome("skip", `duplicate_${existing.status}`, operationId, scheduledAt);
    return { statusCode: 200, body: "Scheduled backup delivery already recorded." };
  }

  if (!existing) {
    await updateOperationState({
      operationId,
      command: "backup",
      status: "accepted",
      phase: "dispatching",
      userEmail: SCHEDULED_BACKUP_OWNER,
      instanceId,
      route: "/scheduled/backup",
      requestedAt: scheduledAt,
    });
  }

  let executionToken;
  let lock;
  let claimed = false;
  let executionError;
  let retainLock = false;
  try {
    // Existence is sufficient; GetParameter deliberately does not decrypt or log the credential.
    if (!(await getParameter("/minecraft/gdrive-token"))) {
      await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt });
      logScheduledBackupOutcome("skip", "drive_credentials_absent", operationId, scheduledAt);
      return { statusCode: 200, body: "Scheduled backup skipped because Drive is not connected." };
    }

    const initialState = await getInstanceState(instanceId);
    if (initialState !== "running") {
      await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt });
      logScheduledBackupOutcome("skip", `instance_${initialState}`, operationId, scheduledAt);
      return { statusCode: 200, body: "Scheduled backup skipped because the instance is not running." };
    }

    try {
      if (existing?.phase === "executing" && existing.lockId && Number.isSafeInteger(existing.fencingToken)) {
        lock = await assertLifecycleLockOwned(existing.lockId, existing.fencingToken, "backup");
      } else {
        lock = await acquireLifecycleLock("backup", SCHEDULED_BACKUP_OWNER);
      }
    } catch (error) {
      if (!(error instanceof LifecycleLockConflictError)) throw error;
      await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt });
      logScheduledBackupOutcome("skip", "lifecycle_operation_in_progress", operationId, scheduledAt);
      return { statusCode: 200, body: "Scheduled backup skipped because another lifecycle action is running." };
    }

    if (!(await isMinecraftServiceActive(instanceId))) {
      await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt, lock });
      logScheduledBackupOutcome("skip", "minecraft_service_inactive", operationId, scheduledAt);
      return { statusCode: 200, body: "Scheduled backup skipped because Minecraft is inactive." };
    }

    const claim = await claimExecutionAttempt(
      {
        operationId,
        command: "backup",
        userEmail: SCHEDULED_BACKUP_OWNER,
        instanceId,
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        route: "/scheduled/backup",
        requestedAt: scheduledAt,
      },
      attempt
    );
    executionToken = claim.executionToken;
    if (!claim.claimed) {
      logScheduledBackupOutcome("skip", `execution_${claim.reason}`, operationId, scheduledAt);
      return { statusCode: 200, body: "Scheduled backup execution was already claimed." };
    }
    claimed = true;

    try {
      // This mode rechecks state after lock acquisition and never calls StartInstances.
      await runWithOperationExecutionContext(
        {
          operationId,
          command: "backup",
          instanceId,
          executionToken,
          deadlineMs: attempt.deadlineMs,
          lockId: lock.lockId,
          fencingToken: lock.fencingToken,
        },
        async () =>
          await handleBackup(instanceId, [operationId], "", {
            requireAlreadyRunning: true,
            requireServiceActive: true,
          })
      );
    } catch (error) {
      if (!["ScheduledBackupInstanceNotRunning", "ScheduledBackupHostIncompatible"].includes(error?.name)) throw error;
      await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt, lock, executionToken });
      const reason =
        error.name === "ScheduledBackupHostIncompatible" ? "host_runtime_incompatible" : "instance_no_longer_running";
      logScheduledBackupOutcome("skip", reason, operationId, scheduledAt);
      return { statusCode: 200, body: `Scheduled backup skipped (${reason}).` };
    }

    const completedAt = new Date().toISOString();
    await putParameter(LAST_SCHEDULED_BACKUP_SUCCESS_PARAMETER, completedAt, "String");
    await completeScheduledBackupOperation({ operationId, instanceId, scheduledAt, lock, executionToken });
    logScheduledBackupOutcome("success", "backup_completed", operationId, scheduledAt);
    return { statusCode: 200, body: "Scheduled backup completed." };
  } catch (error) {
    executionError = error;
    console.error("LIFECYCLE_OPERATION_FAILED", JSON.stringify({ command: "backup", source: "schedule" }));
    logScheduledBackupOutcome("failure", "backup_execution_failed", operationId, scheduledAt);
    emitCountMetric("ScheduledBackupFailure", 1);
    const classification = classifyLifecycleFailure(error);
    if (classification.retryable) {
      retainLock = true;
      throw error;
    }
    try {
      await updateOperationState({
        operationId,
        command: "backup",
        status: "failed",
        phase: "terminal",
        userEmail: SCHEDULED_BACKUP_OWNER,
        instanceId,
        lockId: lock?.lockId,
        fencingToken: lock?.fencingToken,
        expectedExecutionToken: claimed ? executionToken : undefined,
        route: "/scheduled/backup",
        requestedAt: scheduledAt,
        error: getSanitizedErrorMessage("backup"),
        code: classification.code,
      });
    } catch (persistenceError) {
      console.error("[SCHEDULE] Terminal operation state persistence failed; retaining lifecycle lock");
      retainLock = true;
      throw new RetryableLifecycleError("Scheduled terminal state persistence failed", {
        cause: persistenceError,
        code: "terminal_state_persist_failed",
        retainLifecycleLock: true,
      });
    }
    return { statusCode: 200, body: "Scheduled backup failed permanently." };
  } finally {
    if (lock && !retainLock && !shouldRetainLifecycleLock(executionError)) {
      await releaseServerActionLockIfOwned(
        lock.lockId,
        lock.fencingToken,
        "backup",
        SCHEDULED_BACKUP_OWNER,
        operationId
      );
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Baseline creation and stale evaluation intentionally fail closed in one monitor transaction.
async function handleBackupFreshnessCheck(event) {
  const observedAt = scheduledEventTime(event);
  let reference = await getParameter(LAST_SCHEDULED_BACKUP_SUCCESS_PARAMETER);
  if (!reference || Number.isNaN(Date.parse(reference))) {
    reference = await getParameter(SCHEDULED_BACKUP_BASELINE_PARAMETER);
  }
  if (!reference || Number.isNaN(Date.parse(reference))) {
    try {
      await putParameter(SCHEDULED_BACKUP_BASELINE_PARAMETER, observedAt, "String", false);
      reference = observedAt;
    } catch (error) {
      if (error?.name !== "ParameterAlreadyExists") throw error;
      reference = await getParameter(SCHEDULED_BACKUP_BASELINE_PARAMETER);
    }
  }
  if (!reference || Number.isNaN(Date.parse(reference))) {
    throw new Error("Scheduled backup freshness baseline could not be established");
  }

  const staleAfterHours = Number(process.env.MC_BACKUP_STALE_AFTER_HOURS || "192");
  if (!Number.isSafeInteger(staleAfterHours) || staleAfterHours < 25) {
    throw new Error("MC_BACKUP_STALE_AFTER_HOURS is invalid");
  }
  const ageHours = Math.max(0, (Date.parse(observedAt) - Date.parse(reference)) / (60 * 60 * 1000));
  const stale = ageHours >= staleAfterHours;
  console.log(
    "SCHEDULED_BACKUP_FRESHNESS",
    JSON.stringify({ stale, ageHours: Math.round(ageHours * 10) / 10, staleAfterHours, observedAt })
  );
  emitCountMetric("ScheduledBackupStale", stale ? 1 : 0);
  return { statusCode: 200, body: stale ? "Scheduled backup is stale." : "Scheduled backup is fresh." };
}

async function persistOperationStateSafely(input) {
  try {
    await updateOperationState(input);
  } catch {
    console.error("[API] Failed to persist operation state");
  }
}

async function releaseServerActionLockIfOwned(lockId, fencingToken, command, ownerEmail, operationId) {
  if (!lockId) {
    console.warn(`[API] No lockId provided for '${command}', skipping lock release`);
    return;
  }

  try {
    let releaseOptions;
    const operation = operationId ? await getOperationState(operationId).catch(() => null) : null;
    if (operation?.route === "/api/agent/runtime/backups") {
      if (
        operation.id !== operationId ||
        !["completed", "failed"].includes(operation.status) ||
        operation.phase !== "terminal" ||
        operation.lockId !== lockId ||
        operation.fencingToken !== fencingToken ||
        operation.requestedBy?.trim().toLowerCase() !== ownerEmail.trim().toLowerCase() ||
        !Number.isSafeInteger(operation.lockLeaseGeneration) ||
        !operation.dispatchOwnerId
      ) {
        console.warn(`[API] Agent fence cleanup proof is not current for '${command}', skipping lock release`);
        return;
      }
      const current = await assertLifecycleLockOwned(lockId, fencingToken, command);
      if (
        !current?.agentFenceActive ||
        current.leaseGeneration !== operation.lockLeaseGeneration ||
        current.operationId !== operation.id ||
        current.operationOwnerId !== operation.dispatchOwnerId ||
        current.ownerEmail.trim().toLowerCase() !== ownerEmail.trim().toLowerCase()
      ) {
        console.warn(`[API] Agent fence identity changed for '${command}', skipping lock release`);
        return;
      }
      releaseOptions = {
        expectedLeaseGeneration: current.leaseGeneration,
        requireAgentFenceActive: true,
        operationId: operation.id,
        operationOwnerId: operation.dispatchOwnerId,
      };
    }
    const released = releaseOptions
      ? await releaseLifecycleLock(lockId, fencingToken, command, ownerEmail, releaseOptions)
      : await releaseLifecycleLock(lockId, fencingToken, command, ownerEmail);
    console.log(`[API] Lifecycle lock release for '${command}': ${released ? "released" : "not-owned"}`);
  } catch {
    // Do not fail the entire invocation because lock cleanup failed.
    console.error("[API] Failed to conditionally release server-action lock");
  }
}

/**
 * Execute API command based on command type
 */
async function executeApiCommand(
  command,
  instanceId,
  userEmail,
  notificationEmail,
  args,
  restoreMode,
  backupOptions = {}
) {
  const handlers = {
    start: () => handleStartCommand(instanceId, userEmail, notificationEmail),
    stop: () => handleStopCommand(instanceId),
    resume: () => handleResumeCommand(instanceId, userEmail, notificationEmail, args, restoreMode),
    backup: () => handleBackup(instanceId, args || [], notificationEmail, backupOptions),
    restore: () => handleRestore(instanceId, args || [], notificationEmail),
    hibernate: () => handleHibernate(instanceId, args || [], notificationEmail),
    refreshBackups: () => handleRefreshBackups(instanceId),
  };

  const handler = handlers[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }

  await handler();
}

const EMAIL_COMMAND_OWNER = "email-command@mc-aws.internal";
const EMAIL_COMMANDS = new Set(["start", "backup", "restore", "hibernate", "resume"]);

function validateSanitizedEmailCommand(event) {
  const argumentsValid =
    Array.isArray(event?.args) &&
    (event.command === "backup" || event.command === "restore"
      ? event.args.length <= 1 &&
        event.args.every((value) => typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value))
      : event.args.length === 0);
  return (
    event?.invocationType === "emailCommand" &&
    typeof event.operationId === "string" &&
    /^email-[a-f0-9]{40}$/.test(event.operationId) &&
    EMAIL_COMMANDS.has(event.command) &&
    argumentsValid &&
    (event.requestedAt === undefined ||
      (typeof event.requestedAt === "string" && !Number.isNaN(Date.parse(event.requestedAt)))) &&
    !("sender" in event) &&
    !("senderEmail" in event) &&
    !("subject" in event) &&
    !("body" in event) &&
    !("content" in event) &&
    !("Records" in event)
  );
}

async function handleSanitizedEmailCommandInvocation(event, attempt) {
  if (!validateSanitizedEmailCommand(event)) {
    console.error("[EMAIL] Invalid sanitized command envelope; payload omitted");
    return { statusCode: 400, body: "Invalid email command envelope." };
  }
  const envResult = validateEnvironment({ requireInboundCommands: true });
  if (envResult.error) return envResult.error;
  return executeEmailLifecycleCommand({
    parsedCommand: { command: event.command, args: event.args },
    instanceId: envResult.instanceId,
    senderEmail: EMAIL_COMMAND_OWNER,
    operationId: event.operationId,
    requestedAt: event.requestedAt,
    attempt,
  });
}

function isTerminalOperation(operation) {
  return operation?.status === "completed" || operation?.status === "failed";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep durable state, lock ownership, and finalization visibly ordered.
async function executeEmailLifecycleCommand(input) {
  const { parsedCommand, instanceId, senderEmail } = input;
  const command = parsedCommand.command;
  const operationId = input.operationId;
  const requestedAt = input.requestedAt && !Number.isNaN(Date.parse(input.requestedAt)) ? input.requestedAt : undefined;
  const existing = await getOperationState(operationId);
  if (isTerminalOperation(existing)) {
    console.log(`[EMAIL] Duplicate delivery skipped (${existing.status})`);
    return { statusCode: 200, body: `Command already recorded as ${existing.status}.` };
  }

  if (!existing) {
    await updateOperationState({
      operationId,
      command,
      status: "accepted",
      phase: "dispatching",
      userEmail: senderEmail,
      instanceId,
      route: `/email/${command}`,
      requestedAt,
    });
  }

  let lock;
  let executionError;
  let retainLock = false;
  let executionToken;
  try {
    if (existing?.phase === "executing" && existing.lockId && Number.isSafeInteger(existing.fencingToken)) {
      lock = await assertLifecycleLockOwned(existing.lockId, existing.fencingToken, command);
    } else {
      lock = await acquireLifecycleLock(command, senderEmail);
    }
    const claim = await claimExecutionAttempt(
      {
        operationId,
        command,
        userEmail: senderEmail,
        instanceId,
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        route: `/email/${command}`,
        requestedAt,
      },
      input.attempt
    );
    executionToken = claim.executionToken;
    if (!claim.claimed) {
      return { statusCode: 200, body: `Command already recorded as ${claim.state?.status || claim.reason}.` };
    }

    const response = await runWithOperationExecutionContext(
      {
        operationId,
        command,
        instanceId,
        executionToken,
        deadlineMs: input.attempt.deadlineMs,
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
      },
      async () => await executeCommand(parsedCommand, instanceId, senderEmail)
    );
    try {
      await updateOperationState({
        operationId,
        command,
        status: "completed",
        phase: "terminal",
        userEmail: senderEmail,
        instanceId,
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        expectedExecutionToken: executionToken,
        route: `/email/${command}`,
        requestedAt,
      });
    } catch (error) {
      retainLock = true;
      throw new RetryableLifecycleError("Email terminal state persistence failed", {
        cause: error,
        code: "terminal_state_persist_failed",
        retainLifecycleLock: true,
      });
    }
    return response;
  } catch (error) {
    executionError = error;
    const conflict = error instanceof LifecycleLockConflictError;
    if (!conflict) {
      console.error("LIFECYCLE_OPERATION_FAILED", JSON.stringify({ command, source: "email" }));
    }
    const classification = classifyLifecycleFailure(error);
    if (!conflict && classification.retryable) {
      retainLock = true;
      throw error;
    }
    try {
      await updateOperationState({
        operationId,
        command,
        status: "failed",
        phase: "terminal",
        userEmail: senderEmail,
        instanceId,
        lockId: lock?.lockId,
        fencingToken: lock?.fencingToken,
        route: `/email/${command}`,
        requestedAt,
        expectedExecutionToken: lock ? executionToken : undefined,
        error: getSanitizedErrorMessage(command),
        code: conflict ? "operation_conflict" : classification.code,
      });
      if (command === "resume") await failResumeIntentPointerIfOwned(operationId, executionToken);
    } catch (persistenceError) {
      console.error("[EMAIL] Terminal operation state persistence failed; retaining lifecycle lock");
      retainLock = true;
      throw new RetryableLifecycleError("Email terminal failure persistence failed", {
        cause: persistenceError,
        code: "terminal_state_persist_failed",
        retainLifecycleLock: true,
      });
    }
    return {
      statusCode: conflict ? 409 : 500,
      body: conflict ? "Another lifecycle operation is in progress." : getSanitizedErrorMessage(command),
    };
  } finally {
    if (lock && !retainLock && !shouldRetainLifecycleLock(executionError)) {
      await releaseServerActionLockIfOwned(lock.lockId, lock.fencingToken, command, senderEmail, operationId);
    }
  }
}

function validateEnvironment(options = {}) {
  const { requireInboundCommands = false } = options;
  const instanceId = process.env.INSTANCE_ID;

  if (!instanceId) {
    console.error("Missing required environment variable: INSTANCE_ID.");
    return { error: { statusCode: 500, body: "Configuration error." } };
  }

  if (requireInboundCommands && process.env.SES_INBOUND_COMMANDS_ENABLED !== "true") {
    console.error("Email command requested but SES_INBOUND_COMMANDS_ENABLED is not true.");
    return {
      error: {
        statusCode: 503,
        body: "Email commands are disabled. Enable and configure inbound SES commands before using this endpoint.",
      },
    };
  }

  return { instanceId };
}

async function executeCommand(parsedCommand, instanceId, senderEmail) {
  const notificationEmail = process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;

  try {
    switch (parsedCommand.command) {
      case "start":
        return await handleStartCommand(instanceId, senderEmail, notificationEmail);
      case "backup": {
        const backupResult = await handleBackup(instanceId, parsedCommand.args, notificationEmail);
        return { statusCode: 200, body: typeof backupResult === "string" ? backupResult : backupResult.message };
      }
      case "restore":
        return {
          statusCode: 200,
          body: await handleRestore(instanceId, parsedCommand.args, notificationEmail),
        };
      case "hibernate":
        return { statusCode: 200, body: await handleHibernate(instanceId, parsedCommand.args, notificationEmail) };
      case "resume":
        return await handleResumeCommand(instanceId, senderEmail, notificationEmail, parsedCommand.args);
      default:
        throw new TerminalLifecycleError(`Unknown command: ${parsedCommand.command}`, { code: "unsupported_command" });
    }
  } catch (error) {
    console.error("ERROR executing command.");
    if (notificationEmail) {
      await sendNotification(
        notificationEmail,
        "Minecraft Command Failed",
        getSanitizedErrorMessage(parsedCommand.command)
      ).catch(() => console.error("WARNING: Failed to send command failure notification"));
    }
    throw error;
  }
}

function buildReadinessCommand(publicIp) {
  const dnsMode = process.env.MC_DNS_MODE || "raw_ip";
  const hostname = process.env.MC_DNS_HOSTNAME || "";
  const currentCommand = ["/usr/local/bin/mc-wait-ready.sh", dnsMode, hostname, publicIp]
    .map(quotePosixShellArgument)
    .join(" ");
  const fallback =
    'deadline=$((SECONDS+70)); while (( SECONDS < deadline )); do if [[ -f /var/lib/mc-aws/bootstrap-complete ]] && systemctl is-active --quiet minecraft.service && /usr/local/bin/mcstatus localhost status >/dev/null 2>&1; then printf \'{"ready":true,"dnsReady":false,"compatibilityFallback":true}\\n\'; exit 0; fi; sleep 5; done; echo \'ERROR: legacy-host Minecraft readiness timed out\' >&2; exit 1';
  return `if [[ -x /usr/local/bin/mc-wait-ready.sh ]]; then exec ${currentCommand}; else ${fallback}; fi`;
}

async function waitForMinecraftReadiness(instanceId, publicIp) {
  return await executeSSMCommand(instanceId, [buildReadinessCommand(publicIp)], {
    maxAttempts: READINESS_SSM_MAX_ATTEMPTS,
    timeoutSeconds: READINESS_SSM_TIMEOUT_SECONDS,
    step: "readiness",
    finalRemoteStep: true,
  });
}

async function handleStartCommand(instanceId, senderEmail, notificationEmail) {
  console.log("Starting managed instance for authorized request");

  // Store sender email in SSM for EC2 to include in consolidated notification
  if (senderEmail) {
    await putParameter("/minecraft/startup-triggered-by", senderEmail, "String");
  }

  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);
  await waitForMinecraftReadiness(instanceId, publicIp);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Server Started", `Server ready at IP: ${publicIp}`);
  }

  return { statusCode: 200, body: `Instance started at IP: ${publicIp}` };
}

async function handleStopCommand(instanceId) {
  console.log("Stopping managed instance for authorized request");
  await ensureInstanceStopped(instanceId);
  return { statusCode: 200, body: "Managed instance stopped" };
}

async function handleResumeCommand(instanceId, senderEmail, notificationEmail, args, restoreMode) {
  console.log("Resuming managed instance for authorized request");

  // Store sender email in SSM for EC2 to include in consolidated notification
  if (senderEmail) {
    await putParameter("/minecraft/startup-triggered-by", senderEmail, "String");
  }

  const restoreStrategy = resolveResumeRestoreStrategy({
    args,
    restoreMode,
  });

  const executionContext = getOperationExecutionContext();
  if (!executionContext?.operationId) throw new Error("Resume requires durable operation ownership");
  await ensureResumeIntent(executionContext.operationId, executionContext.executionToken, restoreStrategy);

  console.log(`[RESUME] Restore strategy selected: ${restoreStrategy.mode}`);

  await handleResume(instanceId);
  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);
  const resumeCommand = buildResumeCommand(
    restoreStrategy,
    executionContext.operationId,
    executionContext.executionToken
  );
  await executeSSMCommand(instanceId, [resumeCommand], {
    maxAttempts: RESUME_SSM_MAX_ATTEMPTS,
    timeoutSeconds: RESUME_SSM_TIMEOUT_SECONDS,
    step: "resume-restore",
    finalRemoteStep: false,
  });
  await waitForMinecraftReadiness(instanceId, publicIp);
  await completeResumeIntentPointer({
    operationId: executionContext.operationId,
    ownerToken: executionContext.executionToken,
    status: "completed",
  });

  let restoreMsg = "\n\nFresh world requested (no backup restore).";
  if (restoreStrategy.mode === "latest") {
    restoreMsg = "\n\nRestored from latest backup.";
  }

  if (restoreStrategy.mode === "named") {
    restoreMsg = `\n\nRestored from backup: ${restoreStrategy.backupArchiveName}`;
  }

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Server Resumed", `Resumed at IP: ${publicIp}${restoreMsg}`);
  }

  return { statusCode: 200, body: `Instance resumed at IP: ${publicIp}${restoreMsg}` };
}

async function failResumeIntentPointerIfOwned(operationId, ownerToken) {
  if (!operationId || !ownerToken) return;
  try {
    await completeResumeIntentPointer({ operationId, ownerToken, status: "failed" });
  } catch (error) {
    if (error instanceof Error && error.message === "Resume intent successor owns the pointer") return;
    throw error;
  }
}

// Resume coordination is part of the operation-state DynamoDB record. This
// avoids using a mutable SSM pointer as a lock and lets conditional versioned
// updates reject delayed work without deleting a successor's evidence.
async function ensureResumeIntent(operationId, ownerToken, strategy) {
  const existing = await getOperationState(operationId);
  if (!existing || existing.type !== "resume" || isTerminalOperation(existing)) {
    throw new RetryableLifecycleError("Resume operation authority is unavailable or terminal", {
      code: "resume_operation_authority_unavailable",
      retainLifecycleLock: true,
    });
  }
  const resumeIntent = {
    mode: strategy.mode,
    backupArchiveName: strategy.backupArchiveName ?? null,
  };
  if (
    existing.resumeIntent &&
    (existing.resumeIntent.mode !== resumeIntent.mode ||
      existing.resumeIntent.backupArchiveName !== resumeIntent.backupArchiveName)
  ) {
    throw new RetryableLifecycleError("Resume operation intent changed", {
      code: "resume_operation_intent_conflict",
      retainLifecycleLock: true,
    });
  }
  const updated = await updateOperationState({
    operationId,
    command: "resume",
    status: existing.status === "accepted" ? "running" : existing.status,
    source: "lambda",
    phase: "executing",
    expectedExecutionToken: existing.executionToken,
    resumeIntent,
  });
  await claimResumeIntentPointer({
    operationId,
    ownerToken,
    operationVersion: Number.isSafeInteger(updated?.version) ? updated.version : existing.version,
    intent: resumeIntent,
  });
  return updated;
}
