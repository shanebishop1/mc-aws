# Cloudflare Setup

This guide covers Cloudflare configuration for both:

- **Workers deployment auth** (Wrangler OAuth)
- **Runtime DNS updates** (DNS API token used by app/Lambda)

These are intentionally separate.

## 1) Prepare DNS record for Minecraft domain

In Cloudflare DNS:

1. Create an `A` record for your Minecraft domain (example: `mc.yourdomain.com`).
2. Use a placeholder IP initially (it will be updated automatically later).
3. Use DNS-only for standard Minecraft traffic (unless you explicitly use Cloudflare Spectrum).

You will need:

- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_RECORD_ID`
- `CLOUDFLARE_MC_DOMAIN`

## 2) Get Zone ID

Cloudflare Dashboard -> domain -> Overview -> API section -> Zone ID.

## 3) Create DNS API token (runtime token)

Create a token with DNS edit permissions scoped to your zone.

Minimum intent:

- Zone -> DNS -> Edit
- Zone Resources -> specific zone

Save as:

- `CLOUDFLARE_DNS_API_TOKEN`

This token is for runtime DNS updates, not Wrangler deployment login.

## 4) Get DNS Record ID

Use Cloudflare API with your DNS token:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <CLOUDFLARE_DNS_API_TOKEN>" \
  -H "Content-Type: application/json"
```

Find your `mc` record and copy its `id` as `CLOUDFLARE_RECORD_ID`.

## 5) Set env values

Set these in your deployment env file (recommended: `.env.production`):

```bash
CLOUDFLARE_DNS_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_RECORD_ID=...
CLOUDFLARE_MC_DOMAIN=mc.yourdomain.com
NEXT_PUBLIC_APP_URL=https://mc.yourdomain.com
```

## 6) Authenticate Wrangler for deployment

Use Wrangler OAuth login:

```bash
wrangler login
```

Important:

- Do not rely on DNS token auth for deployment.
- `scripts/deploy-cloudflare.sh` already unsets `CLOUDFLARE_DNS_API_TOKEN` before invoking Wrangler to avoid auth collisions.

## 7) Deploy

```bash
pnpm deploy:cf
```

The deploy script uses `.env.production` by default.

If you want to force a specific file:

```bash
ENV_FILE=.env.production pnpm deploy:cf
```

During build, the script writes a temporary `.env.production.local` from the selected deploy file so `.env.local` cannot override production values.

The deploy script validates env, uploads secrets, builds, and deploys the Worker.

## 8) Runtime-state bindings (Durable Object + KV)

`wrangler.jsonc` defines runtime-state namespaces used by the Cloudflare runtime adapter:

- Durable Object binding: `RUNTIME_STATE_DURABLE_OBJECT` (authoritative mutable state)
- KV binding: `RUNTIME_STATE_SNAPSHOT_KV` (optional snapshot cache)

Notes:

- Runtime adapter naming stays consistent with selector fields:
  - `durableObjectNamespace` -> `env.RUNTIME_STATE_DURABLE_OBJECT`
  - `snapshotKvNamespace` -> `env.RUNTIME_STATE_SNAPSHOT_KV`
- A Durable Object migration tag (`v1-runtime-state-durable-object`) is included in Wrangler config.
- Do not manually edit KV IDs in `wrangler.jsonc`.
- Canonical setup path for runtime-state KV IDs:
  1. Create namespaces with Wrangler:
     - `pnpm exec wrangler kv namespace create RUNTIME_STATE_SNAPSHOT_KV`
     - `pnpm exec wrangler kv namespace create RUNTIME_STATE_SNAPSHOT_KV --preview`
  2. Add the returned ids to your deploy env file (`.env.production`):
     - `RUNTIME_STATE_SNAPSHOT_KV_ID`
     - `RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID` (optional; defaults to `RUNTIME_STATE_SNAPSHOT_KV_ID` in deploy flow)
  3. Deploy via `pnpm deploy:cf`.
- Deploy flow injects validated KV ids into a generated Wrangler config and rejects placeholder/invalid values before deployment.
- Local dev parity: `wrangler dev` uses these bindings against local state storage under `.wrangler/state` by default.

### Rate-limit fallback policy and telemetry

`lib/rate-limit.ts` uses a deterministic policy for runtime-state counter failures:

- **Retryable backend error** (`error.retryable === true`): fail-open fallback (request allowed).
- **Non-retryable backend error** (`error.retryable === false`): fail-closed fallback (request throttled, `Retry-After: 1`).
- **Unexpected exception**: fail-open fallback (request allowed).

Throttle/fallback outcomes are emitted through the canonical runtime-state telemetry helper (`emitRuntimeStateTelemetry`) with:

- `operation: "rate-limit.increment-counter"`
- `source: "route"`
- route-aware fields (`route`, `key`)
- `outcome: "THROTTLE"` for hard throttles or fail-closed fallbacks
- `outcome: "FALLBACK"` for fail-open fallbacks

This makes backend-failure behavior explicit and observable in route logs.

## Troubleshooting

### `wrangler login` fails or behaves like API-token mode

- Remove exported `CLOUDFLARE_DNS_API_TOKEN` from your shell session.
- Re-run `wrangler login`.
- Use a deployment env file (normally `.env.production`) for DNS token storage instead of global shell exports.

### DNS is not updating after server start

- Verify `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, and `CLOUDFLARE_DNS_API_TOKEN` values.
- Confirm token has DNS edit scope for the correct zone.
- Check app/lambda logs for Cloudflare API errors.

## Related docs

- [AWS Credentials Setup](AWS_CREDENTIALS_SETUP.md)
- [Google OAuth Setup](GOOGLE_OAUTH_SETUP.md)
- [README](../README.md)
