# Scenario Engine and Fault Injection System - Implementation Summary

## Overview

Implemented a comprehensive scenario engine and fault injection system for the mock backend, enabling powerful testing and development scenarios for the Minecraft server management system.

## Files Created/Modified

### New Files

1. **`lib/aws/mock-scenarios.ts`** (503 lines)
   - Complete scenario engine implementation
   - 10 built-in scenarios
   - Fault injection functions
   - Scenario state tracking

2. **`scripts/test-scenarios.ts`** (56 lines)
   - Test script for verifying scenario engine functionality
   - Demonstrates applying scenarios and fault injection

### Modified Files

1. **`lib/aws/mock-provider.ts`**
   - Added `applyFaultInjection()` helper function
   - Applied fault injection to all 24 operations
   - Re-exported scenario engine functions for convenience

## Built-in Scenarios

All 10 scenarios are implemented and working:

| Scenario | Description | Key Features |
|----------|-------------|--------------|
| `default` | Normal operation, instance stopped | Resets state to defaults |
| `running` | Instance already running | Public IP assigned, 5 players |
| `starting` | Instance in pending state | Mid-start transition |
| `stopping` | Instance in stopping state | Mid-stop transition |
| `hibernated` | Instance stopped without volumes | Hibernation recovery state |
| `high-cost` | High monthly costs | $125.50/month cost data |
| `no-backups` | No backups available | Empty backup list |
| `many-players` | High player count | 18 players active |
| `stack-creating` | CloudFormation stack in progress | CREATE_IN_PROGRESS status |
| `errors` | All operations fail | Comprehensive error testing |

## Scenario Engine API

### Core Functions

```typescript
// Apply a scenario by name
await applyScenario(name: string): Promise<void>

// Get all available scenarios
getAvailableScenarios(): Array<{ name: string; description: string }>

// Get currently active scenario
await getCurrentScenario(): Promise<string | null>

// Reset to default scenario
await resetToDefaultScenario(): Promise<void>
```

### Fault Injection Functions

```typescript
// Inject fault for a specific operation
await injectFault(config: FaultConfig): Promise<void>

// Clear fault for a specific operation
await clearFault(operation: string): Promise<void>

// Clear all faults
await clearAllFaults(): Promise<void>

// Set global latency for all operations
await setGlobalLatency(latencyMs: number): Promise<void>

// Get fault configuration for an operation
await getFaultConfig(operation: string): Promise<OperationFailureConfig | undefined>
```

### Fault Configuration

```typescript
interface FaultConfig {
  operation: string;           // Operation name (e.g., "startInstance")
  latency?: number;            // Add delay in milliseconds
  failNext?: boolean;          // Fail the next call only
  alwaysFail?: boolean;        // Fail all calls until cleared
  errorCode?: string;          // Error code to return
  errorMessage?: string;       // Error message to return
}
```

## Fault Injection Coverage

All 24 mock provider operations support fault injection:

### EC2 Operations (10)
- `findInstanceId`
- `resolveInstanceId`
- `getInstanceState`
- `getInstanceDetails`
- `startInstance`
- `stopInstance`
- `getPublicIp`
- `waitForInstanceRunning`
- `waitForInstanceStopped`
- `detachAndDeleteVolumes`
- `handleResume`

### SSM Operations (9)
- `executeSSMCommand`
- `listBackups`
- `getParameter`
- `putParameter`
- `deleteParameter`
- `getEmailAllowlist`
- `updateEmailAllowlist`
- `getPlayerCount`
- `getServerAction`
- `setServerAction`

### Cost & CloudFormation (3)
- `getCosts`
- `getStackStatus`
- `checkStackExists`

## Integration

### Export from Mock Provider

The scenario engine functions are re-exported from `lib/aws/mock-provider.ts` for convenient access:

```typescript
import {
  applyScenario,
  getAvailableScenarios,
  getCurrentScenario,
  resetToDefaultScenario,
  injectFault,
  clearFault,
  clearAllFaults,
  setGlobalLatency,
  getFaultConfig,
  type Scenario,
  type FaultConfig,
} from "@/lib/aws/mock-provider";
```

### State Persistence

- Scenario state is persisted in the mock state store
- Current scenario is tracked using `_currentScenario` operation failure key
- All fault configurations persist across server restarts (if persistence is enabled)

## Usage Examples

### Applying Scenarios

```typescript
// Apply the running scenario
await applyScenario("running");

// Apply the high-cost scenario
await applyScenario("high-cost");

// Apply the errors scenario to test error handling
await applyScenario("errors");
```

### Injecting Faults

```typescript
// Fail the next startInstance call
await injectFault({
  operation: "startInstance",
  failNext: true,
  errorCode: "InstanceLimitExceeded",
  errorMessage: "You have reached the maximum number of running instances",
});

// Always fail getCosts with a specific error
await injectFault({
  operation: "getCosts",
  alwaysFail: true,
  errorCode: "AccessDenied",
  errorMessage: "User is not authorized to access Cost Explorer",
});

// Add 500ms latency to all operations
await setGlobalLatency(500);
```

### Listing Scenarios

```typescript
const scenarios = getAvailableScenarios();
console.log("Available scenarios:");
for (const scenario of scenarios) {
  console.log(`  - ${scenario.name}: ${scenario.description}`);
}
```

### Getting Current Scenario

```typescript
const current = await getCurrentScenario();
console.log(`Current scenario: ${current}`);
```

## Testing

Run the test script to verify the scenario engine:

```bash
pnpm tsx scripts/test-scenarios.ts
```

This will:
1. List all available scenarios
2. Apply the default scenario
3. Apply the running scenario
4. Apply the high-cost scenario
5. Apply the errors scenario
6. Clear all faults and reset to default

## Acceptance Criteria Met

✅ All 10 built-in scenarios can be applied
✅ Scenarios modify state store correctly
✅ Fault injection works per-operation
✅ Scenarios are selectable at runtime
✅ State persists in mock state store

## Next Steps

The scenario engine is now ready for integration with:
1. Dev-only API endpoints (`/api/dev/mock/*`) for runtime scenario control
2. E2E test scenarios for deterministic testing
3. UI controls for developers to switch scenarios during development

## Notes

- The `applyFaultInjection()` helper is called at the start of every operation
- Fault injection is applied before any operation logic executes
- Global latency is applied after fault checks but before operation logic
- The `errors` scenario demonstrates comprehensive fault injection for error handling tests
- All scenarios reset the state store before applying their specific configuration