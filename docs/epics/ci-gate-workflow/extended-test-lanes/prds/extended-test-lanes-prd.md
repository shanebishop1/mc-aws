# PRD: Extended Test Lanes

**Epic:** CI Gate Workflow  
**Feature:** Extended Test Lanes  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Add path-aware and scheduled extended test lanes so higher-cost suites run deterministically without slowing all pull requests.

## 2) Scope and Non-Goals

### In Scope

- Add CI lane logic for `pnpm test:mock` and `pnpm test:e2e:mock`.
- Trigger extended suites by changed-path policy and nightly schedule.
- Configure concurrency and timeout behavior for heavy jobs.

### Non-Goals

- Making all extended lanes required for every PR.
- Redesigning existing test suites in this feature.

## 3) Impacted Files/Areas

- `.github/workflows/` (new/updated extended lane workflow definitions)
- Test command orchestration around `pnpm test:mock` and `pnpm test:e2e:mock`
- CI maintainer docs under `docs/epics/ci-gate-workflow/`

## 4) Dependencies

- Requires baseline gate feature completion.
- Downstream dependent: branch protection adoption feature uses final lane names/policies.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Change-Aware Lane Selection)
  - T-1.1 | Lane: CIX-L1 | Task: Add changed-path detection outputs
    - Action: Create a reusable CI step/job that emits booleans for high-risk path groups (auth/API/runtime/ui/tests).
    - Definition of Done: Extended lane jobs can conditionally run from explicit changed-path outputs.
  - T-1.2 | Lane: CIX-L1 | Task: Add mock integration lane
    - Action: Add a `pnpm test:mock` lane gated by changed-path outputs with manual override support.
    - Definition of Done: Mock integration lane runs only when conditions match (or manual override is enabled).
- ST-2 (Execution Gate: Heavy Suite Reliability)
  - T-2.1 | Lane: CIX-L2 | Task: Add mock E2E lane with concurrency controls
    - Action: Add `pnpm test:e2e:mock` lane with explicit timeout and superseded-run cancellation policy.
    - Definition of Done: E2E lane is serial/stable in CI and no longer runs concurrently on superseded commits.
  - T-2.2 | Lane: CIX-L2 | Task: Add nightly full extended run
    - Action: Schedule a nightly workflow that executes both extended lanes regardless of changed paths.
    - Definition of Done: A scheduled run exists and executes complete extended coverage at least once per day.

## 6) Acceptance Criteria

- Extended lanes run deterministically from path and schedule rules.
- High-cost suites do not slow unrelated PRs by default.
- Lane behavior (when it runs and why) is transparent to maintainers.
- Extended lane results are available for future required-check policy decisions.
