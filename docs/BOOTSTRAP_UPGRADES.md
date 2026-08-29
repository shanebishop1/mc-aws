# Reviewed Bootstrap, Existing-Host, and OS Upgrades

EC2 bootstrap inputs are immutable review boundaries. Routine setup and deploys validate the checked-in pins; they do not discover new Paper builds, rclone releases, Python packages, or operating-system updates.

## Current reviewed artifacts

The machine-readable source of truth is [`config/bootstrap-pins.json`](../config/bootstrap-pins.json). As reviewed on 2026-08-27 it contains:

| Artifact | Exact pin | SHA-256 source |
| --- | --- | --- |
| Paper | Minecraft `1.21.11`, build `132`, `paper-1.21.11-132.jar` | [Paper Downloads Service build metadata](https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds/132) |
| rclone | `1.71.2`, Linux ARM64 zip | [rclone 1.71.2 SHA256SUMS](https://downloads.rclone.org/v1.71.2/SHA256SUMS) |
| mcstatus | `12.0.2` wheel | [PyPI release JSON](https://pypi.org/pypi/mcstatus/12.0.2/json) |
| asyncio-dgram | `2.2.0` wheel | [PyPI release JSON](https://pypi.org/pypi/asyncio-dgram/2.2.0/json) |
| dnspython | `2.7.0` wheel | [PyPI release JSON](https://pypi.org/pypi/dnspython/2.7.0/json) |

Bootstrap downloads each exact URL and verifies its reviewed SHA-256 before installation. The Python wheels are installed with `--no-index --no-deps`; this prevents pip from resolving mutable transitive versions. `setup.sh` validates that `user_data.sh` and the existing-host rollout helper exactly match the manifest and persists `MC_BOOTSTRAP_PINS_SHA256` in both reusable deployment env files.

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

   The command does not discover a newer release. It downloads every configured artifact, rejects any checksum mismatch, and only then synchronizes `user_data.sh`.
6. Run `pnpm bootstrap:check`, `pnpm test -- lib/bootstrap-pins.test.ts tests/user-data-script.test.ts`, and `bash -n infra/src/ec2/user_data.sh`. Review the manifest and shell diff together before deployment.
7. Do **not** assume UserData reruns. Load `.env.production`, then inspect the live host:

   ```bash
   set -a; source .env.production; set +a
   pnpm host:upgrade -- plan --region "$AWS_REGION"
   ```

8. If the AMI is unchanged, use the plan's exact IDs and digest with `rollout-runtime`. It takes a maintenance lock compatible with old and `dual-v1` clients, stops Minecraft only while applying exact artifacts, transfers `mc-wait-ready.sh` before a new Lambda can depend on it, and verifies hashes/readiness. Then use the existing-deployment non-instance bridge to publish AWS assets/Lambda without replacing EC2. A Paper/Minecraft upgrade can rewrite world data; take and test a Drive backup first, and do not assume reinstalling an older jar reverses a world-format migration.
9. If the AMI changed, use the replacement stages below. Never run ordinary `cdk:deploy` to bypass the guard.

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
2. Run `host:upgrade plan`, then `prepare-replacement` with the exact printed StackId/instance ID. Prepare acquires the compatibility lock, creates and re-reads a fresh exact Drive archive, gracefully stops Minecraft/EC2, creates and waits for an encrypted root snapshot, asks CDK to prepare (not execute) a change set, and rejects anything except the exact EC2 AMI replacement plus non-destructive adjacent changes. It restarts the old host after preparation.
3. Review the immutable change-set ARN in CloudFormation. Execute only with all exact printed confirmations:

   ```bash
   pnpm host:upgrade -- execute-replacement \
     --confirm-stack-id <exact-stack-arn> \
     --confirm-instance-id <old-instance-id> \
     --confirm-snapshot-id <completed-snapshot-id> \
     --confirm-change-set-id <reviewed-change-set-arn> \
     --confirm-replacement 'REPLACE <old-instance-id> WITH <target-ami-id> FROM <snapshot-id>'
   ```

4. The executor revalidates backup/snapshot/change set, exercises the standard guard's narrow reviewed bypass, quiesces `dual-v1`, sets `/minecraft/resume-pending`, replaces the host, restores the named Drive archive, verifies AMI/runtime hashes and readiness, and persists the new instance and both DynamoDB table outputs before allowing Worker deployment.

If any post-check fails, the workflow stops the new instance and retains the resume marker, maintenance lock, local recovery state, Drive backup, and billed snapshot. Do not deploy the Worker or delete anything. Fix the recoverable cause and run the exact printed `recover` confirmation. If the new AMI cannot work, restore the old AMI pin and prepare a new reviewed replacement, restoring the same Drive archive. CloudFormation rollback protects failed stack updates; the EBS snapshot is retained for manual AWS recovery/forensics and is not silently attached to a mismatched instance. Release quiescence only after restore, runtime hashes, readiness, and output persistence all pass.

## Reproducibility limits

- The exact AMI and its explicit AL2023 `releasever` constrain bootstrap RPMs to AWS's matching repository snapshot. AWS still controls availability and the contents/metadata of that snapshot, and this project does not checksum every RPM. Eliminating that residual repository dependency requires a reviewed private RPM mirror with immutable metadata/package hashes or a pre-baked project AMI. Compare the recorded OS package manifest when diagnosing launch differences.
- HTTPS availability, certificate trust, AWS/Paper/rclone/PyPI retention, and EC2 regional capacity remain external dependencies. Checksums prevent substituted bytes from being installed; they cannot keep an upstream URL available.
- Paper may download Minecraft libraries/assets at first start. Those upstream runtime downloads are outside this bootstrap manifest.
- Source timestamps and archive metadata can differ for project-generated runtime/profile archives even though deployment validates their content SHA-256.

## Dependency locks and audits

Use `pnpm install --frozen-lockfile` at the repository root and `npm ci` in Lambda package directories. Commit package manifests and lockfiles together for reviewed dependency changes. CI installs the root lockfile without mutation and audits root and deployed Lambda production dependency locks. Run the same audit commands locally when changing dependencies:

```bash
pnpm audit --prod --audit-level high
npm --prefix infra/src/lambda/StartMinecraftServer audit --omit=dev --audit-level=high
```
