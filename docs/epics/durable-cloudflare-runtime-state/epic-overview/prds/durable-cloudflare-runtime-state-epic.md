# Epic: Durable Cloudflare Runtime State

**Epic ID (doc-local):** EPIC-DURABLE-CLOUDFLARE-RUNTIME-STATE  
**Status:** Draft (approved direction, pending feature/task decomposition)  
**Owner:** Planning

## 1) Problem Statement

Several API behaviors currently rely on process-local in-memory state (for example: `lib/rate-limit.ts` map-based counters and cached snapshots in route modules such as `app/api/status`, `service-status`, and `stack-status`). In a Cloudflare Workers runtime, isolates can be short-lived and horizontally distributed, so in-memory state is non-durable and non-authoritative. This can cause inconsistent rate limiting, cache misses/hot starts, and unpredictable user experience across requests.

## 2) Goals and Non-Goals

### Goals

- Replace in-memory runtime state used for cross-request coordination with Cloudflare-native durable storage.
- Preserve existing API contracts while improving consistency and resilience.
- Provide a clear state-layer abstraction for rate limits and short-lived shared snapshots.
- Improve observability around state reads/writes and fallback behavior.

### Non-Goals

- Full redesign of all data persistence in the system.
- Rewriting AWS-side source-of-truth behavior (SSM/EC2/Lambda integrations remain intact).
- UI redesign or unrelated feature additions.

## 3) Scope

### In Scope

- State abstraction for runtime coordination concerns (rate limiting + selected shared API snapshots).
- Migration of current in-memory limiter/caches in high-traffic/high-risk routes.
- Runtime config changes needed for chosen backing store (bindings/migrations).
- Backward-compatible behavior for API responses and error semantics.

### Out of Scope

- Long-term analytics warehouse or historical event store.
- Non-Cloudflare deployment targets.

## 4) Durable Objects vs KV (Comparison + Recommendation)

| Option | Strengths | Weaknesses | Fit for current problem |
|---|---|---|---|
| **Durable Objects** | Strong consistency per object, serialized access, good for counters and coordination | Higher write-path complexity, region locality considerations | **Best for authoritative rate-limit state and mutable coordination** |
| **KV** | Very fast global reads, simple cache distribution, low operational overhead | Eventual consistency for writes, weaker for strict counters | Good for non-critical read-mostly snapshots |

### Recommendation

Adopt a **hybrid model**:

1. **Durable Objects as authoritative state** for rate limiting and mutable coordination.
2. **KV as optional cache layer** for read-mostly, non-critical snapshots where slight staleness is acceptable.

This aligns with the repo’s current risk profile: correctness-sensitive auth/API throttling should not depend on eventually consistent writes.

## 5) Success Metrics

- Cross-request rate-limit behavior is consistent across isolates/instances.
- In-memory coordination state is removed from targeted high-risk paths.
- Error rate and unexpected 429/allow anomalies decrease after rollout.
- Cache effectiveness and latency remain within agreed SLO budget (to be set during decomposition).

## 6) Risks and Mitigations

- **Risk:** Increased latency from remote state checks.  
  **Mitigation:** Coarse-grained object partitioning, short TTL cache, selective KV read-through.
- **Risk:** Cost growth due to frequent state writes.  
  **Mitigation:** Right-size windowing, aggregate writes, measure per-route call frequency.
- **Risk:** Migration regressions in auth/status endpoints.  
  **Mitigation:** Incremental route rollout + canary + explicit test expansion epic coverage.

## 7) Dependencies

- Cloudflare runtime bindings/migrations (Wrangler/OpenNext integration).
- CI gate epic to enforce migration and test checks.
- Testing-expansion epic for high-confidence regression protection.

## 8) Acceptance Criteria

- Targeted in-memory rate-limit/cache state is replaced with durable runtime-backed mechanisms.
- Chosen DO/KV architecture is documented and reflected in runtime configuration.
- API contracts for existing endpoints remain backward compatible.
- Operational telemetry/logging can distinguish durable-state HIT/MISS/THROTTLE outcomes.
- Regression coverage exists for migrated high-risk endpoints.
