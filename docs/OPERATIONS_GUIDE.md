# Operations Guide

Use the signed-in web panel for production operations. It shows server state, starts and stops the server, creates and restores backups, resumes a hibernated server, manages panel access, and shows costs. The repository CLI does not provide browser-cookie authentication and is not a supported way to control a production panel.

## Panel roles

- **Admin:** the Google account matching `ADMIN_EMAIL`. It can use every panel action.
- **Allowed:** a signed-in account in `/minecraft/email-allowlist`. It can start the server and view signed-in status; it cannot stop, back up, restore, hibernate, resume, manage emails, or view costs.
- **Authenticated public:** a valid signed-in account that is neither admin nor allowed. It can use authenticated status and player-count views, but cannot start or administer the server.
- **Anonymous:** not signed in. It can see the public server and stack status described in [API](API.md), with resource IDs hidden.

Allowlist behavior differs by update path:

- Initial deployment adds `ADMIN_EMAIL` and `ALLOWED_EMAILS`.
- Panel saves retain `NOTIFICATION_EMAIL`, `ADMIN_EMAIL`, and `ALLOWED_EMAILS`.
- Inbound-email admin updates sent with subject `allowlist` retain `ADMIN_EMAIL` and `ALLOWED_EMAILS`, but not `NOTIFICATION_EMAIL`.

`NOTIFICATION_EMAIL` receives notices only. Other allowed senders may email only the start command; only `ADMIN_EMAIL` may send admin commands.

## Start, stop, hibernate, and resume

- **Start** boots a stopped instance that still has its root volume.
- **Stop** stops EC2 but keeps the root EBS volume, which continues to cost money.
- **Hibernate** creates an authenticated terminal Drive backup, proves the host is still quiesced immediately before stopping EC2, and deletes the managed root volume. Do not use it until you have verified a backup and restore.
- **Resume** normally reconstructs a stopped, hibernated instance that has no root volume, then starts fresh or restores Drive data. On an ordinary stopped instance with an attached root volume, it reuses that disk and may still run the selected restore; use Start when no restore is intended.

Resume choices are explicit:

| Choice | Result |
| --- | --- |
| `fresh` | Does not restore a backup. A hibernated server starts from its new system volume; an ordinary stopped server reuses its attached disk. This is the default when no mode or backup name is sent. |
| `latest` | Restores the newest Drive backup. |
| `named` | Restores the supplied backup name. |

Use the panel choice you intend. A resume requested while EC2 or its volume is in a transitional state can fail and leave `/minecraft/resume-pending`; wait for EC2 and storage to become stable, inspect the marker, Lambda/SSM results, and tagged volumes, then retry only after confirming no resume is still running. If storage cleanup also fails, a tagged reconstructed EBS volume can remain.

## Backups and restores

Backups use Google Drive and require the server to be running. A backup:

1. checks the server tree;
2. stops Minecraft, causing player downtime;
3. creates and checks the archive;
4. uploads it to Drive;
5. restarts Minecraft and refreshes the cached backup list.

The host journals the exact active and enablement state of Minecraft, DNS, the executor socket/service, and gateway before masking any activation path. A reboot or process crash resumes that journal and restores exactly the recorded state without repeating an already-published remote backup. Recovery keeps the durable boot hold until exact service-state verification succeeds. Check Drive and the journaled recovery result before manually changing service state, and test a restore during planned downtime before relying on backups.

Hibernation uses a terminal backup mode. After the authenticated archive is published, the host verifies that the
Minecraft protocol is closed, Minecraft/gateway activation paths are stopped and runtime-masked, and the root
maintenance fence is still held. It returns that quiescence evidence to Lambda and does not restore those services;
Lambda stops EC2 and deletes the exact managed root volume only after EC2 reaches `stopped`. A stop, mask, verification,
stale-boot, or missing-evidence failure leaves the root volume in place. Teardown of an already-hibernated host accepts
only the matching durable operation-state transaction; the cached backup list is not durability evidence. Ordinary manual
backups retain their prior service states and restore them after upload.

A restore stages the Drive archive and current profile together, verifies the complete staged tree, and only then replaces
the server directory. Before either profile or server replacement it acquires the host maintenance owner, drains the
gateway's runtime-wide execution slot, and runtime-masks then stops the gateway, executor socket, executor, and Minecraft.
This prevents socket activation during the swap. Failures before commit roll back to the prior local directory. After the
authenticated generation is committed, recovery never rolls it back; startup/readiness failure leaves the committed
journal for a later recovery attempt. Keep an independent backup.

