# Control API

All routes below are relative to `/api`. Google sign-in creates the HTTP-only `mc_session` cookie, which contains a signed JWT and expires after 30 days. Protected routes obtain roles from an AWS Systems Manager allowlist cached for five minutes.

## Roles

- **Public:** no cookie. Only the explicitly public routes below.
- **Authenticated public:** signed in but not allowlisted. It may use `/players` and public status routes with authenticated detail.
- **Allowed:** SSM allowlist member or admin. It may start, read service status, and poll operations.
- **Admin:** `ADMIN_EMAIL`. It may use all routes.

## Responses and operations

Most JSON responses use one of these shapes:

```json
{ "success": true, "data": {}, "timestamp": "2026-01-09T00:00:00.000Z" }
```

```json
{ "success": false, "error": "Message", "timestamp": "2026-01-09T00:00:00.000Z" }
```

Mutating actions normally return `202` with an `operation` object. `202` means accepted, not finished. For start, backup, restore, hibernate, and resume, poll:

```text
GET /api/operations/{operationId}
```

This route requires an allowed or admin cookie. Status moves through `accepted` or `running`; `completed` and `failed` are terminal. An already-hibernated request can return `200` and `completed`.

Stop normally remains `accepted`; poll `GET /api/status` until the server state is `stopped` instead of waiting for a terminal operation record.

Common errors are `400` invalid input/state, `401` no valid cookie, `403` wrong role, `404` missing/disabled route or operation, `409` another action or service not ready, `429` rate limit, and `500` backend failure.

## Server actions

| Route | Method | Access | Request body |
| --- | --- | --- | --- |
| `/start` | `POST` | Allowed | Empty object or no body |
| `/stop` | `POST` | Admin | Empty object or no body |
| `/backup` | `POST` | Admin | Optional `{ "backupName": "name" }` |
| `/restore` | `POST` | Admin | Optional `{ "backupName": "name" }`; omission means latest |
| `/hibernate` | `POST` | Admin | Empty object or no body |
| `/resume` | `POST` | Admin | See below |

Resume bodies:

```json
{ "restoreMode": "fresh" }
```

```json
{ "restoreMode": "latest" }
```

```json
{ "restoreMode": "named", "backupName": "archive-name" }
```

`mode` aliases `restoreMode`, and `name` aliases `backupName`. A supplied backup name implies `named`. With no mode and no name, resume defaults to **fresh**, not latest.

## Read and configuration routes

| Route | Method | Access | Notes |
| --- | --- | --- | --- |
| `/status` | `GET` | Public | Anonymous output includes server state, running address/hostname, and whether a volume exists; `instanceId` is redacted. |
| `/stack-status` | `GET` | Public | Anonymous output discloses stack existence and status; `stackId` is redacted. |
| `/players` | `GET` | Any signed-in user | Player-count data. |
| `/service-status` | `GET` | Allowed | EC2-running and Minecraft-service flags. |
| `/backups` | `GET` | Admin | Cached Drive list. `refresh=true` requests refresh when possible. A `202` means caching; retry this endpoint. |
| `/costs` | `GET` | Admin | `refresh=true` bypasses the saved result. |
| `/emails` | `GET` | Admin | `refresh=true` bypasses the saved result. |
| `/emails/allowlist` | `PUT` | Admin | `{ "emails": ["user@example.com"] }`. Normalizes and deduplicates, then always adds `NOTIFICATION_EMAIL`, `ADMIN_EMAIL`, and every `ALLOWED_EMAILS` entry. Those configured baseline addresses cannot be removed through this endpoint. |
| `/aws-config` | `GET` | Admin | Region, instance ID, and EC2 console URL. |
| `/gdrive/setup` | `GET` | Admin | Returns the Google authorization URL. |
| `/gdrive/callback` | `GET` | Admin | Google redirect; stores the token and redirects. |
| `/gdrive/status` | `GET` | Admin | Whether Drive is configured. |

`/auth/login` starts Google OAuth, `/auth/callback` sets `mc_session`, `/auth/me` returns the current auth state, and `POST /auth/logout` clears the cookie. `/auth/dev-login` is development-only and requires `ENABLE_DEV_LOGIN=true`.

`/backups?instanceId=...` is an implementation-only compatibility override, not a supported client contract. External clients must not send it.

The Worker caches the allowlist for five minutes. A save clears the cache in the Worker instance handling that request, but other instances may use the old list until their cache expires. For a stolen session cookie, rotate `AUTH_SECRET` immediately; allowlist removal alone is not immediate revocation.

## Rate limits

- All six server-action routes: 4 requests per 30 seconds per signed-in email and action.
- `/status`: 30 per 60 seconds per client IP.
- `/stack-status`: 15 per 60 seconds per client IP.
- `/auth/login` and `/auth/callback`: 6 per 60 seconds per client IP.
- `/auth/me`: 30 per 60 seconds per client IP.
- Development-only `/auth/dev-login`: 10 per 60 seconds per client IP.

`/service-status` has no route-specific limit. Do not infer limits for routes not listed here.

## Internal and mock routes

`/internal/runtime-credentials/verify` is a deployment-only Worker credential probe protected by a temporary bearer token. It is not a public client API.

`/mock/state`, `/mock/scenario`, `/mock/fault`, `/mock/reset`, and `/mock/patch` are test routes. They return `404` outside mock mode; mock mutations require allowed or admin access.
