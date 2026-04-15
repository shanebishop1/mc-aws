# PRD: Confirmed Findings F1-F11 Staged Remediation

**Epic:** High-Signal Findings Remediation  
**Feature:** Confirmed Findings F1-F11 Staged Remediation  
**Status:** Draft (execution-ready backlog)  
**Owner:** Planning  
**Source of Truth:** `docs/high-signal-findings-remediation-plan-2026-04-14.md`

## 1) Objective

Execute all confirmed findings (F1-F11) from the 2026-04-14 remediation plan using staged, dependency-safe delivery that preserves route/UI contracts unless intentionally changed.

## 2) Scope and Non-Goals

### In Scope

- All stages from the source plan: Stage 0 through Stage 5.
- All findings F1 through F11.
- Staged PR sequencing aligned to source Section 12.
- Regression coverage and maintainer docs/runbooks in final stage.

### Non-Goals

- Broad control-plane rewrites.
- Style-only script rewrites.
- General auth refactors unrelated to confirmed findings.
- Unrelated code deduplication or speculative cleanup.

## 3) Finding-to-Stage Mapping

- Stage 0: F1-F11 confirmation and traceability.
- Stage 1: F1, F2, F3, F8 correctness + authorization + UI contract alignment.
- Stage 2: F4, F5, F6 runtime/deploy truthfulness and hard prerequisites.
- Stage 2 (follow-up PR): F9 email contract alignment.
- Stage 3: F7 automation safety and F10 lock race hardening.
- Stage 4: F11 hibernate/resume reconstruction durability.
- Stage 5: Cross-finding regression matrix, runbooks/docs, staged rollout gates.

## 4) Dependency and PR Slicing Strategy

- Required PR order from source Section 12 is preserved exactly after Stage 0:
  1. PR-1: Stage 1 (F1/F2/F3/F8)
  2. PR-2: Stage 2 runtime/deploy (F4/F5/F6)
  3. PR-3: Stage 2 email contract (F9)
  4. PR-4: Stage 3 idle safety (F7)
  5. PR-5: Stage 3 lock race hardening (F10)
  6. PR-6: Stage 4 hibernate/resume durability (F11)
  7. PR-7: Stage 5 regression/docs/staged rollout
- Stage 0 is a hard precondition gate for PR-1.
- Later PR slices are blocked by completion of the prior slice validation task.
- Within each PR slice, use regular commit cadence (contract/docs-first commit, implementation commit(s), validation/regression commit) to preserve reviewability and rollback clarity.

## 5) Implementation Task Checklist

- ST-0 (Execution Gate: Stage 0 Confirmation and Traceability)
  - T-0.1 | Lane: HSR-L0A | Task: Build reproducibility matrix for F1-F11
    - Action: Capture current behavior, expected behavior, proof source, owning file paths, and intended end state for each confirmed finding.
    - Definition of Done: A complete F1-F11 matrix exists with no missing owner paths or missing expected outcomes.
  - T-0.2 | Lane: HSR-L0B | Task: Produce cross-layer trace map per finding
    - Action: Trace each finding through UI, route handler, shared helper, Lambda handler, EC2 scripts, and infra/config where applicable.
    - Definition of Done: Each finding has a verified layer-by-layer trace map with concrete code touchpoints.
  - T-0.3 | Lane: HSR-L0C | Task: Lock contract classifications and coupled-fix boundaries
    - Action: Mark each finding as contract bug, implementation bug, and/or operational hardening gap; identify fixes that must land together without API-shape drift.
    - Definition of Done: Classification and coupling decisions are documented, and no unresolved semantics remain for start/resume/restore/fresh-world behavior.

