# High-Signal Improvements Implementation Plan

**Status:** Draft  
**Owner:** Engineering  
**Last Updated:** 2026-04-11

## 1) Objective

Deliver the highest-signal improvements identified across multiple independent repo reviews without getting sidetracked by style cleanup or low-value refactors.

This plan focuses on the areas with the strongest overlap and the highest operational payoff:

1. Rework long-running server operations so they are reliable and observable.
2. Make Cloudflare runtime-state deployment deterministic and fail-fast.
3. Add production-like verification for the real infrastructure path.
4. Reduce control-plane duplication across API routes, Lambda handlers, and AWS helpers.
5. Harden deploy/config safety, especially env validation and secret handling.

## 2) Guiding Principles

- Prioritize reliability and deploy correctness over cosmetic cleanup.
- Prefer small, staged changes with explicit rollback points.
- Preserve existing external API contracts unless a contract change is necessary and intentional.
- Fail fast in production when a critical binding or required config is missing.
- Keep mock-mode speed and usability while raising confidence in real-cloud paths.

## 3) Current Problem Summary

### A. Long-running operations are not a good fit for the current execution model

- `infra/lib/minecraft-stack.ts` defines `StartMinecraftLambda` with a 60 second timeout.
- Lambda-side command handling under `infra/src/lambda/StartMinecraftServer/**` includes multi-step flows, EC2 polling, SSM polling, and backup/restore orchestration that can exceed that budget.
- API routes under `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts` rely on this control plane for state-changing operations.
- `lib/server-action-lock.ts` protects against concurrent actions, but lock lifecycle is still exposed to timeout and partial-completion risk.

### B. Cloudflare runtime-state production wiring is not deterministic enough

- `wrangler.jsonc` declares `RuntimeStateDurableObject` and KV bindings.
- `wrangler.jsonc` still contains placeholder KV IDs.
- `lib/runtime-state/provider-selector.ts` falls back to in-memory when bindings are absent.
- That behavior is acceptable for local/test use, but dangerous if it silently occurs in production.

### C. CI confidence is skewed toward mock mode

- `.github/workflows/baseline-pr-validation.yml` runs strong baseline checks plus mock-focused lanes.
- Existing test investment is good, but the real deployment path still has weak pre-merge verification.
- The most consequential failures in this repo are likely infra/runtime mismatches rather than UI regressions.

### D. Control-plane logic is spread across too many layers

- API routes, AWS client helpers, Lambda handlers, and EC2 scripts each carry part of the orchestration model.
- Validation and state-transition logic risks drifting over time.
- This increases review difficulty and makes failures harder to diagnose.

### E. Deploy/config safety can be improved

- `lib/env.ts` allows missing required values to degrade into warnings and empty strings.
- `scripts/deploy-cloudflare.sh` is a critical deploy path and should strictly control which secrets reach the Worker runtime.
- Configuration correctness should be enforced intentionally rather than inferred from runtime behavior.

## 4) Delivery Strategy

Implement this work in five workstreams, in order. The order matters because later work depends on earlier system clarity.

1. Workstream 1: Operation execution model and observability
2. Workstream 2: Runtime-state correctness in Cloudflare production
3. Workstream 3: Production-like smoke verification
4. Workstream 4: Control-plane consolidation
5. Workstream 5: Deploy/config hardening

Some work can overlap, but Workstreams 1 and 2 should start first because they address the highest reliability risk.

## 5) Workstream 1: Reliable Long-Running Operations

### Goal

Ensure start, backup, restore, hibernate, and resume operations complete reliably, surface durable status, and do not silently fail because of Lambda timeout or partial progress.

### Recommended approach

Use a staged approach instead of jumping straight to a full orchestration rewrite.

#### Phase 1A: Stabilize the current model

- Increase Lambda timeout to a realistic ceiling for current workflows in `infra/lib/minecraft-stack.ts`.
- Audit every multi-step handler under `infra/src/lambda/StartMinecraftServer/**` for worst-case runtime.
- Make command completion semantics explicit for API-triggered invocations.
- Ensure lock acquire/release behavior in `lib/server-action-lock.ts` is safe under timeout and error paths.
- Add durable operation logging for operation id, action type, caller, start time, end time, and final status.

