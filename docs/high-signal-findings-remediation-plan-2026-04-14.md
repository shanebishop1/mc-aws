# High-Signal Findings Remediation Plan

**Status:** Draft  
**Owner:** Engineering  
**Last Updated:** 2026-04-14

## 1) Purpose

Turn the specific high-signal findings from three independent review passes into a staged remediation plan that is concrete enough to execute without drifting into low-value cleanup.

This plan is narrower than `docs/high-signal-improvements-implementation-plan.md`.
That broader plan defines long-term workstreams.
This document is the short-to-medium term execution plan for the concrete issues surfaced by the review passes.

## 2) Review Inputs

This plan covers the substantive findings raised across the three separate subagent reviews:

1. Start/resume authorization and behavior mismatches.
2. Resume/restore flow correctness issues, including "fresh world" and backup-selection behavior.
3. KMS decrypt policy mismatch for `/minecraft/*` SecureString parameters.
4. Runtime script correctness issues (`jq` dependency, backup false-success semantics, region handling).
5. Idle auto-stop safety issues, especially probe-failure handling.
6. Frontend/backend contract mismatches for exposed controls.
7. Email configuration contract mismatch between setup flow and Lambda runtime requirements.
8. Lock stale-recovery race conditions.
9. Hibernate/resume durability risk caused by root-volume recreation from drifting latest AMIs.

## 3) Prioritization Rules

Apply these rules during implementation:

- Fix user-visible correctness and authorization bugs before structural cleanup.
- Prefer small, isolated patches before workflow redesign.
- Only change contracts intentionally; otherwise preserve existing route shapes and UI flows.
- Add regression coverage for every confirmed bug before starting the next stage when practical.
- Do not expand scope into broad refactors unless needed to remove a proven source of defects.

## 4) Issue Inventory

| ID | Issue | Severity | Overlap Across Reviews | Primary Areas |
| --- | --- | --- | --- | --- |
| F1 | `/api/start` can effectively perform admin-only resume behavior in hibernated states | High | Yes | `app/api/start/route.ts`, Lambda resume/start path |
| F2 | "Start Fresh World" is not actually fresh; resume path can restore latest backup | Critical | Yes | `components/ResumeModal.tsx`, `app/page.tsx`, `/api/resume`, `mc-resume.sh` |
| F3 | Resume/restore flow can run the wrong restore sequence or double-restore | High | Yes | Lambda handler flow, `mc-resume.sh`, `mc-restore.sh` |
| F4 | KMS decrypt policy likely does not match `/minecraft/*` parameter ARNs | High | Yes | `infra/lib/minecraft-stack.ts` |
| F5 | `update-dns.sh` depends on `jq`, but instance bootstrap does not install it | High | No | `infra/src/ec2/update-dns.sh`, `user_data.sh` |
| F6 | Backup flow can report success while restart fails and the server remains down | High | No | `infra/src/ec2/mc-backup.sh` |
| F7 | Idle auto-stop can stop live systems after telemetry failure, and one path may omit explicit region | Medium | Partial | `infra/src/ec2/check-mc-idle.sh` |
| F8 | UI exposes Hibernate while backend rejects the action unless the server is running | Medium | No | `hooks/useButtonVisibility.ts`, `/api/hibernate` |
| F9 | Setup presents email as optional while Lambda validation may require `VERIFIED_SENDER` for core operations | High | No | `scripts/setup-wizard.sh`, Lambda env validation |
| F10 | Stale-lock cleanup has a race that can delete a newly acquired lock | Medium | No | `lib/server-action-lock.ts` |
| F11 | Hibernate/resume reconstructs root volume from drifting latest public AMIs | Medium | No | volume recreation path in `lib/aws/volume-client.ts` and hibernate flow |

## 5) Delivery Stages

The stages below are ordered by risk reduction, dependency, and ease of verification.

1. Stage 0: Confirm and pin down the current broken contracts.
2. Stage 1: Fix immediate correctness and authorization bugs.
3. Stage 2: Harden deploy/runtime prerequisites and script truthfulness.
4. Stage 3: Make destructive automation safer under failure and concurrency.
5. Stage 4: Reduce longer-term hibernate/resume drift risk.
6. Stage 5: Lock in regression coverage and operator documentation.

