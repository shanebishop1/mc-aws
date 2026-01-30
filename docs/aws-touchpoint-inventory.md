# AWS and Third-Party Service Touchpoint Inventory

**Generated:** 2026-01-30
**Purpose:** Comprehensive mapping of all AWS operations and third-party service touchpoints for provider interface design

---

## Executive Summary

This document catalogs all external service dependencies across the mc-aws application, organized by API route and service type. It serves as the foundation for designing a provider interface and mock implementations for testing.

**Key Statistics:**
- **23 API Routes** analyzed
- **9 AWS Services** used (EC2, SSM, Cost Explorer, CloudFormation, plus 5 more EC2-related operations)
- **3 Third-Party Services** (Cloudflare, Google OAuth, Google Drive)
- **30+ Unique AWS Operations** identified

---

## API Route to AWS Operations Mapping

### Server Operations

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/status` | GET | `findInstanceId`, `getInstanceDetails`, `getInstanceState`, `getPublicIp` | None | Read-only status check |
| `/api/start` | POST | `findInstanceId`, `getInstanceState`, `handleResume`, `startInstance`, `waitForInstanceRunning`, `getPublicIp`, `withServerActionLock` | `updateCloudflareDns` | Full start flow with DNS update |
| `/api/stop` | POST | `findInstanceId`, `getInstanceState`, `stopInstance`, `withServerActionLock` | None | Admin-only stop |
| `/api/hibernate` | POST | `findInstanceId`, `getInstanceState`, `executeSSMCommand`, `stopInstance`, `waitForInstanceStopped`, `detachAndDeleteVolumes`, `withServerActionLock` | None | Zero-cost mode: backup + stop + delete volumes |
| `/api/resume` | POST | `findInstanceId`, `getInstanceState`, `handleResume`, `startInstance`, `waitForInstanceRunning`, `getPublicIp`, `executeSSMCommand` | `updateCloudflareDns` | Hibernation recovery with optional restore |

### Backup & Restore Operations

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/backup` | POST | `findInstanceId`, `getInstanceState`, `executeSSMCommand`, `withServerActionLock` | None | Runs backup script via SSM |
| `/api/restore` | POST | `findInstanceId`, `getInstanceState`, `executeSSMCommand`, `getPublicIp`, `withServerActionLock` | `updateCloudflareDns` | Restores from backup, updates DNS |

### Cost & Infrastructure Operations

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/costs` | GET | `getCosts` | None | Cost Explorer query with in-memory cache |
| `/api/stack-status` | GET | `getStackStatus` | None | CloudFormation stack status |
| `/api/aws-config` | GET | `findInstanceId` | None | Returns AWS region and instance ID for console URLs |

### Email & Player Management

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/emails` | GET | `getEmailAllowlist`, `updateEmailAllowlist` | None | Admin-only, with global cache |
| `/api/emails/allowlist` | PUT | `updateEmailAllowlist` | None | Admin-only, invalidates cache |
| `/api/players` | GET | `getPlayerCount` | None | Authenticated users only |

