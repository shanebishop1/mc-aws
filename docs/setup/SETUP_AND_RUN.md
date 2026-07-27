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
6. Locates the dedicated least-privilege Worker runtime IAM identity.
7. Reads `INSTANCE_ID` from the CloudFormation stack output.
8. Writes non-secret deployment values to `.env.production` and `.env.local`.
9. Deploys the web app to Cloudflare Workers.
10. Creates a runtime key in memory, uploads it directly to Wrangler, verifies it through the Worker, then revokes any prior key owned by that runtime identity.

## 3. Wizard Inputs

The wizard collects:

- AWS region (the script uses your already-authenticated local AWS CLI/SSO session)
- optional EC2 key pair name
- Google OAuth client ID and secret
- admin and allowed-user emails
- Minecraft connection mode: Cloudflare custom domain, DuckDNS free subdomain, or raw public IP
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
5. Connect from Minecraft using the hostname or public IP shown in the panel.

Connection modes:

- Cloudflare: uses `CLOUDFLARE_MC_DOMAIN` and updates the A record when EC2 gets a new IP.
- DuckDNS: uses `DUCKDNS_DOMAIN.duckdns.org` and updates it when EC2 gets a new IP.
- No domain: shows the current EC2 public IP in the panel. The IP can change after restarts.

Panel hosting is separate from the Minecraft connection mode. If you choose DuckDNS or no-domain mode, you can still use an existing Cloudflare custom panel URL, but automatic panel DNS checks are skipped unless Cloudflare DNS credentials are configured. New users who do not want any custom domain should use the generated `*.workers.dev` panel URL.

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

Rotate only the dedicated Worker runtime key:

```bash
VERIFY_URL=https://panel.example.com bash scripts/rotate-worker-runtime-key.sh
```

The rotation command requires authenticated local AWS CLI and Wrangler sessions. It never uploads the local human/deployment AWS identity.

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
