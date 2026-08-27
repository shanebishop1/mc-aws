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

Update the panel:

```bash
pnpm deploy:cf
```

Preview infrastructure changes, then deploy only after reviewing replacements and data impact:

```bash
pnpm cdk:diff
pnpm cdk:deploy
```

Older stacks may require [Legacy Stack Safety Bridge](EXISTING_DEPLOYMENT_MIGRATION.md) instead of a normal deployment.

## Operation record cleanup

Operation records under `/minecraft/operations` are eligible for deletion 30 days after their last recorded update by default, regardless of their last status. Automatic cleanup is best-effort and can leave old records when AWS calls fail. Always preview manual cleanup first:

```bash
pnpm operations:cleanup -- --dry-run
pnpm operations:cleanup
```

Use `--retention-days=<days>` or `MC_OPERATION_STATE_RETENTION_DAYS` to change the cutoff. A shorter value removes troubleshooting history sooner.

## Remove the deployment

Read [Safe Teardown](TEARDOWN.md), verify Drive directly, and run the dry run before deleting anything.

## Troubleshooting

- **Start fails:** check panel state. A hibernated server needs resume, not start. Check AWS region, Lambda logs, and SSM command results.
- **Resume fails:** inspect Lambda, cloud-init, SSM results, and tagged EBS volumes before retrying. Do not remove `/minecraft/resume-pending` unless no resume is running and you understand the failed step.
- **DNS fails:** check the selected DNS mode, token, zone, and hostname and confirm the token can edit the intended zone.
- **Google sign-in fails:** check the app URL and Google callback URL, then restart local development after environment changes.
- **Backup or restore fails:** check Drive configuration, EC2 script logs, service status, and Drive itself. The panel backup list is cached.
