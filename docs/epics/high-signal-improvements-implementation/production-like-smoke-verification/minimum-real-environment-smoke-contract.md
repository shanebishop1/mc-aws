# Minimum Real-Environment Smoke Contract (mcaws-a9h.3.1)

## Purpose

Define the minimum, non-destructive smoke checks that must pass in a real environment before maintainers trust deployment/runtime compatibility.

This contract is the implementation target for **mcaws-a9h.3.2** (workflow automation).

## Scope and Non-Goals

### In scope

- Manual + scheduled smoke execution contract.
- Required check sequence.
- Pass/fail signals and hard-fail conditions.
- Operator-facing output expectations.

### Non-goals

- Building the GitHub Actions workflow itself.
- Broad functional or regression coverage (mock lanes own that).
- Destructive operations (start/stop/restore/delete).

## Required Preconditions

- Smoke lane runs against a dedicated low-risk real environment.
- Credentials are least-privilege and scoped to smoke actions only.
- Runtime/deploy guardrails from Workstream 2 and Workstream 5 are already in place.

## Minimum Check Contract (in required order)

| ID | Check | Expected pass signal | Hard-fail conditions |
| --- | --- | --- | --- |
| S1 | Environment/auth bootstrap sanity | Required secrets/env resolved; auth/bootstrap probe returns 2xx | Missing/invalid credentials, missing required env, auth probe non-2xx |
| S2 | Real backend status read | Status endpoint returns success payload from real backend (not mock) | Non-2xx, invalid payload shape, explicit backend/auth/runtime misconfiguration |
| S3 | Safe operation path verification | Safe non-destructive operation path succeeds (dry-run or read-only invoke) | Permission denied, invoke failure, timeout, operation requires unsafe mutation |
| S4 | Runtime-state + DNS/binding health probe | Runtime-state/binding probe confirms configured bindings are reachable and internally consistent | Missing binding, placeholder binding, migration/class mismatch signal, probe failure |
| S5 | Optional backup/environment read probe | Optional read-only probe succeeds when configured; if disabled, output records `skipped` with reason | Probe marked required but fails; unexpected destructive action attempt |

Notes:

- S1-S4 are required for a passing smoke run.
- S5 is optional at contract level but must be explicitly reported as `pass` or `skipped` (never silent).

## Global Hard-Fail Rules

The smoke run must fail immediately when any of these are detected:

1. Missing/invalid smoke credentials or required environment variables.
2. Any endpoint/probe needed by S1-S4 returns non-2xx or invalid contract shape.
3. Any signal that runtime-state config is placeholder, missing, or mismatched.
4. Any step attempts a destructive or state-changing operation outside approved safe scope.
5. Workflow timeout/concurrency cancellation before summary is written.

## Operator-Facing Output Contract

Every smoke run (manual or scheduled) must publish a concise summary with:

1. **Overall verdict**: `PASS` or `FAIL`.
2. **Per-check table** for S1-S5 with: `status`, `primary signal`, `failure hint`.
3. **Environment identity**: target environment label and run timestamp.
4. **Failure routing hint**: whether likely class is `credentials/config`, `runtime-state/deploy`, or `service/runtime`.

Recommended status values:

- `pass`
- `fail`
- `skipped` (allowed only for S5 or explicitly optional checks)

## Workflow Handoff Checklist (for mcaws-a9h.3.2)

- [ ] Implement one workflow that supports both `workflow_dispatch` and schedule triggers.
- [ ] Enforce ordered execution S1 → S2 → S3 → S4 (S5 last, optional).
- [ ] Configure explicit timeout + concurrency guard to avoid overlapping smoke runs.
- [ ] Fail run if any S1-S4 check fails.
- [ ] Emit stable step/check IDs (`S1`..`S5`) in logs and summary.
- [ ] Write a single operator summary artifact (GitHub Step Summary) with required columns.
- [ ] Ensure no destructive operations are invoked in default smoke path.
