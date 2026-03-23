# Epic: CI Gate Workflow

**Epic ID (doc-local):** EPIC-CI-GATE-WORKFLOW  
**Status:** Draft (approved direction, pending feature/task decomposition)  
**Owner:** Planning

## 1) Problem Statement

The repository currently relies on local/manual quality checks (`pnpm check`, `pnpm typecheck`, `pnpm test`, optional E2E), with no standardized pull-request gate in GitHub Actions. This creates merge-risk for regressions in API/auth behavior, typed contracts, and formatting/linting compliance.

## 2) Goals and Non-Goals

### Goals

- Establish a deterministic CI gate for pull requests.
- Enforce baseline quality checks before merge (format/lint, typecheck, unit tests).
- Produce actionable failures (which step failed, fast feedback).
- Keep runtime practical for frequent contributor use.

### Non-Goals

- Full production deployment automation in this epic.
- Replacing local developer workflows; CI complements local checks.
- Exhaustive E2E on every single push if it causes unacceptable cycle time.

## 3) Scope

### In Scope

- GitHub Actions workflow(s) for PR validation.
- Baseline command gates aligned with repo scripts:
  - `pnpm check`
  - `pnpm typecheck`
  - `pnpm test`
- Optional lane strategy for heavier suites (`pnpm test:mock`, `pnpm test:e2e:mock`) based on changed paths and/or schedule.
- Branch protection/status check naming guidance for maintainers.

### Out of Scope

- CDK deployment orchestration.
- Runtime infrastructure redesign (covered by durable-state epic).
- New feature implementation unrelated to quality gates.

## 4) Success Metrics

- 100% of PRs to protected branches execute the CI gate.
- Required checks block merge on failure.
- CI median duration remains within agreed budget (target to define in decomposition; suggested <10 min for baseline lane).
- Post-merge break/fix incidents from lint/type/unit regressions trend downward over 30 days.

## 5) Risks and Mitigations

- **Risk:** Flaky tests erode trust in CI.  
  **Mitigation:** Quarantine flaky suites, separate baseline vs extended lanes, stabilize mocks/timers.
- **Risk:** Slow CI discourages iteration.  
  **Mitigation:** Cache dependencies, parallelize jobs, path-aware gating for expensive suites.
- **Risk:** Command drift between local and CI.  
  **Mitigation:** Reuse package scripts as source-of-truth.

## 6) Dependencies

- GitHub repository settings (branch protection + required status checks).
- Stable test commands and environment assumptions in `package.json`.
- Follow-on testing-expansion epic for richer confidence signals.

## 7) Durable Objects vs KV Note (Project Context)

Even though this epic is CI-focused, CI must validate the runtime-state strategy selected by the durable-state epic.

- **Durable Objects (DO):** Strong consistency and per-key coordination; best for authoritative mutable state (rate-limit counters).
- **KV:** Fast, globally distributed reads with eventual consistency; best for read-mostly snapshots/caches.

**Recommendation for project context:** Standardize on **DO as the authoritative state mechanism** for mutable coordination, with **KV as optional read-through cache** for non-critical snapshot distribution. CI should include tests that assert this contract.

## 8) Acceptance Criteria

- A PR validation workflow exists under `.github/workflows/` and runs on PR events.
- Baseline gate includes `pnpm check`, `pnpm typecheck`, and `pnpm test`.
- Merge blocking is documented via required status checks (maintainer-facing docs/update).
- Failure output clearly identifies failing gate stage.
- CI gate design explicitly accounts for future durable-state and test-expansion work.
