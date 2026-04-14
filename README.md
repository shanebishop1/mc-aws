# On-Demand Minecraft Server on AWS

<p align="center"><img width="320" height="320" alt="mc-aws-image" src="https://github.com/user-attachments/assets/2d77fd09-d9d9-4f23-9830-826b6cd68a57" /></p>

Run your own Minecraft server on AWS, control it from a web app, and keep idle cost low by stopping or hibernating when nobody is playing.

This project is web-app first. CLI/manual shell flows are supported as optional add-ons.

## Quick Setup (Production)

If you want the fastest path from clone to a live panel and server, just run the setup script.

You do not need Node.js, `pnpm`, or `mise` installed ahead of time. `./setup.sh` checks for `mise`, installs it if needed, activates it for the current setup session, and then uses it to install the correct Node.js and `pnpm` versions for this project.

```bash
git clone <your-repo-url>
cd mc-aws
bash ./setup.sh
```

`./setup.sh` automatically:

1. Installs/verifies `mise`
2. Activates `mise` for the current setup run and your future shell sessions
3. Uses `mise` to install the correct Node.js and `pnpm` versions for this project
4. Installs project dependencies
5. Launches the credential wizard (`scripts/setup-wizard.sh`)
6. Deploys AWS infrastructure with CDK
7. Stores deployment outputs (including `INSTANCE_ID`) in `.env.production` and `.env.local`
8. Deploys the Next.js app to Cloudflare Workers

### Accounts/credentials you should have ready

- AWS account (for EC2/Lambda/SSM/SES/CDK)
- Cloudflare zone + DNS API token (for runtime DNS updates)
- Google OAuth client (for web app sign-in)
- GitHub token (`repo` scope) plus repo/user values (currently required by CDK setup in this repo)

Setup guides:

- [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md)
- [Cloudflare Setup](docs/CLOUDFLARE_SETUP.md)
- [Google OAuth Setup](docs/GOOGLE_OAUTH_SETUP.md)

## Web App Usage (Primary Interface)

### Run locally against AWS

```bash
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`.

Local auth options:

- Google sign-in (when OAuth env vars are configured)
- Dev login route: `http://localhost:3000/api/auth/dev-login` (`pnpm dev` enables this by default)

### What the panel handles

- Server status, health, and player visibility
- Start, stop, resume, and hibernate operations
- Backup, restore, and backup listing
- Cost views and email allowlist management
- Admin shortcuts for common operational tasks

### Role model

- `ADMIN_EMAIL`: full access
- `ALLOWED_EMAILS`: can check status and start
- signed-in users not listed above: status-only

## CLI Addendum (Optional)

The web app is the default workflow. If you want terminal control, these commands are available:

```bash
pnpm server:status
pnpm server:start
pnpm server:stop
pnpm server:resume
pnpm server:hibernate
pnpm server:backup
pnpm server:backups
pnpm server:restore -- <backup-name>
pnpm operations:cleanup
pnpm operations:cleanup -- --dry-run --retention-days=14
```

Durable operation-state records in SSM (`/minecraft/operations/*`) default to a 30-day retention window.
Set `MC_OPERATION_STATE_RETENTION_DAYS` to override that window.

Manual EC2 shell access (advanced):

```bash
./bin/connect.sh
./bin/console.sh
```

## Deploying Updates

After initial setup, normal app updates are usually:

```bash
wrangler login
pnpm deploy:cf
```

`pnpm deploy:cf` uses `.env.production` by default.

It also writes a temporary `.env.production.local` during build so `next build` cannot be overridden by `.env.local`.

For explicit control:

```bash
ENV_FILE=.env.production pnpm deploy:cf
```

For infrastructure changes:

```bash
pnpm cdk:diff
pnpm cdk:deploy
```

## Troubleshooting (Quick)

### `./setup.sh` fails

- Ensure `aws sts get-caller-identity` works
- Ensure `.env.production` has required values from the wizard
- Re-run `./setup.sh`

### `node` or `pnpm` is not found

- Re-run `./setup.sh` so it can finish the `mise` setup step
- If it still fails, check whether `mise` was installed to `~/.local/bin/mise`
- Restart your terminal, then run `./setup.sh` again

### Google login redirect mismatch

- Add exact callback URLs in Google Console:
  - `http://localhost:3000/api/auth/callback`
  - `https://<your-panel-domain>/api/auth/callback`
- Make sure `NEXT_PUBLIC_APP_URL` matches the deployed panel URL

### Cloudflare deployment auth issues

- Use Wrangler OAuth: `wrangler login`
- Keep DNS runtime token in your deployment env file as `CLOUDFLARE_DNS_API_TOKEN`
- Avoid exporting `CLOUDFLARE_DNS_API_TOKEN` globally in your shell

## Key Docs

- [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md)
- [Cloudflare Setup](docs/CLOUDFLARE_SETUP.md)
- [Google OAuth Setup](docs/GOOGLE_OAUTH_SETUP.md)
- [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md)
- [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)
