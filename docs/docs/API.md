# Minecraft Server Control API Reference

This document provides a comprehensive reference for all API endpoints available in the mc-aws server management system.

## Base URL

All endpoints are relative to the server base URL:
- Development: `http://localhost:3000`
- Production: `https://your-domain.com`

## Response Format

All responses follow a consistent JSON structure:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-01-09T..."
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Human-readable error message",
  "timestamp": "2026-01-09T..."
}
```

---

## Server Management

### Get Server Status

**Method:** GET  
**Path:** `/api/status`  
**Description:** Returns the current server state, instance details, and public IP address. The endpoint verifies the instance state via AWS API.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| instanceId | string | No | Instance ID to check (defaults to auto-discovery) |

**Response:**
```json
{
  "success": true,
  "data": {
    "state": "running",
    "instanceId": "i-1234567890abcdef0",
    "publicIp": "203.0.113.42",
    "hasVolume": true,
    "lastUpdated": "2026-01-09T10:30:00.000Z"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**State Values:**
| State | Description |
|-------|-------------|
| `running` | Instance is running and server is operational |
| `stopped` | Instance is stopped but EBS volume is attached (quick restart) |
| `hibernating` | Instance is stopped with no EBS volumes attached |
| `pending` | Instance is starting up |
| `stopping` | Instance is shutting down |
| `terminated` | Instance has been terminated |
| `unknown` | Could not determine state |

**Example:**
```bash
curl http://localhost:3000/api/status
```

---

### Start Server

**Method:** POST  
**Path:** `/api/start`  
**Description:** Starts the server instance. Handles hibernation recovery automatically by creating and attaching an EBS volume if needed. Updates Cloudflare DNS after the server is running.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| instanceId | string | No | Instance ID to start (defaults to auto-discovery) |

**Behavior:**
1. Checks current instance state
2. If hibernating (no EBS volumes), creates and attaches a new volume
3. Sends EC2 start command
4. Waits for instance to reach "running" state
5. Polls for public IP assignment
6. Updates Cloudflare DNS A record

**Response:**
```json
{
  "success": true,
  "data": {
    "instanceId": "i-1234567890abcdef0",
    "publicIp": "203.0.113.42",
    "domain": "minecraft.example.com",
    "message": "Server started successfully. DNS updated to 203.0.113.42"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/start
```

---

### Stop Server

**Method:** POST  
**Path:** `/api/stop`  
**Description:** Stops the EC2 instance while keeping the EBS volume attached. Unlike hibernation, this allows for quick restarts without volume recreation.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| instanceId | string | No | Instance ID to stop (defaults to auto-discovery) |

**Response:**
```json
{
  "success": true,
  "data": {
    "instanceId": "i-1234567890abcdef0",
    "message": "Server stop command sent successfully"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/stop
```

---

### Hibernate Server

**Method:** POST  
**Path:** `/api/hibernate`  
**Description:** Puts the server into full hibernation mode. This performs a backup, stops the EC2 instance, and deletes all EBS volumes to eliminate ongoing storage costs. The server cannot be resumed without a backup.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| instanceId | string | No | Instance ID to hibernate (defaults to auto-discovery) |

**Process:**
1. Runs backup script (`mc-backup.sh`) on the server
2. Sends EC2 stop command
3. Waits for instance to stop
4. Detaches and deletes all EBS volumes

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Server hibernating successfully (volumes deleted)",
    "instanceId": "i-1234567890abcdef0",
    "backupOutput": "Backup completed successfully"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/hibernate
```

---

### Resume Server

**Method:** POST  
**Path:** `/api/resume`  
**Description:** Resumes the server from hibernation. Creates a new EBS volume, starts the instance, and optionally restores from a backup. Combines start logic with restore functionality.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| instanceId | string | No | Instance ID to resume (defaults to auto-discovery) |
| backupName | string | No | Optional backup name to restore after resume |

**Response:**
```json
{
  "success": true,
  "data": {
    "instanceId": "i-1234567890abcdef0",
    "publicIp": "203.0.113.42",
    "domain": "minecraft.example.com",
    "message": "Server resumed successfully. DNS updated to 203.0.113.42 and restored from backup backup-2026-01-08"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/resume \
  -H "Content-Type: application/json" \
  -d '{"backupName": "backup-2026-01-08"}'
```

---

## Backup & Restore

### Trigger Backup

**Method:** POST  
**Path:** `/api/backup`  
**Description:** Triggers a backup of the server to Google Drive via the `mc-backup.sh` script running on the EC2 instance.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | No | Optional custom name for the backup |
| instanceId | string | No | Instance ID (defaults to auto-discovery) |

**Response:**
```json
{
  "success": true,
  "data": {
    "backupName": "backup-2026-01-09",
    "message": "Backup completed successfully (backup-2026-01-09)",
    "output": "Backup script output..."
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/backup \
  -H "Content-Type: application/json" \
  -d '{"name": "backup-2026-01-09"}'
```

---

### Restore from Backup

**Method:** POST  
**Path:** `/api/restore`  
**Description:** Restores the server from a Google Drive backup. The server must be running before executing this endpoint.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| backupName | string | No | Name of the backup to restore (defaults to latest) |
| name | string | No | Alias for backupName (for backward compatibility) |
| instanceId | string | No | Instance ID (defaults to auto-discovery) |

**Response:**
```json
{
  "success": true,
  "data": {
    "backupName": "backup-2026-01-08",
    "publicIp": "203.0.113.42",
    "message": "Restore completed successfully (backup-2026-01-08)\nDNS updated to 203.0.113.42",
    "output": "Restore script output..."
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/restore \
  -H "Content-Type: application/json" \
  -d '{"backupName": "backup-2026-01-08"}'
```

---

### List Backups

**Method:** GET  
**Path:** `/api/backups`  
**Description:** Lists all available backups from Google Drive. Requires the server to be running to execute the rclone command via SSM.

**Response:**
```json
{
  "success": true,
  "data": {
    "backups": [
      { "name": "backup-2026-01-09", "date": "2026-01-09T10:00:00.000Z", "size": "2.3GB" },
      { "name": "backup-2026-01-08", "date": "2026-01-08T10:00:00.000Z", "size": "2.2GB" }
    ],
    "count": 2
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl http://localhost:3000/api/backups
```

---

## Monitoring

### Get Player Count

**Method:** GET  
**Path:** `/api/players`  
**Description:** Returns the current player count on the Minecraft server. Uses the `list-mc-players.sh` script on the EC2 instance.

**Response:**
```json
{
  "success": true,
  "data": {
    "count": 5,
    "lastUpdated": "2026-01-09T10:30:00.000Z"
  }
}
```

**Example:**
```bash
curl http://localhost:3000/api/players
```

---

### Get Cost Data

**Method:** GET  
**Path:** `/api/costs`  
**Description:** Returns AWS cost breakdown for the current billing period. Results are cached in memory for 5 minutes.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| refresh | boolean | No | Set to "true" to bypass cache and fetch fresh data |

**Response:**
```json
{
  "success": true,
  "data": {
    "period": { "start": "2026-01-01", "end": "2026-01-31" },
    "totalCost": "12.50",
    "currency": "USD",
    "breakdown": [
      { "service": "EC2", "cost": "8.00" },
      { "service": "EBS", "cost": "3.50" },
      { "service": "Data Transfer", "cost": "1.00" }
    ],
    "fetchedAt": "2026-01-09T10:30:00.000Z"
  },
  "cachedAt": 1704805800000
}
```

**Example:**
```bash
curl http://localhost:3000/api/costs
curl http://localhost:3000/api/costs?refresh=true
```

---

## Configuration

### Get AWS Configuration

**Method:** GET  
**Path:** `/api/aws-config`  
**Description:** Returns AWS configuration for constructing console URLs. Useful for generating links to the AWS management console.

**Response:**
```json
{
  "success": true,
  "data": {
    "region": "us-east-1",
    "instanceId": "i-1234567890abcdef0",
    "ec2ConsoleUrl": "https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#InstanceDetails:instanceId=i-1234567890abcdef0"
  },
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Example:**
```bash
curl http://localhost:3000/api/aws-config
```

---

## Email Management

### Get Email Configuration

**Method:** GET  
**Path:** `/api/emails`  
**Description:** Returns the current email configuration including admin email and allowlist. Results are cached in memory.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| refresh | boolean | No | Set to "true" to bypass cache and fetch fresh data |

**Response:**
```json
{
  "success": true,
  "data": {
    "adminEmail": "admin@example.com",
    "allowlist": ["player1@example.com", "player2@example.com"]
  },
  "cachedAt": 1704805800000
}
```

**Example:**
```bash
curl http://localhost:3000/api/emails
curl http://localhost:3000/api/emails?refresh=true
```

---

### Update Email Allowlist

**Method:** PUT  
**Path:** `/api/emails/allowlist`  
**Description:** Updates the email allowlist for server access notifications.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| emails | string[] | Yes | Array of email addresses to allowlist |

**Request:**
```json
{
  "emails": ["player1@example.com", "player2@example.com", "player3@example.com"]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "allowlist": ["player1@example.com", "player2@example.com", "player3@example.com"]
  }
}
```

**Example:**
```bash
curl -X PUT http://localhost:3000/api/emails/allowlist \
  -H "Content-Type: application/json" \
  -d '{"emails": ["player1@example.com", "player2@example.com"]}'
```

---

## Error Handling

All endpoints follow a consistent error handling pattern. HTTP status codes indicate the type of error:

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid state for operation |
| 500 | Server Error - Operation failed |

**Error Response Structure:**
```json
{
  "success": false,
  "error": "Human-readable error message",
  "timestamp": "2026-01-09T10:30:00.000Z"
}
```

**Common Errors:**
| Error | Description |
|-------|-------------|
| `Cannot hibernate when server is stopped` | Server must be running to hibernate |
| `Cannot restore when server is terminated` | Server must be running to restore |
| `Cannot backup when server is stopped` | Server must be running to backup |
| `Invalid email format: invalid-email` | Email validation failed |

---

## Environment Variables

The API requires the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_REGION` | Yes | AWS region (e.g., `us-east-1`) |
| `AWS_ACCOUNT_ID` | Yes | AWS account ID |
| `INSTANCE_ID` | No* | EC2 instance ID (*auto-discovers if not set) |
| `CLOUDFLARE_ZONE_ID` | Yes | Cloudflare zone ID |
| `CLOUDFLARE_RECORD_ID` | Yes | Cloudflare DNS record ID |
| `CLOUDFLARE_MC_DOMAIN` | Yes | Minecraft server domain |
| `CLOUDFLARE_DNS_API_TOKEN` | Yes | Cloudflare DNS API token |
| `NOTIFICATION_EMAIL` | Yes | Admin notification email |
| `GDRIVE_REMOTE` | Yes | rclone remote name for Google Drive |
| `GDRIVE_ROOT` | Yes | Google Drive folder path |

---

## Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Get server status |
| `/api/start` | POST | Start server |
| `/api/stop` | POST | Stop server |
| `/api/hibernate` | POST | Hibernate (backup + stop + delete volume) |
| `/api/resume` | POST | Resume from hibernation |
| `/api/backup` | POST | Trigger backup |
| `/api/restore` | POST | Restore from backup |
| `/api/backups` | GET | List backups |
| `/api/players` | GET | Get player count |
| `/api/costs` | GET | Get cost data |
| `/api/aws-config` | GET | Get AWS configuration |
| `/api/emails` | GET | Get email configuration |
| `/api/emails/allowlist` | PUT | Update email allowlist |
