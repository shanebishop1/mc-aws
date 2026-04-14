# PRD: Workstream 1 - Reliable Long-Running Operations

**Epic:** High-Signal Improvements Implementation  
**Feature:** Workstream 1: Reliable Long-Running Operations  
**Status:** Draft (amended backlog after Stories 1.1-1.3 complete)  
**Owner:** Planning

## 1) Objective

Complete the remaining Workstream 1 reliability work so long-running mutating operations remain safe under timeout, retry, and partial-failure conditions.

## 2) Scope and Non-Goals

### In Scope

- Story 1.4 lock lifecycle hardening and failure-recovery coverage.
- Story 1.5 durable async orchestration migration.

### Non-Goals

- Re-planning or reopening already-complete Stories 1.1, 1.2, and 1.3.

## 3) Impacted Files/Areas

- `lib/server-action-lock.ts`
- `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`
- `infra/src/lambda/StartMinecraftServer/**`
- `infra/lib/minecraft-stack.ts`

## 4) Dependencies

- Upstream completed baseline: Stories 1.1, 1.2, 1.3
- Downstream dependent: Workstream 4 (Control-Plane Consolidation)

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Lock Lifecycle Correctness)
  - T-1.4 | Lane: WS1-L1 | Task: Harden lock lifecycle and failure recovery
    - Action: Audit lock acquire/release/expiry ownership behavior across all mutating action paths and add explicit stale-lock/ownership regression tests.
    - Definition of Done: Lock ownership and cleanup remain correct for timeout, retry, and partial-failure scenarios across mutating operations.
- ST-2 (Execution Gate: Durable Async Workflow)
  - T-1.5 | Lane: WS1-L2 | Task: Move long-running actions to durable async orchestration
    - Action: Replace single inline-Lambda orchestration with durable async workflow execution while preserving existing external mutating API contracts.
    - Definition of Done: Long-running actions survive invocation boundaries with documented retry/idempotency semantics and operation progress durability.

## 6) Acceptance Criteria

- Timeout/retry scenarios do not leave stale or ambiguous lock state.
- Long-running operations no longer depend on a single inline invocation completing end-to-end.
- Operation progress remains visible and recoverable across execution boundaries.