#### Phase 1B: Introduce explicit operation status

- Define a typed operation model in a shared module, for example:
  - operation id
  - action kind
  - requested by
  - current state (`queued`, `running`, `succeeded`, `failed`, `cancelled`)
  - timestamps
  - human-readable summary
  - error summary
- Persist operation state in a durable backing store already used by the system where practical.
- Update mutating API routes to return accepted status with an operation id for long-running actions.
- Add a read endpoint for operation status if one does not already exist.

#### Phase 1C: Move to a durable async workflow

- Replace the “single Lambda does the whole job inline” model with one of these approaches:
  - preferred: Step Functions for multi-step orchestration and retries
  - acceptable: SQS-backed worker model with durable status updates
- Keep `lib/server-action-lock.ts` as the concurrency guard unless the new workflow fully replaces that responsibility.
- Ensure operation retries are idempotent or explicitly guarded.

### Impacted files/areas

- `infra/lib/minecraft-stack.ts`
- `infra/src/lambda/StartMinecraftServer/index.js`
- `infra/src/lambda/StartMinecraftServer/ec2.js`
- `infra/src/lambda/StartMinecraftServer/ssm.js`
- `infra/src/lambda/StartMinecraftServer/handlers/*`
- `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`
- `lib/server-action-lock.ts`
- `lib/types.ts` or a new shared operation-status module

### Tasks

- T1.1: Measure and document runtime budgets for each mutating action.
- T1.2: Raise Lambda timeout and align retry/timeout settings with actual worst-case behavior.
- T1.3: Add explicit operation ids and durable status records.
- T1.4: Update API responses for long-running actions to report operation status consistently.
- T1.5: Add status polling endpoint and UI handling if needed.
- T1.6: Migrate to durable async orchestration after status plumbing is in place.

### Acceptance criteria

- No mutating action depends on a 60 second inline completion assumption.
- Every long-running action has a durable status record.
- A timed-out or failed invocation does not leave ambiguous user-visible state.
- Lock cleanup and ownership remain correct under retries and failures.
- Users can distinguish `accepted`, `running`, `succeeded`, and `failed` states.

### Validation

- Unit tests for operation state transitions and lock lifecycle.
- Integration tests for start, backup, restore, hibernate, and resume accepted-status flows.
- Failure injection for timeout, SSM failure, EC2 polling failure, and partial backup failure.

## 6) Workstream 2: Cloudflare Runtime-State Correctness

### Goal

Ensure the production runtime either has the required Durable Object and KV bindings correctly configured or fails immediately and clearly.

### Approach

#### Phase 2A: Close the configuration gap

- Audit the actual Worker bundle entrypoint and verify whether `RuntimeStateDurableObject` is exported into the deployed Worker.
- Replace placeholder KV ids in `wrangler.jsonc` through setup/deploy automation rather than manual editing.
- Ensure migrations match the real class names and deployment flow.

#### Phase 2B: Change fallback behavior by environment

- Keep in-memory fallback only for local development and test.
- In production, make missing bindings a startup failure or a hard runtime error with a clear diagnostic.
- Update `lib/runtime-state/provider-selector.ts` so production does not silently degrade.

#### Phase 2C: Add verification and observability

- Add a startup/runtime self-check endpoint or diagnostic log path that confirms which runtime-state adapter is active.
- Add telemetry fields for runtime-state adapter kind and binding completeness.
- Add deployment-time validation that rejects placeholder ids or missing bindings.

### Impacted files/areas

- `wrangler.jsonc`
- `lib/runtime-state/provider-selector.ts`
- `lib/runtime-state/*`
- Cloudflare deploy/setup scripts
- Existing runtime-state docs under `docs/epics/durable-cloudflare-runtime-state/**`

### Tasks

- T2.1: Verify Worker-side Durable Object implementation and exports.
- T2.2: Remove placeholder configuration from deployable paths.
- T2.3: Make production binding absence fail fast.
- T2.4: Add deployment validation for runtime-state bindings and migrations.
- T2.5: Add a diagnostic test proving Cloudflare adapter selection under valid bindings.

### Acceptance criteria

