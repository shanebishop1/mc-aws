# Safe Teardown

Teardown acts only on resources recorded for this deployment. If an account, ID, ownership tag, or expected configuration does not match, it skips that resource or stops the run. Changed pre-existing Cloudflare routes and DNS records are preserved.

Setup creates `.mc-aws-deployment.json`, a local file excluded from Git. It records exact resource IDs and whether setup created or reused each resource. Keep it with `.env.production` until cloud deletion and billing checks finish. Do not copy it from another deployment or edit it to claim a resource.

## Before execution

**Verify Google Drive before teardown. The script's cached backup list is not proof that your archives are present or restorable.**

1. Use the same AWS account and region used for deployment.
2. Sign Wrangler into the recorded Cloudflare account. Custom-hostname teardown also needs Cloudflare zone DNS and Worker route read/edit access through `CLOUDFLARE_TEARDOWN_API_TOKEN` or the panel DNS token.
3. Open Google Drive and verify the expected archives directly. Preferably complete a restore test.
4. Review tagged EBS volumes and snapshots, including storage left by a failed resume.
5. Keep local environment files until final verification.

The teardown backup check reads `/minecraft/backups-cache`, but accepts it only when the application refreshed it within the preceding 24 hours (with five minutes of future clock skew). A non-empty fresh cache is still not live proof of Drive contents. Execute mode therefore also requires a StackId-specific typed confirmation that you checked the expected archive directly in Drive. Execution completes both gates before deleting Cloudflare resources, DLM policies, or runtime IAM keys. If either gate fails, those irreversible cleanup steps do not begin; refresh the list/check Drive and rerun the same command.

## Choose how to preserve server data

Choose before execution.

### Default: Drive only

`pnpm destroy:execute` requires a non-empty backup list refreshed in the last 24 hours and the additional exact direct-Drive confirmation. It creates no EBS snapshot. The root volume is normally deleted with the stack. Drive archives are left alone.

This mode depends on your direct Drive check; the cached list is only an old application observation. If the instance is already hibernated, there is no root volume to snapshot and the same cache check is required.

### Retain an EBS snapshot

```bash
pnpm destroy:execute:snapshot
```

When a running managed root volume exists, this mode stops Minecraft, removes only the reusable rclone credential and interrupted temporary credential files, verifies the scrub, stops EC2, creates a tagged final snapshot, waits for completion, and leaves the snapshot in AWS. Scrub failure blocks the snapshot. An already-stopped root requires durable scrub evidence from an interrupted teardown; the script will not boot it and risk server writes merely to scrub it. If no root volume exists, it falls back to the Drive-cache check.

The snapshot still contains the complete Minecraft world and server tree and may contain plugin credentials, logs, configuration secrets, player information, or other application data. Restrict snapshot/KMS/IAM access, do not share it publicly, and delete it when its reviewed retention period ends. The rclone scrub is deliberately narrow and is not a claim that the whole server image is secret-free.

The original CloudFormation root volume normally deletes with the stack. A detached reconstructed root is automatically deleted in Drive-only mode only when it is available, unattached, and carries the exact project, stack, managed-root, and instance tags; deletion happens after backup evidence. Snapshot mode blocks on detached storage because it cannot scrub the filesystem offline. Tag-only, multiply matched, foreign-attached, or otherwise ambiguous volumes are preserved and block teardown. The script never deletes snapshots. Check every reported volume and snapshot after teardown.

## Run safely

### 1. Inventory

**Action**

```bash
pnpm destroy
```

**Expected result:** live AWS and Cloudflare inventory, every discovered `/minecraft` SSM parameter classified by data type and installation ownership, planned deletes/restores, preserved resources, storage that may keep billing, and no changes. Setup records whether exact names or controlled runtime namespaces were absent or existing before installation; exact native CloudFormation SSM resources provide additional ownership evidence. Familiar names alone never prove ownership. Inventory and exact deletion checks use SSM metadata only. Execute mode reads the value of only `/minecraft/backups-cache` for the explicit Drive preservation gate and never prints parameter values.

**Stop when:** any account, region, ID, tag, route, DNS, Worker, KV, IAM, or stack check is wrong or cannot be read.

**Recovery:** correct credentials or region, recover the deployment record from a trusted backup, or review the uncertain resource manually. Do not delete by name alone.

### 2. Execute

**Action**

```bash
pnpm destroy:execute
```

Type the exact account-, region-, and stack-specific phrase printed by the script.