## 6) Stage 0: Confirmation and Traceability

### Goal

Convert the review findings into directly reproducible failures or code-level invariants before changing behavior.

### Scope

- F1 through F11.

### Tasks

1. Build a short reproduction matrix for each finding with current behavior, expected behavior, and proof source.
2. Trace each issue across the relevant layers:
   - UI
   - route handler
   - shared library/helper
   - Lambda handler
   - EC2 script
   - infra/config where applicable
3. Mark which findings are contract bugs versus implementation bugs versus operational hardening gaps.
4. Decide which findings can be fixed safely without changing public API shapes.
5. Identify any coupled fixes that must land together.

### Deliverables

- A checked issue matrix embedded in this plan or a follow-up implementation checklist.
- Minimal repro notes for all high-severity items.
- Stage 0 matrix artifact: `docs/epics/high-signal-findings-remediation/f1-f11-staged-remediation/stage-0-contract-traceability-matrix.md`.

### Exit Criteria

- Every issue has a known owner file path and a concrete desired end state.
- There are no unresolved disagreements about whether "fresh world," hibernate, or start/resume semantics are intended bugs.

## 7) Stage 1: Correctness and Authorization Fixes

### Goal

Stop the system from doing the wrong thing for start/resume/restore flows and eliminate the clearest UI/backend contract errors.

### Why this stage comes first

These are the highest-signal defects because they can violate access intent, perform the wrong restore behavior, or present actions that are known to fail.

### Issues Covered

- F1, F2, F3, F8.

### Work Items

#### 1. Normalize action semantics for `start`, `resume`, `restore`, and "fresh world"

- Define the intended contract for each action in one place.
- Explicitly answer:
  - What `start` means when the instance is stopped but intact.
  - What `resume` means when a hibernated or torn-down state exists.
  - What "Start Fresh World" means operationally.
  - Whether "restore backup X" is a distinct action or a flavor of resume.
- Document these semantics before patching code.

#### 2. Close the `/api/start` authorization hole for hibernated states

- Prevent `start` from silently entering an admin-only resume path.
- Choose one of these implementations and standardize around it:
  - reject `start` when the server is in a resumable/hibernated state unless caller is admin, or
  - split the execution path so `start` never calls resume logic.
- Ensure auth checks depend on runtime state, not only requested route name.

#### 3. Fix "Start Fresh World" so it is actually fresh

- Remove the current no-argument path that falls through to "restore latest backup" behavior.
- Introduce an explicit fresh-start signal if needed.
- Ensure the backend does not infer "latest backup restore" from omitted input when the UI means fresh initialization.

#### 4. Eliminate double-restore and wrong-restore sequencing

- Make the Lambda resume path choose exactly one restore strategy per request:
  - fresh world
  - restore latest backup
  - restore named backup
- Pass backup identifiers consistently end-to-end.
- Resolve any extension mismatch between `mc-resume.sh` and `mc-restore.sh`.
- Ensure the shell layer and Lambda layer agree on whether arguments represent a backup archive filename, logical backup name, or path stem.

#### 5. Align visible UI actions with backend preconditions

- Hide or disable Hibernate when backend preconditions are not met.
- Confirm other controls do not expose similarly invalid states while touching this area.
- Keep this narrow: only fix proven mismatches.

### Acceptance Criteria

- Non-admin users cannot use `/api/start` to trigger resume-only behavior.
- "Start Fresh World" never restores the latest backup implicitly.
- A named backup restore executes one restore path only.
- Resume and restore scripts agree on backup argument format.
- Hibernate is not offered when the backend would deterministically reject it.

### Validation

- Route tests for `start` against stopped, running, and hibernated states with admin and allowed users.
- Tests for fresh, latest, and named restore flows.
- A focused UI test or hook test for button visibility/preconditions.
- Script-level test or harness for backup name/extension handling.

## 8) Stage 2: Deploy and Runtime Prerequisite Hardening

