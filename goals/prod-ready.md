# PRD: Cloudflare (OpenNext) Production Readiness Hardening

**Date:** 2026-02-01  \
**Status:** Draft

## Context

The control panel is deployed to Cloudflare Workers via OpenNext. Several API routes still perform long-running AWS/SSM polling work synchronously (minutes), which is incompatible with Workers request limits. There is also a critical secret exposure risk in `next.config.ts`, plus a command-injection bug and some public information leakage.

This PRD defines the minimal set of changes to make the app production-ready on Cloudflare without adding new AWS services (no DynamoDB/S3/SQS/Step Functions). We will reuse existing components:

- Next.js App Router on Workers (OpenNext)
- Existing `StartMinecraftServer` Lambda
- Existing SSM Parameter Store usage (already in system)

## Decisions

- Public can view status/stack existence, but sensitive fields are redacted unless authenticated.
- No new AWS services/resources. Adding new SSM parameter names/values is allowed.

## Goals

- Prevent any secret from being shipped to the browser bundle.
- Ensure all “long-running” server operations work reliably on Cloudflare Workers (no request timeouts).
- Remove/limit public leakage of infra identifiers/IPs.
- Close command injection vectors.
- Make “server action locking” safe under concurrency across UI + email triggers.
- Keep the existing architecture; do not introduce new AWS services.

## Non-Goals

- No new AWS services/resources (DynamoDB, S3, SQS, Step Functions, etc.).
- No major UI redesign; only UX changes required by async operations.
- No refactor of the entire AWS provider layer beyond what’s required for locks/timeouts.

## Current Issues (Must Fix)

1. **Critical secret leak to client bundle**
   - `next.config.ts` uses `NextConfig.env` to expose server-only env vars, including `CLOUDFLARE_DNS_API_TOKEN` and `INSTANCE_ID`.
   - This can leak secrets into the browser.
2. **Command injection**
   - `app/api/resume/route.ts` interpolates unsanitized `backupName` into an SSM shell command.
3. **Workers-incompatible long-running requests**
   - These routes perform long polling/SSM execution synchronously:
     - `app/api/resume/route.ts`
     - `app/api/hibernate/route.ts`
     - `app/api/backup/route.ts`
     - `app/api/restore/route.ts`
     - `app/api/backups/route.ts` (can block on SSM/rclone)
   - Workers will intermittently fail/time out here.
4. **Non-atomic “server-action” locking**
   - Lock uses SSM param `/minecraft/server-action`, but acquisition is a non-atomic check-then-set with overwrite.
   - Concurrent requests can both proceed.
5. **Stuck lock on lambda invoke failure**
   - `app/api/start/route.ts` sets the lock, then invokes Lambda; if invoke fails, lock can remain until stale (currently ~30 min).
6. **Public information leakage**
   - `app/api/status/route.ts` and `app/api/stack-status/route.ts` are readable anonymously and return infra identifiers (`instanceId`, `stackId`) and potentially IP.

## Proposed Solution (High Level)

### A) Make all long operations “fire-and-forget” via the existing Lambda

Use the existing `StartMinecraftServer` Lambda as the asynchronous job runner for:

- start (already)
- resume
- backup
- restore
- hibernate
- backups cache refresh (see below)

API routes on Workers become:

- Auth + input validation + lock acquisition
- Invoke Lambda asynchronously (`InvocationType: "Event"`)
- Return `202 Accepted` immediately
- Frontend relies on polling `/api/status` + `serverAction` to reflect progress
- Full logs/results are delivered via existing email notifications from the Lambda (already implemented for these actions in the email flow)

### B) Keep backup listing fast on Workers via cached data in SSM

To avoid `GET /api/backups` blocking on rclone/SSM command execution:

- Add a cached parameter in SSM (existing service): `/minecraft/backups-cache` (JSON: `{ backups: BackupInfo[], cachedAt: number }`)
- `GET /api/backups` returns the cached value instantly.
- `GET /api/backups?refresh=true` triggers a Lambda refresh job and returns the last cached result + “refresh started”.

