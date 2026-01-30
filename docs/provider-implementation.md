# Provider Interface and Selector Implementation

## Overview

This document describes the implementation of the provider interface and selector pattern for the mc-aws AWS backend system. This pattern allows the application to switch between real AWS SDK clients and a mock implementation at runtime based on the `MC_BACKEND_MODE` environment variable.

## Files Created

### 1. `lib/aws/types.ts`
**Purpose:** Defines the `AwsProvider` interface that all providers must implement.

**Key Components:**
- `AwsProvider` interface with all 30+ AWS operations
- Supporting types: `InstanceDetails`, `ServerActionLock`, `PlayerCount`, `BackupInfo`
- Uses `ServerState` enum from `lib/types.ts` for type safety

**Operations Defined:**
- **EC2 Instance Management:** `findInstanceId`, `resolveInstanceId`, `getInstanceState`, `getInstanceDetails`, `startInstance`, `stopInstance`, `getPublicIp`, `waitForInstanceRunning`, `waitForInstanceStopped`
- **EC2 Volume Management:** `detachAndDeleteVolumes`, `handleResume`
- **SSM Command Execution:** `executeSSMCommand`, `listBackups`
- **SSM Parameter Store:** `getParameter`, `putParameter`, `deleteParameter`
- **SSM Application-Specific:** `getEmailAllowlist`, `updateEmailAllowlist`, `getPlayerCount`, `getServerAction`, `setServerAction`
- **SSM Action Lock:** `withServerActionLock<T>`
- **Cost Explorer:** `getCosts`
- **CloudFormation:** `getStackStatus`, `checkStackExists`

### 2. `lib/aws/aws-provider.ts`
**Purpose:** Real AWS provider implementation that wraps existing AWS SDK client functions.

**Key Features:**
- Imports all existing AWS client functions from individual modules
- Implements `AwsProvider` interface by delegating to existing functions
- AWS SDK clients are initialized when this module is loaded (in AWS mode)
- Maintains all existing error handling and logging patterns

### 3. `lib/aws/mock-provider.ts`
**Purpose:** Mock AWS provider for testing and local development.

**Key Features:**
- Implements `AwsProvider` interface with stub implementations
- Does NOT initialize any AWS SDK clients (lazy initialization)
- All operations return sensible default values or no-op
- Logs all function calls with `[MOCK]` prefix for debugging
- Examples:
  - `findInstanceId()` returns `"i-mock-instance-id"`
  - `getInstanceState()` returns `ServerState.Stopped`
  - `getPublicIp()` returns `"203.0.113.1"` (RFC 5737 test IP)
  - `listBackups()` returns sample backup data
  - `getCosts()` returns zero costs

### 4. `lib/aws/provider-selector.ts`
**Purpose:** Runtime selector that returns the appropriate provider based on `MC_BACKEND_MODE`.

**Key Features:**
- `getProvider()` function with lazy initialization
- Caches the provider instance after first call
- Checks `env.MC_BACKEND_MODE` to select provider:
  - `"mock"` → returns `mockProvider`
  - `"aws"` or default → returns `awsProvider`
- `resetProvider()` function for testing (clears cache)
- Logs which provider is being used

**Lazy Initialization:**
- AWS SDK clients are only created when `awsProvider` is imported
- In mock mode, `awsProvider` is never imported, so no AWS clients are created
- This is critical for local development without AWS credentials

### 5. `lib/aws/index.ts` (Refactored)
**Purpose:** Main barrel export file that delegates to the selected provider.

**Key Changes:**
- All exported functions now delegate to `getProvider()`
- Maintains the same public API (no breaking changes for API routes)
- Re-exports types and constants for backward compatibility
- Re-exports AWS SDK clients (`ec2`, `ssm`, `cloudformation`) for backward compatibility
- Example:
  ```typescript
  export async function getInstanceState(instanceId?: string) {
    return getProvider().getInstanceState(instanceId);
  }
  ```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     API Routes                               │
