# Mock Mode Developer Guide

This guide provides comprehensive documentation for using mock mode in the mc-aws project. Mock mode enables offline development and testing without requiring AWS resources.

## Table of Contents

- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [NPM Scripts](#npm-scripts)
- [Scenarios](#scenarios)
- [Mock Control API](#mock-control-api)
- [Common Development Workflows](#common-development-workflows)
- [Fault Injection](#fault-injection)
- [Persistence](#persistence)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Start Development Server

```bash
# Start in mock mode with dev login enabled
pnpm dev:mock

# The server will be available at http://localhost:3001
# You'll be automatically logged in as an admin user
```

### Run Tests

```bash
# Run E2E tests in mock mode
pnpm test:e2e:mock

# Run unit tests in mock mode
pnpm test:mock
```

### Manage Scenarios

```bash
# List available scenarios
pnpm mock:scenario

# Apply a specific scenario
pnpm mock:scenario running

# Reset to default state
pnpm mock:reset
```

## Environment Variables

Mock mode is controlled by environment variables. These can be set in `.env.local` for local development.

### Required Variables

| Variable            | Description                                      | Example              |
| :------------------ | :----------------------------------------------- | :-------------------- |
| `MC_BACKEND_MODE`   | Backend mode: `aws` or `mock`                    | `mock`                |
| `ENABLE_DEV_LOGIN`  | Enable dev login route for local auth testing    | `true`                |

### Optional Variables

| Variable            | Description                                      | Example              |
| :------------------ | :----------------------------------------------- | :-------------------- |
| `MOCK_STATE_PATH`   | Path for mock state persistence file             | `./mock-state.json`  |
| `MOCK_SCENARIO`     | Default scenario to apply on startup             | `running`             |

### Example `.env.local`

```bash
# Enable mock mode
MC_BACKEND_MODE=mock

# Enable dev login for easy authentication
ENABLE_DEV_LOGIN=true

# Optional: Persist mock state to file
MOCK_STATE_PATH=./mock-state.json

# Optional: Apply default scenario on startup
MOCK_SCENARIO=default
```

## NPM Scripts

Mock mode provides several convenient npm scripts:

### Development

```bash
pnpm dev:mock
```

Starts the Next.js development server in mock mode with:
- `MC_BACKEND_MODE=mock`
- `ENABLE_DEV_LOGIN=true`
- Port 3001

### Testing

```bash
pnpm test:mock
```

Runs Vitest unit tests in mock mode.

```bash
pnpm test:e2e:mock
```

Runs Playwright E2E tests in mock mode.

### Mock Management

```bash
pnpm mock:reset
```

Resets the mock state to default values.

```bash
pnpm mock:scenario
```

Lists all available scenarios.

```bash
pnpm mock:scenario <name>
```

Applies a specific scenario by name.

## Scenarios

Scenarios are predefined states that set up the mock backend for specific testing situations. All scenarios reset the state before applying their configuration.

### Available Scenarios

#### `default`

**Description:** Normal operation, instance stopped with default settings

**State:**
- Instance: `stopped`
- Public IP: None
- Volume: Attached
- Player count: 0
- Backups: 3 sample backups

**Use case:** Baseline state for testing

#### `running`

**Description:** Instance is already running with public IP assigned

**State:**
- Instance: `running`
- Public IP: `203.0.113.42`
- Volume: Attached
- Player count: 5

**Use case:** Testing UI when server is active

#### `starting`

**Description:** Instance is in pending state, transitioning to running

**State:**
- Instance: `pending`
- Public IP: None
- Volume: Attached

**Use case:** Testing loading states and transitions

#### `stopping`

**Description:** Instance is in stopping state, transitioning to stopped

**State:**
- Instance: `stopping`
- Public IP: `203.0.113.42`
- Volume: Attached

**Use case:** Testing shutdown transitions

#### `hibernated`

**Description:** Instance is stopped without volumes (hibernated state)

**State:**
- Instance: `stopped`
- Public IP: None
- Volume: Not attached
- Block device mappings: Empty

**Use case:** Testing hibernation/resume flows

#### `high-cost`

**Description:** Instance with high monthly costs for testing cost alerts

**State:**
- Instance: `running`
- Public IP: `203.0.113.42`
- Current month cost: $125.50
- Last month cost: $118.75
- Last 30 days cost: $244.25

**Use case:** Testing cost alert UI and thresholds

#### `no-backups`

**Description:** No backups available for testing backup error handling

**State:**
- Backups: Empty array

**Use case:** Testing error handling when no backups exist

#### `many-players`

**Description:** Instance running with high player count for testing scaling

**State:**
- Instance: `running`
- Public IP: `203.0.113.42`
- Player count: 18

**Use case:** Testing UI with high player counts

#### `stack-creating`

**Description:** CloudFormation stack is in CREATE_IN_PROGRESS state

**State:**
- Stack exists: `true`
- Stack status: `CREATE_IN_PROGRESS`
- Stack ID: `arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123`

**Use case:** Testing stack deployment flows

#### `errors`

**Description:** All operations fail with errors for testing error handling

**State:**
- `startInstance`: Fails with `InstanceLimitExceeded`
- `stopInstance`: Fails with `IncorrectState`
- `getCosts`: Fails with `AccessDenied`
- `executeSSMCommand`: Fails with `InvalidInstanceId`
- `getStackStatus`: Fails with `ValidationError`
- `checkStackExists`: Fails with `ValidationError`

**Use case:** Comprehensive error handling testing

## Mock Control API

When running in mock mode, you can control the mock state via HTTP endpoints. These endpoints are only available when `MC_BACKEND_MODE=mock`.

### Get Current State

```bash
GET /api/mock/state
```

Returns the complete mock state including instance, SSM parameters, backups, costs, and fault configurations.

**Response:**
```json
{
  "success": true,
  "data": {
    "instance": {
      "instanceId": "i-mock1234567890abcdef",
      "state": "stopped",
      "publicIp": null,
      "hasVolume": true,
      "lastUpdated": "2026-01-30T12:00:00.000Z"
    },
    "ssm": {
      "parameters": {
        "/minecraft/player-count": {
          "value": "0",
          "type": "String",
          "lastModified": "2026-01-30T12:00:00.000Z"
        }
      },
      "commands": []
    },
    "backups": [...],
    "costs": {...},
    "cloudformation": {...},
    "faults": {...}
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

### List Scenarios

```bash
GET /api/mock/scenario
```

Returns all available scenarios and the currently active scenario.

**Response:**
```json
{
  "success": true,
  "data": {
    "currentScenario": "default",
    "availableScenarios": [
      {
        "name": "default",
        "description": "Normal operation, instance stopped with default settings"
      },
      {
        "name": "running",
        "description": "Instance is already running with public IP assigned"
      }
      // ... more scenarios
    ]
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

### Apply Scenario

```bash
POST /api/mock/scenario
Content-Type: application/json

{
  "scenario": "running"
}
```

Applies a specific scenario to the mock state.

**Response:**
```json
{
  "success": true,
  "data": {
    "scenario": "running",
    "message": "Scenario \"running\" applied successfully"
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

### Reset State

```bash
POST /api/mock/reset
```

Resets the mock state to default values.

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Mock state reset to defaults successfully"
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

### Inject Faults

```bash
POST /api/mock/fault
Content-Type: application/json

{
  "operation": "startInstance",
  "failNext": true,
  "errorCode": "InstanceLimitExceeded",
  "errorMessage": "You have reached the maximum number of running instances"
}
```

Injects fault configuration for a specific operation.

**Response:**
```json
{
  "success": true,
  "data": {
    "operation": "startInstance",
    "message": "Fault injected successfully"
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

## Common Development Workflows

### Testing Start/Stop Flows

```bash
# 1. Reset to default state (server stopped)
pnpm mock:reset

# 2. Start dev server
pnpm dev:mock

# 3. Use the web UI or API to start the server
curl -X POST http://localhost:3001/api/start

# 4. Check the state transitions
curl http://localhost:3001/api/status
# Should show: stopped → pending → running

# 5. Stop the server
curl -X POST http://localhost:3001/api/stop

# 6. Verify state returns to stopped
curl http://localhost:3001/api/status
```

### Testing Error Scenarios

```bash
# 1. Apply the errors scenario
pnpm mock:scenario errors

# 2. Start dev server
pnpm dev:mock

# 3. Try to start the server (will fail)
curl -X POST http://localhost:3001/api/start

# 4. Verify error handling in UI
# The UI should display the error message gracefully

# 5. Reset when done
pnpm mock:reset
```

### Testing UI States

```bash
# 1. Apply the high-cost scenario
pnpm mock:scenario high-cost

# 2. Start dev server
pnpm dev:mock

# 3. Open http://localhost:3001 in your browser

# 4. Verify:
#    - Cost dashboard shows high costs
#    - Cost alerts and warnings are displayed
#    - Cost breakdown is accurate

# 5. Test with different scenarios
pnpm mock:scenario running
# Refresh browser and verify UI updates
```

### Testing Backup/Restore Flows

```bash
# 1. Apply default scenario (has backups)
pnpm mock:reset

# 2. Start dev server
pnpm dev:mock

# 3. List backups
curl http://localhost:3001/api/backups

# 4. Create a backup
curl -X POST http://localhost:3001/api/backup

# 5. Restore from backup
curl -X POST http://localhost:3001/api/restore \
  -H "Content-Type: application/json" \
  -d '{"backupName": "backup-2026-01-30"}'

# 6. Test with no backups scenario
pnpm mock:scenario no-backups
# Verify error handling when no backups exist
```

### Testing Hibernation/Resume

```bash
# 1. Apply hibernated scenario
pnpm mock:scenario hibernated

# 2. Start dev server
pnpm dev:mock

# 3. Verify state shows hibernated (no volume)
curl http://localhost:3001/api/status

# 4. Resume from hibernation
curl -X POST http://localhost:3001/api/resume

# 5. Verify volume is created and instance starts
curl http://localhost:3001/api/status

# 6. Hibernate again
curl -X POST http://localhost:3001/api/hibernate

# 7. Verify volume is deleted
curl http://localhost:3001/api/status
```

## Fault Injection

Fault injection allows you to simulate AWS API failures for testing error handling.

### Fault Types

#### Fail Next

The next call to the operation will fail, then the fault is cleared.

```bash
curl -X POST http://localhost:3001/api/mock/fault \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "startInstance",
    "failNext": true,
    "errorCode": "InstanceLimitExceeded",
    "errorMessage": "You have reached the maximum number of running instances"
  }'
```

#### Always Fail

All calls to the operation will fail until the fault is cleared.

```bash
curl -X POST http://localhost:3001/api/mock/fault \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "getCosts",
    "alwaysFail": true,
    "errorCode": "AccessDenied",
    "errorMessage": "User is not authorized to access Cost Explorer"
  }'
```

#### Latency Injection

Add artificial delay to operations for testing loading states.

```bash
curl -X POST http://localhost:3001/api/mock/fault \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "startInstance",
    "latency": 5000
  }'
```

### Clearing Faults

```bash
# Clear a specific fault
curl -X POST http://localhost:3001/api/mock/fault \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "startInstance",
    "clear": true
  }'

# Or use the errors scenario to set multiple faults
pnpm mock:scenario errors

# Then reset to clear all faults
pnpm mock:reset
```

### Available Operations for Fault Injection

- `startInstance` - Start EC2 instance
- `stopInstance` - Stop EC2 instance
- `getInstanceState` - Get instance state
- `executeSSMCommand` - Execute SSM command
- `getSSMParameter` - Get SSM parameter
- `setSSMParameter` - Set SSM parameter
- `getCosts` - Get cost data
- `getStackStatus` - Get CloudFormation stack status
- `checkStackExists` - Check if stack exists

## Persistence

Mock state can optionally be persisted to a JSON file for debugging and issue reproduction.

### Enable Persistence

Add to `.env.local`:

```bash
MOCK_STATE_PATH=./mock-state.json
```

The state will be automatically saved to this file on every change.

### Use Cases

1. **Debugging**: Inspect the state after a test run
2. **Reproduction**: Share the state file to reproduce issues
3. **Development**: Save interesting states for later testing

### Example

```bash
# Enable persistence
echo "MOCK_STATE_PATH=./mock-state.json" >> .env.local

# Apply a scenario
pnpm mock:scenario running

# Start dev server
pnpm dev:mock

# Make some changes via the API
curl -X POST http://localhost:3001/api/start

# Check the persisted state
cat mock-state.json

# The file contains the complete mock state
# You can share this file to reproduce the exact state
```

## Troubleshooting

### Mock Mode Not Working

**Problem:** Application is still trying to connect to AWS

**Solution:** Verify `MC_BACKEND_MODE=mock` is set:

```bash
# Check the environment variable
echo $MC_BACKEND_MODE

# Or use the dev:mock script which sets it automatically
pnpm dev:mock
```

### Scenarios Not Applying

**Problem:** Scenario changes don't seem to take effect

**Solution:** Ensure you're running in mock mode and restart the dev server:

```bash
# Stop the dev server (Ctrl+C)

# Reset state
pnpm mock:reset

# Apply scenario
pnpm mock:scenario running

# Start dev server
pnpm dev:mock
```

### Authentication Issues

**Problem:** Can't access protected endpoints in mock mode

**Solution:** Enable dev login:

```bash
# Add to .env.local
ENABLE_DEV_LOGIN=true

# Visit the dev login route
open http://localhost:3001/api/auth/dev-login

# You'll be logged in as an admin user
```

### State Not Persisting

**Problem:** Mock state resets on server restart

**Solution:** Enable persistence:

```bash
# Add to .env.local
MOCK_STATE_PATH=./mock-state.json

# Restart the dev server
# State will now persist across restarts
```

### Tests Failing in Mock Mode

**Problem:** Tests pass in AWS mode but fail in mock mode

**Solution:** Check for AWS-specific behavior:

1. Verify the scenario matches your test expectations
2. Check for timing issues (mock mode is instant, AWS has latency)
3. Ensure fault injection is cleared between tests
4. Verify authentication is properly mocked

```bash
# Reset state before tests
pnpm mock:reset

# Run tests
pnpm test:e2e:mock
```

### Port Already in Use

**Problem:** Can't start dev server, port 3001 is in use

**Solution:** Kill the existing process or use a different port:

```bash
# Find and kill the process
lsof -ti:3001 | xargs kill -9

# Or use a different port
MC_BACKEND_MODE=mock ENABLE_DEV_LOGIN=true next dev -p 3002
```

## Best Practices

1. **Always reset between test runs**: Use `pnpm mock:reset` to ensure a clean state
2. **Use scenarios for setup**: Apply scenarios instead of manually configuring state
3. **Test error cases**: Use the `errors` scenario to verify error handling
4. **Enable persistence for debugging**: Use `MOCK_STATE_PATH` when investigating issues
5. **Keep tests isolated**: Each test should reset state and apply its own scenario
6. **Document custom scenarios**: If you create custom scenarios, document their purpose

## Additional Resources

- [README.md](../README.md) - Main project documentation
- [Mock Scenarios Implementation](./mock-scenarios-implementation.md) - Technical details
- [Mock State Store](./mock-state-store-implementation.md) - State management
- [Mock Provider](./mock-provider-implementation.md) - AWS client mocking

## Support

If you encounter issues not covered in this guide:

1. Check the [troubleshooting section](#troubleshooting)
2. Review the mock state using `/api/mock/state`
3. Enable persistence and inspect the state file
4. Check the console logs for error messages
5. Open an issue on GitHub with details about your scenario