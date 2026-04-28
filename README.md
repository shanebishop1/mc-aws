# On-Demand Minecraft Server on AWS

<p align="center"><img width="320" height="320" alt="mc-aws-image" src="https://github.com/user-attachments/assets/2d77fd09-d9d9-4f23-9830-826b6cd68a57" /></p>

Run a Minecraft server on AWS without paying to leave it running all the time. Friends can sign in, check the server status, and start it when they want to play.

## Features

- Web panel for start, stop, resume, and hibernate
- Google sign-in with admin and allowed-user roles
- Cloudflare DNS updates when the server IP changes
- Backup and restore with Google Drive
- Optional CLI commands

## Before Setup

Complete these first:

- [Fork this repo](docs/setup/GITHUB_REPO_SETUP.md)
- [Create a GitHub token](docs/setup/GITHUB_TOKEN_SETUP.md)
- [Prepare your AWS account](docs/setup/AWS_ACCOUNT_SETUP.md)
- [Set up a Cloudflare-managed domain](docs/setup/CLOUDFLARE_SETUP.md)
- [Create a Google OAuth client](docs/setup/GOOGLE_OAUTH_SETUP.md)

Optional:

- [Create an EC2 key pair](docs/setup/EC2_KEY_PAIR_SETUP.md), if you want SSH key access
- [Configure SES email features](docs/setup/SES_SETUP.md), if you want email-triggered actions and notifications
- [Configure Google Drive backups](docs/setup/GOOGLE_DRIVE_SETUP.md), if you want backup, restore, and hibernate workflows

## Setup

After the prerequisites are done, run the setup script from your fork:

```bash
git clone https://github.com/<you>/mc-aws.git
cd mc-aws
bash ./setup.sh
```

The script installs the project toolchain, collects credentials, deploys AWS infrastructure, writes deployment outputs, and deploys the web app to Cloudflare.

For the full walkthrough, use [Setup and Run](docs/setup/SETUP_AND_RUN.md).

## Local Development

Use mock mode if you want to work on the app without AWS:

```bash
pnpm install
pnpm dev:mock
```

Open `http://localhost:3000/api/auth/dev-login` to sign in as a local admin.

More detail:

- [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md)
- [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)

## Using the Panel

The web app is the primary interface. It handles:

- Server status, health, and player visibility
- Start, stop, resume, and hibernate operations
- Backup, restore, and backup listing
- Cost views and email allowlist management
- Admin shortcuts for common operations

Roles:

- `ADMIN_EMAIL`: full access
- `ALLOWED_EMAILS`: can check status and start
- Other signed-in users: status-only

## Start, Stop, Resume, Hibernate

- `start`: starts the server in the normal path
- `stop`: stops the instance but keeps storage attached
- `hibernate`: backs up the server, stops the instance, and deletes attached instance volumes
- `resume`: recreates storage and brings a hibernated server back online

Use `stop` for shorter pauses. Use `hibernate` when the server will be idle long enough that you want to avoid EBS storage cost too.

Hibernate is intentionally destructive. Resume reconstructs the root volume from the instance's own source AMI metadata. If that metadata cannot be resolved, resume fails instead of guessing.

## Backups

Backup and restore use Google Drive.

If Google Drive is not configured, backup, restore, and hibernate flows are not useful. Configure it during setup or from the web panel before relying on those operations.

See [Operations Guide](docs/OPERATIONS_GUIDE.md) for day-to-day backup, restore, and recovery notes.

## CLI

The CLI is optional. It calls the app API and defaults to `http://localhost:3000/api`.

```bash
pnpm server:status
pnpm server:start
pnpm server:stop
pnpm server:resume
pnpm server:hibernate
pnpm server:backup
pnpm server:backups
pnpm server:restore -- <backup-name>
```

To point it at another panel API:

```bash
API_BASE=https://panel.yourdomain.com/api pnpm server:status
```

Advanced shell access:

```bash
./bin/connect.sh
./bin/console.sh
```

## Deploying Updates

For app updates:

```bash
pnpm deploy:cf
```

For infrastructure changes:

```bash
pnpm cdk:diff
pnpm cdk:deploy
```

## Cost Notes

This can reduce idle cost compared with leaving a server running all the time, but it does not make AWS free.

- `stop` stops compute, but attached EBS storage still costs money
- `hibernate` removes attached instance volumes after backup, so it is better for longer idle periods
- Cloudflare, AWS, Google, and GitHub setup are still your responsibility
- Check AWS Billing and Cost Explorer after deployment, especially while testing

## Docs

Setup:

- [Fork this repo](docs/setup/GITHUB_REPO_SETUP.md)
- [Create a GitHub token](docs/setup/GITHUB_TOKEN_SETUP.md)
- [AWS account setup](docs/setup/AWS_ACCOUNT_SETUP.md)
- [Cloudflare setup](docs/setup/CLOUDFLARE_SETUP.md)
- [Google OAuth setup](docs/setup/GOOGLE_OAUTH_SETUP.md)
- [Setup and Run](docs/setup/SETUP_AND_RUN.md)

Operations:

- [Operations Guide](docs/OPERATIONS_GUIDE.md)
- [API Reference](docs/docs/API.md)

Development:

- [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md)
- [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)

## Troubleshooting

### Setup fails

- Run `aws sts get-caller-identity` and confirm AWS CLI access works
- Check `.env.production` for missing values
- Re-run `bash ./setup.sh`

### Google login fails

- Add the exact callback URLs in Google Cloud
- Make sure `NEXT_PUBLIC_APP_URL` matches the deployed panel URL

### Cloudflare deployment auth fails

- Use Wrangler OAuth for deployment auth
- Keep `CLOUDFLARE_DNS_API_TOKEN` for runtime DNS updates only
- Do not export the DNS token globally in your shell
