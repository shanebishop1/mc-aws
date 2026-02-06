# Tasks - Restore Ui Backup Selection

## In Progress


## To Do


## Backlog


## Done

- [x] Engineer: Fix Lambda restore handler to accept missing backup arg (call mc-restore.sh with/without arg). Refs: `infra/src/lambda/StartMinecraftServer/handlers/restore.js`, `infra/src/ec2/mc-restore.sh`. Acceptance: restore works with `args:[]` and with `args:[name]`; no longer throws on empty args; backup name still sanitized when provided.
- [x] Engineer: Add main-UI Restore dialog that supports backup selection + manual entry. Refs: `components/ControlsSection.tsx`, `components/ui/BackupDialog.tsx` (patterns), `components/ResumeModal.tsx` (polling), `components/backup/BackupSelectionList.tsx`, `app/api/backups/route.ts`. Acceptance: dialog shows input (MVP); attempts to list backups via `/api/backups` (ideal); if listing fails, input remains usable; confirm is disabled until a non-empty name is present; confirmation UI displays the chosen name.
- [x] Engineer: Wire Restore button to use the new dialog and POST `/api/restore` with `{ backupName }`. Refs: `app/api/restore/route.ts`, `components/ControlsSection.tsx`, `app/page.tsx` (handleAction plumbing). Acceptance: main Restore no longer sends an empty body by default; selected/typed name is sent; admin-only behavior preserved; Google Drive setup gating remains unchanged.
- [x] Engineer: Update/extend unit tests for restore API and/or lambda restore handler. Refs: `app/api/restore/route.ts`, existing route tests in `app/api/**/route.test.ts`. Acceptance: tests cover (a) restore request includes `backupName` and returns 202, (b) restore with empty body is still tolerated (back-compat) and does not fail due to Lambda arg validation regression.
- [x] Engineer: Update Playwright restore E2E to cover new flow (select from list + typed fallback). Refs: `tests/e2e/backup-restore.spec.ts`, e2e helpers `tests/e2e/setup.ts` + mock parameter helpers, `/minecraft/backups-cache` behavior in `app/api/backups/route.ts`. Acceptance: test sets backups cache (or mocks listing), selects a backup, sees backup name in confirmation UI, confirms restore, and sees async success message; add a second assertion path where listing errors and user types a name to proceed.
- [x] Engineer: UX/accessibility pass for the new Restore dialog. Refs: `components/ui/BackupDialog.tsx` (focus trap/escape), `components/ui/ConfirmationDialog.tsx` (dialog semantics). Acceptance: escape closes when not loading; focus starts in input; click-outside behavior matches existing dialogs; add stable `data-testid` attributes for E2E.

## Notes

- Restore selection feature: Task 23qA complete. Lambda restore now accepts missing backup arg and runs `mc-restore.sh` with no arg to restore latest. Validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test` (Tue 2026-02-03).
- Task 4V6A committed: Restore selection dialog UI (`components/backup/RestoreDialog.tsx`, `components/backup/index.ts`). Commit 513a361. Validation: `pnpm lint` + `pnpm typecheck` + `pnpm test` pass after lint warning fix.
- Task 7RxA: Added restore API route unit tests covering backupName, empty body back-compat, legacy `name`, and precedence. Fixed mock leak with `mockRejectedValueOnce`. Validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Task 5P4Q committed: Controls restore button now opens RestoreDialog and POSTs `/api/restore` with `{ backupName }`. Commit d53313d65759a66c0beb4dafb987665aac565538.
- Task 7RxA committed: restore API unit tests added (`app/api/restore/route.test.ts`). Commit 37df884.
