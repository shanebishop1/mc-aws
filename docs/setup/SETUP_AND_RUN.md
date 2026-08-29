# Setup and Run

This is the complete procedure for a new production deployment.

## 1. Prepare accounts and tools

You need:

- `git`, AWS CLI v2, `curl`, `python3`, `openssl`, and a browser
- an AWS account with a default VPC in the deployment region
- temporary administrator-level AWS deployment capability, preferably through IAM Identity Center/SSO; never use root credentials
- a Cloudflare account with Workers enabled; a custom domain is optional
- a Google OAuth **Web application** client ID and secret

Before reading `.env.production` or any other credential file, setup uses a cleared environment to download the exact platform binary in [`config/mise-pins.json`](../../config/mise-pins.json), verifies its reviewed SHA-256, verifies its version output, and installs it at `~/.local/bin/mise`. It never runs a mutable curl pipe. Review the pin with `bash scripts/bootstrap-mise.sh review`; an intentional pin change is installed only with `pnpm mise:upgrade -- --confirm '<exact review output>'`. Setup does not activate `mise` in the calling shell.

Review the required account guides:

- [AWS account](AWS_ACCOUNT_SETUP.md)
- [Cloudflare](CLOUDFLARE_SETUP.md)
- [Google OAuth client creation](GOOGLE_OAUTH_SETUP.md)

Optional features have separate prerequisites: [DuckDNS](DUCKDNS_SETUP.md), [Google Drive](GOOGLE_DRIVE_SETUP.md), and [SES](SES_SETUP.md).

## 2. Authenticate AWS

Use a temporary SSO session when possible:

```bash
aws configure sso
aws sso login --profile <profile>
AWS_PROFILE=<profile> aws sts get-caller-identity
```

Confirm the returned account before proceeding. Keep the same profile active for both setup passes and CDK bootstrap.

The deployment identity must temporarily be able to bootstrap CDK and create or update IAM, CloudFormation, EC2, SSM, Lambda, and related resources. This repository does not provide a least-privilege policy for human deployment. Remove or reduce that access after deployment.

## 3. Clone and run the first pass

```bash
git clone https://github.com/shanebishop1/mc-aws.git
cd mc-aws
AWS_PROFILE=<profile> bash ./setup.sh
```

On a clean clone, setup installs the toolchain, creates ignored `server-profile/`, and exits before collecting credentials or creating cloud resources. This two-pass behavior prevents deployment with an empty player whitelist.

For commands you run yourself, add the installer location to `PATH`, install the pinned tools, and invoke pnpm through `mise` exactly as shown:

```bash
export PATH="$HOME/.local/bin:$PATH"
mise install
```

Edit `server-profile/whitelist.json`. A minimal valid file is:

```json
[
  { "uuid": "123e4567-e89b-42d3-a456-426614174000", "name": "PlayerName" }
]
```

Replace both fields with the intended player's real Minecraft UUID and name. Then validate it:

```bash
AWS_PROFILE=<profile> mise exec -- pnpm profile:validate
```

See [Server Profiles](../SERVER_PROFILES.md) for the file format and other server settings.

## 4. Bootstrap CDK and run the deployment pass

After authentication and the first setup pass, bootstrap the selected account and region once. This creates CDK support resources and requires the temporary administrator-level deployment capability described above:

```bash
export PATH="$HOME/.local/bin:$PATH"
AWS_PROFILE=<profile> mise exec -- pnpm exec cdk bootstrap aws://<account-id>/<region>
```

Then rerun setup:

```bash
AWS_PROFILE=<profile> bash ./setup.sh
```

The wizard asks for:

- AWS region
- Google OAuth client ID/secret, admin email, and optional allowed emails
- Minecraft address: Cloudflare DNS, DuckDNS, or raw public IP
- panel host: `workers.dev` or a custom Cloudflare hostname
- optional SES and Google Drive settings
- optional CloudWatch alarm email and explicit weekly Drive-backup opt-in

An EC2 key pair is optional, but port 22 is blocked by default. Leave it blank and use AWS Systems Manager Session Manager.

The wizard writes `.env.local` and `.env.production`. These gitignored files contain credentials and secrets, including the Google client secret and DNS tokens. Protect them; do not commit or share them.

### Cloudflare choices

Choose `workers.dev` or a custom panel hostname. For a custom hostname, follow [Cloudflare Prerequisite](CLOUDFLARE_SETUP.md). In the wizard, **External DNS** means an existing proxied Cloudflare record managed outside setup. Panel hosting and the Minecraft address are independent.

### Google URLs printed during setup

Pause after panel hosting is chosen and copy setup's exact printed origin, sign-in callback, and Drive callback into the OAuth Web client. This applies to custom hosts and `workers.dev`; do not construct the values yourself. [Google OAuth Prerequisite](GOOGLE_OAUTH_SETUP.md) is the canonical URL and consent-screen guide.

### Deployment confirmation

Setup validates the AWS identity, region, profile, optional SES inbound prerequisites, and pinned AMI. It then displays chargeable resources and proceeds only when you type `DEPLOY`.