- ST-1 (Execution Gate: PR-1 Stage 1 Correctness and Authorization - F1, F2, F3, F8)
  - T-1.1 | Lane: HSR-L1A | Task: Canonicalize start/resume/restore/fresh-world semantics
    - Action: Document one canonical contract covering stopped-intact start, resumable/hibernated behavior, fresh-world semantics, and named-restore semantics.
    - Definition of Done: One approved semantics contract exists and is referenced by all Stage 1 implementation tasks.
  - T-1.2 | Lane: HSR-L1B | Task: Close `/api/start` auth bypass into resume-only behavior
    - Action: Ensure start requests cannot trigger admin-only resume behavior for non-admin users in resumable/hibernated states.
    - Definition of Done: Non-admin start calls are prevented from entering resume-only paths across all relevant runtime states.
  - T-1.3 | Lane: HSR-L1C | Task: Make "Start Fresh World" explicitly fresh
    - Action: Remove fallback behavior where omitted inputs imply latest-backup restore when fresh initialization is requested.
    - Definition of Done: Fresh-world execution never implicitly restores latest backup.
  - T-1.4 | Lane: HSR-L1D | Task: Enforce single restore strategy with consistent backup identifiers
    - Action: Ensure Lambda and shell layers select exactly one restore path (fresh/latest/named) and agree on backup identifier/extension semantics.
    - Definition of Done: Named restore executes exactly one restore path and backup argument formats are consistent end-to-end.
  - T-1.5 | Lane: HSR-L1E | Task: Align visible Hibernate action with backend preconditions
    - Action: Hide or disable Hibernate when backend preconditions deterministically reject the action; keep scope to proven mismatches.
    - Definition of Done: Hibernate is not exposed in UI states where backend would reject it.
  - T-1.6 | Lane: HSR-L1V | Task: Add Stage 1 regression coverage and focused validation
    - Action: Add route, restore-flow, UI visibility, and script-argument tests that enforce Stage 1 contracts.
    - Definition of Done: Test suite proves auth-state correctness, fresh/latest/named restore correctness, and Hibernate visibility precondition alignment.

- ST-2 (Execution Gate: PR-2 Stage 2 Runtime/Deploy Hardening - F4, F5, F6)
  - T-2.1 | Lane: HSR-L2A | Task: Correct KMS SecureString decrypt condition for `/minecraft/*`
    - Action: Replace non-matching decrypt condition logic with a condition strategy that matches intended SecureString encryption-context behavior.
    - Definition of Done: Intended `/minecraft/*` SecureString decrypts succeed under deployed policy and unintended scope is not expanded.
  - T-2.2 | Lane: HSR-L2B | Task: Ensure EC2 runtime dependencies and fail-fast checks for DNS script path
    - Action: Install or verify `jq` in bootstrap and add explicit missing-dependency failure behavior for `update-dns.sh`.
    - Definition of Done: Fresh instances satisfy DNS script dependencies, and missing prerequisites fail loudly instead of silently.
  - T-2.3 | Lane: HSR-L2C | Task: Fix backup false-success semantics when restart fails
    - Action: Ensure `mc-backup.sh` and upstream callers propagate restart failure as overall operation failure with truthful logs/status.
    - Definition of Done: Backup operations cannot report success when Minecraft restart failed.
  - T-2.4 | Lane: HSR-L2V | Task: Add Stage 2 validation for policy, bootstrap, and backup failure propagation
    - Action: Add deploy/policy verification, clean-bootstrap prerequisite checks, and failure-injection coverage for backup restart failure.
    - Definition of Done: Validation proves KMS rule correctness, runtime prerequisite availability, and backup failure propagation.

- ST-3 (Execution Gate: PR-3 Stage 2 Email Contract Alignment - F9)
  - T-2.5 | Lane: HSR-L3A | Task: Align setup, docs, env validation, and runtime email contract
    - Action: Decide and implement a single contract for whether `VERIFIED_SENDER` is optional, optional-with-gating, or required.
    - Definition of Done: Setup flow, docs, env validation, and runtime behavior agree on one email contract with no contradictory paths.
  - T-2.6 | Lane: HSR-L3V | Task: Add email contract regression tests
    - Action: Add tests for chosen email contract across setup and runtime validation paths.
    - Definition of Done: Tests prove expected behavior for configured and unconfigured sender scenarios according to chosen contract.

- ST-4 (Execution Gate: PR-4 Stage 3 Idle Auto-Stop Safety - F7)
  - T-3.1 | Lane: HSR-L4A | Task: Make idle automation failure-aware and explicit-region deterministic
    - Action: Distinguish probe failures from zero-player observations, require consecutive successful empty probes, and pass explicit region to all AWS CLI calls.
    - Definition of Done: Probe failures cannot advance toward shutdown, and script region behavior is deterministic for all CLI calls.
  - T-3.2 | Lane: HSR-L4V | Task: Add idle automation probe/region validation coverage
    - Action: Add script tests for probe success/failure/mixed sequences and explicit-region execution paths.
    - Definition of Done: Validation proves shutdown gating only on successful-empty probes and verifies explicit region handling.

