# Existing Deployment Safety Migration

This runbook is for a live `MinecraftStack` created before the SES, runtime-IAM, and lifecycle-volume remediations. Do not run a normal CDK update first. The legacy stack can deactivate the account-wide SES receipt rule set when its old activation custom resource is removed, and the current EC2 definition may replace the server whose root EBS volume has `DeleteOnTermination=true`.

The migration operator is deliberately fail-closed and read-only by default. It uses the exact CloudFormation StackId, verifies the AWS account and region, resolves the EC2 instance through logical ID `MinecraftServerACE914F3`, proves the root-volume attachment, and rejects conflicting ownership tags. It never calls SES activation APIs, changes `DeleteOnTermination`, snapshots, stops, or replaces the instance.

## Prerequisites

- Start from the reviewed repository revision and a clean working tree.
- Authenticate the intended human/deployment AWS profile. Never use the Worker runtime identity.
- Use the live stack's region (currently `us-west-1`).
- Ensure no CloudFormation update is in progress.
- Preserve a separate, current application backup before any infrastructure maintenance.

Set the profile and obtain the immutable StackId:

```bash
export AWS_PROFILE=<deployment-profile>
export AWS_REGION=us-west-1
STACK_ID="$(aws cloudformation describe-stacks \
  --stack-name MinecraftStack \
  --query 'Stacks[0].StackId' \
  --output text)"
printf '%s\n' "$STACK_ID"
```

Never substitute a stack name for `--confirm-stack-id`.

## Stage 0: read-only plan

```bash
pnpm migrate:existing
```

This reads STS, CloudFormation, EC2, and the root volume, then synthesizes current CDK into a temporary directory. It does not publish assets, create a change set, change tags, or update the stack. Review the reported StackId, instance ID, root volume ID, `DeleteOnTermination=true`, and missing ownership tags.

## Stage 1: protect legacy SES resources

```bash
pnpm migrate:existing -- \
  --stage retain \
  --execute \
  --confirm-stack-id "$STACK_ID"
```

This starts from the **deployed** template and changes only these template attributes:

| Logical ID | Expected type | Required policies |
| --- | --- | --- |
| `MinecraftRuleSet298765D1` | `AWS::SES::ReceiptRuleSet` | `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain` |
| `ActivateRuleSet3E62562C` | `Custom::AWS` | `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain` |

All legacy SES properties, including the old activation handler properties, remain byte-for-byte equivalent. To prevent an `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` refresh from selecting a newer AMI during this otherwise policy-only update, the instance's template `ImageId` is pinned to the exact AMI reported by the identity-checked physical instance. No other instance property changes. The operator creates a change set and refuses/deletes it if CloudFormation reports **any** instance action or any action outside non-replacing modifications to those two legacy logical IDs. Only a safe change set is executed; the command then waits for the update and re-reads the deployed template. Stop if this stage fails; do not continue with a direct current-template deployment.

## Stage 2: establish lifecycle ownership

```bash
pnpm migrate:existing -- \
  --stage tags \
  --execute \
  --confirm-stack-id "$STACK_ID" \
  --confirm-exclusive-tagging
```

Before calling `CreateTags`, the operator rechecks both Retain policies and proves:

- the physical instance comes from the exact stack and logical ID;
- its CloudFormation stack ID/name/logical-ID tags match exactly;
- its sole EBS root mapping still has `DeleteOnTermination=true`;
- the volume is uniquely attached to that instance at the reported root device; and
- each existing `McAwsProject`, `McAwsStack`, or `McAwsManagedRoot` tag is absent or already exact.

`--confirm-exclusive-tagging` is an explicit assertion that every other stack update, EC2 lifecycle operation, and tag writer has been paused for the entire tags stage. This is required because EC2 `CreateTags` has no compare-and-set operation and cannot establish writer provenance under concurrency. Dry runs and every non-tag stage do not require this acknowledgment.

It adds only `McAwsProject=mc-aws`, `McAwsStack=MinecraftStack`, and `McAwsManagedRoot=true`, preserving unrelated and previously observed ownership tags. The operator rechecks attachment identity immediately before each write, tags and verifies the root volume first, rechecks again, and tags the instance second. Under the required exclusive-writer precondition, if identity, attachment, or tag state changes, it makes a best-effort cleanup of only exact tag keys that were absent immediately before this invocation's writes. Cleanup or exclusivity failure is a critical stop condition; do not continue until tag state is independently reviewed. A conflicting ownership value blocks adoption.