### C) Replace locking with an atomic SSM lock

Implement atomic lock acquisition using `PutParameter` with `Overwrite: false` on `/minecraft/server-action`:

- If parameter exists => conflict (409)
- If parameter exists but is stale => delete + retry acquire
- Release lock by deleting the parameter (idempotent)

This is “good enough” atomicity without adding DynamoDB.

### D) Remove/limit public access to sensitive info

Keep endpoints callable anonymously but redact sensitive fields unless authenticated.

- `/api/status`
  - Anonymous: return `state` (and any non-sensitive fields), but omit/blank `instanceId` + `publicIp`
  - Authenticated: include full response
- `/api/stack-status`
  - Anonymous: return only `{ exists: boolean }`
  - Authenticated: include `status`, `stackId`

### E) Hard fail on missing security-critical env at runtime

Even if build-time checks are bypassed, never run production auth with an empty secret.

- Ensure session signing/verifying throws if `AUTH_SECRET` is missing/too short in production.
- Avoid requiring build-time access to secrets that only exist in Cloudflare runtime.

## API Contract Changes

| Endpoint | Change |
|---|---|
| `POST /api/start` | Keep async; update lock acquisition to atomic; clear lock if invoke fails |
| `POST /api/resume` | Return `202`; invoke Lambda with `{ command:"resume", backupName? }` |
| `POST /api/backup` | Return `202`; invoke Lambda `{ command:"backup", name? }` |
| `POST /api/restore` | Return `202`; invoke Lambda `{ command:"restore", backupName? }` |
| `POST /api/hibernate` | Return `202`; invoke Lambda `{ command:"hibernate" }` |
| `GET /api/backups` | Return cached list from SSM; optional `refresh=true` triggers Lambda refresh |

## Implementation Plan (Actionable)

### Phase 0 — Confirm scope and defaults

- Confirmed decision: public view remains enabled, but sensitive fields are redacted unless authenticated.
- Default decision: use Lambda + email for operation results (UI shows “started” + polling + check email).

### Phase 1 — Stop secrets from reaching the client

- `next.config.ts`
  - Remove `env` entries for server-only vars:
    - `CLOUDFLARE_DNS_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`
    - `INSTANCE_ID`
    - `GDRIVE_*` (not public)
    - `AWS_REGION`, `AWS_ACCOUNT_ID` (keep server-only unless truly needed client-side)
  - Only allow `NEXT_PUBLIC_*` style values to reach client.
- Validate client code doesn’t rely on `process.env.*` for these values (should use API responses instead).

### Phase 2 — Fix command injection

- `app/api/resume/route.ts`
  - Stop interpolating unsanitized `backupName` into shell commands.
  - If resume becomes Lambda-only, still validate/sanitize `backupName` before passing to Lambda.
- Ensure the same sanitizer is used consistently:
  - `lib/sanitization.ts` (`sanitizeBackupName`)

### Phase 3 — Make long-running operations Worker-safe (Lambda orchestration)

- `infra/src/lambda/StartMinecraftServer/index.js`
  - Expand `invocationType: "api"` support to handle commands beyond `start`:
    - `backup`, `restore`, `hibernate`, `resume`, `refreshBackups`
  - For API invocations:
    - Validate payload schema (command, instanceId, userEmail, optional args)
    - Enforce authorization in Lambda as defense-in-depth:
      - `start`: allowed/admin
      - admin-only commands: backup/restore/hibernate/resume/refreshBackups
    - Always clear `/minecraft/server-action` in `finally` (already done for `start`; keep consistent).
  - For email invocations:
    - Acquire the same lock before starting work; if busy, email “operation in progress” and exit.
