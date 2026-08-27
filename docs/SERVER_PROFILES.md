# Server Profiles

A profile supplies Minecraft settings, player lists, datapacks, plugin configuration, and other server files.

## Select and validate

Selection order:

1. A non-blank `MC_SERVER_PROFILE_DIR` path.
2. `server-profile/` when that directory exists.
3. Tracked `config/` defaults.

First generate the local `server-profile/` directory, which is excluded from Git:

```bash
pnpm profile:init
```

Then edit `server-profile/whitelist.json` to include at least one real UUID/name. A valid shape is:

```json
[
  { "uuid": "123e4567-e89b-42d3-a456-426614174000", "name": "PlayerName" }
]
```

Replace both fields with the intended player's real Minecraft UUID and name.

```bash
pnpm profile:validate
```

`profile:init` copies `config/` to `server-profile/` and refuses to overwrite an existing directory. An explicit profile can be inside or outside the worktree but must resolve to a real subdirectory, not a symlink or filesystem/worktree root.

Validation checks entry types, links, file counts and sizes, selected credential-like filenames and text patterns, player-list JSON, and plugin entries. It rejects JAR files and `rclone.conf`. **It is not a general secret scanner.** Review every selected file yourself; arbitrary tokens or sensitive data can pass its limited patterns.

The generated/default profile requires a present, non-empty `whitelist.json`. `MC_ALLOW_EMPTY_WHITELIST=true` is intended for synthesis or an intentionally inaccessible server; it does not turn off Minecraft's whitelist settings. A custom profile validates its whitelist only when the file is present, so omitting it can leave a newly provisioned server inaccessible even when validation succeeds.

## How profiles are applied

Profile files are copied to the same relative paths under `/opt/minecraft/server`. Existing files at those paths are overwritten. Files and directories not declared by the profile are not deleted. The root `plugins.lock.json` manifest and `rclone.conf` are not copied into the server directory.

Each plugin entry downloads one JAR, checks its SHA-256 value, and overwrites only its declared `plugins/<destination>`. Old profile files and old plugin JARs that are no longer declared are not removed automatically.

| Event | Profile applied? |
| --- | --- |
| Fresh instance provisioning | Yes |
| Successful Drive restore | Yes, before Minecraft starts |
| Service restart, repository update, or local profile edit | No |

Profiles apply only during fresh provisioning and after a successful restore. Restore keeps a local copy of the previous server directory and attempts to put it back if startup fails, but rollback can fail or the old copy can later be pruned. Keep a separate Drive backup.

## Plugins

Do not put JAR files in the profile. Use exact HTTPS downloads and checksums:

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "Example",
      "destination": "Example.jar",
      "url": "https://plugins.example.com/Example.jar",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Names and destinations must be unique safe basenames. URLs must be canonical HTTPS without credentials, query strings, or fragments. Checksums must be 64 lowercase hexadecimal characters.