### Goal

Remove configuration and script assumptions that can break core runtime behavior or produce misleading success.

### Issues Covered

- F4, F5, F6, F9.

### Work Items

#### 1. Fix the KMS decrypt policy condition

- Replace the wildcard-plus-`StringEquals` pattern with a condition operator that actually matches the intended parameter set, or enumerate explicit ARNs.
- Confirm the final policy matches how SSM Parameter Store sets KMS encryption context for SecureString decrypts.
- Audit all consumers that rely on `/minecraft/*` SecureString access.

#### 2. Make EC2 bootstrap install or verify all runtime dependencies

- Add `jq` to the package installation path used by fresh instances if it is a required runtime dependency.
- Consider adding a fast fail in `update-dns.sh` for missing commands so the failure is explicit even if bootstrap drifts again.
- Review the dependency list for any other hard-required binaries referenced by the same scripts.

#### 3. Fix backup success semantics

- Make `mc-backup.sh` return non-zero when the server restart fails.
- Ensure upstream callers do not collapse this into a false success response.
- Verify user-visible logs and API status reflect partial-failure states accurately.

#### 4. Resolve the email configuration contract mismatch

- Decide whether email is truly optional for core panel operations.
- If email is optional:
  - relax Lambda env validation so non-email operations can run without `VERIFIED_SENDER`, or
  - gate only email-sending paths on sender configuration.
- If email is required for these operations:
  - change the setup flow and docs to say so clearly, and fail deployment/setup earlier.
- Keep the contract consistent across wizard, docs, env validation, and runtime code.

### Acceptance Criteria

- SecureString decrypt works for the intended `/minecraft/*` parameters in the deployed stack.
- Fresh instances have the dependencies needed for DNS update scripts.
- Backup operations cannot report overall success if the Minecraft service failed to restart.
- The setup flow and Lambda runtime agree on whether email sender configuration is optional.

### Validation

- Policy simulation or deploy-time verification for the updated KMS rule.
- Bootstrap smoke test on a clean instance or containerized equivalent for `update-dns.sh` prerequisites.
- Backup failure injection test proving restart failure propagates as failure.
- Setup-flow regression test or env-validation tests for email-required versus email-optional paths.

## 9) Stage 3: Safety Under Failure, Concurrency, and Automation

### Goal

Reduce the chance that automation makes destructive decisions from bad telemetry or that locking fails under race conditions.

### Issues Covered

- F7, F10.

### Work Items

#### 1. Make idle auto-stop failure-aware rather than silence-biased

- Separate "probe failed" from "0 players detected."
- Require consecutive successful empty-player observations before shutdown.
- Ensure the script does not advance the idle timer when telemetry is unavailable or malformed.
- Add explicit region handling to all AWS CLI calls in the script, including stop-instances.
- Improve logs so operators can distinguish idle shutdown from probe failure suppression.

#### 2. Remove stale-lock blind-delete behavior

- Replace `get -> validate -> delete` stale lock cleanup with an ownership-aware or compare-and-delete approach.
- If SSM Parameter Store cannot provide the needed atomicity, move the lock implementation to a backend with conditional writes.
- Ensure lock release only removes the lock created by the current action instance.

### Acceptance Criteria

- A failed player-count probe cannot on its own drive the system toward shutdown.
- All AWS CLI calls in idle-management scripts behave deterministically with respect to region selection.
- Concurrent stale-lock recovery cannot delete a newly acquired lock from another actor.

### Validation

- Script tests for probe-success, probe-failure, and mixed sequences.
- Concurrency tests around lock acquisition, stale detection, and release.
- A manual or automated harness that simulates overlapping lock recovery attempts.

## 10) Stage 4: Hibernate/Resume Durability Hardening

### Goal

Reduce resume-time drift and make destructive volume reconstruction behavior more predictable and testable.

### Issues Covered

- F11, plus any remaining hibernate/resume correctness debt discovered while fixing Stage 1.

### Work Items

#### 1. Stop depending on drifting latest public AMIs for restore-critical reconstruction

