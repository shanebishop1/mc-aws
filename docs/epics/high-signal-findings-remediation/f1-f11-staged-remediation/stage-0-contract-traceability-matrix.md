# Stage 0 Contract + Traceability Matrix (F1-F11)

**Task:** `mcaws-nze.1.1.1`  
**Date:** 2026-04-14  
**Purpose:** Lock reproducible contracts and owner touchpoints before Stage 1+ behavior changes.

## 1) Implementation Matrix (Actionable)

| ID | Current behavior (confirmed) | Expected behavior (target contract) | Proof/source references | Owner paths by layer (UI / route / lib/helper / lambda-script / infra) | Classification | API/UI shape change required? | Coupled fixes that should land together |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | `/api/start` allows non-admin users and can reach resume-capable internals when instance is in resumable/hibernated states. | `start` must not execute admin-only resume behavior for non-admin users; auth must be state-aware at runtime path boundaries. | `docs/high-signal-findings-remediation-plan-2026-04-14.md` (F1), `app/api/start/route.ts`, `infra/src/lambda/StartMinecraftServer/index.js` (`handleStartCommand` calls `handleResume`). | UI: `app/page.tsx` / `components/ControlsSection.tsx` (start trigger)<br>Route: `app/api/start/route.ts`<br>Lib: `lib/api-auth.ts`, `lib/mutating-action-validation.ts`<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/index.js`, `infra/src/lambda/StartMinecraftServer/handlers/resume.js`<br>Infra: n/a | Contract bug + implementation bug | No (preserve `/api/start` shape) | F1 + F2 + F3 semantics should ship together (single start/resume/restore contract).
| F2 | "Start Fresh World" (`onResume(undefined)`) falls into resume path where shell defaults can select latest backup. | "Fresh" must be explicit and never infer latest backup restore from omitted input. | Plan F2, `components/ResumeModal.tsx`, `app/page.tsx`, `app/api/resume/route.ts`, `infra/src/ec2/mc-resume.sh` (empty arg => latest backup). | UI: `components/ResumeModal.tsx`, `app/page.tsx`<br>Route: `app/api/resume/route.ts`<br>Lib: `lib/mutating-action-validation.ts`<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/index.js`, `infra/src/ec2/mc-resume.sh`, `infra/src/ec2/mc-restore.sh`<br>Infra: n/a | Contract bug + implementation bug | No (can keep route shape; semantics fix) | F2 + F3 must land together to prevent fallback/double-restore regressions.
| F3 | Resume flow can execute restore twice / wrong path: `mc-resume.sh` restore + Lambda `handleRestore()` call with args; backup identifier semantics differ (`name` vs filename). | Exactly one restore strategy per request: fresh OR latest OR named; identifier format consistent end-to-end. | Plan F3, `infra/src/lambda/StartMinecraftServer/index.js` (`handleResumeCommand`), `infra/src/ec2/mc-resume.sh`, `infra/src/ec2/mc-restore.sh`, `infra/src/lambda/StartMinecraftServer/handlers/restore.js`. | UI: `components/ResumeModal.tsx`<br>Route: `app/api/resume/route.ts`, `app/api/restore/route.ts`<br>Lib: `lib/mutating-action-validation.ts`<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/index.js`, `infra/src/lambda/StartMinecraftServer/handlers/restore.js`, `infra/src/ec2/mc-resume.sh`, `infra/src/ec2/mc-restore.sh`<br>Infra: n/a | Implementation bug (with contract ambiguity) | No (prefer internal normalization) | F3 + F2; also coordinate with Stage 1 acceptance tests for restore variants.
| F4 | EC2 role KMS decrypt condition uses wildcard ARN with `StringEquals` on encryption context, likely non-matching for `/minecraft/*` runtime decrypt. | KMS decrypt policy must match real SSM SecureString encryption-context behavior for intended parameter scope. | Plan F4, `infra/lib/minecraft-stack.ts` (KMS policy condition block for `PARAMETER_ARN`). | UI: n/a<br>Route: n/a<br>Lib: n/a<br>Lambda/script: EC2 scripts consuming secure params (`infra/src/ec2/update-dns.sh`, `infra/src/ec2/user_data.sh`)<br>Infra: `infra/lib/minecraft-stack.ts` | Implementation bug + hardening gap | No | F4 should land with Stage 2 policy verification evidence before runtime scripts that depend on SecureString reads.
| F5 | `update-dns.sh` requires `jq` but bootstrap install list omits it, causing runtime failure on clean instances. | Required runtime dependencies are installed or script fails fast with explicit message. | Plan F5, `infra/src/ec2/update-dns.sh` (uses `jq`), `infra/src/ec2/user_data.sh` (no `jq` install). | UI: n/a<br>Route: n/a<br>Lib: n/a<br>Lambda/script: `infra/src/ec2/update-dns.sh`, `infra/src/ec2/user_data.sh`<br>Infra: `infra/lib/minecraft-stack.ts` (user-data wiring) | Implementation bug | No | F5 can ship with F6 in Stage 2 runtime-truthfulness PR.
| F6 | `mc-backup.sh` logs success even if final restart fails (`systemctl start ... || warning`), enabling false-success status. | Backup overall result must fail when restart fails; user/API status must reflect partial failure. | Plan F6, `infra/src/ec2/mc-backup.sh`, backup execution path via `infra/src/lambda/StartMinecraftServer/handlers/backup.js`. | UI: backup UX in `components/backup/*`<br>Route: `app/api/backup/route.ts`<br>Lib: operation state helpers (`lib/operation.ts` + mutating action libs)<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/handlers/backup.js`, `infra/src/ec2/mc-backup.sh`<br>Infra: n/a | Implementation bug | No | F6 should land with upstream error-propagation adjustments in lambda/route mapping.
| F7 | Idle script treats `mcstatus` probe failure as `0 players`; timer progresses toward shutdown. Also stop-instances call omits explicit region. | Probe failure must not count as empty observation; all AWS CLI calls should include explicit region for determinism. | Plan F7, `infra/src/ec2/check-mc-idle.sh` (probe fallback and stop call). | UI: `hooks/useServerStatus.ts` (read-only display impact)<br>Route: n/a<br>Lib: n/a<br>Lambda/script: `infra/src/ec2/check-mc-idle.sh`<br>Infra: `infra/src/ec2/user_data.sh` (cron deployment) | Hardening gap + implementation bug | No | F7 can be isolated in Stage 3 PR; do not couple with semantic Stage 1 fixes.
| F8 | UI shows Hibernate for stopped states; backend `/api/hibernate` requires `running`, producing deterministic reject path. | UI controls must not present actions known to fail backend preconditions. | Plan F8, `hooks/useButtonVisibility.ts`, `app/api/hibernate/route.ts`. | UI: `hooks/useButtonVisibility.ts`, `components/ControlsSection.tsx`, `app/page.tsx`<br>Route: `app/api/hibernate/route.ts`<br>Lib: `lib/types.ts` (state enums)<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/handlers/hibernate.js`<br>Infra: n/a | Contract bug (UI↔route mismatch) | No | F8 should ship with F1-F3 Stage 1 semantic normalization.
| F9 | Setup wizard marks email as optional, but Lambda env validation hard-requires `VERIFIED_SENDER` for API/email paths. | One consistent contract: optional-with-gating OR required, reflected in setup docs, env validation, and runtime behavior. | Plan F9, `scripts/setup-wizard.sh` (`Optional: Email Settings`), `infra/src/lambda/StartMinecraftServer/index.js` (`validateEnvironment`). | UI: setup messaging surfaces in docs/onboarding<br>Route: n/a (indirect API impact via Lambda config failures)<br>Lib: env handling in runtime call chain (`lib/env.ts` for app side if touched later)<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/index.js`, `scripts/setup-wizard.sh`<br>Infra: `infra/lib/minecraft-stack.ts` (VERIFIED_SENDER env/SES rule wiring) | Contract bug + implementation bug | No public API shape change; configuration contract decision required | F9 should remain its own Stage 2 follow-up PR to avoid mixing with F4-F6 infra/runtime fixes.
| F10 | Stale lock cleanup does read-then-delete; under race, one actor can delete another actor's newly acquired lock. | Lock cleanup/release must be ownership-safe (compare-and-delete semantics or backend with conditional writes). | Plan F10, `lib/server-action-lock.ts` (`deleteLockIfExpected`, stale recovery branch). | UI: n/a<br>Route: all mutating routes using lock helpers (`app/api/*/route.ts`)<br>Lib: `lib/server-action-lock.ts`<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/index.js` (`releaseServerActionLockIfOwned`)<br>Infra: n/a | Hardening gap + implementation bug | No | F10 should ship alone (Stage 3 PR-5) with concurrency harness evidence.
| F11 | Resume volume reconstruction picks latest public AL2023 AMI snapshot, causing drift risk over time. | Reconstruction source must be explicit/pinned (AMI/snapshot/metadata), not moving latest. | Plan F11, `infra/src/lambda/StartMinecraftServer/handlers/resume.js`, `lib/aws/volume-client.ts` (same latest-AMI strategy). | UI: n/a<br>Route: `app/api/resume/route.ts` (entrypoint only)<br>Lib: `lib/aws/volume-client.ts`<br>Lambda/script: `infra/src/lambda/StartMinecraftServer/handlers/resume.js`<br>Infra: `infra/lib/minecraft-stack.ts` (base image context) | Hardening gap + implementation bug | No | F11 should remain isolated Stage 4 due highest behavior-change risk.

