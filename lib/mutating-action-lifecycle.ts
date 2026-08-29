import { persistDurableOperationStateTransition } from "@/lib/durable-operation-state";
import type { OperationPhase } from "@/lib/durable-operation-state";
import {
  type MutatingActionExecutionFailure,
  type MutatingActionExecutionResult,
  type MutatingActionRequestContext,
  createMutatingActionFailure,
  createMutatingActionSuccess,
} from "@/lib/mutating-action-contract";
import type { ServerActionLock } from "@/lib/server-action-lock";
import type { OperationStatus } from "@/lib/types";

export const mutatingActionLifecycleStages = ["auth", "throttle", "lock", "invoke", "finalize"] as const;

export type MutatingActionLifecycleStage = (typeof mutatingActionLifecycleStages)[number];

export type MutatingActionThrottleDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      httpStatus?: number;
      code?: string;
      message?: string;
      cause?: unknown;
    };

export interface MutatingActionLifecycleErrorInput<TUser> {
  stage: Exclude<MutatingActionLifecycleStage, "finalize">;
  context: MutatingActionRequestContext;
  user?: TUser;
  lock?: ServerActionLock;
  error: unknown;
}

export interface MutatingActionFinalizeInput<TUser, TInvokeData> {
  context: MutatingActionRequestContext;
  user?: TUser;
  lock?: ServerActionLock;
  invokeResult?: TInvokeData;
  execution: MutatingActionExecutionResult<TInvokeData>;
}

export interface MutatingActionLifecycleOptions<TUser, TInvokeData, TFinalizeData> {
  context: MutatingActionRequestContext;
  authenticate: (context: MutatingActionRequestContext) => Promise<TUser>;
  throttle: (input: { context: MutatingActionRequestContext; user: TUser }) => Promise<MutatingActionThrottleDecision>;
  acquireLock: (input: { context: MutatingActionRequestContext; user: TUser }) => Promise<ServerActionLock>;
  invoke: (input: {
    context: MutatingActionRequestContext;
    user: TUser;
    lock: ServerActionLock;
  }) => Promise<TInvokeData>;
  finalize: (input: MutatingActionFinalizeInput<TUser, TInvokeData>) => Promise<TFinalizeData>;
  mapInvokeResult?: (input: {
    context: MutatingActionRequestContext;
    user: TUser;
    lock: ServerActionLock;
    invokeResult: TInvokeData;
  }) => MutatingActionExecutionResult<TInvokeData>;
  mapError?: (input: MutatingActionLifecycleErrorInput<TUser>) => MutatingActionExecutionFailure;
}

export interface MutatingActionLifecycleOutcome<TUser, TInvokeData, TFinalizeData> {
  completedStage: MutatingActionLifecycleStage;
  context: MutatingActionRequestContext;
  user?: TUser;
  lock?: ServerActionLock;
  invokeResult?: TInvokeData;
  finalizeResult?: TFinalizeData;
  finalizeError?: unknown;
  execution: MutatingActionExecutionResult<TInvokeData>;
}

