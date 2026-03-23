# PRD: Status Snapshot Durable Cache Migration

**Epic:** Durable Cloudflare Runtime State  
**Feature:** Status Snapshot Durable Cache Migration  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Migrate cross-request status snapshot caching from module-local memory to durable runtime-backed storage, keeping response contracts unchanged.

## 2) Scope and Non-Goals

### In Scope

- Remove module-level cached snapshot variables in status-oriented routes.
- Store short-lived snapshots via runtime state adapter (DO/KV according contract).
- Centralize snapshot cache key/TTL policy.
- Preserve API payload and cache-header compatibility.

### Non-Goals

- Changing endpoint payload shapes.
- Replacing upstream AWS data-source interactions.

## 3) Impacted Files/Areas

- `app/api/status/route.ts`
- `app/api/service-status/route.ts`
- `app/api/stack-status/route.ts`
- runtime-state adapter modules for snapshot get/set operations
- durable-state docs under `docs/epics/durable-cloudflare-runtime-state/`

## 4) Dependencies

- Requires state-layer/binding foundation feature.
- Sequenced after rate-limit migration feature to reduce rollout risk.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Snapshot Backend Migration)
  - T-1.1 | Lane: DUR-C1 | Task: Remove module-level snapshot caches
    - Action: Replace route-level `cached*` variables with runtime state adapter read/write operations.
    - Definition of Done: Target routes have no module-local cross-request snapshot state.
  - T-1.2 | Lane: DUR-C1 | Task: Centralize snapshot keys and TTL policies
    - Action: Introduce shared constants/utility for cache keys and TTLs used across status routes.
    - Definition of Done: Status, service-status, and stack-status routes consume one shared key/TTL policy module.
- ST-2 (Execution Gate: Compatibility and Rollout Safety)
  - T-2.1 | Lane: DUR-C2 | Task: Preserve payload and header semantics
    - Action: Keep existing response data fields and `X-*-Cache` header behavior while using durable snapshots.
    - Definition of Done: Public response contracts remain backward compatible for all migrated snapshot routes.
  - T-2.2 | Lane: DUR-C2 | Task: Document rollout toggles and rollback steps
    - Action: Add an operations note for enabling/disabling durable snapshot path and reverting safely.
    - Definition of Done: Maintainers can execute rollback without re-planning migration steps.

## 6) Acceptance Criteria

- Snapshot state in high-risk routes is durable-backed instead of in-memory.
- Shared key/TTL policy prevents drift across status endpoints.
- Existing API contracts remain intact.
- Rollout and rollback controls are documented for operations.
