# Deploy/Destroy, Confirmation Dialogs, Google Drive Setup & E2E Testing PRD

**Date:** 2026-01-09  
**Status:** Draft

## Summary

Enhance the mc-aws Minecraft server management frontend with infrastructure deployment and destruction capabilities, confirmation dialogs for destructive actions, a web-based Google Drive OAuth setup flow, and comprehensive Playwright E2E testing with mocked AWS responses.

## Goals

1. **Deploy/Destroy Infrastructure**: Add buttons to deploy or destroy the MinecraftStack directly from the web UI, with proper stack existence detection
2. **Confirmation Dialogs**: Protect destructive actions (Hibernate, Resume, Backup, Restore, Deploy, Destroy) with confirmation dialogs
3. **Google Drive OAuth Flow**: Enable web-based Google Drive token setup during deployment or when attempting backup/restore without credentials
4. **E2E Testing**: Comprehensive Playwright test coverage for all major user flows with mocked AWS data

## Non-Goals

1. **Alternative Backup Methods**: No direct download/upload to device - Google Drive remains the only backup method
2. **Start/Stop Confirmations**: These are considered low-risk and do not need confirmation dialogs (per user preference)
3. **Real AWS Calls in Tests**: All E2E tests must use mocked data - no actual AWS resources should be used
4. **CDK Code Changes**: Infrastructure code in `lib/minecraft-stack.ts` is out of scope; only API/frontend changes

## Users

- **Server Administrator**: Primary user managing the Minecraft server lifecycle through the web UI
- **Developer**: Running E2E tests during development and CI/CD

## Use Cases

### UC1: First-Time Deployment
1. User opens web UI, sees no stack exists
2. Clicks "Deploy" button
3. Confirms deployment in dialog
4. System prompts for Google Drive setup (OAuth flow)
5. User completes OAuth or declines
6. CDK deploys infrastructure
7. UI shows server controls once stack exists

### UC2: Destroy Infrastructure
1. User with running/stopped stack clicks "Destroy" button
2. Confirms destruction in dialog (with warning about data loss)
3. CDK destroys infrastructure
4. UI returns to "no stack" state with Deploy button

### UC3: Backup Without Google Drive Configured
1. User clicks "Backup" on running server
2. Confirms backup in dialog
3. System detects Google Drive not configured
4. Prompts user to complete OAuth setup
5. If declined, backup is blocked with clear message

### UC4: Confirmation Flow
1. User clicks Hibernate/Resume/Backup/Restore/Deploy/Destroy
2. Modal appears with action description and consequences
3. User confirms or cancels
4. Action proceeds only on confirmation

## Technical Design

### Stack Detection via CloudFormation API

Use CloudFormation `DescribeStacks` to determine stack existence:
- **Stack exists + healthy**: Show normal server controls + Destroy button
- **Stack not found**: Show Deploy button (only if AWS connection works)
- **AWS connection error**: Show error message (not Deploy button)

```typescript
// New API endpoint: GET /api/stack-status
// Returns: { exists: boolean, status: string, error?: string }
```

### Deploy/Destroy API Routes

```typescript
// POST /api/deploy - Triggers CDK deploy
// - Runs: npx cdk deploy --require-approval never
// - Returns deployment progress/status

// POST /api/destroy - Triggers CDK destroy  
// - Runs: npx cdk destroy --force
// - Returns destruction progress/status
```

### Google Drive OAuth Flow

The existing `bin/setup-drive-token.sh` uses rclone's OAuth flow. For web-based setup:

1. **API endpoint**: `POST /api/gdrive/setup` - Initiates OAuth, returns auth URL
2. **Callback endpoint**: `GET /api/gdrive/callback` - Handles OAuth callback, stores token
3. **Status endpoint**: `GET /api/gdrive/status` - Checks if token exists in SSM

Token storage: SSM Parameter Store at `/minecraft/gdrive-token` (existing location)

### Confirmation Dialog Component

Create reusable `ConfirmationDialog` component:
- Title, description, consequences text
- Confirm/Cancel buttons
- Optional "type to confirm" for destructive actions (Deploy, Destroy)
- Consistent with existing `ResumeModal` styling

### Playwright E2E Setup

- Install Playwright in `frontend/`
- Configure MSW (Mock Service Worker) or Playwright's request interception for AWS mocking
- Create test fixtures for different server states