- Production deployments cannot proceed with placeholder runtime-state config.
- Production runtime cannot silently fall back to in-memory adapter.
- Adapter selection is deterministic across local, test, preview, and production.
- Runtime diagnostics clearly show whether Cloudflare or in-memory state is active.

### Validation

- Unit tests for `selectRuntimeStateAdapterKind` and production failure behavior.
- Preview deployment check using real Wrangler config.
- Smoke test that exercises rate-limit and snapshot paths with actual bindings.

## 7) Workstream 3: Production-Like Smoke Verification

### Goal

Add a small but real confidence lane that exercises critical infrastructure compatibility before changes are trusted.

### Approach

Keep the fast mock suite. Add a narrow real-environment lane focused on compatibility rather than broad functional coverage.

### Scope for the first smoke lane

- Auth/config bootstrap sanity
- Status endpoint against real backend
- Lambda invoke path for a safe or dry-run action
- DNS/runtime-state health checks where practical
- Optional non-destructive backup listing or environment probe

### Constraints

- Must avoid destructive operations by default.
- Must be runnable on a schedule and manually.
- Should target a dedicated low-risk environment or preview stack.

### Impacted files/areas

- `.github/workflows/*`
- test harness scripts under `scripts/` or `tests/`
- deploy docs and maintainer docs under `docs/epics/ci-gate-workflow/**`

### Tasks

- T3.1: Define the minimal real-env smoke contract.
- T3.2: Create a dedicated workflow for scheduled and manual execution.
- T3.3: Provision least-privilege CI credentials/secrets for the smoke lane.
- T3.4: Add reporting that clearly distinguishes mock failure vs real-env failure.
- T3.5: Gate sensitive actions so destructive tests require explicit manual approval.

### Acceptance criteria

- There is at least one reproducible real-environment smoke lane.
- It runs without requiring full manual ad hoc setup.
- It catches missing credentials, bad bindings, and deployment/runtime mismatches early.
- It is documented well enough for maintainers to rerun and debug.

### Validation

- Successful scheduled run in the target environment.
- Intentional misconfiguration test proving the lane fails loudly.
- Maintainer runbook with expected outputs and rollback guidance.

## 8) Workstream 4: Control-Plane Consolidation

### Goal

Reduce drift and debugging cost by moving shared operation concepts into one typed orchestration layer rather than scattering them across routes, Lambda handlers, and scripts.

### Approach

Do not rewrite everything at once. First define the shared contract, then migrate one operation at a time.

### Target end state

- API routes perform auth, request parsing, rate limiting, and response shaping.
- A shared command/orchestration layer owns operation validation, state transitions, and status writes.
- AWS-specific modules own AWS interactions only.
- EC2 shell scripts remain thin execution units rather than carrying orchestration logic.

### Impacted files/areas

- `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`
- `lib/aws/*`
- `infra/src/lambda/StartMinecraftServer/handlers/*`
- `lib/sanitization.ts`
- `infra/src/lambda/StartMinecraftServer/sanitization.js`
- `lib/types.ts`

### Tasks

- T4.1: Define a single typed action contract shared by routes and execution layer.
- T4.2: Centralize validation and sanitization for backup/restore/resume inputs.
- T4.3: Centralize status mapping and error normalization.
- T4.4: Migrate one action path first, ideally `start`, then apply the pattern to the remaining mutating actions.
- T4.5: Remove duplicated logic once each route is migrated.

### Acceptance criteria

- Mutating routes share one command contract and one error/status mapping strategy.
- Sanitization logic is not duplicated across TypeScript and Lambda JavaScript without a documented reason.
- Adding a new action no longer requires touching multiple orchestration layers inconsistently.

### Validation

- Contract tests for all action kinds.
- Regression tests proving unchanged API response shape where intended.
- Review pass confirming each migrated route uses the shared orchestration path.

## 9) Workstream 5: Deploy and Config Hardening

### Goal

Prevent “deploy succeeded, runtime broke” failures and reduce unnecessary secret exposure.

### Approach

Split this into env validation hardening and secret-handling hardening.

#### Phase 5A: Env validation hardening

