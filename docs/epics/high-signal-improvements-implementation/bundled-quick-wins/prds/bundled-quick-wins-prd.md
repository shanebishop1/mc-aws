# PRD: Bundled Quick Wins

**Epic:** High-Signal Improvements Implementation  
**Feature:** Bundled Quick Wins  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Execute explicit high-signal quick wins listed in the source plan when they improve reliability without requiring new speculative scope.

## 2) Scope and Non-Goals

### In Scope

- Quick Win Q1 (resume attach bug fix)
- Quick Win Q2 (email command parsing hardening)
- Quick Win Q3 (mutating route throttling coverage)

### Non-Goals

- Additional quick-win candidates not listed in the source plan.

## 3) Impacted Files/Areas

- `lib/aws/volume-client.ts`
- `infra/src/lambda/StartMinecraftServer/command-parser.js`
- `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`

## 4) Dependencies

- Q3 sequencing depends on Workstream 2 fail-fast runtime-state correctness.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Immediate Reliability Fixes)
  - T-6.1 | Lane: WSQ-L1A | Task: Fix resume attach path instance-id usage bug
    - Action: Patch volume attach/resume logic to consistently use resolved instance id and add regression coverage for attach flow.
    - Definition of Done: Resume attach path uses resolved instance id deterministically and regression tests cover failure-prone path.
  - T-6.2 | Lane: WSQ-L1B | Task: Harden email command parsing with exact tokenization
    - Action: Replace ambiguous substring command matching with exact token parsing and tests for overlapping command names.
    - Definition of Done: Command parser chooses intended action only on exact token matches with overlapping-name tests.
- ST-2 (Execution Gate: Mutating Route Throttle Coverage)
  - T-6.3 | Lane: WSQ-L2 | Task: Add route-level throttling to mutating endpoints
    - Action: Audit and add route-specific mutating endpoint throttles aligned with runtime-state hardening assumptions.
    - Definition of Done: Mutating endpoints have explicit route-level throttling policy aligned with production runtime-state behavior.

## 6) Acceptance Criteria

- Q1 and Q2 regressions are fixed with tests.
- Q3 mutating route throttling is explicit and compatible with runtime-state hardening expectations.
