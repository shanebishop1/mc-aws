# Mock Mode Developer Guide

Mock mode runs the application against a local, stateful `AwsProvider` so UI and API work does not require AWS credentials or resources. For initial setup, use the [five-minute quick start](QUICK_START_MOCK_MODE.md).

## Safety boundaries

- Mock mode is development/test-only. The application refuses to select `MC_BACKEND_MODE=mock` when `NODE_ENV=production`.
- The backend defaults to real AWS when `MC_BACKEND_MODE` is unset. Confirm the mode before invoking cloud-affecting commands.
- Mock control endpoints return 404 outside mock mode. Their mutation routes still require an authenticated `allowed` or `admin` session.
- Mock behavior is representative, not an AWS emulator. Route-backed backup, restore, hibernate, and resume simulate operation acceptance and completion only. They do not model server data, Drive archives, or EBS volume effects.
- Never copy real credentials, tokens, production data, account IDs, or customer data into mock state, fixtures, logs, issues, or test artifacts.

## Start and authenticate

Follow the [Mock Mode Quick Start](QUICK_START_MOCK_MODE.md) for installation and startup. `dev:mock` selects mock mode and enables dev login, but it does **not** log you in. Visit <http://localhost:3000/api/auth/dev-login>; the route sets `mc_session` and redirects home.

Dev login is explicitly enabled, rate-limited, and unavailable in production. It creates the normal admin JWT for `dev@localhost`. The JWT expires after 30 days, while the cookie has no `Max-Age`/`Expires` and is therefore a browser-session cookie. Revisit the route when needed. Do not edit JWT roles in the route to test authorization; cover role behavior with focused auth tests and their existing test doubles.

Useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev:mock` | Start Next.js on port 3000 with mock mode and dev login enabled |
| `pnpm mock:scenario` | Print the current and available scenarios |
| `pnpm mock:scenario <name>` | Reset state, then apply a scenario |
| `pnpm mock:reset` | Reset persisted mock state and faults to defaults |
| `pnpm test:mock` | Run Vitest with mock backend mode selected |
| `pnpm test:e2e:mock` | Run the Playwright suite serially against its managed mock server |

Install Chromium once with `pnpm exec playwright install chromium`. Target the mock spec with `pnpm test:e2e:mock tests/mock-mode-e2e.spec.ts`, or a case with `pnpm test:e2e:mock tests/mock-mode-e2e.spec.ts -g "Start Flow"`.

## Scenarios and test lifecycle

Scenarios are code-defined snapshots. Do not maintain a duplicate name list in documentation; discover the current set and descriptions dynamically:

```bash
pnpm mock:scenario
curl http://localhost:3000/api/mock/scenario
```

Each scenario resets state before applying its overrides. For deterministic E2E coverage, follow the contract used by `tests/mock-mode-e2e.spec.ts`:

1. Authenticate through `/api/auth/dev-login`.
2. Reset through authenticated `POST /api/mock/reset`.
3. Apply the required scenario or fault.
4. Exercise the route/UI and assert observable behavior.
5. Reset again in cleanup, including after failures.

The Playwright configuration starts its own mock server, enables dev login, and uses one worker. Do not advertise or depend on skipped tests as coverage.

## Mock control API

All endpoints require mock mode. “Auth” below means an `allowed` or `admin` session is required.

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/mock/state` | No | Inspect state, parameters, backups, costs, stack, and faults |
| `GET` | `/api/mock/scenario` | No | List scenarios and the current scenario |
| `POST` | `/api/mock/scenario` | Yes | Apply `{ "scenario": "<name>" }` |
| `POST` | `/api/mock/reset` | Yes | Restore defaults and clear runtime state |
| `GET` | `/api/mock/fault` | No | Inspect operation failures and global latency |
| `POST` | `/api/mock/fault` | Yes | Configure an operation failure and/or global latency |
| `DELETE` | `/api/mock/fault` | Yes | Clear all faults, or one via `?operation=<name>` |
| `POST` | `/api/mock/patch` | Yes | Patch supported state sections for focused tests |

