# Safe Teardown

Teardown acts only on resources recorded for this deployment. If an account, ID, ownership tag, or expected configuration does not match, it skips that resource or stops the run. Changed pre-existing Cloudflare routes and DNS records are preserved.

Stack ownership is proven by both the manifest claim token and the exact `McAwsClaimToken` tag on the live stack. A
different or missing token blocks adoption or destructive teardown. DNS credentials and `/minecraft/dns-mode` are treated
the same way: teardown inventories exact manifest-claimed parameters, but preserves SSM values for manual review rather
than deleting them automatically.

Setup creates `.mc-aws-deployment.json`, a local file excluded from Git. It records exact resource IDs and whether setup created or reused each resource. Keep it with `.env.production` until cloud deletion and billing checks finish. Do not copy it from another deployment or edit it to claim a resource.

## Before execution

**Verify Google Drive before teardown. The script's cached backup list is not proof that your archives are present or restorable.**

The default teardown also preserves an authenticated recovery capsule outside Drive: the exact SSM records for the
stable backup server identity, generation checkpoint, restore floor, SecureString keyring, verifier metadata, and
account-scoped adoption lock. The checkpoint/floor
values and key IDs remain authenticated by the keyring; the deployment manifest records only non-secret verifier
metadata. This capsule is required to restore old signed archives after a replacement stack.

1. Use the same AWS account and region used for deployment.
2. Sign Wrangler into the recorded Cloudflare account. Custom-hostname teardown also needs Cloudflare zone DNS and Worker route read/edit access through `CLOUDFLARE_TEARDOWN_API_TOKEN` or the panel DNS token.
3. Open Google Drive and verify the expected archives directly. Preferably complete a restore test.
4. Review tagged EBS volumes and snapshots, including storage left by a failed resume.
5. Keep local environment files until final verification.

Execute mode requires a StackId-specific typed confirmation that you checked the expected archive directly in Drive. For an attached root, teardown then creates its own operation-bound authenticated final Drive backup after establishing the destroy barrier and authoritative idle. An already-hibernated host with no attached root must instead have an exact operation-table transaction that binds the managed volume and terminal quiescence evidence to the authenticated server/archive identity, digest, byte size, generation, and creation time. The ordinary `/minecraft/backups-cache` list is never accepted as teardown durability proof. These gates complete before deleting Cloudflare resources, DLM policies, or runtime IAM keys.

## Destroy lifecycle barrier

After inventory and all typed confirmations—but before stopping an agent, Minecraft, or EC2, and before any backup or snapshot—execute mode takes a process lock adjacent to the selected manifest and acquires the exact stack's global `dual-v1` lifecycle record as action `destroy`. The process lock rejects concurrent teardown commands using that manifest. The manifest durably records the destroy operation ID, lock ID, fencing token, phase, and preservation boundary. The DynamoDB owner is mirrored to `/minecraft/server-action`, carries `agentFenceActive=true`, and is renewed during long operations. It is deliberately not expiry-takeover eligible.

While this owner exists, new panel/email/scheduled lifecycle work, restore, backup, start/resume, runtime rollout, and agent backup/fence acquisition conflict with the same global lock. Delayed Lambda deliveries must revalidate their original lock ID and fencing token and therefore cannot dispatch. Teardown stops the agent gateway, takes the shared host operation flock, and asks the root-only `mc-host-operation.py` helper to validate executor journal contract schema 3, every manifest/checkpoint/append/floor HMAC, and the newest monotonic generation before stopping the executor socket/service. A missing sidecar, malformed or invalid-MAC record, replay below the authenticated floor, `in-progress` effect, or indeterminate terminal, an occupied host operation lock, or a lifecycle owner blocks preservation instead of killing and retrying an uncertain effect.

The barrier remains authoritative through final backup/snapshot, Worker route and Worker removal, runtime IAM key revocation, and the CloudFormation delete request. CloudFormation may remove the lifecycle table during stack deletion only after Worker ingress and credentials are gone. Teardown preserves its SSM bridge and all other SSM records for manual review. No failure path automatically releases a destroy owner.

## Choose how to preserve server data

Choose before execution.

### Default: Drive only

`pnpm destroy:execute` requires the exact direct-Drive confirmation. With an attached root it creates one deterministic `final-destroy-<operation>.tar.gz` plus authenticated manifest under the durable destroy operation, then stops Minecraft and EC2. Retries recover that exact backup journal/target and do not create a second final backup. It creates no EBS snapshot. The root volume is normally deleted with the stack and Drive archives are left alone.

If the instance is already hibernated, there is no running host on which to create a new archive and no attached root volume to snapshot. Teardown therefore requires the exact durable terminal hibernation transaction plus direct Drive verification. Missing, malformed, differently bound, or cache-only evidence blocks deletion.

### Retain an EBS snapshot

```bash
pnpm destroy:execute:snapshot
```

