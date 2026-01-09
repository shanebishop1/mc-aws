# MC-AWS Backend API Routes

This document describes the implemented backend API routes for the Minecraft server control panel.

## Overview

The backend API provides three core endpoints for managing the EC2-based Minecraft server:

1. **GET /api/status** - Check server status
2. **POST /api/start** - Start the server (with hibernation recovery)
3. **POST /api/stop** - Stop the server

## Environment Configuration

The API routes require the following environment variables to be set in the parent `.env` file (automatically loaded by Next.js):

### AWS Configuration
- `AWS_REGION` - AWS region where your resources are located
- `AWS_ACCOUNT_ID` - Your AWS account ID
- `INSTANCE_ID` - EC2 instance ID for the Minecraft server

### Cloudflare Configuration
- `CLOUDFLARE_ZONE_ID` - Cloudflare zone ID
- `CLOUDFLARE_RECORD_ID` - Cloudflare DNS record ID
- `CLOUDFLARE_MC_DOMAIN` - Domain name for your Minecraft server
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token with DNS edit permissions

## API Endpoints

### 1. GET /api/status

**Description:** Returns the current server state and metadata.

**Request:**
```bash
GET /api/status
```

**Response (Success - 200):**
```json
{
  "success": true,
  "data": {
    "state": "running",
    "instanceId": "i-1234567890abcdef0",
    "publicIp": "203.0.113.42",
    "lastUpdated": "2026-01-07T15:30:00.000Z"
  },
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

**State Values:**
- `running` - Instance is running and server is operational
- `stopped` - Instance is stopped but EBS volume is attached (quick restart)
- `hibernated` - Instance is stopped and no EBS volumes attached (hibernation state)
- `pending` - Instance is starting up
- `stopping` - Instance is shutting down
- `terminated` - Instance has been terminated
- `unknown` - Could not determine state

**Response (Error - 500):**
```json
{
  "success": false,
  "error": "Instance i-1234567890abcdef0 not found",
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

---

### 2. POST /api/start

**Description:** Starts the server. Handles both normal start and hibernation recovery.

**Behavior:**
1. Checks current instance state
2. If hibernated (no EBS volumes):
   - Looks up latest Amazon Linux 2023 ARM64 AMI
   - Creates 8GB GP3 volume from AMI snapshot
   - Waits for volume to be available
   - Attaches volume to instance at `/dev/xvda`
3. Sends EC2 start command
4. Waits for instance to reach "running" state
5. Polls for public IP assignment
6. Updates Cloudflare DNS A record

**Request:**
```bash
POST /api/start
```

**Response (Success - 200):**
```json
{
  "success": true,
  "data": {
    "instanceId": "i-1234567890abcdef0",
    "publicIp": "203.0.113.42",
    "domain": "minecraft.example.com",
    "message": "Server started successfully. DNS updated to 203.0.113.42"
  },
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

**Response (Error - 500):**
```json
{
  "success": false,
  "error": "Timed out waiting for public IP address.",
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

**Timeouts:**
- Instance startup: 300 seconds
- Public IP assignment: 300 seconds (with 1s polling)
- Volume operations: 5 minutes each

---

### 3. POST /api/stop

**Description:** Stops the EC2 instance. The EBS volume remains attached for quick restart (unlike hibernation which deletes the volume).

**Request:**
```bash
POST /api/stop
```

**Response (Success - 200):**
```json
{
  "success": true,
  "data": {
    "instanceId": "i-1234567890abcdef0",
    "message": "Server stop command sent successfully"
  },
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

**Response (Error - 400/500):**
```json
{
  "success": false,
  "error": "Cannot stop server in state: terminated",
  "timestamp": "2026-01-07T15:30:00.000Z"
}
```

---

## Implementation Details

### Library Files

#### `/lib/env.ts`
- Validates and exports all required environment variables
- Throws error on startup if required vars are missing
- Supports optional variables for future features

#### `/lib/types.ts`
- TypeScript types for all API responses
- Server state type definition
- Generic `ApiResponse<T>` wrapper for consistency

#### `/lib/aws-client.ts`
- EC2 and SSM client initialization
- Core AWS operations:
  - `getInstanceState()` - Detects hibernation state (stopped + no volumes)
  - `getInstanceDetails()` - Gets full instance metadata
  - `waitForInstanceRunning()` - Polls until running state
  - `getPublicIp()` - Polls for public IP assignment (up to 5 minutes)
  - `startInstance()` / `stopInstance()` - Send commands
  - `handleResume()` - Creates and attaches volume if hibernated
  - `executeSSMCommand()` - Runs commands on EC2 (for future use)
- All polling has timeout protection to prevent infinite waits

#### `/lib/cloudflare.ts`
- `updateCloudflareDns()` - Updates Cloudflare DNS A record via API
- Requires CLOUDFLARE_API_TOKEN with DNS edit permissions

### API Routes

#### `/app/api/status/route.ts`
- Reads instance state from EC2 API
- Returns public IP only if running
- Handles errors gracefully

#### `/app/api/start/route.ts`
- Orchestrates full startup sequence
- Detects hibernation and triggers volume recovery
- Waits for all prerequisites before starting
- Updates DNS on success
- Comprehensive error handling

#### `/app/api/stop/route.ts`
- Simple stop with state validation
- Won't stop if already stopped
- Won't stop if in incompatible state (terminated, etc.)

---

## Error Handling

All endpoints follow a consistent error pattern:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "timestamp": "ISO timestamp"
}
```

Common error scenarios:
- **Missing environment variables** - Thrown during module load (500)
- **Instance not found** - Returned from AWS API (500)
- **Timeout waiting for state change** - After max polling attempts (500)
- **Cloudflare API failure** - Returns API error details (500)
- **Invalid state for operation** - Before operation attempt (400)

---

## Polling Behavior

### Public IP Polling
- Polls up to 300 times
- 1 second between attempts
- Maximum wait: ~5 minutes
- Aborts early if instance enters stopped/terminated state

### Volume Creation/Attachment
- 60 attempts for availability (5 seconds between attempts)
- 60 attempts for attachment (2 seconds between attempts)
- Each operation has independent timeout

### Instance Startup
- Polls every 2 seconds
- Maximum 300 second timeout
- Aborts if instance enters terminated state

---

## Security Notes

1. **No authentication** - As per PRD, this is single-admin only
2. **AWS credentials** - Uses local AWS credentials (same as CLI scripts)
3. **Cloudflare token** - Should be treated as secret (not in version control)
4. **Input validation** - Currently minimal as routes have no user input
5. **HTTPS enforcement** - Recommended for production (not in scope)

---

## Future Enhancements

The framework supports these planned features:

### Backup/Restore API
- `/api/backup` - Trigger backup via SSM command
- `/api/restore` - Trigger restore via SSM command
- `/api/backups` - List available backups from Google Drive

### Hibernation API
- `/api/hibernate` - Full hibernation (backup + stop + delete volume)

### Resume API
- `/api/resume` - Resume from hibernation with selected backup

The infrastructure for these is partially implemented:
- `executeSSMCommand()` utility is ready to call on-server scripts
- State detection handles hibernation state correctly

---

## Testing

### Manual Testing

1. **Check status:**
   ```bash
   curl http://localhost:3000/api/status
   ```

2. **Start server:**
   ```bash
   curl -X POST http://localhost:3000/api/start
   ```

3. **Stop server:**
   ```bash
   curl -X POST http://localhost:3000/api/stop
   ```

### Required Setup

Before testing, ensure:
1. `.env` file is in the repo root with all required variables
2. AWS credentials are configured locally
3. Cloudflare API token has DNS edit permissions
4. EC2 instance exists and has the correct security group
5. Run `pnpm install` to install AWS SDK packages

---

## Configuration Example

Create a `.env` file in the project root:

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

---

## References

Implementation follows patterns from:
- `/src/lambda/StartMinecraftServer/index.js` - Core AWS logic
- AWS SDK v3 client documentation
- Next.js API route patterns
