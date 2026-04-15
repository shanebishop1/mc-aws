# Stage 5 Regression Matrix (F1-F11)

**Task:** `mcaws-nze.1.1.8`  
**Scope:** Stage 5 finalization for findings F1-F11  
**Updated:** 2026-04-14

This matrix is intentionally narrow: it tracks only proven issue classes from this remediation cycle and pins each class to automated coverage plus runtime/operational checks where automation is intentionally limited.

## Regression Coverage Index

| Issue class | Findings | Primary automated coverage (runnable) | Additional verification / notes |
| --- | --- | --- | --- |
| Start/resume authorization by role and server state | F1 | `app/api/start/route.test.ts`, `app/api/resume/route.test.ts`, `lib/mutating-action-validation.test.ts` | `/api/start` remains allowed-user capable only for true start states; resumable states must use admin-only `/api/resume`. |
| Fresh/latest/named restore behavior | F2, F3 | `app/api/resume/route.test.ts`, `infra/src/lambda/StartMinecraftServer/restore-contract.test.ts`, `app/api/restore/route.test.ts` | Validates explicit restore mode and single strategy selection (fresh/latest/named), including inconsistent input rejection. |
| Hibernate visibility vs backend precondition | F8 | `hooks/useButtonVisibility.test.ts`, `app/api/hibernate/route.test.ts` | UI hides hibernate unless state is `running`; backend still enforces running precondition. |
| Backup restart-failure propagation | F6 | `infra/src/lambda/StartMinecraftServer/handlers/backup.test.ts`, `app/api/backup/route.test.ts` | Ensures restart failures propagate as failures; route reports failed operation metadata. |
| Idle probe failure handling | F7 | `tests/check-mc-idle-script.test.ts` | Probe failure/malformed telemetry clears streak and suppresses stop; explicit `--region` asserted for stop command. |
| KMS-backed SecureString access expectations | F4 | `infra/lib/minecraft-stack.contract.test.ts` | Policy contract asserts `kms:Decrypt` scope + `StringLike` `kms:EncryptionContext:PARAMETER_ARN` for `/minecraft/*`. Real-account decrypt smoke remains required after deploy. |
| Setup-wizard email optional behavior | F9 | `scripts/setup-wizard.contract.test.ts`, `infra/src/lambda/StartMinecraftServer/index.test.ts` | Wizard contract stays optional/degraded; Lambda permits API commands without `VERIFIED_SENDER` and returns explicit SES-disabled behavior for email invocation path. |
| Lock stale-recovery concurrency correctness | F10 | `lib/server-action-lock.test.ts` | Includes stale-cleanup race case to prevent cross-actor lock deletion during overlap. |
| Hibernate/resume reconstruction-source pinning | F11 | `infra/src/lambda/StartMinecraftServer/handlers/resume.test.ts`, `lib/aws/volume-client.test.ts` | Reconstruction must use instance-pinned source AMI/snapshot, not latest public AMI filters. |

## Focused Validation Commands

Run this focused Stage 5 suite when touching any F1-F11 logic:

```bash
pnpm test app/api/start/route.test.ts app/api/resume/route.test.ts infra/src/lambda/StartMinecraftServer/restore-contract.test.ts hooks/useButtonVisibility.test.ts app/api/hibernate/route.test.ts infra/src/lambda/StartMinecraftServer/handlers/backup.test.ts tests/check-mc-idle-script.test.ts infra/lib/minecraft-stack.contract.test.ts scripts/setup-wizard.contract.test.ts infra/src/lambda/StartMinecraftServer/index.test.ts lib/server-action-lock.test.ts infra/src/lambda/StartMinecraftServer/handlers/resume.test.ts lib/aws/volume-client.test.ts
```

Minimum static verification for Stage 5 doc/code updates:

```bash
pnpm typecheck
pnpm lint
```

## Exit Criteria for Stage 5

- All issue classes above have at least one runnable automated check.
- Any class with unavoidable environment coupling (for example KMS decrypt on deployed infra) has an explicit operator verification step in the runbook/checklist.
- Maintainer docs match route/lambda/script behavior for start/resume/restore/fresh, email optionality, lock assumptions, and hibernate reconstruction semantics.
