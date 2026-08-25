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
11. Writes strict resource IDs, immutable StackId/Worker deployment evidence, and created-versus-pre-existing ownership facts to the ignored, non-secret mode-`0600` `.mc-aws-deployment.json` manifest used by safe teardown. Setup refuses to overwrite unproven same-name stacks or Workers.

Immediately before the first chargeable CDK deployment, setup shows the authenticated AWS account, region, fixed `t4g.medium` instance with 8 GB GP3 root volume, resource categories, cost caveats, and teardown commands. It proceeds only after you type `DEPLOY`. Review the identity and region carefully; cancellation creates no stack resources.

## 3. Wizard Inputs

The wizard collects:

- AWS region (the script uses your already-authenticated local AWS CLI/SSO session)
- optional EC2 key pair name
- Google OAuth client ID and secret
- admin and allowed-user emails
- Minecraft connection mode: Cloudflare custom domain, DuckDNS free subdomain, or raw public IP
- panel hosting mode, independently: generated `workers.dev` URL or custom Cloudflare hostname
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

Panel hosting is separate from the Minecraft connection mode. Every Minecraft mode works with either panel mode:

- `workers.dev`: enter your account subdomain (`account-name`, `account-name.workers.dev`) or full expected Worker URL. Setup validates it against the Worker name, derives and saves `NEXT_PUBLIC_APP_URL`, enables `workers_dev`, deploys without `--route`, skips panel DNS checks, and verifies the resulting URL.
- Custom Cloudflare hostname: enter an HTTPS origin plus the panel zone ID and a zone-scoped token with DNS Read/Edit and Workers Routes Read/Edit. These deploy/teardown panel credentials are separate from Minecraft DNS credentials and are not uploaded as Worker runtime secrets. Setup safely ensures a proxied panel record, records pre-existing route/DNS state, deploys with `--route`, and explicitly asks whether `workers.dev` should stay enabled.

When setup prints the panel URL, add these exact values to the Google OAuth web client:

- Authorized JavaScript origin: `<panel-origin>`
- Sign-in redirect URI: `<panel-origin>/api/auth/callback`
- Google Drive redirect URI: `<panel-origin>/api/gdrive/callback`

For example, Workers hosting might use `https://mc-aws-panel.account-name.workers.dev` with both `/api/auth/callback` and `/api/gdrive/callback` on that exact origin.

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

Browser/E2E tests require Playwright Chromium once per development environment:

```bash
pnpm exec playwright install chromium
pnpm test:e2e:mock
```

## 9. Teardown

Inventory and preview removal without mutation:

```bash
pnpm destroy
```

After reviewing the live inventory, execute with an account-specific typed confirmation:

```bash
pnpm destroy:execute
```

Do not remove `.mc-aws-deployment.json` before teardown. See [Ownership-Aware Teardown](../TEARDOWN.md) for retained backups, failure recovery, manual removal, OAuth/credential cleanup, and billing verification.
