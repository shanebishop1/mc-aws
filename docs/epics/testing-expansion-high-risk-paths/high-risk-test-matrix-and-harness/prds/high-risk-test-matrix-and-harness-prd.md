# PRD: High-Risk Test Matrix and Harness

**Epic:** Testing Expansion for High-Risk Paths  
**Feature:** High-Risk Test Matrix and Harness  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Create a deterministic high-risk coverage matrix and reusable test harness utilities so auth/API/runtime regressions can be tested consistently.

## 2) Scope and Non-Goals

### In Scope

- Define matrix rows for required auth routes, status routes, hooks, and components.
- Add reusable fixtures/helpers for cookies, rate-limit windows, and durable-state stubs.
- Align matrix rows to CI lane ownership (baseline vs extended).

### Non-Goals

- Implementing all test cases in this feature.
- Increasing coverage for low-risk components outside the approved matrix.

## 3) Impacted Files/Areas

- `docs/epics/testing-expansion-high-risk-paths/` (matrix documentation)
- `tests/` shared helpers and fixtures
- `tests/setup.ts` and related harness modules
- CI docs for mapping matrix rows to gate lanes

## 4) Dependencies

- Requires baseline CI gate feature so matrix-to-lane mapping is meaningful.
- Foundation for downstream auth/runtime/UI test suite features.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Coverage Contract)
  - T-1.1 | Lane: TEST-M1 | Task: Publish high-risk coverage matrix
    - Action: Document endpoint/hook/component scenarios, test layer type, and required assertions per row.
    - Definition of Done: Matrix doc exists and includes all mandatory routes/components from epic scope.
  - T-1.2 | Lane: TEST-M1 | Task: Build shared deterministic fixtures
    - Action: Add reusable fixture utilities for auth cookies, fixed time windows, and runtime-state stubs.
    - Definition of Done: New tests can import shared fixtures without ad-hoc cookie/time mocking.
- ST-2 (Execution Gate: CI Alignment + Flake Controls)
  - T-2.1 | Lane: TEST-M2 | Task: Map matrix rows to CI lanes
    - Action: Associate each matrix row with baseline (`pnpm test`) or extended lanes and document the mapping.
    - Definition of Done: Every matrix row specifies where it runs in CI and why.
  - T-2.2 | Lane: TEST-M2 | Task: Define flake triage policy for new suites
    - Action: Document rerun, quarantine, and unquarantine criteria for newly added high-risk tests.
    - Definition of Done: Flake policy is actionable and referenced by maintainers.

## 6) Acceptance Criteria

- A complete high-risk matrix exists and is reviewable.
- Shared fixtures reduce duplicate setup logic in new tests.
- Matrix-to-CI mapping is explicit and enforceable.
- Flake management expectations are documented before broad test expansion.
