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

All cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests also enforce the canonical app origin and host before authentication, throttling, operation persistence, or lock acquisition. Browser callers must send a matching `Origin`; a missing, malformed, `null`, or cross-site browser origin returns `403`. Controlled non-browser callers may omit `Origin` only when they do not send browser Fetch Metadata headers and still address the canonical host. Read-only `GET` routes and OAuth callbacks are unaffected.

## Agent control plane

Agent routes are admin-only and always return `Cache-Control: private, no-store`. The server derives a stable opaque actor ID as SHA-256 of the normalized admin email; email addresses and provider credentials are not part of agent persistence or public DTOs. Production requires the legacy `AGENT_SESSION_DURABLE_OBJECT` migration source plus `AGENT_SESSION_INDEX_DURABLE_OBJECT` and `AGENT_SESSION_SHARD_DURABLE_OBJECT`; it fails closed when any binding is unavailable. New authoritative detail is sharded by session ID, while the coordinator stores only paged summaries and a bounded pending/running work index. Local, test, and mock mode use the deterministic process-local implementation of the same repository contract. KV is not authoritative for agent state.

| Route | Method | Body/behavior |
| --- | --- | --- |
| `/api/agent/sessions` | `GET` | Lists up to 100 separately indexed summaries owned by the current opaque actor; it does not load session detail. |
| `/api/agent/sessions` | `POST` | Creates a session. Local/test/mock mode may create deterministic fixture history; production leaves pending work for the outbound runtime lease API. |
| `/api/agent/providers` | `GET` | Returns the authenticated admin-only, credential-free configured provider/profile/model catalog. |
| `/api/agent/sessions/{sessionId}` | `GET` | Returns one owned session with task IDs/status/timestamps, policy snapshot, and approval metadata. Task directives are intentionally omitted. |
| `/api/agent/sessions/{sessionId}/continue` | `POST` | Appends one task/user turn to an owned idle session and queues it for runtime work. |
| `/api/agent/sessions/{sessionId}/events` | `GET` | Finite, reconnectable SSE replay. Use `Last-Event-ID` or `after`, but not conflicting values. |
| `/api/agent/sessions/{sessionId}/cancel` | `POST` | Cancels an active session. |
| `/api/agent/sessions/{sessionId}/approvals/{approvalId}/decision` | `POST` | Accepts only `"approve"` or `"deny"` for a pending approval. |
| `/api/agent/sessions/{sessionId}/approvals/{approvalId}/revoke` | `POST` | Revokes only an approved, active session-capability grant. |

Every agent mutation requires `schemaVersion: 1`, an exact positive `expectedRevision` (`0` only for create), and an `idempotencyKey`. Mutation bodies reject unknown fields, malformed IDs, oversized strings, and bodies over 12,000 bytes. They enforce admin authentication, cookie same-origin checks, ownership, and fail-closed throttling before state changes. Revision or idempotency conflicts return `409`; terminal-session mutations also return `409`. Do not put task content in paths, query strings, or logs.

Public task metadata contains only task ID, status, and creation/update timestamps; persisted conversation turns remain runtime-only. Approval DTOs expose the invocation ID and SHA-256 digest, summary digest, sanitized arguments/diff, normalized scope, risk, expiry, backup-failure status, and whether the grant is single-use or remains active until session end/revocation/expiry. They never expose provider credentials, credential references, or raw sensitive values.