│  (import from @/lib/aws - no changes needed)                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              lib/aws/index.ts (Barrel Export)               │
│  - Delegates all functions to selected provider             │
│  - Maintains backward compatibility                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           lib/aws/provider-selector.ts                       │
│  - getProvider() checks MC_BACKEND_MODE                     │
│  - Lazy initialization (caches provider)                    │
└────────────┬────────────────────────────┬───────────────────┘
             │                            │
             ▼                            ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│   aws-provider.ts        │  │   mock-provider.ts       │
│   (Real AWS SDK)         │  │   (No AWS SDK)           │
│                          │  │                          │
│  - Imports existing      │  │  - Stub implementations  │
│    AWS client functions  │  │  - Returns mock data     │
│  - Initializes clients   │  │  - Logs all calls        │
│    on module load        │  │                          │
└──────────────────────────┘  └──────────────────────────┘
             │                            │
             ▼                            ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│  lib/aws/ec2-client.ts   │  │  (No AWS SDK clients)    │
│  lib/aws/ssm-client.ts   │  │                          │
│  lib/aws/volume-client.ts│  │                          │
│  lib/aws/cost-client.ts  │  │                          │
│  lib/aws/cloudformation- │  │                          │
│    client.ts             │  │                          │
└──────────────────────────┘  └──────────────────────────┘
```

## Usage

### For API Routes (No Changes Required)

API routes continue to import from `@/lib/aws` as before:

```typescript
import { getInstanceState, startInstance, stopInstance } from "@/lib/aws";

// Works the same way - automatically uses the selected provider
const state = await getInstanceState();
await startInstance();
```

### For Local Development (Mock Mode)

Set environment variable:
```bash
MC_BACKEND_MODE=mock
```

The application will:
1. Use `mockProvider` instead of real AWS SDK
2. Not require AWS credentials
3. Return mock data for all operations
4. Log all function calls with `[MOCK]` prefix

### For Production (AWS Mode)

Set environment variable (or omit, defaults to `aws`):
```bash
MC_BACKEND_MODE=aws
```

The application will:
1. Use `awsProvider` with real AWS SDK clients
2. Require AWS credentials
3. Make actual AWS API calls
4. Use existing error handling and logging

## Benefits

1. **Zero Breaking Changes:** API routes don't need any modifications
2. **Lazy Initialization:** AWS SDK clients only created when needed
3. **Type Safety:** Full TypeScript support with `AwsProvider` interface
4. **Testability:** Easy to mock for unit tests
5. **Local Development:** Can run without AWS credentials
6. **Maintainability:** Clear separation between interface and implementations
7. **Extensibility:** Easy to add new providers (e.g., localstack, test doubles)

## Future Enhancements

1. **Full Mock Implementation:** The current mock provider is a stub. Future work could implement:
   - In-memory state management (e.g., track instance state changes)
   - Realistic polling simulation
   - Configurable mock responses
   - Stateful mock for testing workflows

2. **Additional Providers:**
   - LocalStack provider for local AWS simulation
   - Test double provider for unit tests
   - Recording/replay provider for integration tests

3. **Provider Configuration:**
   - Per-operation provider selection
   - Provider composition (e.g., mock for SSM, real for EC2)
   - Provider middleware for logging, metrics, etc.

## Testing

To test the provider selector:

```typescript
import { getProvider, resetProvider } from "@/lib/aws/provider-selector";
import { env } from "@/lib/env";

// Test mock mode
env.MC_BACKEND_MODE = "mock";
resetProvider();
const provider = getProvider();
// provider should be mockProvider

// Test AWS mode
env.MC_BACKEND_MODE = "aws";
resetProvider();
const provider = getProvider();
// provider should be awsProvider
```

## Notes

- AWS SDK clients (`ec2`, `ssm`, `cloudformation`) are still exported for backward compatibility, but they will only work in AWS mode
- The mock provider intentionally does not implement complex state management - it's a minimal stub that won't break imports
- All existing error handling patterns and logging prefixes are preserved in the AWS provider
- The provider interface closely matches the existing exports to minimize refactoring effort