When a running managed root volume exists, this mode first establishes agent/host-operation idle under the destroy barrier, stops Minecraft, removes only the reusable rclone credential and interrupted temporary credential files, verifies the scrub, stops EC2, creates a tagged final snapshot, waits for completion, and leaves the snapshot in AWS. Scrub failure blocks the snapshot. An already-stopped root requires durable scrub evidence from an interrupted teardown; the script will not boot it and risk server writes merely to scrub it. If no root volume exists, it requires the same exact terminal hibernation transaction used by Drive-only teardown.

The snapshot still contains the complete Minecraft world and server tree and may contain plugin credentials, logs, configuration secrets, player information, or other application data. Restrict snapshot/KMS/IAM access, do not share it publicly, and delete it when its reviewed retention period ends. The rclone scrub is deliberately narrow and is not a claim that the whole server image is secret-free.

The original CloudFormation root volume normally deletes with the stack. A detached reconstructed root is automatically deleted in Drive-only mode only when it is available, unattached, carries the exact project, stack, managed-root, and instance tags, and matches the volume bound into exact terminal hibernation evidence; deletion happens after that proof is recorded. Snapshot mode blocks on detached storage because it cannot scrub the filesystem offline. Tag-only, multiply matched, foreign-attached, or otherwise ambiguous volumes are preserved and block teardown. The script never deletes snapshots. Check every reported volume and snapshot after teardown.

## Run safely

### 1. Inventory

**Action**

```bash
pnpm destroy
```

**Expected result:** live AWS and Cloudflare inventory, every discovered `/minecraft` SSM parameter classified by data type and installation ownership, planned deletes/restores, preserved resources, storage that may keep billing, and no changes. Setup records whether exact names or controlled runtime namespaces were absent or existing before installation; exact native CloudFormation SSM resources provide additional ownership evidence. Familiar names alone never prove ownership. SSM inventory and exact ownership checks use metadata only. For a hibernated host, execute mode reads operation-state payloads only to validate exact terminal backup evidence and never prints those payloads.

**Stop when:** any account, region, ID, tag, route, DNS, Worker, KV, IAM, or stack check is wrong or cannot be read.

**Recovery:** correct credentials or region, recover the deployment record from a trusted backup, or review the uncertain resource manually. Do not delete by name alone.

### 2. Execute

**Action**

```bash
pnpm destroy:execute
```

Type the exact account-, region-, and stack-specific phrase printed by the script.

**Expected result:** the script acquires the fenced destroy owner, establishes authoritative runtime idle, preserves data, records the coherent authenticated recovery capsule, removes project-created Worker routes and Worker, then KV, panel DNS, DLM policies, Worker runtime keys, and the exact CloudFormation stack. After stack deletion succeeds, it re-inventories and preserves all `/minecraft` SSM state for manual review; no SSM parameter is deleted automatically. This also handles application-created state and failed custom-resource leftovers. Unchanged pre-existing routes or panel DNS are restored. If a pre-existing route or DNS record changed after setup, teardown preserves its current value and may not restore the old value while other teardown steps continue. Minecraft DNS, DuckDNS, Drive files, pre-existing Cloudflare resources, retained SES resources, and account-wide SES rule sets are not deleted.

The lifecycle lock table has `Delete` on stack deletion but `Retain` on replacement: upgrades keep the old rollback table, while normal teardown does not orphan lock owner data or on-demand-table billing. For an older deployed template whose deletion policy was also `Retain`, teardown records the exact table physical ID from the immutable stack, waits for stack absence, revalidates its project/stack/purpose tags and ARN, then deletes that one table. If those facts cannot be proven, it preserves the table and stops for manual review.

SSM inventory is name-by-name and requires both a strict familiar-name pattern and installation-ownership classification. The local deployment record preserves setup's pre-existing/absent observation; reruns cannot silently convert an observation. Current manifests without these facts are treated as unproven, except exact native `AWS::SSM::Parameter` resources resolved from the immutable StackId. Custom resources establish dependency but cannot prove that an overwritten parameter was originally created by this installation, so uncertain secure custom-resource parameters block stack deletion. The backup checkpoint, restore floor, server identity, keyring, verifier metadata, and adoption lock have exact capsule classifications; none is inferred from a similar name. Teardown does not delete SSM parameters, including the recovery capsule; exact-name consent is reported for manual review only. Pre-existing, unproven, and ownership-proven parameters remain available for an independently reviewed operator decision. Teardown never issues a path-wide delete.

For a pre-ownership-record installation, first back up `.mc-aws-deployment.json` and run the teardown dry run. Exact native stack resources are recognized automatically. Do not label runtime/custom-resource parameters as created from their names or values. Preserve them and audit CloudTrail/setup history separately. An unfamiliar parameter cannot be deleted through the script; inspect its creator and dependencies before any independently reviewed manual action. A future setup run records observations before its CDK mutation, but cannot reconstruct observations that were never captured historically.

