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

The teardown backup check reads `/minecraft/backups-cache`. That cached list may be stale and is not live proof of Drive contents. More importantly, the script deletes the Cloudflare Worker and its secrets, then removes the Worker runtime AWS keys, **before** it reaches this backup-cache check. If the cache check stops execution, panel and Worker credentials are already gone. Verify Drive first and rerun the same command after fixing the reported problem.

## Choose how to preserve server data

Choose before execution.

### Default: Drive only

`pnpm destroy:execute` requires a non-empty cached backup list with a valid cache timestamp. It creates no EBS snapshot. The root volume is normally deleted with the stack. Drive archives are left alone.

This mode depends on your direct Drive check; the cached list is only an old application observation. If the instance is already hibernated, there is no root volume to snapshot and the same cache check is required.

### Retain an EBS snapshot

```bash
pnpm destroy:execute:snapshot
```

When a managed root volume exists, this mode stops the server, creates a tagged final snapshot, waits for completion, and leaves the snapshot in AWS. The snapshot keeps incurring storage charges until you remove it. If no root volume exists, it falls back to the Drive-cache check.

The original CloudFormation root volume normally deletes with the stack. Any root volume created by a successful or failed resume can exist outside CloudFormation and survive stack deletion. The script never deletes snapshots or extra EBS volumes. Check every reported and tagged volume after teardown, even after CloudFormation is gone, and remove one manually only after confirming it is no longer needed.

## Run safely

### 1. Inventory

**Action**

```bash
pnpm destroy
```

**Expected result:** live AWS and Cloudflare inventory, planned deletes/restores, preserved resources, storage that may keep billing, and no changes.

**Stop when:** any account, region, ID, tag, route, DNS, Worker, KV, IAM, or stack check is wrong or cannot be read.

**Recovery:** correct credentials or region, recover the deployment record from a trusted backup, or review the uncertain resource manually. Do not delete by name alone.

### 2. Execute

**Action**

```bash
pnpm destroy:execute
```

Type the exact account-, region-, and stack-specific phrase printed by the script.

**Expected result:** the script removes project-created Worker routes, Worker, KV, panel DNS, DLM policies, Worker runtime keys, and the exact CloudFormation stack. Unchanged pre-existing routes or panel DNS are restored. If a pre-existing route or DNS record changed after setup, teardown preserves its current value and may not restore the old value while other teardown steps continue. It stops Minecraft and EC2 before deleting the stack when needed. Minecraft DNS, DuckDNS, Drive files, pre-existing Cloudflare resources, retained SES resources, and account-wide SES rule sets are not deleted.

**Stop when:** any identity changes, a provider call fails, Minecraft cannot stop, EC2 does not stop, backup conditions are not met, or final inventory reports remaining resources that should have been removed.

**Recovery:** do not switch to broad deletion. Fix the reported issue and rerun `pnpm destroy:execute`; completed steps can be checked again safely. A partial run may already have removed the panel and Worker credentials. Use provider consoles for diagnosis. Manually remove a remaining resource only after matching its exact ID, account, tags, and recorded pre-existing state.

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

- Confirm the exact CloudFormation stack, EC2 instance, Worker, project-created routes/KV/panel DNS, DLM policies, and Worker runtime IAM user are gone.
- Review all EBS volumes and snapshots. Retained storage may keep billing.
- Confirm the project SES receipt rule is gone; do not remove an account-wide or pre-existing rule set without separate review.
- Check AWS Billing/Cost Explorer and Cloudflare usage again after provider data catches up.
- Revoke user-managed Google OAuth, Cloudflare deployment/DNS, DuckDNS, and local AWS credentials only if they are not used elsewhere. Decide separately whether to retain Drive backups.
