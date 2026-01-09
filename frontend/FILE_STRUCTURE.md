# Frontend API Structure & File Layout

## Directory Structure

```
frontend/
├── app/
│   ├── api/
│   │   ├── status/
│   │   │   └── route.ts          [GET /api/status]
│   │   ├── start/
│   │   │   └── route.ts          [POST /api/start]
│   │   └── stop/
│   │       └── route.ts          [POST /api/stop]
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── env.ts                    [Environment variable validation]
│   ├── types.ts                  [TypeScript type definitions]
│   ├── aws-client.ts             [AWS EC2/SSM client & utilities]
│   └── cloudflare.ts             [Cloudflare DNS utilities]
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── biome.json
├── package.json                  [Updated with AWS SDK dependencies]
├── API.md                        [API documentation]
├── IMPLEMENTATION_SUMMARY.md     [This summary]
├── README.md
└── .gitignore
```

## File Details

### Core Application Files

| File | Lines | Purpose |
|------|-------|---------|
| `lib/env.ts` | 27 | Environment variable loading and validation |
| `lib/types.ts` | 39 | TypeScript interfaces and types |
| `lib/aws-client.ts` | 430+ | AWS EC2/SSM client initialization and utilities |
| `lib/cloudflare.ts` | 33 | Cloudflare DNS API integration |
| `app/api/status/route.ts` | 54 | GET /api/status endpoint |
| `app/api/start/route.ts` | 83 | POST /api/start endpoint |
| `app/api/stop/route.ts` | 68 | POST /api/stop endpoint |

### Documentation Files

| File | Purpose |
|------|---------|
| `API.md` | Comprehensive API documentation with examples |
| `IMPLEMENTATION_SUMMARY.md` | Implementation overview and architecture decisions |

## Module Exports

### `lib/env.ts`
```typescript
export function getEnv(name: string, optional?: boolean): string
export const env: {
  AWS_REGION: string
  AWS_ACCOUNT_ID: string
  INSTANCE_ID: string
  CLOUDFLARE_ZONE_ID: string
  CLOUDFLARE_RECORD_ID: string
  CLOUDFLARE_MC_DOMAIN: string
  CLOUDFLARE_API_TOKEN: string
  GDRIVE_REMOTE: string
  GDRIVE_ROOT: string
}
```

### `lib/types.ts`
```typescript
export type ServerState = "running" | "stopped" | "hibernated" | "pending" | "stopping" | "terminated" | "unknown"
export interface ServerStatusResponse { state, instanceId, publicIp?, lastUpdated }
export interface ApiResponse<T> { success, data?, error?, timestamp }
export interface StartServerResponse { instanceId, publicIp, domain, message }
export interface StopServerResponse { instanceId, message }
```

### `lib/aws-client.ts`
```typescript
export async function getInstanceState(instanceId: string): Promise<ServerState>
export async function getInstanceDetails(instanceId: string): Promise<{ instance, state, publicIp, blockDeviceMappings, az }>
export async function waitForInstanceRunning(instanceId: string, timeoutSeconds?: number): Promise<void>
export async function getPublicIp(instanceId: string): Promise<string>
export async function startInstance(instanceId: string): Promise<void>
export async function stopInstance(instanceId: string): Promise<void>
export async function handleResume(instanceId: string): Promise<void>
export async function executeSSMCommand(instanceId: string, commands: string[]): Promise<string>
export { ec2, ssm }
```

### `lib/cloudflare.ts`
```typescript
export async function updateCloudflareDns(ip: string): Promise<void>
```

## API Endpoints

### 1. GET /api/status
- **Handler:** `app/api/status/route.ts`
- **Auth:** None
- **Query Params:** None
- **Request Body:** None
- **Response Code:** 200 (success) or 500 (error)

### 2. POST /api/start
- **Handler:** `app/api/start/route.ts`
- **Auth:** None
- **Query Params:** None
- **Request Body:** None (uses env vars)
- **Response Code:** 200 (success) or 500 (error)

### 3. POST /api/stop
- **Handler:** `app/api/stop/route.ts`
- **Auth:** None
- **Query Params:** None
- **Request Body:** None (uses env vars)
- **Response Code:** 200 (success), 400 (invalid state), or 500 (error)

## Environment Variables

Required in `.env` (or `.env.local` for frontend/.env.local):

```
AWS_REGION
AWS_ACCOUNT_ID
INSTANCE_ID
CLOUDFLARE_ZONE_ID
CLOUDFLARE_RECORD_ID
CLOUDFLARE_MC_DOMAIN
CLOUDFLARE_API_TOKEN
GDRIVE_REMOTE (optional)
GDRIVE_ROOT (optional)
```

## Dependencies

### Added to package.json
- `@aws-sdk/client-ec2@^3.547.0`
- `@aws-sdk/client-ssm@^3.547.0`

### Already in package.json
- next, react, react-dom, typescript, tailwindcss, biome, etc.

## Implementation Checklist

- [x] Server Status API (GET /api/status)
  - [x] Instance state detection
  - [x] Block device mapping check for hibernation
  - [x] Public IP retrieval (if running)
  - [x] Error handling and logging

- [x] Server Start API (POST /api/start)
  - [x] State validation
  - [x] Hibernation recovery (volume creation)
  - [x] AMI snapshot lookup
  - [x] Volume creation with encryption
  - [x] Volume attachment with timeout
  - [x] Instance start command
  - [x] Running state polling
  - [x] Public IP polling
  - [x] Cloudflare DNS update
  - [x] Error handling

- [x] Server Stop API (POST /api/stop)
  - [x] State validation
  - [x] Stop command with idempotency
  - [x] Error handling

- [x] Supporting Libraries
  - [x] Environment variable validation
  - [x] TypeScript type definitions
  - [x] AWS client initialization
  - [x] Polling utilities with timeouts
  - [x] Cloudflare DNS integration

- [x] Documentation
  - [x] API documentation (API.md)
  - [x] Implementation summary
  - [x] Architecture decisions
  - [x] Environment configuration guide
  - [x] Testing instructions

## Code Quality

- **TypeScript:** Full type safety on all functions
- **Error Handling:** Comprehensive try-catch with meaningful messages
- **Logging:** Detailed console logging with [PREFIX] tags
- **Timeout Protection:** All polling operations have max attempts/timeout
- **API Consistency:** All responses use ApiResponse<T> wrapper
- **HTTP Status Codes:** Proper codes (200, 400, 500) for different scenarios