Production requires an explicit `MC_AGENT_RUNTIME_ENABLED=true|false` on every Worker deployment. `true` requires `MC_AGENT_RUNTIME_ID`, `MC_AGENT_RUNTIME_TOKEN_SHA256`, `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8`, `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS`, `MC_AGENT_PUBLIC_PROVIDER_CATALOG`, and `MC_AGENT_RUNTIME_PROVIDER_PROFILES` together. The backup-fence value is a canonical base64 PKCS#8 Ed25519 private key held only by the control plane; deployment derives its public half for the host executor. The executor-receipt value is setup-managed exact-schema JSON containing one current and at most two retained public Ed25519 SPKI verifiers; each verifier has a monotonic `keyEpoch`, and each retained verifier must carry an explicit `rotationCutoffAt`. Its key IDs must equal the SHA-256 of the SPKI material. Fence authorizations bind the current receipt key ID and epoch when issued or renewed, so a bearer plus a retired signing key cannot mint a current fence. The catalog is bounded exact-schema JSON and the profile inventory is separately supplied, credential-free metadata generated from the reviewed gateway profiles. The profile ID, provider ID/kind, display name, canonical HTTPS endpoint, model allowlist, and feature set must match exactly; an ID-only inventory or any endpoint/model/kind substitution fails deployment validation and catalog reads. Session state and every work lease carry a SHA-256 fingerprint of this canonical metadata, and the gateway verifies its local profile against that fingerprint before reading a provider credential or contacting a model endpoint. Never add `credentialRef`, API keys, tokens, or provider secrets to either catalog value. Mock mode returns only `local-fake` / `deterministic-v1`.

Each dotenv JSON value must remain on one line. Both values are limited to 64,000 UTF-8 bytes and 1–32 exact-schema profiles. Profile/provider IDs, allowed models, provider kinds, canonical HTTPS endpoints without credentials/query/fragment, display names, feature names, list sizes, unique values, and every canonical metadata field are validated by the same fail-closed parser used for catalog reads. Receipt verification uses the exact executor key ID and epoch carried by the fence. A retained old verifier may validate an outstanding fence issued before its cutoff, but new fences are always issued with the current verifier; bounded history must not evict a key referenced by durable handoff state. For example:

```dotenv
MC_AGENT_RUNTIME_ENABLED=true
MC_AGENT_RUNTIME_ID=minecraft-gateway
MC_AGENT_RUNTIME_TOKEN_SHA256=<lowercase SHA-256 of the gateway bearer>
MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=<canonical base64 PKCS#8 Ed25519 private key>
MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS='{"schemaVersion":1,"currentKeyId":"executor-receipt-<sha256-spki>","verifiers":[{"schemaVersion":1,"keyId":"executor-receipt-<sha256-spki>","publicKeySpki":"<canonical base64 Ed25519 SPKI>","keyEpoch":1}]}'
MC_AGENT_PUBLIC_PROVIDER_CATALOG='{"schemaVersion":1,"profiles":[{"schemaVersion":1,"profileId":"reviewed-provider","providerId":"reviewed-openai-api","providerKind":"openai-compatible","displayName":"Reviewed provider","endpoint":"https://provider.example.com/v1","allowedModels":["reviewed-model"],"supportedFeatures":["streaming","tools"]}]}'
MC_AGENT_RUNTIME_PROVIDER_PROFILES='{"schemaVersion":1,"profiles":[{"schemaVersion":1,"profileId":"reviewed-provider","providerId":"reviewed-openai-api","providerKind":"openai-compatible","displayName":"Reviewed provider","endpoint":"https://provider.example.com/v1","allowedModels":["reviewed-model"],"supportedFeatures":["streaming","tools"]}]}'
```

Create request (all eight capabilities must occur exactly once):

```json
{
  "schemaVersion": 1,
  "expectedRevision": 0,
  "idempotencyKey": "create-2026-09-02-1",
  "task": "Inspect the configuration and propose a safe change.",
  "providerProfileId": "local-fake",
  "model": "deterministic-v1",
  "policy": {
    "schemaVersion": 1,
    "preset": "maintainer",
    "backupMode": "before-risky",
    "rules": [
      { "schemaVersion": 1, "capability": "workspace.read", "decision": "allow" },
      { "schemaVersion": 1, "capability": "workspace.write", "decision": "ask-once" },
      { "schemaVersion": 1, "capability": "workspace.delete", "decision": "ask-always" },
      { "schemaVersion": 1, "capability": "shell.execute", "decision": "ask-once" },
      { "schemaVersion": 1, "capability": "console.execute", "decision": "ask-once" },
      { "schemaVersion": 1, "capability": "network.outbound", "decision": "ask-always" },
      { "schemaVersion": 1, "capability": "backup.create", "decision": "allow" },
      { "schemaVersion": 1, "capability": "extension.load", "decision": "ask-always" }
    ]
  }
}
```

