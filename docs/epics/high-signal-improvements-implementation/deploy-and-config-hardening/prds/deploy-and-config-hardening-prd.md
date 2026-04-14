# PRD: Workstream 5 - Deploy and Config Hardening

**Epic:** High-Signal Improvements Implementation  
**Feature:** Workstream 5: Deploy and Config Hardening  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Prevent avoidable deploy/runtime breakage by enforcing strict environment validation, secret allowlisting, and deploy preflight guardrails.

## 2) Scope and Non-Goals

### In Scope

- Story 5.1 through 5.4 from the source plan.

### Non-Goals

- Broad secret-platform redesign outside deploy-path and runtime-target correctness.

## 3) Impacted Files/Areas

- `lib/env.ts`
- `scripts/validate-env.ts`
- `scripts/deploy-cloudflare.sh`
- setup/deploy docs under `docs/`

## 4) Dependencies

- Upstream: none (should start early)
- Downstream dependent: Workstream 3 real-env smoke reliability

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Environment Schema and Strict Validation)
  - T-5.1 | Lane: WS5-L1 | Task: Define environment/runtime config ownership schema
    - Action: Build a canonical matrix mapping env vars to runtime targets and requirement levels (required/optional/deprecated/forbidden).
    - Definition of Done: One source-of-truth matrix exists and is consumable by validation/docs flows.
  - T-5.2 | Lane: WS5-L1 | Task: Enforce strict CI/production validation behavior
    - Action: Update env validation to fail fast for production-critical missing/invalid config while preserving intentional local-dev softness.
    - Definition of Done: CI/production validation fails clearly for critical config gaps and is covered by tests.
- ST-2 (Execution Gate: Secret and Deploy Guardrails)
  - T-5.3 | Lane: WS5-L2 | Task: Restrict Worker secret upload to explicit allowlist
    - Action: Replace broad secret upload patterns with explicit Worker-runtime allowlist and rationale documentation.
    - Definition of Done: Worker deploy uploads only allowlisted runtime-required secrets.
  - T-5.4 | Lane: WS5-L2 | Task: Add deployment guardrails for placeholders and incomplete runtime-state setup
    - Action: Add deploy-time checks that fail on placeholder values, missing required secrets, or incomplete runtime-state bindings.
    - Definition of Done: Deploy scripts reject incomplete production-target configuration before runtime.

## 6) Acceptance Criteria

- Production-critical config cannot silently degrade to empty values.
- Worker runtime receives only required secrets.
- Deploy-time checks fail early and clearly on placeholder/incomplete configuration.
