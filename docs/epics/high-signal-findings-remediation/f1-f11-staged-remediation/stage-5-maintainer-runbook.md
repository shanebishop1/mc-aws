# Stage 5 Maintainer Runbook (F1-F11)

**Task:** `mcaws-nze.1.1.8`  
**Purpose:** Canonical semantics + operational guidance after staged remediation

## 1) Canonical action semantics

### `start`

- Intended for normal stopped-to-running startup.
- Allowed for `admin` and `allowed` users only when state is start-eligible.
- If state is resumable/hibernate-related, `start` must fail fast with guidance to use `resume`.
- Must not tunnel into admin-only resume semantics.

### `resume`

- Admin-only action for hibernated/resumable lifecycle paths.
- Restore strategy must be explicit and singular per invocation:
  - `fresh`: no backup restore
  - `latest`: restore latest backup
  - `named`: restore one specific backup
- Mixed/inconsistent restore inputs must be rejected.

### `restore`

- Admin-only explicit restore path.
- Uses normalized backup identifier semantics (archive naming consistency) and must not execute duplicate restore phases.

### “Start Fresh World”

- Must map to explicit `fresh` semantics.
- Omitted backup input must never be interpreted as `latest` implicitly.

## 2) Runtime EC2 dependencies and failure behavior

- Runtime dependencies used by EC2 scripts (including DNS update flows) are part of the deployment contract.
- Missing required runtime tooling is a deployment defect, not an operator warning.
- Backup completion is only valid when restart succeeds; restart failure must propagate to route/Lambda as a failed operation.
- Idle probe telemetry failures (command failure/malformed output) must reset streak state and suppress shutdown decisions.

## 3) KMS-backed SecureString contract

- EC2 role `kms:Decrypt` permissions are constrained by encryption-context scoping for `/minecraft/*` parameters.
- Policy shape expectation:
  - `Action`: `kms:Decrypt`
  - `Condition`: `StringLike` on `kms:EncryptionContext:PARAMETER_ARN`
  - Parameter scope: `arn:aws:ssm:<region>:<account>:parameter/minecraft/*`
- Post-deploy operator smoke should verify real decrypt/read of expected SecureString parameters.

## 4) Email optional/degraded contract

- Setup wizard email configuration remains optional.
- If `VERIFIED_SENDER` is omitted:
  - Web/API control plane commands continue to work.
  - SES-triggered email commands and SES notifications are disabled.
  - Lambda returns explicit service-disabled messaging for email invocation path.
- If email is configured, `VERIFIED_SENDER` and related values must be valid and consistent.

## 5) Lock backend guarantees and stale-lock assumptions

- Lock lifecycle requires ownership-safe cleanup/release behavior.
- Stale lock recovery must not do blind read-then-delete of shared lock key.
- Delete-claim/ownership checks must prevent one actor from deleting another actor’s newly acquired lock.
- Lock release must verify lock identity and ownership metadata (id/action/owner) before deleting shared lock parameter.

## 6) Hibernate/resume reconstruction source rules

- Reconstruction source is pinned to instance metadata (`ImageId` -> root snapshot), not latest public AMI search filters.
- Resume should fail explicitly when pinned source metadata is missing/invalid.
- No implicit fallback to drifting latest AMI behavior.

### Rollback guidance for reconstruction failures

If resume reconstruction fails in production:

1. Stop automated retries for the same mutation scope (avoid repeated destructive churn).
2. Inspect instance metadata (`ImageId`, root device mapping) and CloudWatch logs for snapshot resolution or attach failure.
3. Validate whether newly created volume exists and is safe to detach/delete manually.
4. If confidence is low, roll back to prior known-good deployment slice and restore from a validated backup path.
5. Record reconstruction source IDs and failure signatures for follow-up hardening.

## 7) Operator quick triage map

- `start` rejected with resume guidance: check instance lifecycle state and caller role.
- Resume/restore mismatch errors: check restoreMode + backupName request payload and route normalization.
- Backup says failed after restart: expected truthful behavior; review service restart logs before retry.
- Idle checker stopped unexpectedly: inspect probe telemetry logs; failures should suppress stop.
- Email command returns disabled message: verify `VERIFIED_SENDER` config and SES readiness.
- Lock conflicts/stale recovery issues: inspect lock/delete-claim parameters and overlapping operation IDs.
