# Existing Deployment Safety Migration

This runbook is for a live `MinecraftStack` created before the SES, runtime-IAM, and lifecycle-volume remediations. Do not run a normal CDK update first. The legacy stack can deactivate the account-wide SES receipt rule set when its old activation custom resource is removed, and the current EC2 definition may replace the server whose root EBS volume has `DeleteOnTermination=true`.

The migration operator is deliberately fail-closed and read-only by default. It uses the exact CloudFormation StackId, verifies the AWS account and region, resolves the EC2 instance through logical ID `MinecraftServerACE914F3`, proves the root-volume attachment, and rejects conflicting ownership tags. It never calls SES activation APIs, changes `DeleteOnTermination`, snapshots, stops, or replaces the instance.

Legacy EC2 user data may still read `/minecraft/github-user`, `/minecraft/github-repo`, or `/minecraft/github-pat`. Current CDK intentionally removes those resources. The bridge and normal-deploy guard refuse that combination rather than preserving physical user data while deleting dependencies needed by later boot/rebuild behavior. The standard-deploy guard also reads the physical EC2 UserData and refuses template drift or physical legacy references. Complete an explicit server-profile transition or retain the legacy parameters in a separately reviewed temporary template before continuing. No automatic legacy-to-profile transition is implemented. Do not delete the parameters merely because a new synthesis omits them, and do not assume hibernate/resume is safe until the transition is complete.

## Prerequisites

- Start from the reviewed repository revision and a clean working tree.
- Authenticate the intended human/deployment AWS profile. Never use the Worker runtime identity.
- Use the live stack's region (currently `us-west-1`).
- Ensure no CloudFormation update is in progress. A fully completed update rollback (`UPDATE_ROLLBACK_COMPLETE`) is accepted for a fresh read-only plan and a guarded retry; in-progress or failed rollback states remain blocked.
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

This reads STS, CloudFormation, EC2, the root volume, and the identity-proven instance's UserData attribute, then synthesizes current CDK into a temporary directory. It does not publish assets, create a change set, change tags, or update the stack. Review the reported StackId, instance ID, root volume ID, `DeleteOnTermination=true`, and missing ownership tags. UserData contents are never printed.

## Stage 1: protect legacy SES resources

```bash
pnpm migrate:existing -- \
  --stage retain \
  --execute \
  --confirm-stack-id "$STACK_ID"
```

This starts from the **deployed** template, installs these lifecycle policies, and—when needed—also converts only the instance's referenced AMI parameter definition as described below:

| Logical ID | Expected type | Required policies |
| --- | --- | --- |
| `MinecraftRuleSet298765D1` | `AWS::SES::ReceiptRuleSet` | `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain` |
| `ActivateRuleSet3E62562C` | `Custom::AWS` | `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain` |

All legacy SES properties, including the old activation handler properties, remain byte-for-byte equivalent. Every deployed EC2 property except the stored `UserData` literal also remains byte-for-byte equivalent. When `ImageId` is an exact `Ref` to an `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`, the operator verifies that the stack parameter's old `ResolvedValue` exactly equals the identity-checked physical instance AMI, changes only that parameter definition to the non-refreshing `AWS::EC2::Image::Id` type (and pins an existing default), and explicitly supplies that same physical AMI as the change-set `ParameterValue`. This prevents both latest-SSM refresh and an EC2 property-expression diff. The parameter must have exactly one direct `Ref` across the entire template—the instance `ImageId`—and no `Fn::Sub` interpolation; the referenced parameter's own definition is excluded from that usage scan. A literal AMI or already-pinned parameter is accepted only when its effective value exactly matches the physical instance; malformed, missing, reused dynamic, unsupported, or mismatched references fail closed.

After proving the instance through its exact stack/logical ID, CloudFormation tags, root mapping, and attached volume, the operator reads `describe-instance-attribute --attribute userData` for that physical instance. It requires canonical nonempty base64 that decodes to valid nonempty UTF-8 and round-trips byte-for-byte. The deployed template must represent UserData as exactly one literal `Fn::Base64` string; references, substitutions, additional keys, empty data, malformed UTF-8, and noncanonical encodings fail closed. The operator replaces only that stored literal with the decoded physical bytes, including legacy Unicode and trailing-newline bytes. This adopts what EC2 already stores rather than intentionally changing the instance attribute.

The operator requests property values when describing the change set but logs only action, equality, and length metadata—not before/after value previews. It refuses/deletes the change set if CloudFormation reports **any** instance action, including a conditional `UserData` modification, or any action outside non-replacing modifications to the two legacy logical IDs. Only after that zero-EC2-action check does it retrieve and validate the exact pending template.

CloudFormation `GetTemplate` can return a lossy API representation of an otherwise adopted UserData literal—for example, physical U+202F may be returned as ASCII `?`. Physical EC2 bytes remain authoritative. A CloudFormation-returned UserData string is accepted only when it is either the exact valid physical UTF-8 text or the complete lossy representation produced by replacing **every** non-ASCII Unicode code point with exactly one ASCII `?`. All physical ASCII code points must remain exact, code-point counts must match, and mixed, partial, missing, additional, differently substituted, or other-Unicode changes are rejected. This representation allowance never permits an EC2 change-set action.

