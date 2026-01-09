# Tasks - Frontend

## In Progress

- [ ] [Bug Fix] Verify button visibility logic works correctly across all server states (hibernated, stopped, running, pending, stopping). Manual testing. Agent: engineer

## To Do

- [ ] [Phase 5] Test all operations end-to-end - verify start, stop, backup, restore, hibernate, resume flows work correctly. Agent: engineer
- [ ] [Phase 5] Handle edge cases - network errors, timeouts, concurrent operations, server in transitioning states. Agent: engineer. Refs: PRD FR9

## Backlog

- [ ] [engineer] Create `src/lambda/StartMinecraftServer/lib/email-utils.js` - Extract email parsing functions from index.js. Move: `extractEmails`, `parseCommand`, `getSanitizedErrorMessage`. Export as named exports.
- [ ] [engineer] Create `src/lambda/StartMinecraftServer/lib/ec2-operations.js` - Extract EC2 operations from index.js. Move: `ensureInstanceRunning`, `getPublicIp`, `updateCloudflareDns`. Import EC2Client from @aws-sdk/client-ec2.
- [ ] [engineer] Create `src/lambda/StartMinecraftServer/lib/volume-operations.js` - Extract volume operations from index.js. Move: `handleResume` function and volume waiting logic. Import EC2Client commands.
- [ ] [engineer] Create `src/lambda/StartMinecraftServer/lib/ssm-operations.js` - Extract SSM operations from index.js. Move: `executeSSMCommand`, `getAllowlist`, `updateAllowlist`. Import SSMClient from @aws-sdk/client-ssm.
- [ ] [engineer] Create `src/lambda/StartMinecraftServer/lib/notification.js` - Extract notification functions from index.js. Move: `sendNotification`. Import SESClient from @aws-sdk/client-ses.
- [ ] [engineer] Refactor `src/lambda/StartMinecraftServer/index.js` - Import from lib modules. Keep only: handler function, handleBackup, handleRestore, handleHibernate, and command routing switch. File should become ~400 lines.

## Done

