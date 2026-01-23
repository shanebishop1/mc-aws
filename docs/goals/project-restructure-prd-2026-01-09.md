# PRD: Project Restructure - Next.js as Root

**Date:** 2026-01-09  
**Status:** Draft  
**Task File:** `tasks/project-restructure.md`

---

## Summary

Restructure the mc-aws project to make the Next.js application the root of the project. Currently, the Next.js app lives in `frontend/` while legacy CDK infrastructure and shell scripts occupy the root. This restructure will:

1. Move the Next.js app (`frontend/*`) to the project root
2. Consolidate CDK infrastructure into an `infrastructure/` subdirectory
3. Move deprecated shell scripts to a `legacy/` folder
4. Update all path references, imports, and configuration files

---

## Goals

- **Primary**: Simplify the project structure so the main application (Next.js) is at the root
- **Secondary**: Preserve CDK functionality in a dedicated `infrastructure/` workspace
- **Tertiary**: Archive legacy shell scripts without breaking git history

## Non-Goals

- Rewriting or modernizing the CDK stack code
- Changing functionality of the Next.js application
- Migrating away from CDK to a different IaC tool
- Removing legacy scripts entirely (they may still be useful for reference)

---

## Current Structure

```
mc-aws/
├── bin/                    # Mixed: CDK entry (mc-aws.ts) + shell scripts
│   ├── mc-aws.ts           # CDK entry point
│   └── *.sh                # Legacy shell scripts
├── config/                 # Minecraft server config
├── lib/                    # CDK stack definitions
│   └── minecraft-stack.ts
├── src/
│   ├── ec2/                # Scripts deployed to EC2
│   └── lambda/             # Lambda function code
├── scripts/
│   └── deploy.js           # CDK deployment script
├── frontend/               # ← THE MAIN APP
│   ├── app/                # Next.js App Router
│   ├── components/         # React components
│   ├── lib/                # Shared utilities
│   ├── hooks/              # React hooks
│   ├── scripts/            # CLI scripts
│   ├── tests/              # Test files
│   ├── package.json        # Next.js dependencies
│   ├── tsconfig.json       # TS config (paths: @/* → ./*)
│   ├── next.config.ts      # Next.js config (loads ../.env)
│   └── biome.json          # Linter config
├── goals/                  # PRDs
├── tasks/                  # Task plans
├── cdk.json                # CDK configuration
├── package.json            # CDK dependencies
└── .env                    # Environment variables
```

## Proposed Structure

```
mc-aws/
├── app/                    # Next.js App Router (from frontend/app)
├── components/             # React components (from frontend/components)
├── lib/                    # Shared utilities (from frontend/lib)
├── hooks/                  # React hooks (from frontend/hooks)
├── scripts/                # CLI scripts (from frontend/scripts)
├── tests/                  # Tests (from frontend/tests)
├── public/                 # Static assets (from frontend/public, if exists)
│
├── infrastructure/         # CDK and AWS infrastructure
│   ├── bin/                # CDK entry point (from bin/mc-aws.ts)
│   │   └── mc-aws.ts
│   ├── lib/                # CDK stack definitions (from lib/)
│   │   └── minecraft-stack.ts
│   ├── src/                # EC2 and Lambda code (from src/)
│   │   ├── ec2/
│   │   └── lambda/
│   ├── scripts/            # Deployment scripts (from scripts/)
│   │   └── deploy.js
│   ├── cdk.json            # CDK config (updated paths)
│   ├── package.json        # CDK dependencies (from root)
│   └── tsconfig.json       # CDK TypeScript config
│
├── config/                 # Minecraft server config (unchanged)
│
├── legacy/                 # Deprecated shell scripts
│   └── bin/                # Old shell scripts (from bin/*.sh)
│
├── docs/                   # Documentation
│   ├── goals/              # PRDs (from goals/)
│   └── API.md              # API reference (from frontend/docs/)
│
├── package.json            # Main package.json (Next.js + workspace scripts)
├── pnpm-workspace.yaml     # Workspace configuration (optional)
├── next.config.ts          # Next.js config (from frontend/)
├── tsconfig.json           # TypeScript config (from frontend/)
├── biome.json              # Biome config (from frontend/)
├── tailwind.config.ts      # Tailwind config (from frontend/)
├── postcss.config.mjs      # PostCSS config (from frontend/)
├── .env                    # Environment variables (unchanged)
└── README.md               # Updated README
```

---

## Users

| User | Impact |
|------|--------|
| **Developer (primary)** | Simpler project structure, `pnpm dev` runs from root |
| **CI/CD pipelines** | Path updates required for any automation |
| **CDK operations** | Commands run from `infrastructure/` or via workspace scripts |

---

## Use Cases

### UC1: Local Development
- Developer clones repo, runs `pnpm install` at root
- Runs `pnpm dev` to start Next.js dev server
- No need to navigate to `frontend/` subdirectory

### UC2: CDK Deployment
- Run `pnpm run cdk:deploy` from root (proxies to infrastructure/)
- Or navigate to `infrastructure/` and run `npm run deploy`

### UC3: Running Tests
- `pnpm test` runs from root (Vitest unit tests)
- `pnpm test:e2e` runs Playwright tests

---

## Success Criteria