Restore journals the pre-swap server inode/device identity, exact service state, boot/attempt identity, exact prior and
active world-root generations, and their canonical root records. A staged archive may carry hidden canonical metadata for
custom roots; restore records those reviewed roots durably, publishes the selected generation before activation, and
removes the metadata file from the installed server tree. If the level name is unchanged, the full reviewed allowlist is
preserved; if it changes, derived dimensions are combined only with reviewed additions. Precommit recovery atomically
checkpoints the prior directory and exact prior root generation together before restoring services. Once the authenticated generation and restore floor are committed,
recovery moves forward and never rolls the accepted world back. The boot generator masks all five service activation
paths for every non-restoration phase, including after reboot, so incomplete evidence fails closed.

Every new Drive backup is an immutable `.tar.gz` plus a detached `.tar.gz.manifest.json`. The strict canonical JSON
manifest is authenticated with HMAC-SHA256 and binds the archive SHA-256 and byte size, exact archive and backup name,
random backup ID, authenticated monotonic generation, UTC creation time, archive/manifest format versions, source EC2 instance ID, stable stack/server
identity, and key ID. The root backup path uploads the archive first and the manifest last; the manifest is the completion
marker. `latest` ignores Drive `ModTime`: it downloads and authenticates every bounded candidate manifest, rejects
conflicting generations, and selects the greatest authenticated generation. Restore downloads the exact named pair and
verifies canonical encoding, schema, server identity, HMAC key, generation, name, size, and digest before extraction and
before stopping or replacing Minecraft. A changed archive (including `paper.jar` or a plugin), changed manifest, swapped
name, cross-server manifest, unknown/retired key, or missing half of the pair fails closed.

The root-only local generation checkpoint and accepted restore floor are mirrored to retained SSM String parameters
`/minecraft/backup-generation-checkpoint` and `/minecraft/restore-generation-floor`. Both replicas are canonical and
HMAC-authenticated with the same rotatable keyring. One surviving replica heals the other; missing or conflicting copies
fail closed. Named and latest authenticated restores must be strictly newer than the accepted floor, so renaming or
re-uploading an old valid pair cannot turn it into `latest`. Restore commits the floor and durable `committed` journal
before unmasking any service or starting Minecraft. Crash recovery may roll back only precommit phases.

The HMAC keyring is `/minecraft/backup-auth-keyring`, an SSM `SecureString` outside Drive and the EC2 root volume.
`/minecraft/backup-server-identity` is stable stack-managed identity metadata. The EC2 role reads only those exact
parameters, with KMS decryption scoped to the exact SecureString ARN. The Worker, lifecycle Lambda, agent gateway,
executor, and Minecraft service cannot read the keyring. Only the root-owned `0750` helper fetches it; key material is not
written to disk, put in argv/environment, archives/manifests, or logs. Stack deletion does not delete the externally
provisioned SecureString; the reviewed teardown workflow owns disposal.

### Authenticated recovery capsule and backup-state teardown policy

The destroy inventory uses a closed exact-name classification for all backup state. The six exact SSM records
`/minecraft/backup-server-identity`, `/minecraft/backup-generation-checkpoint`, `/minecraft/restore-generation-floor`,
`/minecraft/backup-auth-keyring`, `/minecraft/backup-verifier-metadata`, and
`/minecraft/backup-recovery-adoption-lock` form the authenticated recovery capsule outside Drive. They remain available
through the final authenticated Drive backup or final EBS snapshot gate and remain after decommission by default.
The capsule, state, verifier, and deployment provenance all use schema version 3. The manifest records their exact names, authenticated HMAC/state formats, key-ID source, and checkpoint/floor
continuity, but never records key material or state secrets.
The stack custom-resource delete callback is intentionally non-destructive so
teardown, rather than CloudFormation, controls that order.

The keyring is retained by default so retained authenticated archives and verify-only rotation keys remain recoverable.
An operator may delete the capsule only by naming all six exact parameters with `--consent-delete-ssm`, then entering
the second exact phrase printed after preservation evidence. The warning explicitly says that archives become
unrecoverable. This is an exact-name decision, not a prefix or namespace delete.
Pre-existing, unproven, lookalike, and otherwise unclassified parameters are
preserved and block automated teardown. A rerun reuses the same final
preservation evidence and deletes only the exact owned leftovers; an
already-absent stack follows the same rule after its durable evidence or
explicit second confirmation is present.

The guarded setup/deploy path provisions an initial keyring if absent. Explicit operator provisioning and rotation use
non-secret key IDs (never key material in arguments):