## 2) Minimal Repro Notes (High Severity: F1, F2, F3, F4, F5, F6, F9)

### F1 repro (authorization/runtime mismatch)
- Preconditions: non-admin allowed user, server in stopped-without-root-volume (resumable) state.
- Step: call `POST /api/start` as allowed non-admin.
- Observe: route auth passes (`requireAllowed`), lambda `start` path calls resume-capable handler.
- Expected: reject or non-resume path for non-admin in resumable state.

### F2 repro (fresh world not fresh)
- Preconditions: backups exist in remote storage.
- Step: UI "Resume World" -> "Start Fresh World".
- Observe: UI sends resume without backup name; shell default path resolves latest backup and restores it.
- Expected: fresh path must not restore latest by omission.

### F3 repro (wrong/double restore strategy)
- Preconditions: resume with named backup.
- Step: `POST /api/resume` with `backupName`; follow lambda path.
- Observe: `mc-resume.sh` runs (restore behavior) and lambda may additionally call `handleRestore` with args.
- Expected: exactly one restore strategy executes.

### F4 repro (KMS decrypt condition mismatch)
- Preconditions: deployed stack with SecureString values under `/minecraft/*`.
- Step: on EC2, run `aws ssm get-parameter --with-decryption --name /minecraft/cloudflare-api-token --region <region>`.
- Observe: access can fail due to policy context mismatch (`StringEquals` + wildcard ARN pattern).
- Expected: decrypt allowed for intended `/minecraft/*` parameters.