- Replace warning-and-empty-string behavior for production-critical variables in `lib/env.ts` with explicit required/optional semantics.
- Keep developer-friendly softness only for local workflows where that is intentional.
- Add environment-aware validation modes for local, CI, preview, and production.

#### Phase 5B: Secret allowlisting in Cloudflare deploys

- Audit which env vars the Worker runtime truly needs.
- Replace any broad upload pattern in `scripts/deploy-cloudflare.sh` with an explicit allowlist.
- Keep infrastructure-only secrets out of the Worker runtime if they are not needed there.

#### Phase 5C: Deployment guardrails

- Fail deployment when required runtime secrets are missing.
- Fail deployment when placeholder values remain.
- Fail deployment when runtime-state bindings are not fully configured.

### Impacted files/areas

- `lib/env.ts`
- `scripts/validate-env.ts`
- `scripts/deploy-cloudflare.sh`
- setup/deploy docs under `docs/`

### Tasks

- T5.1: Define env schema by environment and runtime target.
- T5.2: Implement strict validation for production and CI.
- T5.3: Add a Worker secret allowlist and document each allowed secret.
- T5.4: Reject placeholder values and missing runtime-state configuration at deploy time.
- T5.5: Update setup docs so manual configuration paths match the new guardrails.

### Acceptance criteria

- Production-critical env vars cannot degrade silently to empty strings.
- Worker deploy only uploads runtime-required secrets.
- Deploy scripts fail clearly on placeholder or incomplete production configuration.
- Docs match the actual deploy flow.

### Validation

- Unit tests for env parsing and failure conditions.
- Script-level verification with representative env files.
- Manual dry-run deploy validation in a non-production environment.

## 10) Cross-Cutting Quick Wins

These are not the primary workstreams, but they are high-signal enough to bundle into the implementation effort when touching the same areas.

### Quick Win A: Fix the resume volume attach bug

- Review and patch `lib/aws/volume-client.ts` so resume/attach logic consistently uses the resolved instance id rather than an undefined or stale input.
- Add regression coverage around the attach path.

### Quick Win B: Tighten command parsing for email-triggered actions

- Review `infra/src/lambda/StartMinecraftServer/command-parser.js` to avoid ambiguous substring matches.
- Require exact command tokenization for action detection.

### Quick Win C: Add route-level throttling for mutating endpoints

- Audit rate-limit coverage on `app/api/{start,stop,backup,restore,hibernate,resume}`.
- Apply route-specific limits where absent.
- Ensure production runtime-state correctness lands before relying on globally enforced throttling in Cloudflare.

## 11) Suggested Delivery Sequence

### Milestone 1: Immediate stabilization

- Workstream 1 Phase 1A
- Workstream 2 Phase 2A
- Quick Win A
- Quick Win B

### Milestone 2: Fail-fast production correctness

- Workstream 2 Phase 2B and 2C
- Workstream 5 Phase 5A and 5C
- Quick Win C

### Milestone 3: Durable action status and smoke verification

- Workstream 1 Phase 1B
- Workstream 3

### Milestone 4: Structural simplification

- Workstream 4
- Workstream 5 Phase 5B

### Milestone 5: Full async orchestration

- Workstream 1 Phase 1C
- Final cleanup of legacy orchestration paths

## 12) Dependency Map

- Workstream 1 depends on clear command and state ownership decisions.
- Workstream 2 should be completed before relying on Cloudflare-backed global coordination in production.
- Workstream 3 depends on Workstreams 2 and 5 enough to make preview/prod-like validation meaningful.
- Workstream 4 should begin after Workstream 1 has clarified the target orchestration model.
- Workstream 5 should start early because it reduces deployment ambiguity for all other workstreams.

## 13) Risks and Mitigations

### Risk: Too much change lands at once in the control plane

Mitigation:

- Ship workstream phases separately.
- Add feature flags or transitional routing where needed.
- Keep API contracts stable while internals change.

### Risk: New fail-fast behavior disrupts previously tolerated but broken setups

Mitigation:

- Introduce clear preflight checks and docs before enforcing hard failures.
- Roll out strict validation in preview first, then production.

### Risk: Real-env smoke tests become flaky or destructive

Mitigation:

- Keep smoke scope narrow and non-destructive.
- Use a dedicated environment.
- Require explicit approval for any state-changing verification.

### Risk: Durable action-status layer becomes another duplicated subsystem

Mitigation:

- Treat operation state as the canonical path and migrate routes toward it incrementally.
- Do not maintain parallel “old” and “new” status models longer than necessary.

## 14) Definition of Done

This implementation plan is complete when all of the following are true:

- Long-running actions no longer depend on a short inline Lambda success path.
- Production Cloudflare runtime-state configuration is deterministic and validated.
- At least one real-environment smoke lane exists and is documented.
- Mutating action orchestration is materially less duplicated than today.
- Production env/deploy validation is strict enough to catch missing or placeholder config before runtime.
- The known high-signal quick wins bundled with this effort have regression coverage.

## 15) Recommended Next Step

Start with a short execution spike covering these three concrete outputs:

1. Document measured runtime budgets for each mutating action.
2. Verify the actual Worker-side `RuntimeStateDurableObject` implementation and binding path.
3. Produce a production env/runtime secret matrix showing what the Worker, Lambda, and EC2 instance each actually need.

That spike should remove the biggest unknowns before implementation begins.

## 16) Story Breakdown

This section splits each major improvement area into smaller execution stories. Each story is sized to be independently reviewable and testable.

### Workstream 1: Reliable Long-Running Operations

#### Story 1.1: Measure and align runtime budgets

- Audit real and worst-case runtimes for `start`, `backup`, `restore`, `hibernate`, and `resume`.
- Compare those runtimes against the Lambda timeout and polling behavior.
- Update `infra/lib/minecraft-stack.ts` timeout and related settings to match current reality.

Definition of done:

- Runtime budget table exists for each action.
- Timeout settings are updated and justified.
- No current action is guaranteed to exceed its configured execution ceiling under expected conditions.

Runtime budget baseline (Story 1.1 implementation):

| Action | Polling/retry ceilings used in path | Estimated worst-case total |
| --- | --- | --- |
| `start` | `resume` volume available (`30 x 5s = 150s`) + volume attach (`30 x 2s = 60s`) + instance running (`30 x 5s = 150s`) + public IP (`120 x 1s = 120s`) | ~480s (8m) |
| `backup` | instance running (`30 x 5s = 150s`) + backup SSM command (`60 x 2s = 120s`) + refresh-backups instance check (`30 x 5s = 150s`) + refresh-backups SSM (`60 x 2s = 120s`) | ~540s (9m) |
| `restore` | instance running (`30 x 5s = 150s`) + restore SSM command (`60 x 2s = 120s`) | ~270s (4.5m) |
| `hibernate` | pre-stop backup SSM (`60 x 2s = 120s`) + stop polling (`30 x 5s = 150s`) + detach polling (`30 x 2s = 60s` per volume) | ~330s (5.5m) for single volume |
| `resume` | volume available (`30 x 5s = 150s`) + volume attach (`30 x 2s = 60s`) + instance running (`30 x 5s = 150s`) + public IP (`120 x 1s = 120s`) + resume SSM (`60 x 2s = 120s`) + optional restore SSM (`60 x 2s = 120s`) | ~600s (10m) baseline, ~720s (12m) with restore |

Notes:

- These are deterministic ceilings from the current handler polling loops, not production percentile measurements.
- Lambda timeout for `StartMinecraftLambda` is set to 15 minutes (`900s`) with async retries disabled (`retryAttempts: 0`) so the configured execution ceiling stays above all documented mutating action budgets while avoiding duplicate non-idempotent retries.

#### Story 1.2: Make operation outcomes explicit at the API layer

- Standardize mutating route responses under `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`.
- Return a consistent accepted/running/completed/failed model for long-running operations.
- Introduce operation ids in responses for actions that are not truly synchronous.

Definition of done:

- Mutating routes share one response pattern for long-running work.
- Operation ids are returned where appropriate.
- Client-visible state is less ambiguous than the current inline-success model.

#### Story 1.3: Persist operation status durably

- Define a shared operation-status model.
- Persist operation state transitions for long-running actions.
- Add a read path for status lookup by operation id.