function getUserEmail(user: unknown): string | undefined {
  if (!user || typeof user !== "object") {
    return undefined;
  }

  const email = (user as { email?: unknown }).email;
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

function getInstanceIdFromInvokeResult(invokeResult: unknown): string | undefined {
  if (!invokeResult || typeof invokeResult !== "object") {
    return undefined;
  }

  const instanceId = (invokeResult as { instanceId?: unknown }).instanceId;
  return typeof instanceId === "string" && instanceId.length > 0 ? instanceId : undefined;
}

async function persistLifecycleOperationState(input: {
  context: MutatingActionRequestContext;
  status: OperationStatus;
  userEmail?: string;
  lockId?: string;
  fencingToken?: number;
  instanceId?: string;
  error?: string;
  code?: string;
  phase?: OperationPhase;
}): Promise<void> {
  await persistDurableOperationStateTransition({
    operationId: input.context.operation.id,
    type: input.context.action,
    route: input.context.route,
    requestedAt: input.context.requestedAt,
    status: input.status,
    source: "api",
    requestedBy: input.userEmail,
    lockId: input.lockId,
    fencingToken: input.fencingToken,
    instanceId: input.instanceId,
    error: input.error,
    code: input.code,
    phase: input.phase,
  });
}

async function persistFinalLifecycleOperationState<TInvokeData>(input: {
  authenticated: boolean;
  context: MutatingActionRequestContext;
  user: unknown;
  lock?: ServerActionLock;
  invokeResult?: TInvokeData;
  execution: MutatingActionExecutionResult<TInvokeData>;
  retainLifecycleLock: boolean;
}): Promise<void> {
  if (!input.authenticated) {
    return;
  }

  await persistLifecycleOperationState({
    context: input.context,
    status: input.retainLifecycleLock ? "accepted" : input.execution.ok ? input.execution.status : "failed",
    userEmail: getUserEmail(input.user),
    lockId: input.lock?.lockId,
    fencingToken: input.lock?.fencingToken,
    instanceId: getInstanceIdFromInvokeResult(input.invokeResult),
    error: input.retainLifecycleLock || input.execution.ok ? undefined : input.execution.error,
    code: input.retainLifecycleLock || input.execution.ok ? undefined : input.execution.code,
    phase: input.retainLifecycleLock ? "dispatching" : input.execution.ok ? "dispatched" : "terminal",
  });
}

function isAmbiguousRemoteDispatch(
  stage: Exclude<MutatingActionLifecycleStage, "finalize">,
  lock: ServerActionLock | undefined,
  error: unknown
): boolean {
  if (stage !== "invoke" || lock === undefined) return false;
  if ((error as { remoteDispatchRejected?: unknown })?.remoteDispatchRejected === true) return false;
  const httpStatusCode = (error as { $metadata?: { httpStatusCode?: unknown } })?.$metadata?.httpStatusCode;
  return !Number.isInteger(httpStatusCode);
}

function shouldRunFinalizer(terminalPersistenceFailed: boolean, retainLifecycleLock: boolean): boolean {
  return !terminalPersistenceFailed && !retainLifecycleLock;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep remote dispatch ambiguity, durable state, and lock finalization in one auditable transaction.
export async function runMutatingActionLifecycle<TUser, TInvokeData, TFinalizeData>(
  options: MutatingActionLifecycleOptions<TUser, TInvokeData, TFinalizeData>
): Promise<MutatingActionLifecycleOutcome<TUser, TInvokeData, TFinalizeData>> {
  const { context } = options;

  let stage: Exclude<MutatingActionLifecycleStage, "finalize"> = "auth";
  let user: TUser | undefined;
  let authenticated = false;
  let lock: ServerActionLock | undefined;
  let invokeResult: TInvokeData | undefined;
  let execution: MutatingActionExecutionResult<TInvokeData>;
  let retainLifecycleLock = false;

  try {
    user = await options.authenticate(context);
    authenticated = true;

    await persistLifecycleOperationState({
      context,
      status: "accepted",
      userEmail: getUserEmail(user),
      phase: "validating",
    });

    stage = "throttle";
    const throttleDecision = await options.throttle({ context, user });
    if (!throttleDecision.allowed) {
      execution = createMutatingActionFailure(throttleDecision.message ?? "Request throttled", {
        httpStatus: throttleDecision.httpStatus ?? 429,
        code: throttleDecision.code ?? "throttled",
        cause: throttleDecision.cause,
      });
    } else {
      stage = "lock";
      lock = await options.acquireLock({ context, user });

      await persistLifecycleOperationState({
        context,
        status: "accepted",
        userEmail: getUserEmail(user),
        lockId: lock.lockId,
        fencingToken: lock.fencingToken,
        phase: "dispatching",
      });

      stage = "invoke";
      invokeResult = await options.invoke({ context, user, lock });

      execution =
        options.mapInvokeResult?.({
          context,
          user,
          lock,
          invokeResult,
        }) ?? createMutatingActionSuccess(invokeResult);
    }
  } catch (error) {
    // Once remote dispatch begins, transport failures cannot prove that the
    // mutation was not accepted. Keep the operation retryable and the lease
    // occupied rather than publishing a contradictory terminal failure.
    retainLifecycleLock = isAmbiguousRemoteDispatch(stage, lock, error);
    execution =
      options.mapError?.({
        stage,
        context,
        user,
        lock,
        error,
      }) ??
      createMutatingActionFailure("Failed to process mutating action", {
        cause: error,
      });
    if (retainLifecycleLock) {
      execution = createMutatingActionFailure(
        "Remote dispatch could not be confirmed. The operation remains pending until its lease expires.",
        {
          httpStatus: 503,
          code: "dispatch_unresolved",
          cause: error,
          operationStatus: "accepted",
        }
      );
    }
  }

  let finalizeResult: TFinalizeData | undefined;
  let finalizeError: unknown;
  let terminalPersistenceFailed = false;

  try {
    await persistFinalLifecycleOperationState({
      authenticated,
      context,
      user,
      lock,
      invokeResult,
      execution,
      retainLifecycleLock,
    });
  } catch (error) {
    finalizeError = error;
    terminalPersistenceFailed = true;
    execution = createMutatingActionFailure("Failed to persist mutating action state", {
      code: "operation_state_persist_failed",
      cause: error,
    });
  }

  if (shouldRunFinalizer(terminalPersistenceFailed, retainLifecycleLock)) {
    try {
      finalizeResult = await options.finalize({
        context,
        user,
        lock,
        invokeResult,
        execution,
      });
    } catch (error) {
      finalizeError = error;
      if (execution.ok) {
        execution = createMutatingActionFailure("Failed to finalize mutating action", {
          code: "finalize_failed",
          cause: error,
        });
      }
    }
  }

  return {
    completedStage: "finalize",
    context,
    user,
    lock,
    invokeResult,
    finalizeResult,
    finalizeError,
    execution,
  };
}
