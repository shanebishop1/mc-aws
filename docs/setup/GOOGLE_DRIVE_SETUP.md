# Google Drive Backup Setup

Google Drive is used for backup and restore.

If this is not configured, do not rely on backup, restore, or hibernate.

## How It Works

- The EC2 instance uses `rclone` for Google Drive access.
- The web panel can start a Google Drive OAuth setup flow.
- The token is stored in SSM as `/minecraft/gdrive-token`.
- Drive operations materialize a root-only rclone config from SSM immediately before use, so OAuth may safely finish after EC2 bootstrap.
- Backups are uploaded under `GDRIVE_REMOTE:GDRIVE_ROOT`.

## During Setup

The setup wizard asks for:

- `GDRIVE_REMOTE`, usually `gdrive`
- `GDRIVE_ROOT`, for example `mc-backups`

These values choose the destination path. They do not complete OAuth by themselves.

Before connecting Drive, enable **Google Drive API** in the same Google Cloud project as `GOOGLE_CLIENT_ID`. If the External OAuth app is still in **Testing**, add the admin Google account under **Google Auth Platform -> Audience -> Test users**. Testing-mode Drive refresh tokens can expire after seven days, so use **In production** for durable unattended backups when appropriate.

The Drive consent requests full Drive access because restore must discover archives created by earlier rclone OAuth clients. The narrower `drive.file` scope cannot see those existing files without a Google Picker grant, which this app does not implement. Use a dedicated backup folder and a Google account appropriate for server backups.

## After Deployment

1. Open the web panel.
2. Sign in as the admin user.
3. Use the Google Drive setup prompt or backup section to connect Drive.
4. Confirm the panel reports Google Drive as configured.
5. Create a test backup before using hibernate.

## Existing Instance Rollout

Updating the stack's EC2 user data does not rerun bootstrap on an existing root volume. Before relying on post-bootstrap OAuth on an instance created by an older release:

1. Start the instance and connect with SSM Session Manager.
2. Confirm `/opt/setup` has pulled the release containing `infra/src/ec2/mc-rclone-config.sh`.
3. As root, copy `mc-rclone-config.sh`, `mc-backup.sh`, and `mc-restore.sh` from `/opt/setup/infra/src/ec2/` to `/usr/local/bin/` and set mode `0755`.
4. Write the deployed `GDRIVE_REMOTE` and `GDRIVE_ROOT` values, one line each, to `/etc/minecraft/gdrive-remote` and `/etc/minecraft/gdrive-root`; set both files to `root:root` mode `0644`.
5. Run `sudo /usr/local/bin/mc-rclone-config.sh` and then perform a test backup and list operation.

Do not copy the token into commands or files manually. The helper retrieves and decrypts it directly from SSM using the instance role. Reconstructed hibernation volumes run current user data and do not need this one-time rollout.

## Notes

- Your Google OAuth client must include `/api/gdrive/callback` as an authorized redirect URI.
- Hibernation backs up before deleting attached instance volumes.
- Test backup and restore before treating the server as durable.
- Use a dedicated Drive folder so backups are easy to find and clean up.
