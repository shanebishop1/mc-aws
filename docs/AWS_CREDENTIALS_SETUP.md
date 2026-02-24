# AWS Credentials Setup

This guide covers the AWS credentials needed by `mc-aws` for both local control-panel usage and production runtime.

## What AWS credentials are used for

The app uses AWS credentials to:

- Read server/stack status
- Start/stop/resume/hibernate operations
- Run backup/restore commands through SSM/Lambda
- Read and update allowlist parameters in SSM
- Read AWS costs
- Deploy infrastructure with CDK (`pnpm cdk:deploy` or `pnpm setup`)

## Recommended approach

Use a dedicated IAM user (or role) instead of root credentials.

## Create IAM access keys

1. Open AWS Console -> IAM -> Users.
2. Create a user (example: `minecraft-control-panel`).
3. Create an access key for CLI/application usage.
4. Save:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

## Permissions (pragmatic starter set)

For fastest setup, attach policies that cover the current feature set:

- `AmazonEC2FullAccess`
- `AmazonSSMFullAccess`
- `AWSLambda_FullAccess`
- `AmazonSESFullAccess`
- `AWSCloudFormationFullAccess`
- `AWSBillingReadOnlyAccess` (or equivalent Cost Explorer read access)

You can tighten this later with least-privilege policies after confirming your workflow.

## Add credentials to env files

Copy from template first:

```bash
cp .env.example .env.production
cp .env.example .env.local
```

Set values in your deployment env file:

```bash
AWS_REGION=us-west-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_ACCOUNT_ID=123456789012
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=us-west-1
```

`pnpm deploy:cf` uses `.env.production` by default (or `ENV_FILE` if explicitly set).

Notes:

- `pnpm setup` can fill most of this for you through the wizard.
- `INSTANCE_ID` is populated automatically during setup/deploy.

## Configure AWS CLI (recommended)

```bash
aws configure
aws sts get-caller-identity
```

Use the same key/secret/region as above.

## Where these creds are used

- **Local development (`pnpm dev`)**: backend API routes call AWS services directly.
- **Infrastructure deploy (`pnpm cdk:deploy`)**: CDK uses your AWS CLI/session credentials.
- **Production deploy (`pnpm deploy:cf`)**: AWS credentials from the selected deployment env file are uploaded as Worker secrets.

## Common issues

### `Unable to locate credentials`

- Check your deployment env file for `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
- Restart dev server after updating env files.
- Run `aws sts get-caller-identity` to verify CLI credentials.

### `security token included in the request is invalid`

- Access key is wrong, disabled, or deleted.
- Generate a new key and update env files.

### `not authorized to perform ...`

- IAM policy is missing required permission.
- Add the required policy, then retry.

### `No default region configured`

- Set `AWS_REGION` in your deployment env file.
- Optionally set CLI default region via `aws configure`.

## Related docs

- [Cloudflare Setup](CLOUDFLARE_SETUP.md)
- [Google OAuth Setup](GOOGLE_OAUTH_SETUP.md)
- [README](../README.md)
