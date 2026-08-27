# Google Drive Backups

Google Drive is optional, but backup, restore, and hibernate depend on it.

Drive authorization requests the full Google Drive scope, not access limited to the backup folder. Use a dedicated Google account without unrelated Drive files where practical.

Before deployment:

- enable Google Drive API in the Google OAuth client's project
- add the exact `/api/gdrive/callback` URL printed by setup
- if the External app is in Testing, add the admin as a test user

The wizard asks for a remote name, usually `gdrive`, and a backup folder. These values select a path; they do not authorize Drive.

After deployment:

1. Sign in to the panel as the admin.
2. Connect Google Drive.
3. Create a test backup.
4. Test restoring that backup and confirm the server data is correct.

Do not use hibernate until both backup and restore have been tested. Hibernate backs up and then deletes the project-managed root volume; an unverified backup is not a recovery plan.

Authorization stores a persistent refresh token together with the OAuth client secret in an encrypted SSM credential bundle. Treat that bundle as full access to the authorized account's Drive. When Drive is configured, a root-only rclone configuration exists on EC2 after boot and backup or restore operations. Do not copy either into shell commands or other files.

External apps in Testing can receive Drive refresh tokens that expire after seven days. Use an appropriate Google account and move the app to In production when durable unattended backups are required.

The migration bridge does not install Drive helpers on an older EC2 instance. There is no supported in-place Drive rollout for such an instance. Preserve its data, complete the [Existing Deployment Migration](../EXISTING_DEPLOYMENT_MIGRATION.md), and plan a reviewed replacement under the current stack before connecting Drive. Do not copy tokens manually.