Definition of done:

- Each long-running action writes durable status records.
- Status can be queried independently of the original request lifecycle.
- Failures include a summarized error reason.

#### Story 1.4: Harden lock lifecycle and failure recovery

- Audit `lib/server-action-lock.ts` usage in all mutating routes and handlers.
- Ensure lock release/expiry logic is safe under timeout, retries, and partial failure.
- Add explicit tests for stale lock cleanup and ownership validation.

Definition of done:

- Lock ownership behavior is consistent across all mutating actions.
- Timeout and retry paths do not leave confusing lock state behind.
- Regression coverage exists for the main lock failure modes.

#### Story 1.5: Move to durable async orchestration

- Replace the “single inline Lambda does the whole operation” pattern with a durable async workflow.
- Keep the public API contract stable while changing the internals.
- Add retries and idempotency where needed.

Definition of done:

- Long-running actions no longer depend on short inline Lambda completion.
- Operation progress survives worker/invocation boundaries.
- Retry behavior is documented and tested.

### Workstream 2: Cloudflare Runtime-State Correctness

#### Story 2.1: Verify and wire the Durable Object implementation

- Confirm the real Worker bundle includes `RuntimeStateDurableObject`.
- Ensure the declared binding in `wrangler.jsonc` matches the implementation and migration names.
- Fix any missing export or bundling gap.

Definition of done:

- The configured Durable Object class actually exists in the deployed Worker path.
- Binding names, class names, and migrations all line up.
- Preview deployment no longer relies on guesswork here.

#### Story 2.2: Eliminate placeholder runtime-state configuration

- Remove placeholder KV ids from deployable config paths.
- Move KV and Durable Object setup into explicit setup/deploy steps.
- Add checks that reject placeholder values before deploy.

Definition of done:

- `wrangler.jsonc` and deploy flow cannot proceed with placeholder runtime-state values.
- Maintainers have one clear path for binding setup.

#### Story 2.3: Make production fallback fail fast

- Update `lib/runtime-state/provider-selector.ts` so missing production bindings do not silently degrade to in-memory.
- Keep local/test in-memory behavior intact.
- Surface a clear diagnostic when bindings are missing.

Definition of done:

- Production runtime either has valid bindings or fails loudly.
- Development and test behavior remain ergonomic.
- Adapter selection behavior is environment-specific and explicit.

#### Story 2.4: Add runtime-state diagnostics and tests

- Add diagnostic logging or a health check to show which runtime-state adapter is active.
- Add tests covering adapter selection and production failure conditions.
- Verify rate-limit/snapshot flows using real bindings in preview if possible.

Definition of done:

- Maintainers can tell which adapter is active without guesswork.
- Tests cover both valid Cloudflare bindings and missing-binding failure paths.

### Workstream 3: Production-Like Smoke Verification

#### Story 3.1: Define the minimum real-environment smoke contract

- Decide which actions are safe and meaningful for a real smoke lane.
- Keep scope narrow: auth/config sanity, status, runtime-state health, safe invoke path.
- Document what the smoke lane does and does not guarantee.

Definition of done:

- A written smoke contract exists.
- The scope is non-destructive by default.
- The lane is targeted at compatibility, not exhaustive testing.

#### Story 3.2: Build the smoke workflow

- Add a dedicated GitHub Actions workflow for scheduled and manual real-env verification.
- Give it clear concurrency, timeout, and reporting behavior.
- Separate smoke reporting from existing mock lanes.

Definition of done:

- A real-env smoke workflow exists and is runnable.
- It can be triggered manually and on a schedule.
- Results are easy to distinguish from baseline and mock lanes.

#### Story 3.3: Provision safe CI credentials and environment

- Create the least-privilege credentials and secrets needed for the smoke lane.
- Point the lane at a dedicated preview or low-risk environment.
- Ensure destructive actions require separate approval or are excluded entirely.

Definition of done:

- Smoke credentials are scoped appropriately.
- The workflow does not require production-level privilege.
- The environment choice is documented.

#### Story 3.4: Add maintainer runbook and failure triage

- Document expected outputs, common failure modes, and rollback/escalation steps.
- Explain how to rerun the smoke lane locally or manually.
- Make it clear when a smoke failure should block a release.

