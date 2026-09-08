# Reviewed Bootstrap, Existing-Host, and OS Upgrades

EC2 bootstrap inputs are immutable review boundaries. Routine setup and deploys validate the checked-in pins; they do not discover new Paper builds, Node/Pi releases, rclone releases, Python packages, or operating-system updates.

## Current reviewed artifacts

The machine-readable source of truth is [`config/bootstrap-pins.json`](../config/bootstrap-pins.json). As reviewed on 2026-09-02 it contains:

| Artifact | Exact pin | SHA-256 source |
| --- | --- | --- |
| Paper | Minecraft `1.21.11`, build `132`, `paper-1.21.11-132.jar` | [Paper Downloads Service build metadata](https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds/132) |
| rclone | `1.71.2`, Linux ARM64 zip | [rclone 1.71.2 SHA256SUMS](https://downloads.rclone.org/v1.71.2/SHA256SUMS) |
| Node | `22.19.0`, official Linux ARM64 tar.xz (`0b2d9f…b6bcc`) | [Node v22.19.0 SHASUMS256.txt](https://nodejs.org/dist/v22.19.0/SHASUMS256.txt) |
| Pi coding agent | npm `@earendil-works/pi-coding-agent@0.84.4`, MIT | Published package metadata and `npm-shrinkwrap.json`; recorded in `agent-runtime/dependency-inventory.json` |
| mcstatus | `12.0.2` wheel | [PyPI release JSON](https://pypi.org/pypi/mcstatus/12.0.2/json) |
| asyncio-dgram | `2.2.0` wheel | [PyPI release JSON](https://pypi.org/pypi/asyncio-dgram/2.2.0/json) |
| dnspython | `2.7.0` wheel | [PyPI release JSON](https://pypi.org/pypi/dnspython/2.7.0/json) |

Bootstrap downloads each exact URL and verifies its reviewed SHA-256 before installation. The Python wheels are installed with `--no-index --no-deps`; this prevents pip from resolving mutable transitive versions. `setup.sh` validates the exact `user_data.sh` bindings and the existing-host rollout helper's reviewed digest/manifest contract, then persists `MC_BOOTSTRAP_PINS_SHA256` in both reusable deployment env files. The content-addressed host release embeds the same complete pin manifest; bootstrap and existing-host rollout verify that embedded source before activation.

## Intentional artifact upgrade

Do not replace a version with `latest`, `current`, an API query performed during bootstrap, or a floating package requirement.

1. Choose exact versions/builds and review their upstream release/security notes.
2. Obtain the exact artifact URL and SHA-256 from the upstream checksum source in the table. For a new mcstatus release, review its dependency metadata and pin every required wheel independently.
3. Edit `config/bootstrap-pins.json`, including `reviewedAt`. Do not edit shell constants by hand.
4. Print the digest of the reviewed manifest (this changes nothing):

   ```bash
   pnpm bootstrap:review
   ```

5. Pass that exact digest to the upgrade command:

   ```bash
   pnpm bootstrap:upgrade -- --confirm <digest-printed-above>
   ```

   The command does not discover a newer release. It downloads every configured artifact, rejects any checksum mismatch, and only then synchronizes `user_data.sh` plus the rollout digest marker.
6. Run `pnpm bootstrap:check`, `pnpm test -- lib/bootstrap-pins.test.ts tests/user-data-script.test.ts`, and `bash -n infra/src/ec2/user_data.sh`. Review the manifest and shell diff together before deployment.

For a runtime change, also run the cloud-free package evidence under the reviewed toolchain:

```bash
mise exec node@22.19.0 -- pnpm agent-runtime:check
mise exec node@22.19.0 -- pnpm test -- tests/agent-runtime-package.test.ts tests/agent-runtime-services.test.ts
```

The package command bundles the two CLI entrypoints, emits the complete exact Pi shrinkwrap-derived dependency/license inventory, writes a member-checksummed manifest, builds a deterministic ZIP under `.local-artifacts/agent-runtime/`, and compares two independent builds. Its evidence includes the ZIP digest/size and the digest of `bundle-manifest.json`. No generated archive or Node binary belongs in Git. EC2 verifies the official Node checksum and the CDK content-addressed runtime archive before descriptor-safe extraction; it never runs npm/pnpm or install scripts.

Host operations use the same boundary. `build-host-release.mjs` creates one deterministic, content-addressed host ZIP containing the agent runtime ZIP plus every cooperating script, backup/restore authentication and checkpoint helper, world-root helper, unit/socket, config, and `host-operation-contract.json`. `release-manifest.json` records the exact destination, SHA-256, mode, and byte size of every member and embeds the complete canonical bootstrap pin manifest; `/var/lib/mc-aws/runtime-hashes.sha256` records those values again after installation. The SSM manifest publishes only this host release and the server profile. New-host bootstrap, profile reconciliation, and existing-host rollout reject schema, omitted, stale, size, or digest mismatches and never combine members from different releases.
7. Do **not** assume UserData reruns. Load `.env.production`, then inspect the live host:

   ```bash
   set -a; source .env.production; set +a
   pnpm host:upgrade -- plan --region "$AWS_REGION"
   ```

8. If the AMI and launch-time UserData are unchanged, preserve this order: build and review the local host release; prepare/review the existing-deployment non-instance bridge so CDK publishes that content-addressed ZIP; execute the reviewed bridge so its atomic SSM manifest and exact EC2 object permission identify the same ZIP; then immediately run `rollout-runtime` with the plan's exact IDs and pins **before enabling or publishing a Worker/panel release that relies on it**. The command conditionally acquires the canonical `dual-v1` lifecycle owner before publication checks or SSM activation and conditionally releases only its exact fencing token and lease generation. The rollout rebuilds the local reviewed host release and refuses activation unless the live manifest has the exact same release ZIP digest, ZIP size, and release-manifest digest/size. Before live release mutation, the host fsyncs durable maintenance intent, drains the gateway, proves authenticated executor idle, and masks/stops Minecraft, DNS, the executor socket/service, and gateway. Its content-addressed journal publishes exact service state before `active` and snapshots setup links, release destinations, configs, runtime links, profile/plugins, and world-root state. A boot generator masks all five activation paths after power loss; its recovery unit only reasserts the volatile fence. Reruns validate and retire a matching commit or idempotently roll precommit state back. Exact restoration starts only units recorded active and preserves enable/mask state; corrupt evidence retains the journal, durable intent, and masks. `--defer-services` is validation-only and writes no live destination; the journaled owner uses `--activate-quiesced`. Commit still requires bounded Minecraft, plugin, executor, socket, and gateway readiness. An in-place rollout requires the installed maintenance helper, generator, and recovery unit to match the reviewed release before creating the marker; a legacy host without that reboot guard must use the backup/snapshot replacement path so new UserData installs it, rather than accepting an unsafe first-install crash window. A Paper/Minecraft upgrade can rewrite world data; take and test a Drive backup first, and do not assume reinstalling an older jar reverses a world-format migration.

The same boot-time inhibition contract covers `restore`, `backup`, `hibernate`, and `destroy`. Their phase vocabularies
and exact managed-service inventory come from the packaged `host-operation-contract.json`, not duplicated shell lists.
Only a same-boot `restoring-services` phase permits activation; every other nonterminal phase remains masked after reboot.
Do not upgrade only a backup/restore script or helper in isolation: activate the complete reviewed host release so the
journal schema, maintenance helper, generator, world-root helper, units, and recovery behavior remain coherent.

Do not run `rollout-runtime` before the intended ZIP and manifest are published: an old-manifest/current-bundle mismatch is an intentional hard stop. Do not publish/enable the dependent Worker first, and do not manually substitute an S3 URI or edit the manifest. If infrastructure publication fails, no host activation is attempted. If host activation fails after publication, keep the Worker disabled, retain the maintenance lock, correct or roll back the reviewed infrastructure publication, and rerun only after the local ZIP and published manifest match exactly.
9. If the AMI or launch-time UserData changed, use the guarded stages below. A same-AMI UserData update is accepted only when the prepared CloudFormation change set identifies exactly one conditional UserData change on the exact EC2 instance; an AMI change must still prove explicit replacement. Never run ordinary `cdk:deploy` to bypass the guard.

## Intentional Amazon Linux security upgrade

`AL2023_ARM64_AMI_ID` is an exact region-specific AMI. Bootstrap deliberately does **not** run `dnf update`: doing so would mutate a reviewed image according to repository state at launch time and make two launches from the same deployment inputs differ. First boot validates and explicitly passes the immutable AL2023 `releasever` embedded in that AMI to DNF, disables weak dependencies, and records the installed package versions in `/var/lib/mc-aws/os-package-manifest.txt`.

Security maintenance is not disabled; it is applied by selecting and reviewing a newer AWS-published AL2023 image:

```bash
pnpm ami:upgrade -- upgrade --region <region> --confirm <reviewed-ami-id>
pnpm host:upgrade -- plan --region <region>
```

Review Amazon Linux security advisories and release notes first. Pinning changes local configuration only. The command resolves AWS's current ARM64 AL2023 parameter but persists it only after an exact confirmation.

## Backup-guarded replacement

An AMI or current UserData change replaces EC2 and its `DeleteOnTermination=true` root volume. **Wrong confirmations, an untested Drive restore, or deleting recovery artifacts can permanently lose world data.** The EBS snapshot adds regional snapshot-storage charges until explicitly deleted; replacement also incurs normal EC2/EBS/data-transfer costs.

1. Schedule downtime, stop new panel/email actions, test a Drive backup/restore, and preserve `.mc-aws-deployment.json`.
2. Run `host:upgrade plan`, then `prepare-replacement` with the exact printed StackId/instance ID. Prepare creates a durable replacement operation, atomically binds it to the canonical lifecycle fence, creates and re-reads a fresh exact Drive archive, drains the agent, persistently inhibits activation, stops EC2, creates and waits for an encrypted root snapshot, asks CDK to prepare (not execute) a change set, and rejects anything except the exact reviewed EC2 property transition and non-replacing dynamic references caused by that instance. Preparation journals `backup-requested`, `backup-verified`, `quiesce-requested`, `quiesced`, `stop-requested`, `old-host-safe`, `snapshot-requested`, `snapshot-complete`, `change-set-requested`, and `prepared` before/after their corresponding effects. Snapshot creation has an operation-stable client token, change-set creation has an operation-stable name, and `prepared` durably records the immutable change-set ARN and classification before local state can authorize execution. The process renews the fence every five minutes during SSM, EC2, snapshot, CDK, AMI, and health waits. Every renewal atomically advances the DynamoDB operation-state generation and then fsyncs the same generation locally. The old host remains drained, masked, and stopped after preparation; do not start it manually.
3. Review the immutable change-set ARN in CloudFormation. Execute only with all exact printed confirmations:

   ```bash
   pnpm host:upgrade -- execute-replacement \
     --confirm-stack-id <exact-stack-arn> \
     --confirm-instance-id <old-instance-id> \
     --confirm-snapshot-id <completed-snapshot-id> \
     --confirm-change-set-id <reviewed-change-set-arn> \
     --confirm-replacement 'REPLACE <old-instance-id> WITH <target-ami-id> FROM <snapshot-id>'
   ```

4. The executor revalidates backup/snapshot/change set, reconciles the exact operation owner and latest durable lease generation, exercises the standard guard's narrow reviewed bypass, and provisions a one-time signed replacement transfer authorization. Ordinary consumption retains the source offer's 24-hour freshness boundary. If replacement recovery exceeds it after the source is gone, `transfer-renew` authenticates the expired source offer with the target's retained/adopted root keyring, authenticates and consumes the target-bound delegated renewal envelope, preserves the exact source/server/account/operation/backup/floor lineage, and issues a fresh offer under the current retained key. Direct file/JSON renewal cannot extend an expired offer. The final authorization binds the durable replacement operation, old and new instance IDs, stable server/account identity, exact backup ID/generation, lifecycle fence issuance generation, and restore-floor anti-replay state; a renewal or proven-safe takeover can rebind that same source offer to its newly owned fence. It is consumed before extraction and can be republished by exact-operation recovery until the restore floor commits; an arbitrary new host, wrong operation/backup/account, stale fence/floor, or committed replay is rejected. If the exact requested generation and backup ID are already the authenticated restore floor, replacement convergence succeeds idempotently without re-extracting the archive; a conflicting or ahead floor fails closed. The workflow then sets `/minecraft/resume-pending`, replaces the host, restores the named Drive archive, verifies AMI/runtime hashes and readiness, and fsyncs the new instance and both DynamoDB table outputs before atomically terminalizing the operation and releasing its exact fence generation. Missing `/minecraft/resume-pending` during a commit retry is treated as an already-completed deletion, not a new failure.

If the process crashes, a rerun first reads the strongly consistent replacement operation. A local generation behind the same unexpired owner is advanced to the authoritative generation. A different unexpired owner remains fail-closed, except for the operation-deterministic takeover owner used to reconcile a response loss and repair the SSM compatibility mirror. Generic lifecycle acquisition can never steal an expired protected replacement owner. Before quiescence intent, an expired preparation rolls back. After durable `quiesce-requested`, recovery first stops and freshly re-reads the exact old instance when necessary; only a stopped, terminated, or absent disposition permits the dedicated transaction to rotate the protected lock and operation owner together. Physical stop is the fail-closed proof for crashes during drain/mask/stop checkpoints, and takeover records the completed safety evidence before continuation. A host that cannot be stopped and freshly proven safe still rejects the takeover transaction. If a host becomes active again after `old-host-safe` or `prepared`, the workflow clears only its exact local maintenance owner, durably invalidates the old backup evidence, terminalizes that replacement operation, and requires a completely fresh preparation; manually stopping it later cannot make the stale artifacts reusable. A long review delay with the host continuously safe is recoverable without trusting a stale generation: rerun the exact `execute-replacement` command above with its original snapshot/change-set confirmations. Never delete the operation record or edit the local generation.

If execution was interrupted after CloudFormation started, use the exact command printed by the failure. Before a replacement instance ID is known it has this form:

```bash
pnpm host:upgrade -- recover \
  --confirm-stack-id '<exact-stack-arn>' \
  --confirm-instance-id '<old-instance-id>' \
  --confirm-recovery 'RECOVER <operation-uuid> FOR <old-instance-id>'
```

After the replacement ID is known, use `--confirm-instance-id '<new-instance-id>' --confirm-recovery 'RESTORE <new-instance-id> FROM <backup.tar.gz>'`. Recovery continuously renews the reconciled/taken-over fence through CloudFormation convergence, instance startup, SSM availability, restore, AMI/runtime hash checks, health checks, and output persistence. If any post-check fails, the workflow stops the new instance and retains the resume marker, maintenance state, local recovery state, Drive backup, and billed snapshot. Do not deploy the Worker or delete anything. If the new AMI cannot work, restore the old AMI pin and prepare a new reviewed replacement, restoring the same Drive archive. CloudFormation rollback protects failed stack updates; the EBS snapshot is retained for manual AWS recovery/forensics and is not silently attached to a mismatched instance. Renewal stops only after a durable `committed` or `rolled-back` terminal phase; quiescence is released only after restore, runtime hashes, readiness, and output persistence all pass.

## Reproducibility limits

- The exact AMI and its explicit AL2023 `releasever` constrain bootstrap RPMs to AWS's matching repository snapshot. AWS still controls availability and the contents/metadata of that snapshot, and this project does not checksum every RPM. Eliminating that residual repository dependency requires a reviewed private RPM mirror with immutable metadata/package hashes or a pre-baked project AMI. Compare the recorded OS package manifest when diagnosing launch differences.
- HTTPS availability, certificate trust, AWS/Paper/rclone/PyPI retention, and EC2 regional capacity remain external dependencies. Checksums prevent substituted bytes from being installed; they cannot keep an upstream URL available.
- Paper may download Minecraft libraries/assets at first start. Those upstream runtime downloads are outside this bootstrap manifest.
- The agent runtime ZIP uses fixed metadata, sorted inputs, stored ZIP members, and a two-build byte comparison. The older profile/runtime ZIP builder is also sorted and fixed-time, but still depends on the reviewed local Python ZIP implementation.

## Agent runtime activation boundary

Drive archive authentication is a separate trust domain from the agent backup fence. Before infrastructure deployment,
the guarded deploy path creates or verifies `/minecraft/backup-auth-keyring` as an external SSM SecureString;
CloudFormation adopts only its reference and never receives or deletes its value. Runtime installation puts
`mc-backup-auth.py` at root-owned mode `0750`, and only root backup/restore execution fetches the keyring. Never place it
in UserData, profile/runtime content, `/opt/minecraft`, Minecraft/agent systemd credentials, Drive, logs, or deploy env
files. Rotation retains old material as verify-only. Instance/root-volume replacement recovers from the same SSM
parameter and stable `/minecraft/backup-server-identity`. Normal same-instance restores and replacement restores
authenticate against that stable identity; `source.instanceId` remains audited metadata rather than a permanent host
pin. A replacement must additionally consume the one-time signed transfer authorization described above. Decommission
retains the six-record authenticated recovery
capsule outside Drive by default (schema v3, including its retained adoption lock). A replacement/recovery setup must explicitly provide
`MC_BACKUP_RECOVERY_CAPSULE_FILE`; setup authenticates its MAC and imports the complete keyring, key IDs, server
identity, verifier metadata, checkpoint, and restore floor into SSM before recording adoption. The lock is claimed before the replacement lifecycle table exists. CDK verifies those exact
authoritative values without resetting newer monotonic state or creating a new keyring/identity. See provisioning,
rotation, escrow recovery, capsule adoption, and the legacy override in [Operations Guide](OPERATIONS_GUIDE.md#backups-and-restores).

The stack also retains `/minecraft/backup-generation-checkpoint` and `/minecraft/restore-generation-floor`. Their values
are public canonical HMAC documents (or the initial `UNINITIALIZED` sentinel), while root-volume mirrors live under
`/var/lib/mc-aws`. A non-destructive custom resource creates either parameter only when missing; stack updates and deletes
do not overwrite or remove runtime state. EC2 has exact get/put permissions only for these state parameters. Never reset
either parameter to `UNINITIALIZED`, copy it between stacks, or delete both replicas; one surviving authenticated replica
is required to heal loss safely and cross-server state is rejected.

The stack also retains `/minecraft/backup-transfer-authorization` as an `UNINITIALIZED` String. The guarded replacement
workflow writes a target-bound authorization there only after the replacement instance ID is known; root restore
consumes and deletes it before extraction. It is not a general restore bypass and is never copied between accounts.

Bootstrap installs immutable releases, a separate `mc-agent-gateway` account, a Minecraft-domain executor service running as `minecraft`, a root-created group-only `mc-agent-executor.socket`, and an Ed25519 gateway key pair. Keeping the executor in the Minecraft domain is intentional: it can edit the existing world and use the existing `screen` console without changing `/opt/minecraft/server` ownership. PID 1 owns the socket inode and its non-writable `/run/mc-agent` parent and passes the named descriptor to Node; the Minecraft UID cannot unlink or replace that endpoint. The socket remains available across executor `RestartSec=2s` restarts. The checked-in placeholder configuration does **not** enable the gateway service, and setup writes the Worker-side `MC_AGENT_RUNTIME_ENABLED=false` default. Before a later reviewed deployment, provision root-owned `0400` files for `/etc/mc-agent/runtime-bearer` and `/etc/mc-agent/provider-openrouter`, replace the `.invalid` control origin and reviewed-profile placeholders in `/etc/mc-agent/gateway.json`, then review `systemd-analyze security` and start the gateway unit. Enable the Worker only with the complete reviewed runtime identity, verifier, backup-fence signing key, catalog, and profile inventory. CDK derives only the Ed25519 public half into new-host UserData; the reviewed existing-host `rollout-runtime` path installs the same root-owned `0444` public key at `/etc/mc-agent/backup-fence-public.pem` transactionally. The executor sees that file read-only at `/config/backup-fence-public.pem`. It never receives the private half, AWS credentials, or backup-provider credentials. The profile's credential name must be in the exact `provider-*` allowlist and match a `LoadCredential` entry; runtime bearer, signing-key, and arbitrary credential names are rejected for providers. Gateway/provider secrets enter only the separate gateway process through `LoadCredential`; never put them in command arguments, logs, the executor config, or the runtime archive, and never use the runtime control bearer as a model API key.

To enable a host that was bootstrapped with the runtime disabled, keep the gateway credential source root-owned
`0700` with exactly `runtime-bearer` and the provider names in the reviewed gateway allowlist, then run the existing-host
rollout with `--enable-agent --gateway-credential-source <source-dir>`. Supply the reviewed backup-fence public key as
the protected `--backup-fence-public-source <file>`; the rollout verifies it without printing secret material. The
installer rejects missing or extra source members and starts the gateway only after the complete release, credentials,
and reconciled configs pass validation.

Restore adds a separate runtime-wide boundary. Its root-owned maintenance marker prevents new gateway leases, `SIGUSR1`
lets the current gateway run drain, and the authenticated executor journal must then report idle. Restore runtime-masks
and stops the gateway, executor socket, executor, and Minecraft before changing profile or server bytes. It releases those
masks only after the authenticated restore floor and committed journal are durable; protocol readiness therefore cannot
precede commit, and committed recovery never selects the prior directory.

The executor is rooted in `/opt/mc-agent/executor-root`, sees the live world only at `/workspace`, has only explicit read-only runtime/toolchain binds, accepts only Ed25519-authenticated requests from the inherited root-created Unix socket, receives no gateway/provider/cloud credentials, and has `IPAddressDeny=any`. Sharing the `minecraft` UID means the executor is intentionally inside the Minecraft trust domain rather than protected from the server by a separate DAC account; the root-owned socket parent, private user/mount namespace, no-new-privileges/capability restrictions, signed protocol, authenticated journal, and separate gateway account remain the security boundaries.

The executor credential boundary is explicit and complete. The installer provisions the journal HMAC at
`/etc/mc-agent/executor-journal-hmac.key`, the terminal receipt private key at
`/etc/mc-agent/executor-receipt-private.pem`, and the clean-start epoch, all owned by `root:root` with mode `0400`.
The backup-fence authority is represented by the root-owned `0444` public key at
`/etc/mc-agent/backup-fence-public.pem`; when enabling an existing host it must match the reviewed authority supplied
as a protected source. PID 1 exposes only the three private credentials through exact `LoadCredential` entries and
bind-mounts the public verifier read-only. Missing, extra, malformed, or incorrectly owned credentials fail closed
before service validation. None is an environment value, protocol field, runtime archive member, or Minecraft mount.
The Minecraft unit has its own user/mount namespace, `ProtectProc=ptraceable`, `ProcSubset=pid`, no capabilities, and
explicit inaccessibility for `/etc/mc-agent`, `/run/credentials`, the executor StateDirectory, and executor root.
The executor retains `ProtectProc=invisible` and `ProcSubset=pid`. These controls prevent a same-host-UID plugin from
using `/proc/<pid>/{root,environ,mem}` or service paths to obtain the credentials; killing the executor remains an
availability attack.

### Executor journal authentication, rollback, and key recovery

Executor journal schema version 3 authenticates every entry, tombstone, complete append transaction, alternating checkpoint, current
manifest, and monotonic generation floor with domain-separated canonical HMAC-SHA-256. The main configured path is the
small manifest; deterministic `.checkpoint.0/.checkpoint.1`, `.append.0/.append.1`, and `.generation-floor` sidecars
remain in the same executor StateDirectory. The authenticated fields include exact task/lease/invocation and result
bindings, execution behavior and approval/authorization fingerprints, statuses, timestamps, publication
acknowledgements, cancellation tombstones, and constant-size folded terminal evidence. Each append generation is one
authenticated transaction whose complete ordered mutation set validates before any mutation is applied. Compaction
publishes folded evidence and deletion together through one atomic checkpoint, so no torn append can expose only the
deletion. Temporary-file sync, atomic rename, and directory sync make each slot switch crash-safe. Startup requires the manifest-selected checkpoint and
append sidecars, validates every available slot and append transaction generation, and selects only the newest valid generation at
or above the authenticated floor, including recovery at every partial compaction stage. An incomplete final append frame
is ignored wholly, then the selected append file is truncated and synced to its last complete authenticated byte boundary
before another append. Publication failure after any write or sync recovers the newest durable generation rather than
restoring an older in-memory generation. The protected gateway's sequence checkpoint can therefore classify any lower
recovered generation as indeterminate rather than making the verifier unavailable. Older inactive slots may be absent only before first rotation.
Unknown fields, a wrong key, malformed complete bytes, a replay below the floor, or any invalid MAC prevents the
executor from listening; HMAC authority never relies on ownership by the intentionally shared `minecraft` UID.

Before a required-backup effect can be dispatched, the protected gateway first persists `awaiting-executor`, obtains an
authenticated executor `reserved` entry for the exact request, records that reservation generation as the minimum expected
sequence, and only then durably enters `dispatching` before sending `execute`. `begin` durably changes the same entry from
`reserved` to `in-progress` before entering the host effect. That external checkpoint prevents replacement with a valid older
snapshot. A matching `reserved` entry is exact proof that the effect did not start, so restart may cancel it and redispatch
the same request under current authority. After `in-progress` may have been reached, a missing journal, a lower sequence,
an absent MAC/sequence, or `not-started` is indeterminate: the gateway never converts it to a no-effect result or releases
the lifecycle fence. A brand-new executor with no durable gateway handoff may initialize sequence zero and create its first
authenticated snapshot normally. `awaiting-executor` remains the explicit state before reservation.

The executor reserves enough of the 64-MiB and 100,000-entry limits before returning authenticated `reserved` state for a worst-case bounded
terminal or fallback record. It rejects before a host effect if that reservation cannot be guaranteed. Terminal entries
remain complete and replayable until the gateway has durably finalized any lifecycle fence, published the result, and
sent an Ed25519-authenticated acknowledgement bound to the exact task, lease generation, invocation ID/digest, terminal
journal sequence, and result digest. A lost acknowledgement response is an idempotent retry and retains the latest full
result. A later invocation may fold only acknowledged non-indeterminate terminals into one constant-size authenticated
aggregate containing the count, latest terminal sequence, digest chain, and fixed 1-MiB seven-hash replay filter;
schema v3 never stores an unbounded `claims` list. Active, waiting, unacknowledged, and indeterminate entries are never
compacted away. Append deltas avoid history-sized rewrites between those bounded checkpoints. Backup, restore, destroy,
and automatic idle shutdown all establish the lifecycle/maintenance fence and use the same root verifier before host
mutation or instance stop.

The installer is idempotent and never rotates an existing valid key. To rotate deliberately, first quiesce new agent
work, stop the gateway and executor, and prove that the protected gateway reconciliation journal is empty and that no
durable lifecycle operation has an active agent fence. Preserve an offline root-only copy of the matching journal and
old key for the reviewed recovery window, atomically install a newly generated 32-byte root-owned `0400` key, remove or
archive the old executor journal only after the no-handoff proof, then start and verify the executor before reopening
work. Never rotate merely to clear a startup authentication failure.

If the key or journal is lost, truncated, deleted, rolled back, or fails authentication while a gateway handoff/fence
exists, leave the gateway journal and lifecycle fence in place. Recover the exact matching key and authenticated journal
from root-only backup, or perform a manual host-effect and durable-operation reconciliation that explicitly resolves the
indeterminate effect before removing the handoff. Do not create an empty journal, forge a terminal result, delete the
gateway handoff, return `not-started`, or redispatch as recovery. Same-UID process termination does not weaken this rule.

`/etc/mc-agent/world-roots-generations/<digest>/world-roots.json` is the immutable root-owned source for persistent-world policy;
`/etc/mc-agent/world-roots-current` is the single atomic publication point. A new host derives it from
the applied profile's Java-properties `server.properties` `level-name` (including `=`, `:`, whitespace separators,
escapes, and continuations) and both dimension suffixes, defaulting to `world` only when that property is absent.
Malformed property escapes fail closed. Profile installs and in-place upgrades preserve valid custom roots, rewrite both runtime configs from
that same source, and verify exact equality and every member digest before any affected service starts. Conflicting pre-canonical gateway and
executor roots, malformed paths, duplicate roots, or a failed partial write abort and roll back rather than silently
accepting template defaults. To intentionally change a level name, quiesce agent work, atomically publish a complete reviewed generation with the canonical
JSON with schema version `1` and the complete reviewed root list, rerun the profile installer, and verify with
`sudo /usr/local/bin/mc-agent-world-roots.py verify` before starting services. Never edit only one runtime config.

Restore journals retain the exact pre-restore generation and canonical roots, plus the reviewed roots carried by the
backup. An unchanged level name keeps the complete reviewed allowlist; a transition replaces generated dimensions and
keeps only reviewed additions. Precommit rollback durably checkpoints the restored server directory and prior root
generation as one pair before restoring any service, and stale generation evidence remains inhibited across reboot.

`network.download` keeps the executor in `PrivateNetwork=true`: the executor presents a gateway-signed, one-use invocation capability over `/run/mc-agent-download/download.sock`, and the gateway performs a credential-less HTTPS GET. Every request, including non-executable data, requires operator-supplied `expectedSha256` and `expectedBytes`; a mutable URL, byte bound, or `Content-Length` is never sufficient. These values bind the invocation digest, approval scope, gateway grant, and executor authorization. Connection or response loss switches to a bounded, backoff-delayed, read-only reconciliation command carrying the exact execute payload; the executor reports its exact in-memory active state and bounded atomic StateDirectory journal result instead of issuing another GET. The relay validates every DNS answer, pins only validated public addresses while retaining the original TLS SNI and HTTP Host, permits redirects only when they retain the exact approved origin and pathname, rejects query strings, fragments, userinfo, encoded or dot-segment ambiguity, and cross-origin/private/rebound targets, bounds media type, encoding, declared and streamed bytes, redirects, and total time, and propagates cancellation. The executor streams the framed response into its descriptor-relative temporary file and atomically renames only after verifying a signed trailer that binds the final URL, exact byte count, and downloaded SHA-256 digest to the invocation and request fingerprint. Runtime/provider credentials are never relay headers, payloads, or executor inputs.

Executor cancellation is durable across the pre-registration race: the gateway checks an already-aborted signal before execute, the server exposes the invocation to cancellation before awaiting journal work, and bounded expiring StateDirectory tombstones prevent a cancelled invocation ID from starting during the transport/lease safety horizon. A tombstone is reclaimed after expiry or once a durable cancelled journal result replaces it. Saturation rejects current cancellation and execution requests until safe expiry instead of writing an unsafe cancellation or permanently disabling the executor across restart. The runtime enforces one in-flight invocation per task and the control plane records its exact proposal ID and digest on that task, preventing a stale proposal from another continuation from receiving the cancellation receipt. The Pi adapter uses the executor's finite reconciliation bound, and the gateway fences queued nonterminal publications while draining a later exact committed/indeterminate result through the digest-bound cancellation receipt before exit. Filesystem renames and successful Minecraft `screen` delivery return explicit committed metadata. Console cancellation is checked immediately before invoking `screen`; after invocation begins, exit zero is committed, while timeout or uncertain process/socket completion is journaled as indeterminate and terminalizes the harness without an automatic replacement invocation. Any future RCON bridge must preserve this same dispatch boundary.

The gateway systemd IP policy uses longest-prefix precedence to allow exactly the reviewed EC2 AmazonProvidedDNS resolver address `169.254.169.253/32`. The enclosing `169.254.0.0/16` remains denied and the metadata endpoint has the more-specific explicit denial `169.254.169.254/32` (plus the IPv6 metadata denial). This is static intended-policy evidence only; local validation must not probe either host address.

World-root configuration is published as an immutable generation under
`/etc/mc-agent/world-roots-generations/<sha256>/`. The root-owned
`/etc/mc-agent/world-roots-current` symlink is the only commit point; gateway and
executor both consume files below that one generation. The service `ExecStartPre`
verifier checks the manifest, all member digests, and exact three-way root equality,
so a missing, torn, or mismatched generation fails closed. The installed
`/usr/lib/tmpfiles.d/mc-agent.conf` recreates `/run/mc-agent` as `root:root 0755`
and `/run/mc-agent-download` as `mc-agent-gateway:mc-agent 0750` before socket or
gateway activation on every boot.

Required backups use runtime-bearer `POST /api/agent/runtime/backups`, not the admin backup route (which only returns asynchronous acceptance). The narrow route verifies the active lease and persisted invocation/digest request, durably creates the deterministic operation before touching the legacy bridge, and atomically binds one dispatch owner plus the global server-action lock to that operation. Duplicate callers attach to the pending owner. Cancellation is rechecked after ownership and before the agent-only Lambda dispatch; ambiguous lock, persistence, or response outcomes reconcile from the operation/owner binding and never dispatch twice. The agent-only backup never starts EC2 and requires Minecraft to stay active, and the gateway polls until durable success/failure.

Before backup dispatch, the gateway persists the complete exact-bound executor request as `awaiting-backup`. Success marks the exact lifecycle owner `agentFenceActive`, atomically stores its signed authorization as `awaiting-executor`, and makes the owner ineligible for expiry takeover until authoritative terminal reconciliation. The gateway obtains the exact executor `reserved` entry, checkpoints its generation, and persists `dispatching` before `execute`. The control plane renews its monotonically increasing lifecycle lease generation and signs a 60-second permit bound to the exact invocation and lock ID/token/generation. Renewal atomically advances the DynamoDB lifecycle lock and durable operation authorization; only an exact strongly consistent two-record identity match can reconcile a lost transaction response. The legacy SSM record is repaired forward afterward and cannot roll back durable authority. The gateway probes the executor journal and renews every 20 seconds while it reports reserved/active/pending. A restarted gateway reloads every handoff state from StateDirectory before accepting new work, recovers the exact control-plane backup operation even if the work lease has since expired, and redispatches only when current authority and an exact authenticated `reserved` entry prove the effect never started. The executor verifies `/etc/mc-agent/backup-fence-public.pem` on each generation and validates the current non-revoked permit again immediately before atomic rename or console dispatch.

JavaScript `AbortSignal` is cooperative and is not a filesystem syscall cancellation bound. Ownership loss prevents a not-yet-entered commit; an entered syscall remains covered by the non-takeover active lock. The executor's `RuntimeMaxSec=20min`, 30-second kill-on-stop policy, control-group SIGKILL, and 25-minute permit-to-lock margin keep normal hard-kill/restart semantics inside the lock horizon. A kernel-uninterruptible process retains the active lock rather than allowing a restore overlap; wall-clock expiry by itself never authorizes takeover. Finalization releases only the persisted lock ID, fencing token, and latest durable authorization generation after an authoritative terminal journal result. Indeterminate or renewal-loss state persists reconciliation-needed without release. The three-minute inactive-effect horizon applies only after restart reports no active process; active always wins. The durable handoff makes a terminated or proven-never-started effect automatically recoverable, while any effect that may still commit remains fenced. Mock/test mode follows the same handoff and generation behavior while remaining provider-free. Only a durable terminal backup execution failure can offer the exact proceed-without-backup-or-cancel decision. Missing configuration, unavailable prerequisites, lock conflicts, duplicate/in-progress operations, cancellation, and ambiguous control outcomes fail closed without that approval.

The ARM64 units, shared filesystem Unix socket behavior, `IPAddressDeny` enforcement, console bind, and actual TLS SNI/Host behavior still have only local static/unit evidence until a separately approved AL2023 host validation is performed. Do not claim host readiness or enable the checked-in placeholder units on that basis.

## Dependency locks and audits

Use `pnpm install --frozen-lockfile` at the repository root and `npm ci` in Lambda package directories. Commit package manifests and lockfiles together for reviewed dependency changes. CI installs the root lockfile without mutation and audits root and deployed Lambda production dependency locks. Run the same audit commands locally when changing dependencies:

```bash
pnpm audit --prod --audit-level high
npm --prefix infra/src/lambda/StartMinecraftServer audit --omit=dev --audit-level=high
```