- Decide whether to pin an AMI ID, pin an owned snapshot source, or persist enough metadata to recreate from the originally validated root source.
- Make the reconstruction source explicit and reviewable rather than inferred from "latest."

#### 2. Revisit destructive delete assumptions in hibernate flow

- Confirm which volumes must be deleted versus preserved for the intended cost model.
- Verify that resume paths still match that model after Stage 1 semantic fixes.

#### 3. Add durable validation around the volume lifecycle

- Expand tests beyond happy-path resume.
- Cover detach/delete/recreate/attach behavior and failure rollback expectations.

### Acceptance Criteria

- Resume behavior is not coupled to whatever Amazon publishes as the latest AMI on a later date.
- The hibernate/resume lifecycle is documented with explicit source-of-truth rules for recreated volumes.
- Tests cover destructive and reconstructive paths, not only happy-path resume.

### Validation

- Unit and integration tests for volume recreation source selection.
- A controlled real-environment rehearsal for hibernate/resume after pinning strategy is implemented.
- Clear rollback guidance if recreated boot volumes fail validation.

## 11) Stage 5: Regression Coverage, Runbooks, and Release Strategy

### Goal

Make the fixes durable by encoding the intended contracts into tests and maintainer-facing docs.

### Scope

- All findings from F1 through F11.

### Work Items

#### 1. Build a focused regression matrix

- Cover only the proven issue classes from this review cycle.
- Suggested matrix rows:
  - start/resume auth by role and server state
  - fresh/latest/named restore behavior
  - hibernate visibility versus backend precondition
  - backup restart-failure propagation
  - idle probe failure handling
  - KMS-backed SecureString access on real config
  - setup-wizard email-optional versus runtime behavior

#### 2. Update maintainer docs and operational runbooks

- Document the intended semantics for start, resume, restore, and fresh world.
- Document the required EC2 runtime dependencies and why they matter.
- Document whether email is optional, optional-with-degraded-features, or required.
- Document the lock backend guarantees and stale-lock handling assumptions.

#### 3. Use staged rollout rather than a single large merge when possible

- Land Stage 1 fixes first and validate behavior.
- Land Stage 2 and Stage 3 safety fixes next.
- Land Stage 4 separately because it has the highest behavior-change risk.
- Gate each stage on its own tests and smoke checks.

### Acceptance Criteria

- The intended contracts that were previously ambiguous are now codified in tests and docs.
- Maintainers can explain why each fix exists and what regression it prevents.
- The highest-risk changes are deployable in smaller increments with rollback points.

## 12) Recommended Implementation Order

If execution must be broken into concrete PRs, use this order:

1. PR 1: Stage 1 semantic fixes for start/resume/restore/fresh world plus Hibernate button visibility.
2. PR 2: KMS condition fix, `jq` bootstrap/install fix, and backup false-success fix.
3. PR 3: Email contract alignment across setup, docs, and runtime validation.
4. PR 4: Idle auto-stop failure handling and explicit region usage.
5. PR 5: Lock stale-recovery hardening.
6. PR 6: Hibernate/resume AMI pinning or reconstruction-source redesign.
7. PR 7: Consolidated regression tests, smoke checks, and maintainer docs.

## 13) Items That Should Not Expand Scope

The following should stay out unless they become necessary to complete a proven fix:

- Broad control-plane rewrites.
- Style-driven shell script rewrites.
- General auth refactors unrelated to the confirmed route/role bugs.
- Reorganizing docs beyond what is needed to encode the new contracts.
- Generic cleanup of duplicated code that does not contribute to one of the findings above.

## 14) Success Definition

This remediation effort is successful when:

- Start, resume, restore, and fresh-world actions do exactly what their names imply.
- Authorization rules are enforced by real runtime state, not just UI intent.
- Runtime scripts either have their prerequisites or fail loudly and truthfully.
- Automation does not turn missing telemetry into destructive action.
- Lock handling remains correct under concurrent recovery.
- Hibernate/resume behavior no longer depends on uncontrolled AMI drift.
- The fixes are enforced by targeted tests rather than memory or convention.
