# Security Hardening PRD

Date: 2026-02-05

## Summary

Harden mc-aws against HIGH severity security findings from the prior audit by closing the Google Drive OAuth CSRF/state gap, removing unsafe mock overrides, tightening over-broad IAM policies in CDK, and remediating feasible HIGH dependency vulnerabilities.

## Goals

- Eliminate CSRF risk in the Google Drive OAuth callback by adding and validating `state` (and tightening callback behavior accordingly).
- Ensure mock-mode behavior cannot be enabled via request parameters in non-mock environments.
- Reduce IAM blast radius in `infra/lib/minecraft-stack.ts` by replacing `ANY_RESOURCE` and wildcard KMS decrypt where practical.
- Upgrade dependencies to remove HIGH severity vulnerabilities where feasible without destabilizing the app/deploy.

## Non-Goals

- Addressing the audit concern "PAT in URL in user_data.sh" (explicitly out of scope).
- Full OAuth redesign (new provider, database sessions, etc.).
- Large infrastructure redesign (multi-account, SCPs, VPC redesign).

## Users

- Admin operator: uses the dashboard to set up Google Drive backups and manage the server.
- Maintainer: deploys CDK stack and Cloudflare Workers build; wants least-privilege defaults.

## Use Cases

1. Admin initiates Google Drive setup; the app creates an authorization URL containing a cryptographically strong `state` and stores the state server-side or in a secure cookie.
2. Google redirects back to `/api/gdrive/callback`; the app validates `state` and rejects mismatches/omissions.
3. In non-mock mode, an attacker cannot force mock behavior via `?mock=true` or similar overrides.
4. CDK deploy creates only narrowly-scoped IAM permissions required for custom resources and SSM SecureString reads.
5. Dependency audit reports no HIGH severity vulnerabilities (or documents the residual exceptions with justification).

## Success Criteria

- Google Drive OAuth callback rejects requests with missing/invalid `state` and does not write tokens in those cases.
- `app/api/gdrive/callback/route.ts` ignores `mock` query parameters unless mock mode is enabled by environment.
- CDK stack no longer uses `cr.AwsCustomResourcePolicy.ANY_RESOURCE` where scoping is supported (e.g., SSM parameter writes).
- IAM does not grant `kms:Decrypt` on `"*"` for the EC2 instance role (or is replaced with an equally-safe, audit-accepted restriction).
- `pnpm audit` (or equivalent) reports 0 HIGH vulnerabilities in the root workspace after remediation; any remaining HIGHs are explicitly listed with rationale and follow-up plan.

## Dependencies & References

### Primary Code Paths

- `app/api/gdrive/setup/route.ts` (OAuth initiation URL generation; add state)
- `app/api/gdrive/callback/route.ts` (OAuth callback; validate state; remove unsafe mock override)
- `lib/aws/ssm-client.ts` (SSM token writes; relevant if KMS key handling changes)
- `lib/api-auth.ts` (admin authorization gate used by gdrive routes)
- `infra/lib/minecraft-stack.ts` (IAM statements; custom resources; KMS decrypt)
- `package.json` and `pnpm-lock.yaml` (dependency remediation)

### Related Docs

- `docs/GOOGLE_OAUTH_SETUP.md` (Google OAuth configuration reference)
- `docs/QUICK_START_MOCK_MODE.md` and `docs/MOCK_MODE_DEVELOPER_GUIDE.md` (mock-mode expectations)
