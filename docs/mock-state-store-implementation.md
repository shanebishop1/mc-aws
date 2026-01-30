# Mock State Store Implementation Summary

## Overview

Created a comprehensive in-memory state store with optional JSON persistence for the mock backend in local development mode.

## File Created

- **`lib/aws/mock-state-store.ts`** (648 lines)
  - Complete implementation of the mock state store
  - Type-safe with full TypeScript support
  - Concurrency-safe operations
  - Optional JSON persistence with debouncing

## Key Features Implemented

### 1. Type Definitions

All state types are properly defined:

- `MockInstanceState` - Instance details (state, public IP, block devices, etc.)
- `MockSSMParameter` - SSM parameters with metadata
- `MockSSMCommand` - Command execution records
- `MockBackup` - Backup information
- `MockCostData` - Cost data for different periods
- `MockCloudFormationStack` - Stack status
- `MockFaultInjection` - Fault injection configuration
- `MockState` - Complete state container

### 2. Default Fixtures

Sensible initial state for all components:

**Instance:**
- State: `stopped`
- Instance ID: `i-mock1234567890abcdef`
- Has volume: `true`
- Availability zone: `us-east-1a`
- Block device mappings: One attached volume

**SSM Parameters:**
- `/minecraft/email-allowlist`: `[]` (empty array)
- `/minecraft/player-count`: `0`
- `/minecraft/server-action`: `""` (no active action)
- `/minecraft/gdrive-token`: `""` (empty SecureString)

**Backups:**
- 3 sample backups from the last 3 days
- Sizes: 2.0-2.1 GB
- Sorted by date (newest first)

**Costs:**
- Current month: $15.50
- Last month: $18.75
- Last 30 days: $34.25
- Breakdown by service (EC2, EBS, Lambda, SNS, SES)

**CloudFormation Stack:**
- Exists: `true`
- Status: `CREATE_COMPLETE`
- Stack ID: ARN format

**Fault Injection:**
- Global latency: 0ms
- No operation failures configured

### 3. Class-Based API

The `MockStateStore` class provides methods for all state operations:

#### Instance State
- `getInstance()` - Get current instance state
- `setInstance(instance)` - Set instance state
- `updateInstanceState(newState)` - Update state with auto-IP management
- `getPublicIp()` - Get public IP
- `setPublicIp(ip)` - Set public IP
- `hasVolume()` - Check if volume exists
- `setHasVolume(hasVolume)` - Set volume status

#### SSM Parameters
- `getParameter(name)` - Get parameter value
- `setParameter(name, value, type)` - Set parameter
- `deleteParameter(name)` - Delete parameter
- `getAllParameters()` - Get all parameters

#### SSM Commands
- `getCommands()` - Get all commands
- `addCommand(commands)` - Add new command
- `updateCommand(commandId, updates)` - Update command status
- `clearCommands()` - Clear all commands

#### Backups
- `getBackups()` - Get all backups
- `addBackup(backup)` - Add backup
- `removeBackup(name)` - Remove backup
- `clearBackups()` - Clear all backups

#### Costs
- `getCosts(period)` - Get cost data for period
- `setCosts(period, costs)` - Set cost data

#### CloudFormation
- `getStackStatus()` - Get stack status
- `setStackStatus(stack)` - Set stack status

#### Fault Injection
- `getGlobalLatency()` - Get global latency
- `setGlobalLatency(latencyMs)` - Set global latency
- `getOperationFailure(operation)` - Get failure config
- `setOperationFailure(operation, config)` - Set failure config
- `clearOperationFailure(operation)` - Clear failure config
- `clearAllFailures()` - Clear all failures

#### State Management
- `getState()` - Get complete state
- `resetState()` - Reset to defaults
- `patchState(updates)` - Apply partial updates
- `persistNow()` - Force immediate persistence

### 4. Concurrency Safety

Implemented a simple mutex pattern:

