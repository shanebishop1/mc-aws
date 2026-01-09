# Tasks - Deploy Destroy E 2 E

## In Progress


## To Do


## Backlog


## Done

- [x] [debugger] Analyze CloudFormation API for stack detection - Research DescribeStacks API to determine best approach for checking if MinecraftStack exists. Document expected responses for: stack exists, stack not found, AWS connection error. Reference: lib/minecraft-stack.ts for stack name. Output: Brief analysis doc in notes.
- [x] [debugger] Analyze Google Drive OAuth flow requirements - Review bin/setup-drive-token.sh and determine how to adapt rclone OAuth flow for web-based setup. Identify: OAuth URL construction, token exchange, SSM storage at /minecraft/gdrive-token. Determine if server-side or client-side OAuth is better.
- [x] [engineer] Create CloudFormation client utility - Add frontend/lib/aws/cloudformation-client.ts with functions: describeStack(stackName), checkStackExists(stackName). Follow patterns in ec2-client.ts. Use @aws-sdk/client-cloudformation.
- [x] [engineer] Add StackStatusResponse and GDriveStatusResponse types - Add to frontend/lib/types.ts: StackStatusResponse { exists: boolean, status?: string, error?: string }, GDriveStatusResponse { configured: boolean }, DeployResponse { message: string, output?: string }, DestroyResponse { message: string, output?: string }.
- [x] [engineer] Create GET /api/stack-status endpoint - Returns { exists: boolean, status: string, error?: string }. Use CloudFormation client to check MinecraftStack. Handle: stack exists (return status), stack not found (exists: false), AWS error (return error string). Follow ApiResponse<T> pattern from existing routes.
- [x] [engineer] Create GET /api/gdrive/status endpoint - Check if Google Drive token exists in SSM Parameter Store at /minecraft/gdrive-token. Return { configured: boolean }. Use SSM GetParameter with error handling for missing parameter.
- [x] [engineer] Create POST /api/deploy endpoint - Triggers CDK deploy via child_process.spawn. Command: npx cdk deploy MinecraftStack --require-approval never. Stream output or return final status. Handle errors gracefully. Note: This is a long-running operation.
- [x] [engineer] Create POST /api/destroy endpoint - Triggers CDK destroy via child_process.spawn. Command: npx cdk destroy MinecraftStack --force. Stream output or return final status. Include safety check that stack exists before destroying.
- [x] [engineer] Create POST /api/gdrive/setup endpoint - Generate rclone OAuth URL for Google Drive authorization. May need to research rclone OAuth flow for programmatic URL generation, or use Google OAuth directly. Return { authUrl: string }.
- [x] [engineer] Create GET /api/gdrive/callback endpoint - Handle OAuth callback, exchange code for token, store in SSM at /minecraft/gdrive-token as SecureString. Redirect user back to frontend with success/error status.
- [x] [engineer] Create ConfirmationDialog component - Create frontend/components/ui/ConfirmationDialog.tsx. Props: isOpen, onClose, onConfirm, title, description, confirmText, cancelText, requireTypedConfirmation?: string. Style consistent with ResumeModal.tsx. Include danger variant for destructive actions.
- [x] [engineer] Create useStackStatus hook - Create frontend/hooks/useStackStatus.ts. Fetches GET /api/stack-status on mount and provides: stackExists, stackStatus, isLoading, error, refetch. Similar pattern to useServerStatus hook.
- [x] [engineer] Create useGDriveStatus hook - Create frontend/hooks/useGDriveStatus.ts. Fetches GET /api/gdrive/status and provides: isConfigured, isLoading, error, refetch. Used to determine if Google Drive setup prompt needed.
- [x] [engineer] Create GoogleDriveSetupPrompt component - Create frontend/components/GoogleDriveSetupPrompt.tsx. Modal that explains Google Drive backup requirement, shows 'Set Up Google Drive' button that opens OAuth flow, and 'Skip for Now' option. Track setup status.
- [x] [engineer] Create DeployButton component - Create frontend/components/DeployButton.tsx. Shows only when stack doesn't exist. Opens ConfirmationDialog requiring user to type 'deploy'. On confirm, calls POST /api/deploy. Shows progress during deployment.
- [x] [engineer] Create DestroyButton component - Create frontend/components/DestroyButton.tsx. Shows only when stack exists. Opens ConfirmationDialog requiring user to type 'destroy' with danger styling. On confirm, calls POST /api/destroy. Shows progress during destruction.
- [x] [engineer] Add confirmation dialogs to existing actions - Update ControlsSection.tsx to wrap Hibernate, Backup, Restore with ConfirmationDialog. Resume already has ResumeModal which serves as confirmation. Use appropriate messaging for each action.
- [x] [engineer] Update homepage for deploy/destroy flow - Update frontend/app/page.tsx: Fetch stack status on load. If no stack: show DeployButton instead of server controls. If stack exists: show normal controls + DestroyButton (in header or settings area). Handle loading and error states.
- [x] [engineer] Extend useButtonVisibility for deploy/destroy - Update frontend/hooks/useButtonVisibility.ts to accept stackExists parameter. Add: showDeploy (stackExists === false && no AWS error), showDestroy (stackExists === true). Export these new visibility flags.
- [x] [engineer] Add Google Drive setup prompt to deploy flow - In deploy flow, after user confirms deploy, check Google Drive status. If not configured, show GoogleDriveSetupPrompt. Allow user to complete OAuth or skip. Then proceed with deploy.
- [x] [engineer] Add Google Drive check to backup/restore flows - Before executing backup or restore, check Google Drive status via useGDriveStatus. If not configured, show GoogleDriveSetupPrompt. If user declines, block the operation with clear message explaining Google Drive is required.
- [x] [engineer] Install and configure Playwright - In frontend/: pnpm add -D @playwright/test. Create playwright.config.ts with: baseURL localhost:3000, webServer config to start dev server, browser configs. Create tests/ directory structure.
- [x] [engineer] Create Playwright mock utilities - Create frontend/tests/mocks/aws-handlers.ts with MSW or Playwright route handlers for all API endpoints. Create fixtures for: no-stack state, stack-exists-stopped, stack-exists-running, stack-exists-hibernating, aws-error state. Each fixture returns appropriate mock data.
- [x] [engineer] Create Playwright test helpers - Create frontend/tests/helpers/test-utils.ts with: setupMockState(scenario), waitForStatusUpdate(), confirmDialog(action), typeToConfirm(text). These simplify common test patterns.
- [x] [engineer] E2E tests: Homepage states - Create frontend/tests/e2e/homepage.spec.ts. Test scenarios: 1) No stack → Deploy button shown, 2) Stack exists + stopped → Start/Hibernate shown, 3) Stack exists + running → Stop/Backup/Restore shown, 4) AWS error → Error message shown (no Deploy).
- [x] [engineer] E2E tests: Deploy flow - Create frontend/tests/e2e/deploy.spec.ts. Test: Click Deploy → dialog appears → type 'deploy' → confirm → Google Drive prompt → complete/skip OAuth → deployment proceeds. Test cancel flow. Test deployment error handling.
- [x] [engineer] E2E tests: Destroy flow - Create frontend/tests/e2e/destroy.spec.ts. Test: Click Destroy → dialog appears → type 'destroy' → confirm → destruction proceeds → returns to no-stack state. Test cancel flow. Test destruction error handling.
- [x] [engineer] E2E tests: Server operations with confirmations - Create frontend/tests/e2e/server-operations.spec.ts. Test: Hibernate with confirmation, Resume with confirmation and backup selection, Start (no confirmation), Stop (no confirmation). Verify dialogs appear and actions proceed on confirm.
- [x] [engineer] E2E tests: Backup/Restore with Google Drive - Create frontend/tests/e2e/backup-restore.spec.ts. Test: Backup with Google Drive configured → confirmation → success. Backup without Google Drive → prompt appears → setup or decline. Restore with backup selection. Test decline blocking operation.
- [x] [engineer] E2E tests: Error paths - Create frontend/tests/e2e/errors.spec.ts. Test: Deploy failure → error message → retry available. Destroy failure → error message. Backup failure. API timeout handling. Network error handling.

## Reminders

- PRD location: goals/deploy-destroy-e2e-prd-2026-01-09.md - Read this for full context on deploy/destroy, confirmation dialogs, Google Drive setup, and E2E testing requirements
- Stack name is 'MinecraftStack' - Use this when querying CloudFormation API (see lib/minecraft-stack.ts)
- Google Drive token stored at SSM: /minecraft/gdrive-token (SecureString) - Reference bin/setup-drive-token.sh for OAuth flow details
- All API routes must return ApiResponse<T> format with success, data/error, and timestamp fields
- Follow patterns in AGENTS.md for code style, error handling (try-catch, bracketed log prefixes), and Biome formatting
- E2E tests must mock ALL AWS data - no real AWS calls during tests
- Confirmations needed for: Hibernate, Resume, Backup, Restore, Deploy, Destroy. NOT needed for: Start, Stop
- Deploy/Destroy buttons use typed confirmation ('deploy' or 'destroy') for extra safety
