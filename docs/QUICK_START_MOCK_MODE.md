# Quick Start Guide for Mock Mode

This guide helps you get started with mock mode in under 5 minutes. Mock mode lets you develop and test the application without AWS credentials or infrastructure.

## Prerequisites

- Node.js 18+ installed
- pnpm installed (`npm install -g pnpm`)
- Git installed

## Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-username/mc-aws.git
cd mc-aws

# Install dependencies
pnpm install
```

## Step 2: Configure Environment

Copy the minimal mock mode configuration:

```bash
cp .env.local.example .env.local
```

The `.env.local` file now contains the minimal configuration needed for mock mode:

```bash
MC_BACKEND_MODE=mock
ENABLE_DEV_LOGIN=true
AUTH_SECRET=dev-secret-change-in-production
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Note:** No AWS credentials are needed in mock mode!

## Step 3: Start Development Server

```bash
# Start in mock mode with dev login enabled
pnpm dev:mock
```

The server will start at `http://localhost:3001`.

## Step 4: Authenticate

Open your browser and visit:

```
http://localhost:3001/api/auth/dev-login
```

You'll be automatically redirected to the home page and logged in as an admin user.

## Step 5: Start Developing

Now you can:

- **View the UI:** Open `http://localhost:3001` in your browser
- **Test scenarios:** Use `pnpm mock:scenario <name>` to switch between states
- **Run tests:** Use `pnpm test:e2e:mock` to run E2E tests
- **Validate setup:** Use `pnpm validate:dev-login` to verify everything works

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm dev:mock` | Start dev server in mock mode |
| `pnpm validate:dev-login` | Validate dev login is working |
| `pnpm mock:reset` | Reset mock state to defaults |
| `pnpm mock:scenario` | List available scenarios |
| `pnpm mock:scenario running` | Apply a specific scenario |
| `pnpm test:e2e:mock` | Run E2E tests in mock mode |

## What's Next?

- **Read the full guide:** See [docs/MOCK_MODE_DEVELOPER_GUIDE.md](docs/MOCK_MODE_DEVELOPER_GUIDE.md)
- **Learn about scenarios:** See the "Scenarios" section in the guide
- **Understand authentication:** See "Authentication in Mock Mode" in the guide
- **Explore the codebase:** Check out [README.md](README.md) for project overview

## Troubleshooting

**Dev login returns 403:**
- Ensure `ENABLE_DEV_LOGIN=true` is in `.env.local`
- Restart the dev server after changing `.env.local`

**Dev login returns 404:**
- Check that `NODE_ENV` is not set to `production`
- In development, Next.js sets this automatically

**Can't access protected routes:**
- Visit `/api/auth/dev-login` to authenticate
- Check browser dev tools → Application → Cookies for `mc_session`

**Tests failing:**
- Ensure dev server is running (`pnpm dev:mock`)
- Run `pnpm mock:reset` before running tests
- Check that `MC_BACKEND_MODE=mock` is set

## Need Help?

- Check the [troubleshooting section](docs/MOCK_MODE_DEVELOPER_GUIDE.md#troubleshooting)
- Review the [full mock mode guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md)
- Open an issue on GitHub with details about your problem

## Switching to Real AWS

When you're ready to use real AWS infrastructure:

1. Update `.env.local`:
   ```bash
   MC_BACKEND_MODE=aws
   ENABLE_DEV_LOGIN=false
   # Add your AWS credentials
   AWS_ACCESS_KEY_ID=your-key
   AWS_SECRET_ACCESS_KEY=your-secret
   AWS_REGION=us-west-1
   INSTANCE_ID=i-xxxxxxxx
   ```

2. Restart the dev server:
   ```bash
   pnpm dev
   ```

3. Set up Google OAuth (see [README.md](README.md#authentication))

That's it! You're now ready to develop with mock mode. 🚀