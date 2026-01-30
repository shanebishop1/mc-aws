# Backend API Implementation Summary

## Overview

I have successfully implemented the core backend API routes for the Minecraft server control panel. The implementation provides a complete foundation for managing the EC2-based Minecraft server through HTTP endpoints.

## Mock Mode for Local Development

The project includes a comprehensive mock mode for offline development and testing without AWS resources.

### Quick Start

```bash
# Start dev server in mock mode
pnpm dev:mock

# Run E2E tests in mock mode
pnpm test:e2e:mock

# Reset mock state
pnpm mock:reset

# List and apply scenarios
pnpm mock:scenario
pnpm mock:scenario running
```

### Features

- **Offline testing**: No AWS credentials or infrastructure required
- **Deterministic scenarios**: 10 built-in scenarios (running, stopped, starting, stopping, hibernated, high-cost, no-backups, many-players, stack-creating, errors)
- **Fault injection**: Test error handling by injecting failures
- **Fast feedback**: No network latency or AWS API calls
- **State persistence**: Optional JSON file persistence for debugging

### Documentation

See [../MOCK_MODE_DEVELOPER_GUIDE.md](../MOCK_MODE_DEVELOPER_GUIDE.md) for comprehensive mock mode documentation.

## Files Created

### Library Files (4 files in `/lib/`)

1. **`lib/env.ts`** (27 lines)
   - Environment variable validation and export
   - Loads AWS, Cloudflare, and Google Drive config from `.env`
   - Throws error immediately if required variables are missing

2. **`lib/types.ts`** (41 lines)
   - TypeScript type definitions for all API responses
   - `ServerState` type with all supported states
   - Generic `ApiResponse<T>` wrapper for consistency

3. **`lib/aws-client.ts`** (430+ lines)
   - EC2 and SSM client initialization
   - Core AWS operations with polling and timeout protection:
     - **State detection:** `getInstanceState()` - Detects hibernating state (stopped + no volumes)
     - **Instance management:** `startInstance()`, `stopInstance()`, `waitForInstanceRunning()`
     - **IP management:** `getPublicIp()` - Polls for up to 5 minutes with 1-second intervals
     - **Hibernation recovery:** `handleResume()` - Creates 8GB GP3 volume from latest AL2023 ARM64 AMI snapshot
     - **Future support:** `executeSSMCommand()` - Ready for backup/restore operations

4. **`lib/cloudflare.ts`** (33 lines)
   - Cloudflare DNS API integration
   - `updateCloudflareDns()` - Updates A record with instance IP
   - Handles API errors with detailed logging

### API Route Files (3 routes in `/app/api/`)

1. **`app/api/status/route.ts`** (45 lines)
   - **Endpoint:** `GET /api/status`
   - **Purpose:** Check current server state
   - **Returns:** Server state, instance ID, public IP (if running), timestamp
   - **States detected:** running, stopped, hibernating, pending, stopping, terminated, unknown

2. **`app/api/start/route.ts`** (80 lines)
   - **Endpoint:** `POST /api/start`
   - **Purpose:** Start the server with full automation
   - **Features:**
     - Detects hibernation state and creates volume if needed
     - Creates 8GB GP3 volume from AMI snapshot
     - Waits for volume attachment (with timeout)
     - Sends EC2 start command
     - Polls for running state
     - Polls for public IP assignment
     - Updates Cloudflare DNS automatically
   - **Returns:** Instance ID, public IP, domain, success message

