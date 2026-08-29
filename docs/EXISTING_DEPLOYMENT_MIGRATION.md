# Existing Deployment Migration

Use this runbook for an older live `MinecraftStack` that still manages the old SES rule-set resources or whose EC2 definition differs from current CDK. Do not run a normal CDK update first: removing the old SES activation resource can disable the account-wide receipt rule set, and changing EC2 can replace the instance and delete its root volume.

## What this does not do

- It does not upgrade or replace the existing EC2 instance.
- It does not change `DeleteOnTermination`, stop the server, create a snapshot, or create an application backup.
- It does not convert old GitHub-based instance setup to a server profile.
- It does not deploy Cloudflare.
- It does not remove retained SES resources after they leave the stack.
- It does not create or adopt a complete `.mc-aws-deployment.json`. Without a trusted complete record, automated teardown is unavailable. Never fabricate or fill in one from guesses.

Legacy user data may still read `/minecraft/github-user`, `/minecraft/github-repo`, or `/minecraft/github-pat`. Current CDK removes those parameters. The bridge stops if the live instance still depends on them. Plan a separate profile transition or a reviewed temporary template that retains those parameters. Do not assume hibernate or resume is safe until that work is complete.

Inventory all three exact names. Treat `/minecraft/github-pat` as a reusable credential: after dependency removal, delete it only with proven installation ownership or explicit exact-name consent, then revoke the PAT in GitHub. Preserve uncertain user/repository parameters until their history is reviewed. A missing local ownership fact is not evidence that an old parameter belongs to this installation.

## Prepare

Start from the reviewed repository revision and make a current application backup. Use a clean worktree so synthesis matches what you reviewed; **the command does not check worktree cleanliness for you.** Pause stack updates, EC2 actions, and tag writers.

Set the deployment identity. Use the stack's real region rather than assuming the default:

```bash
export AWS_PROFILE=<deployment-profile>
export MC_AWS_REGION=<stack-region>
export AWS_REGION="$MC_AWS_REGION"
STACK_ID="$(aws cloudformation describe-stacks \
  --region "$MC_AWS_REGION" \
  --stack-name MinecraftStack \
  --query 'Stacks[0].StackId' \
  --output text)"
printf '%s\n' "$STACK_ID"
```

Use a human deployment identity, not the Worker runtime IAM user. The stack must be stable. A completed update rollback is accepted; an update or rollback still in progress is not.

## Stage 0: inspect only

**Purpose:** confirm account, region, exact stack, instance, AMI, root volume, tags, live user data, and the current synthesized template.

```bash
pnpm migrate:existing -- --region "$MC_AWS_REGION"
```

**Expected changes:** none. The command reads AWS and synthesizes locally; it does not publish assets or create a change set.

**Stop if:** any identity is unexpected, the root volume is not the sole attached root with `DeleteOnTermination=true`, the stack is unstable, or old GitHub parameters are still required without a transition plan.

## Stage 1: retain old SES resources and pin EC2 inputs

**Purpose:** make removal of the old SES resources leave them in the account, while keeping the physical instance's current AMI and user data unchanged.

```bash
pnpm migrate:existing -- \
  --region "$MC_AWS_REGION" \
  --stage retain \
  --execute \
  --confirm-stack-id "$STACK_ID"
```

**Expected changes:** adds `Retain` policies to `MinecraftRuleSet298765D1` and `ActivateRuleSet3E62562C`; pins a dynamic AMI parameter when needed; records the instance's current user data in the deployed template. The command rejects any EC2 action or unrelated change.

**Stop if:** the proposed change set includes an EC2 action, a replacement, or anything beyond the permitted SES updates and required AMI/user-data pinning. Do not continue after a failed update.

## Stage 2: tag the instance and root volume

**Purpose:** add the tags used by current storage and teardown checks.

```bash
pnpm migrate:existing -- \
  --region "$MC_AWS_REGION" \
  --stage tags \
  --execute \
  --confirm-stack-id "$STACK_ID" \
  --confirm-exclusive-tagging
```

**Expected changes:** adds `McAwsProject=mc-aws`, `McAwsStack=MinecraftStack`, and `McAwsManagedRoot=true` to the exact root volume first and exact instance second. Unrelated tags remain.

