# Frontend Enhancements - Product Requirements Document

**Date:** January 8, 2026  
**Status:** Draft (Pending Review)  
**Project:** mc-aws (Minecraft Server Management)

---

## Summary

This PRD documents four new frontend features to enhance the mc-aws control panel:
1. **Email Management Panel** - View and manage the email allowlist for server triggers
2. **Resume with Restore Option** - Streamlined flow combining hibernation recovery with backup restoration
3. **Cost Dashboard** - Display AWS costs associated with the Minecraft server stack
4. **Player Count Display** - Show current player count when server is running

These features extend the existing frontend (documented in `goals/frontend-prd-2026-01-07.md`) without changing its core architecture.

---

## Goals

1. **Email Visibility** - Give admins visibility into which emails can trigger the server
2. **Streamlined Resume** - Reduce clicks when resuming from hibernation with a specific backup
3. **Cost Awareness** - Help admins understand ongoing costs of running the server
4. **Server Activity Insight** - Show whether players are currently online

## Non-Goals

- Email configuration changes that require CDK redeployment (admin email is set at deploy time)
- Real-time cost monitoring or alerting
- Detailed player information (names, activity logs)
- Automated cost optimization actions

---

## Feature 1: Email Management Panel

### Description
Display the current admin email and allow viewing/editing of the email allowlist. The allowlist controls which email addresses can trigger the server via SES.

### User Value
- Admins can see who is allowed to start the server
- Quick add/remove of allowed emails without accessing AWS Console
- Visibility into the configured admin email

### Technical Approach

**Data Storage:**
- **Admin Email**: Lambda environment variable `NOTIFICATION_EMAIL` (read-only from frontend)
- **Allowlist Emails**: SSM Parameter Store at `/minecraft/email-allowlist` (comma-separated)

**Existing Infrastructure:**
The Lambda function (`src/lambda/StartMinecraftServer/index.js`) already has:
- `getAllowlist()` function (lines 241-255) - reads from SSM
- `updateAllowlist(emails)` function (lines 262-271) - writes to SSM

**API Endpoints Needed:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/emails` | GET | Return admin email and allowlist |
| `/api/emails/allowlist` | PUT | Update the allowlist |

**GET /api/emails Response:**
```json
{
  "success": true,
  "data": {
    "adminEmail": "admin@example.com",
    "allowlist": ["friend1@example.com", "friend2@example.com"]
  }
}
```

**PUT /api/emails/allowlist Request:**
```json
{
  "emails": ["friend1@example.com", "friend2@example.com"]
}
```

### UI/UX Considerations

- Panel or modal accessible from main dashboard
- Display admin email (read-only, with note that it's set at deploy time)
- Editable list of allowlist emails with:
  - Visual list of current emails
  - Input field to add new email
  - Remove button for each email
  - Save/Cancel actions
- Validation: email format check before saving
- Success/error toast notifications on update

### Implementation Notes

- Frontend needs AWS SDK access to SSM (via `@aws-sdk/client-ssm`)
- The SSM parameter may not exist initially (handle gracefully)
- Empty allowlist = anyone can trigger (display this as a warning)

---

## Feature 2: Resume with Restore Option

### Description
When user clicks "Resume" to exit hibernation, display a modal with two options:
1. "Start Fresh World" - Resume without restoring a backup
2. "Restore from Backup" - Select a backup to restore

This combines the resume + restore flow into one streamlined interaction.

### User Value
- Saves steps when user knows they want a specific backup
- Clearer UX than separate Resume then Restore actions
- Prevents forgetting to restore after resuming

### Technical Approach

**Existing Infrastructure:**
The `/api/resume` endpoint (`frontend/app/api/resume/route.ts`) already supports:
- Optional `backupName` parameter in request body (line 86)
- Automatic restore after server is running (lines 121-125)

**No new API endpoints needed** - this is purely a frontend UI change.

**Flow:**
1. User clicks "Resume" button
2. Modal appears with two choices:
   - "Start Fresh" → calls `POST /api/resume` with no body
   - "Restore from Backup" → shows backup list, user selects, calls `POST /api/resume { backupName: "selected-backup" }`

### UI/UX Considerations

- Modal should match existing design language (luxury/classy aesthetic)
- Two clear choices with distinct visual treatment
- If "Restore from Backup" selected:
  - Fetch and display backup list (use existing `/api/backups` endpoint)
  - Show loading state while fetching
  - Allow search/filter if list is long
  - Display backup date/name for identification
- Progress indication during resume operation
- Clear messaging about what each option does

### Implementation Notes

- Reuse existing `BackupList` component if available
- Only show this modal when server state is "hibernated"
- For "stopped" state (EBS attached), Resume just starts - no backup choice needed

---

## Feature 3: Cost Dashboard

### Description
Display AWS costs associated with the Minecraft server stack, itemized by service (EC2, EBS, data transfer, etc.).

### User Value
- Transparency into running costs
- Help decide when to hibernate vs. leave running
- Identify unexpected cost spikes

### Technical Approach

**AWS Cost Explorer API:**
- Service: AWS Cost Explorer (`@aws-sdk/client-cost-explorer`)
- Request type: `GetCostAndUsage`
- Filter by: Resource tags or service names
- Granularity: MONTHLY or DAILY

**Cost Considerations:**
- Cost Explorer API costs ~$0.01 per request
- **Must be on-demand only** - no polling/auto-refresh
- Cache results in memory/localStorage for session

**API Endpoint Needed:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/costs` | GET | Return cost breakdown for the stack |