- [x] [Phase 1] Initialize Next.js project with TypeScript, Tailwind CSS, PNPM, and Biome (formatting/linting) in frontend/ directory. Agent: engineer. Refs: PRD at goals/frontend-prd-2026-01-07.md
- [x] [Phase 1] Set up environment variable handling to read from parent .env file (AWS credentials, Cloudflare config, Google Drive config). Agent: engineer. Refs: .env.template, .env
- [x] [Phase 2] Implement API route for server status - detect running/stopped/hibernated states by checking EC2 instance state and volume attachments. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (DescribeInstances, BlockDeviceMappings)
- [x] [Phase 2] Implement API route for server start - handle both normal start and resume-from-hibernation (create volume if needed). Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (handleResume, StartInstancesCommand)
- [x] [Phase 2] Implement API route for server stop - simple EC2 stop without EBS deletion. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (StopInstancesCommand)
- [x] [Phase 2] Implement API route for Cloudflare DNS update after server start. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (updateCloudflareDns function)
- [x] [Phase 3] Implement API route for backup - execute mc-backup.sh via SSM with optional custom name. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (handleBackup, executeSSMCommand), src/ec2/mc-backup.sh
- [x] [Phase 3] Implement API route for restore - execute mc-restore.sh via SSM with selected backup name. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (handleRestore), src/ec2/mc-restore.sh
- [x] [Phase 3] Implement API route for hibernate - backup then stop EC2 and delete EBS. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (handleHibernate), bin/hibernate.sh
- [x] [Phase 3] Implement API route for resume - create EBS, start EC2, restore from backup. Agent: engineer. Refs: src/lambda/StartMinecraftServer/index.js (handleResume), bin/resume.sh
- [x] [Phase 3] Implement API route for listing available backups from Google Drive. Agent: engineer. Refs: Phase 1 research decision
- [x] [Bug Fix] Add `hasVolume: boolean` field to ServerStatusResponse type. Agent: engineer. File: frontend/lib/types.ts
- [x] [Bug Fix] Update /api/status route to return hasVolume from block device mappings. Call getInstanceDetails() to check blockDeviceMappings.length > 0. Agent: engineer. Files: frontend/app/api/status/route.ts, frontend/lib/aws-client.ts (ref)
- [x] [Bug Fix] Refactor page.tsx button visibility/disabled logic for proper state handling. Rules: (1) Hibernated state (no EBS): ONLY show Resume button, (2) Stopped state (has EBS): show Start + Hibernate buttons enabled, hide Backup/Restore, (3) Running state: show Stop + Hibernate + Backup + Restore, (4) Pending/Stopping: show appropriate buttons disabled + loading indicator. Create derived state variables (showResume, showStart, showStop, showHibernate, showBackup, showRestore + enabled states). Agent: engineer. File: frontend/app/page.tsx
- [x] [F1] Add SSM client to aws-client.ts for parameter store operations
- [x] [F1] Create GET /api/emails endpoint - return admin email and allowlist from SSM
- [x] [F1] Create PUT /api/emails/allowlist endpoint - update allowlist in SSM
- [x] [F2] Create ResumeModal component with Fresh/Restore options
- [x] [F2] Fetch and display backup list when Restore option selected
- [x] [F2] Wire ResumeModal to Resume button - pass backupName to /api/resume
- [x] [F1] Create EmailManagementPanel component with add/remove email UI
- [x] [F1] Integrate EmailManagementPanel into main page (modal or panel)
- [x] [F3] Add Cost Explorer client to aws-client.ts
- [x] [F3] Create GET /api/costs endpoint - query Cost Explorer API
- [x] [F3] Create CostDashboard component with period selector
- [x] [F3] Add Costs button and integrate CostDashboard modal
- [x] [F4] Modify check-mc-idle.sh to write player count to SSM parameter
- [x] [F4] Update CDK stack to grant EC2 ssm:PutParameter for /minecraft/player-count
- [x] [F4] Create GET /api/players endpoint - read player count from SSM
- [x] [F4] Display player count in ServerStatus component when running
- [x] [engineer] Button hover improvements - Add `cursor: pointer` to all buttons (Add, Save, Resume, etc.) and make the hover animation (move up effect) faster - currently feels too slow/delayed
- [x] [engineer] Admin email copy change - In `EmailManagementPanel`, change the text "Set at deploy time. Contact your administrator to change." to "Set at deploy time. Redeploy to change."
- [x] [engineer] Larger header icon buttons - Increase the size of the cost ($) and email icons in the header. Should be noticeably bigger than current size but not massive.
- [x] [engineer] Add GitHub button to header - Add a GitHub icon/button to the LEFT of the cost/email icons in the header, linking to https://github.com/shanebishop1/mc-aws
- [x] [engineer] Fix cost breakdown horizontal scroll flash - The service breakdown list shows a brief horizontal scrollbar while animating in. Fix or remove the animation causing this flash.
- [x] [engineer] Email panel caching with background refresh - Implement stale-while-revalidate pattern: (1) Cache email data permanently like costs, (2) When modal opens, instantly show cached data, (3) Fetch fresh data in background, (4) Show small loading indicator while refetching, (5) Update UI when fresh data arrives, (6) Add a manual refresh button
- [x] [engineer] Hibernation Zs animation - When server is hibernated, animate floating "Z" letters emerging from the Decagon, drifting up and to the right, and fading out. Should be subtle and clean, not distracting.
- [x] [engineer] Create `frontend/lib/aws/ec2-client.ts` - Extract EC2 operations from `frontend/lib/aws-client.ts`. Move: `findInstanceId`, `getInstanceState`, `getInstanceDetails`, `waitForInstanceRunning`, `waitForInstanceStopped`, `getPublicIp`, `startInstance`, `stopInstance`. Include ec2 client initialization and constants (MAX_POLL_ATTEMPTS, POLL_INTERVAL_MS). Export the ec2 client instance.
- [x] [engineer] Create `frontend/lib/aws/ssm-client.ts` - Extract SSM operations from `frontend/lib/aws-client.ts`. Move: `checkCommandStatus`, `pollCommandCompletion`, `executeSSMCommand`, `listBackups`, `getEmailAllowlist`, `updateEmailAllowlist`, `getPlayerCount`. Include ssm client initialization. Import env from `../env`. Import ServerState type if needed.
- [x] [engineer] Create `frontend/lib/aws/cost-client.ts` - Extract Cost Explorer operations from `frontend/lib/aws-client.ts`. Move: `CostBreakdown` interface, `CostData` interface, `getCosts` function. This module handles dynamic import of @aws-sdk/client-cost-explorer.
- [x] [engineer] Create `frontend/lib/aws/volume-client.ts` - Extract EBS volume operations from `frontend/lib/aws-client.ts`. Move: `waitForVolumeDetached`, `detachAndDeleteVolumes`, `waitForVolumeAvailable`, `waitForVolumeAttached`, `handleResume`. Import ec2 client from `./ec2-client`. Import `getInstanceDetails` from `./ec2-client`.
- [x] [engineer] Create `frontend/lib/aws/index.ts` - Create barrel file that re-exports all functions and types from ec2-client, ssm-client, cost-client, and volume-client. Export both named exports and the client instances (ec2, ssm).
- [x] [engineer] Update `frontend/lib/aws-client.ts` - Replace file contents with re-exports from `./aws/index`. This maintains backward compatibility. File should become ~5 lines that just re-exports everything from the aws folder.
- [x] [engineer] Create `frontend/components/page/PageHeader.tsx` - Extract from page.tsx. Create header component with title and icon buttons (GitHub, Costs, Email). Props: onCostClick: () => void, onEmailClick: () => void. Includes responsive layout (icons below title on mobile, absolute on desktop).
- [x] [engineer] Create `frontend/components/page/ControlsSection.tsx` - Extract from page.tsx. Create the 3-column grid with server action buttons. Props: status, showResume, showStart, showStop, showHibernate, showBackupRestore, actionsEnabled, onAction, onResumeClick. Handles all button rendering logic.
- [x] [engineer] Create `frontend/hooks/useServerStatus.ts` - Extract status polling logic from page.tsx. Hook returns: { status, hasVolume, ip, instanceId, playerCount, isInitialLoad, fetchStatus }. Encapsulates GET /api/status polling every 5 seconds and player count fetching.
- [x] [engineer] Create `frontend/components/email/EmailListItem.tsx` - Extract from EmailManagementPanel.tsx. Create component that renders a single email in the allowlist with remove button. Props: email: string, onRemove: (email: string) => void, disabled: boolean. Uses motion.div with animation.
- [x] [engineer] Create `frontend/components/email/AddEmailForm.tsx` - Extract from EmailManagementPanel.tsx. Create component with email input field and Add button. Props: onAdd: (email: string) => void, disabled: boolean. Handles local validation (EMAIL_REGEX) and Enter key submission.
- [x] [engineer] Create `frontend/hooks/useEmailData.ts` - Extract email fetching and state management from EmailManagementPanel.tsx. Hook returns: { adminEmail, allowlist, setAllowlist, isLoading, error, refetch, saveAllowlist, isSaving, hasChanges }. Encapsulates fetch from /api/emails and PUT to /api/emails/allowlist.
- [x] [engineer] Refactor `frontend/components/EmailManagementPanel.tsx` - Use extracted components (EmailListItem, AddEmailForm) and useEmailData hook. Remove duplicated logic. Component should become ~150 lines focused on layout and modal structure.
- [x] [engineer] Create `frontend/components/cost/CostBreakdownTable.tsx` - Extract from CostDashboard.tsx. Create component that renders the service breakdown table. Props: breakdown: CostBreakdown[], animate: boolean. Renders the scrollable table with alternating row colors.
- [x] [engineer] Create `frontend/hooks/useCostData.ts` - Extract cost fetching logic from CostDashboard.tsx. Hook returns: { costData, cachedAt, isLoading, error, isStale, fetchCosts, refreshCosts, hasRefreshed }. Encapsulates GET /api/costs and refresh logic.
- [x] [engineer] Refactor `frontend/components/CostDashboard.tsx` - Use extracted CostBreakdownTable component and useCostData hook. Remove duplicated logic. Component should become ~180 lines focused on modal structure and confirmation flow.
- [x] [engineer] Create `frontend/components/resume/BackupSelectionList.tsx` - Extract from ResumeModal.tsx. Create component that renders the list of backups with selection state. Props: backups: BackupInfo[], selectedBackup: string | null, onSelect: (name: string) => void. Includes empty state message.
- [x] [engineer] Refactor `frontend/components/ResumeModal.tsx` - Use extracted BackupSelectionList component. File is 262 lines, should become ~200 lines after extraction. Focus on modal structure and view switching logic.
- [x] [engineer] Refactor `frontend/app/page.tsx` - Use extracted PageHeader, ControlsSection components and useServerStatus hook. Remove duplicated logic. Page should become ~150 lines focused on layout and modal state management.
- [x] [Phase 4] Design and implement main control panel page following frontend-design.md guidelines. Single-page layout with server status and all actions. Agent: engineer. Refs: frontend-design.md, goals/frontend-prd-2026-01-07.md
- [x] [Phase 4] Implement server status display component - show state (running/stopped/hibernated), IP address when running. Agent: engineer. Refs: PRD FR1
- [x] [Phase 4] Implement action components for Start, Stop, Backup, Restore, Hibernate, Resume with appropriate inputs (backup name, backup selection). Agent: engineer. Refs: PRD FR2-FR7
- [x] [Phase 4] Implement backup list display component with refresh capability. Agent: engineer. Refs: PRD FR8
- [x] [Phase 4] Implement loading states and progress indication for long-running operations. Agent: engineer. Refs: PRD FR10
- [x] [Phase 4] Implement notification/feedback system for success, error, and warning states. Agent: engineer. Refs: PRD FR9
- [x] [Phase 5] Connect all frontend components to API routes - integrate status polling, action triggers, and backup listing. Agent: engineer
- [x] [Phase 5] Implement confirmation dialogs for destructive actions (hibernate). Agent: engineer. Refs: PRD FR6
- [x] [engineer] Update API route imports after aws-client refactor - Update all files in `frontend/app/api/` that import from `@/lib/aws-client`. Verify imports still work since aws-client.ts now re-exports from aws/index.ts. Files to check: status/route.ts, start/route.ts, stop/route.ts, hibernate/route.ts, resume/route.ts, backup/route.ts, restore/route.ts, backups/route.ts, emails/route.ts, costs/route.ts, players/route.ts.

## Deleted

- [ ] [Phase 1] Initialize Next.js project with TypeScript and Tailwind CSS in frontend/ directory. Agent: engineer. Refs: PRD at goals/frontend-prd-2026-01-07.md
- [ ] [Phase 1] Research and decide on approach for listing Google Drive backups (rclone CLI vs Google Drive API vs SSM query). Document decision. Agent: researcher. Refs: bin/backup-from-ec2.sh, bin/restore-to-ec2.sh