### F5 repro (`jq` missing runtime dep)
- Preconditions: clean instance boot via current user-data.
- Step: run `/usr/local/bin/update-dns.sh`.
- Observe: failure when script parses JSON using `jq` but package not installed.
- Expected: dependency present or explicit fail-fast with actionable error.

### F6 repro (backup false success)
- Preconditions: force minecraft restart failure after archive upload (e.g., service misconfig).
- Step: run `/usr/local/bin/mc-backup.sh`.
- Observe: script logs warning on restart failure but still logs success and exits zero.
- Expected: non-zero exit and propagated operation failure.

### F9 repro (setup/runtime contract mismatch)
- Preconditions: run setup wizard skipping email section.
- Step: invoke API command path that reaches lambda env validation.
- Observe: lambda `validateEnvironment()` fails when `VERIFIED_SENDER` empty.
- Expected: either setup requires email or runtime gates only email-specific features.

## 3) Stage 1+ Ambiguities to Resolve Before Code Changes

1. **Fresh-vs-latest contract:** do we support "latest restore" explicitly in resume flow, or only fresh + named?
2. **F9 contract decision:** is email required for all commands, or optional with command-level gating?
3. **F11 source-of-truth choice:** pin AMI ID, pin snapshot, or persist initial validated root source metadata.

These are the only known semantic decisions that can block implementation sequencing; all other items are implementation-traceable with current owners.
