# Tasks - Cloudflare Workers Deployment

## In Progress


## To Do


## Backlog


## Done

- [x] [engineer] Update scripts/validate-env.ts to always validate with mode-aware behavior. In dev mode (NODE_ENV !== 'production'): log warnings for missing vars but continue. In build mode (NODE_ENV === 'production'): fail with error. Required vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, ADMIN_EMAIL, NEXT_PUBLIC_APP_URL. Read: scripts/validate-env.ts. PRD: docs/goals/cloudflare-workers-deployment-prd-2026-01-09.md
- [x] [debugger] Add @opennextjs/cloudflare and wrangler as devDependencies using pnpm. Run: pnpm add -D @opennextjs/cloudflare wrangler
- [x] [engineer] Create wrangler.jsonc configuration file at project root. Include: name 'mc-aws-frontend', compatibility_date '2024-09-23', nodejs_compat flag, main '.open-next/worker.js', assets config, and vars section for ADMIN_EMAIL, ALLOWED_EMAILS, NEXT_PUBLIC_APP_URL (non-secrets only). PRD: docs/goals/cloudflare-workers-deployment-prd-2026-01-09.md
- [x] [engineer] Create open-next.config.ts at project root with OpenNextConfig for Cloudflare Workers. Use cloudflare-node wrapper, edge converter, and dummy caches (incrementalCache, tagCache, queue). PRD: docs/goals/cloudflare-workers-deployment-prd-2026-01-09.md
- [x] [engineer] Add deploy:cf and preview:cf scripts to package.json. deploy:cf: 'opennextjs-cloudflare build && wrangler deploy'. preview:cf: 'opennextjs-cloudflare build && wrangler dev'. Read: package.json
- [x] [engineer] Update .env.template with all required environment variables and descriptions. Add: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, ADMIN_EMAIL, ALLOWED_EMAILS (optional), NEXT_PUBLIC_APP_URL. Include comments explaining each variable. Read: .env.template
- [x] [engineer] Update README.md Production Deployment section with complete Cloudflare Workers workflow. Include: 1) Install wrangler and login, 2) Set secrets via wrangler secret put commands (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), 3) Configure non-secret vars in wrangler.jsonc, 4) Deploy with pnpm deploy:cf, 5) Custom domain setup instructions, 6) DNS configuration for same-domain setup with MC server. Read: README.md. PRD: docs/goals/cloudflare-workers-deployment-prd-2026-01-09.md
