# PRD: Rate Limit Durable Object Migration

**Epic:** Durable Cloudflare Runtime State  
**Feature:** Rate Limit Durable Object Migration  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Replace process-local rate-limit state with Durable Object-backed authoritative counters while preserving API-facing throttling behavior.

## 2) Scope and Non-Goals

### In Scope

- Migrate `lib/rate-limit.ts` away from module-level `Map` state.
- Route-level migration for high-risk endpoints currently calling `checkRateLimit`.
- Preserve existing `429` and `Retry-After` response semantics.
- Add explicit telemetry for durable throttle/fallback outcomes.

### Non-Goals

- Reworking endpoint business logic unrelated to throttling.
- Snapshot cache migration (handled in separate feature).

## 3) Impacted Files/Areas

- `lib/rate-limit.ts`
- `app/api/auth/login/route.ts`
- `app/api/auth/callback/route.ts`
- `app/api/status/route.ts`
- `app/api/service-status/route.ts`
- `app/api/stack-status/route.ts`
- runtime-state adapter modules introduced by the foundation feature

## 4) Dependencies

- Requires state-layer/binding foundation feature.
- Should complete before broad status snapshot migration to reduce behavioral overlap.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: Core Limiter Migration)
  - T-1.1 | Lane: DUR-RL1 | Task: Replace in-memory limiter with runtime state adapter calls
    - Action: Refactor limiter internals to use authoritative DO-backed counters through the shared state interface.
    - Definition of Done: `lib/rate-limit.ts` contains no cross-request `Map` storage for counters.
  - T-1.2 | Lane: DUR-RL1 | Task: Preserve response contract for throttle outcomes
    - Action: Keep `allowed`, `remaining`, and `retryAfterSeconds` behavior compatible with current API callers.
    - Definition of Done: Existing endpoint throttling responses remain backward compatible for status code and headers.
- ST-2 (Execution Gate: Endpoint Rollout)
  - T-2.1 | Lane: DUR-RL2 | Task: Migrate high-risk auth and status routes to durable limiter path
    - Action: Update all current `checkRateLimit` callers on high-risk routes to use the migrated limiter path.
    - Definition of Done: Target routes no longer rely on process-local throttling state.
  - T-2.2 | Lane: DUR-RL2 | Task: Add fallback policy and throttle telemetry
    - Action: Implement and document controlled fallback behavior for state backend failures plus explicit throttle/fallback logs.
    - Definition of Done: Fallback policy is deterministic, documented, and observable through route logs.

## 6) Acceptance Criteria

- Authoritative rate-limit coordination is durable across Cloudflare isolates.
- Target routes preserve client-visible throttle contract.
- Fallback behavior is explicit and measurable.
- No high-risk route depends on in-memory limiter counters.
