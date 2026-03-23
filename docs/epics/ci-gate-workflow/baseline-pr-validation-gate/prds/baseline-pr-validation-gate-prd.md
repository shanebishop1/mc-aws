# PRD: Baseline PR Validation Gate

**Epic:** CI Gate Workflow  
**Feature:** Baseline PR Validation Gate  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Create a deterministic pull-request validation workflow that blocks merge when baseline repository quality checks fail.

## 2) Scope and Non-Goals

### In Scope

- Add a GitHub Actions PR workflow for baseline validation.
- Run `pnpm check`, `pnpm typecheck`, and `pnpm test` as merge-gate checks.
- Ensure failures are obvious by step/job naming and workflow summaries.

### Non-Goals

- Adding E2E-heavy test lanes in this feature (handled by extended lanes feature).
- Deploy automation and release workflows.

## 3) Impacted Files/Areas

- `.github/workflows/` (new baseline PR workflow)
- `package.json` scripts as CI source-of-truth commands (`check`, `typecheck`, `test`)
- `docs/epics/ci-gate-workflow/` planning docs for required check naming

## 4) Dependencies

- Upstream: none (foundational CI feature)
- Downstream dependents:
  - `extended-test-lanes-prd.md`
  - `branch-protection-adoption-prd.md`

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Foundation Baseline Workflow)
  - T-1.1 | Lane: CI-L1 | Task: Create baseline PR workflow scaffold
    - Action: Add a workflow with `pull_request` and `workflow_dispatch` triggers, deterministic Node/pnpm setup, and dependency caching.
    - Definition of Done: A baseline workflow file exists under `.github/workflows/` and runs on PR events against the default branch.
  - T-1.2 | Lane: CI-L1 | Task: Add baseline quality gate commands
    - Action: Execute `pnpm check`, `pnpm typecheck`, and `pnpm test` as distinct named gate steps.
    - Definition of Done: CI output clearly identifies which baseline gate failed and exits non-zero when any gate fails.
- ST-2 (Execution Gate: CI Failure Clarity and Contract)
  - T-2.1 | Lane: CI-L2 | Task: Add workflow summary and failure signal clarity
    - Action: Publish a concise per-run summary that lists baseline gate status and links to failed step logs.
    - Definition of Done: Job summary contains pass/fail entries for each baseline gate in every run.
  - T-2.2 | Lane: CI-L2 | Task: Publish required check name contract
    - Action: Record final baseline check job names in maintainer docs for branch protection configuration.
    - Definition of Done: Maintainer docs include exact status check names that can be marked required.

## 6) Acceptance Criteria

- PRs execute a baseline CI workflow automatically.
- `pnpm check`, `pnpm typecheck`, and `pnpm test` are enforced as merge gates.
- Failing checks are diagnosable without digging through unrelated logs.
- Required-check naming is documented for maintainers.
