# AWS Credential Boundary

`mc-aws` deliberately uses separate AWS identities for local deployment and the deployed Cloudflare Worker.

## Human/deployment identity

Use AWS IAM Identity Center / SSO locally when possible:

```bash
aws configure sso
aws sso login --profile <profile>
AWS_PROFILE=<profile> aws sts get-caller-identity
AWS_PROFILE=<profile> bash ./setup.sh
```

A local `aws configure` access-key profile is a pragmatic fallback. Root credentials are never appropriate. CDK, CloudFormation output lookup, and runtime-key rotation use this local AWS CLI credential chain. Setup does not ask for a human access key and never sends the local deployment identity to Cloudflare.

Ignored local env files may still contain credentials from an older deployment. The general Worker secret uploader explicitly skips `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from those files.

## Dedicated Worker runtime identity

The CDK stack creates one tagged IAM user for the Cloudflare Worker and an inline least-privilege policy. It does **not** create an `AWS::IAM::AccessKey`, output a key, or write a key to a project file.

The runtime policy is derived from the deployed API call graph:

| Capability | AWS actions | Scope |
| --- | --- | --- |
| Instance status | `ec2:DescribeInstances` | `*` because this describe action has no resource-level IAM support |
| Stop | `ec2:StopInstances` | Managed instance ARN only |
| Start/backup/restore/hibernate/resume | `lambda:InvokeFunction` | Lifecycle Lambda ARN only |
| Stack status and Lambda-name lookup | `cloudformation:DescribeStacks` | Managed stack ARN only |
| Service checks | `ssm:SendCommand` | Managed instance and `AWS-RunShellScript` document only |
| Command results | `ssm:GetCommandInvocation` | `*` because this action has no resource-level IAM support |
| Runtime state/config | `ssm:GetParameter`, `ssm:GetParametersByPath`, `ssm:PutParameter`, `ssm:DeleteParameter` | Only the exact `/minecraft` parameters and operation/lock subpaths used by the app |
| Optional cost view | `ce:GetCostAndUsage` | `*` because Cost Explorer does not support resource-level scope |

Set `AWS_COST_EXPLORER_ENABLED=false` before CDK deployment to omit Cost Explorer permission. The runtime identity has no IAM administration, CloudFormation mutation, EC2 termination, deployment, or lifecycle-volume permissions.

## Key creation and rotation

`setup.sh` deploys the IAM identity, locates its non-secret user-name output, deploys the Worker, and runs `scripts/rotate-worker-runtime-key.sh`. The rotation flow:

1. Confirms the IAM user has the project runtime-identity tags.
2. Refuses to proceed if two active keys would require deleting a valid key first.
3. Creates a replacement key in process memory only.
4. Pipes it directly to Wrangler under temporary candidate secret names.
5. Calls an ephemeral bearer-protected Worker probe that uses the candidate key to describe only the managed instance.
6. Promotes the verified candidate to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` and verifies the primary binding.
7. Deactivates prior keys belonging to the dedicated runtime user, verifies again, and reactivates them if that check fails.
8. Deletes revoked prior keys and removes candidate/probe/session-token Worker secrets.

The secret access key is never a CloudFormation output, command-line argument, tracked file, or project env-file value.

To rotate later, authenticate both local CLIs and run:

```bash
aws sso login --profile <profile>
pnpm exec wrangler login
AWS_PROFILE=<profile> \
VERIFY_URL=https://panel.example.com \
bash scripts/rotate-worker-runtime-key.sh
```

Use the exact deployed panel origin for `VERIFY_URL`. If candidate verification fails, the new candidate is removed and every prior runtime key remains valid. If a later promotion check fails, prior keys are left active or reactivated and the script stops for investigation.

## Existing deployment migration

Do **not** begin by re-running `setup.sh` on a legacy stack. Follow [Existing Deployment Safety Migration](EXISTING_DEPLOYMENT_MIGRATION.md) so the old SES activation is retained and the live EC2 instance is pinned while the stack adds the dedicated identity. Because routine setup remains guarded while the EC2 definition is intentionally pinned, continue with `pnpm deploy:cf` after the bridge; that deployment locates the new stack output and runs the verified runtime-key rotation. Rotation only manages keys attached to the tagged dedicated runtime user; it never deactivates or deletes the human identity whose credentials an older Worker may have used.

After the replacement verifies:

- Remove obsolete human AWS values from ignored project env files if you no longer need them there.
- Rotate or delete the old human key only if it is active, over-privileged, or exposed, and only after confirming no other local tooling uses it.
- Do not delete a valid old credential merely because it exists in a mode-`0600`, ignored local file.

## Residual tradeoff

Cloudflare Workers cannot directly assume an AWS IAM role through instance metadata or workload identity in this deployment model, so the Worker retains a long-lived IAM user key in Cloudflare encrypted secrets. The blast radius is reduced through a dedicated identity, narrow action/resource policy, direct secret upload, and verified rotation, but periodic rotation and Cloudflare account security remain operator responsibilities.

## Troubleshooting

- `Unable to locate credentials`: run `aws sts get-caller-identity` with the same `AWS_PROFILE` used for setup.
- Two active runtime keys: identify a stale key on the tagged runtime user and deactivate it; the script intentionally will not guess or delete an active key.
- Probe failure: inspect Worker logs and IAM policy drift. Do not manually delete the prior key until the replacement probe succeeds.
- Missing runtime-user output: deploy the current CDK stack before running standalone rotation.

Related: [AWS Account Setup](setup/AWS_ACCOUNT_SETUP.md), [Setup and Run](setup/SETUP_AND_RUN.md), and [Cloudflare Setup](CLOUDFLARE_SETUP.md).
