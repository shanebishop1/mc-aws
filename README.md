# On-Demand Minecraft Server on AWS

`mc-aws` deploys a Minecraft server to AWS and a control panel to Cloudflare Workers. The panel supports Google sign-in, server lifecycle controls, an email allowlist, cost views, and optional Google Drive backups.

## Production setup

Use [Setup and Run](docs/setup/SETUP_AND_RUN.md). It is the complete production procedure and covers both required `setup.sh` passes.

## Hosting choices

Cloudflare Workers hosts the panel and is mandatory. Choose either:

- the account's `workers.dev` hostname; no custom domain is needed
- a custom Cloudflare hostname

Choose the Minecraft address separately:

- Cloudflare DNS on a custom domain
- a DuckDNS hostname
- the current public IP shown in the panel

Setup prints the exact panel origin and Google sign-in/Drive callback URLs. Copy those values into the Google OAuth client, including for `workers.dev`; do not construct the URLs yourself.

## Operation and cost

Use the web panel for production changes. The server automatically stops after about 15 minutes of consecutive successful zero-player checks. A stopped instance no longer incurs EC2 compute charges, but its EBS volume still costs money.

The first deployment starts EC2 and Minecraft immediately, so billing starts during deployment. After deployment, wait for the instance and Minecraft readiness checks before connecting players or testing backups.

Hibernate backs up the server and removes its root volume. Configure Drive and test backup and restore first. On resume, choose `latest`, a named backup, or `fresh` for a new server; omitting the choice also starts fresh.

Costs vary by region, instance type, storage, snapshots, data transfer, API usage, optional services, free-tier eligibility, and provider pricing. Review the deployment preflight and monitor AWS Billing after deployment.

## Access

- `ADMIN_EMAIL` has administrative panel access.
- `ALLOWED_EMAILS` seeds the initial list of users who can start the server.
- Other signed-in users receive public/read-only access.
- SSH ingress is blocked by default. Use AWS Systems Manager Session Manager for shell access.

## Development

For local development without AWS, use [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md). Do not run production setup merely to install development tools.

## Documentation

- [Setup and Run](docs/setup/SETUP_AND_RUN.md)
- [Documentation index](docs/README.md)
- [Operations Guide](docs/OPERATIONS_GUIDE.md)
- [Server Profiles](docs/SERVER_PROFILES.md)
- [Teardown](docs/TEARDOWN.md)
