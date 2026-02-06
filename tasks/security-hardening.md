# Tasks - Security Hardening

## In Progress


## To Do


## Backlog


## Done

- [x] Debugger: Establish baseline (prior audit + current) HIGH findings. Collect: (a) dependency HIGHs (root + any nested package.json), (b) infra IAM findings (ANY_RESOURCE uses; kms:Decrypt on '*'). Output a short note with package paths/CVEs (if available) and exact policy statements/lines. Validation: attach command outputs/grep excerpts + list of HIGH items to close. References: `package.json`, `pnpm-lock.yaml`, `infra/lib/minecraft-stack.ts`.
- [x] Engineer: Close Google Drive OAuth CSRF/state gap and remove unsafe mock override. Implement `state` generation in `app/api/gdrive/setup/route.ts` and validation in `app/api/gdrive/callback/route.ts` (reject missing/mismatch; clear state after use). Ensure `?mock=true` cannot force mock flow unless `isMockMode()` is true. Add automated coverage (unit/integration) for state + mock override behavior if repo has existing test harness. Validation: tests exist for (1) missing state, (2) mismatched state, (3) valid state, (4) mock override ignored when not in mock mode. References: `app/api/gdrive/setup/route.ts`, `app/api/gdrive/callback/route.ts`, `docs/QUICK_START_MOCK_MODE.md`.
- [x] Debugger: Validate Google Drive OAuth hardening. Run relevant unit tests (`pnpm test`, `pnpm test:mock`) and spot-check route behavior (e.g., setup returns authUrl with state; callback rejects invalid/missing state). Validation: provide test results + minimal reproduction steps confirming mock override blocked outside mock mode.
- [x] Researcher: Determine least-privilege replacement for wildcard `kms:Decrypt` in EC2 role for SSM SecureString reads and for `cr.AwsCustomResourcePolicy.ANY_RESOURCE` usages in `infra/lib/minecraft-stack.ts`. Prefer an approach that (a) passes common IaC security scanners, and (b) does not require migrating existing SSM parameters unless necessary. Validation: link to AWS/IAM/KMS/SSM docs and propose exact policy statement(s) to implement.
- [x] Engineer: Tighten CDK IAM policies where practical (per research). Replace `AwsCustomResourcePolicy.ANY_RESOURCE` for GitHub PAT SSM custom resource with parameter-scoped resources; tighten `kms:Decrypt` to remove `Resource: "*"` (or implement audit-accepted equivalent). If feasible without risk, also scope other broad statements (e.g., StopInstances, volume actions) via resource ARNs and/or tag conditions. Validation: `infra/lib/minecraft-stack.ts` contains no avoidable `ANY_RESOURCE` and no `kms:Decrypt` on `"*"` for EC2 role.
- [x] Debugger: Validate CDK IAM tightening. Run `pnpm cdk:synth` and `pnpm cdk:diff` and ensure they succeed. Validate: generated IAM policies reflect tightened resources/conditions; document any remaining wildcards with rationale (e.g., actions that lack resource-level permissions).
- [x] Debugger: Dependency vulnerability triage (HIGH severity). Run dependency audit for root workspace and identify HIGHs (notably wrangler + transitive). Propose safe upgrade path: target versions, any breaking changes, and whether lockfile overrides/resolutions are needed. Validation: provide a short upgrade plan listing each HIGH vulnerability, affected package chain, and remediation approach.
- [x] Debugger: Apply dependency upgrades to remediate feasible HIGH vulnerabilities. Update `package.json`/`pnpm-lock.yaml` accordingly (and any nested lambda package locks if applicable). Validation: `pnpm audit` (or equivalent) shows 0 HIGH vulnerabilities after upgrade, or produce explicit exception list with justification + follow-up plan.
- [x] Engineer: Fix any regressions introduced by dependency upgrades (only if needed). Address build/test/runtime issues (Next/OpenNext/Wrangler config, TypeScript changes, API behavior) while keeping security posture improved. Validation: the repo builds and tests pass on the upgraded dependency set.
- [x] Debugger: Final verification pass. Run `pnpm build`, `pnpm test`, and (if used in workflow) `pnpm test:e2e:mock`. Re-run dependency audit and confirm the three known HIGH findings are closed. Validation: provide final checklist: OAuth state+mock fix verified; IAM tightening verified via synth/diff; 0 HIGH dependency vulns (or documented exceptions).