## Stage 3: prepare the pinned-instance bridge

```bash
pnpm migrate:existing -- \
  --stage prepare-bridge \
  --execute \
  --confirm-stack-id "$STACK_ID"
```

This stage synthesizes current CDK, copies the complete deployed `MinecraftServerACE914F3` resource definition (with its `ImageId` kept pinned to the identity-checked physical AMI) into that template, publishes the current Lambda assets, and creates—but does **not** execute—an update change set. Before returning a synthesized template or publishing anything, the operator verifies the cloud assembly stack environment and every asset destination account, region, publishing role, and file-asset bucket against the exact confirmed stack identity. Thus current non-instance remediation such as `WorkerRuntimeUser` can deploy while the EC2 resource remains exactly as CloudFormation already manages it.

Existing CloudFormation parameters use their previous values. If current configuration introduces a required parameter that the deployed template did not have, the command refuses until its named `MC_AWS_MIGRATION_PARAMETER_<ParameterLogicalId>` environment variable is present; do not place the value on the command line. The temporary mode-`0600` request file is removed after the API call.

The operator deletes and rejects its change set unless CloudFormation reports:

- no action at all for `MinecraftServerACE914F3`; and
- exactly one `Remove` action for each retained legacy SES logical ID.

When CloudFormation includes `PolicyAction` in a removal, it must be `Retain`; an explicit `Delete` or any other effective action is rejected. Some CloudFormation responses omit this optional field, so omission is accepted only alongside the independently re-read deployed Retain policies.

Review every change in the CloudFormation console or with:

```bash
aws cloudformation describe-change-set \
  --stack-name "$STACK_ID" \
  --change-set-name <printed-change-set-arn>
```

Do not execute a change set that differs from the operator's validated description.

## Stage 4: execute the reviewed bridge

```bash
pnpm migrate:existing -- \
  --stage execute-bridge \
  --execute \
  --confirm-stack-id "$STACK_ID" \
  --change-set-name <reviewed-change-set-arn>
```

Immediately before execution, the operator revalidates the Retain policies, ownership and attachment, exact StackId, change-set status/description, both legacy removals, and absence of any instance action. After CloudFormation completes, it verifies that the same instance and root volume remain attached and tagged, and that the old SES resources are no longer managed by the stack. Because both were retained first, removal does not invoke the historical activation resource's delete handler or delete the account-wide rule set.

The retained rule set and activation physical resource are now operator-managed. Confirm SES remains active and remove only obsolete project receipt rules after independent ownership review.

The bridge creates the dedicated Worker IAM user but does not deploy Cloudflare. Once bridge verification succeeds, run `pnpm deploy:cf`; it reads the runtime-user stack output and performs the candidate-key probe/rotation. Do not re-run all of `setup.sh` while its intentional EC2-diff guard remains active.

## Future deployments

The bridge intentionally does not alter `infra/lib/minecraft-stack.ts` or pretend the legacy EC2 definition is current. `setup.sh` and `pnpm cdk:deploy` run a read-only guard and refuse an existing stack while either legacy SES resource remains managed, the deployed EC2 resource differs from current CDK, **or the synthesized instance AMI is a dynamic/unpinned value such as CDK's latest-AMI SSM parameter**. Template equality cannot prove safety for a dynamic AMI because CloudFormation may re-resolve it during an update and replace the instance. Routine deployment remains blocked until the desired CDK uses an explicit AMI ID matching the deployed instance, or updates continue through reviewed pinned-instance bridges.

- To ship additional non-instance infrastructure while the instance remains legacy, repeat the `prepare-bridge` and `execute-bridge` stages; the full live instance resource is pinned each time.
- Before converging the EC2 definition, make and verify an application-consistent backup plus a completed snapshot of the exact root volume, test the restore path, and review a dedicated final change set that explicitly states whether replacement occurs. Alternatively, change the desired CDK instance properties so CloudFormation reports no replacement. A raw `cdk deploy` bypasses the repository guard and is therefore an explicit operator exception, not a migration step.
- Do not delete the retained SES rule set merely to make a diff disappear. Account-wide activation remains operator-owned.

If any identity, tag, attachment, template type, policy, parameter, change-set, waiter, or post-update assertion fails, stop and investigate. Do not weaken the checks or switch to resource-name-only matching.