**Query Parameters:**
- `period`: "current-month" (default), "last-month", or "last-30-days"

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "start": "2026-01-01", "end": "2026-01-08" },
    "totalCost": "12.47",
    "currency": "USD",
    "breakdown": [
      { "service": "Amazon EC2", "cost": "8.32" },
      { "service": "Amazon EBS", "cost": "2.15" },
      { "service": "Data Transfer", "cost": "2.00" }
    ],
    "fetchedAt": "2026-01-08T10:30:00Z"
  }
}
```

**Filtering Strategy:**
Option A: Filter by resource tags
- Stack uses `Backup: weekly` tag on EC2 instance
- Could add a dedicated tag like `Stack: MinecraftServer` in CDK

Option B: Filter by service in specific region
- Less precise but simpler

**Recommendation:** Add a `Stack: MinecraftServer` tag to all CDK resources, then filter by this tag in Cost Explorer.

### UI/UX Considerations

- "Costs" button in header or as new panel
- Modal or expandable panel showing:
  - Total cost for period (prominent)
  - Breakdown by service (table or bar chart)
  - Period selector (current month / last month)
  - "Last fetched" timestamp
  - Note about $0.01 API cost
- Loading state while fetching
- Refresh button (with confirmation about API cost)

### Open Questions

1. **Tag Strategy**: Should we add a `Stack: MinecraftServer` tag via CDK update?
   - If yes, requires CDK deployment before feature is useful
   - If no, filter by region/account (less precise)

2. **Historical Data**: How far back should we support?
   - Recommendation: Current month and previous month only

---

## Feature 4: Player Count Display

### Description
Display the current number of players online when the server is running.

### User Value
- Know if anyone is playing before shutting down
- Decide whether to keep server running
- Activity visibility without joining the game

### Technical Approach

**Current Implementation:**
The EC2 instance runs `check-mc-idle.sh` via cron, which:
- Uses `mcstatus localhost status` to query player count (line 29)
- Parses output like `players: 2/20`
- Logs to systemd journal

**Challenge:** This data exists only on the EC2 instance. Need to expose it to the frontend.

**Options Evaluated:**

| Option | Approach | Latency | Complexity | Notes |
|--------|----------|---------|------------|-------|
| A | SSM command to run `mcstatus` on demand | 5-10s | Medium | Most accurate, adds API latency |
| B | Store player count in SSM parameter (cron updates) | <1s | Medium | May be up to 5min stale |
| C | Direct query via Minecraft Query Protocol | 1-2s | High | Requires security group change |
| D | RCON query from Lambda | 1-2s | High | Requires RCON setup, credentials |

**Recommendation: Option B** - Store player count in SSM parameter
- Modify `check-mc-idle.sh` to write player count to `/minecraft/player-count` SSM parameter
- Frontend queries SSM parameter (fast, cheap)
- Accept 1-5 minute staleness (acceptable for this use case)
- Show "last updated" timestamp to set expectations

**API Endpoint Needed:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/players` | GET | Return current player count |

**Response:**
```json
{
  "success": true,
  "data": {
    "count": 2,
    "maxPlayers": 20,
    "lastUpdated": "2026-01-08T10:25:00Z"
  }
}
```

