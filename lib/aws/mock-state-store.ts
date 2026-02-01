/**
 * Mock State Store for Local Development Mode
 *
 * Provides an in-memory state store with optional JSON persistence for the mock backend.
 * Manages all mock state including instance details, SSM parameters, costs, backups, and more.
 *
 * Features:
 * - In-memory storage for all mock state
 * - Concurrency-safe read/write operations using a simple mutex
 * - Optional JSON file persistence (load on startup, save on changes)
 * - Default/seed fixtures for initial state
 * - Debounced persistence to avoid excessive writes
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerState } from "@/lib/types";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Mock instance state
 */
export interface MockInstanceState {
  instanceId: string;
  state: ServerState;
  publicIp?: string;
  hasVolume: boolean;
  availabilityZone?: string;
  blockDeviceMappings?: BlockDeviceMapping[];
  lastUpdated: string;
}

/**
 * Block device mapping for volumes
 */
export interface BlockDeviceMapping {
  deviceName: string;
  volumeId: string;
  status: "attached" | "detached" | "detaching";
  deleteOnTermination: boolean;
}

/**
 * SSM parameter with metadata
 */
export interface MockSSMParameter {
  value: string;
  type: "String" | "SecureString";
  lastModified: string;
}

/**
 * SSM command execution record
 */
