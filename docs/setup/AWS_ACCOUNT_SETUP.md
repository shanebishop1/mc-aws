# AWS Account Setup

Use a real AWS account, but do not use the root user for daily work.

## 1. Create Or Choose An AWS Account

Use a dedicated account if you can. It makes billing, cleanup, and permissions easier to reason about.

AWS account docs:

- https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-creating.html

## 2. Secure The Root User

1. Sign in as the root user once.
2. Enable MFA for the root user.
3. Do not create root access keys.
4. Store root recovery details somewhere safe.

AWS docs:

- https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html
- https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html

## 3. Create A Non-Root Admin Path

For human access, AWS recommends temporary credentials and federation where possible.

Recommended path:

1. Set up IAM Identity Center.
2. Create a user for yourself.
3. Assign administrator access for the account while getting started.
4. Use AWS CLI SSO locally.

AWS docs:

- https://docs.aws.amazon.com/singlesignon/latest/userguide/getting-started.html
- https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html

Pragmatic fallback:

1. Create an IAM user for deployment.
2. Enable MFA for console access.
3. Create access keys for local CLI/project deployment.
4. Store the keys securely.

Do not use root access keys.

## 4. Permissions For Setup

Fastest path while getting this running:

1. Use an admin permission set if you are using IAM Identity Center.
2. Use an IAM user with broad deployment permissions if you are using access keys.

This project deploys EC2, IAM roles, Lambda, SSM parameters, CloudFormation/CDK resources, SES/SNS pieces, and reads cost data. You can tighten permissions after the first successful deployment.

Do not use root credentials for this.

## 5. Install And Verify AWS CLI

Install AWS CLI v2:

- https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

If using SSO:

```bash
aws configure sso
aws sso login
aws sts get-caller-identity
```

If using access keys:

```bash
aws configure
aws sts get-caller-identity
```

## 6. Pick A Region

Choose a region near the players.

Common choices:

- `us-east-1`
- `us-west-2`
- `eu-west-1`
- `eu-central-1`
- `ap-southeast-1`

Use the same region for AWS CLI, CDK, and project env values.

## 7. Set A Billing Alert

Create an AWS Budget before experimenting.

AWS docs:

- https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html

## Values Needed Later

The setup wizard asks for:

- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

If you use temporary credentials, also keep track of:

- `AWS_SESSION_TOKEN`

The deployed Cloudflare Worker needs AWS credentials as runtime secrets. SSO is good for human CLI access, but the deployed app still needs credentials it can use at runtime.