Cancel and revoke use `{ "schemaVersion": 1, "expectedRevision": 8, "idempotencyKey": "...", "reason": "optional" }`. Approval decisions add `"decision": "approve"` or `"deny"`.

Continuation uses `{ "schemaVersion": 1, "expectedRevision": 15, "idempotencyKey": "...", "task": "Follow up", "providerProfileId": "...", "model": "..." }`. Only an idle, owned session accepts a new key; exact retries are idempotent and stale revisions return `409`. Cancellation and failure remain terminal.

SSE event IDs are opaque replay cursors and events are emitted strictly after the supplied cursor, without duplication. A stale cursor produces an explicit `replay-truncated` event with the retained sequence floor. Each response emits heartbeats, waits at most 10 seconds, observes client abort, and then closes so clients can reconnect. Persisted event payloads are already marked and projected as redacted.

### Outbound agent runtime API

The EC2 gateway uses only outbound HTTPS requests. Portal task content is carried in authenticated JSON work responses and is never placed in an SSM command, path, query string, or log. These routes do not accept the admin cookie and are not public client APIs.

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/agent/runtime/work` | `POST` | Long-polls up to 25 seconds and atomically leases the oldest eligible task. |
| `/api/agent/runtime/leases/{leaseId}/ack` | `POST` | Acknowledges a pending lease and starts its task/session. |
| `/api/agent/runtime/leases/{leaseId}/renew` | `POST` | Renews an unexpired lease owned by the authenticated runtime. |
| `/api/agent/runtime/leases/{leaseId}/events` | `POST` | Accepts one to 64 redacted, monotonically ordered event drafts. The server assigns authoritative event sequence/cursors transactionally. |
| `/api/agent/runtime/leases/{leaseId}/recovery` | `POST` | Privileged terminal-only publication of every durable executor result and authenticated receipt, including after the original lease expires or is revoked; it never creates execution authority. |
| `/api/agent/runtime/leases/{leaseId}/approval` | `POST` | Persists an exact invocation-bound approval request and pauses the task/session transactionally. |
| `/api/agent/runtime/leases/{leaseId}/consume-approval` | `POST` | Atomically consumes one approved single-invocation or backup-failure decision. |
| `/api/agent/runtime/leases/{leaseId}/authorize-invocation` | `POST` | Linearizes one exact digest/policy/revision/approval-bound invocation against revocation and cancellation under the current lease. |
| `/api/agent/runtime/leases/{leaseId}/decisions` | `POST` | Long-polls approval, revocation, expiry-relevant, and cancellation state. |
| `/api/agent/runtime/leases/{leaseId}/status` | `POST` | Applies a fenced runtime task/session status transition and may persist a bounded redacted assistant turn on completion. |
| `/api/agent/runtime/backups` | `POST` | Checks availability, starts/polls one exact backup, renews its signed lifecycle lease generation, or finalizes its fence only with an exact authenticated executor terminal receipt. |

Every runtime request uses `Authorization: Bearer ...`. Authentication first requires `MC_AGENT_RUNTIME_ENABLED=true`, before reading the identity or verifier. The Worker then verifies the presented bearer against `MC_AGENT_RUNTIME_TOKEN_SHA256` by SHA-256 plus a fixed-length constant-time comparison, binds it to the single configured `MC_AGENT_RUNTIME_ID`, and applies fail-closed runtime-identity rate limits. The raw `MC_AGENT_RUNTIME_TOKEN` belongs only in the gateway secret boundary and is forbidden in Worker configuration. A missing/false switch or missing/malformed identity configuration returns `503`; authentication failure returns `401` without identifying the configured runtime. Deploying explicit `false` is the safe decommission state: an old bearer cannot authenticate even if Cloudflare retains previously uploaded identity/catalog secrets. Actual deletion of those retained secrets is a separate reviewed cleanup because the standard deploy path does not safely infer deletions.

Runtime mutation bodies use `schemaVersion: 1`, `sessionId`, `taskId`, exact `expectedRevision`, and `idempotencyKey`. The path lease, authenticated runtime ID, and persisted lease owner must all match, and the lease must be unexpired. Claims include a client-stable `claimId`; claim retry returns the same active lease. Lease expiry permits a higher-generation takeover, while stale workers receive `409`. Event draft ordinal and ID reuse are strict and idempotent, and lease/event/internal runtime fields are omitted from admin public DTO projections.

Recovery publication is the exception to the active-lease requirement, but is narrower rather than more privileged: it requires the exact durable runtime owner/handoff, prior lease generation, invocation digest, authenticated journal sequence/result digest, and executor terminal receipt. One atomic mutation persists the centrally redacted terminal result, records its separate persisted-result digest, clears the exact lease and active invocation, and establishes the task/session publication statuses without reversing cancellation. The signed acknowledgement authorization uses those immutable publication-revision statuses, so a lost response remains retryable even after a continuation moves the current session back to `pending` or `running`. A replacement invocation, conflicting evidence, forged or unverifiable receipt, unavailable publication, or lost acknowledgement retains the executor evidence and runtime owner. Only successful publication permits lifecycle-fence release followed by the exact signed executor acknowledgement and gateway-journal removal; indeterminate evidence remains unacknowledged until a root-authorized clean executor epoch produces a new authenticated `clean-start-no-active` result.

A completed task transitions its session to non-terminal `idle`; later continuation returns it to `pending` and preserves prior task/event history and session-capability grants. The gateway rebuilds a bounded prompt from persisted centrally redacted task/user/assistant turns for each fresh harness run. Explicit cancellation, runtime failure, an indeterminate host effect, and acknowledged-lease reconciliation failure remain terminal and cannot be continued. An indeterminate `ToolResult` is persisted as audit evidence and fences the harness from creating another invocation until the exact executor journal is reconciled. In addition to the task-scoped proposal identity, the gateway durably claims one runtime-wide execution owner before every executor attempt and checkpoints the authenticated executor journal before dispatch. Gateway restart reconciles every protected handoff against the executor's authenticated in-flight identity before requesting another work lease; active, pending, cancellation-pending, indeterminate, publication-pending, missing, rolled-back, or corrupt state fails closed. The executor applies the same slot globally across all sessions, tasks, and lease generations, so a distinct invocation is rejected until exact authoritative terminal or proven-never-started reconciliation durably releases the prior owner. If cancellation races after a registered mutation commits, the cancelled session removes the active lease and persists a bounded 30-minute, one-use receipt bound to that task-scoped invocation, digest, lease generation, and next event ordinal. This exceeds the maximum executor restart reconciliation plus control publication retry window. Queued nonterminal events are fenced after cancellation while the gateway drains the exact executor result through this dedicated receipt. The receipt accepts only the matching committed or indeterminate `tool-result` (plus exact idempotent publication retry); it does not reopen the task or permit further model work.

The standalone source entrypoint is `agent-runtime/`. The gateway resolves provider secret references in its own process, deep-redacts events, and sends only actor, pinned policy, validated approval state, invocation, and digest-bound authorizations to the executor. Immediately before an approval-gated effect, the current lease requests an authoritative invocation authorization. One atomic store transaction verifies the active policy revision and exact grant, consumes an `ask-always` grant when applicable, and records the lease-generation/session/task/invocation/digest/scope-bound authorization. Revocation linearized first denies execution; authorization linearized first permits only that exact invocation. The executor requires this authorization for session grants rather than trusting a polled approval snapshot. The executor protocol is a bounded one-message Unix-domain socket protocol authenticated with Ed25519: the gateway retains the private key and the credential-less executor receives only the public key. PID 1 creates `/run/mc-agent/executor.sock` from `mc-agent-executor.socket` in a root-owned non-writable directory and passes its inherited descriptor to Node, so the shared Minecraft UID cannot unlink or replace the gateway's executor endpoint. Signed nonces have a bounded replay window. Connection or response loss is reconciled with bounded exponential backoff spanning `RestartSec=2s` and retries the identical execute request ID and body; after reconnect, the executor's durable journal returns the committed cached result rather than repeating the host effect. Unavailable reconciliation returns a distinct indeterminate result only after that bound instead of allowing the model to create a replacement invocation. Durable, expiring cancellation tombstones fence cancellation that arrives before execution registration, fail new requests temporarily at saturation, and reclaim after the safety horizon or durable cancelled commit. The protocol does not carry the runtime bearer, provider credentials, private signing key, process environment, or portal transport configuration.

Minecraft console cancellation is checked immediately before the credential-less `screen` dispatch. Calling the screen transport is the dispatch boundary: exit zero produces committed `console-dispatch` metadata even if cancellation races afterward, while timeout, socket/process loss, or any otherwise uncertain result after dispatch begins is persisted as indeterminate and cannot be retried automatically. A future RCON transport must use the same boundary.

The executor journal is not trusted based on the shared `minecraft` UID. Schema-v3 entries, cancellation tombstones,
one authenticated append transaction per generation, alternating checkpoints, the small current-generation manifest, and the monotonic generation floor use
domain-separated canonical HMAC-SHA-256 under an exact 32-byte root-generated systemd credential available only in the
executor's private user and mount namespace. Checkpoint and manifest replacement use temporary-file sync, atomic rename,
and directory sync. A transaction authenticates its complete ordered mutation set before any mutation is applied; a
torn final frame therefore applies none of that generation, and recovery truncates and syncs the selected append file to
its last authenticated complete byte boundary before permitting another append. A post-sync publication failure recovers
the newest durable generation instead of restoring stale in-memory state. Compaction publishes folded evidence and deletion together
in one atomic checkpoint rather than as separate append records. Recovery validates both slots and append generations, selects the newest valid generation at or
above the authenticated floor, and rejects a valid but older checkpoint replay. Before durable `dispatching`, the
protected gateway handoff records the current authenticated executor sequence as a minimum external floor. Missing,
deleted, truncated, invalid-MAC, wrong-key, or valid-old/rollback state after that point is indeterminate and retains the
lifecycle fence; it cannot produce `not-started`, terminal trust, redispatch, or release. Before returning authenticated `reserved` state, the
executor also reserves its 100,000-entry/64-MiB budget for the maximum bounded terminal or fallback record; inability to
guarantee that commit capacity rejects the invocation before its effect. Only a genuinely fresh invocation without a
durable handoff may initialize an empty journal.

Required-backup orchestration uses the typed backup adapter. Its Lambda payload is a narrow agent-only variant that refuses to start stopped EC2 capacity, requires `minecraft.service` to remain active, and invokes the host backup script in active-only mode. Ordinary admin backups retain their existing start-if-stopped behavior and cannot opt into agent-only fields. Only an authoritative terminal backup execution failure creates a separate `backup.create`, single-invocation approval; approval explicitly means proceed without backup and denial means cancel that invocation. Lock conflicts, duplicate/in-progress work, cancellation, unavailable prerequisites, and ambiguous control responses fail closed without offering proceed-without-backup. No approval can override executor immutable boundaries.

The runtime backup route is intentionally separate from admin `POST /api/backup`. The admin route returns asynchronous acceptance and therefore cannot prove completion before an agent mutation. The runtime-bearer route first verifies the active runtime lease and persisted proposal/backup-request events, then uses a narrow injected adapter. Before taking the global lifecycle fence it durably creates the deterministic invocation/idempotency operation, including the exact runtime/session/task/lease-generation/invocation/digest binding. A DynamoDB transaction then binds that operation, a unique dispatch owner, and the global server-action lock; a duplicate caller attaches to the same pending operation. Exact retries recover that operation before rejecting a now-stale work lease, while any binding mismatch fails closed. The owner rechecks active lease/cancellation state after ownership and immediately before Lambda dispatch. Transaction or response ambiguity is reconciled from the lock's operation/owner identity and durable operation binding, never by issuing a second dispatch.

Before requesting that backup, the gateway durably records an `awaiting-backup` handoff with the complete executor request. Backup success atomically persists the exact authorization in the lifecycle operation as `awaiting-executor`; the gateway then advances its local handoff to `awaiting-executor`, asks the executor to durably authenticate the exact request as `reserved`, records that reservation generation as its external sequence floor, and only then marks `dispatching` before the executor `execute` call. `begin` durably changes the same entry to `in-progress` before entering the host effect. After backup success, the exact lifecycle owner is marked `agentFenceActive`; expiry cannot make that owner eligible for takeover while an executor effect may still commit. The control plane increments a monotonically fenced lifecycle lease generation and signs a 60-second permit containing the exact runtime/work-lease generation, session, task, invocation digest, backup ID, lifecycle lock ID, fencing token, lease generation, and lock horizon. Each renewal is one DynamoDB transaction that conditionally advances both the global lock and the durable operation authorization; response loss is accepted only after strongly consistent reads prove the exact operation, dispatch owner, lock ID, fencing token, and new generation. SSM is a forward-only compatibility mirror and its failure cannot roll back durable authority. The gateway probes the authoritative executor journal and renews every 20 seconds while it reports reserved, active, or pending. Every renewal has bounded transport retries and revalidates the active runtime lease and persisted proposal. Gateway restart reloads all three handoff states before leasing new work, recovers an exact completed backup even after work-lease expiry, and consults both authoritative control state and executor state before resuming dispatch or finalization.

`AbortSignal` and request timeouts are cooperative; they are not claimed to cancel filesystem syscalls. The executor protocol server validates the latest non-revoked signed generation immediately before atomic rename or console dispatch. Ownership loss revokes that permit and prevents a commit that has not entered its syscall. An entered syscall remains covered because `agentFenceActive` is never expiry-takeover eligible. Normal process termination is additionally bounded by `RuntimeMaxSec=20min`, `TimeoutStopSec=30s`, control-group SIGKILL, and a 25-minute lock margin. If a process remains kernel-uninterruptible, its active lock stays non-takeover rather than allowing restore overlap; elapsed wall time alone is never treated as proof that the effect cannot commit.

Only an Ed25519-signed terminal executor receipt bound to the runtime/session/task/work-lease generation, invocation ID/digest, result digest, backup operation, lock ID/token, current lifecycle fence generation, executor epoch, signing-key ID, and HMAC-authenticated journal sequence can release the persisted lock. The Worker verifies that receipt against the exact bounded public-key set pinned in the authoritative deployment manifest. Caller-selected, synthetic, stale, wrong-key, modified, or conflicting outcomes are rejected. Finalization conditionally updates the exact operation version and lock generation together, so an identical receipt is idempotent while a conflicting replay fails. A terminal result remains in the gateway journal until fence finalization and control-plane publication both succeed, so publication retries cannot redispatch the effect. Only after durable publication does the Ed25519-authenticated gateway acknowledge the exact invocation/digest/task/lease-generation/terminal-sequence/result-digest tuple to the executor. Acknowledgement loss is idempotent and retains the latest full result; subsequent work may fold only previously acknowledged non-indeterminate terminals into constant-size authenticated aggregate evidence, keeping rewrite cost and storage bounded without dropping waiting, active, unacknowledged, or indeterminate state. Indeterminate or renewal-loss results persist `reconciliation-needed` and retain the fence indefinitely; elapsed time is never evidence that a host effect cannot still commit. Only an explicit root-authorized hard stop followed by clean-start epoch rotation can produce a signed `clean-start-no-active` proof for the prior epoch. Mock/test mode follows the same handoff and generation rules while remaining provider-free. Neither AWS nor backup-provider credentials enter the gateway or executor, the executor receipt private key never leaves the executor service credential boundary, and the control-plane private key never enters EC2.

Here, an exact `not-started` proof is accepted only before reservation and the gateway's durable `dispatching` transition.
An exact authenticated `reserved` entry proves that `begin` and the host effect were not entered, so restart may resume the
same request under current authority or cancel it if authority was withdrawn. Once `in-progress` can have been reached, an authenticated
empty/current response cannot prove that a same-UID process did not delete the relevant record; the sequence checkpoint and
handoff phase force indeterminate fence retention instead.

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

`latest` means greatest authenticated backup generation, never greatest mutable Drive modification time. Authenticated
named and latest restores reject generations at or below the retained accepted floor and reject cross-server manifests.
On-host restore keeps the global lifecycle owner plus a root maintenance owner, drains the gateway, masks every executor
socket/service and Minecraft activation path, stages the profile into the replacement tree, and commits the authenticated
floor/journal before Minecraft can become protocol-ready. A precommit failure may roll back; committed recovery may only
finish service readiness for the committed generation.

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
