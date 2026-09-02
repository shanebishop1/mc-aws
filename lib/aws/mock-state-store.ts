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
 * - Immediate persistence so separate development route runtimes stay coherent
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

export interface MockLifecycleLock {
  lockId: string;
  fencingToken: number;
  action: string;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string;
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
  /** Maximum time to wait for another runtime's persistence lock */
  persistenceLockTimeoutMs?: number;
  /** Age after which an ownerless or invalid lock can be recovered */
  persistenceLockStaleMs?: number;
}

interface PersistenceLockOwner {
  ownerToken: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface PersistenceLockHandle {
  saveState: () => Promise<void>;
  release: () => Promise<void>;
}

const persistenceLockRetryMs = 10;
const maxCommandHistory = 1_000;

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

  constructor(options: MockStateStoreOptions = {}) {
    this.options = {
      enablePersistence: options.enablePersistence ?? false,
      persistencePath: options.persistencePath ?? path.join(process.cwd(), ".mock-state.json"),
      persistenceLockTimeoutMs: options.persistenceLockTimeoutMs ?? 5_000,
      persistenceLockStaleMs: options.persistenceLockStaleMs ?? 30_000,
    };

    // Persistence is loaded under the cross-runtime lock on first access.
    this.state = createDefaultMockState();
  }

  // ========================================================================
  // Concurrency Control
  // ========================================================================

