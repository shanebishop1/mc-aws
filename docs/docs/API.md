# Minecraft Server Control API Reference

This reference documents the current behavior of API routes under `app/api`.

## Base URL

- Local development: `http://localhost:3000`
- Production: your deployed app URL

## Response Conventions

Most JSON routes return:

```json
{
  "success": true,
  "data": {},
  "timestamp": "2026-01-09T00:00:00.000Z"
}
```

Most errors return:

```json
{
  "success": false,
  "error": "Human-readable message",
  "timestamp": "2026-01-09T00:00:00.000Z"
}
```

Notable exceptions:
- Auth OAuth endpoints (`/api/auth/login`, `/api/auth/callback`) return redirects/HTML.
- `/api/auth/me` returns `{ authenticated: boolean, ... }`.

## Auth Model

- `public`: no session required.
- `allowed`: authenticated allowlisted users (admin and allowed roles).
- `admin`: admin session required.

## Server Lifecycle Endpoints

| Endpoint | Method | Auth | Behavior | Typical Status |
|---|---|---|---|---|
| `/api/start` | `POST` | `allowed` | Invokes Lambda start flow and returns immediately | `200` |
| `/api/stop` | `POST` | `admin` | Stops EC2 directly (sync command) | `200` |
| `/api/hibernate` | `POST` | `admin` | Invokes async Lambda hibernate flow | `202` |
| `/api/resume` | `POST` | `admin` | Invokes async Lambda resume flow | `202` |
| `/api/backup` | `POST` | `admin` | Invokes async Lambda backup flow | `202` |
| `/api/restore` | `POST` | `admin` | Invokes async Lambda restore flow | `202` |

Notes:
- Async routes (`hibernate`, `resume`, `backup`, `restore`) return accepted-style responses while work continues.
- `start` is fire-and-forget but currently returns `200` with initiation message.
- `400` is used for invalid state transitions (for example already running/stopped).

## Status and Monitoring

### `/api/status` (`GET`, `public`)

- Optional auth (`getAuthUser`): anonymous callers are supported.
- Anonymous responses redact `instanceId`.
- Rate limited (30 requests per 60 seconds, by client IP).
- Runtime-state snapshot cache key: `status:latest`.
- Headers:
  - `X-Status-Cache: HIT|MISS`
  - `Vary: Cookie`
  - `Cache-Control`:
    - authenticated: `private, no-store`
    - anonymous: `public, s-maxage=5, stale-while-revalidate=25`

### `/api/service-status` (`GET`, `allowed`)

- Rate limited (20 requests per 60 seconds).
- Snapshot cache key: `service-status:latest`.
- Headers:
  - `X-Service-Status-Cache: HIT|MISS`
  - `Cache-Control: private, no-store`

### `/api/stack-status` (`GET`, `public`)

- Optional auth; anonymous responses redact `stackId`.
- Rate limited (15 requests per 60 seconds).
- Snapshot cache key: `stack-status:latest`.
- Headers:
  - `X-Stack-Status-Cache: HIT|MISS`
  - `Vary: Cookie`
  - `Cache-Control`:
    - authenticated: `private, no-store`
    - anonymous: `public, s-maxage=30, stale-while-revalidate=120`

### `/api/players` (`GET`, `authenticated`)

- Requires a valid session (`requireAuth`).
- Returns player count payload from backend provider.

## Backups Listing

### `/api/backups` (`GET`, `admin`)

- Reads backups from SSM-backed cache parameter.
- Query params:
  - `refresh=true`: force refresh Lambda invocation.
  - `instanceId` (optional): override instance for refresh operation.
- Returns:
  - `200` with `status: "listing"` when cache is fresh.
  - `202` with `status: "caching"` when refresh is triggered.
- Header: `Cache-Control: no-store`.

## Costs and Email Configuration

### `/api/costs` (`GET`, `admin`)

- Query param: `refresh=true` to force fresh AWS fetch.
- Cache policy:
  - On-demand snapshot cache only (no TTL set).
  - Fresh fetch on cache miss or `refresh=true`.
- Headers:
  - `X-Costs-Cache: HIT|MISS`
  - `Cache-Control: private, no-store`

### `/api/emails` (`GET`, `admin`)

- Query param: `refresh=true` to bypass snapshot cache.
- Snapshot cache uses bounded staleness TTL (`emails` key in runtime-state cache config).
- Headers:
  - `X-Emails-Cache: HIT|MISS`
  - `Cache-Control: private, no-store`

### `/api/emails/allowlist` (`PUT`, `admin`)

- Body: `{ "emails": string[] }`.
- Validates email format and normalizes casing/deduplication.
- Invalidates `/api/emails` snapshot after mutation.

## AWS and Google Drive Utility Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/aws-config` | `GET` | `admin` | Returns region, instanceId, and EC2 console URL |
| `/api/gdrive/setup` | `GET` | `admin` | Returns Google OAuth URL; mock mode returns mock callback URL |
| `/api/gdrive/callback` | `GET` | `admin` | Exchanges OAuth code and stores token in SSM/mock store |
| `/api/gdrive/status` | `GET` | `admin` | Returns `{ configured: boolean }`, always `Cache-Control: no-store` |

## Authentication Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/login` | `GET` | Starts Google OAuth flow, sets PKCE cookies, redirects to Google |
| `/api/auth/callback` | `GET` | Handles OAuth callback, creates `mc_session`, redirects or popup-close HTML |
| `/api/auth/me` | `GET` | Returns auth state (`authenticated` true/false) |
| `/api/auth/logout` | `POST` | Clears session cookie |
| `/api/auth/dev-login` | `GET` | Development-only login helper (`NODE_ENV != production` and `ENABLE_DEV_LOGIN=true`) |

Rate limiting:
- `/api/auth/login`: 6 requests / 60 seconds
- `/api/auth/callback`: 6 requests / 60 seconds

## Mock Control Endpoints (Mock Mode Only)

These routes return `404` outside mock mode:

- `/api/mock/state` (`GET`)
- `/api/mock/scenario` (`GET`, `POST`)
- `/api/mock/fault` (`GET`, `POST`, `DELETE`)
- `/api/mock/reset` (`POST`)
- `/api/mock/patch` (`POST`)

Mutation routes require authenticated allowed/admin access.

## Common Status Codes

- `200` successful synchronous response
- `202` asynchronous operation accepted/caching in progress
- `400` invalid input or invalid state transition
- `401` unauthenticated
- `403` authenticated but insufficient privileges
- `404` route disabled in current mode (for mock-control in AWS mode)
- `409` operation conflict (for example service not ready)
- `429` rate-limited endpoint
- `500` unexpected backend/server error

## Environment Notes

- Local default app URL fallback: `http://localhost:3000`
- Deprecated env var: `CLOUDFLARE_API_TOKEN` (use `CLOUDFLARE_DNS_API_TOKEN`)
