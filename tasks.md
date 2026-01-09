# Tasks - Tasks

## In Progress

- [ ] Test backup command via email

## To Do

- [ ] Test restore command via email
- [ ] Test restore command via email
- [ ] Test hibernate/resume cycle

## Phase 4: Frontend UI (Luxury Design)

- [ ] Setup Tailwind with "Luxury" theme (Cream background, Serif fonts)
- [ ] Implement UI Components (LuxuryButton, StatusIndicator, Spinning Decagon)
- [ ] Assemble Main Control Interface (page.tsx)
- [ ] Integrate Backend API with UI


## Backlog


## Done

- [x] Create EC2 management scripts (mc-backup.sh, mc-restore.sh, mc-hibernate.sh, mc-resume.sh)
- [x] Update user_data.sh to deploy management scripts on boot
- [x] Update Lambda to parse commands from subject line
- [x] Update Lambda to use SSM SendCommand for EC2 script execution
- [x] Update CDK to grant Lambda SSM permissions
- [x] Update CDK to grant EC2 volume management permissions
- [x] Update README with new email command documentation
