# PRD: Workstream 3 - Production-Like Smoke Verification

**Epic:** High-Signal Improvements Implementation  
**Feature:** Workstream 3: Production-Like Smoke Verification  
**Status:** Draft (execution-ready with upstream gates)  
**Owner:** Planning

## 1) Objective

Add a narrow, reproducible real-environment confidence lane that validates infra/runtime compatibility before trust in deployment changes.

## 2) Scope and Non-Goals

### In Scope

- Story 3.1 through 3.4 from the source plan.

### Non-Goals

- Destructive production operations.
- Full end-to-end functional parity with existing mock suites.

## 3) Impacted Files/Areas

- `.github/workflows/*`
- `scripts/` and/or `tests/` smoke harness files
- CI gate docs/runbooks under `docs/epics/**`

## 4) Dependencies

- Upstream: Workstream 2 and Workstream 5 guardrails

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Smoke Contract and Workflow)
  - T-3.1 | Lane: WS3-L1 | Task: Define minimal real-environment smoke contract
    - Action: Specify non-destructive smoke scope, guarantees, and explicit non-goals for real-environment compatibility checks.
    - Artifact: `docs/epics/high-signal-improvements-implementation/production-like-smoke-verification/minimum-real-environment-smoke-contract.md`
    - Definition of Done: Smoke contract is documented, scoped, and approved for scheduled/manual execution.
  - T-3.2 | Lane: WS3-L1 | Task: Build dedicated scheduled/manual smoke workflow
    - Action: Implement a dedicated workflow with clear trigger, concurrency, timeout, and reporting behavior distinct from mock lanes.
    - Definition of Done: Real-environment smoke workflow runs manually and on schedule with unambiguous result reporting.
- ST-2 (Execution Gate: Safe Access and Operations Runbook)
  - T-3.3 | Lane: WS3-L2 | Task: Provision least-privilege smoke credentials and target environment
    - Action: Create scoped CI credentials/secrets and bind smoke lane to dedicated low-risk environment with destructive actions gated/excluded.
    - Definition of Done: Smoke lane runs with least privilege against dedicated environment and disallows destructive operations by default.
  - T-3.4 | Lane: WS3-L2 | Task: Add maintainer smoke runbook and failure triage guide
    - Action: Document rerun/debug steps, common failure modes, escalation, and release-blocking criteria.
    - Artifact: `docs/epics/high-signal-improvements-implementation/production-like-smoke-verification/maintainer-smoke-runbook-and-failure-triage.md`
    - Definition of Done: Maintainers can rerun, debug, and triage smoke failures without ad hoc tribal knowledge.

## 6) Acceptance Criteria

- A real-env smoke lane is reproducible, non-destructive by default, and operationally documented.
- Smoke failures are clearly distinguishable from mock/baseline failures.
- Maintainers have explicit rerun and triage guidance.