Definition of done:

- Maintainers have a runbook for rerun and debugging.
- Failure handling is explicit instead of tribal knowledge.

### Workstream 4: Control-Plane Consolidation

#### Story 4.1: Define a shared mutating-action contract

- Introduce one typed command model for start/stop/backup/restore/hibernate/resume.
- Define shared request validation, operation metadata, and result mapping.
- Use this contract at the route layer and execution layer.

Definition of done:

- Mutating actions share one formal contract.
- Route-specific ad hoc command shapes are reduced or eliminated.

#### Story 4.2: Centralize validation and sanitization

- Consolidate shared input validation for backup names, restore targets, and related arguments.
- Reduce duplication between `lib/sanitization.ts` and Lambda-side sanitization logic.
- Document any remaining runtime-specific validation that cannot be shared.

Definition of done:

- Validation rules are defined once unless there is a runtime-specific reason not to.
- Behavior is consistent across route and Lambda execution paths.

#### Story 4.3: Centralize error and status mapping

- Standardize how execution-layer failures become API responses and operation-status updates.
- Remove inconsistent per-route error shaping where possible.
- Add a shared translation layer for actionable vs internal errors.

Definition of done:

- Similar failures produce similar user-visible behavior.
- Error mapping is no longer scattered across each route and handler.

#### Story 4.4: Migrate one action path end-to-end

- Use `start` as the first full migration target.
- Route it through the shared contract, validation, and status model.
- Prove the new pattern before migrating the remaining actions.

Definition of done:

- One action path is fully migrated and covered.
- The migration pattern is clear enough to repeat safely.

#### Story 4.5: Migrate remaining mutating actions and remove drift

- Apply the new pattern to `stop`, `backup`, `restore`, `hibernate`, and `resume`.
- Remove now-obsolete duplicated orchestration code.
- Keep behavior stable unless an intentional contract change is documented.

Definition of done:

- All mutating actions use the consolidated path.
- Redundant orchestration logic has been removed.

### Workstream 5: Deploy and Config Hardening

#### Story 5.1: Define environment and runtime config schema

- Categorize env vars by runtime target: Worker, Lambda, EC2, local dev, CI.
- Mark each as required, optional, deprecated, or forbidden for a given target.
- Use that matrix to drive validation and docs.

Definition of done:

- A single source of truth exists for config ownership and requirements.
- Runtime-specific config confusion is reduced.

#### Story 5.2: Enforce strict production validation

- Update `lib/env.ts` and `scripts/validate-env.ts` so production-critical values fail clearly instead of downgrading to warnings.
- Preserve softer behavior only where explicitly intended for local development.
- Add tests for failure cases.

Definition of done:

- Production-critical missing config does not silently become empty strings.
- CI and production validation are strict and test-covered.

#### Story 5.3: Restrict Worker secret upload to an explicit allowlist

- Audit `scripts/deploy-cloudflare.sh` and the actual Worker runtime needs.
- Upload only the secrets required by the Worker.
- Keep non-Worker secrets out of the Worker runtime.

Definition of done:

- Worker secret upload is explicit and documented.
- Secret blast radius is reduced.

#### Story 5.4: Add deployment guardrails for incomplete setup

- Fail deployment when placeholders remain.
- Fail deployment when runtime-state bindings are incomplete.
- Fail deployment when required secrets for the chosen target are missing.

Definition of done:

- Broken deploy configuration is rejected before runtime.
- Maintainers get clear error messages about what is missing.

### Optional bundled quick-win stories

#### Quick Win Q1: Fix resume attach bug in volume client

- Patch `lib/aws/volume-client.ts` to use the resolved instance id consistently.
- Add regression coverage around the resume attach path.

#### Quick Win Q2: Tighten email command parsing

- Replace ambiguous substring matching in `infra/src/lambda/StartMinecraftServer/command-parser.js` with exact tokenized parsing.
- Add tests for overlapping command names.

#### Quick Win Q3: Add throttling to mutating routes

- Audit and add route-level rate limiting to mutating endpoints.
- Align this with the runtime-state hardening work so production enforcement is trustworthy.
