/**
 * Mock AWS provider implementation
 * Provides realistic mock implementations for testing and local development
 * This provider does NOT initialize any AWS SDK clients
 */

import type { Stack } from "@aws-sdk/client-cloudformation";
import { type CostData, type OperationStatus, type OperationType, ServerState } from "../types";
import { getMockStateStore } from "./mock-state-store";
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
  console.log(`[MOCK-FAULT] Checking operation ${operation}, failureConfig:`, failureConfig);
  if (failureConfig?.failNext || failureConfig?.alwaysFail) {
    console.log(`[MOCK-FAULT] Throwing error for ${operation}:`, failureConfig.errorMessage);
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
]);
const transitionSources = new Set<MockOperationStateTransitionSource>(["api", "lambda"]);
const operationStatusPriority: Record<OperationStatus, number> = {
  accepted: 1,
  running: 2,
  completed: 3,
  failed: 3,
};

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
  instanceId?: string;
  lastError?: string;
  code?: string;
  history: MockOperationStateTransition[];
}

interface PersistMockOperationStateTransitionInput {
  operationId?: string;
  type?: string;
  status: OperationStatus;
  source: MockOperationStateTransitionSource;
  route?: string;
  requestedAt?: string;
  requestedBy?: string;
  lockId?: string;
  instanceId?: string;
  error?: string;
  code?: string;
  timestamp?: string;
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

function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === "completed" || status === "failed";
}

function shouldApplyStatusTransition(
  existing: MockOperationState | null,
  next: OperationStatus,
  source: MockOperationStateTransitionSource
): boolean {
  if (!existing) {
    return true;
  }

  const current = existing.status;

  if (current === next) {
    return true;
  }

  if (isTerminalOperationStatus(current)) {
    return false;
  }

  if (current === "running" && next === "accepted") {
    const latestSource = existing.history.at(-1)?.source;
    return latestSource === "api" && source === "api";
  }

  return operationStatusPriority[next] >= operationStatusPriority[current];
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
      instanceId: normalizeOptionalText(parsed.instanceId),
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

function resolveLastErrorMetadata(input: {
  existing: MockOperationState | null;
  applyIncomingStatus: boolean;
  nextStatus: OperationStatus;
  error?: string;
  code?: string;
}): {
  lastError?: string;
  code?: string;
} {
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
    lastError: input.error ?? input.existing?.lastError ?? "Operation failed",
    code: input.code ?? input.existing?.code,
  };
}

