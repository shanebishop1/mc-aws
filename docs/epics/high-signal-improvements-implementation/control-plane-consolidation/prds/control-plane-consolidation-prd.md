# PRD: Workstream 4 - Control-Plane Consolidation

**Epic:** High-Signal Improvements Implementation  
**Feature:** Workstream 4: Control-Plane Consolidation  
**Status:** Draft (execution-ready with upstream gates)  
**Owner:** Planning

## 1) Objective

Reduce control-plane drift by consolidating mutating action contracts, validation, and error/status mapping into shared orchestration pathways.

## 2) Scope and Non-Goals

### In Scope

- Story 4.1 through 4.5 from the source plan.

### Non-Goals

- Large-bang rewrite of all routes/handlers at once.

## 3) Impacted Files/Areas

- `app/api/{start,stop,backup,restore,hibernate,resume}/route.ts`
- `infra/src/lambda/StartMinecraftServer/handlers/*`
- `lib/aws/*`
- `lib/sanitization.ts`
- `infra/src/lambda/StartMinecraftServer/sanitization.js`
- `lib/types.ts`

## 4) Dependencies

- Upstream: Workstream 1 remaining tasks complete (lock + durable async model clarity)

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Shared Contract Foundations)
  - T-4.1 | Lane: WS4-L1 | Task: Define shared mutating-action contract
    - Action: Create one typed command contract spanning start/stop/backup/restore/hibernate/resume across route and execution layers.
    - Definition of Done: Mutating action contract is canonical and reused across route/execution boundaries.
  - T-4.2 | Lane: WS4-L1A | Task: Centralize validation and sanitization rules
    - Action: Consolidate backup/restore/resume validation and sanitization to minimize duplicated route/Lambda logic.
    - Definition of Done: Shared validation path is primary and runtime-specific exceptions are explicitly documented.
  - T-4.3 | Lane: WS4-L1B | Task: Centralize error and status mapping
    - Action: Introduce shared translation from execution outcomes to API responses and operation-status updates.
    - Definition of Done: Similar failures map to consistent user-visible responses and status updates across mutating routes.
- ST-2 (Execution Gate: Incremental Migration and Drift Removal)
  - T-4.4 | Lane: WS4-L2 | Task: Migrate start action end-to-end through shared orchestration path
    - Action: Route `start` through shared contract/validation/status mapping and prove migration pattern with tests.
    - Definition of Done: Start action is fully migrated and test-backed under consolidated orchestration path.
  - T-4.5 | Lane: WS4-L2 | Task: Migrate remaining mutating actions and remove duplicated orchestration code
    - Action: Apply the proven migration pattern to stop/backup/restore/hibernate/resume and remove obsolete duplicated logic.
    - Definition of Done: All mutating actions use consolidated path and redundant orchestration code is removed.

## 6) Acceptance Criteria

- Mutating actions share canonical typed contract plus common validation and error/status mapping.
- One-by-one migration pattern is proven before full rollout.
- Legacy duplicated orchestration paths are retired after migration.
