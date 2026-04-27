# Operations Guide

This guide covers normal use after setup.

## Web Panel

Use the web panel for routine operations:

- check status
- start the server
- stop the server
- resume from hibernation
- create backups
- restore backups
- manage allowed emails
- view costs

## Roles

- `ADMIN_EMAIL`: full access
- `ALLOWED_EMAILS`: can check status and start
- other signed-in users: status-only

## Start And Stop

Use `start` when the server has normal attached storage and just needs to boot.

Use `stop` when people are done for now but you expect to use the server again soon. The EC2 instance stops, but the EBS volume remains attached and still costs money.

## Hibernate And Resume

Use `hibernate` for longer idle periods.

Hibernate:

1. creates a backup
2. stops the instance
3. detaches and deletes attached instance volumes

Resume recreates storage using the instance's pinned source AMI metadata, then brings the server back online.

Do not use hibernate until you have created and verified a backup.

## Backups

Backups use Google Drive.

Before relying on backups:

1. Configure Google Drive from the panel.
2. Create a manual backup.
3. Confirm it appears in the backup list.
4. Run a restore test when you can tolerate downtime.

## CLI

The CLI calls the app API:

```bash
pnpm server:status
pnpm server:start
pnpm server:stop
pnpm server:backup
pnpm server:backups
pnpm server:restore -- <backup-name>
pnpm server:hibernate
pnpm server:resume
```

Default API base:

```text
http://localhost:3000/api
```

Override it:

```bash
API_BASE=https://panel.yourdomain.com/api pnpm server:status
```

## Manual Shell Access

Advanced access:

```bash
./bin/connect.sh
./bin/console.sh
```

Use the web panel first unless you specifically need shell or console access.

## Updating The App

```bash
pnpm deploy:cf
```

## Updating Infrastructure

Preview first:

```bash
pnpm cdk:diff
```

Deploy:

```bash
pnpm cdk:deploy
```

## Operation State Cleanup

Durable operation-state records in SSM use a 30-day retention window by default.

```bash
pnpm operations:cleanup
pnpm operations:cleanup -- --dry-run --retention-days=14
```

Override the default with:

```bash
MC_OPERATION_STATE_RETENTION_DAYS=14 pnpm operations:cleanup
```

## Troubleshooting

### Server will not start

- Check the panel status.
- Check whether the server is hibernated and needs `resume` instead of `start`.
- Check AWS credentials and region values.
- Check Lambda and SSM command logs in AWS.

### DNS does not update

- Check `CLOUDFLARE_DNS_API_TOKEN`.
- Check `CLOUDFLARE_ZONE_ID`.
- Check `CLOUDFLARE_RECORD_ID` if you supplied one.
- Confirm the token has DNS edit access for the correct zone.

### Google login fails

- Check `NEXT_PUBLIC_APP_URL`.
- Check Google OAuth callback URLs.
- Restart local dev after changing env values.

### Backup or restore fails

- Confirm Google Drive is configured in the panel.
- Confirm the backup list loads.
- Check the EC2 script logs.
- Do not hibernate until backup succeeds.