export interface MockSSMCommand {
  commandId: string;
  commands: string[];
  status: "Pending" | "InProgress" | "Success" | "Failed";
  output?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * Backup information
 */
export interface MockBackup {
  name: string;
  date: string;
  size: string;
}

/**
 * Cost data for a specific period
 */
export interface MockCostData {
  period: { start: string; end: string };
  totalCost: string;
  currency: string;
  breakdown: { service: string; cost: string }[];
  fetchedAt: string;
}

/**
 * CloudFormation stack state
 */
export interface MockCloudFormationStack {
  exists: boolean;
  status: string;
  stackId: string;
}

/**
 * Fault injection configuration
 */
export interface MockFaultInjection {
  globalLatencyMs: number;
  operationFailures: Map<string, OperationFailureConfig>;
}

/**
 * Operation failure configuration
 */
export interface OperationFailureConfig {
  failNext: boolean;
  alwaysFail: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Complete mock state
 */
export interface MockState {
  instance: MockInstanceState;
  ssm: {
    parameters: Record<string, MockSSMParameter>;
    commands: MockSSMCommand[];
  };
  backups: MockBackup[];
  costs: {
    "current-month": MockCostData;
    "last-month": MockCostData;
    "last-30-days": MockCostData;
  };
  cloudformation: MockCloudFormationStack;
  faults: MockFaultInjection;
  pendingTimeouts: NodeJS.Timeout[];
}

/**
 * Configuration options for the state store
 */
export interface MockStateStoreOptions {
  /** Enable JSON file persistence */
  enablePersistence?: boolean;
  /** Path to the JSON persistence file */
  persistencePath?: string;
  /** Debounce delay for persistence writes (ms) */
  persistenceDebounceMs?: number;
}

// ============================================================================
// Default Fixtures
// ============================================================================

/**
 * Create default instance state
 */
function createDefaultInstanceState(): MockInstanceState {
  return {
    instanceId: "i-mock1234567890abcdef",
    state: "stopped" as ServerState,
    publicIp: undefined,
    hasVolume: true,
    availabilityZone: "us-east-1a",
    blockDeviceMappings: [
      {
        deviceName: "/dev/sda1",
        volumeId: "vol-mock1234567890abcdef",
        status: "attached",
        deleteOnTermination: true,
      },
    ],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Create default SSM parameters
 */
function createDefaultSSMParameters(): Record<string, MockSSMParameter> {
  const now = new Date().toISOString();
  return {
    "/minecraft/email-allowlist": {
      value: "[]",
      type: "String",
      lastModified: now,
    },
    "/minecraft/player-count": {
      value: "0",
      type: "String",
      lastModified: now,
    },
    "/minecraft/server-action": {
      value: "",
      type: "String",
      lastModified: now,
    },
    "/minecraft/gdrive-token": {
      value: "",
      type: "SecureString",
      lastModified: now,
    },
  };
}

/**
 * Create default backups
 */
function createDefaultBackups(): MockBackup[] {
  const now = new Date();
  return [
    {
      name: "minecraft-backup-2026-01-29",
      date: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      size: "2.1 GB",
    },
    {
      name: "minecraft-backup-2026-01-28",
      date: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      size: "2.0 GB",
    },
    {
      name: "minecraft-backup-2026-01-27",
      date: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      size: "2.0 GB",
    },
  ];
}

/**
 * Create default cost data for a period
 */
function createDefaultCostData(period: "current-month" | "last-month" | "last-30-days"): MockCostData {
  const now = new Date();
  let start: Date;
  let end: Date;

  if (period === "current-month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (period === "last-month") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else {
    // last-30-days
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    end = now;
  }

  const baseCost = period === "current-month" ? "15.50" : period === "last-month" ? "18.75" : "34.25";

  return {
    period: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    totalCost: baseCost,
    currency: "USD",
    breakdown: [
      { service: "Amazon EC2", cost: baseCost },
      { service: "Amazon EBS", cost: "0.00" },
      { service: "AWS Lambda", cost: "0.00" },
      { service: "Amazon SNS", cost: "0.00" },
      { service: "Amazon SES", cost: "0.00" },
    ],
    fetchedAt: now.toISOString(),
  };
}

/**
 * Create default CloudFormation stack state
 */
function createDefaultCloudFormationStack(): MockCloudFormationStack {
  return {
    exists: true,
    status: "CREATE_COMPLETE",
    stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123",
  };
}

/**
 * Create default fault injection configuration
 */
function createDefaultFaultInjection(): MockFaultInjection {
  return {
    globalLatencyMs: 0,
    operationFailures: new Map(),
  };
}

/**
 * Create complete default mock state
 */
function createDefaultMockState(): MockState {
  return {
    instance: createDefaultInstanceState(),
    ssm: {
      parameters: createDefaultSSMParameters(),
      commands: [],
    },
    backups: createDefaultBackups(),
    costs: {
      "current-month": createDefaultCostData("current-month"),
      "last-month": createDefaultCostData("last-month"),
      "last-30-days": createDefaultCostData("last-30-days"),
    },
    cloudformation: createDefaultCloudFormationStack(),
    faults: createDefaultFaultInjection(),
    pendingTimeouts: [],
  };
}

// ============================================================================
// Mock State Store Implementation
// ============================================================================

/**
 * Mock State Store
 *
 * Manages all mock state with optional persistence and concurrency safety.
 */
export class MockStateStore {
  private state: MockState;
  private lock: Promise<void> = Promise.resolve();
  private options: Required<MockStateStoreOptions>;
  private persistenceTimeout: NodeJS.Timeout | null = null;

  constructor(options: MockStateStoreOptions = {}) {
    this.options = {
      enablePersistence: options.enablePersistence ?? false,
      persistencePath: options.persistencePath ?? path.join(process.cwd(), ".mock-state.json"),
      persistenceDebounceMs: options.persistenceDebounceMs ?? 1000,
    };

    // Load state from persistence or create default
    if (this.options.enablePersistence) {
      this.state = this.loadState() ?? createDefaultMockState();
    } else {
      this.state = createDefaultMockState();
    }
  }

  // ========================================================================
  // Concurrency Control
  // ========================================================================

  /**
   * Acquire a lock for concurrent access
   * Returns a promise that resolves when the lock is acquired
   */
  private async acquireLock(): Promise<() => void> {
    // Wait for any ongoing operation to complete
    await this.lock;

    // Create a new lock promise
    let resolveLock: (() => void) | null = null;
    this.lock = new Promise((resolve) => {
      resolveLock = resolve;
    });

    return () => {
      if (resolveLock) {
        resolveLock();
      }
    };
  }

  /**
   * Execute a function with exclusive access to the state
   */
  private async withLock<T>(fn: (state: MockState) => T): Promise<T> {
    const release = await this.acquireLock();
    try {
      const result = fn(this.state);
      // Await the result if it's a Promise
      return await Promise.resolve(result);
    } finally {
      release();
    }
  }

  /**
   * Execute a function with exclusive access and persist changes
   */
  private async withLockAndPersist<T>(fn: (state: MockState) => T): Promise<T> {
    const result = await this.withLock(fn);
    this.schedulePersistence();
    return result;
  }

  // ========================================================================
  // Persistence
  // ========================================================================

  /**
   * Load state from JSON file
   */
  private loadState(): MockState | null {
    try {
      if (!fs.existsSync(this.options.persistencePath)) {
        return null;
      }

      const data = fs.readFileSync(this.options.persistencePath, "utf-8");
      const parsed = JSON.parse(data);

      // Reconstruct Map for operationFailures
      if (parsed.faults?.operationFailures) {
        parsed.faults.operationFailures = new Map(Object.entries(parsed.faults.operationFailures));
      }

      // Initialize pendingTimeouts (not persisted)
      parsed.pendingTimeouts = [];

      return parsed as MockState;
    } catch (error) {
      console.error("[MOCK-STATE-STORE] Failed to load state:", error);
      return null;
    }
  }

  /**
   * Save state to JSON file
   */
  private saveState(): void {
    try {
      // Convert Map to object for JSON serialization
      // Exclude pendingTimeouts as it contains non-serializable NodeJS.Timeout objects
      const { pendingTimeouts, ...stateWithoutTimeouts } = this.state;
      const serializableState = {
        ...stateWithoutTimeouts,
        faults: {
          ...this.state.faults,
          operationFailures: Object.fromEntries(this.state.faults.operationFailures),
        },
      };

      const data = JSON.stringify(serializableState, null, 2);
      fs.writeFileSync(this.options.persistencePath, data, "utf-8");
    } catch (error) {
      console.error("[MOCK-STATE-STORE] Failed to save state:", error);
    }
  }

  /**
   * Schedule persistence with debouncing
   */
  private schedulePersistence(): void {
    if (!this.options.enablePersistence) {
      return;
    }

    if (this.persistenceTimeout) {
      clearTimeout(this.persistenceTimeout);
    }

    this.persistenceTimeout = setTimeout(() => {
      this.saveState();
      this.persistenceTimeout = null;
    }, this.options.persistenceDebounceMs);
  }

  // ========================================================================
  // Instance State
  // ========================================================================

  /**
   * Get the current instance state
   */
  async getInstance(): Promise<MockInstanceState> {
    return this.withLock((state) => ({ ...state.instance }));
  }

  /**
   * Set the instance state
   */
  async setInstance(instance: Partial<MockInstanceState>): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.instance = {
        ...state.instance,
        ...instance,
        lastUpdated: new Date().toISOString(),
      };
    });
  }