The deployment uses the region's default VPC, a public subnet, a `t4g.medium` instance, and an encrypted 8 GB GP3 root volume. It deploys AWS resources with CDK, deploys the panel to Cloudflare Workers, creates runtime-state resources, and provisions a dedicated AWS runtime key directly into Cloudflare. The first deployment starts EC2 and Minecraft immediately, so compute billing begins during deployment.

## 5. Finish configuration

After setup completes:

1. Confirm the Google OAuth client contains the exact printed origin and callbacks.
2. Open the printed panel URL and sign in as `ADMIN_EMAIL`.
3. Wait for the instance to report running, then check Minecraft service readiness in the panel.
4. If using Drive, connect it in the panel, create a test backup, and restore that backup.
5. If `MC_ALARM_EMAIL` is set, accept AWS's SNS **Subscription Confirmation** email; alerts are not delivered before confirmation.
6. Connect using the displayed address and confirm the server works.
7. Check AWS Billing and Cost Explorer.

Use the web panel for production mutations. The repository's `scripts/server-cli.ts` sends no authentication, so its start/stop/backup/restore commands do not work against authenticated production routes.

## Runtime and cost behavior

The instance stops after about 15 minutes of consecutive successful probes showing zero players. Probe failures suppress the automatic stop. Stopping ends EC2 compute charges, but the attached EBS volume remains billed.

Hibernate backs up, stops the instance, and deletes the project-managed root volume. Do not hibernate until Google Drive is configured and a backup and restore have been tested. When resuming, explicitly choose the latest backup, a named backup, or a fresh server; a request without a restore choice starts fresh.

Any cost examples are estimates, not quotes. Actual charges depend on region, instance and storage pricing, snapshots, data transfer, request volume, optional SES/Cloudflare services, taxes, free-tier eligibility, and pricing changes.

The production monitoring baseline adds 30-day CloudWatch log retention, standard alarms, custom operation/backup metrics, an SNS alarm topic, and an encrypted 14-day failure queue. At low volume these are commonly around $1–3/month, principally CloudWatch charges. Optional weekly backup and daily freshness schedules usually add pennies in EventBridge/Lambda/SSM requests and do not start stopped EC2 capacity. See [Operations Guide](../OPERATIONS_GUIDE.md#monitoring-and-alerts) for thresholds, retention, RPO, and the explicit CloudTrail limitation.

## Updates and teardown

Redeploy the Cloudflare Worker and rotate its AWS runtime key:

```bash
AWS_PROFILE=<profile> mise exec -- pnpm deploy:cf
```

This requires the matching `.mc-aws-deployment.json`, `.env.production`, AWS session, and Cloudflare authentication described in [Cloudflare Prerequisite](CLOUDFLARE_SETUP.md). An interrupted run is recovered before a new deployment; preserve the active record and see [Cloudflare deployment recovery](../CLOUDFLARE_DEPLOYMENT_RECOVERY.md).

Review infrastructure changes before deployment:

```bash
AWS_PROFILE=<profile> mise exec -- pnpm cdk:diff
AWS_PROFILE=<profile> mise exec -- pnpm cdk:deploy
```

These ordinary commands intentionally refuse an existing-host AMI/UserData replacement. For AMI, bootstrap-pin, helper, or OS security maintenance, use [Reviewed Bootstrap and OS Upgrades](../BOOTSTRAP_UPGRADES.md). UserData is launch-only and is never described as an existing-host update mechanism.

`pnpm cdk:deploy` loads the same preferred deployment file as the CDK app (`.env.production`, falling back to `.env.local`) while preserving explicit non-empty `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` shell overrides. It verifies that the active AWS caller, region, stack, and synthesized CDK environment agree before any DNS credential write. Only after that guard succeeds does it write the selected Cloudflare or DuckDNS token directly to SSM as a `SecureString`; token values are never added to CDK or AWS CLI arguments. `setup.sh` also waits for the explicit `DEPLOY` confirmation before this write.

Preview teardown:

```bash
AWS_PROFILE=<profile> mise exec -- pnpm destroy
```

Read [Safe Teardown](../TEARDOWN.md) before executing removal. Keep `.mc-aws-deployment.json`; teardown uses it to identify the exact resources created or changed for this deployment.

## Troubleshooting

- AWS authentication: run `AWS_PROFILE=<profile> aws sts get-caller-identity` and retry with the same profile.
- CDK bootstrap errors: rerun the account/region bootstrap command in step 4.
- No default VPC: recreate one in the selected region or use a region with a default VPC; the current stack does not accept a custom VPC ID.
- Google `redirect_uri_mismatch`: copy the exact origin and callbacks printed by setup.
- Wrangler login problems: let setup authenticate its isolated Wrangler home; remove unrelated globally exported Cloudflare DNS tokens.
- Custom external panel failure: export `CLOUDFLARE_API_TOKEN` with account Workers scripts/secrets/KV access plus zone read and Workers Routes Read/Edit access.
