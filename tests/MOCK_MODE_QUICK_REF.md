# Mock Mode E2E Tests - Quick Reference

## Quick Start

```bash
# Run all mock mode E2E tests
pnpm test:e2e tests/mock-mode-e2e.spec.ts

# Run with Playwright UI (interactive)
pnpm test:e2e:ui tests/mock-mode-e2e.spec.ts

# Run specific test
pnpm test:e2e tests/mock-mode-e2e.spec.ts -g "Status Page"
```

## Test Coverage

| Test | Scenario | Verifies |
|------|----------|----------|
| Status Page | `running` | Server status, IP, costs, player count |
| Start Flow | `default` → `running` | Stopped → Starting → Running transition |
| Stop Flow | `running` → `default` | Running → Stopping → Stopped transition |
| Backup Error | `running` + fault | Error message display on backup failure |
| Backup Success | `running` | Successful backup completion |
| Scenario Switching | Multiple | Correct state transitions |
| High Cost | `high-cost` | Elevated cost display |
| Many Players | `many-players` | High player count display |

## Helper Functions

```typescript
// Set mock scenario
await setScenario(page, "running");

// Inject fault
await injectFault(page, {
  operation: "executeSSMCommand",
  failNext: true,
  errorMessage: "Error message"
});

// Reset mock state
await resetMockState(page);

// Authenticate as dev user
await authenticateAsDev(page);
```

## Available Scenarios

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

## Common Issues

**Tests fail with "Mock control endpoints are only available in mock mode"**
- Playwright config automatically sets `MC_BACKEND_MODE=mock`
- Check `.env.local` has `MC_BACKEND_MODE=mock`

**Tests fail with "Dev login is disabled"**
- Playwright config automatically sets `ENABLE_DEV_LOGIN=true`
- Check `.env.local` has `ENABLE_DEV_LOGIN=true`

**Tests timeout**
- Ensure port 3001 is not blocked
- Check dev server is starting correctly

**Tests fail to find elements**
- Use correct text patterns (e.g., "Online" not "running")
- Ensure page has fully loaded
- Check correct scenario is set

## Files

- `tests/mock-mode-e2e.spec.ts` - Main test file
- `tests/MOCK_MODE_E2E.md` - Detailed documentation
- `playwright.config.ts` - Playwright configuration
- `lib/aws/mock-scenarios.ts` - Scenario definitions
- `app/api/mock/**/route.ts` - Mock control endpoints