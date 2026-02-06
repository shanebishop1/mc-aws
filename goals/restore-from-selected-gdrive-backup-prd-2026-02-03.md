# PRD: Restore From Selected Google Drive Backup (Main UI Restore)

## Summary
Add a selection step to the main UI **Restore** button so an admin can restore from a specific Google Drive backup (configured by `GDRIVE_REMOTE`/`GDRIVE_ROOT`). The flow must show the chosen backup name in the confirmation UI and must not initiate a restore without an explicitly chosen/entered backup name. If backup listing fails, the user can still paste/type a backup name (MVP fallback).

## Goals
- Main UI **Restore** action supports restoring from a user-selected backup name.
- Confirmation UI clearly displays the backup name that will be restored.
- Admin-only access is preserved end-to-end (UI gating + API auth).
- Backup listing is reused from existing `/api/backups` behavior (no new AWS permissions).
- If listing is unavailable (error/caching/empty), the user can still type/paste a backup name and proceed.
- Automated tests cover the new flow (unit and/or Playwright).

## Non-Goals
- Building a full backup browser (search, paging, metadata-rich UI) beyond basic selection.
- Adding new AWS IAM permissions or new AWS services for this feature.
- Guaranteeing the selected backup still exists at restore time (we will validate/sanitize the name; existence is ultimately enforced by the restore script/rclone).

## Users
- Primary: Admin users managing the Minecraft server.
- Secondary: None (restore remains admin-only).

## Use Cases
1. Admin clicks **Restore** and selects a backup from a list; confirms restore.
2. Admin clicks **Restore**, listing fails; admin manually enters a backup name; confirms restore.
3. Admin attempts restore without selecting/entering a name; UI prevents confirmation.

## UX / Interaction
### Entry Point
- Main UI **Restore** button (currently a simple confirmation dialog) becomes a restore dialog that includes:
  - A backup name input (MVP requirement).
  - An optional list/dropdown populated from `/api/backups` (ideal).

### Restore Dialog Requirements
- Must always show a single, explicit “Backup to restore” value before confirmation.
- Confirm button disabled until a non-empty backup name is present.
- Selecting a backup from the list sets the input value.
- If `/api/backups` returns `status: "caching"`, poll (similar to existing `components/ResumeModal.tsx`) until `listing` or timeout.
- If listing fails:
  - Show a non-blocking error state (“Couldn’t load backups…”) but keep the input enabled.
  - User can proceed by typing/pasting a backup name.

### Confirmation Copy
- Confirmation UI includes the backup name prominently (e.g., “Restore from: `<backupName>`”).
- Warning text: restoring overwrites current server state.

## Technical Design
### Frontend
- Add a new modal/dialog for main restore (suggested location: `components/ui/RestoreDialog.tsx` or `components/RestoreModal.tsx`).
- Reuse:
  - `GET /api/backups` for listing.
  - `components/backup/BackupSelectionList.tsx` to render selectable names.
  - Existing “Google Drive setup required” gating in `components/ControlsSection.tsx`.
- Update `components/ControlsSection.tsx` restore handler to open the new restore dialog instead of `ConfirmationDialog`.
- Ensure the restore request sends the selected backup name: `POST /api/restore` with JSON body `{ backupName: "..." }`.

### Backend (Next.js API)
- Continue using existing `POST /api/restore` behavior and request schema (`backupName` and/or `name`).
- Keep admin-only enforcement via `requireAdmin`.
- Defense-in-depth: keep `sanitizeBackupName()` validation on the provided name.
- No new endpoints required.

### Backend (Lambda)
- Fix the current mismatch between `/api/restore` (which can send `args: []`) and the Lambda restore handler (which currently requires `args[0]`).
- Update `infra/src/lambda/StartMinecraftServer/handlers/restore.js` to:
  - Accept missing `args[0]`.
  - If a name is provided, sanitize and call `/usr/local/bin/mc-restore.sh <name>`.
  - If no name is provided, call `/usr/local/bin/mc-restore.sh` with no args.
  - Rationale: `infra/src/ec2/mc-restore.sh` already supports finding the latest backup when no name is provided.

## Security / Permissions
- Preserve admin-only access:
  - UI remains gated by admin state.
  - APIs `/api/restore` and `/api/backups` already enforce admin via `requireAdmin`.
- Avoid new IAM permissions:
  - `/api/backups` reuses the existing Lambda `refreshBackups` command and SSM cache parameter.

## Success Criteria
- Admin can restore from a chosen backup using the main Restore button without navigating to the Resume modal.
- UI prevents accidental/implicit restore: user must see and confirm a specific backup name.
- Listing failures do not block restore (manual name entry works).
- Playwright E2E test(s) validate the selection/entry flow.

## Acceptance Criteria (Must)
- Admin-only access preserved.
- Restore confirmation UI displays the backup name that will be restored.
- No restore request is sent without an explicit backup name being chosen/entered.
- If listing fails, user can still paste/type a backup name and proceed.
- Reuse existing `/api/backups` behavior if feasible; avoid new AWS permissions.
- Tests updated/extended to cover the new flow.

## Dependencies & References
- Main Restore API: `app/api/restore/route.ts`
- Backup listing API: `app/api/backups/route.ts`
- Restore Lambda handler: `infra/src/lambda/StartMinecraftServer/handlers/restore.js`
- Backup listing Lambda handler: `infra/src/lambda/StartMinecraftServer/handlers/backups.js`
- Restore script (supports no-arg “latest”): `infra/src/ec2/mc-restore.sh`
- Main UI controls / current Restore dialog: `components/ControlsSection.tsx`
- Existing backup selection UI pattern (Resume flow): `components/ResumeModal.tsx`
- Backup list component: `components/backup/BackupSelectionList.tsx`
- E2E tests to extend: `tests/e2e/backup-restore.spec.ts`

## Risks / Notes
- Backup list cache may be stale; UI should treat the displayed list as “best effort” and still allow manual entry.
- Backup name formatting (with or without `.tar.gz`) should be consistent; server-side sanitization should accept the canonical form used in Google Drive.
- Polling for `status: "caching"` should have a timeout and clear error messaging to avoid trapping the user.
