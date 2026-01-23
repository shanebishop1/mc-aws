# Tasks - Project Restructure

## In Progress

- [ ] [debugger] Create new directory structure: mkdir -p infrastructure/bin infrastructure/lib infrastructure/src infrastructure/scripts legacy/bin docs/goals. PRD: docs/goals/project-restructure-prd-2026-01-09.md

## To Do

- [ ] [debugger] Move CDK entry point: git mv bin/mc-aws.ts infrastructure/bin/mc-aws.ts. This is the CDK app entry point that synthesizes the stack.
- [ ] [debugger] Move CDK stack: git mv lib/ infrastructure/lib/. Contains minecraft-stack.ts with all AWS resource definitions.
- [ ] [debugger] Move CDK source code: git mv src/ infrastructure/src/. Contains ec2/ scripts and lambda/ functions deployed to AWS.
- [ ] [debugger] Move CDK deployment script: git mv scripts/deploy.js infrastructure/scripts/deploy.js
- [ ] [debugger] Move CDK config: git mv cdk.json infrastructure/cdk.json. Update 'app' path if needed (should still be bin/mc-aws.ts relative to infrastructure/).
- [ ] [debugger] Move root package.json to infrastructure: git mv package.json infrastructure/package.json. This contains CDK dependencies (aws-cdk-lib, constructs, etc.).
- [ ] [debugger] Create infrastructure/tsconfig.json for CDK TypeScript compilation. Base it on standard CDK tsconfig with target ES2020, module commonjs.
- [ ] [debugger] Move legacy shell scripts: git mv bin/*.sh legacy/bin/. Scripts: mc-api.sh, console.sh, connect.sh, restore-to-ec2.sh, backup-from-ec2.sh, resume.sh, hibernate.sh, setup-drive-token.sh
- [ ] [debugger] Move frontend/app to root: git mv frontend/app ./app. This is the Next.js App Router with all pages and API routes.
- [ ] [debugger] Move frontend/components to root: git mv frontend/components ./components. React UI components.
- [ ] [debugger] Move frontend/lib to root: git mv frontend/lib ./lib. Shared utilities, AWS clients, types.
- [ ] [debugger] Move frontend/hooks to root: git mv frontend/hooks ./hooks. React hooks.
- [ ] [debugger] Move frontend/scripts to root: git mv frontend/scripts ./scripts. CLI scripts (server-cli.ts).
- [ ] [debugger] Move frontend/tests to root: git mv frontend/tests ./tests. Vitest and Playwright tests.
- [ ] [debugger] Move frontend config files to root: git mv frontend/package.json frontend/tsconfig.json frontend/next.config.ts frontend/biome.json frontend/tailwind.config.ts frontend/postcss.config.mjs frontend/next-env.d.ts ./
- [ ] [debugger] Move frontend/public to root (if exists): git mv frontend/public ./public
- [ ] [debugger] Move goals/ to docs/goals/: git mv goals/* docs/goals/. Move PRDs to documentation folder.
- [ ] [debugger] Move frontend/docs to docs/: git mv frontend/docs/* docs/. Includes API.md reference.
- [ ] [engineer] Update next.config.ts: Remove '../.env' path (now same directory), remove outputFileTracingRoot (no longer needed for monorepo). File: next.config.ts
- [ ] [engineer] Update root package.json: Add CDK proxy scripts (cdk:deploy, cdk:synth, cdk:diff) that cd into infrastructure/. Keep all Next.js scripts. File: package.json
- [ ] [engineer] Verify tsconfig.json paths: Confirm @/* alias maps to './*' (should work as-is). File: tsconfig.json
- [ ] [engineer] Update AGENTS.md: Update directory structure section to reflect new layout with infrastructure/, legacy/, docs/ folders. File: AGENTS.md
- [ ] [debugger] Remove empty frontend/ directory: rm -rf frontend/ after confirming all files moved.
- [ ] [debugger] Run pnpm install at root to regenerate lockfile and node_modules
- [ ] [debugger] Validate build: Run 'pnpm build' and ensure Next.js builds successfully with no import errors
- [ ] [debugger] Validate tests: Run 'pnpm test' to ensure all unit tests pass
- [ ] [debugger] Validate CDK: cd infrastructure && npm install && npx cdk synth to ensure CDK still works

## Backlog


## Done


## Reminders

- PRD location: goals/project-restructure-prd-2026-01-09.md - Contains full context on current vs proposed structure, technical details, and success criteria
- Use 'git mv' for all file moves to preserve git history
- Tasks marked [debugger] require shell commands/file operations; tasks marked [engineer] are code edits only
- CDK and Next.js have separate package managers: CDK uses npm (infrastructure/), Next.js uses pnpm (root)
- After all moves complete, verify: pnpm build, pnpm test, cd infrastructure && npx cdk synth
