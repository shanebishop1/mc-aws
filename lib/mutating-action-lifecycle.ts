import {
  type MutatingActionExecutionFailure,
  type MutatingActionExecutionResult,
  type MutatingActionRequestContext,
  createMutatingActionFailure,
  createMutatingActionSuccess,
} from "@/lib/mutating-action-contract";
import { persistDurableOperationStateTransition } from "@/lib/durable-operation-state";
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
  instanceId?: string;
  error?: string;
  code?: string;
}): Promise<void> {
  try {
    await persistDurableOperationStateTransition({
      operationId: input.context.operation.id,
      type: input.context.action,
      route: input.context.route,
      requestedAt: input.context.requestedAt,
      status: input.status,
      source: "api",
      requestedBy: input.userEmail,
      lockId: input.lockId,
      instanceId: input.instanceId,
      error: input.error,
      code: input.code,
    });
  } catch (error) {
    console.error("[MUTATING-ACTION] Failed to persist durable operation state:", error);
  }
}

export async function runMutatingActionLifecycle<TUser, TInvokeData, TFinalizeData>(
  options: MutatingActionLifecycleOptions<TUser, TInvokeData, TFinalizeData>
): Promise<MutatingActionLifecycleOutcome<TUser, TInvokeData, TFinalizeData>> {
  const { context } = options;

  await persistLifecycleOperationState({
    context,
    status: "running",
  });

  let stage: Exclude<MutatingActionLifecycleStage, "finalize"> = "auth";
  let user: TUser | undefined;
  let lock: ServerActionLock | undefined;
  let invokeResult: TInvokeData | undefined;
  let execution: MutatingActionExecutionResult<TInvokeData>;

  try {
    user = await options.authenticate(context);

    await persistLifecycleOperationState({
      context,
      status: "running",
      userEmail: getUserEmail(user),
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
  }

  let finalizeResult: TFinalizeData | undefined;
  let finalizeError: unknown;

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

  await persistLifecycleOperationState({
    context,
    status: execution.ok ? execution.status : "failed",
    userEmail: getUserEmail(user),
    lockId: lock?.lockId,
    instanceId: getInstanceIdFromInvokeResult(invokeResult),
    error: execution.ok ? undefined : execution.error,
    code: execution.ok ? undefined : execution.code,
  });

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
