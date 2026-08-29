/**
 * Mock AWS provider implementation
 * Provides realistic mock implementations for testing and local development
 * This provider does NOT initialize any AWS SDK clients
 */

import { randomUUID } from "node:crypto";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { type CostData, type OperationStatus, type OperationType, ServerState } from "../types";
import { type MockState, getMockStateStore } from "./mock-state-store";
import type { AwsProvider, BackupInfo, InstanceDetails, ParameterStoreEntry, PlayerCount } from "./types";

// Re-export scenario engine functions for convenience
export {
  applyScenario,
  getAvailableScenarios,
  getCurrentScenario,
  resetToDefaultScenario,
  injectFault,
  clearFault,
  clearAllFaults,
  setGlobalLatency,
  getFaultConfig,
  resetMockStateStore,
  type Scenario,
  type FaultConfig,
} from "./mock-scenarios";

/**
 * Helper function to apply fault injection before an operation
 * Throws an error if the operation is configured to fail
 * Applies latency if configured
 */
async function applyFaultInjection(operation: string): Promise<void> {
  const stateStore = getMockStateStore();

  // Check for operation-specific failure
  const failureConfig = await stateStore.getOperationFailure(operation);
  console.log("[MOCK-FAULT] Checking configured operation fault");
  if (failureConfig?.failNext || failureConfig?.alwaysFail) {
    console.log("[MOCK-FAULT] Injecting configured operation failure");
    if (failureConfig.failNext) {
      await stateStore.clearOperationFailure(operation);
    }
    const error = new Error(failureConfig.errorMessage || `Mock ${operation} error`);
    (error as Error & { name: string }).name = failureConfig.errorCode || `${operation}Error`;
    throw error;
  }

  // Apply global latency if configured
  const latencyMs = await stateStore.getGlobalLatency();
  if (latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }
}

// Constants for state transition delays (in milliseconds)
const PENDING_DELAY_MS = 2500; // 2.5 seconds
const STOPPING_DELAY_MS = 2500; // 2.5 seconds
const POLL_INTERVAL_MS = 500; // 0.5 seconds for polling
const operationStateParamPrefix = "/minecraft/operations";
const operationStatuses: ReadonlySet<OperationStatus> = new Set(["accepted", "running", "completed", "failed"]);
const operationTypes: ReadonlySet<OperationType> = new Set([
  "start",
  "stop",
  "backup",
  "restore",
  "hibernate",
  "resume",
  "allowlist",
]);
const transitionSources = new Set<MockOperationStateTransitionSource>(["api", "lambda"]);

type MockOperationStateTransitionSource = "api" | "lambda";

interface MockOperationStateTransition {
  status: OperationStatus;
  at: string;
  source: MockOperationStateTransitionSource;
  error?: string;
  code?: string;
}

interface MockOperationState {
  id: string;
  type: OperationType;
  route: string;
  status: OperationStatus;
  requestedAt: string;
  updatedAt: string;
  requestedBy?: string;
  lockId?: string;
  fencingToken?: number;
  instanceId?: string;
  phase?: "validating" | "dispatching" | "dispatched" | "executing" | "terminal";
  executionAttempt?: number;
  executionToken?: string;
  lastError?: string;
  code?: string;
  history: MockOperationStateTransition[];
}

