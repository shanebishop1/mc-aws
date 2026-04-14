# Real-Environment Smoke CI Credentials Setup (mcaws-a9h.3.3)

This checklist documents how maintainers provision **safe, least-privilege** CI inputs for `.github/workflows/real-environment-smoke.yml`.

> Do not store secret values in the repository. Configure them only in GitHub Environment settings.

## 1) Create and scope a dedicated GitHub Environment

1. In GitHub: **Settings → Environments → New environment**.
2. Create environment named: **`real-environment-smoke`**.
3. Apply protection rules (recommended):
   - Required reviewers for environment secret changes/runs.
   - Restrict branch access to trusted branches only.
   - Keep this environment dedicated to smoke workflow use.

The workflow job is explicitly bound to this environment:

- `jobs.real-environment-smoke.environment.name = real-environment-smoke`

## 2) Configure required environment secrets

Set these as **Environment secrets** on `real-environment-smoke`:

1. `SMOKE_BASE_URL` (required)
   - Production-like smoke target base URL.
   - Must be an HTTPS URL.
   - Example format only: `https://mc.example.com`.
2. `SMOKE_SESSION_COOKIE` (required)
   - Session token/cookie value for a dedicated smoke operator account.
   - Use a low-privilege account limited to required read/safe operations.
   - Rotate regularly and after any operator/account changes.

## 3) Configure environment variables (vars)

Set these as **Environment variables** on `real-environment-smoke`:

### Required / strongly recommended

1. `SMOKE_ENVIRONMENT_LABEL`
   - Human-readable label in smoke summary output.
   - Example: `staging-real-smoke`.

### Optional (workflow has defaults)

1. `SMOKE_EXPECT_BACKEND_MODE` (default: `aws`)
   - Allowed values: `aws`, `mock`.
2. `SMOKE_EXPECT_DOMAIN` (default: empty)
   - Set expected domain when DNS/domain consistency should be enforced.
3. `SMOKE_ENABLE_S5_ENVIRONMENT_PROBE` (default: `false`)
   - Enables optional S5 `/api/costs` probe.
4. `SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE` (default: `false`)
   - When `true`, S5 failure becomes blocking.

## 4) Credential safety checklist

- [ ] Use a dedicated smoke account/session, not a personal maintainer session.
- [ ] Scope underlying cloud/runtime access to required smoke checks only.
- [ ] Disallow destructive operations in account/IAM policy.
- [ ] Set session/token expiration and rotation cadence.
- [ ] Audit who can edit environment secrets/vars.

## 5) What the workflow enforces automatically

Before dependencies are installed or smoke checks run, CI now fails fast if:

1. Required values are missing:
   - `SMOKE_BASE_URL` (secret)
   - `SMOKE_SESSION_COOKIE` (secret)
   - `SMOKE_ENVIRONMENT_LABEL` (var)
2. `SMOKE_BASE_URL` is not HTTPS.
3. `SMOKE_BASE_URL` or `SMOKE_SESSION_COOKIE` appears to be placeholder text.
4. `SMOKE_SESSION_COOKIE` is suspiciously short.

The workflow error points back to this setup document.

## 6) Post-setup verification

1. Trigger **Real-Environment Smoke Verification** manually.
2. Confirm preflight config check passes.
3. Confirm summary artifact is published and includes environment label.
4. If CI reports missing/invalid config, update environment secrets/vars and rerun.
