/**
 * Mock Scenario Engine for Local Development Mode
 *
 * Provides predefined scenarios and fault injection capabilities for testing.
 * Scenarios modify the mock state store to set up specific testing states.
 *
 * Features:
 * - 10 built-in scenarios covering common use cases
 * - Per-operation fault injection (latency, failNext, alwaysFail)
 * - Runtime scenario selection
 * - Scenario state persistence
 */

import type { ServerState } from "@/lib/types";
import { getMockStateStore } from "./mock-state-store";
import type {
  MockBackup,
  MockCostData,
  MockInstanceState,
  MockSSMParameter,
  OperationFailureConfig,
} from "./mock-state-store";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Scenario definition
 */
export interface Scenario {
  /** Unique scenario name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Function that applies the scenario to the state store */
  apply: () => Promise<void>;
}

/**
 * Fault injection configuration for an operation
 */
export interface FaultConfig {
  /** Operation name (e.g., "startInstance", "getCosts") */
  operation: string;
  /** Add delay in milliseconds */
  latency?: number;
  /** Fail the next call only */
  failNext?: boolean;
  /** Fail all calls until cleared */
  alwaysFail?: boolean;
  /** Error code to return */
  errorCode?: string;
  /** Error message to return */
  errorMessage?: string;
}

/**
 * Scenario state tracking
 */
export interface ScenarioState {
  /** Currently active scenario name */
  currentScenario: string;
  /** When the scenario was applied */
  appliedAt: string;
}

// ============================================================================
// Built-in Scenarios
// ============================================================================

/**
 * Default scenario: Normal operation, instance stopped
 */
const defaultScenario: Scenario = {
  name: "default",
  description: "Normal operation, instance stopped with default settings",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();
    console.log("[SCENARIO] Applied default scenario");
  },
};

/**
 * Running scenario: Instance already running
 */
const runningScenario: Scenario = {
  name: "running",
  description: "Instance is already running with public IP assigned",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to running state
    await stateStore.setInstance({
      state: "running" as ServerState,
      publicIp: "203.0.113.42",
      hasVolume: true,
    });

    // Set player count to simulate active server
    await stateStore.setParameter("/minecraft/player-count", "5", "String");

    console.log("[SCENARIO] Applied running scenario");
  },
};

/**
 * Starting scenario: Instance in pending state (mid-start)
 */
const startingScenario: Scenario = {
  name: "starting",
  description: "Instance is in pending state, transitioning to running",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to pending state
    await stateStore.setInstance({
      state: "pending" as ServerState,
      publicIp: undefined,
      hasVolume: true,
    });

    console.log("[SCENARIO] Applied starting scenario");
  },
};

/**
 * Stopping scenario: Instance in stopping state (mid-stop)
 */
const stoppingScenario: Scenario = {
  name: "stopping",
  description: "Instance is in stopping state, transitioning to stopped",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to stopping state
    await stateStore.setInstance({
      state: "stopping" as ServerState,
      publicIp: "203.0.113.42",
      hasVolume: true,
    });

    console.log("[SCENARIO] Applied stopping scenario");
  },
};

/**
 * Hibernated scenario: Instance stopped without volumes
 */
const hibernatedScenario: Scenario = {
  name: "hibernated",
  description: "Instance is stopped without volumes (hibernated state)",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to stopped state without volume
    await stateStore.setInstance({
      state: "stopped" as ServerState,
      publicIp: undefined,
      hasVolume: false,
      blockDeviceMappings: [],
    });

    console.log("[SCENARIO] Applied hibernated scenario");
  },
};

/**
 * High cost scenario: High monthly costs
 */
