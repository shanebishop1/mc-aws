# AWS Credential Boundary

`mc-aws` uses separate AWS identities for deployment and runtime.

## Deployment identity

Prefer temporary IAM Identity Center/SSO credentials:

```bash
aws sso login --profile <profile>
AWS_PROFILE=<profile> aws sts get-caller-identity
AWS_PROFILE=<profile> bash ./setup.sh
```

An access-key profile is a fallback. Never use root credentials. Setup, CDK, and CloudFormation use the local AWS CLI credential chain; they do not upload the human identity to Cloudflare.

`.env.local` and `.env.production` are gitignored but credential-bearing. They contain application secrets and provider tokens and may contain old AWS credentials from earlier versions. Protect them and never commit or share them. For an older deployment, use [Existing Deployment Migration](EXISTING_DEPLOYMENT_MIGRATION.md), not setup.

## Worker runtime identity

CDK creates an IAM user for the panel. It can invoke the lifecycle Lambda, stop the instance, run SSM shell commands, and access selected SSM parameters, including the Drive credential. When cost reporting is enabled, it can also read account-wide Cost Explorer data. It cannot administer IAM, terminate EC2 instances, mutate CloudFormation, or deploy infrastructure.

Setup creates a runtime access key in memory, uploads it directly to Cloudflare encrypted secrets, verifies it against the managed instance, and only then revokes the previous runtime key. The secret key is not written to a project env file, command argument, or CloudFormation output.

Cloudflare Workers cannot use EC2 instance metadata or this deployment's workload identity, so the runtime key remains long-lived in Cloudflare. Protect both accounts and rotate the key periodically.

`pnpm deploy:cf` rotates the Worker runtime key after deployment. Updating an existing Worker requires its matching setup-generated `.mc-aws-deployment.json`, `.env.production`, AWS session, and Cloudflare authentication. A first deployment can create the local record. The command verifies the replacement key before revoking the old one.

Related: [AWS prerequisite](setup/AWS_ACCOUNT_SETUP.md), [Cloudflare prerequisite](setup/CLOUDFLARE_SETUP.md), and [Setup and Run](setup/SETUP_AND_RUN.md).
