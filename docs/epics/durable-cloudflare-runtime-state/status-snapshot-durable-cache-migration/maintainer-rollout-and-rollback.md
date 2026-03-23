# Status Snapshot Durable Cache: Maintainer Rollout and Rollback

This note documents the **currently available** operational controls for status snapshot caching in Cloudflare runtime state.

## Scope

Snapshot behavior in these routes:

- `app/api/status/route.ts`
- `app/api/service-status/route.ts`
- `app/api/stack-status/route.ts`

Shared keys/TTL policy:

- `lib/runtime-state/snapshot-cache.ts`

Runtime adapter selection logic:

- `lib/runtime-state/provider-selector.ts`

Cloudflare binding config:

- `wrangler.jsonc`

## Rollout toggles (current repo state)

There is **no dedicated env feature flag** (for example, no `ENABLE_DURABLE_SNAPSHOTS`) in this repository today.

The operational toggle is the runtime-state adapter selector:

- `getRuntimeStateAdapter()` in `lib/runtime-state/provider-selector.ts`
- Selector rules:
  - `NODE_ENV=test|development` -> always `"in-memory"`
  - `NODE_ENV=production` + Cloudflare bindings present -> `"cloudflare"`
  - otherwise -> `"in-memory"`

Cloudflare bindings that represent durable backends are defined in `wrangler.jsonc`:

- `RUNTIME_STATE_DURABLE_OBJECT`
- `RUNTIME_STATE_SNAPSHOT_KV`

### Important current limitation

Status routes currently call `getRuntimeStateAdapter()` without passing Cloudflare bindings, so the effective adapter for those call sites remains in-memory unless binding injection is added by code.

## Enable durable snapshot path (when binding-injection code is present)

1. Ensure `wrangler.jsonc` has valid (non-placeholder) KV IDs for `RUNTIME_STATE_SNAPSHOT_KV` and the DO migration entry remains intact.
2. Deploy the release that passes runtime bindings into `getRuntimeStateAdapter({ bindings })` for status snapshot routes.
3. Deploy to Cloudflare (`pnpm deploy:cf`).
4. Smoke-check cache contract:
   - Call `/api/status`, `/api/service-status`, `/api/stack-status` twice.
   - Confirm `X-Status-Cache`, `X-Service-Status-Cache`, `X-Stack-Status-Cache` are present and show expected `MISS` -> `HIT` behavior.
5. Tail logs and watch for fallback/error reasons from runtime-state paths (for example `snapshot_read_failed:*` / `snapshot_write_failed:*`).

## Disable / rollback sequence

Use this when durable snapshot rollout causes instability.

1. **Stop further rollout**: pause promotion of new releases.
2. **Disable durable path** by deploying a revision that forces in-memory selection for these routes:
   - fastest/lowest-risk: redeploy last known-good release before durable binding usage,
   - or deploy a hotfix that omits/clears Cloudflare bindings passed to `getRuntimeStateAdapter` for snapshot calls.
3. Redeploy (`pnpm deploy:cf`).
4. Validate endpoints:
   - `/api/status`, `/api/service-status`, `/api/stack-status` return 200s,
   - `X-*-Cache` headers remain present,
   - no elevated 5xx/429 regression compared to pre-rollout baseline.
5. Observe logs for at least one cache TTL window:
   - no repeated `snapshot_*_failed` bursts,
   - no user-facing payload/contract drift.
6. After stability is confirmed, open follow-up issue/PR for root cause before re-attempting durable enablement.

## Safety notes

- Current route implementations keep response contracts stable even if snapshot backend operations fail (routes continue via uncached path).
- Keep rollback focused on adapter selection only; avoid changing payload schema or headers during incident response.
