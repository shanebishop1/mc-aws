# Stage 5 Staged Rollout Checklist (F1-F11)

Use this checklist for finalization and any replay rollout of the staged remediation slices.

## Preflight (before Stage 5 closure)

- [ ] Confirm regression matrix is current (`stage-5-regression-matrix.md`).
- [ ] Confirm maintainer runbook is current (`stage-5-maintainer-runbook.md`).
- [ ] Run focused Stage 5 regression suite.
- [ ] Run `pnpm typecheck` and `pnpm lint`.

## Stage gate ordering

### Gate A — Stage 1 semantics/auth/UI (F1/F2/F3/F8)

- [ ] `/api/start` role/state checks verified.
- [ ] Resume restore strategy tests (`fresh/latest/named`) verified.
- [ ] Hibernate visibility and backend precondition alignment verified.
- [ ] Rollback point recorded (last good commit/tag before Stage 1 slice).

### Gate B — Stage 2 runtime/deploy truthfulness (F4/F5/F6)

- [ ] KMS SecureString policy contract check passed.
- [ ] Runtime dependency prerequisites verified.
- [ ] Backup restart failure propagation verified.
- [ ] Real-environment decrypt smoke evidence captured.

### Gate C — Stage 2 email contract follow-up (F9)

- [ ] Setup wizard optional email semantics verified.
- [ ] Lambda API invocation succeeds without `VERIFIED_SENDER`.
- [ ] Email invocation returns explicit disabled/degraded behavior when unset.

### Gate D — Stage 3 safety + lock correctness (F7/F10)

- [ ] Idle probe failure suppression tests verified.
- [ ] Explicit AWS region behavior in idle stop path verified.
- [ ] Lock stale-recovery race tests verified.

### Gate E — Stage 4 hibernate/resume durability (F11)

- [ ] Reconstruction source pinning tests verified.
- [ ] Controlled resume rehearsal completed.
- [ ] Rollback notes for reconstruction failures documented.

### Gate F — Stage 5 finalization

- [ ] All issue classes mapped to runnable tests/manual checks.
- [ ] Runbook/checklist docs reviewed by maintainers.
- [ ] Open risks (if any) documented with owners.

## Go / No-Go criteria

### Go

- All required gates complete with evidence.
- No critical regressions in role/state authorization, restore strategy selection, lock safety, or reconstruction pinning.

### No-Go

- Any unresolved critical regression in findings classes.
- Missing rollback point or missing operator evidence for KMS/email/reconstruction operational checks.

## Rollback anchors

- Keep rollback reference for each gate (A-E) before promoting next stage.
- Prefer rolling back only the latest stage slice when feasible.
- For Stage 4 failures, prioritize restoring service continuity (validated backup + known-good deployment) before reattempting reconstruction fixes.
