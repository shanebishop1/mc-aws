# Google Drive Backup Setup

Google Drive is used for backup and restore.

If this is not configured, do not rely on backup, restore, or hibernate.

## How It Works

- The EC2 instance uses `rclone` for Google Drive access.
- The web panel can start a Google Drive OAuth setup flow.
- The token is stored in SSM as `/minecraft/gdrive-token`.
- Backups are uploaded under `GDRIVE_REMOTE:GDRIVE_ROOT`.

## During Setup

The setup wizard asks for:

- `GDRIVE_REMOTE`, usually `gdrive`
- `GDRIVE_ROOT`, for example `mc-backups`

These values choose the destination path. They do not complete OAuth by themselves.

## After Deployment

1. Open the web panel.
2. Sign in as the admin user.
3. Use the Google Drive setup prompt or backup section to connect Drive.
4. Confirm the panel reports Google Drive as configured.
5. Create a test backup before using hibernate.

## Notes

- Your Google OAuth client must include `/api/gdrive/callback` as an authorized redirect URI.
- Hibernation backs up before deleting attached instance volumes.
- Test backup and restore before treating the server as durable.
- Use a dedicated Drive folder so backups are easy to find and clean up.
