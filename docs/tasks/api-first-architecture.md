# Tasks - Api First Architecture

## In Progress


## To Do


## Backlog


## Done

- [x] [engineer] Create GET /api/backups endpoint to list available Google Drive backups. Use SSM to execute a command on EC2 that lists backups via rclone. Return data matching ListBackupsResponse type in frontend/lib/types.ts. Reference: frontend/app/api/backup/route.ts for pattern.
- [x] [engineer] Add pnpm scripts to frontend/package.json for server management - Add scripts like 'pnpm server:status', 'pnpm server:start', 'pnpm server:stop', 'pnpm server:hibernate', 'pnpm server:resume', 'pnpm server:backup', 'pnpm server:restore' that call the API endpoints via curl or a small Node.js script
- [x] [engineer] Create frontend/scripts/server-cli.ts - A simple CLI script that can be run via pnpm to call API endpoints. Should support commands: status, start, stop, hibernate, resume, backup, restore, backups (list). Use fetch to call localhost API.
- [x] [engineer] Add backup selection to restore flow - Update /api/restore to accept backup name from list. Ensure frontend can fetch backups list then trigger restore. Reference: frontend/app/api/restore/route.ts
- [x] [engineer] Add deprecation notice to bin/hibernate.sh - Add comment block at top explaining this is deprecated, use POST /api/hibernate or the web UI instead. Keep script functional.
- [x] [engineer] Add deprecation notice to bin/resume.sh - Add comment block at top explaining this is deprecated, use POST /api/resume or the web UI instead. Keep script functional.
- [x] [engineer] Add deprecation notice to bin/backup-from-ec2.sh - Add comment block explaining Drive backup is available via API, local backup mode remains for developer use only.
- [x] [engineer] Add deprecation notice to bin/restore-to-ec2.sh - Add comment block explaining Drive restore is available via API, local restore mode remains for developer use only.
- [x] [engineer] Add utility notice to bin/connect.sh - Add comment block explaining this is a utility script for interactive SSH access, not deprecated (no API equivalent possible).
- [x] [engineer] Add utility notice to bin/console.sh - Add comment block explaining this is a utility script for Minecraft console access, not deprecated (no API equivalent possible).
- [x] [engineer] Update root README.md - Add section explaining API-first architecture. Document that the web UI and API are the primary interface. List available API endpoints with brief descriptions. Mention shell scripts are legacy/utility.
- [x] [engineer] Create frontend/docs/API.md - Comprehensive API reference documenting all endpoints: method, path, request body, response type, example curl commands. Reference types.ts for response shapes.
- [x] [engineer] Add API error handling consistency check - Audit all API routes in frontend/app/api/ to ensure they follow the same error response pattern (ApiResponse with success:false, error message, 4xx/5xx status). Fix any inconsistencies.
- [x] [engineer] Create simple CLI wrapper script bin/mc-api.sh - Bash script that wraps common API calls (status, start, stop, hibernate, resume, backup, restore). Uses curl to call API endpoints. Includes --help with usage examples.
- [x] [engineer] Add Vitest setup for API route testing - Configure Vitest in frontend/, create test utilities for mocking AWS SDK, add sample test for /api/status endpoint.
- [x] [engineer] Add API route tests for core endpoints - Test /api/start, /api/stop, /api/hibernate, /api/resume with mocked AWS responses. Verify correct status codes and response shapes.

## Reminders

- PRD location: goals/api-first-architecture-prd-2026-01-08.md - Read this for full context on the API-first migration
- Key principle: API routes should be the primary interface, shell scripts are deprecated (except connect.sh and console.sh which are utilities)
- All API routes must return ApiResponse<T> format with success, data/error, and timestamp fields
- Follow patterns in AGENTS.md for code style, error handling, and logging conventions