```bash
pnpm backup-auth:keyring -- provision --key-id initial-2026-09
pnpm backup-auth:keyring -- rotate --key-id rotation-2027-01 --confirm-key-id rotation-2027-01
```

Rotation makes the new key the sole signer and retains older keys as `verify-only`, so old archives and durable state
replicas remain verifiable and are rewritten with the active key on the next state advance. Do
not remove a verify-only key while a retained backup uses it. The bounded keyring accepts eight keys; archive or expire
backups before reaching that limit. SSM survives instance/root-volume destruction. To restore an operator-escrowed
keyring envelope after account-level loss, first put the exact JSON in a root/operator-only `0600` file, verify target and
recovery source out of band, then run:

```bash
pnpm backup-auth:keyring -- recover --from-file /secure/offline/keyring.json \
  --confirm-parameter /minecraft/backup-auth-keyring
```

The command validates the complete keyring before replacing the SecureString and never prints its material. Keep escrow
encrypted outside Drive, EC2, and this repository. Losing both the SSM recovery capsule and escrow makes the archives
intentionally unrecoverable.

For a replacement or recovery stack, first place the private capsule in a root/operator-only `0600` file and set
`MC_BACKUP_RECOVERY_CAPSULE_FILE` when running setup. Setup authenticates the capsule MAC before importing the complete
keyring (including every retained verifier key), server identity, verifier metadata, checkpoint, and restore floor into
SSM. Existing records must match or be authenticated newer state; lower state is advanced and rollback/conflict is
rejected. Adoption first claims the retained, account-scoped `/minecraft/backup-recovery-adoption-lock` with atomic
`PutParameter(Overwrite=false)`; it does not use the replacement stack's lifecycle table. The claim binds the capsule
digest, account, region, stack, key IDs, and monotonic generations. Every read/write phase rechecks that claim and
SSM versions, so a concurrent generation advance is preserved and retried and a stale failure cannot undo a later
backup. The claim is retained as durable recovery state, making a lost setup or CloudFormation response safe to rerun
for the same capsule while a different capsule fails closed. A failed import is rolled back before deployment starts.
Key material is never written to logs, deployment manifests, or environment artifacts; only non-secret content digests
are recorded. CDK's post-stack custom resource verifies the already-activated claim and exact imported values without
depending on the destroyed lifecycle table. The replacement therefore accepts old signed archives while the
authenticated floor continues to reject replay or generation collisions. A replacement without this explicit adoption
is refused. The verifier value `UNINITIALIZED` is the explicit first-install sentinel and is adoptable; any real,
different verifier metadata is a conflict.

All capsule writers—including checkpoint allocation, restore-floor commits, keyring rotation/recovery, capsule adoption,
and DNS credential materialization—serialize through the account-scoped `/minecraft/backup-recovery-migration-lock`.
The lock is an atomic SSM no-overwrite claim and each owner verifies its exact value before and after mutation. SSM writes
also re-read the parameter version and final value, so a lost or concurrent write fails closed rather than silently
overwriting newer recovery authority. Runtime checkpoint and floor writers use the same lock; do not bypass the reviewed
helpers with direct `aws ssm put-parameter` commands.

DNS credentials are setup-owned only after the pre-deployment manifest records an exact absent/owned observation. A
pre-existing credential or `/minecraft/dns-mode` value with no matching manifest claim is preserved and blocks overwrite;
provider changes delete only exact manifest-claimed parameters. The stack's `/minecraft/stack-ownership-claim` is likewise
created with an atomic no-overwrite claim and is reconciled on retries, while the `McAwsClaimToken` CloudFormation tag
must match the manifest before an existing stack is adopted.

Backups created before this format remain unsigned persisted data and are not shown as authenticated backups. Normal
named/latest restore rejects them. During planned downtime, a root operator may repeat one exact name as a separate
confirmation:

```bash
sudo /usr/local/bin/mc-restore.sh --legacy-unsigned old-backup.tar.gz \
  --confirm-legacy-unsigned old-backup.tar.gz
```

This override never accepts `latest`, emits a `SECURITY_AUDIT` warning, and is not exposed through panel, resume,
scheduled, or agent flows. It excludes unauthenticated `paper.jar` and all `plugins/`, sourcing those executable inputs
from the current local installation before profile reapplication. Treat all other legacy data as untrusted and replace it
with a newly authenticated backup after validation.