### Google Drive Integration

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/gdrive/status` | GET | `getParameter` | None | Checks if GDrive token exists in SSM |
| `/api/gdrive/setup` | GET | None | Google OAuth (generate auth URL) | Admin-only, initiates OAuth flow |
| `/api/gdrive/callback` | GET | `putParameter` | Google OAuth (token exchange) | Stores token as SecureString in SSM |

### Authentication Routes

| Route | Method | AWS Operations | Third-Party Services | Notes |
|-------|--------|----------------|---------------------|-------|
| `/api/auth/login` | GET | None | Google OAuth (initiate flow) | Uses Arctic library for PKCE |
| `/api/auth/callback` | GET | None | Google OAuth (token exchange, userinfo) | Creates JWT session |
| `/api/auth/me` | GET | None | None | Verifies JWT session, returns user info |
| `/api/auth/logout` | POST | None | None | Clears session cookie |
| `/api/auth/dev-login` | GET | None | None | Dev-only, creates test session |

---

## Consolidated AWS Operations List

### EC2 Operations

**File:** `lib/aws/ec2-client.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `getInstanceState` | `DescribeInstancesCommand` | Get current instance state | status, start, stop, backup, restore, hibernate, resume |
| `getInstanceDetails` | `DescribeInstancesCommand` | Get full instance details (state, IP, volumes, AZ) | status, handleResume |
| `startInstance` | `StartInstancesCommand` | Start EC2 instance | start, resume |
| `stopInstance` | `StopInstancesCommand` | Stop EC2 instance | stop, hibernate |
| `getPublicIp` | `DescribeInstancesCommand` (polling) | Get public IP with retry logic | status, start, restore, resume |
| `waitForInstanceRunning` | `DescribeInstancesCommand` (polling) | Wait for instance to reach running state | start, resume |
| `waitForInstanceStopped` | `DescribeInstancesCommand` (polling) | Wait for instance to reach stopped state | hibernate |

**File:** `lib/aws/instance-resolver.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `findInstanceId` | `DescribeInstancesCommand` | Discover instance by tag or env var | All server operations |
| `resolveInstanceId` | N/A (uses findInstanceId) | Resolve or discover instance ID | All EC2 operations |

**File:** `lib/aws/volume-client.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `detachAndDeleteVolumes` | `DescribeInstancesCommand`, `DetachVolumeCommand`, `DeleteVolumeCommand` | Detach and delete all volumes | hibernate |
| `handleResume` | `DescribeInstancesCommand`, `DescribeImagesCommand`, `CreateVolumeCommand`, `AttachVolumeCommand` | Create and attach volume for hibernation recovery | start, resume |
| `waitForVolumeDetached` | `DescribeVolumesCommand` (polling) | Wait for volume detachment | detachAndDeleteVolumes |
| `waitForVolumeAvailable` | `DescribeVolumesCommand` (polling) | Wait for volume to be available | handleResume |
| `waitForVolumeAttached` | `DescribeVolumesCommand` (polling) | Wait for volume attachment | handleResume |

### SSM Operations

**File:** `lib/aws/ssm-client.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `executeSSMCommand` | `SendCommandCommand`, `GetCommandInvocationCommand` (polling) | Execute shell script on EC2 instance | backup, restore, hibernate, resume, listBackups |
| `listBackups` | `executeSSMCommand` (rclone) | List backups from Google Drive | Not directly used by API (utility) |
| `getEmailAllowlist` | `GetParameterCommand` | Get email allowlist from SSM | emails |
| `updateEmailAllowlist` | `PutParameterCommand` | Update email allowlist in SSM | emails, emails/allowlist |
| `getPlayerCount` | `GetParameterCommand` | Get player count from SSM | players |
| `getParameter` | `GetParameterCommand` | Get any parameter by name | gdrive/status |
| `putParameter` | `PutParameterCommand` | Put any parameter by name | gdrive/callback, setServerAction |
| `deleteParameter` | `DeleteParameterCommand` | Delete parameter by name | withServerActionLock |
| `getServerAction` | `getParameter` | Get current server action lock | withServerActionLock |
| `setServerAction` | `putParameter` | Set server action lock | withServerActionLock |
| `withServerActionLock` | `getServerAction`, `setServerAction`, `deleteParameter` | Execute action with mutual exclusion | start, stop, backup, restore, hibernate |

### Cost Explorer Operations

**File:** `lib/aws/cost-client.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `getCosts` | `GetCostAndUsageCommand` | Get cost breakdown by service | costs |

**Note:** Uses dynamic import to avoid build issues if package not installed.

### CloudFormation Operations

**File:** `lib/aws/cloudformation-client.ts`

| Operation | AWS SDK Command | Purpose | Used By |
|-----------|----------------|---------|---------|
| `getStackStatus` | `DescribeStacksCommand` | Get CloudFormation stack status | stack-status |
| `checkStackExists` | `getStackStatus` | Boolean wrapper for stack existence | Not directly used by API |

