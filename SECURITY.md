# Security Policy

## Supported versions

Security fixes are considered for the latest GitHub release. Older releases and unreleased `main` are not supported. This is a personal project maintained on a best-effort basis; no response or fix timeline is guaranteed.

## Report a vulnerability

Do not use public issues, discussions, pull requests, or logs. Use [GitHub private vulnerability reporting](https://github.com/shanebishop1/mc-aws/security/advisories/new) and include the affected version, impact, minimal reproduction, suggested mitigation, and whether cloud resources or credentials may be exposed.

Remove tokens, cookies, private hostnames, account IDs, and resource IDs unless strictly necessary. Never submit active secrets.

Only test deployments you own or are authorized to test. Do not access another user's data, disrupt service, create costs for others, or retain exposed credentials. Report upstream AWS, Cloudflare, Google, Minecraft, or dependency issues to the provider when appropriate.

## Deployment boundaries

- `AUTH_SECRET`, `ADMIN_EMAIL`, runtime bearer/verifier values, and private signing material are excluded from Next/OpenNext build dotenv and process input, then supplied only through their runtime bindings. Deployment opens a root-private read-only descriptor to the validated dotenv source before provider mutation; later config, validation, scanning, and secret-upload reads use that immutable descriptor even when KV provisioning atomically replaces the source file. Next/OpenNext isolation uses the owner-only `.mc-aws-state` journal/backup directory, outside predeploy cleanup paths, and recovers it before provider mutation on rerun. Explicit rotation also applies to currently valid values: a `0600` local journal preserves the one CSPRNG candidate across interruption/rerun without printing it, and artifact scanning fails closed before upload if exact secret or canary material appears in `.next`, `.open-next`, or OpenNext scratch output. Worker secret uploads pass only names in child arguments; each value is streamed once through stdin, never through a child argument, inherited environment, reversible encoding, log, or command telemetry.
- `MC_BACKEND_MODE=aws` is a non-secret canonical Worker `vars` binding, never a Worker secret. The deployment validates and carries that value from the immutable pre-mutation dotenv descriptor into the generated Wrangler config; Worker startup rejects missing, noncanonical, or mock modes before the backup provider adapter is selected.

- The EC2 security group exposes TCP port `25565` to all public IPv4 addresses. SSH port 22 is closed; administration uses SSM Session Manager.
- The tracked server settings use `online-mode=true`, `white-list=true`, and `enforce-whitelist=true`. Keep a real player UUID/name list and review changes to these settings.
- **Anonymous access:** callers can see server state, the public IP or hostname while running, volume presence, and CloudFormation stack existence/status. Instance and stack IDs are hidden.
- **Signed-in but unapproved access:** a valid Google user outside the allowlist can also use authenticated player-count and status views. Signing in does not grant lifecycle or administration actions.
- Panel sessions use signed, HTTP-only cookies with a maximum 30-day lifetime. Session JWTs require HS256, JWT type, expiration and issued-at timestamps, the fixed mc-aws issuer and panel audience, a session-purpose claim, and a nonempty email; verification rejects missing, future, stale, expired, overlong, cross-purpose, or algorithm-confused tokens. Production accepts `AUTH_SECRET` only as canonical unpadded base64url decoding to at least 32 bytes; setup emits 48 CSPRNG bytes in exactly that format. Arbitrary human strings are never assigned an estimated entropy, and ordered, repeated, printable wrapped, padded, hex, or other legacy/noncanonical forms fail closed at schema load, deploy preflight, session use, and Worker startup. Rotate every old noncanonical value explicitly with `MC_AWS_ROTATE_AUTH_SECRET=1`; rotation invalidates all existing panel sessions and setup/deploy omit the replacement from output. Local development alone retains convenient non-production secret values.
- Cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests are pinned to the configured canonical panel origin and request host. Browser mutations require a matching `Origin`; origin-less requests are accepted only without browser Fetch Metadata headers for controlled non-browser clients. OAuth callbacks and read-only `GET` routes are not subject to this mutation check.
- Google Drive setup requests full Drive scope so it can find archives created by older clients. Treat the token as access to the user's Drive, not just this app's folder.
- Drive is not an authenticity trust root. New archives require a detached canonical HMAC manifest whose keyring lives in
  deployment-managed SSM SecureString storage outside Drive and the EC2 root volume. Only the root backup/restore helper
  can decrypt it; Minecraft, Worker, gateway, executor, and Drive never receive it. Unsigned legacy restores fail closed
  unless an operator uses the exact separately confirmed root-only override in the Operations Guide; that path excludes
  archive-supplied Paper and plugins.
- Drive timestamps are not freshness authority. Manifest schema 3 authenticates a monotonic backup generation, stable
  server identity, exact archive SHA-256, and exact byte size. Restore authenticates the small manifest first, pins each
  Drive object ID plus available revision/hash metadata, checks Content-Length when supplied, and streams into atomic
  staging with the configured archive maximum, timeout, and free-space reserve. Chunked/no-length and oversized objects
  are aborted and deleted before extraction; legacy unsigned restores use a fixed 64 MiB cap and exclude executables.
  Root-local and retained-SSM authenticated checkpoint/floor replicas reject cross-server state, downgrade,
  same-generation conflict, and old-pair re-upload. Restore drains and masks the gateway/socket/executor/game
  activation paths, commits the accepted floor before protocol readiness, and never rolls back a committed generation.
  Restore, ordinary backup, hibernate, and terminal destroy all persist operation-specific boot inhibition before host
  mutation. Their journals bind exact service active/enablement state and boot/attempt identity; restore additionally
  binds the prior server inode/device and immutable world-root generation. Rebooted or malformed nonterminal evidence
  keeps all five service activation paths masked rather than guessing a recovery state.
- Decommission preserves the exact checkpoint, restore-floor, and server-identity parameters until the final authenticated
  Drive backup or EBS snapshot evidence is complete. Teardown then removes only proven project-owned state in its recorded
  order. The backup-auth keyring, including verify-only rotation keys needed by retained archives, is intentionally retained
  by default and is disposable only through explicit exact-name consent after preservation. Similar or nested SSM names are
  unclassified and cannot be deleted by consent or by a path-wide operation. Attached-root Drive teardown publishes an
  operation-bound terminal backup before cloud-side stop and issues no later host mutation. Hibernated teardown requires
  the exact operation-table record binding terminal quiescence and managed-volume identity to the authenticated backup;
  an ordinary cached backup list is never accepted as destruction evidence.
- Backup archives are gzip-compressed tar files, not application-encrypted archives. Drive account controls and Google storage encryption protect them, but anyone who obtains an archive can read world data and server files in plaintext.
- `.env`, `.env.local`, and `.env.production` may contain Google, Cloudflare, DNS, OAuth, session-signing, and other credentials. They are gitignored but remain credential-bearing local files. Restrict local access and backups.
 - Runtime identities are separate. The EC2 instance profile reads required SSM/profile data and performs server tasks. The lifecycle Lambda controls the managed instance and sends its fixed, validated host operations through SSM. The Worker uses a deployment-scoped IAM identity limited to the exact lifecycle Lambda, managed instance status/stop, stack status, lifecycle state, and non-secret coordination parameters; it has no `ssm:SendCommand`, `ssm:GetCommandInvocation`, or Drive-token access. Service readiness is returned by a small Lambda operation containing only instance state and a boolean, never command IDs, stdout, stderr, or secrets. Human deployment credentials remain only in the local AWS CLI chain and must not be uploaded to the Worker.
 - Legacy SSM bridge cleanup uses a claim token bound to its exact owner and monotonic claim version. Both the lock delete and claim cleanup revalidate that tuple; a claimant that has gone stale cannot remove a successor's claim or bridge record.
- `START_KEYWORD` selects an inbound email command. It is not a credential. Inbound authorization still depends on SES mail checks, `ADMIN_EMAIL`, and the email allowlist; do not treat a hard-to-guess keyword as access control.
- Server-profile validation scans only the selected profile and checks a limited set of filenames, file types, sizes, JSON structures, and credential-like text. It is not a general secret scanner and does not inspect unrelated local files. Review profile content before deployment.
- `NOTIFICATION_EMAIL` receives notices but is not an inbound-email admin. Saving the panel allowlist retains it alongside `ADMIN_EMAIL` and `ALLOWED_EMAILS`. Only `ADMIN_EMAIL` can issue inbound admin commands.
- Persisted application logs omit email addresses, roles, cloud resource IDs, OAuth state, inbound subjects, backup names, tokens, command output, and raw provider errors. Cloudflare invocation logs are disabled in source configuration so callback query strings are not persisted; follow the production retention and redaction controls in the Operations Guide before enabling them.

## If credentials or data are exposed

1. Stop using the affected panel or automation and preserve only sanitized logs needed for investigation.
2. Revoke or rotate the exposed session signing secret, Google OAuth/Drive token, Cloudflare tokens, DNS tokens, and AWS keys as applicable. If the Worker identity may be exposed, revoke its access key immediately. Sign in again after rotating the session secret.
3. Remove unknown panel allowlist entries and review inbound-email settings.
4. Review CloudTrail, Cloudflare activity, Google account access, SSM parameters, EC2 volumes/snapshots, Drive files, and billing for unauthorized actions. Review host and backup integrity; a compromised Worker can request only the allowlisted lifecycle Lambda operations and cannot directly run SSM commands or read the Drive credential.
5. Redeploy or restore from a verified backup if server or panel files may have changed.
6. Follow [Safe Teardown](docs/TEARDOWN.md) if the deployment cannot be trusted; do not broadly delete resources by name.

See [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md), [Operations Guide](docs/OPERATIONS_GUIDE.md), and [Server Profiles](docs/SERVER_PROFILES.md).
