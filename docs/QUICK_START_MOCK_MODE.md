# Mock Mode Quick Start

Mock mode is for local development only. It does not deploy or use AWS.

Prerequisites: Git and `mise`. If you manage the pinned Node.js and pnpm versions another way, use the equivalent direct `pnpm` commands.

```bash
git clone https://github.com/shanebishop1/mc-aws.git
cd mc-aws
mise install
mise exec -- pnpm install --frozen-lockfile
cp .env.mock.example .env.local
mise exec -- pnpm dev:mock
```

`.env.local` is gitignored. In this workflow it contains local mock settings; do not reuse a production credential file.

Open `http://localhost:3000/api/auth/dev-login`, then use the panel at `http://localhost:3000`.

In a second terminal, manage mock state with:

```bash
mise exec -- pnpm mock:reset
mise exec -- pnpm mock:scenario
```

Stop the development server before browser tests; Playwright starts its own server:

```bash
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm test:e2e:mock
```

Do not run `setup.sh` to install development tools; it is the production deployment entry point. See the [Mock Mode Developer Guide](MOCK_MODE_DEVELOPER_GUIDE.md) for scenarios and troubleshooting.