---

## Third-Party Service Touchpoints

### Cloudflare DNS

**File:** `lib/cloudflare.ts`

| Operation | HTTP Method | Endpoint | Purpose | Used By |
|-----------|-------------|----------|---------|---------|
| `updateCloudflareDns` | PUT | `https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}` | Update A record with new IP | start, restore, resume |

**Environment Variables Required:**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_RECORD_ID`
- `CLOUDFLARE_MC_DOMAIN`

**Request Body:**
```typescript
{
  type: "A",
  name: domain,
  content: ip,
  ttl: 60,
  proxied: false
}
```

### Google OAuth (Authentication)

**Files:** `app/api/auth/login/route.ts`, `app/api/auth/callback/route.ts`

| Operation | HTTP Method | Endpoint | Purpose | Used By |
|-----------|-------------|----------|---------|---------|
| Generate Auth URL | N/A (client-side redirect) | `https://accounts.google.com/o/oauth2/v2/auth` | Initiate OAuth flow with PKCE | auth/login |
| Exchange Code for Tokens | POST | `https://oauth2.googleapis.com/token` | Exchange authorization code for access token | auth/callback |
| Get User Info | GET | `https://www.googleapis.com/oauth2/v2/userinfo` | Fetch user profile (email, name, picture) | auth/callback |

**Environment Variables Required:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL`

**OAuth Flow:**
1. Generate state and code verifier (PKCE)
2. Store in HTTP-only cookies
3. Redirect to Google with authorization URL
4. Google redirects back with code
5. Validate state, exchange code for tokens
6. Fetch user info with access token
7. Create JWT session cookie
8. Clear OAuth cookies

**Library Used:** `arctic` (Google OAuth provider)

### Google Drive Integration

**Files:** `app/api/gdrive/setup/route.ts`, `app/api/gdrive/callback/route.ts`

| Operation | HTTP Method | Endpoint | Purpose | Used By |
|-----------|-------------|----------|---------|---------|
| Generate Auth URL | N/A (client-side redirect) | `https://accounts.google.com/o/oauth2/v2/auth` | Initiate OAuth flow for Drive access | gdrive/setup |
| Exchange Code for Tokens | POST | `https://oauth2.googleapis.com/token` | Exchange authorization code for Drive tokens | gdrive/callback |

**Environment Variables Required:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL`

**OAuth Flow:**
1. Generate authorization URL with `https://www.googleapis.com/auth/drive.file` scope
2. User authorizes app
3. Google redirects back with code
4. Exchange code for tokens
5. Convert to rclone-compatible format
6. Store as SecureString in SSM (`/minecraft/gdrive-token`)

**Token Format (rclone-compatible):**
```typescript
{
  access_token: string,
  token_type: "Bearer",
  refresh_token: string,
  expiry: ISO string
}
```

**Note:** Actual Google Drive file operations are performed by `rclone` on the EC2 instance via SSM commands, not directly from the Next.js app.

---

## Special Considerations

### Error Handling Patterns

1. **Consistent API Response Format:**
   ```typescript
   {
     success: boolean,
     data?: T,
     error?: string,
     timestamp: ISO string
   }
   ```

2. **HTTP Status Codes:**
   - `200` - Success
   - `400` - Bad request (invalid state, invalid input)
   - `401` - Authentication required
   - `403` - Insufficient permissions
   - `409` - Conflict (another operation in progress)
   - `500` - Server error

3. **AWS Error Handling:**
   - `ParameterNotFound` - Return empty/default value (not an error)
   - `ValidationError` (stack does not exist) - Return null (not an error)
   - Other errors - Log and propagate

### Polling Patterns

Several operations implement polling with timeouts:

| Operation | Poll Interval | Max Attempts | Timeout | Purpose |
|-----------|---------------|--------------|---------|---------|
| `getPublicIp` | 1000ms | 300 | ~5 minutes | Wait for IP assignment |
| `waitForInstanceRunning` | 2000ms | 150 | ~5 minutes | Wait for running state |
| `waitForInstanceStopped` | 5000ms | 60 | ~5 minutes | Wait for stopped state |
| `executeSSMCommand` | 2000ms | 60 | ~2 minutes | Wait for command completion |
| `waitForVolumeDetached` | 2000ms | 30 | ~1 minute | Wait for volume detachment |
| `waitForVolumeAvailable` | 5000ms | 60 | ~5 minutes | Wait for volume to be available |
| `waitForVolumeAttached` | 2000ms | 60 | ~2 minutes | Wait for volume attachment |

### Caching Strategies

1. **Cost Data:** In-memory cache (module-level variable) with `?refresh=true` query param to bypass
2. **Email Allowlist:** Global cache (`globalThis.__mc_cachedEmails`) with `?refresh=true` query param to bypass
3. **Player Count:** No caching (always fresh from SSM)

### Mutual Exclusion Lock

The `withServerActionLock` function prevents concurrent operations:

- **Lock Storage:** SSM Parameter `/minecraft/server-action`
- **Lock Format:** JSON `{ action: string, timestamp: number }`
- **Expiration:** 30 minutes (auto-cleared if stale)
- **Error:** Returns 409 Conflict if another action is in progress

### State Transitions

**Valid State Transitions:**
- `stopped` → `pending` → `running`
- `running` → `stopping` → `stopped`
- `running` → `stopping` → `stopped` (no volumes) → `hibernating`
- `hibernating` → `pending` → `running` (with volume restoration)

**State Detection Logic:**
- `running` - Instance state is "running"
- `stopped` - Instance state is "stopped" AND has volumes
- `hibernating` - Instance state is "stopped" AND has NO volumes
- `pending` - Instance state is "pending"
- `stopping` - Instance state is "stopping"
- `terminated` - Instance state is "terminated"
- `unknown` - Any other state or error

### Security Considerations

1. **SSM SecureString:** Google Drive token stored as SecureString
2. **HTTP-only Cookies:** OAuth state, code verifier, session token
3. **PKCE:** Used for Google OAuth flow
4. **JWT Sessions:** Signed with HS256, 7-day expiration
5. **Role-Based Access Control:** admin, allowed, public roles
6. **Command Injection Prevention:** Backup names sanitized before SSM execution

---

## Provider Interface Requirements

Based on this inventory, the provider interface should include:

### Core Operations

```typescript
interface AwsProvider {
  // EC2 - Instance Management
  findInstanceId(): Promise<string>;
  resolveInstanceId(instanceId?: string): Promise<string>;
  getInstanceState(instanceId?: string): Promise<ServerState>;
  getInstanceDetails(instanceId?: string): Promise<InstanceDetails>;
  startInstance(instanceId?: string): Promise<void>;
  stopInstance(instanceId?: string): Promise<void>;
  getPublicIp(instanceId: string): Promise<string>;
  waitForInstanceRunning(instanceId: string, timeout?: number): Promise<void>;
  waitForInstanceStopped(instanceId: string, timeout?: number): Promise<void>;

  // EC2 - Volume Management
  detachAndDeleteVolumes(instanceId?: string): Promise<void>;
  handleResume(instanceId?: string): Promise<void>;

  // SSM - Command Execution
  executeSSMCommand(instanceId: string, commands: string[]): Promise<string>;

  // SSM - Parameter Store
  getParameter(name: string): Promise<string | null>;
  putParameter(name: string, value: string, type?: "String" | "SecureString"): Promise<void>;
  deleteParameter(name: string): Promise<void>;

  // SSM - Application-Specific Parameters
  getEmailAllowlist(): Promise<string[]>;
  updateEmailAllowlist(emails: string[]): Promise<void>;
  getPlayerCount(): Promise<{ count: number; lastUpdated: string }>;
  getServerAction(): Promise<{ action: string; timestamp: number } | null>;
  setServerAction(action: string): Promise<void>;

  // SSM - Action Lock
  withServerActionLock<T>(actionName: string, fn: () => Promise<T>): Promise<T>;

  // Cost Explorer
  getCosts(periodType?: "current-month" | "last-month" | "last-30-days"): Promise<CostData>;

  // CloudFormation
  getStackStatus(stackName?: string): Promise<Stack | null>;
  checkStackExists(stackName?: string): Promise<boolean>;
}
```

