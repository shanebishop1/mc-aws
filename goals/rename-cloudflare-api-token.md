# Rename Cloudflare DNS Token Env Var

## Goal
Rename the runtime Cloudflare DNS API token environment variable from `CLOUDFLARE_API_TOKEN` to `CLOUDFLARE_DNS_API_TOKEN` across the repo.

## Why
Wrangler (Workers CLI) auto-loads `.env*` files and treats `CLOUDFLARE_API_TOKEN` as its own auth input. Having our DNS token named `CLOUDFLARE_API_TOKEN` inside `.env.production` / `.env.local` can cause:
- `wrangler login` refusing OAuth login (thinks it is in API-token auth mode)
- `wrangler secret put` / `wrangler deploy` failing with `/memberships` auth errors

Renaming removes the collision and makes setup/deploy scripts self-contained and predictable.

## Non-Goals
- Changing what the token can do. This remains a DNS-scoped token (typically "Edit zone DNS").
- Altering Cloudflare deployment strategy beyond removing the env-var collision.

## Target State
- The app/Lambdas/CDK read DNS token from `CLOUDFLARE_DNS_API_TOKEN`.
- `.env.example` uses `CLOUDFLARE_DNS_API_TOKEN` and does not mention `CLOUDFLARE_API_TOKEN` except as a migration note.
- Cloudflare deploy script uploads `CLOUDFLARE_DNS_API_TOKEN` as a Worker secret.
- A compatibility shim exists for a short transition window (optional but recommended): accept `CLOUDFLARE_API_TOKEN` if `CLOUDFLARE_DNS_API_TOKEN` is missing, and/or auto-migrate `.env.local` + `.env.production`.

## Implementation Plan (Atomic Tasks)

### Task 1: Add New Env Var With Backwards-Compatible Fallback
Update server env loading so existing installs keep working.

- Edit `lib/env.ts`
  - Add `CLOUDFLARE_DNS_API_TOKEN` to the env object.
  - Set it from `getEnv("CLOUDFLARE_DNS_API_TOKEN")`.
  - Optional compatibility: if missing, fall back to `getEnv("CLOUDFLARE_API_TOKEN")`.
  - If both are set, prefer `CLOUDFLARE_DNS_API_TOKEN`.
  - If only the old name is set, consider logging a one-time warning to server logs.

Acceptance:
- Code compiles and all callers can read `env.CLOUDFLARE_DNS_API_TOKEN`.

### Task 2: Switch Cloudflare Client To New Env Property

- Edit `lib/cloudflare.ts`
  - Replace uses of `env.CLOUDFLARE_API_TOKEN` with `env.CLOUDFLARE_DNS_API_TOKEN`.

Acceptance:
- Cloudflare API requests use the new token property.

### Task 3: Update Lambda Runtime Env Var Name

- Edit `infra/src/lambda/UpdateDns/index.js`
  - Read token from `process.env.CLOUDFLARE_DNS_API_TOKEN`.
  - Optional compatibility: fall back to `process.env.CLOUDFLARE_API_TOKEN`.

- Edit `infra/src/lambda/StartMinecraftServer/index.js`
  - Read token from `process.env.CLOUDFLARE_DNS_API_TOKEN`.
  - Optional compatibility: fall back to `process.env.CLOUDFLARE_API_TOKEN`.

- Edit `infra/src/lambda/StartMinecraftServer/env.json`
  - Rename key to `CLOUDFLARE_DNS_API_TOKEN`.

Acceptance:
- Lambdas still work if only old var is present (if compatibility is implemented).

### Task 4: Update CDK Stack Env Wiring

- Edit `infra/lib/minecraft-stack.ts`
  - Change Lambda environment key from `CLOUDFLARE_API_TOKEN` to `CLOUDFLARE_DNS_API_TOKEN`.
  - Read from `process.env.CLOUDFLARE_DNS_API_TOKEN`.
  - Optional compatibility: if missing, use `process.env.CLOUDFLARE_API_TOKEN`.

Acceptance:
- CDK synth would include the new env var name for Lambdas.

### Task 5: Update Setup Wizard Prompts + Output Files

- Edit `scripts/setup-wizard.sh`
  - Prompt and store the DNS token in variable `CLOUDFLARE_DNS_API_TOKEN`.
  - Update validation function to validate `CLOUDFLARE_DNS_API_TOKEN`.
  - Update `.env.local` and `.env.production` writers to write `CLOUDFLARE_DNS_API_TOKEN=...`.
  - Update any user-facing text to say "DNS token" and mention it is NOT used for deployment.
  - Migration behavior (recommended):
    - If `CLOUDFLARE_API_TOKEN` exists in env files and `CLOUDFLARE_DNS_API_TOKEN` does not, rewrite the key.
    - Keep the value identical; do not duplicate.

Acceptance:
- Hitting Enter on an empty required field re-prompts (already fixed) and token ends up stored under the new name.

### Task 6: Update Root Setup Script Requirements / Logging

- Edit `setup.sh`
  - Replace required secret name `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_DNS_API_TOKEN`.
  - Update any logging/masking lines to reference the new name.
  - If compatibility is kept, optionally detect and print a warning if the old name is present.

Acceptance:
- Setup no longer demands the old env var.

### Task 7: Update Cloudflare Deployment Script

- Edit `scripts/deploy-cloudflare.sh`
  - Replace required var `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_DNS_API_TOKEN`.
  - Ensure the script uploads `CLOUDFLARE_DNS_API_TOKEN` as a Worker secret.
  - Ensure no wrangler auth guidance references the old name.
  - Migration behavior (recommended):
    - If `.env.production` contains `CLOUDFLARE_API_TOKEN=` and not `CLOUDFLARE_DNS_API_TOKEN=`, auto-rewrite the file.

Acceptance:
- Deploy script does not introduce `CLOUDFLARE_API_TOKEN` into wrangler runtime via dotenv auto-loading.

### Task 8: Update Sample Env + Documentation

- Edit `.env.example`
  - Replace `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_DNS_API_TOKEN`.
  - Add a short note: "Renamed to avoid wrangler auth collision." (keep it concise)

- Update docs that mention the old name:
  - `README.md`
  - `docs/docs/API.md`
  - `docs/docs/QUICK_REFERENCE.md`
  - `docs/docs/IMPLEMENTATION_SUMMARY.md`
  - `docs/docs/FILE_STRUCTURE.md`
  - `docs/aws-touchpoint-inventory.md`
  - Any other matches from a repo search

Acceptance:
- Docs consistently reference `CLOUDFLARE_DNS_API_TOKEN`.

### Task 9: Update Tests / Fixtures

- Edit `tests/setup.ts`
  - Replace `CLOUDFLARE_API_TOKEN` with `CLOUDFLARE_DNS_API_TOKEN`.

Acceptance:
- No test helpers rely on the old name.

### Task 10: Remove Old Name From Codebase (Post-Compat Cleanup)
After the compatibility window (or immediately if you choose breaking-only):

- Remove fallbacks to `CLOUDFLARE_API_TOKEN`.
- Remove any remaining mentions of `CLOUDFLARE_API_TOKEN` from scripts/docs.

Acceptance:
- A repo-wide search for `CLOUDFLARE_API_TOKEN` returns 0 matches (or only an explicit migration note, if you keep one).

## Notes / Engineer Guidance
- Treat this as a rename with minimal behavioral change.
- Keep the variable meaning explicit: it is a DNS-scoped token, not a deployment token.
- If implementing auto-migration of env files, be careful to:
  - preserve comments and formatting as much as possible
  - avoid duplicating keys
  - avoid printing secret values to stdout