Hibernate is stricter than an ordinary backup: the host must have the current authenticated backup tooling, quiesce the
runtime, and publish a fresh manifest bound to the exact hibernate operation and current instance/server identity. The
Lambda validates the detached archive/manifest pair cryptographically, including its digest, non-zero monotonic
generation, creation time, and restoreability metadata, before it can stop, detach, or delete the root volume. Missing,
stale, tampered, manifest-less, ambiguous, or legacy-host results fail closed and preserve the volume. A cached pair is
never used as a substitute for that exact fresh hibernate proof.

### Scheduled backup policy

`MC_SCHEDULED_BACKUP_ENABLED=false` is the safe default because selecting a Drive folder during setup does not prove that a durable Drive refresh token exists. The setup wizard offers an explicit opt-in. When enabled, the default `cron(0 5 ? * SUN *)` attempts one backup each Sunday at 05:00 UTC. The target recovery-point objective (RPO) is therefore **seven days while the server is running at the scheduled time**. `MC_BACKUP_STALE_AFTER_HOURS=192` raises a freshness alarm after eight days without a successful scheduled backup, allowing one day for investigation.

The scheduler never starts or resumes EC2. It checks for the encrypted Drive credential, requires EC2 to already be `running`, acquires the same DynamoDB lifecycle lock/fencing token used by panel and email actions, writes the same durable operation state, and rechecks instance state before SSM execution. Missing credentials, a stopped/transitional instance, duplicate delivery, or another lifecycle action produces a structured safe-skip log. A long stopped period can therefore exceed the target RPO by design; the staleness alarm detects this but does not wake the server. Success updates `/minecraft/last-scheduled-backup-success`. Failures are logged, metered, recorded as failed operations, and pass through the existing asynchronous/idempotent retry path; durable terminal state prevents a retry from repeating the backup. Unhandled delivery/platform failures can reach the lifecycle failure queue. No monitoring path performs an automatic restore or destructive action.

Change `MC_SCHEDULED_BACKUP_SCHEDULE` only to a valid EventBridge `cron(...)` or `rate(...)` expression and keep `MC_BACKUP_STALE_AFTER_HOURS` longer than the intended interval. Redeploy after changing deploy-time schedule values. Test a manual backup and restore before enabling unattended backups.

## Monitoring and alerts

The stack retains all project Lambda and custom-resource CloudWatch logs for 30 days and deletes those log groups with the stack. Migration updates only the exact CloudFormation-owned legacy function log-group names, never a stack-name wildcard. The encrypted lifecycle failure queue retains sanitized exhausted asynchronous/delivery failures for 14 days. A separate encrypted sanitizer dead-letter queue retains the raw destination envelope if the sanitizer itself exhausts retries, and its depth alarm prevents that terminal failure from being silent. Access that second queue only during restricted incident response because its payload was not sanitized. Both queues are deleted with the stack. Reserved lifecycle concurrency remains one; Lambda retries asynchronous lifecycle events twice with a one-hour maximum age, leaving retry opportunity after a maximum-length 15-minute execution while durable operation IDs and fencing make duplicate delivery safe.

CloudWatch alarms cover:

- EC2 instance/system status-check failures;
- lifecycle Lambda unhandled errors/timeouts, caught operation failures, 13-minute duration, throttles, and 10-minute asynchronous event age;
- lifecycle failure-queue depth;
- failure-sanitizer dead-letter queue depth;
- scheduled-backup execution failure and staleness when scheduling is enabled.

Every alarm publishes ALARM and OK changes to the project SNS topic. Set `MC_ALARM_EMAIL` only when an operator wants email. Blank means no subscription and no surprise email. When set, AWS sends a **Subscription Confirmation** message; open its confirmation link before relying on alerts. An unconfirmed subscription receives nothing. The `AlarmTopicArn` and `LifecycleFailureQueueUrl` stack outputs locate both resources. Treat queue payloads and logs as operational metadata and do not forward them publicly.

At low volume, EventBridge, Lambda, SQS, SNS email, and SSM request charges should normally be pennies. CloudWatch is the material addition: standard alarms, two custom backup/operation metric families, log ingestion, and 30-day storage are commonly around **$1–3/month**, but region, usage, free tier, and AWS pricing determine the actual amount. Review AWS Pricing and Cost Explorer rather than treating this estimate as a quote.

### Cloudflare production logs

`wrangler.jsonc` keeps persisted Cloudflare observability and invocation logs disabled by default. Before enabling Workers Logs in production, open **Workers & Pages → mc-aws-panel → Observability → Settings**, set **Redact query strings** to **On**, and verify it after deploys or dashboard changes. OAuth callbacks carry short-lived codes and state in their query strings; do not enable invocation logs without this control. The source configuration also leaves `invocation_logs=false` as defense in depth.