### Third-Party Provider Interface

```typescript
interface ThirdPartyProvider {
  // Cloudflare
  updateCloudflareDns(ip: string): Promise<void>;

  // Google OAuth (Authentication)
  generateGoogleAuthUrl(state: string, codeVerifier: string): Promise<string>;
  exchangeGoogleCodeForTokens(code: string, codeVerifier: string): Promise<GoogleTokens>;
  getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo>;

  // Google Drive
  generateGDriveAuthUrl(): Promise<string>;
  exchangeGDriveCodeForTokens(code: string): Promise<GDriveToken>;
}
```

---

## Mock Implementation Priorities

### High Priority (Core Functionality)

1. **EC2 Instance Operations**
   - `findInstanceId`, `getInstanceState`, `getInstanceDetails`
   - `startInstance`, `stopInstance`
   - `getPublicIp` (with polling simulation)
   - `waitForInstanceRunning`, `waitForInstanceStopped`

2. **SSM Command Execution**
   - `executeSSMCommand` (simulate script output)
   - `withServerActionLock` (in-memory lock for tests)

3. **SSM Parameter Store**
   - `getParameter`, `putParameter`, `deleteParameter`
   - `getEmailAllowlist`, `updateEmailAllowlist`
   - `getPlayerCount`

### Medium Priority (Advanced Features)

4. **Volume Operations**
   - `detachAndDeleteVolumes`
   - `handleResume`

5. **Cost Explorer**
   - `getCosts` (return realistic cost data)

6. **CloudFormation**
   - `getStackStatus`, `checkStackExists`

### Low Priority (Third-Party)

7. **Cloudflare DNS**
   - `updateCloudflareDns` (no-op mock)

8. **Google OAuth**
   - Mock token exchange and user info
   - Use test tokens for local development

9. **Google Drive**
   - Mock token storage in SSM
   - Mock backup listing (via SSM command)

---

## Testing Considerations

### Unit Tests

- Test each AWS operation in isolation
- Mock AWS SDK responses
- Test error handling (ParameterNotFound, ValidationError, etc.)
- Test polling logic with different scenarios

### Integration Tests

- Test complete workflows (start, stop, backup, restore, hibernate, resume)
- Test state transitions
- Test mutual exclusion lock behavior
- Test caching invalidation

### E2E Tests

- Test full user flows through API routes
- Test authentication and authorization
- Test error responses and status codes

---

## Appendix: AWS SDK Commands Reference

### EC2 Commands Used

```typescript
// Instance operations
DescribeInstancesCommand
StartInstancesCommand
StopInstancesCommand

// Volume operations
DescribeVolumesCommand
AttachVolumeCommand
DetachVolumeCommand
DeleteVolumeCommand

// Image operations
DescribeImagesCommand
```

### SSM Commands Used

```typescript
// Command execution
SendCommandCommand
GetCommandInvocationCommand

// Parameter operations
GetParameterCommand
PutParameterCommand
DeleteParameterCommand
```

### Cost Explorer Commands Used

```typescript
GetCostAndUsageCommand
```

### CloudFormation Commands Used

```typescript
DescribeStacksCommand
```

---

## Document Metadata

- **Version:** 1.0
- **Last Updated:** 2026-01-30
- **Maintainer:** Development Team
- **Related Documents:**
  - Provider Interface Design (TODO)
  - Mock Implementation Guide (TODO)
  - Testing Strategy (TODO)