3. **`app/api/stop/route.ts`** (56 lines)
   - **Endpoint:** `POST /api/stop`
   - **Purpose:** Stop the server (keeps EBS volume)
   - **Features:**
     - Validates state before stopping
     - Prevents stopping if already stopped
     - Does NOT delete volume (that's for hibernation)
   - **Returns:** Instance ID, confirmation message

### Documentation

**`API.md`** (350+ lines)
- Comprehensive API documentation
- Request/response examples for all endpoints
- Environment variable configuration guide
- Error handling patterns
- Security notes
- Testing instructions
- Future enhancement roadmap

## Implementation Features

### ✅ Core Functionality
- [x] Server state detection (all 6+ states supported)
- [x] Hibernation recovery (volume creation, attachment, waiting)
- [x] EC2 instance management (start/stop)
- [x] Public IP polling with timeout
- [x] Cloudflare DNS updates
- [x] Comprehensive error handling

### ✅ Quality & Reliability
- [x] TypeScript with full type safety
- [x] Timeout protection on all polling operations
- [x] Consistent JSON response format
- [x] Detailed console logging for debugging
- [x] Error messages that are user-friendly
- [x] No unhandled promise rejections

### ✅ AWS Operations
- [x] EC2 API: DescribeInstances, StartInstances, StopInstances
- [x] EC2 Volume: CreateVolume, AttachVolume, DescribeVolumes
- [x] EC2 Images: DescribeImages (for AMI lookup)
- [x] SSM API: SendCommand, GetCommandInvocation (prepared for future use)

### ✅ Polling Mechanisms
- [x] Public IP polling: 300 attempts × 1s = 5 minute max
- [x] Instance startup: 300 second timeout with 2s polling
- [x] Volume availability: 60 attempts × 5s = 5 minute max
- [x] Volume attachment: 60 attempts × 2s = 2 minute max
- [x] Early abort if instance enters failed state

## Environment Variables Required

```env
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
INSTANCE_ID=i-1234567890abcdef0

# Cloudflare Configuration
CLOUDFLARE_ZONE_ID=abc123xyz789
CLOUDFLARE_RECORD_ID=record123xyz
CLOUDFLARE_MC_DOMAIN=minecraft.example.com
CLOUDFLARE_API_TOKEN=your-api-token-here

# Google Drive (optional for future use)
GDRIVE_REMOTE=gdrive
GDRIVE_ROOT=/Minecraft-Backups
```

## Dependencies Added

Updated `package.json` with:
- `@aws-sdk/client-ec2@^3.547.0` - EC2 operations
- `@aws-sdk/client-ssm@^3.547.0` - SSM operations (for future backup/restore)

Run `pnpm install` to install these dependencies.

## Architecture Decisions

### 1. **State Detection Logic**
Used the approach from the Lambda code: check both instance state AND block device mappings to detect hibernation (stopped + no volumes).

### 2. **Polling Strategy**
- Separate timeouts for each operation type (start, IP, volume)
- Early abort conditions to prevent waste
- Reasonable intervals balancing responsiveness and API calls

### 3. **Error Handling**
- Consistent API response format with `success` flag
- Human-readable error messages (not stack traces)
- HTTP status codes: 200 (success), 400 (invalid state), 500 (error)

### 4. **Module Organization**
- **lib/**: Reusable utilities (AWS, Cloudflare, types)
- **app/api/**: Route handlers
- Each route is independent and can be tested individually

### 5. **Volume Recovery**
Implemented full hibernation recovery:
1. Check if instance has no volumes
2. Look up latest AL2023 ARM64 AMI
3. Extract snapshot from AMI
4. Create 8GB GP3 volume with encryption
5. Wait for availability
6. Attach to `/dev/xvda` (root device)
7. Wait for attachment completion

## What's Ready for Future Enhancement

The framework supports these planned features from the PRD:

### Backup/Restore (Ready)
- `executeSSMCommand()` utility already implemented
- Just need to add routes: `/api/backup`, `/api/restore`
- Can call `/usr/local/bin/mc-backup.sh` and `/usr/local/bin/mc-restore.sh`

### Hibernation (Ready)
- State detection works correctly
- Volume deletion logic is in the Lambda code
- Route `/api/hibernate` can call similar workflow

### Backup Listing (Partial)
- Framework ready for `/api/backups` endpoint
- Can use `executeSSMCommand()` to call rclone or GDRIVE_REMOTE config

## Testing Instructions

1. **Install dependencies:**
   ```bash
   cd frontend
   pnpm install
   ```

2. **Start dev server:**
   ```bash
   pnpm dev
   ```

3. **Test status endpoint:**
   ```bash
   curl http://localhost:3000/api/status
   ```

4. **Test start endpoint:**
   ```bash
   curl -X POST http://localhost:3000/api/start
   ```

5. **Test stop endpoint:**
   ```bash
   curl -X POST http://localhost:3000/api/stop
   ```

## Key Implementation Details

### State Mapping
- `running` → Instance state is "running"
- `stopped` → Instance state is "stopped" AND has volumes
- `hibernating` → Instance state is "stopped" AND NO volumes
- `pending` → Instance state is "pending"
- `stopping` → Instance state is "stopping"
- `terminated` → Instance state is "terminated"
- `unknown` → Error or unrecognized state

### Start Operation Flow
1. Get current state
2. If running, return current IP
  3. Create/attach volume if hibernating (handleResume)
4. Send EC2 StartInstances command
5. Poll instance state until "running" (max 5 min)
6. Poll for public IP assignment (max 5 min)
7. Update Cloudflare DNS
8. Return IP to client

### Error Recovery
- All operations have max timeout limits
- Early abort if instance enters failed state during polling
- Cloudflare errors are caught and logged
- Missing env vars fail loudly at startup

## Next Steps (Not in Scope)

These features are planned but not implemented yet:
1. UI components for the control panel
2. Backup/Restore API routes
3. Hibernation API route
4. Backup listing and selection
5. SSM command output streaming to UI
6. Progress indication for long operations
7. Email notifications (can be added later)
8. Server logs viewer
9. Player management UI

---

**Status:** ✅ Core backend API implementation complete and ready for integration with UI components.