For this low-traffic panel, use `head_sampling_rate=1` while investigating or when full security-event coverage is required. If volume or cost requires sampling, set `observability.logs.head_sampling_rate` deliberately, document the chosen rate, and never describe a sample as a complete audit trail. Cloudflare plan controls the Workers Logs retention window: review the current plan and dashboard value before production use (Cloudflare currently documents up to 3 days on Free and 7 days on Paid). Choose the plan that meets the incident-response window, or export sanitized logs to an approved destination with an explicit retention/deletion policy. Recheck query redaction, sampling, destination access, and retention at least quarterly and after plan changes.

### Audit-log limitation

This stack does not create a paid durable CloudTrail trail. AWS CloudTrail **Event History** provides roughly 90 days of regional management events, but it is not a durable archive, does not include every data event, and is insufficient as a long-term forensic control. A future explicit operator choice can add an organization/account trail with a dedicated encrypted S3 bucket, retention/lifecycle policy, optional CloudWatch delivery, and deliberately selected data events. That choice is deferred because it adds storage, KMS/request cost, bucket-retention decisions, and account-wide scope; it is not silently enabled here.

## Server profiles

See [Server Profiles](SERVER_PROFILES.md) for when profile content is applied and how to validate it.

### Host release integrity

Bootstrap and existing-host maintenance consume one versioned host release from `/minecraft/server-profile-manifest`.
The release contains the agent runtime, backup/restore/authentication helpers, world-root helper, host-operation
contract, all cooperating scripts, and their systemd units/configuration. Its `release-manifest.json` and the installed
`/var/lib/mc-aws/runtime-hashes.sha256` record the exact SHA-256 and byte size of every member. A missing, stale,
extra, or digest-mismatched member fails closed; members from an older release are never mixed with a new one.
Before activation, the canonical `dual-v1` lifecycle owner is acquired, the gateway is drained, authenticated executor
idle is proven, and Minecraft, DNS, the executor socket/service, and gateway are masked and stopped. A root-owned durable
maintenance marker is fsynced before activation; the boot generator masks all five paths after a reboot and the recovery
unit only recreates the volatile gateway fence. A rerun consumes a matching committed journal idempotently or exactly
rolls back an unresolved precommit journal, restoring only units recorded active and preserving enable/mask state.
Corrupt evidence keeps boot inhibition in place. Validation-only deferred profiles and restore staging do not mutate
live release, systemd, credential, runtime-link, or Minecraft destinations.

### Executor receipt authority and indeterminate recovery

The executor alone holds `/etc/mc-agent/executor-receipt-private.pem` through the
`executor-receipt-private` systemd credential. The gateway, Minecraft process, runtime bearer, Worker, and deployment
manifest receive no private receipt material. The public Ed25519 SPKI and its SHA-256-derived key ID are emitted as
`/etc/mc-agent/executor-receipt-verifier.json`. Fresh setup reads that public file only after bootstrap, records it in
`.mc-aws-deployment.json`, and writes the exact bounded verifier set to `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS` before
deploying the Worker. Existing-host `rollout-runtime` performs the same local manifest/env update and deliberately does
not deploy the Worker automatically. A routine rollout that rediscovers the same receipt key ID, public key, and epoch
is a no-op for receipt authority and requires no rotation cutoff. Every rollout still holds global lifecycle exclusion
through host drain, activation, readiness, and receipt pinning. Before host mutation, standalone rollout promotes that
lock to protected ownership and fsyncs `.mc-aws-runtime-rollout.json`. It fsyncs the authoritative manifest and both
dotenv files before conditional release. If the host later becomes unavailable after verifier pinning, run
`pnpm host:upgrade -- reconcile-runtime-receipt` with the exact stack, instance, and pins confirmations recorded by the
failed rollout; this local-only reconciliation does not require an SSM-online host and deliberately retains both
maintenance authorities. Rerun the exact `rollout-runtime` command when the host is available to reconcile host release
and conditional lifecycle-lock release.
If verifier authority is new or rotated, release keeps the executor socket/service and gateway disabled so the
undeployed Worker cannot receive an effect signed by unknown authority. Deploy the reviewed Worker verifier set, then
rerun the exact rollout; unchanged verifier authority allows agent service activation.

