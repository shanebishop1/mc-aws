# Ownership-Aware Teardown

Teardown is intentionally conservative. It inventories live AWS and Cloudflare resources, compares them with the ignored local ownership manifest, and refuses mutation when ownership or provider identity cannot be proved.

## Deployment Ownership Manifest

`setup.sh` and `scripts/deploy-cloudflare.sh` create and update `.mc-aws-deployment.json`. The file is ignored by Git, must be a current-user-owned regular file (never a symlink) with mode exactly `0600`, and contains identifiers and ownership facts—not credential or secret values. Unknown fields, malformed provider IDs, invalid ownership transitions, and insecure file metadata are rejected.

### Trust Boundary

The local OS user who can read this repository and holds the AWS/Cloudflare deletion credentials is trusted. Strict schema validation, mode/link checks, manifest digests, immutable provider IDs, live tags, and repeated provider reads prevent accidents, stale-state deletion, and same-name replacement mistakes. They do **not** defend against a malicious authorized operator who can both rewrite local state and use the same provider credentials directly.

Teardown intentionally does not add a second deployment receipt to project KV. Such a receipt would be mutable by the same trusted Cloudflare principal, would not improve this threat boundary, and could write teardown metadata into a user-supplied pre-existing KV namespace that must otherwise be preserved. The exact current Worker deployment ID, account ID, route/DNS/KV IDs, and created-versus-pre-existing facts are the intended provider evidence within the trusted-operator boundary.

It records:

- AWS account, region, CloudFormation stack ID, instance ID, and runtime IAM user
- whether the stack and runtime identity were created by this setup
- Cloudflare account, Worker name plus provider deployment ID, panel hosting mode, custom routes, panel DNS records, and runtime-state KV namespaces
- whether DNS, routes, and KV were project-created or pre-existing
- project-created DLM policies outside the stack, if a deployment flow records any
- the manifest-recorded pending snapshot attempt, plus a pointer to the newest completed final snapshot
- completed teardown stages for failure recovery

Keep the manifest until teardown and billing verification are complete. Do not copy another deployment's manifest or mark a resource as owned manually merely because its name looks familiar. Setup refuses to overwrite a same-name Worker unless its recorded provider deployment ID is still present, and refuses a same-name stack whose exact StackId differs.

## Automated Procedure

Prerequisites:

1. Authenticate the same local AWS account/profile used for deployment.
2. Authenticate Wrangler to the same Cloudflare account used for deployment.
3. For a custom panel hostname, provide a token with **Zone DNS Read/Edit** and **Workers Routes Read/Edit** for the panel zone. Set `CLOUDFLARE_TEARDOWN_API_TOKEN` in the shell or `.env.production`; the panel DNS token is used as a fallback.
4. Retain `.mc-aws-deployment.json` and `.env.production` until verification finishes.

Run the default dry run:

```bash
pnpm destroy
```

The dry run performs live reads but no Cloudflare/AWS mutations, manifest updates, or local-file deletion. Review every `PRESERVE`, retained backup, and blocker.

Execute verified teardown:

```bash
pnpm destroy:execute
```

The compatibility package aliases `pnpm cdk:destroy` and `pnpm cdk:destroy:force` also route to this ownership-aware script; teardown does not invoke `cdk destroy`.

Execution requires typing the exact account-, region-, and stack-specific phrase printed by the script. The script then:

1. removes project-created routes or restores the original target of a pre-existing route;
2. immediately revalidates the current deployment ID, then deletes only a project-created Worker in one Worker deletion operation (without creating intermediate secret-removal versions);
3. deletes only project-created KV namespaces;
4. deletes only project-created panel DNS or restores a recorded proxy-state change on pre-existing DNS;
5. deletes only manifest-owned DLM policies with matching live project/stack tags;
6. inactivates and deletes dedicated runtime IAM keys so CloudFormation can delete its IAM user;
7. immediately before stack deletion, inspects instance state; a running/pending instance must successfully stop Minecraft through SSM, report exact command success, stop through EC2, and reach `stopped` before the exact instance/root volume/tags are re-read;
8. in the default Google Drive durability mode, parses the real `/minecraft/backups-cache` shape `{backups:[...], cachedAt:<epoch-ms>}`, requires non-empty backups plus a valid positive `cachedAt`, records that evidence, and creates no EBS snapshot;
9. only when `pnpm destroy:execute:snapshot` was explicitly selected, creates, waits for, tag-verifies, records, and reports a retained final snapshot of the managed root volume;
10. revalidates the exact StackId and runtime IAM tags after any snapshot wait, requests `cloudformation delete-stack` using the recorded StackId/ARN (never a mutable name), and waits for exact stack deletion;
11. handles a verified tagged IAM-user orphan after stack deletion;
12. re-inventories known billing-relevant resources and treats AccessDenied, throttling, malformed responses, and network failures as verification failures—not absence.