1. **Build works**: `pnpm build` succeeds at project root
2. **Dev server works**: `pnpm dev` starts Next.js at root
3. **Tests pass**: All existing tests continue to pass
4. **CDK works**: `cdk deploy` succeeds from `infrastructure/`
5. **No broken imports**: All `@/*` imports resolve correctly
6. **No broken imports**: All `@/*` imports resolve correctly
7. **Git history preserved**: Use `git mv` where possible

---

## Technical Details

### Path Alias Update
- Current: `@/*` maps to `frontend/*`
- New: `@/*` maps to project root (`./*`)
- No changes to import statements in source files

### next.config.ts Changes
```typescript
// Before: loads ../.env (parent directory)
config({ path: resolve(__dirname, "../.env") });

// After: loads .env (same directory)  
config({ path: resolve(__dirname, ".env") });

// Remove outputFileTracingRoot (no longer needed)
```

### API Route CDK Path Updates
```typescript
// Before (deploy/route.ts, destroy/route.ts)
const projectRoot = path.resolve(process.cwd(), "..");
const command = 'npx cdk deploy ... --app "npx ts-node bin/mc-aws.ts"';

// After
const infrastructureDir = path.resolve(process.cwd(), "infrastructure");
const command = 'npx cdk deploy ... --app "npx ts-node bin/mc-aws.ts"';
// Execute with cwd: infrastructureDir
```

### CDK Configuration Updates
```json
// infrastructure/cdk.json
{
  "app": "npx ts-node --prefer-ts-exts bin/mc-aws.ts"
}
// Path remains relative to infrastructure/ directory
```

### Package.json Scripts
```json
// Root package.json (new)
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "biome lint .",
    "format": "biome format --write .",
    "check": "biome check --write .",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "cdk:deploy": "cd infrastructure && npm run deploy",
    "cdk:synth": "cd infrastructure && npx cdk synth",
    "cdk:diff": "cd infrastructure && npx cdk diff"
  }
}
```

---

## Migration Phases

### Phase 1: Create Directory Structure
- Create `infrastructure/`, `legacy/`, `docs/` directories

### Phase 2: Move CDK Files to infrastructure/
- Move `bin/mc-aws.ts` → `infrastructure/bin/mc-aws.ts`
- Move `lib/` → `infrastructure/lib/`
- Move `src/` → `infrastructure/src/`
- Move `scripts/deploy.js` → `infrastructure/scripts/deploy.js`
- Move `cdk.json` → `infrastructure/cdk.json`
- Move root `package.json` → `infrastructure/package.json`
- Create `infrastructure/tsconfig.json` for CDK

### Phase 3: Move Legacy Scripts
- Move `bin/*.sh` → `legacy/bin/`

### Phase 4: Move Frontend to Root
- Move `frontend/app/` → `app/`
- Move `frontend/components/` → `components/`
- Move `frontend/lib/` → `lib/`
- Move `frontend/hooks/` → `hooks/`
- Move `frontend/scripts/` → `scripts/`
- Move `frontend/tests/` → `tests/`
- Move `frontend/public/` → `public/` (if exists)
- Move config files: `package.json`, `tsconfig.json`, `next.config.ts`, `biome.json`, `tailwind.config.ts`, `postcss.config.mjs`

### Phase 5: Move Documentation
- Move `goals/` → `docs/goals/`
- Move `frontend/docs/` → `docs/`

### Phase 6: Update Configuration Files
- Update `tsconfig.json` paths (verify `@/*` still works)
- Update `next.config.ts` (.env path, remove outputFileTracingRoot)
- Update API routes for CDK paths
- Update root `package.json` with CDK proxy scripts
- Update `infrastructure/cdk.json` if needed

### Phase 7: Cleanup and Validation
- Remove empty `frontend/` directory
- Run `pnpm install` at root
- Run `pnpm build` to verify
- Run `pnpm test` to verify tests
- Test CDK from `infrastructure/`
- Update README.md

---

## Dependencies & References

### Source Files (Current Paths)
| File | Purpose | Action |
|------|---------|--------|
| `frontend/package.json` | Next.js deps | Move to root |
| `frontend/tsconfig.json` | TS config | Move to root |
| `frontend/next.config.ts` | Next config | Move to root, update paths |
| `frontend/biome.json` | Linter | Move to root |
| `package.json` | CDK deps | Move to infrastructure/ |
| `cdk.json` | CDK config | Move to infrastructure/ |
| `bin/mc-aws.ts` | CDK entry | Move to infrastructure/bin/ |
| `lib/minecraft-stack.ts` | CDK stack | Move to infrastructure/lib/ |

### Related Documentation
- `AGENTS.md` - Will need path updates for directory structure section

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Broken imports after move | Medium | High | Use `git mv`, test build immediately |
| CDK commands fail | Medium | Medium | Test CDK from infrastructure/ before cleanup |
| Lost git history | Low | Low | Use `git mv` consistently |

---

## Open Questions

1. **npm vs pnpm workspaces**: Should `infrastructure/` be a pnpm workspace or remain independent with its own `npm install`?
   - Recommendation: Keep separate for now; CDK uses npm, frontend uses pnpm

2. **tasks/ folder location**: Move to `docs/tasks/` or keep at root?
   - Recommendation: Keep at root for easy access during development