An indeterminate executor effect or backup fence has **no time-based recovery**. Do not delete the journal, operation,
lock, or credential; do not edit DynamoDB/SSM state; and do not synthesize a terminal result. The fence remains held even
after service timeouts, lock expiry timestamps, process restart horizons, or arbitrarily long wall-clock delay. First
reconcile the exact invocation normally. If that cannot produce an authoritative terminal receipt, inspect the host and
durable operation identity, then use the authorized clean-start path only after deciding that a hard stop is required:

1. Keep new agent work quiesced. Runtime-mask and stop `mc-agent-gateway.service`, `mc-agent-executor.socket`, and
   `mc-agent-executor.service`. Confirm all three units are inactive and masked. This hard stop kills the executor cgroup;
   do not use the procedure while any unit can still socket-activate.
2. As root, run
   `mc-agent-install.sh rotate-clean-start-epoch --confirm-hard-stop ROTATE-EXECUTOR-CLEAN-START-EPOCH`.
   The command independently refuses unless all three units are inactive and masked, atomically creates a new root-only
   epoch, and leaves services masked.
3. Unmask and start the executor socket/service and gateway through the reviewed maintenance path. Reconcile the same
   invocation. The changed root-controlled epoch permits only a signed `clean-start-no-active` receipt for the old
   journal owner; the Worker still checks the exact runtime/session/task/lease/invocation/backup/lock generations before
   atomically releasing anything. If reconciliation or publication fails, retain the fence and investigate.

Receipt-key rotation uses the same hard-stop prerequisite, but a service stop alone is not sufficient. Before a bounded
history entry is retired or removed, the existing-host rotation path scans the current retiring key (not just older
history) in strongly consistent durable operation state and in the authenticated executor and gateway journals. Committed
results without terminal receipts, gateway handoffs, backup fences, or incomplete terminal-publication evidence all
remain blockers; a complete durable receipt is the boundary that makes an old private signer unnecessary. Migrate or
reconcile that operation first, then retain the old verifier until no in-flight receipt can use it. The host keeps a
root-only copy and a 0600 crash-safe rotation journal until the new private key and epoch are durably published; an
interrupted precommit restores the old key before any credential repair. The host increments its root-owned receipt-key epoch atomically
with the new private key. Run
`mc-agent-install.sh rotate-receipt-key --confirm-hard-stop ROTATE-EXECUTOR-RECEIPT-KEY`, capture only the emitted public
verifier JSON, and add it with `scripts/shared/deployment-manifest.mjs executor-receipt --key-id ... --public-key-spki ...`.
Pass an explicit `--rotation-cutoff-at` for the prior key. That command derives and checks the key ID and epoch, makes the
new key current, retains at most two prior verifiers only through their recorded cutoff, and rejects mismatched or duplicate
material. Active operations are renewed onto the new fence epoch before dispatch; an operation that remains on the old epoch
must retain that exact old private key and is accepted only through its cutoff. Put `executor-receipt-state`'s exact JSON into
`MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS`, deploy and validate the reviewed Worker environment, and only then unmask agent
services. Never remove a prior verifier while an operation signed by it can remain in flight; if three retained keys are
already present, quiesce and reconcile old operations before rotating again.

## SSM access

Use the panel first. For a running instance, advanced access is available through AWS Systems Manager:

```bash
./bin/connect.sh
./bin/console.sh
```

This requires the AWS CLI, Session Manager plugin, a signed-in AWS identity allowed to start SSM sessions, the deployment region/profile, a managed instance online in SSM, and outbound network access from the instance. Port 22 is not open.

## Deploy changes

For an ordinary UI-only release, update the panel:

```bash
pnpm deploy:cf
```

The deployer creates a durable local recovery record before its first Cloudflare mutation and automatically rolls back an interrupted run before allowing another. Preserve that file and follow [Cloudflare deployment recovery](CLOUDFLARE_DEPLOYMENT_RECOVERY.md) if recovery cannot finish.

Preview infrastructure changes, then deploy only after reviewing replacements and data impact:

```bash
pnpm cdk:diff
pnpm cdk:deploy
```

Older stacks may require [Legacy Stack Safety Bridge](EXISTING_DEPLOYMENT_MIGRATION.md) instead of a normal deployment.

The standard deploy command loads `.env.production` with the same target-preservation rules as the CDK app, requires an exact account and region, and runs the existing-host safety guard first. A guard refusal occurs before Cloudflare/DuckDNS credentials are changed. After a successful guard, the selected DNS token is sent directly to its SSM `SecureString` parameter through the AWS SDK and is never placed in a process argument or CloudFormation parameter. Do not bypass this orchestrator with a direct `cdk deploy`.