**Expected result:** the script removes project-created Worker routes, Worker, KV, panel DNS, DLM policies, Worker runtime keys, and the exact CloudFormation stack. After the data-preservation gate and stack deletion succeed, it deletes and verifies removal of each allowlisted project SSM credential, PII, and runtime-state parameter, including `/minecraft/gdrive-token`. This also handles application-created state and failed custom-resource leftovers. Unchanged pre-existing routes or panel DNS are restored. If a pre-existing route or DNS record changed after setup, teardown preserves its current value and may not restore the old value while other teardown steps continue. It stops Minecraft and EC2 before deleting the stack when needed. Minecraft DNS, DuckDNS, Drive files, pre-existing Cloudflare resources, retained SES resources, and account-wide SES rule sets are not deleted.

The lifecycle lock table has `Delete` on stack deletion but `Retain` on replacement: upgrades keep the old rollback table, while normal teardown does not orphan lock owner data or on-demand-table billing. For an older deployed template whose deletion policy was also `Retain`, teardown records the exact table physical ID from the immutable stack, waits for stack absence, revalidates its project/stack/purpose tags and ARN, then deletes that one table. If those facts cannot be proven, it preserves the table and stops for manual review.

SSM deletion is name-by-name and requires both a strict familiar-name pattern and installation ownership. The local deployment record preserves setup's pre-existing/absent observation; reruns cannot silently convert an observation. Current manifests without these facts are treated as unproven, except exact native `AWS::SSM::Parameter` resources resolved from the immutable StackId. Custom resources establish dependency but cannot prove that an overwritten parameter was originally created by this installation, so uncertain secure custom-resource parameters block stack deletion. Use repeatable `--consent-delete-ssm /minecraft/exact-name` only after reviewing that exact parameter and accepting deletion. Pre-existing/unproven parameters otherwise remain untouched. Teardown never issues a path-wide delete.

For a pre-ownership-record installation, first back up `.mc-aws-deployment.json` and run the teardown dry run. Exact native stack resources are recognized automatically. Do not label runtime/custom-resource parameters as created from their names or values. Preserve them, or audit CloudTrail/setup history and use exact-name consent for only the reviewed names. An unfamiliar parameter cannot be consented through the script; inspect its creator and dependencies, then use an independently reviewed exact `aws ssm delete-parameter --name ...` command if deletion is justified. A future setup run records observations before its CDK mutation, but cannot reconstruct observations that were never captured historically.

Legacy `/minecraft/github-pat`, `/minecraft/github-user`, and `/minecraft/github-repo` are inventoried explicitly. Teardown checks live EC2 user data and blocks while it references them. After migrating bootstrap dependencies, delete only installation-owned or explicitly consented exact parameters and revoke the PAT in GitHub; deleting Parameter Store does not revoke the token.

### Exceptional Drive credential migration

Only when another reviewed migration still needs the encrypted Drive credential, run `scripts/destroy.sh --execute --retain-gdrive-token-for-migration`. This retains `/minecraft/gdrive-token`; other ownership-proven SSM data is deleted while pre-existing or uncertain data remains preserved. The final report flags the credential as a security residual. Delete it immediately after migration. This option is not a backup-retention mechanism: Drive archives remain in Drive without retaining the credential.

If CloudFormation is already absent and the manifest has no completed preservation stage plus Drive/snapshot evidence, normal teardown blocks. After directly checking Drive archives or an exact retained snapshot, `--confirm-absent-stack-data` enables execution and requires a second StackId-specific phrase. This exception acknowledges external proof; it never infers that stack deletion preserved data.

**Stop when:** any identity changes, a provider call fails, Minecraft cannot stop, EC2 does not stop, backup conditions are not met, or final inventory reports remaining resources that should have been removed.

**Recovery:** do not switch to broad deletion. Fix the reported issue and rerun `pnpm destroy:execute`; completed steps can be checked again safely. Once the preservation gate succeeds, a later partial run may already have removed panel or Worker credentials. Use provider consoles for diagnosis. Manually remove a remaining resource only after matching its exact ID, account, tags, and recorded pre-existing state.

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

- Confirm the exact CloudFormation stack, EC2 instance, Worker, project-created routes/KV/panel DNS, DLM policies, Worker runtime IAM user, and allowlisted `/minecraft` SSM parameters are gone.
- Review all EBS volumes and snapshots. Retained storage may keep billing.
- Confirm the project SES receipt rule is gone; do not remove an account-wide or pre-existing rule set without separate review.
- Check AWS Billing/Cost Explorer and Cloudflare usage again after provider data catches up.
- Treat any explicitly retained Drive credential or unclassified SSM parameter as a residual security item, not a successful cleanup default.
- Revoke user-managed Google OAuth, Cloudflare deployment/DNS, DuckDNS, and local AWS credentials only if they are not used elsewhere. Decide separately whether to retain Drive backups.