const highCostScenario: Scenario = {
  name: "high-cost",
  description: "Instance with high monthly costs for testing cost alerts",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to running state
    await stateStore.setInstance({
      state: "running" as ServerState,
      publicIp: "203.0.113.42",
      hasVolume: true,
    });

    // Set high costs for all periods
    const now = new Date();
    const highCostData: MockCostData = {
      period: {
        start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
      },
      totalCost: "125.50",
      currency: "USD",
      breakdown: [
        { service: "Amazon EC2", cost: "110.00" },
        { service: "Amazon EBS", cost: "12.50" },
        { service: "AWS Lambda", cost: "2.00" },
        { service: "Amazon SNS", cost: "0.50" },
        { service: "Amazon SES", cost: "0.50" },
      ],
      fetchedAt: now.toISOString(),
    };

    await stateStore.setCosts("current-month", highCostData);
    await stateStore.setCosts("last-month", { ...highCostData, totalCost: "118.75" });
    await stateStore.setCosts("last-30-days", { ...highCostData, totalCost: "244.25" });

    console.log("[SCENARIO] Applied high-cost scenario");
  },
};

/**
 * No backups scenario: No backups available
 */
const noBackupsScenario: Scenario = {
  name: "no-backups",
  description: "No backups available for testing backup error handling",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Clear all backups
    await stateStore.clearBackups();

    console.log("[SCENARIO] Applied no-backups scenario");
  },
};

/**
 * Many players scenario: High player count
 */
const manyPlayersScenario: Scenario = {
  name: "many-players",
  description: "Instance running with high player count for testing scaling",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set instance to running state
    await stateStore.setInstance({
      state: "running" as ServerState,
      publicIp: "203.0.113.42",
      hasVolume: true,
    });

    // Set high player count
    await stateStore.setParameter("/minecraft/player-count", "18", "String");

    console.log("[SCENARIO] Applied many-players scenario");
  },
};

/**
 * Stack creating scenario: CloudFormation stack in progress
 */
const stackCreatingScenario: Scenario = {
  name: "stack-creating",
  description: "CloudFormation stack is in CREATE_IN_PROGRESS state",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Set stack to creating state
    await stateStore.setStackStatus({
      exists: true,
      status: "CREATE_IN_PROGRESS",
      stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123",
    });

    console.log("[SCENARIO] Applied stack-creating scenario");
  },
};

/**
 * Errors scenario: All operations fail
 */
const errorsScenario: Scenario = {
  name: "errors",
  description: "All operations fail with errors for testing error handling",
  apply: async () => {
    const stateStore = getMockStateStore();
    await stateStore.resetState();

    // Configure failures for all operations
    const failures: FaultConfig[] = [
      {
        operation: "startInstance",
        alwaysFail: true,
        errorCode: "InstanceLimitExceeded",
        errorMessage: "You have reached the maximum number of running instances",
      },
      {
        operation: "stopInstance",
        alwaysFail: true,
        errorCode: "IncorrectState",
        errorMessage: "Instance is in an incorrect state for this operation",
      },
      {
        operation: "getCosts",
        alwaysFail: true,
        errorCode: "AccessDenied",
        errorMessage: "User is not authorized to access Cost Explorer",
      },
      {
        operation: "executeSSMCommand",
        alwaysFail: true,
        errorCode: "InvalidInstanceId",
        errorMessage: "The specified instance ID is not valid",
      },
      {
        operation: "getStackStatus",
        alwaysFail: true,
        errorCode: "ValidationError",
        errorMessage: "Stack does not exist",
      },
      {
        operation: "checkStackExists",
        alwaysFail: true,
        errorCode: "ValidationError",
        errorMessage: "Stack does not exist",
      },
    ];

    for (const failure of failures) {
      const config: OperationFailureConfig = {
        failNext: false,
        alwaysFail: failure.alwaysFail ?? false,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
      };
      await stateStore.setOperationFailure(failure.operation, config);
    }

    console.log("[SCENARIO] Applied errors scenario");
  },
};

// ============================================================================
// Scenario Registry
// ============================================================================

/**
 * All available scenarios
 */
const scenarios: Record<string, Scenario> = {
  default: defaultScenario,
  running: runningScenario,
  starting: startingScenario,
  stopping: stoppingScenario,
  hibernated: hibernatedScenario,
  "high-cost": highCostScenario,
  "no-backups": noBackupsScenario,
  "many-players": manyPlayersScenario,
  "stack-creating": stackCreatingScenario,
  errors: errorsScenario,
};

