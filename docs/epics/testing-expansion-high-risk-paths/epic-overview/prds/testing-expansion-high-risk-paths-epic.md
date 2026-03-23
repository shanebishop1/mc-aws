# Epic: Testing Expansion for High-Risk API/Auth Paths and Critical Hooks/Components

**Epic ID (doc-local):** EPIC-TESTING-EXPANSION-HIGH-RISK-PATHS  
**Status:** Draft (approved direction, pending feature/task decomposition)  
**Owner:** Planning

## 1) Problem Statement

The codebase has valuable test coverage already, but high-risk auth/API flows and complex client state logic still present regression risk. Routes like `/api/auth/login`, `/api/auth/callback`, and status/rate-limited endpoints, along with hooks/components such as `useServerStatus`, `auth-provider`, and `ControlsSection`, contain branching behavior and side effects that are costly to break in production.

## 2) Goals and Non-Goals

### Goals

- Expand test depth on high-risk auth and API control paths.
- Add focused coverage for critical hooks/components with state transitions and permission logic.
- Reduce regressions from edge cases (rate limiting, cookie/session handling, action-state transitions).
- Align tests with CI gate so quality bars are consistently enforced.

### Non-Goals

- Chasing blanket 100% repository coverage.
- Replacing E2E with unit tests (or vice versa); this is a layered strategy.
- Major product behavior changes solely to make tests easier.

## 3) Scope

### In Scope

- High-risk API/auth routes (at minimum):
  - `/api/auth/login`
  - `/api/auth/callback`
  - `/api/auth/me`
  - `/api/auth/logout`
  - `/api/status`, `/api/service-status`, `/api/stack-status`
- Critical client logic:
  - `hooks/useServerStatus.ts`
  - `components/auth/auth-provider.tsx`
  - `components/ControlsSection.tsx`
- Test layers:
  - unit + integration for deterministic logic
  - selective E2E for high-value user journeys and failure paths

### Out of Scope

- Broad snapshot-driven testing across all UI components.
- Performance benchmarking suite for every endpoint (unless tied to a specific risk).

## 4) Success Metrics

- Agreed high-risk route/component matrix is fully covered by deterministic tests.
- New tests are included in CI required checks.
- Regression escapes in covered paths trend downward over 30-60 days.
- Flaky test rate for newly added tests remains below agreed threshold (to define in decomposition).

## 5) Risks and Mitigations

- **Risk:** Test brittleness due to timers/network/auth redirects.  
  **Mitigation:** Stable mocks, explicit clock control, and clear test harness boundaries.
- **Risk:** Longer CI times from expanded test suite.  
  **Mitigation:** Layered suites, parallel lanes, and targeted E2E scope.
- **Risk:** False confidence from shallow assertions.  
  **Mitigation:** Define behavior-first assertions and edge-case matrices per critical path.

## 6) Dependencies

- CI gate workflow epic (to enforce test execution as merge gate).
- Durable runtime state epic (new behavior requires corresponding assertions).
- Existing Vitest/Playwright setup and mock infrastructure.

## 7) Durable Objects vs KV Note (Project Context)

This testing epic must validate whichever durable-state strategy is adopted.

- **Durable Objects:** Validate strong-consistency behavior for rate-limit counters and coordination.
- **KV:** Validate tolerated staleness boundaries for cache-like read paths.

**Recommendation for project context:** Treat **DO behavior as correctness-critical** in tests, and treat **KV as optional/auxiliary** with explicit staleness-tolerant assertions.

## 8) Acceptance Criteria

- A high-risk test matrix exists and maps endpoints/hooks/components to concrete test types.
- Auth route tests cover success + key failure paths (state mismatch, missing params/cookies, rate limit conditions).
- Status/rate-limit route tests cover cache and throttle behavior.
- Critical hook/component tests cover role-based action gating and pending-action transitions.
- New/updated tests are wired into required CI checks.
