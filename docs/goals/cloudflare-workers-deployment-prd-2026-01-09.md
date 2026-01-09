# Cloudflare Workers Deployment PRD

**Date:** 2026-01-09  
**Status:** Draft

## Summary

Set up Cloudflare Workers deployment for the mc-aws frontend using OpenNext (@opennextjs/cloudflare). This includes proper environment validation that runs in all modes, Cloudflare-specific configuration files, secrets management documentation, and deployment scripts.

## Goals

1. **Environment Validation**: Update `scripts/validate-env.ts` to always validate environment variables, with different behavior for dev (warn) vs build (fail)
2. **Cloudflare Workers Setup**: Add OpenNext adapter and create required configuration files (wrangler.jsonc, open-next.config.ts)
3. **Deployment Scripts**: Add `deploy:cf` and `preview:cf` scripts to package.json
4. **Secrets Management**: Document secure secrets handling via `wrangler secret put`
5. **DNS Configuration**: Document same-domain setup with Minecraft server
6. **Updated Documentation**: Update .env.template and README.md with complete deployment workflow

## Non-Goals

- Automatic secrets provisioning (secrets are set manually via wrangler CLI for security)
- Custom domain automation (DNS setup is manual via Cloudflare dashboard)
- CDK infrastructure changes (this is frontend deployment only)

## Users

- **Operators**: Individuals deploying and managing the mc-aws system
- **Developers**: Contributors working on the frontend codebase

## Use Cases

1. **First-time deployment**: Operator sets up Cloudflare Workers deployment from scratch
2. **Continuous deployment**: Developer deploys updates to production
3. **Local preview**: Developer tests Cloudflare Workers build locally before deploying
4. **Environment debugging**: Developer identifies missing environment variables early in development

## Success Criteria

- [ ] `pnpm dev` warns about missing env vars but continues
- [ ] `pnpm build` fails if required env vars are missing
- [ ] `pnpm deploy:cf` successfully builds and deploys to Cloudflare Workers
- [ ] `pnpm preview:cf` successfully runs local Cloudflare Workers preview
- [ ] README.md contains complete deployment workflow
- [ ] .env.template contains all required variables with descriptions

## Technical Design

### 1. Environment Validation Updates

**File:** `scripts/validate-env.ts`

Update to always run validation with mode-aware behavior:
- **Development mode** (`NODE_ENV !== 'production'`): Log warnings for missing vars, continue execution
- **Build/Production mode** (`NODE_ENV === 'production'`): Fail with error for missing vars

**Required variables:**
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `AUTH_SECRET` - Session encryption secret (32+ chars)
- `ADMIN_EMAIL` - Administrator email address
- `NEXT_PUBLIC_APP_URL` - Public URL of the deployed app

### 2. Cloudflare Workers Configuration

**New file:** `wrangler.jsonc`
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mc-aws-frontend",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "main": ".open-next/worker.js",
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  // Non-secret environment variables
  "vars": {
    "ADMIN_EMAIL": "",
    "ALLOWED_EMAILS": "",
    "NEXT_PUBLIC_APP_URL": ""
  }
}
```

**New file:** `open-next.config.ts`
```typescript
import type { OpenNextConfig } from "@opennextjs/cloudflare";

const config: OpenNextConfig = {
  default: {
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
};

export default config;
```

### 3. Package.json Updates

Add to dependencies:
- `@opennextjs/cloudflare`

Add scripts:
```json
{
  "deploy:cf": "opennextjs-cloudflare build && wrangler deploy",
  "preview:cf": "opennextjs-cloudflare build && wrangler dev"
}
```

### 4. Secrets Management

Secrets are set via wrangler CLI (not stored in config files):

```bash
# One-time setup commands
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put AUTH_SECRET

# AWS credentials for API routes
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
```

### 5. DNS Configuration

The frontend shares the same domain as the Minecraft server. Options:
- **Subdomain approach** (recommended): `panel.mc.example.com` for frontend, `mc.example.com` for game server
- **Path prefix approach**: `mc.example.com/panel/*` for frontend (requires additional routing config)

## Dependencies & References

### Existing Files to Modify
- `scripts/validate-env.ts` - Environment validation script
- `package.json` - Add dependencies and scripts
- `.env.template` - Add all required variables
- `README.md` - Update Production Deployment section

### New Files to Create
- `wrangler.jsonc` - Cloudflare Workers configuration
- `open-next.config.ts` - OpenNext adapter configuration

### External Documentation
- [OpenNext Cloudflare Adapter](https://opennext.js.org/cloudflare)
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
