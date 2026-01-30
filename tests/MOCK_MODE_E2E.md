# Mock Mode E2E Tests

This document explains how to run the Playwright E2E tests in mock mode.

## Overview

The mock mode E2E tests validate the full UI workflow using the mock control API. These tests are:

- **Deterministic**: Use predefined scenarios to set up specific states
- **Isolated**: Each test resets mock state before and after execution
- **Fast**: No AWS resources required, runs against local mock backend
- **Comprehensive**: Cover status display, start/stop flows, and error handling

## Prerequisites

1. **Environment Variables**: Set up your `.env.local` file:

```bash
# Enable mock backend mode
MC_BACKEND_MODE=mock

# Enable dev login for authentication
ENABLE_DEV_LOGIN=true

# Required for JWT signing (can be any random string)
AUTH_SECRET=your-secret-key-here
```

2. **Dependencies**: Ensure all dependencies are installed:

```bash
pnpm install
```

## Running the Tests

The Playwright config automatically sets `MC_BACKEND_MODE=mock` and `ENABLE_DEV_LOGIN=true` when starting the dev server, so you don't need to set them manually.

### Run all mock mode E2E tests:

```bash
pnpm test:e2e tests/mock-mode-e2e.spec.ts
```

### Run with Playwright UI (interactive mode):

```bash
pnpm test:e2e:ui tests/mock-mode-e2e.spec.ts
```

### Run a specific test:

```bash
pnpm test:e2e tests/mock-mode-e2e.spec.ts -g "Status Page"
```

### Run in headed mode (watch the browser):

```bash
pnpm test:e2e tests/mock-mode-e2e.spec.ts --headed
```

## Test Scenarios

The tests use the mock control API to set up different scenarios:

### 1. Status Page Test
- **Scenario**: `running`
- **Verifies**:
  - Server displays as running
  - Public IP is shown
  - Costs are displayed in cost dashboard
  - Player count is shown

### 2. Start Flow Test
- **Scenario**: `default` (stopped) → `running`
- **Verifies**:
  - Initial stopped state
  - "Starting" state after clicking start
  - Transition to "running" state
  - Public IP appears after running

### 3. Stop Flow Test
- **Scenario**: `running` → `default` (stopped)
- **Verifies**:
  - Initial running state
  - "Stopping" state after clicking stop
  - Transition to "stopped" state
  - Public IP disappears after stopping

### 4. Backup Flow Error Handling
- **Scenario**: `running` + fault injection
- **Verifies**:
  - Backup dialog opens
  - Error message displays when backup fails
  - Dialog closes after error

### 5. Backup Flow Success
- **Scenario**: `running` (no faults)
- **Verifies**:
  - Backup dialog opens
  - Success message displays
  - Dialog closes after success

### 6. Scenario Switching
- **Scenarios**: `default` → `running` → `starting` → `stopping` → `default`
- **Verifies**:
  - Correct state transitions
  - UI updates reflect scenario changes

### 7. High Cost Scenario
- **Scenario**: `high-cost`
- **Verifies**:
  - Elevated costs displayed ($125.50)
  - Cost breakdown shows correct values

### 8. Many Players Scenario
- **Scenario**: `many-players`
- **Verifies**:
  - High player count displayed (18 players)

## Mock Control API

The tests use these mock control endpoints:

### Set Scenario
```typescript
POST /api/mock/scenario
{
  "scenario": "running"
}
```

Available scenarios:
- `default` - Normal operation, instance stopped
- `running` - Instance running with public IP
- `starting` - Instance in pending state
- `stopping` - Instance in stopping state
- `hibernated` - Instance stopped without volumes
- `high-cost` - High monthly costs
- `no-backups` - No backups available
- `many-players` - High player count
- `stack-creating` - CloudFormation stack creating
- `errors` - All operations fail

### Inject Fault
```typescript
POST /api/mock/fault
{
  "operation": "executeSSMCommand",
  "failNext": true,
  "errorCode": "InvalidInstanceId",
  "errorMessage": "Instance not found"
}
```

### Reset State
```typescript
POST /api/mock/reset
```

## Authentication

Tests use the dev login feature for authentication:

```typescript
GET /api/auth/dev-login
```

This creates a session cookie for `dev@localhost` with admin role.

## Test Structure

Each test follows this pattern:

```typescript
test.beforeEach(async ({ page }) => {
  // Reset mock state
  await resetMockState(page);

  // Authenticate as dev user
  await authenticateAsDev(page);
});

test.afterEach(async ({ page }) => {
  // Clean up mock state
  await resetMockState(page);
});

test("Test name", async ({ page }) => {
  // Set scenario
  await setScenario(page, "running");

  // Navigate to page
  await navigateTo(page, "/");

  // Perform actions
  await page.getByRole("button", { name: /start/i }).click();

  // Verify results
  await expect(page.getByText(/running/i)).toBeVisible();
});
```

## Troubleshooting

### Tests fail with "Mock control endpoints are only available in mock mode"

**Solution**: The Playwright config should automatically set `MC_BACKEND_MODE=mock`. If you're still seeing this error, check that:
1. Your `.env.local` file has `MC_BACKEND_MODE=mock`
2. The dev server is starting with the correct environment variables

### Tests fail with "Dev login is disabled"

**Solution**: The Playwright config should automatically set `ENABLE_DEV_LOGIN=true`. If you're still seeing this error, check that:
1. Your `.env.local` file has `ENABLE_DEV_LOGIN=true`
2. The dev server is starting with the correct environment variables

### Tests timeout waiting for state transitions

**Solution**: The mock backend transitions states quickly. If tests timeout, check that:
1. The dev server is running (Playwright starts it automatically)
2. The mock mode is enabled
3. No other processes are blocking port 3001

### Tests fail to find elements

**Solution**: Check that:
1. The page has fully loaded (`waitForPageLoad`)
2. The correct scenario is set
3. The element selectors match the current UI
4. You're using the correct text patterns (e.g., "Online" instead of "running")

## Debugging

### Run tests in headed mode:

```bash
MC_BACKEND_MODE=mock pnpm test:e2e tests/mock-mode-e2e.spec.ts --headed
```

### Run with Playwright Inspector:

```bash
MC_BACKEND_MODE=mock pnpm test:e2e:ui tests/mock-mode-e2e.spec.ts
```

### View trace files:

After test runs, trace files are saved in `test-results/`. View them with:

```bash
npx playwright show-trace test-results/[trace-file].zip
```

## Adding New Tests

To add a new test:

1. Choose an appropriate scenario or create a new one in `lib/aws/mock-scenarios.ts`
2. Add the test to `tests/mock-mode-e2e.spec.ts`
3. Use the helper functions: `setScenario`, `injectFault`, `resetMockState`
4. Follow the test structure pattern above
5. Run the test to verify it works

## Related Files

- `tests/mock-mode-e2e.spec.ts` - Main test file
- `lib/aws/mock-scenarios.ts` - Scenario definitions
- `lib/aws/mock-state-store.ts` - Mock state management
- `app/api/mock/scenario/route.ts` - Scenario control endpoint
- `app/api/mock/fault/route.ts` - Fault injection endpoint
- `app/api/mock/reset/route.ts` - Reset endpoint
- `playwright.config.ts` - Playwright configuration