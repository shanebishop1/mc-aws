# AGENTS.md - AI Coding Agent Instructions

This document provides guidelines for AI coding agents working in the mc-aws repository.

## Project Overview

A Minecraft server management system on AWS with:
- **Infrastructure**: AWS CDK (TypeScript) for EC2, Lambda, SES, SNS, SSM
- **Frontend**: Next.js 15 with App Router, React 19, Tailwind CSS
- **Backend**: Next.js API routes + AWS Lambda functions

## Directory Structure

```
mc-aws/
├── bin/                    # CLI scripts (connect.sh, backup.sh, etc.)
├── config/                 # Minecraft server config (server.properties, whitelist.json)
├── lib/                    # CDK stack definitions
│   └── minecraft-stack.ts  # Main infrastructure stack
├── src/
│   ├── ec2/                # Scripts running on EC2 instance
│   └── lambda/             # Lambda function code (JavaScript)
├── scripts/                # Deployment scripts
└── frontend/               # Next.js web application
    ├── app/                # App Router pages and API routes
    │   └── api/            # REST API endpoints
    ├── components/         # React components
    ├── lib/                # Shared utilities and types
    └── hooks/              # React hooks
```

## Build, Lint, and Test Commands

### Root (CDK Infrastructure)

```bash
# Package manager: npm
npm run deploy          # Deploy CDK stack (runs scripts/deploy.js)
npx cdk synth           # Synthesize CloudFormation template
npx cdk diff            # Show infrastructure changes
```

### Frontend (Next.js)

```bash
# Package manager: pnpm (run from frontend/ directory)
pnpm dev                # Start development server
pnpm build              # Production build
pnpm start              # Start production server
pnpm lint               # Run Biome linter
pnpm format             # Format code with Biome
pnpm check              # Run both lint and format with auto-fix
```

### Testing

**No test framework is currently configured.** If adding tests:
- Use Vitest for unit tests (recommended for Next.js)
- Run single test: `pnpm vitest run path/to/file.test.ts`
- Run specific test: `pnpm vitest run -t "test name pattern"`

## Code Style Guidelines

### Formatting (Biome)

- **Indentation**: 2 spaces
- **Line width**: 120 characters max
- **Quotes**: Double quotes (`"`)
- **Semicolons**: Always required
- **Trailing commas**: ES5 style (arrays, objects)
- **Arrow parentheses**: Always (`(x) => x`)

### TypeScript

- **Strict mode enabled** - no implicit any, strict null checks
- Use `type` imports for type-only imports: `import type { Foo } from "./types"`
- Use Node.js import protocol: `import fs from "node:fs"`
- Prefer interfaces for object shapes, types for unions/intersections
- Avoid `any` - use `unknown` and narrow types when needed
- Non-null assertions (`!`) are allowed but use sparingly

### Linting Rules

- **We use Biome, not ESLint** - Never add `eslint-disable` comments
- Always fix linting issues properly rather than suppressing them
- If Biome reports an error, refactor the code to comply
- No lazy workarounds or rule suppressions

### Imports

```typescript
// Order: external packages, then internal modules with @/ alias
import { NextRequest, NextResponse } from "next/server";
import type { ApiResponse, ServerStatusResponse } from "@/lib/types";
import { findInstanceId, getInstanceState } from "@/lib/aws-client";
```

- Use `@/*` path alias for frontend imports (maps to `frontend/*`)
- Group imports: React/Next, external packages, internal modules, types

### Naming Conventions

- **Files**: kebab-case (`aws-client.ts`, `server-status.tsx`)
- **Components**: PascalCase (`ServerStatus.tsx`, `CostDashboard.tsx`)
- **Functions/variables**: camelCase (`getInstanceState`, `instanceId`)
- **Types/Interfaces**: PascalCase (`ServerState`, `ApiResponse`)
- **Constants**: camelCase or UPPER_SNAKE for true constants

### API Route Pattern

All API routes follow this consistent structure:

```typescript
/**
 * GET /api/endpoint
 * Brief description of what this endpoint does
 */

import type { ApiResponse, ResponseType } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<ResponseType>>> {
  try {
    // Implementation
    console.log("[ENDPOINT] Descriptive log message");
    
    return NextResponse.json({
      success: true,
      data: { /* response data */ },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ENDPOINT] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    return NextResponse.json(
      { success: false, error: errorMessage, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
```

### Error Handling

- Always wrap async operations in try-catch
- Log errors with prefixed tags: `[STATUS]`, `[START]`, `[STOP]`, `[BACKUP]`
- Return user-friendly error messages, not stack traces
- Use `error instanceof Error ? error.message : "Unknown error"` pattern

### Logging

Use bracketed prefixes for log categorization:
```typescript
console.log("[STATUS] Getting server status for instance:", instanceId);
console.warn("[STATUS] Could not get public IP:", error);
console.error("[START] Failed to start instance:", error);
```

### React Components

```typescript
"use client";  // Only when needed (hooks, event handlers, browser APIs)

import { useState, useEffect } from "react";
import type { ServerState } from "@/lib/types";

interface Props {
  initialState: ServerState;
}

export const ServerStatus = ({ initialState }: Props) => {
  const [state, setState] = useState<ServerState>(initialState);
  // ...
};
```

- Use **const arrow functions** (`const Component = (...) => {}`) for all components
- Use TypeScript for all props
- Extract reusable UI to `components/ui/`

### Shell Scripts (bin/, src/ec2/)

```bash
#!/usr/bin/env bash
set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

# Use environment variable defaults
INSTANCE_ID="${INSTANCE_ID:-}"
```

- Always use `set -euo pipefail` for strict error handling
- Create a `log()` function for consistent output
- Use `${VAR:-default}` for optional defaults

## AWS SDK Usage

Use AWS SDK v3 with modular imports:

```typescript
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";

const client = new EC2Client({ region: env.AWS_REGION });
const response = await client.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
```

## Environment Variables

- Defined in `.env` files (not committed)
- Validated in `frontend/lib/env.ts`
- Access via the `env` object: `env.AWS_REGION`, `env.INSTANCE_ID`

## Type Definitions

All shared types are in `frontend/lib/types.ts`:
- `ServerState`: Union type for instance states
- `ApiResponse<T>`: Standard API response wrapper
- `*Response` interfaces: Specific endpoint response types

## CDK Infrastructure

- Stack defined in `lib/minecraft-stack.ts`
- Uses CDK v2 with `aws-cdk-lib`
- Environment variables for configuration (GDRIVE_*, GITHUB_*, etc.)
- Secrets stored in SSM Parameter Store (SecureString)

## Key Files Reference

| Purpose | Location |
|---------|----------|
| CDK Entry | `bin/mc-aws.ts` |
| CDK Stack | `lib/minecraft-stack.ts` |
| API Routes | `frontend/app/api/*/route.ts` |
| AWS Client | `frontend/lib/aws-client.ts` |
| Type Definitions | `frontend/lib/types.ts` |
| Environment | `frontend/lib/env.ts` |
| Lambda Handler | `src/lambda/StartMinecraftServer/index.js` |