  /**
   * Update the instance state
   */
  async updateInstanceState(newState: ServerState): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.instance.state = newState;
      state.instance.lastUpdated = new Date().toISOString();

      // Auto-manage public IP based on state
      if (newState === "running" && !state.instance.publicIp) {
        state.instance.publicIp = "203.0.113.42"; // Example IP (TEST-NET-3)
      } else if (newState !== "running") {
        state.instance.publicIp = undefined;
      }
    });
  }

  /**
   * Get the instance public IP
   */
  async getPublicIp(): Promise<string | undefined> {
    return this.withLock((state) => state.instance.publicIp);
  }

  /**
   * Set the instance public IP
   */
  async setPublicIp(ip: string): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.instance.publicIp = ip;
      state.instance.lastUpdated = new Date().toISOString();
    });
  }

  /**
   * Check if the instance has a volume attached
   */
  async hasVolume(): Promise<boolean> {
    return this.withLock((state) => state.instance.hasVolume);
  }

  /**
   * Set whether the instance has a volume
   */
  async setHasVolume(hasVolume: boolean): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.instance.hasVolume = hasVolume;
      state.instance.lastUpdated = new Date().toISOString();

      // Update block device mappings accordingly
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
    });
  }

  // ========================================================================
  // SSM Parameters
  // ========================================================================

  /**
   * Get an SSM parameter by name
   */
  async getParameter(name: string): Promise<string | null> {
    return this.withLock((state) => {
      const param = state.ssm.parameters[name];
      return param ? param.value : null;
    });
  }

  /**
   * Set an SSM parameter
   */
  async setParameter(name: string, value: string, type: "String" | "SecureString" = "String"): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.ssm.parameters[name] = {
        value,
        type,
        lastModified: new Date().toISOString(),
      };
    });
  }

  /**
   * Delete an SSM parameter
   */
  async deleteParameter(name: string): Promise<void> {
    await this.withLockAndPersist((state) => {
      delete state.ssm.parameters[name];
    });
  }

  /**
   * Get all SSM parameters
   */
  async getAllParameters(): Promise<Record<string, MockSSMParameter>> {
    return this.withLock((state) => ({ ...state.ssm.parameters }));
  }

  // ========================================================================
  // SSM Commands
  // ========================================================================

  /**
   * Get all SSM commands
   */
  async getCommands(): Promise<MockSSMCommand[]> {
    return this.withLock((state) => [...state.ssm.commands]);
  }

  /**
   * Add a new SSM command
   */
  async addCommand(commands: string[]): Promise<string> {
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    await this.withLockAndPersist((state) => {
      state.ssm.commands.push({
        commandId,
        commands,
        status: "Pending",
        createdAt: new Date().toISOString(),
      });
    });

    return commandId;
  }

  /**
   * Update a command status
   */
  async updateCommand(
    commandId: string,
    updates: Partial<Pick<MockSSMCommand, "status" | "output" | "error" | "completedAt">>
  ): Promise<void> {
    await this.withLockAndPersist((state) => {
      const command = state.ssm.commands.find((c) => c.commandId === commandId);
      if (command) {
        Object.assign(command, updates);
      }
    });
  }

  /**
   * Clear all commands
   */
  async clearCommands(): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.ssm.commands = [];
    });
  }

  // ========================================================================
  // Backups
  // ========================================================================

  /**
   * Get all backups
   */
  async getBackups(): Promise<MockBackup[]> {
    return this.withLock((state) => [...state.backups]);
  }

  /**
   * Add a backup
   */
  async addBackup(backup: MockBackup): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.backups.push(backup);
      // Sort by date descending
      state.backups.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });
  }

  /**
   * Remove a backup by name
   */
  async removeBackup(name: string): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.backups = state.backups.filter((b) => b.name !== name);
    });
  }

  /**
   * Clear all backups
   */
  async clearBackups(): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.backups = [];
    });
  }

  // ========================================================================
  // Costs
  // ========================================================================

  /**
   * Get cost data for a specific period
   */
  async getCosts(period: "current-month" | "last-month" | "last-30-days"): Promise<MockCostData> {
    return this.withLock((state) => ({ ...state.costs[period] }));
  }

  /**
   * Set cost data for a specific period
   */
  async setCosts(period: "current-month" | "last-month" | "last-30-days", costs: MockCostData): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.costs[period] = { ...costs };
    });
  }

  // ========================================================================
  // CloudFormation Stack
  // ========================================================================

  /**
   * Get CloudFormation stack status
   */
  async getStackStatus(): Promise<MockCloudFormationStack> {
    return this.withLock((state) => ({ ...state.cloudformation }));
  }

  /**
   * Set CloudFormation stack status
   */
  async setStackStatus(stack: Partial<MockCloudFormationStack>): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.cloudformation = {
        ...state.cloudformation,
        ...stack,
      };
    });
  }

  // ========================================================================
  // Fault Injection
  // ========================================================================

  /**
   * Get global latency in milliseconds
   */
  async getGlobalLatency(): Promise<number> {
    return this.withLock((state) => state.faults.globalLatencyMs);
  }

  /**
   * Set global latency in milliseconds
   */
  async setGlobalLatency(latencyMs: number): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.faults.globalLatencyMs = latencyMs;
    });
  }

  /**
   * Get failure configuration for an operation
   */
  async getOperationFailure(operation: string): Promise<OperationFailureConfig | undefined> {
    return this.withLock((state) => state.faults.operationFailures.get(operation));
  }

  /**
   * Set failure configuration for an operation
   */
  async setOperationFailure(operation: string, config: OperationFailureConfig): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.faults.operationFailures.set(operation, config);
    });
  }

  /**
   * Clear failure configuration for an operation
   */
  async clearOperationFailure(operation: string): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.faults.operationFailures.delete(operation);
    });
  }

  /**
   * Clear all failure configurations
   */
  async clearAllFailures(): Promise<void> {
    await this.withLockAndPersist((state) => {
      state.faults.operationFailures.clear();
      state.faults.globalLatencyMs = 0;
    });
  }

  // ========================================================================
  // State Management
  // ========================================================================

  /**
   * Get the complete mock state
   */
  async getState(): Promise<MockState> {
    return this.withLock((state) => ({
      ...state,
      ssm: {
        parameters: { ...state.ssm.parameters },
        commands: [...state.ssm.commands],
      },
      backups: [...state.backups],
      costs: {
        "current-month": { ...state.costs["current-month"] },
        "last-month": { ...state.costs["last-month"] },
        "last-30-days": { ...state.costs["last-30-days"] },
      },
      cloudformation: { ...state.cloudformation },
      faults: {
        globalLatencyMs: state.faults.globalLatencyMs,
        operationFailures: new Map(state.faults.operationFailures),
      },
    }));
  }

  /**
   * Reset the state to defaults
   */
  async resetState(): Promise<void> {
    console.log("[MOCK-STATE-STORE] Resetting state to defaults");
    // Clear any pending timeouts before resetting
    this.clearAllTimeouts();
    // Clear any pending persistence timeout
    if (this.persistenceTimeout) {
      clearTimeout(this.persistenceTimeout);
      this.persistenceTimeout = null;
    }
    await this.withLockAndPersist((state) => {
      const defaultState = createDefaultMockState();
      console.log("[MOCK-STATE-STORE] Current faults before reset:", Array.from(state.faults.operationFailures.keys()));
      // Replace all properties including nested objects and Maps
      state.instance = { ...defaultState.instance };
      state.ssm = {
        parameters: { ...defaultState.ssm.parameters },
        commands: [...defaultState.ssm.commands],
      };
      state.backups = [...defaultState.backups];
      state.costs = { ...defaultState.costs };
      state.cloudformation = { ...defaultState.cloudformation };
      state.faults = {
        globalLatencyMs: defaultState.faults.globalLatencyMs,
        operationFailures: new Map(defaultState.faults.operationFailures),
      };
      state.pendingTimeouts = [];
      console.log("[MOCK-STATE-STORE] Faults after reset:", Array.from(state.faults.operationFailures.keys()));
    });
    // Save immediately without debouncing to ensure clean state for next test
    this.saveState();
    console.log("[MOCK-STATE-STORE] State reset complete and saved");
  }

  /**
   * Register a timeout for cleanup on reset
   */
  registerTimeout(timeout: NodeJS.Timeout): void {
    this.state.pendingTimeouts.push(timeout);
  }

  /**
   * Clear all pending timeouts
   */
  clearAllTimeouts(): void {
    for (const timeout of this.state.pendingTimeouts) {
      clearTimeout(timeout);
    }
    this.state.pendingTimeouts = [];
  }

  /**
   * Apply instance updates to state
   */
  private applyInstanceUpdate(state: MockState, instance?: Partial<MockInstanceState>): void {
    if (instance) {
      state.instance = { ...state.instance, ...instance };
    }
  }

  /**
   * Apply SSM updates to state
   */
  private applySSMUpdate(state: MockState, ssm?: Partial<MockState["ssm"]>): void {
    if (!ssm) return;
    if (ssm.parameters) {
      state.ssm.parameters = { ...state.ssm.parameters, ...ssm.parameters };
    }
    if (ssm.commands) {
      state.ssm.commands = [...ssm.commands];
    }
  }

  /**
   * Apply backup updates to state
   */
  private applyBackupsUpdate(state: MockState, backups?: MockBackup[]): void {
    if (backups) {
      state.backups = [...backups];
    }
  }

  /**
   * Apply cost updates to state
   */
  private applyCostsUpdate(state: MockState, costs?: Partial<MockState["costs"]>): void {
    if (costs) {
      state.costs = { ...state.costs, ...costs };
    }
  }

  /**
   * Apply CloudFormation updates to state
   */
  private applyCloudFormationUpdate(state: MockState, cloudformation?: Partial<MockCloudFormationStack>): void {
    if (cloudformation) {
      state.cloudformation = { ...state.cloudformation, ...cloudformation };
    }
  }

  /**
   * Apply fault injection updates to state
   */
  private applyFaultsUpdate(state: MockState, faults?: Partial<MockFaultInjection>): void {
    if (!faults) return;
    if (typeof faults.globalLatencyMs === "number") {
      state.faults.globalLatencyMs = faults.globalLatencyMs;
    }
    if (faults.operationFailures) {
      state.faults.operationFailures = new Map(faults.operationFailures);
    }
  }

  /**
   * Apply a partial state update
   */
  async patchState(updates: Partial<MockState>): Promise<void> {
    await this.withLockAndPersist((state) => {
      this.applyInstanceUpdate(state, updates.instance);
      this.applySSMUpdate(state, updates.ssm);
      this.applyBackupsUpdate(state, updates.backups);
      this.applyCostsUpdate(state, updates.costs);
      this.applyCloudFormationUpdate(state, updates.cloudformation);
      this.applyFaultsUpdate(state, updates.faults);
    });
  }

  /**
   * Force immediate persistence (bypasses debouncing)
   */
  async persistNow(): Promise<void> {
    if (this.options.enablePersistence) {
      if (this.persistenceTimeout) {
        clearTimeout(this.persistenceTimeout);
        this.persistenceTimeout = null;
      }
      this.saveState();
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Global singleton instance of the mock state store
 * Initialized lazily on first access
 */
// Use globalThis to persist state across module reloads in dev mode
const GLOBAL_KEY = "__MOCK_STATE_STORE__";

/**
 * Get or create the global mock state store instance
 */
export function getMockStateStore(options?: MockStateStoreOptions): MockStateStore {
  // Check if store exists on globalThis (survives module reloads)
  const existingStore = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  if (existingStore instanceof MockStateStore) {
    console.log("[MOCK-STATE-STORE] Reusing existing store from globalThis");
    return existingStore;
  }

  // Disable persistence in test mode to ensure clean state between tests
  const isTestMode = process.env.NODE_ENV === "test" || process.env.PLAYWRIGHT_TEST === "1";
  console.log("[MOCK-STATE-STORE] Creating new store, test mode:", isTestMode);

  // Enable file persistence by default to survive module reloads in dev mode
  const storeOptions: MockStateStoreOptions = {
    ...options,
    enablePersistence: !isTestMode,
    persistencePath: path.join(process.cwd(), ".mock-state.json"),
  };
  const newStore = new MockStateStore(storeOptions);
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = newStore;
  return newStore;
}

/**
 * Force a complete reset of the mock state store singleton
 * This creates a new store instance, discarding all previous state
 * Useful for testing to ensure clean state between tests
 */
export function resetMockStateStore(): void {
  console.log("[MOCK-STATE-STORE] Force resetting singleton store");
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
