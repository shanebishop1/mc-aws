# PRD: Workstream 2 - Cloudflare Runtime-State Correctness

**Epic:** High-Signal Improvements Implementation  
**Feature:** Workstream 2: Cloudflare Runtime-State Correctness  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Ensure production runtime-state configuration is deterministic and fails fast when bindings or migrations are incomplete.

## 2) Scope and Non-Goals

### In Scope

- Story 2.1 through 2.4 from the source plan.

### Non-Goals

- Broad runtime-state redesign beyond deterministic binding correctness and diagnostics.

## 3) Impacted Files/Areas

- `wrangler.jsonc`
- `lib/runtime-state/provider-selector.ts`
- `lib/runtime-state/*`
- Cloudflare setup/deploy scripts and docs

## 4) Dependencies

- Upstream: none (can start immediately)
- Downstream dependents: Workstream 3 smoke verification; Quick Win Q3 throttling confidence

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Binding and Configuration Correctness)
  - T-2.1 | Lane: WS2-L1 | Task: Verify Worker Durable Object implementation and exports
    - Action: Confirm deployed Worker bundle exports `RuntimeStateDurableObject` and class/binding/migration naming matches runtime config.
    - Definition of Done: Durable Object class export and wrangler binding/migration names are aligned and verified.
  - T-2.2 | Lane: WS2-L1 | Task: Eliminate placeholder runtime-state configuration
    - Action: Remove placeholder KV/runtime-state values from deployable paths and enforce setup flow that provides real binding identifiers.
    - Definition of Done: Deploy paths reject placeholder runtime-state identifiers and provide one canonical setup path.
- ST-2 (Execution Gate: Fail-Fast Runtime and Diagnostics)
  - T-2.3 | Lane: WS2-L2 | Task: Make production binding absence fail fast
    - Action: Update provider selection so production cannot silently fall back to in-memory runtime-state when required bindings are missing.
    - Definition of Done: Production startup/runtime fails loudly with clear diagnostics when required runtime-state bindings are absent.
  - T-2.4 | Lane: WS2-L2 | Task: Add runtime-state diagnostics and adapter-selection tests
    - Action: Add diagnostic signal plus tests for valid bindings and missing-binding failure behavior across environments.
    - Definition of Done: Maintainers can deterministically identify active runtime-state adapter and tests cover success/failure selection paths.

## 6) Acceptance Criteria

- Production deployment/runtime cannot silently proceed with missing or placeholder runtime-state configuration.
- Adapter selection behavior is explicit and environment-aware.
- Runtime-state adapter diagnostics are immediately visible and test-backed.