function getOperationStateParameterName(operationId: string): string {
  return `${operationStateParamPrefix}/${operationId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOperationState(raw: string | null): MockOperationState | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<MockOperationState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (!parsed.id || !parsed.type || !parsed.route || !parsed.status || !parsed.requestedAt || !parsed.updatedAt) {
      return null;
    }

    if (!operationTypes.has(parsed.type) || !operationStatuses.has(parsed.status)) {
      return null;
    }

    const history: MockOperationStateTransition[] = Array.isArray(parsed.history)
      ? parsed.history.flatMap((entry) => {
          if (!isObject(entry)) {
            return [];
          }

          const status = entry.status;
          const at = entry.at;
          const source = entry.source;
          if (typeof status !== "string" || typeof at !== "string" || typeof source !== "string") {
            return [];
          }

          if (
            !operationStatuses.has(status as OperationStatus) ||
            !transitionSources.has(source as MockOperationStateTransitionSource)
          ) {
            return [];
          }

          return [
            {
              status: status as OperationStatus,
              at,
              source: source as MockOperationStateTransitionSource,
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
      fencingToken: Number.isSafeInteger(parsed.fencingToken) ? parsed.fencingToken : undefined,
      instanceId: normalizeOptionalText(parsed.instanceId),
      phase: parsed.phase,
      executionAttempt: Number.isSafeInteger(parsed.executionAttempt) ? parsed.executionAttempt : undefined,
      executionToken: normalizeOptionalText(parsed.executionToken),
      lastError: normalizeOptionalText(parsed.lastError),
      code: normalizeOptionalText(parsed.code),
      history,
    };
  } catch {
    return null;
  }
}

function shouldAppendTransition(
  history: MockOperationStateTransition[],
  nextStatus: OperationStatus,
  source: MockOperationStateTransitionSource,
  error?: string,
  code?: string
): boolean {
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

function buildNextTransitionHistory(input: {
  existingHistory: MockOperationStateTransition[];
  applyIncomingStatus: boolean;
  nextStatus: OperationStatus;
  source: MockOperationStateTransitionSource;
  now: string;
  error?: string;
  code?: string;
}): MockOperationStateTransition[] {
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

type MockStateStore = ReturnType<typeof getMockStateStore>;

interface MockLambdaCommandContext {
  lockId?: string;
  fencingToken?: number;
  command?: string;
  operationId?: string;
  userEmail?: string;
  instanceId?: string;
  operationType?: OperationType;
}

interface ClaimedMockLambdaCommandContext extends MockLambdaCommandContext {
  lockId: string;
  fencingToken: number;
  command: string;
  operationId: string;
  userEmail: string;
  instanceId: string;
  operationType: OperationType;
  executionToken: string;
}

function includesCommand(commandString: string, ...terms: string[]): boolean {
  return terms.some((term) => commandString.includes(term));
}

async function getMockCommandOutput(commandString: string, stateStore: MockStateStore): Promise<string> {
  if (includesCommand(commandString, "ListBackups", "rclone lsf")) {
    const backups = await stateStore.getBackups();
    return backups.map((backup) => `${backup.name}|${backup.size}|${backup.date}`).join("\n");
  }

  if (commandString.includes("systemctl is-active minecraft")) {
    const instance = await stateStore.getInstance();
    return instance.state === ServerState.Running ? "active" : "inactive";
  }

  if (commandString.includes("GetPlayerCount")) {
    return (await stateStore.getParameter("/minecraft/player-count")) || "0";
  }

  if (commandString.includes("UpdateEmailAllowlist")) {
    return "Email allowlist updated successfully";
  }

  if (includesCommand(commandString, "backup", "Backup")) {
    return "Backup completed successfully";
  }

  if (includesCommand(commandString, "restore", "Restore")) {
    return "Restore completed successfully";
  }

  if (includesCommand(commandString, "start", "Start")) {
    return "Server started successfully";
  }

  if (includesCommand(commandString, "stop", "Stop")) {
    return "Server stopped successfully";
  }

  return `Command executed: ${commandString}`;
}

function parseMockLambdaCommand(payload: unknown): MockLambdaCommandContext {
  const parsedPayload = (typeof payload === "string" ? JSON.parse(payload) : payload) as Record<string, unknown> | null;
  const command = normalizeOptionalText(parsedPayload?.command);

  return {
    lockId: normalizeOptionalText(parsedPayload?.lockId),
    fencingToken: Number.isSafeInteger(parsedPayload?.fencingToken)
      ? (parsedPayload?.fencingToken as number)
      : undefined,
    command,
    operationId: normalizeOptionalText(parsedPayload?.operationId),
    userEmail: normalizeOptionalText(parsedPayload?.userEmail),
    instanceId: normalizeOptionalText(parsedPayload?.instanceId),
    operationType: operationTypes.has((command ?? "") as OperationType) ? (command as OperationType) : undefined,
  };
}

function normalizeOwner(value: unknown): string | undefined {
  return normalizeOptionalText(value)?.toLowerCase();
}

function parseCurrentLifecycleLock(raw: string | undefined): {
  lockId: string;
  fencingToken: number;
  action: string;
  ownerEmail: string;
  expiresAt: string;
} | null {
  if (!raw) return null;
  try {
    const lock = JSON.parse(raw) as Record<string, unknown>;
    const lockId = normalizeOptionalText(lock.lockId);
    const action = normalizeOptionalText(lock.action);
    const ownerEmail = normalizeOwner(lock.ownerEmail);
    const expiresAt = normalizeOptionalText(lock.expiresAt);
    if (
      !lockId ||
      !action ||
      !ownerEmail ||
      !expiresAt ||
      !Number.isSafeInteger(lock.fencingToken) ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      return null;
    }
    return { lockId, action, ownerEmail, expiresAt, fencingToken: lock.fencingToken as number };
  } catch {
    return null;
  }
}

function hasExactLambdaIdentity(
  operation: MockOperationState,
  context: ClaimedMockLambdaCommandContext | Omit<ClaimedMockLambdaCommandContext, "executionToken">
): boolean {
  return (
    operation.id === context.operationId &&
    operation.type === context.operationType &&
    operation.lockId === context.lockId &&
    operation.fencingToken === context.fencingToken &&
    normalizeOwner(operation.requestedBy) === context.userEmail &&
    operation.instanceId === context.instanceId
  );
}

function hasClaimableLambdaIdentity(
  operation: MockOperationState,
  context: Omit<ClaimedMockLambdaCommandContext, "executionToken">
): boolean {
  return (
    operation.id === context.operationId &&
    operation.type === context.operationType &&
    operation.lockId === context.lockId &&
    operation.fencingToken === context.fencingToken &&
    normalizeOwner(operation.requestedBy) === context.userEmail &&
    (operation.instanceId === undefined || operation.instanceId === context.instanceId)
  );
}

function hasExactCurrentLifecycleLock(
  raw: string | undefined,
  context: ClaimedMockLambdaCommandContext | Omit<ClaimedMockLambdaCommandContext, "executionToken">
): boolean {
  const lock = parseCurrentLifecycleLock(raw);
  return Boolean(
    lock &&
      lock.lockId === context.lockId &&
      lock.fencingToken === context.fencingToken &&
      lock.action === context.command &&
      lock.ownerEmail === context.userEmail &&
      Date.parse(lock.expiresAt) > Date.now()
  );
}

function writeOperationState(state: MockState, operation: MockOperationState): void {
  state.ssm.parameters[getOperationStateParameterName(operation.id)] = {
    value: JSON.stringify(operation),
    type: "String",
    lastModified: operation.updatedAt,
  };
}

async function consumeMockLambdaTransportFault(
  context: Omit<ClaimedMockLambdaCommandContext, "executionToken">,
  stateStore: MockStateStore
): Promise<{ eligible: boolean; error?: Error; latencyMs: number }> {
  return stateStore.transact((state) => {
    if (!hasExactCurrentLifecycleLock(state.ssm.parameters["/minecraft/server-action"]?.value, context)) {
      return { eligible: false, latencyMs: 0 };
    }
    const operation = parseOperationState(
      state.ssm.parameters[getOperationStateParameterName(context.operationId)]?.value ?? null
    );
    if (
      !operation ||
      !hasClaimableLambdaIdentity(operation, context) ||
      operation.status !== "accepted" ||
      operation.executionToken
    ) {
      return { eligible: false, latencyMs: 0 };
    }

    const failure = state.faults.operationFailures.get("invokeLambda");
    if (!failure?.failNext && !failure?.alwaysFail) {
      return { eligible: true, latencyMs: state.faults.globalLatencyMs };
    }
    if (failure.failNext) state.faults.operationFailures.delete("invokeLambda");

    // Preserve accepted/dispatching state and the lifecycle lock for ambiguous
    // transport failure, while fencing duplicate delivery of this operation.
    writeOperationState(state, { ...operation, executionToken: `transport-${randomUUID()}` });
    const error = new Error(failure.errorMessage || "Mock invokeLambda error");
    (error as Error & { name: string }).name = failure.errorCode || "invokeLambdaError";
    return { eligible: true, error, latencyMs: state.faults.globalLatencyMs };
  });
}

async function claimMockLambdaOperation(
  context: MockLambdaCommandContext,
  stateStore: MockStateStore
): Promise<ClaimedMockLambdaCommandContext | null> {
  const userEmail = normalizeOwner(context.userEmail);
  if (
    !context.lockId ||
    !Number.isSafeInteger(context.fencingToken) ||
    !context.command ||
    !context.operationId ||
    !context.instanceId ||
    !context.operationType ||
    !userEmail
  ) {
    return null;
  }

  const identity = {
    ...context,
    lockId: context.lockId,
    fencingToken: context.fencingToken as number,
    command: context.command,
    operationId: context.operationId,
    userEmail,
    instanceId: context.instanceId,
    operationType: context.operationType,
  };
  const executionToken = randomUUID();
  return stateStore.transact((state) => {
    if (!hasExactCurrentLifecycleLock(state.ssm.parameters["/minecraft/server-action"]?.value, identity)) {
      return null;
    }
    const operation = parseOperationState(
      state.ssm.parameters[getOperationStateParameterName(identity.operationId)]?.value ?? null
    );
    if (
      !operation ||
      !hasClaimableLambdaIdentity(operation, identity) ||
      operation.status !== "accepted" ||
      operation.executionToken
    ) {
      return null;
    }

    const now = new Date().toISOString();
    const claimed: MockOperationState = {
      ...operation,
      instanceId: identity.instanceId,
      status: "running",
      updatedAt: now,
      phase: "executing",
      executionAttempt: (operation.executionAttempt ?? 0) + 1,
      executionToken,
      lastError: undefined,
      code: undefined,
      history: buildNextTransitionHistory({
        existingHistory: operation.history,
        applyIncomingStatus: true,
        nextStatus: "running",
        source: "lambda",
        now,
      }),
    };
    writeOperationState(state, claimed);
    return { ...identity, executionToken };
  });
}

function getClaimedOperation(state: MockState, context: ClaimedMockLambdaCommandContext): MockOperationState | null {
  if (!hasExactCurrentLifecycleLock(state.ssm.parameters["/minecraft/server-action"]?.value, context)) {
    return null;
  }
  const operation = parseOperationState(
    state.ssm.parameters[getOperationStateParameterName(context.operationId)]?.value ?? null
  );
  if (
    !operation ||
    !hasExactLambdaIdentity(operation, context) ||
    operation.status !== "running" ||
    operation.executionToken !== context.executionToken
  ) {
    return null;
  }
  return operation;
}

async function mutateIfMockLambdaClaimed(
  context: ClaimedMockLambdaCommandContext,
  stateStore: MockStateStore,
  mutate: (state: MockState) => void
): Promise<boolean> {
  return stateStore.transact((state) => {
    if (!getClaimedOperation(state, context)) return false;
    mutate(state);
    return true;
  });
}

async function finalizeClaimedMockLambdaOperation(
  context: ClaimedMockLambdaCommandContext,
  stateStore: MockStateStore,
  status: "completed" | "failed",
  error?: unknown,
  mutate?: (state: MockState) => void
): Promise<boolean> {
  return stateStore.transact((state) => {
    const operation = getClaimedOperation(state, context);
    if (!operation) return false;
    mutate?.(state);
    const now = new Date().toISOString();
    const errorMessage =
      status === "failed" ? (error instanceof Error ? error.message : "Mock lambda operation failed") : undefined;
    const code = status === "failed" ? "lambda_execution_failed" : undefined;
    writeOperationState(state, {
      ...operation,
      status,
      updatedAt: now,
      phase: "terminal",
      lastError: errorMessage,
      code,
      history: buildNextTransitionHistory({
        existingHistory: operation.history,
        applyIncomingStatus: true,
        nextStatus: status,
        source: "lambda",
        now,
        error: errorMessage,
        code,
      }),
    });
    Reflect.deleteProperty(state.ssm.parameters, "/minecraft/server-action");
    return true;
  });
}

function applyMockInstanceTransition(state: MockState, newState: ServerState): void {
  state.instance.state = newState;
  state.instance.lastUpdated = new Date().toISOString();
  if (newState === ServerState.Running && !state.instance.publicIp) {
    state.instance.publicIp = "203.0.113.42";
  } else if (newState !== ServerState.Running) {
    state.instance.publicIp = undefined;
  }
}

function setMockVolumePresence(state: MockState, hasVolume: boolean): void {
  state.instance.hasVolume = hasVolume;
  state.instance.lastUpdated = new Date().toISOString();
  if (hasVolume && !state.instance.blockDeviceMappings?.length) {
    state.instance.blockDeviceMappings = [
      {
        deviceName: "/dev/sda1",
        volumeId: `vol-mock${Date.now().toString(16)}`,
        status: "attached",
        deleteOnTermination: true,
      },
    ];
  } else if (!hasVolume) {
    state.instance.blockDeviceMappings = [];
  }
}

function scheduleMockLambdaCommandCompletion(
  context: ClaimedMockLambdaCommandContext,
  stateStore: MockStateStore,
  delayMs: number,
  commandName: string,
  mutate?: (state: MockState) => void
): void {
  const completeTimeout = setTimeout(() => {
    void finalizeClaimedMockLambdaOperation(context, stateStore, "completed", undefined, mutate)
      .then((finalized) => {
        if (finalized) console.log(`[MOCK] Finalized ${commandName} and cleared its server-action lock`);
      })
      .catch(() => console.error(`[MOCK] Failed to finalize ${commandName} operation`));
  }, delayMs);
  stateStore.registerTimeout(completeTimeout);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The command dispatch keeps each claimed side effect and its fenced completion in one auditable location.
async function runMockLambdaCommand(
  context: ClaimedMockLambdaCommandContext,
  stateStore: MockStateStore
): Promise<void> {
  try {
    if (context.command === "start") {
      await applyFaultInjection("startInstance");
      const started = await mutateIfMockLambdaClaimed(context, stateStore, (state) => {
        if (state.instance.state === ServerState.Running) return;
        if (state.instance.state !== ServerState.Stopped) {
          throw new Error(`Cannot start instance in state: ${state.instance.state}`);
        }
        applyMockInstanceTransition(state, ServerState.Pending);
      });
      if (started) {
        scheduleMockLambdaCommandCompletion(context, stateStore, PENDING_DELAY_MS + 500, "start", (state) =>
          applyMockInstanceTransition(state, ServerState.Running)
        );
      }
      return;
    }

    if (context.command === "stop") {
      await applyFaultInjection("stopInstance");
      const stopped = await mutateIfMockLambdaClaimed(context, stateStore, (state) => {
        if (state.instance.state === ServerState.Stopped) return;
        if (state.instance.state !== ServerState.Running) {
          throw new Error(`Cannot stop instance in state: ${state.instance.state}`);
        }
        applyMockInstanceTransition(state, ServerState.Stopping);
      });
      if (stopped) {
        scheduleMockLambdaCommandCompletion(context, stateStore, STOPPING_DELAY_MS + 500, "stop", (state) =>
          applyMockInstanceTransition(state, ServerState.Stopped)
        );
      }
      return;
    }

    if (context.command === "backup") {
      const backedUp = await mutateIfMockLambdaClaimed(context, stateStore, (state) => {
        state.backups.push({
          name: `mock-${context.operationId}.tar.gz`,
          date: new Date().toISOString(),
          size: "2.0 GB",
        });
        state.backups.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      });
      if (backedUp) scheduleMockLambdaCommandCompletion(context, stateStore, 500, "backup");
      return;
    }

    if (context.command === "hibernate") {
      await applyFaultInjection("stopInstance");
      const hibernating = await mutateIfMockLambdaClaimed(context, stateStore, (state) => {
        state.backups.push({
          name: `mock-${context.operationId}.tar.gz`,
          date: new Date().toISOString(),
          size: "2.0 GB",
        });
        state.backups.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        if (state.instance.state === ServerState.Running) {
          applyMockInstanceTransition(state, ServerState.Stopping);
        }
      });
      if (hibernating) {
        scheduleMockLambdaCommandCompletion(context, stateStore, STOPPING_DELAY_MS + 500, "hibernate", (state) => {
          applyMockInstanceTransition(state, ServerState.Stopped);
          setMockVolumePresence(state, false);
        });
      }
      return;
    }

    if (context.command === "resume") {
      await applyFaultInjection("startInstance");
      const resuming = await mutateIfMockLambdaClaimed(context, stateStore, (state) => {
        setMockVolumePresence(state, true);
        if (state.instance.state === ServerState.Stopped) {
          applyMockInstanceTransition(state, ServerState.Pending);
        }
      });
      if (resuming) {
        scheduleMockLambdaCommandCompletion(context, stateStore, PENDING_DELAY_MS + 500, "resume", (state) =>
          applyMockInstanceTransition(state, ServerState.Running)
        );
      }
      return;
    }

    scheduleMockLambdaCommandCompletion(context, stateStore, 500, context.command);
  } catch (error) {
    await finalizeClaimedMockLambdaOperation(context, stateStore, "failed", error);
    console.error("[MOCK] Async lambda command failed");
  }
}

/**
 * Mock AWS provider for testing and local development
 * Simulates realistic AWS behavior with state transitions and delays
 */
export const mockProvider: AwsProvider = {
  // EC2 - Instance Management
  findInstanceId: async (): Promise<string> => {
    await applyFaultInjection("findInstanceId");
    console.log("[MOCK] findInstanceId called");
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.instanceId;
  },

  resolveInstanceId: async (instanceId?: string): Promise<string> => {
    await applyFaultInjection("resolveInstanceId");
    console.log("[MOCK] resolveInstanceId called");
    if (instanceId) {
      return instanceId;
    }
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.instanceId;
  },

  getInstanceState: async (instanceId?: string): Promise<ServerState> => {
    await applyFaultInjection("getInstanceState");
    await mockProvider.resolveInstanceId(instanceId);
    console.log("[MOCK] getInstanceState called");
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();

    // Determine if hibernating based on state and volume presence
    const isHibernating = instance.state === "stopped" && !instance.hasVolume;
    if (isHibernating) {
      return ServerState.Hibernating;
    }

    return instance.state;
  },

  getInstanceDetails: async (instanceId?: string): Promise<InstanceDetails> => {
    await applyFaultInjection("getInstanceDetails");
    await mockProvider.resolveInstanceId(instanceId);
    console.log("[MOCK] getInstanceDetails called");
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();

    // Determine if hibernating based on state and volume presence
    const isHibernating = instance.state === "stopped" && !instance.hasVolume;

    return {
      instance: { InstanceId: instance.instanceId },
      state: isHibernating ? "stopped" : instance.state,
      publicIp: instance.publicIp,
      blockDeviceMappings: instance.blockDeviceMappings || [],
      az: instance.availabilityZone,
    };
  },

  startInstance: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("startInstance");
    await mockProvider.resolveInstanceId(instanceId);
    console.log("[MOCK] Sending start command for managed instance");
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "running") {
      console.log("[MOCK] Managed instance is already running");
      return;
    }

    if (currentState.state !== "stopped") {
      throw new Error(`Cannot start instance in state: ${currentState.state}`);
    }

    // Transition to pending state
    console.log("[MOCK] Managed instance transitioning to pending state");
    await stateStore.updateInstanceState(ServerState.Pending);

    // Simulate AWS delay before transitioning to running
    const timeout = setTimeout(async () => {
      console.log("[MOCK] Managed instance transitioning to running state");
      await stateStore.updateInstanceState(ServerState.Running);
    }, PENDING_DELAY_MS);
    stateStore.registerTimeout(timeout);
  },

  stopInstance: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("stopInstance");
    await mockProvider.resolveInstanceId(instanceId);
    console.log("[MOCK] Sending stop command for managed instance");
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "stopped") {
      console.log("[MOCK] Managed instance is already stopped");
      return;
    }

    if (currentState.state !== "running") {
      throw new Error(`Cannot stop instance in state: ${currentState.state}`);
    }

    // Transition to stopping state
    console.log("[MOCK] Managed instance transitioning to stopping state");
    await stateStore.updateInstanceState(ServerState.Stopping);

    // Simulate AWS delay before transitioning to stopped
    const timeout = setTimeout(async () => {
      console.log("[MOCK] Managed instance transitioning to stopped state");
      await stateStore.updateInstanceState(ServerState.Stopped);
    }, STOPPING_DELAY_MS);
    stateStore.registerTimeout(timeout);
  },

  getPublicIp: async (instanceId: string, timeoutSeconds = 300): Promise<string> => {
    await applyFaultInjection("getPublicIp");
    console.log(`[MOCK] Getting managed instance public IP (timeout: ${timeoutSeconds}s)`);

    // Check instance state before polling - throw error immediately if stopped
    const details = await mockProvider.getInstanceDetails(instanceId);
    const { publicIp, state } = details;

    if (["stopped", "stopping", "terminated", "shutting-down"].includes(state || "")) {
      throw new Error(`Instance entered unexpected state ${state} while waiting for IP`);
    }

    // If IP is already available, return it immediately
    if (publicIp) {
      console.log(`[MOCK] Public IP already available: ${publicIp}`);
      return publicIp;
    }

    // Poll for IP assignment
    console.log("[MOCK] Polling for managed instance public IP");
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let attempts = 0;

    while (Date.now() - startTime < timeoutMs) {
      attempts++;
      try {
        const pollDetails = await mockProvider.getInstanceDetails(instanceId);
        const { publicIp: pollIp, state: pollState } = pollDetails;

        console.log(`[MOCK] Polling attempt ${attempts}: state=${pollState}, ip=${pollIp || "not assigned"}`);

        if (pollIp) {
          return pollIp;
        }

        if (["stopped", "stopping", "terminated", "shutting-down"].includes(pollState || "")) {
          throw new Error(`Instance entered unexpected state ${pollState} while waiting for IP`);
        }
      } catch (error) {
        if (Date.now() - startTime >= timeoutMs) {
          throw new Error(`Failed to get public IP after ${attempts} attempts: ${error}`);
        }
        console.error(`[MOCK] Error on attempt ${attempts}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Timed out waiting for public IP address after ${timeoutSeconds} seconds`);
  },

  waitForInstanceRunning: async (instanceId: string, timeoutSeconds = 300): Promise<void> => {
    await applyFaultInjection("waitForInstanceRunning");
    console.log(`[MOCK] waitForInstanceRunning called with timeout ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "running") {
        console.log("[MOCK] Managed instance is now running");
        return;
      }

      if (["terminated", "terminating"].includes(state || "")) {
        throw new Error(`Instance entered unexpected state: ${state}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Instance did not reach running state within ${timeoutSeconds} seconds`);
  },

  waitForInstanceStopped: async (instanceId: string, timeoutSeconds = 300): Promise<void> => {
    await applyFaultInjection("waitForInstanceStopped");
    console.log(`[MOCK] waitForInstanceStopped called with timeout ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "stopped") {
        console.log("[MOCK] Managed instance is now stopped");
        return;
      }

      if (["terminated", "terminating"].includes(state || "")) {
        throw new Error(`Instance entered unexpected state: ${state}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Instance did not reach stopped state within ${timeoutSeconds} seconds`);
  },

  // EC2 - Volume Management
  detachAndDeleteVolumes: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("detachAndDeleteVolumes");
    await mockProvider.resolveInstanceId(instanceId);
    console.log("[MOCK] Detaching and deleting managed volumes");
    const stateStore = getMockStateStore();

    const instance = await stateStore.getInstance();
    const blockDeviceMappings = instance.blockDeviceMappings || [];
    console.log(`[MOCK] Found ${blockDeviceMappings.length} block device mappings`);

    for (const mapping of blockDeviceMappings) {
      const volumeId = mapping.volumeId;
      if (!volumeId) {
        console.log("[MOCK] Skipping mapping with no VolumeId");
        continue;
      }

      console.log("[MOCK] Detaching managed volume");
      // Simulate detachment delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("[MOCK] Managed volume detached");

      console.log("[MOCK] Deleting managed volume");
      // Simulate deletion delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("[MOCK] Managed volume deleted successfully");
    }

    // Remove volumes from instance state
    await stateStore.setHasVolume(false);
    console.log("[MOCK] All volumes detached and deleted");
  },

  handleResume: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("handleResume");
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log("[MOCK] Checking if managed instance needs volume restoration");
    const stateStore = getMockStateStore();

    const instance = await stateStore.getInstance();
    const blockDeviceMappings = instance.blockDeviceMappings || [];

    if (blockDeviceMappings.length > 0) {
      console.log(`[MOCK] Managed instance already has ${blockDeviceMappings.length} volume(s); skipping resume`);
      return;
    }

    console.log("[MOCK] Managed instance has no volumes; proceeding with recovery");

    if (!instance.availabilityZone) {
      throw new Error(`Could not determine availability zone for instance ${resolvedId}`);
    }

    console.log("[MOCK] Using pinned source AMI");

    console.log("[MOCK] Using pinned root snapshot");

    console.log("[MOCK] Creating new 8GB GP3 volume from snapshot...");
    console.log("[MOCK] Managed volume created");

    // Simulate volume creation delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("[MOCK] Managed volume is now available");

    console.log("[MOCK] Attaching managed volume");

    // Simulate attachment delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("[MOCK] Managed volume is now attached");

    // Update instance state to reflect new volume
    await stateStore.setHasVolume(true);
    console.log("[MOCK] Successfully restored managed volume");
  },

  // SSM - Command Execution
  executeSSMCommand: async (_instanceId: string, commands: string[]): Promise<string> => {
    await applyFaultInjection("executeSSMCommand");
    console.log(`[MOCK] executeSSMCommand called with ${commands.length} command(s)`);
    const stateStore = getMockStateStore();

    // Add command to history
    const commandId = await stateStore.addCommand(commands);
    console.log("[MOCK] SSM command sent");

    // Simulate command execution delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to InProgress
    await stateStore.updateCommand(commandId, { status: "InProgress" });

    // Simulate realistic execution based on command type
    const status: "Success" | "Failed" = "Success";
    const commandString = commands.join(" ");
    const output = await getMockCommandOutput(commandString, stateStore);

    // Simulate additional processing time
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to Success
    await stateStore.updateCommand(commandId, {
      status,
      output,
      completedAt: new Date().toISOString(),
    });

    console.log("[MOCK] SSM command completed successfully");
    return output;
  },

  listBackups: async (_instanceId?: string): Promise<BackupInfo[]> => {
    await applyFaultInjection("listBackups");
    console.log("[MOCK] listBackups called");
    const stateStore = getMockStateStore();
    const backups = await stateStore.getBackups();

    // Convert to BackupInfo format
    return backups.map((b) => ({
      name: b.name,
      size: b.size,
      date: b.date,
    }));
  },

  // SSM - Parameter Store
  getParameter: async (name: string): Promise<string | null> => {
    await applyFaultInjection("getParameter");
    console.log("[MOCK] getParameter called for:", name);
    const stateStore = getMockStateStore();
    return stateStore.getParameter(name);
  },

  putParameter: async (
    name: string,
    value: string,
    type?: "String" | "SecureString",
    overwrite = true
  ): Promise<void> => {
    await applyFaultInjection("putParameter");
    const parameterType = type ?? "String";
    console.log("[MOCK] putParameter called", {
      name,
      type: parameterType,
      overwrite,
      value: parameterType === "SecureString" ? "[REDACTED]" : value,
    });
    const stateStore = getMockStateStore();
    const written = await stateStore.putParameter(name, value, parameterType, overwrite);
    if (!written) {
      const error = new Error(`Parameter ${name} already exists`);
      (error as Error & { name: string }).name = "ParameterAlreadyExists";
      throw error;
    }
  },

  deleteParameter: async (name: string): Promise<void> => {
    await applyFaultInjection("deleteParameter");
    console.log("[MOCK] deleteParameter called for:", name);
    const stateStore = getMockStateStore();
    await stateStore.deleteParameter(name);
  },

  listParametersByPath: async (path: string): Promise<ParameterStoreEntry[]> => {
    await applyFaultInjection("listParametersByPath");
    const normalizedPath = path.trim().replace(/\/$/, "");
    if (!normalizedPath) {
      return [];
    }

    console.log("[MOCK] listParametersByPath called for:", normalizedPath);
    const stateStore = getMockStateStore();
    const allParameters = await stateStore.getAllParameters();

    return Object.entries(allParameters)
      .filter(([name]) => name === normalizedPath || name.startsWith(`${normalizedPath}/`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, parameter]) => ({
        name,
        value: parameter.value,
        type: parameter.type,
        lastModifiedAt: parameter.lastModified,
      }));
  },

  // SSM - Application-Specific Parameters
  getEmailAllowlist: async (): Promise<string[]> => {
    await applyFaultInjection("getEmailAllowlist");
    console.log("[MOCK] getEmailAllowlist called");
    const stateStore = getMockStateStore();
    const value = await stateStore.getParameter("/minecraft/email-allowlist");

    if (!value) {
      return [];
    }

    try {
      // Try to parse as JSON array
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // If not JSON, split by comma
      return value
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
    }

    return [];
  },

  updateEmailAllowlist: async (emails: string[]): Promise<void> => {
    await applyFaultInjection("updateEmailAllowlist");
    console.log(`[MOCK] updateEmailAllowlist called with ${emails.length} entries`);
    const stateStore = getMockStateStore();
    // Store as JSON array
    await stateStore.setParameter("/minecraft/email-allowlist", JSON.stringify(emails), "String");
  },

  getPlayerCount: async (): Promise<PlayerCount> => {
    await applyFaultInjection("getPlayerCount");
    console.log("[MOCK] getPlayerCount called");
    const stateStore = getMockStateStore();
    const value = await stateStore.getParameter("/minecraft/player-count");
    const count = value ? Number.parseInt(value, 10) : 0;

    return {
      count,
      lastUpdated: new Date().toISOString(),
    };
  },

  // Cost Explorer
  getCosts: async (
    periodType: "current-month" | "last-month" | "last-30-days" = "current-month"
  ): Promise<CostData> => {
    await applyFaultInjection("getCosts");
    console.log("[MOCK] getCosts called with period:", periodType);
    const stateStore = getMockStateStore();

    // Get cost data from state store
    const costData = await stateStore.getCosts(periodType);

    console.log(`[MOCK] Returning cost data for ${periodType}:`, costData.totalCost);
    return costData;
  },

  // CloudFormation
  getStackStatus: async (stackName = "MinecraftStack"): Promise<Stack | null> => {
    await applyFaultInjection("getStackStatus");
    console.log("[MOCK] getStackStatus called");
    const stateStore = getMockStateStore();

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();

    if (!stackState.exists) {
      console.log("[MOCK] Managed stack does not exist");
      return null;
    }

    // Get instance details for stack outputs
    const instance = await stateStore.getInstance();

    // Build realistic Stack object
    const stack: Stack = {
      StackName: stackName,
      StackId: stackState.stackId,
      StackStatus: stackState.status as unknown as Stack["StackStatus"],
      CreationTime: new Date("2024-01-01T00:00:00Z"),
      Description: "Minecraft Server Infrastructure",
      Parameters: [
        {
          ParameterKey: "InstanceType",
          ParameterValue: "t4g.medium",
        },
        {
          ParameterKey: "KeyName",
          ParameterValue: "minecraft-key",
        },
      ],
      Outputs: [
        {
          OutputKey: "InstanceId",
          OutputValue: instance.instanceId,
          Description: "EC2 Instance ID",
        },
        {
          OutputKey: "PublicIP",
          OutputValue: instance.publicIp || "N/A",
          Description: "Public IP Address",
        },
        {
          OutputKey: "AvailabilityZone",
          OutputValue: instance.availabilityZone || "us-east-1a",
          Description: "Availability Zone",
        },
      ],
      Tags: [
        {
          Key: "Project",
          Value: "Minecraft",
        },
        {
          Key: "Environment",
          Value: "Production",
        },
      ],
    };

    console.log("[MOCK] Managed stack status:", stackState.status);
    return stack;
  },

  checkStackExists: async (_stackName = "MinecraftStack"): Promise<boolean> => {
    await applyFaultInjection("checkStackExists");
    console.log("[MOCK] checkStackExists called");
    const stateStore = getMockStateStore();

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();
    const exists = stackState.exists;

    console.log("[MOCK] Managed stack existence checked:", exists);
    return exists;
  },

  // Lambda
  invokeLambda: async (functionName: string, payload: unknown): Promise<void> => {
    const stateStore = getMockStateStore();

    // Simulate StartMinecraftServer lambda
    if (functionName === "StartMinecraftServer" || functionName.includes("StartMinecraftServer")) {
      const context = parseMockLambdaCommand(payload);
      const userEmail = normalizeOwner(context.userEmail);
      if (
        !context.lockId ||
        !Number.isSafeInteger(context.fencingToken) ||
        !context.command ||
        !context.operationId ||
        !context.instanceId ||
        !context.operationType ||
        !userEmail
      ) {
        console.log("[MOCK] Skipping duplicate or stale lambda delivery");
        return;
      }
      const identity = {
        ...context,
        lockId: context.lockId,
        fencingToken: context.fencingToken as number,
        command: context.command,
        operationId: context.operationId,
        userEmail,
        instanceId: context.instanceId,
        operationType: context.operationType,
      };
      const transport = await consumeMockLambdaTransportFault(identity, stateStore);
      if (!transport.eligible) {
        console.log("[MOCK] Skipping duplicate or stale lambda delivery");
        return;
      }
      if (transport.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transport.latencyMs));
      }
      if (transport.error) throw transport.error;

      const claimedContext = await claimMockLambdaOperation(identity, stateStore);
      if (!claimedContext) {
        console.log("[MOCK] Skipping duplicate or stale lambda delivery");
        return;
      }
      console.log("[MOCK] Running claimed StartMinecraftServer delivery");
      await runMockLambdaCommand(claimedContext, stateStore);
      return;
    }

    console.log("[MOCK] invokeLambda called for:", functionName);
    await applyFaultInjection("invokeLambda");
  },
};