Legacy `/minecraft/github-pat`, `/minecraft/github-user`, and `/minecraft/github-repo` are inventoried explicitly. Teardown checks live EC2 user data and blocks while it references them. After migrating bootstrap dependencies, review these credentials manually and revoke the PAT in GitHub; retaining or removing Parameter Store does not revoke the token.

### Exceptional Drive credential migration

Only when another reviewed migration still needs the encrypted Drive credential, run `scripts/operations/destroy.sh --execute --retain-gdrive-token-for-migration`. This flags `/minecraft/gdrive-token` for migration review; all SSM data remains preserved. The final report flags the credential as a security residual. Remove it only through a separately reviewed manual operation after migration. This option is not a backup-retention mechanism: Drive archives remain in Drive without retaining the credential.

If CloudFormation is already absent and the manifest has no completed preservation stage plus Drive/snapshot evidence, normal teardown blocks. After directly checking Drive archives or an exact retained snapshot, `--confirm-absent-stack-data` enables execution and requires a second StackId-specific phrase. This exception acknowledges external proof; it never infers that stack deletion preserved data.

**Stop when:** any identity changes, a provider call fails, Minecraft cannot stop, EC2 does not stop, backup conditions are not met, or final inventory reports remaining resources that should have been removed.

**Recovery:** do not switch to broad deletion. Fix the reported issue and rerun the identical `pnpm destroy:execute` mode with the same manifest. A dead script reattaches only to that manifest's operation/lock/fencing identity. An unacknowledged DynamoDB acquisition is accepted only when a consistent read proves that exact identity, and an authoritative phase committed before a local-manifest write is reconciled forward without repeating the completed phase. Once `preserving` is durable, completed preservation is reused because the non-expiring barrier prevents later server mutation; a partial run may also have removed panel or Worker credentials. If journal validation fails, do not delete or edit the journal, sidecars, or key: restore the matching root-owned credential/runtime release and rerun the helper until schema 3, every HMAC, the monotonic generation, and idle status validate; otherwise retain the destroy barrier for manual reconciliation. The barrier remains fail-closed until stack deletion removes its table. Use provider consoles for diagnosis and manually remove a remaining resource only after matching its exact ID, account, tags, and recorded pre-existing state.

Before preservation starts only, an operator may abandon teardown with:

```bash
scripts/operations/destroy.sh --execute --safe-abort-destroy
```

This requires the ordinary stack confirmation plus the printed exact destroy-operation phrase. It conditionally releases only the manifest's lock ID, operation ID, and fencing token; the matching SSM bridge remains preserved for manual review. It is refused from authoritative phase `preserving` onward. A pre-preservation failure does not release automatically; use safe abort only after confirming no teardown process is still running and deciding how to restore any intentionally stopped agent units. Never manually delete `/minecraft/server-action` to bypass this check.

## Legacy deployment without a complete local record

Automated teardown is unavailable when `.mc-aws-deployment.json` is missing or incomplete. Do not copy or invent one.

1. Verify Drive archives and create a root-volume snapshot if one still exists.
2. Record the AWS account, region, full CloudFormation StackId, stack resources, EC2 instance, volumes, snapshots, DLM lifecycle policies, IAM user, and SES resources.
3. Inventory the exact Cloudflare Worker, routes, KV namespaces, and DNS records. Preserve anything that may have existed before this deployment.
4. Confirm any legacy SES rule set or activation resource has the intended retain policy before stack deletion.
5. Stop Minecraft cleanly and stop EC2.
6. Remove only Cloudflare resources, DLM policies, and runtime keys whose exact IDs and deployment history you can verify, then delete the exact CloudFormation stack by its full StackId.
7. Recheck EBS volumes, snapshots, DLM policies, IAM keys/users, SES, Cloudflare, and billing. Retained or resume-created storage may require separate deletion.

Have another operator review this inventory before deleting anything. If a resource's history is uncertain, preserve it and investigate instead of deleting by name.

## Cloud teardown plus local environment cleanup

```bash
pnpm destroy:cleanup-local
```

Despite its name, this command reruns the full cloud teardown and verification with execution enabled, then asks for a second confirmation before deleting only `.env`, `.env.local`, and `.env.production`. It keeps `.mc-aws-deployment.json`. Run it only while cloud credentials are still available.

## Final checks

- Confirm the exact CloudFormation stack, EC2 instance, Worker, project-created routes/KV/panel DNS, DLM policies, and Worker runtime IAM user are gone; review the retained `/minecraft` SSM parameters separately.
- Review all EBS volumes and snapshots. Retained storage may keep billing.
- Confirm the project SES receipt rule is gone; do not remove an account-wide or pre-existing rule set without separate review.
- Check AWS Billing/Cost Explorer and Cloudflare usage again after provider data catches up.
- Treat any explicitly retained Drive credential or unclassified SSM parameter as a residual security item, not a successful cleanup default.
- Revoke user-managed Google OAuth, Cloudflare deployment/DNS, DuckDNS, and local AWS credentials only if they are not used elsewhere. Decide separately whether to retain Drive backups.