### Lifecycle concurrency migration order

The DynamoDB lifecycle-lock and operation-state rollout is a mixed-version `dual-v1` migration. Deploy it in this order; do not deploy the new Worker before its AWS tables, IAM permissions, Lambda environment, and protocol metadata exist:

1. Quiesce new panel and email lifecycle actions, then run `pnpm cdk:diff`. Refuse unexpected EC2 replacement or destructive table changes. The lifecycle lock table must synthesize `UpdateReplacePolicy: Retain` and `DeletionPolicy: Delete`: replacement rollback stays safe without leaving PII/billing after teardown.
2. Before enabling a Worker/panel release that depends on new host runtime, publish the reviewed content-addressed agent ZIP and atomic stack manifest through the reviewed non-instance infrastructure bridge, then immediately run the confirmed `pnpm host:upgrade -- rollout-runtime ...` stage. The command locally rebuilds the reviewed ZIP and requires its digest, exact size, and bundle-manifest digest to equal the published manifest; a previous live SSM artifact is never accepted as a substitute. It takes a legacy-compatible maintenance lock, checks `dual-v1` metadata/current lock state when the table exists, transfers checksum-verified helpers through SSM, and delegates one bounded host transaction to the helper from that exact release. The transaction journals content-addressed pre-state for every cooperating destination and records service enabled/masked/active state before quiescing. It verifies dependency versions, runtime hashes, the exact runtime transition, installed manifest, three-way world roots, loopback Minecraft protocol and plugin initialization, and functional local executor/gateway sockets before commit. Minecraft readiness runs from a private copy/reflink of the complete server tree while live Minecraft remains stopped, so startup migrations, plugin data, player activity, and world writes cannot escape before the journal commit. `active` alone is never readiness. Existing valid custom roots are preserved; malformed or conflicting configs stop the rollout and restore its backed-up inputs. No-transition failures never invoke runtime rollback, and stale global previous-runtime markers are never consulted. A verified rollback restores exact prior state; failed rollback leaves the attempt journal and runtime masks in place. The exact lifecycle lock is released only after every check succeeds. Publication, transfer, digest, activation, root equality, or health failure keeps the Worker disabled and leaves the lock for recovery; do not delete it until old inputs are restored or a complete reviewed rollout is proven.
3. Deploy AWS infrastructure with the reviewed non-instance bridge or replacement path. The metadata custom resource initializes `protocol#dual-v1` before the lifecycle Lambda update. The old Worker remains compatible because the rollout preserves `/minecraft/server-action` and `/minecraft/server-action-delete-claim/*`.
4. Persist `InstanceId`, `LifecycleLockTableName`, and `OperationStateTableName` before any Worker deploy. Fresh setup and host replacement do this automatically. For an existing bridge, run `pnpm migrate:existing -- --region "$MC_AWS_REGION" --stage sync-worker-env --execute --confirm-stack-id "$STACK_ID" --env-file .env.production`, then `pnpm bootstrap:check -- --env-file .env.production`. The table names become validated Wrangler plain-text variables, not Worker secrets; the bootstrap digest is deploy provenance only.
5. Run Worker environment validation, deploy the Worker, and verify one lifecycle action plus operation polling before reopening mutations.

For rollback, restore the previous Worker version first, while the SSM compatibility lock and its IAM permissions still exist. Quiesce and drain lifecycle deliveries before a reviewed Lambda/CDK rollback; do not apply an old template that deletes bridge metadata, retained lifecycle state, operation state, or SSM compatibility paths while current deliveries can still run. Recovery refuses to report success while either lifecycle lock remains active or malformed.

### Teardown lifecycle ordering

`pnpm destroy:execute` is itself a global lifecycle operation. After read-only inventory and exact confirmations, it records a stable destroy operation/lock identity in `.mc-aws-deployment.json`, conditionally acquires the `dual-v1` DynamoDB lock with a monotonically incremented fencing token, mirrors it to SSM, marks it non-expiry-takeover eligible, and renews its lease generation during long preservation/deletion waits. Any current lifecycle owner or active agent effect blocks acquisition. Once acquired, new or delayed start/resume/restore/backup/hibernate/stop/allowlist work, runtime rollout, and agent backup/fence acquisition fail closed against that owner.

