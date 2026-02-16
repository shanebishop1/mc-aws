# On-Demand Minecraft Server on AWS

<p align="center"><img width="320" height="320" alt="mc-aws-image" src="https://github.com/user-attachments/assets/2d77fd09-d9d9-4f23-9830-826b6cd68a57" /></p>

Most Minecraft hosts charge a flat monthly fee whether anyone is playing or not. This project takes a different path: run your own AWS-backed server, manage it from a web control panel, and keep idle cost near zero by hibernating when you're done.

The control panel is the primary interface. CLI, API, and manual shell access are available for advanced operations.

## Overview

- **Primary interface:** Next.js frontend control panel (`pnpm dev` locally, Cloudflare Workers in production)
- **Infrastructure:** AWS CDK stack for EC2, Lambda, SES, SNS, SSM
- **Operational options:** UI first, with optional CLI/API/manual shell scripts for advanced workflows

## Fast Path (Recommended)

If you want the shortest path from clone to working panel + infrastructure:

```bash
git clone https://github.com/you/mc-aws.git
cd mc-aws
pnpm setup
```

`pnpm setup` runs `./setup.sh`, which:

1. Verifies local tooling (`mise`, Node, pnpm, AWS CLI, CDK)
2. Launches the interactive setup wizard for required credentials
3. Deploys AWS infrastructure with CDK
4. Captures stack outputs (including `INSTANCE_ID`)
5. Deploys the frontend to Cloudflare Workers

If you prefer step-by-step manual control, jump to [Manual and Advanced Operations](#manual-and-advanced-operations).

## Required Account Setup (AWS + Cloudflare + Google)

You need all three providers for a full production setup:

- **AWS**: infrastructure + runtime operations
- **Cloudflare**: DNS + Workers deployment
- **Google OAuth**: authentication for the control panel

Use these guides before (or during) `pnpm setup`:

- [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md)
- [Cloudflare Setup](docs/CLOUDFLARE_SETUP.md)
- [Google OAuth Setup](docs/GOOGLE_OAUTH_SETUP.md)

## Frontend-First Daily Usage

### Run the panel locally against AWS

```bash
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000`.

For local auth, you can use either:

- Google sign-in (if OAuth env vars are configured), or
- Dev login route: `http://localhost:3000/api/auth/dev-login`

### What you can do in the UI

- View server state, domain, player count, and service health
- Start or stop the server
- Resume from hibernated state
- Hibernate (backup + stop + detach/delete volume flow)
- Trigger backups and restores
- View AWS cost breakdown
- Manage email allowlist from the panel
- Open AWS console shortcuts (admin)
- Add to iOS home screen for quick access (PWA support)

### Authorization model

- **Admin (`ADMIN_EMAIL`)**: full control
- **Allowed (`ALLOWED_EMAILS`)**: status + start
- **Public (signed in but not listed)**: status only

### Other interfaces (optional)

The same backend is also available through CLI and API.

#### CLI (optional)

```bash
pnpm server:status
pnpm server:start
pnpm server:stop
pnpm server:resume
pnpm server:hibernate
pnpm server:backup
pnpm server:backups
pnpm server:restore <backup-name>
```

#### API (optional)

Main routes live in [`app/api`](app/api). Core endpoints include:

- `GET /api/status`
- `POST /api/start`
- `POST /api/stop`
- `POST /api/resume`
- `POST /api/hibernate`
- `POST /api/backup`
- `POST /api/restore`
- `GET /api/backups`
- `GET /api/costs`
- `GET /api/emails`
- `PUT /api/emails/allowlist`

#### Email trigger path (optional)

If SES is configured, email commands are supported through the `StartMinecraftServer` Lambda flow (`start`, `backup`, `restore`, `hibernate`, `resume`).

## Local Development With Mock Mode

Use mock mode when you want frontend/API development without real AWS resources.

```bash
pnpm dev:mock
pnpm test:mock
pnpm test:e2e:mock
pnpm mock:scenario
pnpm mock:scenario running
pnpm mock:reset
pnpm validate:dev-login
```

Detailed docs:

- [Quick Start Mock Mode](docs/QUICK_START_MOCK_MODE.md)
- [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)

## Manual And Advanced Operations

These paths are optional, but fully supported.

### Manual shell access to the EC2 instance

Prerequisites:

- AWS CLI installed and authenticated
- AWS Session Manager plugin installed
- Minecraft instance currently running

```bash
./bin/connect.sh
./bin/console.sh
```

- `bin/connect.sh`: starts a standard SSM session to the instance
- `bin/console.sh`: attaches to the Minecraft `screen` session directly

### Advanced deployment and infra commands

Use these when you want direct control instead of `pnpm setup`:

```bash
pnpm install
pnpm cdk:synth
pnpm cdk:diff
pnpm cdk:deploy
pnpm deploy:cf
```

Useful extras:

```bash
pnpm cdk:list
pnpm cdk:destroy
pnpm cdk:destroy:force
pnpm preview:cf
```

## Production Deployment (Cloudflare Workers)

For normal updates after initial setup:

```bash
cp .env.example .env
# fill in real values
wrangler login
pnpm deploy:cf
```

`pnpm deploy:cf` runs `scripts/deploy-cloudflare.sh`, which:

1. Validates required values in `.env`
2. Generates `AUTH_SECRET` if needed
3. Uploads secrets/vars to Workers
4. Builds and deploys the app
5. Configures route details from `NEXT_PUBLIC_APP_URL`

Cloudflare details and token setup are documented in [Cloudflare Setup](docs/CLOUDFLARE_SETUP.md).

## Troubleshooting

### `pnpm setup` fails before deployment

- Confirm `mise`, AWS CLI, and dependencies are installed
- Re-run `pnpm install`
- Check `.env` for missing required values

### Google sign-in fails with redirect mismatch

- Verify OAuth redirect URIs include:
  - `http://localhost:3000/api/auth/callback`
  - `https://<your-domain>/api/auth/callback`
- Make sure `NEXT_PUBLIC_APP_URL` matches the deployed domain

### Cloudflare deploy auth issues

- Run `wrangler login` (OAuth) for deployment auth
- Keep DNS runtime token in env files as `CLOUDFLARE_DNS_API_TOKEN`
- Do not export DNS token globally in your shell for Wrangler auth

### Manual shell scripts fail

- Ensure the server is running
- Check AWS CLI profile/credentials and region
- Confirm Session Manager plugin is installed

## Source-Of-Truth Docs

- [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md)
- [Cloudflare Setup](docs/CLOUDFLARE_SETUP.md)
- [Google OAuth Setup](docs/GOOGLE_OAUTH_SETUP.md)
- [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md)
- [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)
- [API Reference](docs/docs/API.md)

## Repo Structure (Quick View)

```text
mc-aws/
├── app/              # Next.js app + API routes
├── components/       # Frontend components
├── hooks/            # Frontend hooks
├── lib/              # Shared AWS/auth/types utilities
├── scripts/          # Setup/deploy/dev helper scripts
├── bin/              # Manual EC2 shell/console scripts
├── infra/            # AWS CDK stack + Lambda/EC2 assets
├── docs/             # Setup guides and deeper docs
└── tests/            # Vitest + Playwright tests
```
