# Mock Mode Developer Guide

This guide provides comprehensive documentation for using mock mode in the mc-aws project. Mock mode enables offline development and testing without requiring AWS resources.

**New to mock mode?** Start with the [Quick Start Guide](QUICK_START_MOCK_MODE.md) to get up and running in 5 minutes.

## Table of Contents

- [Quick Start](#quick-start)
- [Authentication in Mock Mode](#authentication-in-mock-mode)
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

## Authentication in Mock Mode

Mock mode provides a streamlined authentication experience that doesn't require Google OAuth or AWS credentials. This makes local development faster and easier.

### How Dev Login Works

In mock mode, you can use the **dev login** feature to authenticate instantly:

1. Set `ENABLE_DEV_LOGIN=true` in your `.env.local` file
2. Visit `http://localhost:3000/api/auth/dev-login` in your browser
3. You're automatically logged in with a real session cookie (valid for 30 days)

The dev login creates a real JWT token with the following credentials:
- **Email:** `dev@localhost`
- **Role:** `admin` (full access to all features)

### Security Features

The dev login endpoint includes multiple security safeguards:

- **Production blocking:** Returns 404 in production (`NODE_ENV=production`)
- **Explicit opt-in:** Only works when `ENABLE_DEV_LOGIN=true` is set
- **Non-production secret:** Uses your local `AUTH_SECRET` for signing
- **Same session mechanism:** Uses the same JWT verification as production

### Testing Different User Roles

To test different permission levels, you can modify the dev login endpoint:

Edit `app/api/auth/dev-login/route.ts` and change the `role` value:

```typescript
const token = await new SignJWT({
  email: "dev@localhost",
  role: "admin", // Change to "allowed" or "public" to test different roles
})
```

**Role Permissions:**

| Role    | Can View Status | Can Start Server | Can Backup/Restore/Hibernate |
| ------- | --------------- | ---------------- | ---------------------------- |
| `admin` | ✅              | ✅               | ✅                           |
| `allowed` | ✅            | ✅               | ❌                           |
| `public` | ✅             | ❌               | ❌                           |

### Why Use Dev Login?

**Benefits:**
- **Fast:** No Google OAuth flow, no popup windows
- **Deterministic:** Same credentials every time
- **Realistic:** Uses the same session mechanism as production
- **Flexible:** Easy to test different permission levels

**Compared to bypassing auth:**
- Catches auth bugs during development
- Tests the same code paths as production
- No need to remember to re-enable auth before deploying

### Setting Up Dev Login

**Option 1: Using the convenience script (recommended)**

```bash
# The dev:mock script automatically sets both MC_BACKEND_MODE and ENABLE_DEV_LOGIN
pnpm dev:mock
```

**Option 2: Manual configuration**

1. Copy the example configuration:
   ```bash
   cp .env.local.example .env.local
   ```

2. The `.env.local.example` file already has the minimal mock mode configuration:
   ```bash
   MC_BACKEND_MODE=mock
   ENABLE_DEV_LOGIN=true
   AUTH_SECRET=dev-secret-change-in-production
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   ```

3. Start the dev server:
   ```bash
   pnpm dev
   ```

4. Visit the dev login endpoint:
   ```bash
   open http://localhost:3000/api/auth/dev-login
   ```

### Verifying Authentication

After visiting the dev login endpoint, you can verify you're authenticated:

**Via browser:**
- The login button in the header should change to "Sign out"
- You should see admin-only features (cost dashboard, email management)

**Via API:**
```bash
curl http://localhost:3000/api/auth/me
# Returns: {"authenticated":true,"email":"dev@localhost","role":"admin"}
```

### Logging Out

To sign out and test the unauthenticated experience:

```bash
# Via browser: Click "Sign out" button in the header

# Via API:
curl -X POST http://localhost:3000/api/auth/logout
```

### Common Issues

**Dev login returns 403:**
- Ensure `ENABLE_DEV_LOGIN=true` is set in `.env.local`
- Restart the dev server after changing environment variables

**Dev login returns 404:**
- Check that `NODE_ENV` is not set to `production`
- In development, Next.js sets `NODE_ENV=development` automatically

**Session expires quickly:**
- Dev login creates a 30-day session by default
- If you need to refresh, just visit `/api/auth/dev-login` again

**Protected routes still block access:**
- Verify the session cookie was set (check browser dev tools → Application → Cookies)
- Check that `AUTH_SECRET` is set in `.env.local`

### E2E Testing with Dev Login

The mock mode E2E tests use dev login automatically:

```typescript
// From tests/mock-mode-e2e.spec.ts
async function authenticateAsDev(page: any): Promise<void> {
  // Navigate to dev login endpoint (it will set the cookie and redirect)
  await page.goto("/api/auth/dev-login");

  // Wait for redirect to home page
  await page.waitForURL("/");

  // Verify we're authenticated
  const authCheck = await page.request.get("/api/auth/me");
  const authData = await authCheck.json();
  expect(authData.authenticated).toBe(true);
}
```

This ensures tests are fast, deterministic, and don't require real Google OAuth credentials.

## Environment Variables

Mock mode is controlled by environment variables. These can be set in `.env.local` for local development.

### Required Variables

| Variable            | Description                                      | Example              |
| :------------------ | :----------------------------------------------- | :-------------------- |
| `MC_BACKEND_MODE`   | Backend mode: `aws` or `mock`                    | `mock`                |
| `ENABLE_DEV_LOGIN`  | Enable dev login route for local auth testing    | `true`                |
| `AUTH_SECRET`       | Secret for signing JWT tokens                    | `dev-secret-...`      |
| `NEXT_PUBLIC_APP_URL` | App URL for redirects                          | `http://localhost:3000` |

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

# Required for authentication
AUTH_SECRET=dev-secret-change-in-production
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Optional: Persist mock state to file
MOCK_STATE_PATH=./mock-state.json

# Optional: Apply default scenario on startup
MOCK_SCENARIO=default
```

**Note:** AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, etc.) are **not required** in mock mode. The mock backend simulates all AWS operations locally.

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

# Restart the dev server
# (Environment variables are only loaded on startup)

# Visit the dev login route
open http://localhost:3001/api/auth/dev-login

# You'll be logged in as an admin user
```

**Problem:** Dev login returns 403 Forbidden

**Solution:** Verify environment variables:

```bash
# Check that ENABLE_DEV_LOGIN is set
echo $ENABLE_DEV_LOGIN

# If not set, add to .env.local and restart dev server
echo "ENABLE_DEV_LOGIN=true" >> .env.local
pnpm dev:mock
```

**Problem:** Dev login returns 404 Not Found

**Solution:** Check production mode:

```bash
# Ensure NODE_ENV is not "production"
# In development, Next.js sets this automatically
# If you manually set NODE_ENV=production, dev login will be disabled

# Check current value
echo $NODE_ENV

# Unset if needed
unset NODE_ENV
pnpm dev:mock
```

**Problem:** Session cookie not being set

**Solution:** Check AUTH_SECRET:

```bash
# Ensure AUTH_SECRET is set in .env.local
grep AUTH_SECRET .env.local

# If missing, add it:
echo "AUTH_SECRET=dev-secret-change-in-production" >> .env.local

# Restart dev server
pnpm dev:mock
```

**Problem:** Protected routes still block access after dev login

**Solution:** Verify session cookie:

1. Open browser dev tools (F12)
2. Go to Application → Cookies
3. Look for `mc_session` cookie
4. If missing, visit `/api/auth/dev-login` again
5. If present but still blocked, check the cookie value is valid

**Problem:** Want to test different user roles

**Solution:** Modify dev login endpoint:

Edit `app/api/auth/dev-login/route.ts`:

```typescript
// Change role to test different permissions
role: "allowed", // or "public"
```

Then restart dev server and visit `/api/auth/dev-login` again.

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