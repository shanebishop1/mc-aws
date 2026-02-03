# Frontend Control Panel - Product Requirements Document

**Date:** January 7, 2026  
**Status:** Draft  
**Project:** mc-aws (Minecraft Server Management)

---

## Summary

Build a locally-running web frontend for the mc-aws Minecraft server management system. This frontend will replace CLI scripts and email triggers as the primary admin interface, providing a visual control panel to manage all server operations from a single page.

---

## Goals

1. **Unified Control Interface** - Expose all 6 server management actions (Start, Stop, Backup, Restore, Hibernate, Resume) through a single web interface
2. **Server Visibility** - Display current server state and health at a glance
3. **Backup Management** - List and select available backups from Google Drive for restore/resume operations
4. **Operational Feedback** - Provide clear feedback on operation status, progress, and outcomes
5. **Local-First** - Run entirely locally; no external hosting required

## Non-Goals

- **Multi-user authentication** - Single admin user assumed; no auth system needed
- **Mobile-first design** - Desktop browser is primary target (responsive is nice-to-have)
- **Remote hosting** - Not designed for deployment to a public server
- **Real-time server metrics** - No live CPU/memory/player monitoring (server status only)
- **Automated scheduling** - No cron-like scheduled operations from frontend

---

## Users

**Primary User:** Server admin (single person)
- Technical familiarity: Comfortable with command line but prefers visual interface for routine operations
- Usage context: Local machine, likely macOS/Linux dev environment
- Usage frequency: Sporadic (when wanting to play or manage the server)

---

## Use Cases

### UC1: Check Server Status
Admin opens frontend and immediately sees whether server is running, stopped, or hibernated (no EBS attached).

### UC2: Start the Server
Admin clicks to start the server, sees progress indication, and receives confirmation when server is ready with the current IP/DNS.

### UC3: Stop the Server
Admin clicks to stop the server (EC2 instance stops but EBS remains attached for quick restart).

### UC4: Create Backup
Admin initiates a backup, optionally providing a custom name. Progress is shown during the backup process.

### UC5: Restore from Backup
Admin views available backups from Google Drive, selects one, and initiates restore. Server restarts with restored data.

### UC6: Hibernate for Cost Savings
Admin triggers hibernation which backs up data, stops EC2, and deletes EBS. Clear warning about the destructive nature of this action.

### UC7: Resume from Hibernation
Admin selects a backup (or uses most recent) and triggers resume which creates new EBS, starts EC2, and restores data.

### UC8: View Available Backups
Admin can browse the list of backups stored on Google Drive with timestamps/names.

---

## Success Criteria

1. All 6 core operations are accessible and functional from the frontend
2. Server state is accurately reflected in the UI
3. Operations provide feedback (loading states, success/failure notifications)
4. Backup list is retrievable and displayed for selection
5. Error states are handled gracefully with user-friendly messages
6. Frontend starts successfully with a single command (e.g., `pnpm dev`)

---

## Functional Requirements

### FR1: Server Status Display
- **Requirement:** Show current server state
- **States to detect:** Running, Stopped, Hibernated (no volume), Terminated, Pending/Transitioning
- **Data source:** AWS EC2 API (DescribeInstances)
- **Refresh:** On page load and after operations; manual refresh capability

### FR2: Server Start Action
- **Requirement:** Trigger server start (handles both normal start and resume-from-hibernation)
- **Behavior:** 
  - If hibernated: Create volume, attach, start EC2
  - If stopped: Start EC2
  - Update Cloudflare DNS
- **Feedback:** Progress indication, final IP/DNS displayed

### FR3: Server Stop Action
- **Requirement:** Stop the running EC2 instance (EBS remains attached)
- **Behavior:** Call EC2 StopInstances
- **Feedback:** Confirmation when stopped

### FR4: Backup Action
- **Requirement:** Trigger backup to Google Drive
- **Inputs:** Optional custom backup name
- **Behavior:** Execute backup script via SSM on EC2
- **Feedback:** Progress indication, confirmation with backup name

### FR5: Restore Action
- **Requirement:** Restore server from a selected backup
- **Inputs:** Backup selection (from list)
- **Precondition:** Server must be running
- **Behavior:** Execute restore script via SSM on EC2
- **Feedback:** Progress indication, confirmation when complete

### FR6: Hibernate Action
- **Requirement:** Full hibernation (backup + stop + delete EBS)
- **Precondition:** User confirmation (destructive action)
- **Behavior:** Backup to Drive, stop EC2, detach/delete EBS
- **Feedback:** Progress through each stage, final confirmation

### FR7: Resume Action
- **Requirement:** Resume from hibernation with selected backup
- **Inputs:** Backup selection (optional - defaults to most recent)
- **Precondition:** Server must be hibernated (no EBS)
- **Behavior:** Create EBS, start EC2, restore from backup
- **Feedback:** Progress through each stage, final confirmation with IP/DNS

### FR8: Backup Listing
- **Requirement:** Display available backups from Google Drive
- **Data:** Backup name/filename, timestamp, size (if available)
- **Source:** Google Drive via rclone or Drive API
- **Behavior:** List should be refreshable

