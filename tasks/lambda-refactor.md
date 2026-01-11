# Tasks - Lambda Refactor

## In Progress

- [ ] [documenter] Phase 6b: Commit changes - After tests pass, commit all changes with message 'refactor: modularize StartMinecraftServer Lambda'. Push to remote. Ref: goals/lambda-refactor-prd-2026-01-10.md

## To Do


## Backlog


## Done

- [x] [engineer] Phase 1: Create clients.js - Extract AWS SDK client initialization (EC2, SES, SSM) from lines 1-26 of index.js into a new module. Export the client instances. Ref: goals/lambda-refactor-prd-2026-01-10.md, infra/src/lambda/StartMinecraftServer/index.js
- [x] [engineer] Phase 2a: Create ec2.js - Extract EC2 operations (ensureInstanceRunning, getPublicIp, pollInstanceForIp, constants MAX_POLL_ATTEMPTS, POLL_INTERVAL_MS) from lines 28-159. Import clients from clients.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 2b: Create cloudflare.js - Extract updateCloudflareDns function from lines 169-201. Pure utility, no AWS SDK dependencies. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 2c: Create notifications.js - Extract getSanitizedErrorMessage and sendNotification from lines 207-250. Import SES client from clients.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 2d: Create ssm.js - Extract executeSSMCommand and waitForSSMCompletion from lines 354-401. Import SSM client from clients.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 3a: Create allowlist.js - Extract getAllowlist, updateAllowlist, extractEmails from lines 256-304. Import SSM client from clients.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 3b: Create command-parser.js - Extract parseCommand function from lines 306-348. Pure utility, no dependencies. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 3c: Create email-parser.js - Extract parseEmailFromEvent function from lines 751-771. Pure utility, no AWS dependencies. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 4a: Create handlers/backup.js - Extract handleBackup from lines 409-451. Import: ensureInstanceRunning from ec2.js, executeSSMCommand from ssm.js, sendNotification/getSanitizedErrorMessage from notifications.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 4b: Create handlers/restore.js - Extract handleRestore from lines 453-522. Import: ensureInstanceRunning/getPublicIp from ec2.js, executeSSMCommand from ssm.js, updateCloudflareDns from cloudflare.js, sendNotification/getSanitizedErrorMessage from notifications.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 4c: Create handlers/hibernate.js - Extract handleHibernate, stopInstanceAndWait, detachAndDeleteVolumes, detachVolume from lines 524-603. Import EC2 client from clients.js, executeSSMCommand from ssm.js, sendNotification/getSanitizedErrorMessage from notifications.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 4d: Create handlers/resume.js - Extract handleResume, findLatestAL2023Snapshot, createAndAttachVolume, waitForVolumeAvailable, attachVolumeToInstance from lines 605-718. Import EC2 client from clients.js. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [engineer] Phase 5: Refactor index.js - Replace inline functions with imports from new modules. Keep only: handler, validateEnvironment, handleAllowlistUpdate, parseAndAuthorizeCommand, executeCommand, handleStartCommand, handleResumeCommand. Wire up all imports. Handler signature MUST remain: export const handler = async (event) => {}. Ref: goals/lambda-refactor-prd-2026-01-10.md
- [x] [debugger] Phase 6a: Run tests - Execute 'pnpm test' and 'pnpm test:e2e' to verify all functionality works after refactoring. Fix any issues found. Ref: AGENTS.md for test commands

## Reminders

- All modules must use ES module syntax (import/export). Lambda runtime is Node.js 20.x. No TypeScript, no bundler. Handler signature must remain: export const handler = async (event) => {}

## Notes

- UpdateDns Lambda (71 lines) duplicates getPublicIp and updateCloudflareDns. Due to CDK constraints (no changes allowed), this duplication remains. Future improvement: consider Lambda layers or CDK restructuring to share code.
