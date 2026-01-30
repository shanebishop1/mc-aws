# Mock Mode E2E Tests - Implementation Summary

## Overview

This implementation adds comprehensive Playwright E2E tests for mock mode that validate the full UI workflow using the mock control API. The tests are deterministic, isolated, and fast.

## Files Created/Modified

### New Files

1. **`tests/mock-mode-e2e.spec.ts`** (352 lines)
   - Main test file with 8 comprehensive E2E tests
   - Helper functions for mock control API interactions
   - Test setup and teardown hooks

2. **`tests/MOCK_MODE_E2E.md`** (Documentation)
   - Detailed guide for running and understanding mock mode tests
   - Troubleshooting section
   - Mock control API reference
   - Test structure patterns

3. **`tests/MOCK_MODE_QUICK_REF.md`** (Quick Reference)
   - Quick start commands
   - Test coverage table
   - Common issues and solutions

### Modified Files

1. **`playwright.config.ts`**
   - Updated `testDir` from `./tests/e2e` to `./tests` to include new test file
   - Updated `baseURL` from `http://localhost:3000` to `http://localhost:3001` (matching dev server port)
   - Added environment variables to `webServer.command`: `MC_BACKEND_MODE=mock ENABLE_DEV_LOGIN=true`
   - Increased `timeout` to 120000ms for dev server startup

2. **`README.md`**
   - Added "Mock Mode Testing" section in Local Development Authentication
   - Included quick start commands for E2E tests
   - Added reference to detailed documentation

## Test Coverage

### 1. Status Page Test
- **Scenario**: `running`
- **Verifies**:
  - Server displays as "Online"
  - Public IP (203.0.113.42) is shown
  - Costs are displayed in cost dashboard ($12.50)
  - Player count is shown (5 players online)

### 2. Start Flow Test
- **Scenario**: `default` (stopped) → `running`
- **Verifies**:
  - Initial "Stopped" state
  - "Starting..." state after clicking start
  - Transition to "Online" state
  - Public IP appears after running

### 3. Stop Flow Test
- **Scenario**: `running` → `default` (stopped)
- **Verifies**:
  - Initial "Online" state
  - "Stopping..." state after clicking stop
  - Transition to "Stopped" state
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
  - Cost breakdown shows correct values ($110.00 for EC2)

### 8. Many Players Scenario
- **Scenario**: `many-players`
- **Verifies**:
  - High player count displayed (18 players)

## Helper Functions

### `setScenario(page, scenario)`
Sets the mock scenario via control API (`POST /api/mock/scenario`).

### `injectFault(page, config)`
Injects a fault via control API (`POST /api/mock/fault`).

### `resetMockState(page)`
Resets mock state to defaults (`POST /api/mock/reset`).

### `authenticateAsDev(page)`
Authenticates as dev user using dev login endpoint (`GET /api/auth/dev-login`).

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
  await expect(page.getByText(/online/i)).toBeVisible();
});
```

## Running the Tests

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

## Environment Configuration

The Playwright config automatically sets the required environment variables:

```bash
MC_BACKEND_MODE=mock
ENABLE_DEV_LOGIN=true
```

No manual configuration needed when running tests via Playwright.

## Key Features

1. **Deterministic**: Uses predefined scenarios for consistent test results
2. **Isolated**: Each test resets state before and after execution
3. **Fast**: No AWS resources required, runs against local mock backend
4. **Comprehensive**: Covers status display, start/stop flows, and error handling
5. **Well-documented**: Includes detailed documentation and quick reference

## Acceptance Criteria Met

✅ 4 E2E tests covering status, start, stop, and backup error flows
✅ Tests use mock control API for deterministic state
✅ Tests run successfully with `pnpm test:e2e`
✅ Tests are isolated and don't interfere with each other
✅ Clear documentation on how to run E2E tests in mock mode

## Related Files

- `tests/mock-mode-e2e.spec.ts` - Main test file
- `tests/MOCK_MODE_E2E.md` - Detailed documentation
- `tests/MOCK_MODE_QUICK_REF.md` - Quick reference
- `playwright.config.ts` - Playwright configuration
- `lib/aws/mock-scenarios.ts` - Scenario definitions
- `lib/aws/mock-state-store.ts` - Mock state management
- `app/api/mock/scenario/route.ts` - Scenario control endpoint
- `app/api/mock/fault/route.ts` - Fault injection endpoint
- `app/api/mock/reset/route.ts` - Reset endpoint
- `tests/e2e/helpers.ts` - Test helper functions

## Future Enhancements

Potential additions for future iterations:

1. Add tests for restore flow
2. Add tests for hibernate flow
3. Add tests for email management
4. Add tests for cost dashboard interactions
5. Add visual regression tests
6. Add performance tests
7. Add accessibility tests
8. Add tests for different user roles (admin, allowed, public)