**Stop if:** another process may write tags or change EC2, any existing tag conflicts, the attachment changes, or cleanup after a partial tag write fails. Review both resources before retrying.

## Stage 3: prepare a bridge change set

**Purpose:** combine current non-instance infrastructure with the exact live EC2 definition and remove the two now-retained SES resources from stack management.

```bash
pnpm migrate:existing -- \
  --region "$MC_AWS_REGION" \
  --stage prepare-bridge \
  --execute \
  --confirm-stack-id "$STACK_ID"
```

**Expected changes:** publishes current Lambda/runtime/profile assets and creates, but does not execute, a change set. The allowed plan has no EC2 action and one removal for each old SES resource. New required CloudFormation parameters must be supplied through `MC_AWS_MIGRATION_PARAMETER_<LogicalId>` environment variables.

**Stop if:** old GitHub-dependent user data remains, any account or region differs, the plan changes EC2, or the change set contains unexpected actions. Review the printed change-set ARN in CloudFormation.

## Stage 4: execute the reviewed change set

**Purpose:** apply exactly the plan reviewed in Stage 3.

```bash
pnpm migrate:existing -- \
  --region "$MC_AWS_REGION" \
  --stage execute-bridge \
  --execute \
  --confirm-stack-id "$STACK_ID" \
  --change-set-name <reviewed-change-set-arn>
```

**Expected changes:** updates non-instance resources and removes the two old SES resources from stack management without deleting them. The same instance, AMI, root volume, user data, and tags must remain afterward.

**Stop if:** the change set changed since review, any EC2 action appears, the pinned AMI is not exact, or any post-update check fails. Do not use a normal deployment to work around the error.

After success, confirm SES inbound mail still works. The retained SES rule set and activation resource are now your responsibility. Updating an existing Worker requires its matching `.mc-aws-deployment.json` and should be refused without it. If no Worker exists, `pnpm deploy:cf` can create one and a partial local record, but automated teardown remains unavailable until the AWS resource history is safely adopted. Inventory existing Cloudflare resources first. Do not fabricate the record or rerun all of `setup.sh` for this transition.

Capture the exact bridge outputs without rerunning setup or another AWS deployment:

```bash
pnpm migrate:existing -- \
  --region "$MC_AWS_REGION" \
  --stage sync-worker-env \
  --execute \
  --confirm-stack-id "$STACK_ID" \
  --env-file .env.production
pnpm bootstrap:check -- --env-file .env.production
```

This revalidates account, region, exact StackId, stable status, physical instance identity, and all three outputs before an atomic `0600` dotenv update. It preserves unrelated values and refuses duplicate effective keys, links, missing outputs, or a mismatched instance. It does not deploy AWS or Cloudflare resources.

## Unresolved-state checklist

Do not call the bridge complete until every item is resolved:

- [ ] The exact stack is stable in the intended account and `MC_AWS_REGION`.
- [ ] The instance ID, AMI, user data, root volume, and attachment are unchanged.
- [ ] Instance and volume have all three expected tags with no conflicts.
- [ ] The old SES resources are retained, no longer managed by the stack, and SES remains active.
- [ ] Old GitHub SSM references are absent or covered by a separately reviewed temporary plan.
- [ ] The GitHub PAT has been revoked after its final dependency was removed; Parameter Store deletion alone is insufficient.
- [ ] DynamoDB operation-state reads/writes are verified, the rollback/retention window has closed, and opt-in legacy SSM cleanup has been reviewed before removing SSM fallback or IAM.
- [ ] `.env.production` contains synchronized `INSTANCE_ID`, `MC_LIFECYCLE_LOCK_TABLE_NAME`, `MC_OPERATION_STATE_TABLE_NAME`, and the validated bootstrap pin digest.
- [ ] A tested data-preservation plan exists before any later EC2 replacement.
- [ ] A current application backup and root-volume snapshot exist before any later planned replacement.
- [ ] Cloudflare deployment and Worker runtime-key setup have completed separately.

Normal deployment remains blocked while old SES resources are still managed or current CDK would change the live EC2 resource. On the first bridge pass, Stages 3 and 4 expect removal of the two retained legacy SES resources. On later reviewed non-instance bridge updates those resources are already outside the stack, so repeat Stages 3 and 4 only when the printed plan contains no unexpected action; do not expect the SES removals to repeat.