- ST-5 (Execution Gate: PR-5 Stage 3 Lock Race Hardening - F10)
  - T-3.3 | Lane: HSR-L5A | Task: Replace stale-lock blind delete with ownership-safe release semantics
    - Action: Implement ownership-aware/compare-and-delete lock cleanup; if needed, move lock backend to conditional-write-capable storage.
    - Definition of Done: Lock release and stale cleanup cannot delete locks acquired by another actor.
  - T-3.4 | Lane: HSR-L5V | Task: Add concurrent stale-lock recovery harness
    - Action: Add tests/harness for overlapping lock acquisition, stale detection, and release.
    - Definition of Done: Concurrency validation demonstrates no cross-actor lock deletion race.

- ST-6 (Execution Gate: PR-6 Stage 4 Hibernate/Resume Durability - F11)
  - T-4.1 | Lane: HSR-L6A | Task: Remove latest-AMI drift from restore-critical reconstruction source
    - Action: Implement explicit pinned reconstruction source strategy (AMI/snapshot/metadata) for boot-volume recreation.
    - Definition of Done: Resume reconstruction source is explicit, reviewable, and not dependent on drifting latest public AMIs.
  - T-4.2 | Lane: HSR-L6B | Task: Reconcile hibernate delete/preserve rules with target cost and semantics
    - Action: Verify and document which volumes are deleted versus preserved, aligned with Stage 1 semantics and intended cost model.
    - Definition of Done: Volume lifecycle rules are explicit, consistent, and reflected in implementation paths.
  - T-4.3 | Lane: HSR-L6V | Task: Expand destructive lifecycle tests and rollback guidance
    - Action: Add tests and rehearsal guidance for detach/delete/recreate/attach flows plus rollback behavior.
    - Definition of Done: Destructive/reconstructive paths are validated beyond happy-path resume with rollback instructions.

- ST-7 (Execution Gate: PR-7 Stage 5 Regression, Docs, and Staged Rollout)
  - T-5.1 | Lane: HSR-L7A | Task: Build focused F1-F11 regression matrix
    - Action: Encode only proven issue classes from this cycle (auth-state semantics, restore variants, Hibernate visibility, backup restart-failure, idle probe failures, KMS SecureString access, email contract).
    - Definition of Done: A maintainable regression matrix exists and is automated where practical for all proven issue classes.
  - T-5.2 | Lane: HSR-L7B | Task: Update maintainer docs and operational runbooks
    - Action: Document start/resume/restore/fresh semantics, EC2 dependency requirements, email contract, lock guarantees, and hibernate volume reconstruction rules.
    - Definition of Done: Maintainer-facing docs explain intent, behavior, and regression-prevention rationale for each finding class.
  - T-5.3 | Lane: HSR-L7C | Task: Execute staged rollout checklist with per-stage test/smoke gates
    - Action: Define and apply rollout checkpoints so Stage 1 lands first, Stage 2/3 next, Stage 4 isolated, and Stage 5 finalization gated by explicit smoke and rollback criteria.
    - Definition of Done: Rollout plan includes stage-level go/no-go gates, rollback points, and evidence requirements for each PR slice.

## 6) Acceptance Criteria

- Start/resume/restore/fresh-world behavior matches documented semantics and role/state authorization.
- Runtime scripts are truthful about success/failure and enforce prerequisite clarity.
- Automation safety paths do not convert telemetry failure into destructive action.
- Locking behavior is race-safe under concurrent stale recovery.
- Hibernate/resume reconstruction no longer depends on drifting latest public AMIs.
- Confirmed finding classes are guarded by tests and maintainer documentation.

## 7) Validation Expectations

- Stage 1: Route tests by role/state, restore variant tests, UI visibility/hook checks, script arg-format tests.
- Stage 2: KMS policy verification, bootstrap dependency smoke, backup failure-injection tests, email contract tests.
- Stage 3: Idle script probe-sequence tests, region determinism checks, lock concurrency harness.
- Stage 4: Volume lifecycle unit/integration coverage and controlled rehearsal with rollback verification.
- Stage 5: Consolidated regression run plus staged rollout smoke evidence and runbook completeness review.