Under the barrier, teardown stops new agent leases at the host gateway, proves the executor effect journal and shared backup/restore flock idle, and stops the executor socket/service before final preservation. It durably enters `preserving` before the final Drive backup or EBS snapshot. From that phase onward failures retain resumable destroy state; reruns reuse only preservation created under the same fenced operation, so no post-preservation host mutation can force an unsafe duplicate or stale snapshot. Worker routes/Worker are disabled before runtime IAM credentials are revoked, and both precede exact StackId deletion. The barrier is never automatically released. Explicit `--safe-abort-destroy` is available only before preservation, and the full recovery contract is in [Safe Teardown](TEARDOWN.md).

Paper, rclone, mcstatus, and the AL2023 image never refresh during a routine deployment. Follow [Reviewed Bootstrap and OS Upgrades](BOOTSTRAP_UPGRADES.md) for checksum-verified artifact changes and the intentional OS security-maintenance path.

## Real-environment smoke configuration

The manual **Real-Environment Smoke Verification** workflow uses the protected `real-environment-smoke` GitHub Environment. Configure `SMOKE_BASE_URL` and `SMOKE_SESSION_COOKIE` as environment secrets. Configure `SMOKE_EXPECT_DOMAIN` as an environment variable containing the exact Minecraft DNS hostname, without a scheme or path; an explicit workflow input can override it for a single run. `SMOKE_EXPECT_BACKEND_MODE` and `SMOKE_REQUEST_TIMEOUT_MS` are optional environment variables.

The required S4 check forces an authenticated status snapshot write, then requires the next read to return the same opaque response-header probe from snapshot metadata. When the server is running and the status response exposes its domain, S4 requires an exact `SMOKE_EXPECT_DOMAIN` match. A non-running status intentionally omits the domain, allowing smoke verification without starting a stopped server; the deployment preflight still validates the configured domain. The probe and infrastructure identifiers are never written to the summary. Each request has a bounded timeout, and failures still produce the fixed redacted summary artifact.

## Operation record cleanup

Current operation records live in the DynamoDB operation-state table. Nonterminal records have no TTL and cannot be
retention-deleted. Terminal records without retained lifecycle identity become TTL-eligible after 30 days by default;
terminal records that still carry lifecycle identity remain TTL-free for reviewed cleanup. Compatibility cleanup also
retains a terminal mirror while its exact authoritative DynamoDB lifecycle lock is still owned. DynamoDB TTL is eventual; the
operator cleanup first proves that both configured table names are outputs of the exact claim-tagged stack in
`.mc-aws-deployment.json`, then scans the exact operation table and conditionally deletes only the version/timestamp it
reviewed. Always preview first:

```bash
pnpm operations:cleanup -- --dry-run
pnpm operations:cleanup
```

The command requires `MC_OPERATION_STATE_TABLE_NAME`, `MC_LIFECYCLE_LOCK_TABLE_NAME`, the secure deployment manifest,
and a local operator identity with `cloudformation:DescribeStacks` plus table-scoped `dynamodb:Scan` and
`dynamodb:DeleteItem`; these permissions are intentionally not granted to the Worker. Use
`--retention-days=<days>` or `MC_OPERATION_STATE_RETENTION_DAYS` to change the cutoff and
`--max-deletions=<count>` to bound one run.

During the DynamoDB dual-read migration, legacy PII-bearing SSM records remain readable as fallback. Preview and clean them only after quiescing operations and keeping the required rollback/retention window:

```bash
pnpm operations:cleanup -- --dry-run --include-legacy-ssm
pnpm operations:cleanup -- --include-legacy-ssm
```

`--legacy-ssm-only` is available for a pre-DynamoDB installation. Legacy cleanup additionally needs SSM path read and exact delete permissions. Keep the SSM fallback and runtime IAM until every supported rollback version uses DynamoDB, in-flight operations have drained, and a reviewed dry run shows no required SSM-only record; remove fallback/IAM only in a later staged infrastructure change.

## Remove the deployment

Read [Safe Teardown](TEARDOWN.md), verify Drive directly, and run the dry run before deleting anything.

## Troubleshooting

- **Start fails:** check panel state. A hibernated server needs resume, not start. Check AWS region, Lambda logs, and SSM command results.
- **Resume fails:** inspect Lambda, cloud-init, SSM results, and tagged EBS volumes before retrying. Do not remove `/minecraft/resume-pending` unless no resume is running and you understand the failed step.
- **DNS fails:** check the selected DNS mode, token, zone, and hostname and confirm the token can edit the intended zone.
- **Google sign-in fails:** check the app URL and Google callback URL, then restart local development after environment changes.
- **Backup or restore fails:** check Drive configuration, EC2 script logs, service status, and Drive itself. The panel backup list is cached.
