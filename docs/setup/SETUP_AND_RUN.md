# Setup And Run

This is the project-specific setup after the account prerequisites are done.

## 1. Clone Your Fork

```bash
git clone https://github.com/<you>/mc-aws.git
cd mc-aws
```

Use your fork, not the upstream repo, because the EC2 instance clones the GitHub repo configured during setup.

## 2. Run Setup

```bash
bash ./setup.sh
```

The script:

1. Installs or verifies `mise`.
2. Uses the repo-pinned Node.js and `pnpm` versions.
3. Installs project dependencies.
4. Runs `scripts/setup-wizard.sh`.
5. Deploys AWS infrastructure with CDK.
6. Reads `INSTANCE_ID` from the CloudFormation stack output.
7. Writes deployment values to `.env.production` and `.env.local`.
8. Deploys the web app to Cloudflare Workers.

## 3. Wizard Inputs

The wizard collects:

- AWS region and credentials
- optional EC2 key pair name
- Google OAuth client ID and secret
- admin and allowed-user emails
- Cloudflare DNS token, zone, record, and Minecraft domain
- production panel URL
- optional SES email settings
- GitHub repo and token values
- optional Google Drive backup path values
- generated `AUTH_SECRET`

## 4. First Login

After setup finishes:

1. Open the panel URL.
2. Sign in with `ADMIN_EMAIL`.
3. Check server status.
4. Start the server.
5. Connect from Minecraft using `CLOUDFLARE_MC_DOMAIN`.

## 5. Local Run Against AWS

After setup has written `.env.local`:

```bash
pnpm dev
```

Open `http://localhost:3000`.

Local auth options:

- Google sign-in, if localhost is configured in Google OAuth
- Dev login at `http://localhost:3000/api/auth/dev-login`

## 6. Mock Mode

Mock mode does not need AWS credentials:

```bash
pnpm dev:mock
```

Open `http://localhost:3000/api/auth/dev-login`.

## 7. Deploy Updates

App update:

```bash
pnpm deploy:cf
```

Infrastructure update:

```bash
pnpm cdk:diff
pnpm cdk:deploy
```

## 8. Common Checks

AWS identity:

```bash
aws sts get-caller-identity
```

Typecheck:

```bash
pnpm typecheck
```

Tests:

```bash
pnpm test
```