Only a safe change set is executed; the command then waits for the update, re-reads the deployed template, stack parameters, instance, volume, and UserData attribute, and proves the instance ID, root volume, physical AMI, and actual UserData bytes did not change while the returned template UserData is one of those two narrowly accepted representations. Stop if this stage fails; do not continue with a direct current-template deployment.

Stage 1 does not no-op merely because both Retain policies are already present. It separately verifies that applying Retain makes no change, the AMI parameter definition/default is already pinned with a deployed value matching the physical instance, and stored UserData is either the exact physical UTF-8 or the complete allowed CloudFormation question-mark representation. Only then does it skip the update. Therefore an older partial attempt that deployed Retain policies but left the SSM AMI parameter dynamic or stored UserData outside that narrow representation still requires Stage 1.

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

This stage re-reads and adopts the identity-proven physical UserData bytes, synthesizes current CDK, and copies that adopted `MinecraftServerACE914F3` resource definition into the bridge without rewriting its `ImageId` expression. For an SSM-backed live `Ref`, it carries forward the converted `AWS::EC2::Image::Id` parameter definition and explicitly supplies the identity-checked physical AMI; an already-pinned live parameter is likewise preserved and explicitly supplied. Before publishing assets, it also refuses legacy GitHub-dependent physical user data when the synthesis removes those SSM dependencies. It then publishes the current Lambda plus narrow runtime/profile assets and creates—but does **not** execute—an update change set. Before returning a synthesized template or publishing anything, the operator verifies the cloud assembly stack environment and every asset destination account, region, publishing role, and file-asset bucket against the exact confirmed stack identity. After proving CloudFormation reports no EC2 action, it retrieves the pending template and validates its AMI pin and UserData using the narrow API-representation rule above.

Existing CloudFormation parameters use their previous values except the live instance's pinned AMI parameter, which always receives the verified physical AMI as an explicit `ParameterValue`. If current configuration introduces a required parameter that the deployed template did not have, the command refuses until its named `MC_AWS_MIGRATION_PARAMETER_<ParameterLogicalId>` environment variable is present; do not place the value on the command line. The temporary mode-`0600` request file is removed after the API call.

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

Immediately before execution, the operator revalidates the Retain policies, ownership and attachment, exact StackId, change-set status/description, both legacy removals, and absence of any instance action. It re-reads the authoritative actual UserData bytes and validates the live template under the narrow exact-or-completely-lossy API rule. It then retrieves the template associated with the exact immutable change-set ID through CloudFormation `GetTemplate`, verifies its EC2 `ImageId` expression is byte-equivalent to the live expression, proves its AMI parameter definition is already non-refreshing, requires the described change-set parameter payload to explicitly supply the exact physical AMI rather than `UsePreviousValue`, and validates pending UserData under the same rule.

After CloudFormation completes, the operator re-reads the stack, original template, stack parameters, EC2 instance, root volume, and actual UserData bytes. Success requires the pinned parameter type/value and EC2 `ImageId` expression to remain exact; returned UserData to satisfy the narrow representation rule; the authoritative physical AMI and UserData bytes to be unchanged; the same instance and root volume to remain attached and tagged; and the old SES resources to no longer be managed by the stack. Because both legacy resources were retained first, removal does not invoke the historical activation resource's delete handler or delete the account-wide rule set.

The retained rule set and activation physical resource are now operator-managed. Confirm SES remains active and remove only obsolete project receipt rules after independent ownership review.

The bridge creates the dedicated Worker IAM user but does not deploy Cloudflare. Once bridge verification succeeds, run `pnpm deploy:cf`; it reads the runtime-user stack output and performs the candidate-key probe/rotation. Do not re-run all of `setup.sh` while its intentional EC2-diff guard remains active.

## Future deployments

`setup.sh` now resolves and persists an exact ARM64 AL2023 AMI ID before synthesis; routine reruns preserve it, and intentional changes require the explicit reviewed `pnpm ami:upgrade` workflow. `setup.sh` and `pnpm cdk:deploy` still run a read-only guard and refuse an existing stack while either legacy SES resource remains managed, the deployed EC2 resource differs from current CDK, or the exact desired AMI differs from the deployed instance. Template equality cannot prove safety for a dynamic AMI because CloudFormation may re-resolve it during an update and replace the instance. Existing non-converged stacks must continue through reviewed pinned-instance bridges until a separately planned replacement/restore is intentional.

- To ship additional non-instance infrastructure while the instance remains legacy, repeat the `prepare-bridge` and `execute-bridge` stages; the adopted live instance resource, actual UserData bytes, and pinned parameter definition/value are preserved each time.
- Before converging the EC2 definition, make and verify an application-consistent backup plus a completed snapshot of the exact root volume, test the restore path, and review a dedicated final change set that explicitly states whether replacement occurs. Alternatively, change the desired CDK instance properties so CloudFormation reports no replacement. A raw `cdk deploy` bypasses the repository guard and is therefore an explicit operator exception, not a migration step.
- Do not delete the retained SES rule set merely to make a diff disappear. Account-wide activation remains operator-owned.

If any identity, tag, attachment, template type, policy, parameter, change-set, waiter, or post-update assertion fails, stop and investigate. Do not weaken the checks or switch to resource-name-only matching.
