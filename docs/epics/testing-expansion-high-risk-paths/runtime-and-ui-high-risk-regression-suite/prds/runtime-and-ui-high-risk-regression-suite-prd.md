# PRD: Runtime and UI High-Risk Regression Suite

**Epic:** Testing Expansion for High-Risk Paths  
**Feature:** Runtime and UI High-Risk Regression Suite  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Expand regression coverage for high-risk status/rate-limit routes and critical client state paths (`useServerStatus`, `auth-provider`, `ControlsSection`) with deterministic assertions.

## 2) Scope and Non-Goals

### In Scope

- Add route-level tests for `/api/status`, `/api/service-status`, and `/api/stack-status` rate-limit and cache semantics.
- Add durable-state assertion coverage for authoritative counters and staleness-tolerant snapshots.
- Add hook/component tests for pending-action transitions, focus/idle behavior, role-gated controls, and sign-in/start flow behavior.
- Add one selective high-value E2E assertion path for control flow integrity.

### Non-Goals

- Full UI snapshot testing across the application.
- Broad E2E expansion outside defined high-risk scenarios.

## 3) Impacted Files/Areas

- `app/api/status/route.test.ts` and related status route tests
- New tests for `app/api/service-status/route.ts` and `app/api/stack-status/route.ts`
- New tests for `hooks/useServerStatus.ts`
- New tests for `components/auth/auth-provider.tsx`
- New tests for `components/ControlsSection.tsx`
- selective E2E coverage in `tests/e2e/`

## 4) Dependencies

- Requires high-risk matrix/harness feature completion.
- Should sequence after durable-state migration features for final authoritative/staleness assertions.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Runtime Route Regression Depth)
  - T-1.1 | Lane: TEST-R1 | Task: Add status route cache and throttle contract tests
    - Action: Add deterministic tests for `Retry-After`, `429`, and `X-*-Cache` hit/miss behavior on status/service-status/stack-status routes.
    - Definition of Done: Each route has explicit tests for cache warm/cold and throttle boundary behavior.
  - T-1.2 | Lane: TEST-R1 | Task: Add durable-state correctness and staleness assertions
    - Action: Add tests that enforce DO-authoritative counter behavior and explicitly tolerate bounded KV snapshot staleness.
    - Definition of Done: Runtime tests distinguish strict consistency checks from staleness-tolerant snapshot checks.
- ST-2 (Execution Gate: Critical Client Logic Regression Depth)
  - T-2.1 | Lane: TEST-R2 | Task: Add useServerStatus transition and timer tests
    - Action: Use fake timers and query mocks to assert pending-action timeout, focus-triggered refetch, and player refresh transitions.
    - Definition of Done: Hook tests deterministically cover transition logic without flakiness.
  - T-2.2 | Lane: TEST-R2 | Task: Add auth-provider and ControlsSection permission-flow tests
    - Action: Cover role-gated controls, unauthenticated start/login prompting, and primary action behavior with one targeted E2E assertion.
    - Definition of Done: Component and targeted E2E tests verify critical permission and action-state behavior end-to-end.

## 6) Acceptance Criteria

- Status and rate-limit route contracts are explicitly regression-tested.
- Durable-state assumptions are encoded into test assertions.
- Critical hook/component behavior is covered with deterministic tests.
- At least one targeted E2E check validates the highest-risk UI action flow.