async function persistMockOperationStateTransition(input: PersistMockOperationStateTransitionInput): Promise<void> {
  const operationId = normalizeOptionalText(input.operationId);
  const type = normalizeOptionalText(input.type);
  if (!operationId || !type) {
    return;
  }

  if (
    !operationTypes.has(type as OperationType) ||
    !operationStatuses.has(input.status) ||
    !transitionSources.has(input.source)
  ) {
    return;
  }

  const stateStore = getMockStateStore();
  const now = input.timestamp ?? new Date().toISOString();
  const parameterName = getOperationStateParameterName(operationId);
  const existing = parseOperationState(await stateStore.getParameter(parameterName));
  const route = existing?.route ?? input.route ?? `/api/${type}`;
  const requestedAt = existing?.requestedAt ?? input.requestedAt ?? now;
  const requestedBy = normalizeOptionalText(input.requestedBy) ?? existing?.requestedBy;
  const lockId = normalizeOptionalText(input.lockId) ?? existing?.lockId;
  const instanceId = normalizeOptionalText(input.instanceId) ?? existing?.instanceId;

  const currentStatus = existing?.status ?? input.status;
  const applyIncomingStatus = shouldApplyStatusTransition(existing, input.status, input.source);
  const nextStatus = applyIncomingStatus ? input.status : currentStatus;
  const normalizedError = normalizeOptionalText(input.error);
  const normalizedCode = normalizeOptionalText(input.code);
  const history = buildNextTransitionHistory({
    existingHistory: existing?.history ?? [],
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

  const nextState: MockOperationState = {
    id: existing?.id ?? operationId,
    type: existing?.type ?? (type as OperationType),
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

  await stateStore.setParameter(parameterName, JSON.stringify(nextState), "String");
}

async function persistMockOperationStateTransitionSafely(
  input: PersistMockOperationStateTransitionInput
): Promise<void> {
  try {
    await persistMockOperationStateTransition(input);
  } catch (error) {
    console.error("[MOCK] Failed to persist operation state transition:", error);
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
    console.log("[MOCK] resolveInstanceId called with:", instanceId);
    if (instanceId) {
      return instanceId;
    }
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.instanceId;
  },

  getInstanceState: async (instanceId?: string): Promise<ServerState> => {
    await applyFaultInjection("getInstanceState");
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log("[MOCK] getInstanceState called for:", resolvedId);
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
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log("[MOCK] getInstanceDetails called for:", resolvedId);
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
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Sending start command for instance ${resolvedId}`);
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "running") {
      console.log(`[MOCK] Instance ${resolvedId} is already running`);
      return;
    }

    if (currentState.state !== "stopped") {
      throw new Error(`Cannot start instance in state: ${currentState.state}`);
    }

    // Transition to pending state
    console.log(`[MOCK] Instance ${resolvedId} transitioning to pending state`);
    await stateStore.updateInstanceState(ServerState.Pending);

    // Simulate AWS delay before transitioning to running
    const timeout = setTimeout(async () => {
      console.log(`[MOCK] Instance ${resolvedId} transitioning to running state`);
      await stateStore.updateInstanceState(ServerState.Running);
    }, PENDING_DELAY_MS);
    stateStore.registerTimeout(timeout);
  },

  stopInstance: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("stopInstance");
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Sending stop command for instance ${resolvedId}`);
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "stopped") {
      console.log(`[MOCK] Instance ${resolvedId} is already stopped`);
      return;
    }

    if (currentState.state !== "running") {
      throw new Error(`Cannot stop instance in state: ${currentState.state}`);
    }

    // Transition to stopping state
    console.log(`[MOCK] Instance ${resolvedId} transitioning to stopping state`);
    await stateStore.updateInstanceState(ServerState.Stopping);

    // Simulate AWS delay before transitioning to stopped
    const timeout = setTimeout(async () => {
      console.log(`[MOCK] Instance ${resolvedId} transitioning to stopped state`);
      await stateStore.updateInstanceState(ServerState.Stopped);
    }, STOPPING_DELAY_MS);
    stateStore.registerTimeout(timeout);
  },

  getPublicIp: async (instanceId: string, timeoutSeconds = 300): Promise<string> => {
    await applyFaultInjection("getPublicIp");
    console.log(`[MOCK] Getting public IP address for instance: ${instanceId} (timeout: ${timeoutSeconds}s)`);

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
    console.log(`[MOCK] Polling for public IP address for instance: ${instanceId}`);
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
        console.error(`[MOCK] Error on attempt ${attempts}:`, error);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Timed out waiting for public IP address after ${timeoutSeconds} seconds`);
  },

  waitForInstanceRunning: async (instanceId: string, timeoutSeconds = 300): Promise<void> => {
    await applyFaultInjection("waitForInstanceRunning");
    console.log(`[MOCK] waitForInstanceRunning called for: ${instanceId}, timeout: ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "running") {
        console.log(`[MOCK] Instance ${instanceId} is now running`);
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
    console.log(`[MOCK] waitForInstanceStopped called for: ${instanceId}, timeout: ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "stopped") {
        console.log(`[MOCK] Instance ${instanceId} is now stopped`);
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
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Detaching and deleting volumes for instance ${resolvedId}...`);
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

      console.log(`[MOCK] Detaching volume ${volumeId}...`);
      // Simulate detachment delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[MOCK] Volume ${volumeId} detached`);

      console.log(`[MOCK] Deleting volume ${volumeId}...`);
      // Simulate deletion delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[MOCK] Volume ${volumeId} deleted successfully`);
    }

    // Remove volumes from instance state
    await stateStore.setHasVolume(false);
    console.log("[MOCK] All volumes detached and deleted");
  },

  handleResume: async (instanceId?: string): Promise<void> => {
    await applyFaultInjection("handleResume");
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Checking if instance ${resolvedId} needs volume restoration...`);
    const stateStore = getMockStateStore();

    const instance = await stateStore.getInstance();
    const blockDeviceMappings = instance.blockDeviceMappings || [];

    if (blockDeviceMappings.length > 0) {
      console.log(
        `[MOCK] Instance ${resolvedId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`
      );
      return;
    }

    console.log(`[MOCK] Instance ${resolvedId} has no volumes. Proceeding with hibernation recovery...`);

    if (!instance.availabilityZone) {
      throw new Error(`Could not determine availability zone for instance ${resolvedId}`);
    }

    const amiId = "ami-mock1234567890abcdef";
    console.log(`[MOCK] Using pinned source AMI: ${amiId}`);

    const snapshotId = "snap-mock1234567890abcdef";
    console.log(`[MOCK] Using pinned root snapshot: ${snapshotId}`);

    console.log("[MOCK] Creating new 8GB GP3 volume from snapshot...");
    const volumeId = `vol-mock${Date.now().toString(16)}`;
    console.log(`[MOCK] Volume created: ${volumeId}`);

    // Simulate volume creation delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`[MOCK] Volume ${volumeId} is now available`);

    console.log(`[MOCK] Attaching volume ${volumeId} to instance ${resolvedId} at /dev/xvda...`);

    // Simulate attachment delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`[MOCK] Volume ${volumeId} is now attached to instance ${resolvedId}`);

    // Update instance state to reflect new volume
    await stateStore.setHasVolume(true);
    console.log(`[MOCK] Successfully restored volume for instance ${resolvedId}`);
  },

  // SSM - Command Execution
  executeSSMCommand: async (instanceId: string, commands: string[]): Promise<string> => {
    await applyFaultInjection("executeSSMCommand");
    console.log("[MOCK] executeSSMCommand called for:", instanceId, "commands:", commands);
    const stateStore = getMockStateStore();

    // Add command to history
    const commandId = await stateStore.addCommand(commands);
    console.log(`[MOCK] SSM command sent with ID: ${commandId}`);

    // Simulate command execution delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to InProgress
    await stateStore.updateCommand(commandId, { status: "InProgress" });

    // Simulate realistic execution based on command type
    let output = "";
    const status: "Success" | "Failed" = "Success";

    const commandString = commands.join(" ");

    if (commandString.includes("ListBackups") || commandString.includes("rclone lsf")) {
      // Simulate listing backups
      const backups = await stateStore.getBackups();
      output = backups.map((b) => `${b.name}|${b.size}|${b.date}`).join("\n");
    } else if (commandString.includes("systemctl is-active minecraft")) {
      // Simulate service status checks used by /api/service-status
      const instance = await stateStore.getInstance();
      output = instance.state === ServerState.Running ? "active" : "inactive";
    } else if (commandString.includes("GetPlayerCount")) {
      // Simulate getting player count
      const playerCount = await stateStore.getParameter("/minecraft/player-count");
      output = playerCount || "0";
    } else if (commandString.includes("UpdateEmailAllowlist")) {
      // Simulate updating email allowlist
      output = "Email allowlist updated successfully";
    } else if (commandString.includes("backup") || commandString.includes("Backup")) {
      // Simulate backup operation
      output = "Backup completed successfully";
    } else if (commandString.includes("restore") || commandString.includes("Restore")) {
      // Simulate restore operation
      output = "Restore completed successfully";
    } else if (commandString.includes("start") || commandString.includes("Start")) {
      // Simulate start operation
      output = "Server started successfully";
    } else if (commandString.includes("stop") || commandString.includes("Stop")) {
      // Simulate stop operation
      output = "Server stopped successfully";
    } else {
      // Generic command output
      output = `Command executed: ${commandString}`;
    }

    // Simulate additional processing time
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to Success
    await stateStore.updateCommand(commandId, {
      status,
      output,
      completedAt: new Date().toISOString(),
    });

    console.log(`[MOCK] SSM command completed successfully. Command ID: ${commandId}`);
    return output;
  },

  listBackups: async (instanceId?: string): Promise<BackupInfo[]> => {
    await applyFaultInjection("listBackups");
    console.log("[MOCK] listBackups called for:", instanceId);
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
    console.log("[MOCK] putParameter called for:", name, "value:", value, "type:", type, "overwrite:", overwrite);
    const stateStore = getMockStateStore();
    const existingValue = await stateStore.getParameter(name);
    if (!overwrite && existingValue !== null) {
      const error = new Error(`Parameter ${name} already exists`);
      (error as Error & { name: string }).name = "ParameterAlreadyExists";
      throw error;
    }
    await stateStore.setParameter(name, value, type || "String");
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
    console.log("[MOCK] updateEmailAllowlist called with:", emails);
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
    console.log("[MOCK] getStackStatus called for:", stackName);
    const stateStore = getMockStateStore();

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();

    if (!stackState.exists) {
      console.log(`[MOCK] Stack "${stackName}" does not exist`);
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

    console.log(`[MOCK] Stack "${stackName}" status:`, stackState.status);
    return stack;
  },

  checkStackExists: async (stackName = "MinecraftStack"): Promise<boolean> => {
    await applyFaultInjection("checkStackExists");
    console.log("[MOCK] checkStackExists called for:", stackName);
    const stateStore = getMockStateStore();

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();
    const exists = stackState.exists;

    console.log(`[MOCK] Stack "${stackName}" exists:`, exists);
    return exists;
  },

  // Lambda
  invokeLambda: async (functionName: string, payload: unknown): Promise<void> => {
    await applyFaultInjection("invokeLambda");
    console.log("[MOCK] invokeLambda called for:", functionName, "payload:", payload);
    const stateStore = getMockStateStore();

    // Simulate StartMinecraftServer lambda
    if (functionName === "StartMinecraftServer" || functionName.includes("StartMinecraftServer")) {
      const parsedPayload = typeof payload === "string" ? JSON.parse(payload) : payload;
      const lockId = normalizeOptionalText(parsedPayload?.lockId);
      const command = normalizeOptionalText(parsedPayload?.command);
      const operationId = normalizeOptionalText(parsedPayload?.operationId);
      const userEmail = normalizeOptionalText(parsedPayload?.userEmail);
      const instanceId = normalizeOptionalText(parsedPayload?.instanceId);
      const operationType = operationTypes.has((command ?? "") as OperationType) ? command : undefined;

      if (operationType && operationId) {
        await persistMockOperationStateTransitionSafely({
          operationId,
          type: operationType,
          status: "running",
          source: "lambda",
          requestedBy: userEmail,
          lockId,
          instanceId,
        });
      }

      const releaseLockIfOwned = async () => {
        if (!lockId) {
          return;
        }

        const lockRaw = await stateStore.getParameter("/minecraft/server-action");
        if (!lockRaw) {
          return;
        }

        try {
          const parsedLock = JSON.parse(lockRaw) as { lockId?: string };
          if (parsedLock.lockId !== lockId) {
            return;
          }
        } catch {
          return;
        }

        await mockProvider.deleteParameter("/minecraft/server-action");
      };

      const scheduleCommandCompletion = (delayMs: number, commandName: string): void => {
        const completeTimeout = setTimeout(async () => {
          try {
            await releaseLockIfOwned();

            if (operationType && operationId) {
              await persistMockOperationStateTransitionSafely({
                operationId,
                type: operationType,
                status: "completed",
                source: "lambda",
                requestedBy: userEmail,
                lockId,
                instanceId,
              });
            }

            console.log(`[MOCK] Cleared server-action lock after ${commandName} completion`);
          } catch (error) {
            if (operationType && operationId) {
              const errorMessage = error instanceof Error ? error.message : "Mock lambda operation failed";
              await persistMockOperationStateTransitionSafely({
                operationId,
                type: operationType,
                status: "failed",
                source: "lambda",
                requestedBy: userEmail,
                lockId,
                instanceId,
                error: errorMessage,
                code: "lambda_execution_failed",
              });
            }
            console.error(`[MOCK] Failed to finalize ${commandName} operation:`, error);
          }
        }, delayMs);
        stateStore.registerTimeout(completeTimeout);
      };

      try {
        if (command === "start") {
          console.log("[MOCK] Simulating async start by triggering startInstance");

          // Start the instance (this transitions to pending, then running after delay)
          await mockProvider.startInstance(instanceId);

          // Simulate Lambda lock cleanup shortly after instance reaches running
          scheduleCommandCompletion(PENDING_DELAY_MS + 500, "start");
          return;
        }

        if (operationType && typeof command === "string" && command !== "start") {
          scheduleCommandCompletion(500, command);
        }
      } catch (error) {
        if (operationType && operationId) {
          const errorMessage = error instanceof Error ? error.message : "Mock lambda operation failed";
          await persistMockOperationStateTransitionSafely({
            operationId,
            type: operationType,
            status: "failed",
            source: "lambda",
            requestedBy: userEmail,
            lockId,
            instanceId,
            error: errorMessage,
            code: "lambda_execution_failed",
          });
        }

        await releaseLockIfOwned();
        console.error("[MOCK] Async lambda command failed:", error);
      }
    }
  },
};
