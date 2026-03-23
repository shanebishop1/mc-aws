# PRD: State Layer and Cloudflare Bindings

**Epic:** Durable Cloudflare Runtime State  
**Feature:** State Layer and Cloudflare Bindings  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Establish a runtime-state abstraction and Cloudflare binding configuration that supports Durable Objects as authoritative mutable state and KV as optional snapshot cache.

## 2) Scope and Non-Goals

### In Scope

- Define a typed state-layer interface for rate-limit counters and snapshot cache reads/writes.
- Add runtime provider selection for test/local vs Cloudflare-backed adapters.
- Add/align Cloudflare runtime bindings and migration metadata for DO/KV usage.
- Standardize state-operation telemetry event names.

### Non-Goals

- Migrating endpoint logic to the new state layer (covered by follow-on features).
- Full persistence redesign outside runtime coordination concerns.

## 3) Impacted Files/Areas

- `lib/` new runtime-state modules (interface + provider selector + adapters)
- `open-next.config.ts` and related Cloudflare runtime configuration
- Cloudflare binding/migration config files introduced by the feature
- Shared logging/observability helpers consumed by API routes

## 4) Dependencies

- Upstream: none (foundation for durable migration)
- Downstream dependents:
  - `rate-limit-durable-object-migration-prd.md`
  - `status-snapshot-durable-cache-migration-prd.md`

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Runtime State Contract)
  - T-1.1 | Lane: DUR-L1 | Task: Define typed runtime state interface
    - Action: Create interface(s) covering counter increment/check operations and snapshot get/set/invalidate operations with explicit result types.
    - Definition of Done: Shared runtime state contract compiles and is referenced from a single canonical module.
  - T-1.2 | Lane: DUR-L1 | Task: Add provider selector for environment-aware adapters
    - Action: Implement selector logic for test/local in-memory adapter and Cloudflare adapter when bindings exist.
    - Definition of Done: Runtime state provider selection is deterministic across test/dev/Cloudflare environments.
- ST-2 (Execution Gate: Cloudflare Wiring + Telemetry Contract)
  - T-2.1 | Lane: DUR-L2 | Task: Add Durable Object and KV binding configuration
    - Action: Introduce binding and migration config for one DO namespace and one KV namespace with local dev parity notes.
    - Definition of Done: Configuration artifacts define DO and KV bindings required by runtime adapters.
  - T-2.2 | Lane: DUR-L2 | Task: Standardize runtime state telemetry event schema
    - Action: Add shared event names/fields for HIT, MISS, THROTTLE, and FALLBACK outcomes.
    - Definition of Done: Telemetry helper emits normalized state-operation events consumable by route-level logs.

## 6) Acceptance Criteria

- A reusable runtime state abstraction exists and is environment-aware.
- DO/KV bindings are configured and documented for Cloudflare runtime use.
- Telemetry naming for state outcomes is standardized before route migration.
- Follow-on migration features can proceed without re-defining storage contracts.