### FR9: Error Handling
- **Requirement:** Graceful error handling for all operations
- **Display:** User-friendly error messages (not raw stack traces)
- **Recovery:** Clear indication of what went wrong and potential remediation

### FR10: Loading/Progress States
- **Requirement:** Visual indication when operations are in progress
- **Behavior:** Prevent duplicate submissions, show progress for long-running operations

---

## Technical Constraints

1. **Stack:** Next.js with TypeScript, React, Tailwind CSS
2. **Location:** `frontend/` directory within mc-aws repo
3. **Backend:** Next.js API routes (no separate backend service)
4. **AWS Access:** Uses local AWS credentials (same as CLI scripts)
5. **No Auth:** Single admin user, no authentication layer
6. **Package Manager:** PNPM
7. **Formatting & Linting:** Biome

---

## Dependencies & References

### Existing Code to Reference

| File/Directory | Purpose | Relevance |
|----------------|---------|-----------|
| `bin/hibernate.sh` | CLI hibernation script | Understand flow for FR6 |
| `bin/resume.sh` | CLI resume script | Understand flow for FR7 |
| `bin/backup-from-ec2.sh` | CLI backup script | Understand backup modes (local/drive) |
| `bin/restore-to-ec2.sh` | CLI restore script | Understand restore flow |
| `src/lambda/StartMinecraftServer/index.js` | Lambda handler for all commands | Primary reference for AWS API calls, SSM command execution, Cloudflare DNS updates |
| `src/ec2/mc-backup.sh` | EC2-side backup script | Understand what runs on server |
| `src/ec2/mc-restore.sh` | EC2-side restore script | Understand what runs on server |
| `lib/minecraft-stack.ts` | CDK stack definition | Understand infrastructure (instance IDs, security groups, etc.) |
| `.env` | Environment variables | Required config values |

### Design Guidelines

| File | Purpose |
|------|---------|
| `frontend-design.md` | General aesthetic guidelines |
| **Design Direction** | **"Ironically Classy" / Luxury Invitation** |

### Design Specification (Phase 4)

**Aesthetic:** "High-End / Old Money" Luxury. The interface should feel like a premium physical object (gala invitation, fine wine menu, luxury watch catalog) juxtaposed with server management.

**Visual Language:**
- **Background:** Rich, matte cream/off-white (Hex: `#F9F7F2`) with subtle paper grain texture.
- **Typography:**
    - *Headings:* Elegant, high-contrast Serif (e.g., Playfair Display, Didot). Heavy use of **italics** for emphasis (e.g., *Online*).
    - *Body:* Minimal, geometric sans-serif (e.g., Inter, Geist), widely spaced.
- **Color Palette:**
    - *Primary:* Sharp Ink Black (`#1A1A1A`).
    - *Accent:* Deep British Racing Green / Forest Green (`#1A4222`).
- **Layout:** Centered, symmetrical, heavy negative space.

**Key Visual Elements:**
1. **Center Shape Animation:** A central geometric shape (e.g., decagon) that:
    - Slowly spins.
    - "Breathes" (scales gently in and out).
    - Acts as a status anchor.
    - **NO** literal Minecraft icons (no emeralds, no blocks).
2. **Controls:** Minimalist text links or sophisticated outlined buttons. "Start" button should feel tactile (outlined -> solid fill on hover).
3. **Motion:** Playful but restrained micro-interactions (staggered reveals, smooth color transitions).

**Implementation Phases:**
- **Phase 4:** Frontend UI Implementation (Assembly of pages and components matching this design).

### Environment Variables Required

From `.env`:
- `AWS_REGION` - AWS region
- `AWS_ACCOUNT_ID` - For resource identification
- `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, `CLOUDFLARE_MC_DOMAIN`, `CLOUDFLARE_DNS_API_TOKEN` - DNS updates
- `GDRIVE_REMOTE`, `GDRIVE_ROOT` - Google Drive config for backup listing

### External Services

- **AWS EC2** - Instance management (start, stop, describe)
- **AWS SSM** - Execute commands on EC2 (backup, restore scripts)
- **Cloudflare API** - DNS record updates
- **Google Drive** - Backup storage (via rclone)

---

## Open Questions for Implementation

1. **Backup Listing Mechanism:** How to list Google Drive backups from the frontend?
   - Option A: Call rclone CLI from API route
   - Option B: Use Google Drive API directly
   - Option C: Query via SSM command on running EC2
   - *Implementing agent should research and decide*

2. **Long-Running Operations:** How to handle operations that take minutes (hibernate, resume)?
   - Option A: Polling from frontend
   - Option B: Server-sent events
   - Option C: WebSocket
   - *Implementing agent should decide based on complexity trade-offs*

3. **State Detection:** How to reliably detect "hibernated" state (stopped + no EBS)?
   - Need to check both instance state AND block device mappings
   - *Reference existing Lambda code for approach*

4. **Stop Action:** Currently no explicit "stop" in Lambda - only hibernate.
   - Need to implement simple EC2 stop (without EBS deletion)
   - *May need to add this capability*

---

## Out of Scope (Future Considerations)

- Player count / active player list display
- Server logs viewer
- Server properties editor
- Whitelist management from UI
- Cost tracking / billing display
- Multi-server support