## Success Criteria

1. **Deploy Flow**: User can deploy stack from web UI when none exists
2. **Destroy Flow**: User can destroy stack with proper confirmation
3. **Confirmations**: All specified actions require confirmation before proceeding
4. **Google Drive**: Web-based OAuth setup works during deploy and backup/restore attempts
5. **E2E Coverage**: Tests cover all major paths with 100% mocked AWS data
6. **No Regressions**: Existing functionality continues to work

## Dependencies & References

### Source Code - Key Files

- **Homepage**: `frontend/app/page.tsx` - Add Deploy/Destroy buttons here
- **Controls**: `frontend/components/ControlsSection.tsx` - Add confirmations to existing buttons
- **Button Visibility**: `frontend/hooks/useButtonVisibility.ts` - Extend for deploy/destroy states
- **Types**: `frontend/lib/types.ts` - Add new response types
- **AWS Clients**: `frontend/lib/aws/` - Add CloudFormation client
- **CDK Stack**: `lib/minecraft-stack.ts` - Reference for stack name ("MinecraftStack")
- **Google Drive Setup**: `bin/setup-drive-token.sh` - Reference for OAuth flow

### Existing Patterns

- **API Routes**: `frontend/app/api/*/route.ts` - Follow existing ApiResponse<T> pattern
- **Modals**: `frontend/components/ResumeModal.tsx` - Pattern for confirmation dialogs
- **AGENTS.md**: Coding conventions, error handling, logging

### Stack Name

The CDK stack is named `MinecraftStack` (see `lib/minecraft-stack.ts` line 16). Use this when querying CloudFormation.

### Google Drive Token Location

SSM Parameter: `/minecraft/gdrive-token` (SecureString)

## API Endpoint Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/stack-status` | GET | Check if MinecraftStack exists |
| `/api/deploy` | POST | Trigger CDK deploy |
| `/api/destroy` | POST | Trigger CDK destroy |
| `/api/gdrive/status` | GET | Check if Google Drive token exists |
| `/api/gdrive/setup` | POST | Initiate OAuth flow |
| `/api/gdrive/callback` | GET | Handle OAuth callback |

## UI States

### No Stack State
- Show "Deploy" button (primary)
- Hide all server controls
- If AWS connection failed, show error instead of Deploy button

### Stack Exists State
- Show normal server controls (Start/Stop, Hibernate, Backup, etc.)
- Show "Destroy" button (secondary/danger, in settings or header)

### Deploying State
- Show progress indicator
- Disable all buttons
- Show Google Drive setup prompt when appropriate

### Destroying State
- Show progress indicator
- Disable all buttons

## Confirmation Dialog Requirements

| Action | Needs Confirmation | Extra Protection |
|--------|-------------------|------------------|
| Start | No | - |
| Stop | No | - |
| Hibernate | Yes | - |
| Resume | Yes | - |
| Backup | Yes | - |
| Restore | Yes | - |
| Deploy | Yes | Type "deploy" to confirm |
| Destroy | Yes | Type "destroy" to confirm |

## E2E Test Scenarios

### Homepage States
- No stack exists → Deploy button shown
- Stack exists, server stopped → Start/Hibernate buttons shown
- Stack exists, server running → Stop/Backup/Restore buttons shown
- AWS error → Error message shown (no Deploy button)

### Deploy Flow
- Click Deploy → Confirmation dialog appears
- Type "deploy" → Confirm enabled
- Confirm → Google Drive prompt appears
- Complete OAuth → Deploy proceeds
- Decline OAuth → Deploy proceeds (backup disabled later)

### Destroy Flow
- Click Destroy → Confirmation dialog appears
- Type "destroy" → Confirm enabled
- Confirm → Destruction proceeds
- UI returns to no-stack state

### Server Operations (with confirmations)
- Hibernate: Confirm dialog → proceeds
- Resume: Confirm dialog with backup selection → proceeds
- Backup: Confirm dialog → Google Drive check → proceeds or prompts OAuth
- Restore: Confirm dialog with backup selection → proceeds

### Error Paths
- Deploy fails → Error shown, retry available
- Destroy fails → Error shown, retry available
- Google Drive OAuth fails → Clear error, retry option
- Backup without Google Drive → OAuth prompt or block