The `workers.dev` mode has no custom panel route or panel DNS to delete. Custom mode requires route and DNS verification. Cloudflare absence is accepted only from the expected HTTP status plus provider error code. Minecraft Cloudflare DNS, DuckDNS, raw-IP configuration, and account-wide SES receipt rule sets are not deleted by this script. The project-owned SES receipt rule is removed with the stack; a pre-existing receipt rule set remains untouched.

### Failure And Retry

Do not switch to broad deletion after a failure. Correct the reported authentication, live-state, or ownership problem and run the same command again. Successful stages are idempotent, and live absence is treated as already complete. A snapshot that is still `pending` and recorded as the current manifest attempt is waited again rather than duplicated. However, if that snapshot completed and the exact CloudFormation deletion did not finish, the instance may have restarted or received new writes. A rerun therefore quiesces/stops again and creates a fresh snapshot before retrying deletion.

An ownership mismatch blocks mutation before confirmation. A provider failure during execution may leave a partial teardown; rerun first, then use the manual procedure only for the remaining verified resources.

## Final Data Preservation, Backups, And Volumes

CloudFormation normally deletes the instance's root EBS volume. **The root volume itself does not survive stack deletion.** For `running`/`pending`, teardown sends a bounded graceful `systemctl stop minecraft.service` command through SSM, verifies exact `Success`, stops the EC2 instance, waits for `stopped`, and then re-reads the exact instance, root mapping, attachment, and ownership tags. An already stopped instance proceeds directly; an instance already stopping must finish stopping. Any quiesce, stop, wait, identity, or tag failure blocks deletion.

The default `pnpm destroy:execute` uses the project's Google Drive durability model. It requires non-empty cached backup evidence and a valid cache timestamp, records that evidence in the manifest, deletes no Google Drive content, and creates no EBS snapshot. The cache is supporting evidence rather than a live Drive read: independently list the Drive archives (and preferably test restore) before confirming destructive teardown.

Use `pnpm destroy:execute:snapshot` only after explicitly deciding to incur and later manage retained EBS snapshot storage. That mode creates a final `McAwsFinalTeardown=true` snapshot after the stop, records it as the pending manifest attempt, waits for `completed`, verifies exact source/stack tags, and updates the manifest's final-snapshot pointer. Stack deletion is blocked if creation, waiting, or verification fails.

Pending waiter retries are deduplicated only when the exact pending snapshot ID is recorded in the manifest and remains `pending` with matching provider tags. A completed snapshot is never reused as the final preservation point while the stack/root volume still exists: teardown quiesces/stops again and creates a fresh snapshot representing the current volume contents. The manifest pointer moves to the newest completed snapshot; all older completed snapshots remain retained, are included in snapshot inventory/reporting, and may continue to incur charges.

When hibernate has already removed the root volume, no EBS snapshot can be created, so even snapshot mode requires the same Google Drive cache evidence. This is only evidence that the application previously cached a non-empty listing; it is **not** live external Google Drive verification and is not a substitute for checking Google Drive or performing a restore test.

The script has no automatic snapshot or EBS volume **deletion** path. It reports the final snapshot, other project snapshots, and volumes before and after teardown because they may incur charges. This avoids silently deleting backups or a volume retained after a failed resume/stack deletion.

Review each retained item manually. Before deleting one, verify its tags, contents, attachment state, backup/restore requirements, and exact relationship to this deployment. Google Drive backups are external to AWS and are never removed by teardown.

## Optional Local Cleanup