// ============================================================================
// Scenario Engine Functions
// ============================================================================

/**
 * Apply a scenario by name
 *
 * @param name - The name of the scenario to apply
 * @throws Error if scenario name is not found
 */
export async function applyScenario(name: string): Promise<void> {
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error(`Scenario not found: ${name}. Available scenarios: ${Object.keys(scenarios).join(", ")}`);
  }

  console.log(`[SCENARIO] Applying scenario: ${name}`);
  await scenario.apply();

  // Track current scenario in state store
  const stateStore = getMockStateStore();
  const state = await stateStore.getState();
  state.faults.operationFailures.set("_currentScenario", {
    failNext: false,
    alwaysFail: false,
    errorMessage: name,
  });
  await stateStore.setOperationFailure("_currentScenario", {
    failNext: false,
    alwaysFail: false,
    errorMessage: name,
  });
}

/**
 * Get all available scenarios
 *
 * @returns Array of scenario names and descriptions
 */
export function getAvailableScenarios(): Array<{ name: string; description: string }> {
  return Object.values(scenarios).map((scenario) => ({
    name: scenario.name,
    description: scenario.description,
  }));
}

/**
 * Get the currently active scenario
 *
 * @returns The name of the current scenario, or null if none is active
 */
export async function getCurrentScenario(): Promise<string | null> {
  const stateStore = getMockStateStore();
  const scenarioConfig = await stateStore.getOperationFailure("_currentScenario");
  return scenarioConfig?.errorMessage ?? null;
}

/**
 * Reset to the default scenario
 */
export async function resetToDefaultScenario(): Promise<void> {
  await applyScenario("default");
}

// ============================================================================
// Fault Injection Functions
// ============================================================================

/**
 * Apply fault injection configuration to an operation
 *
 * @param config - The fault configuration to apply
 */
export async function injectFault(config: FaultConfig): Promise<void> {
  const stateStore = getMockStateStore();

  const failureConfig: OperationFailureConfig = {
    failNext: config.failNext ?? false,
    alwaysFail: config.alwaysFail ?? false,
    errorCode: config.errorCode,
    errorMessage: config.errorMessage,
  };

  await stateStore.setOperationFailure(config.operation, failureConfig);

  // Set latency if specified
  if (config.latency !== undefined) {
    await stateStore.setGlobalLatency(config.latency);
  }

  console.log(`[SCENARIO] Injected fault for operation: ${config.operation}`, config);
}

/**
 * Clear fault injection for a specific operation
 *
 * @param operation - The operation name to clear faults for
 */
export async function clearFault(operation: string): Promise<void> {
  const stateStore = getMockStateStore();
  await stateStore.clearOperationFailure(operation);
  console.log(`[SCENARIO] Cleared fault for operation: ${operation}`);
}

/**
 * Clear all fault injections
 */
export async function clearAllFaults(): Promise<void> {
  const stateStore = getMockStateStore();
  await stateStore.clearAllFailures();
  console.log("[SCENARIO] Cleared all faults");
}

/**
 * Set global latency for all operations
 *
 * @param latencyMs - Latency in milliseconds
 */
export async function setGlobalLatency(latencyMs: number): Promise<void> {
  const stateStore = getMockStateStore();
  await stateStore.setGlobalLatency(latencyMs);
  console.log(`[SCENARIO] Set global latency: ${latencyMs}ms`);
}

/**
 * Get current fault configuration for an operation
 *
 * @param operation - The operation name
 * @returns The fault configuration, or undefined if none is set
 */
export async function getFaultConfig(operation: string): Promise<OperationFailureConfig | undefined> {
  const stateStore = getMockStateStore();
  return stateStore.getOperationFailure(operation);
}

// ============================================================================
// Export
// ============================================================================

export { scenarios };