- `app/api/*/route.ts` (Worker routes)
  - Convert to:
    - authorize
    - acquire lock atomically
    - invoke Lambda asynchronously
    - return `202`
  - Specifically:
    - `app/api/backup/route.ts`
    - `app/api/restore/route.ts`
    - `app/api/hibernate/route.ts`
    - `app/api/resume/route.ts`
  - For `app/api/start/route.ts`:
    - Replace check-then-set lock with atomic acquire
    - If Lambda invoke fails, release the lock immediately

### Phase 4 — Backups list caching (Worker-safe)

- Add SSM param: `/minecraft/backups-cache` (String JSON, small size).
- `infra/src/lambda/StartMinecraftServer/index.js`
  - Implement `refreshBackups` command:
    - run list backups (existing SSM/rclone mechanism in Lambda environment)
    - store JSON into `/minecraft/backups-cache`
- `app/api/backups/route.ts`
  - Read `/minecraft/backups-cache` and return it quickly
  - If `refresh=true`, invoke Lambda `{ command:"refreshBackups" }` (admin-only) and return cached data + message

### Phase 5 — Locking correctness (no races)

- `lib/aws/ssm-client.ts`
  - Implement atomic lock helpers:
    - `acquireServerAction(action: string)` using `PutParameter(Overwrite:false)`
    - `releaseServerAction()` using `DeleteParameter`
    - `getServerAction()` keeps stale cleanup, but tune TTL to reasonable value (e.g., 10–15 min)
  - Update `withServerActionLock` to use atomic acquire (or retire it for routes that are Lambda-driven).
- `lib/aws/mock-provider.ts`
  - Ensure mock-mode behavior matches new locking expectations.

### Phase 6 — Remove public leakage

- `app/api/status/route.ts`
  - If user is not authenticated: omit/blank `instanceId` and `publicIp`
- `app/api/stack-status/route.ts`
  - If user is not authenticated: return `{ exists }` only (no `stackId`, no detailed status)
- Audit other endpoints for infra/cost leakage and ensure they are auth-protected (e.g., costs, console URLs).

### Phase 7 — Runtime env safety + Cloudflare build path

- `lib/auth.ts`
  - Enforce `AUTH_SECRET` presence and minimum strength at runtime before signing/verifying in production.
- `scripts/validate-env.ts` + `package.json`
  - Ensure Cloudflare deployment scripts run env validation in the correct place (and don’t rely on `prebuild` being executed by `opennextjs-cloudflare build`).
  - Keep validation focused on runtime-required vars; don’t force secrets at build time if they’re only available at runtime.

## UX Changes (Minimal)

- For backup/restore/hibernate/resume:
  - UI should display: “Operation started. You’ll receive an email when it completes.”
  - Show operation-in-progress state using `serverAction` from `/api/status`.
- Resume modal:
  - Backups list loads from cached `/api/backups` response.
  - If user clicks refresh, trigger `/api/backups?refresh=true` and re-fetch after a short delay.

## Security Notes

- Removing secrets from `next.config.ts` is mandatory.
- Prefer moving DNS updates entirely into Lambda so Cloudflare token is not needed in Worker runtime (recommended).
- Consider least-privilege IAM for Cloudflare AWS credentials:
  - If most “write” operations move to Lambda, Worker creds can be reduced to read-only + `lambda:InvokeFunction`.

## Verification Plan

- Unit tests:
  - Update API route tests for new `202` behavior and Lambda invocation mocks.
- E2E (mock mode):
  - Ensure UI still works with async operation flow and polling.
- Manual:
  - `pnpm preview:cf` and verify:
    - Start works and status polling reflects progress
    - Backup/restore/hibernate/resume return immediately and complete via Lambda
    - Anonymous status does not expose IP/instance/stack ids

## Definition of Done

- No secrets are exposed client-side (verify bundle does not include `CLOUDFLARE_DNS_API_TOKEN`).
- All long operations work on Cloudflare Workers without timeouts.
- `backupName` injection path removed.
- Locking prevents concurrent operations reliably across UI + email triggers.
- Anonymous endpoints do not leak infra identifiers or public IP.
