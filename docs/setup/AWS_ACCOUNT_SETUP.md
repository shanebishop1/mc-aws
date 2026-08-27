# AWS Account Prerequisite

Production setup needs an AWS account with:

- MFA on the root user and no root access keys
- a non-root deployment identity with temporary administrator-level capability
- a default VPC in the target region
- AWS CLI v2 installed locally
- CDK bootstrapped once for the target account and region

Prefer IAM Identity Center/SSO so deployment uses temporary credentials. An access-key profile is a fallback. Never put root or human AWS keys in project env files. Setup uses the local AWS credential chain and creates a separate deployment-scoped runtime identity for the Worker. Follow [Setup and Run](SETUP_AND_RUN.md) for the exact login and deployment sequence.

The deployment identity must be able to bootstrap CDK and create or update IAM, CloudFormation, EC2, SSM, Lambda, and related resources. This repository does not include a least-privilege human deployment policy. Grant administrator-level capability only for deployment, then remove or reduce it.

Setup does not create a default VPC or bootstrap CDK. The complete procedure, including authentication, tool installation, and bootstrap, is in [Setup and Run](SETUP_AND_RUN.md).

Before deployment, choose a region near the players and create an AWS Budget. Actual charges vary by region, usage, storage, snapshots, data transfer, optional services, and pricing changes.

References: [AWS CLI v2 installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [IAM Identity Center CLI setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html), [root-user security](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html), and [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html).