- `acquireLock()` - Acquires exclusive access
- `withLock(fn)` - Executes function with lock
- `withLockAndPersist(fn)` - Executes with lock and persists

All state modifications go through `withLockAndPersist()` to ensure:
- Only one operation can modify state at a time
- Changes are automatically persisted
- Reads can happen concurrently but are serialized

### 5. JSON Persistence

Optional persistence with debouncing:

**Configuration:**
```typescript
interface MockStateStoreOptions {
  enablePersistence?: boolean;        // Default: false
  persistencePath?: string;           // Default: .mock-state.json
  persistenceDebounceMs?: number;     // Default: 1000ms
}
```

**Features:**
- Loads existing state on startup if file exists
- Saves state to JSON on modifications
- Debounced writes (1 second default) to avoid excessive I/O
- `persistNow()` for immediate persistence
- Handles Map serialization for fault injection

### 6. Singleton Instance

Global singleton for easy access:

```typescript
// Get or create the global instance
const store = getMockStateStore(options);

// Reset the global instance (useful for testing)
resetMockStateStore();
```

## Usage Examples

### Basic Usage

```typescript
import { getMockStateStore } from "@/lib/aws/mock-state-store";

// Get the global state store
const store = getMockStateStore();

// Get instance state
const instance = await store.getInstance();
console.log(instance.state); // "stopped"

// Update instance state
await store.updateInstanceState("running");

// Get public IP (auto-assigned when running)
const ip = await store.getPublicIp();
console.log(ip); // "203.0.113.42"
```

### With Persistence

```typescript
import { getMockStateStore } from "@/lib/aws/mock-state-store";

const store = getMockStateStore({
  enablePersistence: true,
  persistencePath: ".mock-state.json",
  persistenceDebounceMs: 2000,
});

// State will be loaded from .mock-state.json if it exists
// Changes will be saved automatically with 2-second debounce
```

### Fault Injection

```typescript
// Add latency to all operations
await store.setGlobalLatency(500);

// Make the next startInstance call fail
await store.setOperationFailure("startInstance", {
  failNext: true,
  alwaysFail: false,
  errorCode: "InstanceLimitExceeded",
  errorMessage: "You have reached your instance limit",
});

// Clear failures
await store.clearAllFailures();
```

## Acceptance Criteria Met

✅ **State store can be imported and used by the mock provider**
- Exported class and singleton functions
- Clean API for all state operations

✅ **Default fixtures provide sensible initial state**
- Instance in stopped state
- Empty email allowlist
- Zero player count
- No active server actions
- Sample backups
- Sample cost data
- CREATE_COMPLETE stack status

✅ **Read/write operations are concurrency-safe**
- Mutex-based locking
- All modifications go through `withLockAndPersist()`
- Prevents race conditions

✅ **JSON persistence works**
- Loads existing state on startup
- Saves changes with debouncing
- Handles Map serialization
- Configurable path and debounce delay

✅ **Type-safe with proper TypeScript types**
- All interfaces properly typed
- Uses `ServerState` enum from `@/lib/types`
- No `any` types used
- Proper type inference

## Test File

Created `lib/aws/mock-state-store.test.ts` for manual testing:

```bash
# Run the test
tsx lib/aws/mock-state-store.test.ts
```

The test covers:
- Initial state retrieval
- Instance state updates
- Public IP auto-assignment
- SSM parameter operations
- Backup management
- Cost data retrieval
- CloudFormation stack status
- Fault injection
- State reset

## Next Steps

The mock state store is now ready to be used by the mock provider implementation. The next task would be to:

1. Create the mock provider that uses this state store
2. Implement the provider interface methods
3. Wire up the mock provider to the facade layer
4. Create dev-only API endpoints for scenario management

## Notes

- The state store is designed to be used in a single-process environment (Next.js dev server)
- For multi-process environments, a more sophisticated locking mechanism would be needed
- The persistence file should be added to `.gitignore` (not committed)
- The state store is thread-safe for async operations but not for synchronous concurrent access