# Tasks - Tasks

## In Progress

- [ ] Integrate async-start semantics: /api/start sets server-action lock and does NOT clear it; StartMinecraftServer lambda clears it; update mock provider invokeLambda to simulate this correctly

## To Do

- [ ] Test backup command via email
- [ ] Update unit tests/mocks for async-start: fix app/api/start/route.test.ts mocks and align tests/mocks/handlers.ts /api/start response with new async contract
- [ ] Test restore command via email
- [ ] Test restore command via email
- [ ] Test hibernate/resume cycle

## Backlog


## Done

- [x] Create EC2 management scripts (mc-backup.sh, mc-restore.sh, mc-hibernate.sh, mc-resume.sh)
- [x] Update user_data.sh to deploy management scripts on boot
- [x] Update Lambda to parse commands from subject line
- [x] Update Lambda to use SSM SendCommand for EC2 script execution
- [x] Update CDK to grant Lambda SSM permissions
- [x] Update CDK to grant EC2 volume management permissions
- [x] Update README with new email command documentation

## Phase 4: Frontend UI (Luxury Design)

- [ ] Setup Tailwind with "Luxury" theme (Cream background, Serif fonts)
- [ ] Implement UI Components (LuxuryButton, StatusIndicator, Spinning Decagon)
- [ ] Assemble Main Control Interface (page.tsx)
- [ ] Integrate Backend API with UI
