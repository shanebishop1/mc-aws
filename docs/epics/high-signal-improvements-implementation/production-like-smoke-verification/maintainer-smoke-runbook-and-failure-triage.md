# Real-Environment Smoke: Maintainer Runbook and Failure Triage (mcaws-a9h.3.4)

This runbook describes first-response operations for `.github/workflows/real-environment-smoke.yml`.

Use alongside:

- Contract: `docs/epics/high-signal-improvements-implementation/production-like-smoke-verification/minimum-real-environment-smoke-contract.md`
- Credential setup: `docs/epics/high-signal-improvements-implementation/production-like-smoke-verification/real-environment-smoke-ci-credentials-setup.md`

## 1) Manual run procedure (workflow_dispatch)

1. Open **Actions → Real-Environment Smoke Verification → Run workflow**.
2. Confirm branch/ref is the intended release candidate.
3. Set optional inputs:
   - `enable_s5_environment_probe` (default `false`)
   - `require_s5_environment_probe` (default `false`)
4. Start run and wait for job `Real-environment smoke contract (S1-S5)`.
5. Review:
   - Job logs (including preflight config validation)
   - GitHub Step Summary
   - Artifact `real-environment-smoke-summary`

Notes:

- Schedule runs daily via cron and use the same contract.
- The job uses GitHub Environment `real-environment-smoke`; secrets/vars must be configured there.

## 2) How to interpret smoke summary output

Summary includes:

1. Overall verdict: `PASS` or `FAIL`
2. Environment label + timestamp
3. Failure routing hint (`credentials/config`, `runtime-state/deploy`, `service/runtime`, or `none`)
4. S1-S5 per-check table with `status`, `primary signal`, `failure hint`

Status semantics:

- `pass`: check met expected contract.
- `fail`: blocking for S1-S4; also blocking for S5 only when `SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE=true`.
- `skipped`: allowed for S5 only.

Execution order is strict: `S1 → S2 → S3 → S4 → S5`.
If a required check fails, later required checks appear as `fail` with `primary signal = not executed` and S5 is recorded as `skipped`.

## 3) Failure taxonomy and first response

### A) `credentials/config`

Typical signals:

- Preflight failure before dependency install
- S1 auth/bootstrap fails
- Missing/placeholder/invalid `SMOKE_*` environment values

First response:

1. Verify `real-environment-smoke` environment contains required secrets/vars:
   - Secrets: `SMOKE_BASE_URL`, `SMOKE_SESSION_COOKIE`
   - Vars: `SMOKE_ENVIRONMENT_LABEL`
2. Confirm `SMOKE_BASE_URL` is HTTPS and not placeholder text.
3. Rotate/reissue smoke session cookie if expired or invalid.
4. Re-run workflow after config correction.

### B) `runtime-state/deploy`

Typical signals:

- S4 failure
- Missing/invalid runtime-state cache signal (`x-status-cache`)
- `/api/stack-status` or domain/binding consistency checks fail

First response:

1. Confirm latest deployment completed successfully and targets expected environment.
2. Validate runtime-state bindings/migrations and domain config for this environment.
3. Compare with last known-good deploy revision/config.
4. Re-run smoke once after deploy/config fix.

### C) `service/runtime`

Typical signals:

- S2 `/api/status` contract or backend-mode failure
- S3 `/api/service-status` read-path failure
- S5 required probe failure (`/api/costs`) when configured blocking

First response:

1. Check endpoint availability and auth behavior in logs.
2. Verify expected backend mode (`SMOKE_EXPECT_BACKEND_MODE`, default `aws`).
3. Verify route dependencies (AWS/runtime permissions, service-status wiring).
4. Re-run once if failure appears transient (timeouts/network/intermittent 5xx).

## 4) Escalation and retry guidance

- **Do not spam retries.**
- Allowed immediate retry policy:
  - One immediate rerun for suspected transient failures.
  - No rerun until fixed for deterministic config/binding/contract failures.
- Escalate when any condition holds:
  - Same required check fails twice consecutively.
  - S4 failure persists after a deploy/config correction.
  - Failure occurs during release promotion window and blocks confidence.

Escalation target by class:

- `credentials/config`: maintainer with GitHub Environment admin access
- `runtime-state/deploy`: deploy/runtime-state owners
- `service/runtime`: API/service owners

Release gating rule:

- Treat any `FAIL` in S1-S4 as release-blocking until resolved and a passing rerun is recorded.

## 5) Rollback and safety guidance

Safety constraints (must hold during incident response):

- Keep smoke lane non-destructive (no start/stop/restore/delete operations).
- Do not broaden smoke credentials during triage; keep least privilege.
- Keep S5 optional unless incident context explicitly requires blocking probe behavior.

Rollback guidance when smoke fails after recent deployment:

1. Pause promotion of newer revisions.
2. Roll back to last known-good release/config for failing area.
3. Re-run smoke workflow manually.
4. Resume promotion only after required contract checks (S1-S4) return `PASS`.

Post-incident:

- Capture root cause and corrective action in the relevant epic/workstream tracking thread before normal release cadence resumes.
