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
- **Hibernate** creates a Drive backup, refreshes the backup cache, stops EC2, and deletes the managed root volume. Do not use it until you have verified a backup and restore.
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

Most failures attempt to restart Minecraft. A partial failure is possible: the archive may already be in Drive while Minecraft fails to restart, or the backup may succeed while the cached list fails to refresh. Check Drive directly, check service status, and start the service before retrying. Test a restore during planned downtime before relying on backups.

A restore replaces the server directory from Drive, reapplies the current server profile, and restarts Minecraft. If the restored server does not start, rollback to the prior local directory is attempted; rollback can also fail. Keep an independent backup.

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
2. Before a Lambda release depends on a new host helper, run the confirmed `pnpm host:upgrade -- rollout-runtime ...` stage. It takes a legacy-compatible maintenance lock, checks `dual-v1` metadata/current lock state when the table exists, transfers checksum-verified `mc-wait-ready.sh` and the rollout helper through SSM, applies exact bootstrap pins idempotently, and verifies dependency versions, runtime hashes, and readiness. The exact lock is released only after every check succeeds. On partial upgrade it is deliberately non-expiring for practical purposes, so lifecycle operations cannot resume automatically against mixed helpers/dependencies; do not delete it until the old files are restored or a complete reviewed rollout is proven.
3. Deploy AWS infrastructure with the reviewed non-instance bridge or replacement path. The metadata custom resource initializes `protocol#dual-v1` before the lifecycle Lambda update. The old Worker remains compatible because the rollout preserves `/minecraft/server-action` and `/minecraft/server-action-delete-claim/*`.
4. Persist `InstanceId`, `LifecycleLockTableName`, and `OperationStateTableName` before any Worker deploy. Fresh setup and host replacement do this automatically. For an existing bridge, run `pnpm migrate:existing -- --region "$MC_AWS_REGION" --stage sync-worker-env --execute --confirm-stack-id "$STACK_ID" --env-file .env.production`, then `pnpm bootstrap:check -- --env-file .env.production`. The table names become validated Wrangler plain-text variables, not Worker secrets; the bootstrap digest is deploy provenance only.
5. Run Worker environment validation, deploy the Worker, and verify one lifecycle action plus operation polling before reopening mutations.

For rollback, restore the previous Worker version first, while the SSM compatibility lock and its IAM permissions still exist. Quiesce and drain lifecycle deliveries before a reviewed Lambda/CDK rollback; do not apply an old template that deletes bridge metadata, retained lifecycle state, operation state, or SSM compatibility paths while current deliveries can still run. Recovery refuses to report success while either lifecycle lock remains active or malformed.

Paper, rclone, mcstatus, and the AL2023 image never refresh during a routine deployment. Follow [Reviewed Bootstrap and OS Upgrades](BOOTSTRAP_UPGRADES.md) for checksum-verified artifact changes and the intentional OS security-maintenance path.

## Real-environment smoke configuration

The manual **Real-Environment Smoke Verification** workflow uses the protected `real-environment-smoke` GitHub Environment. Configure `SMOKE_BASE_URL` and `SMOKE_SESSION_COOKIE` as environment secrets. Configure `SMOKE_EXPECT_DOMAIN` as an environment variable containing the exact Minecraft DNS hostname, without a scheme or path; an explicit workflow input can override it for a single run. `SMOKE_EXPECT_BACKEND_MODE` and `SMOKE_REQUEST_TIMEOUT_MS` are optional environment variables.

The required S4 check forces an authenticated status snapshot write, then requires the next read to return the same opaque response-header probe from snapshot metadata. When the server is running and the status response exposes its domain, S4 requires an exact `SMOKE_EXPECT_DOMAIN` match. A non-running status intentionally omits the domain, allowing smoke verification without starting a stopped server; the deployment preflight still validates the configured domain. The probe and infrastructure identifiers are never written to the summary. Each request has a bounded timeout, and failures still produce the fixed redacted summary artifact.

## Operation record cleanup

Current operation records live in the DynamoDB operation-state table and are eligible for deletion 30 days after their last update by default. DynamoDB TTL is eventual; the operator cleanup scans the exact table and conditionally deletes only the version/timestamp it reviewed. Always preview first:

```bash
pnpm operations:cleanup -- --dry-run
pnpm operations:cleanup
```

The command requires `MC_OPERATION_STATE_TABLE_NAME` and a local operator identity with table-scoped `dynamodb:Scan` and `dynamodb:DeleteItem`; these permissions are intentionally not granted to the Worker. Use `--retention-days=<days>` or `MC_OPERATION_STATE_RETENTION_DAYS` to change the cutoff and `--max-deletions=<count>` to bound one run.

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
