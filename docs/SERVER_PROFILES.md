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

`profile:init` copies `config/` to `server-profile/` and refuses to overwrite an existing directory. The only implicit roots are
the repository's `config/` and `server-profile/` directories. An external profile requires both `MC_SERVER_PROFILE_DIR` and
`MC_SERVER_PROFILE_APPROVED_EXTERNAL_PATH`, with the selected profile resolving to that approved real directory or one of its
real subdirectories. The approved tree from that trust root through the selected profile must be owned by the operator or root
and must not be group/world writable. Unrelated ancestors above the approved root are not part of the trust decision, so a
sticky temporary parent such as `/tmp` is safe. A pointer to an arbitrary worktree, filesystem root, symlink escape, or
unapproved external directory is refused.

Validation checks entry types, links, ownership boundaries, allowlisted Minecraft paths/extensions, file and directory counts,
size limits, credential/mock-state names, secret-like text, player-list JSON, and plugin entries. It rejects `.agents`, `.git`,
`.local-artifacts`, dotenv files, credentials, mock state, JAR files, and `rclone.conf`. The same exclusion scanner is run over the
actual CDK staging tree before the asset is created. Review every selected file yourself; this is a bounded pre-packaging scanner,
not a substitute for a full secret-management review.

The allowed root files are the standard server/player-list files (`server.properties`, `whitelist.json`, `ops.json`, ban lists,
`eula.txt`, server icon, and the supported Paper/Bukkit configuration files). Nested files may only be under `config/`,
`plugins/`, `datapacks/`, `resourcepacks/`, or `world*/datapacks/` and must use a Minecraft configuration/data extension such as `.json`, `.yml`,
`.properties`, `.toml`, `.mcfunction`, `.mcmeta`, `.png`, or `.txt`. Do not put archives, executable files, or plugin JARs in a
profile; plugin JARs are downloaded separately from the exact HTTPS URL and SHA-256 entries in `plugins.lock.json`.
The tracked `config/bootstrap-pins.json` and `config/mise-pins.json` controls are scanned but intentionally omitted from the
profile asset.

The generated/default profile requires a present, non-empty `whitelist.json`. `MC_ALLOW_EMPTY_WHITELIST=true` is intended for synthesis or an intentionally inaccessible server; it does not turn off Minecraft's whitelist settings. A custom profile validates its whitelist only when the file is present, so omitting it can leave a newly provisioned server inaccessible even when validation succeeds.

## How profiles are applied

Profile files are copied to the same relative paths under `/opt/minecraft/server`. Existing files at those paths are overwritten. Files and directories not declared by the profile are not deleted. The root `plugins.lock.json` manifest and `rclone.conf` are not copied into the server directory.

Each plugin entry records its name, destination, canonical HTTPS provenance URL, and exact SHA-256 digest. It downloads one JAR,
checks that digest, and overwrites only its declared `plugins/<destination>`. The CDK profile manifest repeats this provenance;
the profile archive itself never contains a JAR. Old profile files and old plugin JARs that are no longer declared are not
removed automatically.

The agent's generic workspace write/delete/download tools cannot replace `paper.jar`, plugin JARs, startup scripts, native
libraries, or systemd/profile/runtime executable assets. These are immutable-denied using exact canonical, case-sensitive
paths, so names such as `paper.jar.bak`, `Plugins/example.jar`, `plugins/example.JAR`, or `plugins/../paper.jar` do not
silently match. Changes to those assets must use the separately reviewed root-owned rollout/profile path with artifact
provenance, exact digest and size verification, a successful backup, an active maintenance fence, and explicit operator
approval; a normal agent approval cannot grant this exception.

| Event | Profile applied? |
| --- | --- |
| Fresh instance provisioning | Yes |
| Successful Drive restore | Yes, against the staged server tree before atomic installation |
| Service restart, repository update, or local profile edit | No |

Profiles apply only during fresh provisioning and restore. Restore first drains and masks every agent/Minecraft activation
path, applies profile and checksum-pinned plugin bytes to the staged server tree, validates it, and atomically installs the
whole tree. Restore profile staging is server-tree-only: it does not replace `/opt/setup`, host helpers, systemd units,
agent credentials/configs, or active runtime links while preparing the candidate. The previous directory is available
for rollback only before the authenticated restore-generation commit.
After commit, Minecraft readiness is retried against the committed generation and it is never automatically replaced by
the old tree. Keep a separate Drive backup.

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

Names and destinations must be unique safe basenames. URLs must be canonical HTTPS without credentials, query strings, or fragments,
and their paths must end in `.jar`. Checksums must be 64 lowercase hexadecimal characters.