Local environment cleanup has a second, separate confirmation:

```bash
pnpm destroy:cleanup-local
```

After cloud verification, type the additional phrase to delete only `.env`, `.env.local`, and `.env.production`. Example files and `.mc-aws-deployment.json` remain. Keep the manifest as an audit/recovery record until you have completed provider billing review.

## Manual Procedure

Use this only when the automated flow cannot run. Start with `pnpm destroy` and the manifest. Never infer ownership from a resource name alone.

1. **Identity:** verify `aws sts get-caller-identity`, AWS region, Wrangler account ID, stack ID, and manifest all agree.
2. **Cloudflare routes:** list routes for the recorded zone. Delete only a route recorded as project-created whose live ID, pattern, and Worker target all match. Restore (do not delete) a pre-existing route to its recorded original target.
3. **Worker:** require the manifest's provider deployment ID to match the current live deployment immediately before deleting the Worker directly. Do not delete secrets one-by-one first. Never overwrite or delete a merely same-name Worker. There is no safe automated adoption path for an arbitrary pre-existing Worker because prior code and secrets cannot be restored.
4. **KV and panel DNS:** compare exact IDs plus live title/name/type/content. Delete only entries marked project-created. Preserve pre-existing Minecraft DNS and panel DNS records; restore only changes explicitly recorded in the manifest.
5. **DLM:** compare policy ID and `McAwsProject=mc-aws` plus `McAwsStack=<stack>`. Delete only a policy marked project-created in the manifest. A matching tag without a manifest ownership fact is not sufficient.
6. **Runtime IAM:** compare username and all three ownership tags. Inactivate/delete that user's runtime access keys before CloudFormation deletion. Do not revoke local SSO or human deployment credentials as part of this step.
7. **Final root data:** if a tagged managed root volume is attached, gracefully stop Minecraft through SSM when running, verify SSM success, stop/wait for the instance, and re-read exact identities/tags. In default mode, verify Google Drive separately and require non-empty `{backups,cachedAt}` cache evidence; in explicit snapshot mode, create and verify the tagged final snapshot. Never snapshot a running instance. Do not continue on failure.
8. **CloudFormation:** re-fetch the exact StackId and runtime IAM tags after the snapshot wait, then call `delete-stack` and its waiter with that exact StackId/ARN. Expect its root EBS volume to be deleted. Do not delete by mutable stack name or use `cdk destroy --all` as a substitute for ownership proof.
9. **SES:** confirm the project receipt rule disappeared with the stack. Never deactivate or delete the operator-owned SES receipt rule set during this migration/cleanup.
10. **Backups/storage:** list project-tagged snapshots and volumes. Retain by default; manually delete only after an explicit backup decision.
11. **Final verification:** check CloudFormation, EC2 instances/volumes/snapshots, DLM, IAM, Worker, routes, KV, panel DNS, AWS Billing/Cost Explorer, and the Cloudflare dashboard. Treat every provider error as unresolved.

If the manifest is missing—or predates the Worker deployment marker—there is no safe automated ownership proof. Inventory manually using CloudFormation resources and provider IDs, preserve ambiguous resources, and recover an authoritative manifest from a secure local backup if available. Do not "adopt" a same-name Worker or stack by editing JSON.

## External Credential And OAuth Cleanup

Cloud teardown revokes the dedicated Worker runtime IAM keys. It intentionally does not make these user-owned decisions:

- remove the production origin and redirect URI—or delete the OAuth client/project—in Google Cloud;
- revoke deploy/DNS API tokens in Cloudflare if they are no longer used elsewhere;
- revoke the GitHub token if it was dedicated to this deployment;
- rotate/revoke a DuckDNS token only if it is not shared;
- remove Google Drive backup access/data only after deciding whether to retain backups;
- remove local AWS SSO/profile credentials only if you intend to retire that local identity.

## Billing Verification

Provider billing data can lag. After the script's final verification, check AWS Billing and Cost Explorer again after usage data settles. Pay particular attention to retained EBS volumes/snapshots and any unproven DLM policy. Also inspect Cloudflare Workers/KV usage and any separately billed DNS/domain services. A successful script run does not claim that deliberately retained backups are free.