  /**
   * Acquire a lock for concurrent access
   * Returns a promise that resolves when the lock is acquired
   */
  private async acquireLock(): Promise<() => void> {
    const previousLock = this.lock;
    let resolveLock!: () => void;
    this.lock = new Promise((resolve) => {
      resolveLock = resolve;
    });
    await previousLock;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveLock();
    };
  }

  /**
   * Execute a function with exclusive access to the state
   */
  private async withLock<T>(fn: (state: MockState) => T, persist = false): Promise<T> {
    const release = await this.acquireLock();
    let persistenceLock: PersistenceLockHandle | undefined;
    try {
      if (this.options.enablePersistence) {
        persistenceLock = await this.acquirePersistenceLock();
        const persistedState = this.loadState();
        if (persistedState) {
          persistedState.pendingTimeouts = this.state.pendingTimeouts;
          this.state = persistedState;
        }
      }

      const result = fn(this.state);
      const resolvedResult = await Promise.resolve(result);
      if (persist && this.options.enablePersistence) {
        await persistenceLock?.saveState();
      }
      return resolvedResult;
    } finally {
      try {
        await persistenceLock?.release();
      } finally {
        release();
      }
    }
  }

  /**
   * Execute a function with exclusive access and persist changes
   */
  private async withLockAndPersist<T>(fn: (state: MockState) => T): Promise<T> {
    return this.withLock(fn, true);
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
      if (Array.isArray(parsed.ssm?.commands)) {
        parsed.ssm.commands = parsed.ssm.commands.slice(-maxCommandHistory);
      }

      return parsed as MockState;
    } catch (error) {
      throw new Error("[MOCK-STATE-STORE] Failed to load persisted state", { cause: error });
    }
  }

  /**
   * Save state to JSON file
   */
  private saveState(): void {
    let temporaryPath: string | undefined;
    let temporaryFile: number | undefined;
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
      temporaryPath = `${this.options.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
      temporaryFile = fs.openSync(/* turbopackIgnore: true */ temporaryPath, "wx", 0o600);
      fs.writeFileSync(temporaryFile, data, "utf-8");
      fs.fsyncSync(temporaryFile);
      fs.closeSync(temporaryFile);
      temporaryFile = undefined;
      fs.renameSync(temporaryPath, this.options.persistencePath);
      temporaryPath = undefined;
    } catch (error) {
      if (temporaryFile !== undefined) {
        try {
          fs.closeSync(temporaryFile);
        } catch {
          // Preserve the original persistence error.
        }
      }
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("[MOCK-STATE-STORE] Failed to clean up owned temporary state file");
          }
        }
      }
      throw new Error("[MOCK-STATE-STORE] Failed to persist state", { cause: error });
    }
  }

  private get persistenceLockPath(): string {
    return `${this.options.persistencePath}.lock`;
  }

  private parsePersistenceLockOwner(raw: string): PersistenceLockOwner | null {
    try {
      const owner = JSON.parse(raw) as Partial<PersistenceLockOwner>;
      if (
        typeof owner.ownerToken !== "string" ||
        !Number.isSafeInteger(owner.pid) ||
        (owner.pid ?? 0) <= 0 ||
        typeof owner.hostname !== "string" ||
        typeof owner.createdAt !== "string" ||
        !Number.isFinite(Date.parse(owner.createdAt))
      ) {
        return null;
      }
      return owner as PersistenceLockOwner;
    } catch {
      return null;
    }
  }

  private isDeadLocalOwner(owner: PersistenceLockOwner): boolean {
    if (owner.hostname !== os.hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private createPersistenceLockOwner(): PersistenceLockOwner {
    return {
      ownerToken: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
  }

  private readPersistenceLockSnapshot(lockPath: string): {
    raw: string;
    owner: PersistenceLockOwner | null;
    stats: fs.Stats;
  } | null {
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      return { raw, owner: this.parsePersistenceLockOwner(raw), stats: fs.statSync(lockPath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private isAbandonedPersistenceLock(snapshot: {
    owner: PersistenceLockOwner | null;
    stats: fs.Stats;
  }): boolean {
    const stale = Date.now() - snapshot.stats.mtimeMs >= this.options.persistenceLockStaleMs;
    return stale || Boolean(snapshot.owner && this.isDeadLocalOwner(snapshot.owner));
  }

  private removePersistenceLockSnapshot(lockPath: string, expectedRaw: string): boolean {
    try {
      if (fs.readFileSync(lockPath, "utf-8") !== expectedRaw) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }

  private releaseOwnedPersistenceLock(lockPath: string, ownerToken: string): void {
    const snapshot = this.readPersistenceLockSnapshot(lockPath);
    if (!snapshot) throw new Error("[MOCK-STATE-STORE] Persistence lock disappeared before release");
    if (snapshot.owner?.ownerToken !== ownerToken) {
      throw new Error("[MOCK-STATE-STORE] Refusing to release a persistence lock owned by another runtime");
    }
    if (!this.removePersistenceLockSnapshot(lockPath, snapshot.raw)) {
      throw new Error("[MOCK-STATE-STORE] Persistence lock ownership changed before release");
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Guard creation must pair exclusive open failures with owned cleanup and stale recovery.
  private tryAcquirePersistenceRecoveryGuard(recoveryPath: string, owner: PersistenceLockOwner): boolean {
    let recoveryFile: number | undefined;
    try {
      recoveryFile = fs.openSync(recoveryPath, "wx", 0o600);
      fs.writeFileSync(recoveryFile, JSON.stringify(owner), "utf-8");
      fs.closeSync(recoveryFile);
      return true;
    } catch (error) {
      if (recoveryFile !== undefined) {
        try {
          fs.closeSync(recoveryFile);
        } catch {
          // Continue with ownership-safe cleanup of the path created above.
        }
        try {
          fs.unlinkSync(recoveryPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error("[MOCK-STATE-STORE] Failed to clean up persistence recovery guard", {
              cause: cleanupError,
            });
          }
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("[MOCK-STATE-STORE] Failed to acquire persistence lock recovery guard", { cause: error });
      }
      const snapshot = this.readPersistenceLockSnapshot(recoveryPath);
      if (snapshot && this.isAbandonedPersistenceLock(snapshot)) {
        this.removePersistenceLockSnapshot(recoveryPath, snapshot.raw);
      }
      return false;
    }
  }

  private recoverAbandonedPersistenceLock(): boolean {
    const recoveryPath = `${this.persistenceLockPath}.recovery`;
    const recoveryOwner = this.createPersistenceLockOwner();
    if (!this.tryAcquirePersistenceRecoveryGuard(recoveryPath, recoveryOwner)) return false;

    let recovered = false;
    let recoveryError: unknown;
    try {
      const snapshot = this.readPersistenceLockSnapshot(this.persistenceLockPath);
      recovered =
        !snapshot ||
        (this.isAbandonedPersistenceLock(snapshot) &&
          this.removePersistenceLockSnapshot(this.persistenceLockPath, snapshot.raw));
    } catch (error) {
      recoveryError = error;
    }

    let cleanupError: unknown;
    try {
      this.releaseOwnedPersistenceLock(recoveryPath, recoveryOwner.ownerToken);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new Error("[MOCK-STATE-STORE] Failed to release persistence recovery guard", { cause: cleanupError });
    }
    if (recoveryError) throw recoveryError;
    return recovered;
  }

  /**
   * Release the primary lock while holding the same recovery guard used by
   * stale-lock takeover. This prevents an old owner from validating its token,
   * being replaced, and then unlinking the replacement owner's lock.
   */
  private async releasePersistenceLock(ownerToken: string): Promise<void> {
    const recoveryPath = `${this.persistenceLockPath}.recovery`;
    const recoveryOwner = this.createPersistenceLockOwner();
    const deadline = Date.now() + this.options.persistenceLockTimeoutMs;

    while (!this.tryAcquirePersistenceRecoveryGuard(recoveryPath, recoveryOwner)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `[MOCK-STATE-STORE] Timed out waiting to release persistence lock: ${this.persistenceLockPath}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, persistenceLockRetryMs));
    }

    let releaseError: unknown;
    try {
      this.releaseOwnedPersistenceLock(this.persistenceLockPath, ownerToken);
    } catch (error) {
      releaseError = error;
    }

    let guardCleanupError: unknown;
    try {
      this.releaseOwnedPersistenceLock(recoveryPath, recoveryOwner.ownerToken);
    } catch (error) {
      guardCleanupError = error;
    }
    if (guardCleanupError) {
      throw new Error("[MOCK-STATE-STORE] Failed to release persistence recovery guard", {
        cause: guardCleanupError,
      });
    }
    if (releaseError) throw releaseError;
  }

  /**
   * Validate ownership and replace the state file while excluding stale-lock
   * takeover. A timed-out former owner must never publish after replacement.
   */
  private async saveStateWhilePersistenceLockOwned(ownerToken: string): Promise<void> {
    const recoveryPath = `${this.persistenceLockPath}.recovery`;
    const recoveryOwner = this.createPersistenceLockOwner();
    const deadline = Date.now() + this.options.persistenceLockTimeoutMs;

    while (!this.tryAcquirePersistenceRecoveryGuard(recoveryPath, recoveryOwner)) {
      if (Date.now() >= deadline) {
        throw new Error(`[MOCK-STATE-STORE] Timed out validating persistence lock: ${this.persistenceLockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, persistenceLockRetryMs));
    }

    let saveError: unknown;
    try {
      const snapshot = this.readPersistenceLockSnapshot(this.persistenceLockPath);
      if (snapshot?.owner?.ownerToken !== ownerToken) {
        throw new Error("[MOCK-STATE-STORE] Persistence lock ownership changed before save");
      }
      this.saveState();
    } catch (error) {
      saveError = error;
    }

    let guardCleanupError: unknown;
    try {
      this.releaseOwnedPersistenceLock(recoveryPath, recoveryOwner.ownerToken);
    } catch (error) {
      guardCleanupError = error;
    }
    if (guardCleanupError) {
      throw new Error("[MOCK-STATE-STORE] Failed to release persistence recovery guard", {
        cause: guardCleanupError,
      });
    }
    if (saveError) throw saveError;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Acquisition, bounded retries, heartbeat, and ownership-safe cleanup form one lock protocol.
  private async acquirePersistenceLock(): Promise<PersistenceLockHandle> {
    const owner = this.createPersistenceLockOwner();
    const deadline = Date.now() + this.options.persistenceLockTimeoutMs;

    while (true) {
      let lockFile: number | undefined;
      let createdLock = false;
      try {
        lockFile = fs.openSync(this.persistenceLockPath, "wx", 0o600);
        createdLock = true;
        fs.writeFileSync(lockFile, JSON.stringify(owner), "utf-8");
        fs.fsyncSync(lockFile);
        fs.closeSync(lockFile);
        lockFile = undefined;
        if (fs.existsSync(`${this.persistenceLockPath}.recovery`)) {
          fs.unlinkSync(this.persistenceLockPath);
          createdLock = false;
          const recoveryInProgress = new Error("Persistence lock recovery is in progress") as NodeJS.ErrnoException;
          recoveryInProgress.code = "EEXIST";
          throw recoveryInProgress;
        }
        let heartbeatError: unknown;
        const heartbeat = setInterval(
          () => {
            try {
              const current = this.parsePersistenceLockOwner(fs.readFileSync(this.persistenceLockPath, "utf-8"));
              if (current?.ownerToken !== owner.ownerToken) {
                throw new Error("Persistence lock ownership changed during heartbeat");
              }
              const now = new Date();
              fs.utimesSync(this.persistenceLockPath, now, now);
            } catch (error) {
              heartbeatError ??= error;
            }
          },
          Math.max(1, Math.floor(this.options.persistenceLockStaleMs / 3))
        );
        heartbeat.unref();
        return {
          saveState: async () => this.saveStateWhilePersistenceLockOwned(owner.ownerToken),
          release: async () => {
            try {
              await this.releasePersistenceLock(owner.ownerToken);
            } finally {
              clearInterval(heartbeat);
            }
            if (heartbeatError) {
              throw new Error("[MOCK-STATE-STORE] Persistence lock heartbeat failed", { cause: heartbeatError });
            }
          },
        };
      } catch (error) {
        if (lockFile !== undefined) {
          fs.closeSync(lockFile);
        }
        if (createdLock) {
          try {
            fs.unlinkSync(this.persistenceLockPath);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw new Error("[MOCK-STATE-STORE] Failed to clean up an incomplete owned lock", {
                cause: cleanupError,
              });
            }
          }
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error("[MOCK-STATE-STORE] Failed to acquire persistence lock", { cause: error });
        }
      }

      this.recoverAbandonedPersistenceLock();
      if (Date.now() >= deadline) {
        throw new Error(`[MOCK-STATE-STORE] Timed out waiting for persistence lock: ${this.persistenceLockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, persistenceLockRetryMs));
    }
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

  /** Atomically create or overwrite one parameter, matching SSM PutParameter semantics. */
  async putParameter(
    name: string,
    value: string,
    type: "String" | "SecureString" = "String",
    overwrite = true
  ): Promise<boolean> {
    return this.withLockAndPersist((state) => {
      if (!overwrite && state.ssm.parameters[name]) return false;
      state.ssm.parameters[name] = { value, type, lastModified: new Date().toISOString() };
      return true;
    });
  }

  /** Delete only when the current serialized value still belongs to the caller. */
  async deleteParameterIfValue(name: string, expectedValue: string): Promise<boolean> {
    return this.withLockAndPersist((state) => {
      if (state.ssm.parameters[name]?.value !== expectedValue) return false;
      delete state.ssm.parameters[name];
      return true;
    });
  }

  /** Atomically acquire the mock lifecycle lock and increment its fencing token. */
  async acquireLifecycleLock(
    candidate: Omit<MockLifecycleLock, "fencingToken">,
    nowMs: number
  ): Promise<{ acquired: boolean; lock: MockLifecycleLock | null }> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parse validation, expiry, and fencing increment are one atomic critical section.
    return this.withLockAndPersist((state) => {
      const lockParameter = state.ssm.parameters["/minecraft/server-action"];
      let existing: MockLifecycleLock | null = null;
      try {
        existing = lockParameter ? (JSON.parse(lockParameter.value) as MockLifecycleLock) : null;
      } catch {
        return { acquired: false, lock: null };
      }
      if (existing) {
        const expiresAt = Date.parse(existing.expiresAt);
        if (!Number.isFinite(expiresAt) || !Number.isSafeInteger(existing.fencingToken)) {
          return { acquired: false, lock: null };
        }
        if (expiresAt > nowMs) return { acquired: false, lock: existing };
      }
      const tokenParameter = state.ssm.parameters["/minecraft/server-action-fencing-token"];
      const previousToken = Number(tokenParameter?.value ?? "0");
      if (tokenParameter && (!Number.isSafeInteger(previousToken) || previousToken < 0)) {
        return { acquired: false, lock: null };
      }
      const fencingToken = previousToken + 1;
      const lock = { ...candidate, fencingToken };
      const modifiedAt = new Date(nowMs).toISOString();
      state.ssm.parameters["/minecraft/server-action-fencing-token"] = {
        value: String(fencingToken),
        type: "String",
        lastModified: modifiedAt,
      };
      state.ssm.parameters["/minecraft/server-action"] = {
        value: JSON.stringify(lock),
        type: "String",
        lastModified: modifiedAt,
      };
      return { acquired: true, lock };
    });
  }

  async releaseLifecycleLock(input: {
    lockId: string;
    fencingToken: number;
    action?: string;
    ownerEmail?: string;
  }): Promise<boolean> {
    return this.withLockAndPersist((state) => {
      const parameter = state.ssm.parameters["/minecraft/server-action"];
      if (!parameter) return false;
      let lock: MockLifecycleLock;
      try {
        lock = JSON.parse(parameter.value) as MockLifecycleLock;
      } catch {
        return false;
      }
      if (lock.lockId !== input.lockId || lock.fencingToken !== input.fencingToken) return false;
      if (input.action && lock.action !== input.action) return false;
      if (input.ownerEmail && lock.ownerEmail !== input.ownerEmail.trim().toLowerCase()) return false;
      Reflect.deleteProperty(state.ssm.parameters, "/minecraft/server-action");
      return true;
    });
  }

  async renewLifecycleLock(lockId: string, fencingToken: number, expiresAt: string, nowMs: number) {
    return this.withLockAndPersist((state) => {
      const parameter = state.ssm.parameters["/minecraft/server-action"];
      if (!parameter) return null;
      let lock: MockLifecycleLock;
      try {
        lock = JSON.parse(parameter.value) as MockLifecycleLock;
      } catch {
        return null;
      }
      if (
        lock.lockId !== lockId ||
        lock.fencingToken !== fencingToken ||
        !Number.isFinite(Date.parse(lock.expiresAt)) ||
        Date.parse(lock.expiresAt) <= nowMs
      ) {
        return null;
      }
      const renewed = { ...lock, expiresAt };
      state.ssm.parameters["/minecraft/server-action"] = {
        ...parameter,
        value: JSON.stringify(renewed),
        lastModified: new Date(nowMs).toISOString(),
      };
      return renewed;
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
      if (state.ssm.commands.length > maxCommandHistory) {
        state.ssm.commands.splice(0, state.ssm.commands.length - maxCommandHistory);
      }
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
    await this.withLockAndPersist((state) => {
      const defaultState = createDefaultMockState();
      console.log("[MOCK-STATE-STORE] Clearing configured faults before reset");
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
      console.log("[MOCK-STATE-STORE] Configured faults cleared");
    });
    console.log("[MOCK-STATE-STORE] State reset complete and saved");
  }

  /**
   * Register a timeout for cleanup on reset
   */
  registerTimeout(timeout: NodeJS.Timeout): void {
    this.state.pendingTimeouts.push(timeout);
  }

  unregisterTimeout(timeout: NodeJS.Timeout): void {
    const index = this.state.pendingTimeouts.indexOf(timeout);
    if (index !== -1) this.state.pendingTimeouts.splice(index, 1);
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

  /** Execute one mock-only read/modify/write transaction under all persistence locks. */
  async transact<T>(fn: (state: MockState) => T): Promise<T> {
    return this.withLockAndPersist(fn);
  }

  /**
   * Force immediate persistence
   */
  async persistNow(): Promise<void> {
    if (this.options.enablePersistence) {
      await this.withLock(() => undefined, true);
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

  // Disable persistence only for unit-test environments.
  // Playwright E2E runs against a dev server where requests may execute in
  // separate runtimes; persistence keeps mock state consistent across those
  // boundaries and prevents scenario/patch drift between requests.
  const isTestMode = process.env.NODE_ENV === "test";
  console.log("[MOCK-STATE-STORE] Creating new store, unit test mode:", isTestMode);

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
  const globalState = globalThis as Record<string, unknown>;
  const existingStore = globalState[GLOBAL_KEY] as { clearAllTimeouts?: () => void } | undefined;
  existingStore?.clearAllTimeouts?.();
  delete globalState[GLOBAL_KEY];
}