**`GET /api/mock/state` is unauthenticated. It exposes every mock parameter value, including plaintext values that represent `SecureString` or other secret-like data. Never put real secrets or sensitive data in mock state.**

Use a cookie jar when calling mutation endpoints outside the browser:

```bash
# Server must already be running with AUTH_SECRET configured.
cookie_jar="$(mktemp)"
trap 'rm -f "$cookie_jar"' EXIT
curl -sS -L -c "$cookie_jar" \
  http://localhost:3000/api/auth/dev-login >/dev/null
curl -sS -b "$cookie_jar" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"running"}' \
  http://localhost:3000/api/mock/scenario
curl -sS -b "$cookie_jar" -X POST \
  http://localhost:3000/api/mock/reset
```

Treat cookie jars as credentials: keep them outside the repository, do not share them, and delete them after use.

## Fault injection

Faults use provider operation names. Read `AwsProvider` and `mock-provider.ts` for supported operations rather than copying a list into tests or docs. The commands below reuse the authenticated `cookie_jar` above.

```bash
# Fail the next start attempt.
curl -sS -b "$cookie_jar" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"operation":"startInstance","failNext":true,"errorCode":"InstanceLimitExceeded","errorMessage":"Injected failure"}' \
  http://localhost:3000/api/mock/fault

# Add global provider latency in milliseconds (the operation field is required).
curl -sS -b "$cookie_jar" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"operation":"getCosts","latency":750}' \
  http://localhost:3000/api/mock/fault

# Clear one fault, or omit the query string to clear every fault and latency.
curl -sS -b "$cookie_jar" -X DELETE \
  'http://localhost:3000/api/mock/fault?operation=startInstance'
curl -sS -b "$cookie_jar" -X DELETE \
  http://localhost:3000/api/mock/fault
```

`failNext` affects the next matching provider call; `alwaysFail` remains until cleared. Latency is global. Clearing one fault leaves latency in place; clearing all faults also clears scenario tracking but does not undo its state. Reset to restore defaults and clear in-process transition timers.

## Persistence and sensitivity

Development and Playwright server runtimes persist mock state automatically to repository-root `.mock-state.json`; unit tests normally use in-memory state, although reset helpers can rewrite the ignored file. The path and startup scenario are not configurable.

Writes use atomic replacement, but locking is process-local; avoid concurrent mutations from separate runtimes. The file is local state, not a fixture or durable storage model. **It stores `SecureString`-like and other parameter values as plaintext, and unauthenticated `GET /api/mock/state` exposes them.** Timers are not persisted. Never commit, upload, or attach `.mock-state.json`; reset or delete it if it may contain sensitive values.

## Extending mock mode

Follow the [AWS Provider Extension Contract](provider-implementation.md). Keep non-mock 404 guards, require authentication on every mutation, and preserve authenticate → reset → scenario → assert → reset for browser coverage.

## Troubleshooting and source map

- **AWS calls occur:** stop the server and use `pnpm dev:mock`; mode is cached with the selected provider for that process.
- **Dev login is 403:** use `dev:mock` or set `ENABLE_DEV_LOGIN=true`, ensure `AUTH_SECRET` exists, then restart. A 404 indicates production mode.
- **Mutation is 401/403:** visit dev login in the same browser, or send the `mc_session` cookie with the API request.
- **Scenario appears stale:** reset, apply the scenario after the server starts, and reload the page. Inspect `/api/mock/state` and `.mock-state.json` without sharing sensitive contents.
- **Transitions leak between tests:** always perform authenticated cleanup; reset clears registered timers.
- **E2E fails to start:** free port 3000, install Chromium, and let Playwright manage the server rather than reusing one.

Implementation map: provider selection is in `lib/aws/provider-selector.ts`; the contract is `lib/aws/types.ts`; behavior is in `lib/aws/mock-provider.ts`; state/persistence is in `lib/aws/mock-state-store.ts`; scenarios/faults are in `lib/aws/mock-scenarios.ts`; controls are under `app/api/mock/`; dev auth is `app/api/auth/dev-login/route.ts`; browser coverage is `tests/mock-mode-e2e.spec.ts` and `playwright.config.ts`.
