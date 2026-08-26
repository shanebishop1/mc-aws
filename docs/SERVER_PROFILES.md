# Server Profiles

`mc-aws` application code stays canonical. Deployment-specific Minecraft configuration belongs in a narrow local server profile, not in a fork of the application.

## Create and select a profile

```bash
pnpm profile:init
pnpm profile:validate
```

`profile:init` copies the tracked generic `config/` defaults to ignored `server-profile/` and refuses to overwrite an existing directory. Before validation or deployment, replace the empty `whitelist.json` with at least one real Minecraft UUID/name entry. If `MC_SERVER_PROFILE_DIR` is unset or blank, the existing `server-profile/` is selected automatically; otherwise CDK uses tracked `config/`.

The tracked generic whitelist is deliberately empty and deployment fails closed so a fresh server is not launched with no authorized players. Automation that only synthesizes/tests infrastructure may explicitly set `MC_ALLOW_EMPTY_WHITELIST=true`; this does not weaken `enforce-whitelist` and produces an intentionally inaccessible game server if used for a deployment.

For independent private versioning, set `MC_SERVER_PROFILE_DIR` to an absolute path or a worktree-relative path such as `../mc-private/profiles/production`. The selected root must be a real, non-symlink profile subdirectory. It may be outside this application worktree; all profile contents still receive the same strict validation before CDK creates an asset.

A profile may contain `server.properties`, `whitelist.json`, `ops.json`, datapacks, plugin configuration, and similar server files. Validation recursively rejects links, special files, hard links, `.git`, `.env*`, credentials/private keys, `rclone.conf`, path escapes, excessive counts, and excessive sizes. `whitelist.json` and `ops.json` are schema-checked when present.

`rclone.conf` is never profile content. Google Drive credentials remain rematerialized from SSM by the existing root-owned helper at `/opt/setup/rclone/rclone.conf`.

## Plugins

Do not commit or asset plugin JARs; validation rejects them. Add exact downloads to `plugins.lock.json`:

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "ExamplePlugin",
      "destination": "ExamplePlugin.jar",
      "url": "https://plugins.example.com/releases/ExamplePlugin.jar",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Names and destination JAR basenames must be unique and traversal-free. URLs must be canonical HTTPS URLs without credentials, query strings, or fragments. SHA-256 values must be exact lowercase hex. Installation downloads each JAR to a temporary file, verifies its checksum, and then replaces only that declared destination.

## Deployment and precedence

CDK validates the selected profile before synthesis. It packages two separate content-addressed file assets: the trusted `infra/src/ec2` runtime (excluding `user_data.sh`) and the profile directory. A single standard SSM String parameter, `/minecraft/server-profile-manifest`, atomically names both exact S3 objects and SHA-256 digests of the actual staged ZIP bytes. The instance verifies each downloaded archive before extraction. The instance role can read only those two objects; the repository root and local env files are never assets.

Fresh provisioning downloads assets with the instance role, validates every archive path/type/count/size, atomically installs root-owned runtime and profile releases under `/opt/setup`, installs systemd units/scripts, applies profile files without `rsync --delete`, and checksum-installs plugins. EC2 does not clone or pull GitHub. Restarting `minecraft.service` does not reapply a profile.

A profile is applied on fresh provisioning or an intentional rebuild. A Google Drive restore replaces the server directory and therefore takes precedence afterward; no blind service restart overwrites restored data. A later explicit profile application would override only profile-declared paths and plugin destinations, never delete unrelated world/server files.

Existing-instance rollout is intentionally not automated yet because safely coordinating deployment, legacy user data, server downtime, and SSM execution requires a reviewed transition. `pnpm profile:rollout:check` validates the selected profile but performs no cloud mutation. Use a reviewed rebuild/restore transition; do not manually invoke a partial updater.