**Fallback:** If SSM parameter doesn't exist or server isn't running, return:
```json
{
  "success": true,
  "data": {
    "count": null,
    "maxPlayers": null,
    "lastUpdated": null,
    "message": "Player count unavailable"
  }
}
```

### UI/UX Considerations

- Display in status panel (e.g., "2 players online")
- Only show when server is running
- Subtle styling - not the primary information
- Show "last updated X minutes ago" if data is stale
- Refresh with main status refresh (not separate polling)
- Graceful handling when unavailable

### EC2 Script Changes Required

Modify `src/ec2/check-mc-idle.sh` to write player count to SSM:

```bash
# After parsing PLAYERS variable, write to SSM
aws ssm put-parameter \
  --name "/minecraft/player-count" \
  --value "$PLAYERS" \
  --type "String" \
  --overwrite 2>/dev/null || true
```

**Note:** EC2 instance already has SSM permissions but needs `ssm:PutParameter` for this new parameter. CDK update required.

---

## Dependencies & References

### Existing Code to Reference

| File/Directory | Purpose | Relevance |
|----------------|---------|-----------|
| `src/lambda/StartMinecraftServer/index.js` | Lambda with email allowlist functions | Feature 1: `getAllowlist()`, `updateAllowlist()` |
| `lib/minecraft-stack.ts` | CDK stack definition | Feature 1: SSM permissions; Feature 3: tags; Feature 4: SSM permissions |
| `frontend/app/api/resume/route.ts` | Resume API endpoint | Feature 2: Already supports `backupName` param |
| `src/ec2/check-mc-idle.sh` | Idle check script with mcstatus | Feature 4: Player count source |
| `frontend/lib/aws-client.ts` | AWS SDK client setup | All features: Extend for SSM, Cost Explorer |
| `frontend/lib/types.ts` | TypeScript types | All features: Add new response types |
| `goals/frontend-prd-2026-01-07.md` | Original frontend PRD | Design language, aesthetic guidelines |

### Environment Variables

Existing (no changes):
- `AWS_REGION`, `AWS_ACCOUNT_ID` - For AWS SDK
- `NOTIFICATION_EMAIL` - Feature 1 (read-only display)

### AWS Services

| Service | Feature | New Usage |
|---------|---------|-----------|
| SSM Parameter Store | 1, 4 | Read/write `/minecraft/email-allowlist`, `/minecraft/player-count` |
| Cost Explorer | 3 | Query `GetCostAndUsage` |

### IAM Permissions Required

**Frontend API (via local AWS credentials):**
- `ssm:GetParameter` for `/minecraft/email-allowlist`, `/minecraft/player-count`
- `ssm:PutParameter` for `/minecraft/email-allowlist`
- `ce:GetCostAndUsage` for Cost Explorer

**EC2 Instance (CDK update needed for Feature 4):**
- `ssm:PutParameter` for `/minecraft/player-count`

---

## Implementation Priority

Suggested order based on complexity and dependencies:

| Priority | Feature | Complexity | Dependencies |
|----------|---------|------------|--------------|
| 1 | Email Management Panel | Low | None (SSM infrastructure exists) |
| 2 | Resume with Restore Option | Low | None (API already supports it) |
| 3 | Player Count Display | Medium | EC2 script change + CDK update |
| 4 | Cost Dashboard | Medium | Cost Explorer permissions + tag strategy |

---

## Open Questions

1. **Feature 3 (Costs)**: Should we add a `Stack: MinecraftServer` tag to CDK resources for better filtering?

2. **Feature 4 (Players)**: Is 1-5 minute staleness acceptable, or do we need real-time?

3. **Feature 4 (Players)**: Should we also display player names (requires more complex mcstatus parsing)?

4. **UI Placement**: Where should the new panels/buttons live in the existing UI layout?

---

## Success Criteria

1. **Feature 1**: Admin can view and edit email allowlist from frontend; changes persist to SSM
2. **Feature 2**: Resuming from hibernation prompts for backup selection; restore happens in same flow
3. **Feature 3**: Costs modal shows itemized AWS costs for current and previous month
4. **Feature 4**: Player count displays on status panel when server is running; updates within 5 minutes of actual change

---

## Out of Scope (Future Considerations)

- Multi-user access control (beyond email allowlist)
- Real-time player notifications
- Cost alerts or budgeting
- Player activity history/analytics
- Server performance metrics (CPU, memory)
