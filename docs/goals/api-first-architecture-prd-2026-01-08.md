# API-First Architecture PRD

**Date:** 2026-01-08  
**Status:** Draft

## Summary

Centralize the mc-aws Minecraft server management project around the Next.js frontend/API layer. The shell scripts in `bin/` will be deprecated as the primary interface in favor of an API-driven approach, though kept for legacy reference and specific use cases that require local/interactive access.

## Goals

1. **API as Primary Interface**: All server management operations (start, stop, hibernate, resume, backup, restore) should be accessible via HTTP API endpoints
2. **Complete API Coverage**: Fill any gaps where shell scripts provide functionality not yet available via API
3. **Clear Documentation**: Document the API-first approach, available endpoints, and when CLI tools are still appropriate
4. **Graceful Deprecation**: Add clear deprecation notices to shell scripts pointing to API equivalents
5. **Consistent Error Handling**: Ensure all API routes follow the same patterns for responses and error handling

## Non-Goals

1. **Replace Interactive Sessions**: Operations requiring interactive terminal access (`connect.sh`, `console.sh`) will remain as shell scripts - these cannot be API-driven
2. **Local Backup Downloads**: Downloading backups directly to a local machine (rsync mode in `backup-from-ec2.sh`) is a developer operation that doesn't need API coverage
3. **Local Restore Uploads**: Uploading local backups to EC2 is similarly a developer operation
4. **Project Restructure**: Moving CDK out of root or into frontend is out of scope for this initiative
5. **Full CLI Replacement**: Building a comprehensive CLI wrapper is optional and not required for v1

## Current State Analysis

### Shell Scripts (bin/) - Current Primary Interface

| Script | Purpose | API Equivalent | Gap? |
|--------|---------|----------------|------|
| `connect.sh` | Interactive SSH via SSM | N/A - inherently interactive | No - Keep as utility |
| `console.sh` | Minecraft console via screen | N/A - inherently interactive | No - Keep as utility |
| `hibernate.sh` | Stop + delete volumes | `POST /api/hibernate` | **Fully covered** |
| `resume.sh` | Create volume + start | `POST /api/resume` | **Fully covered** |
| `backup-from-ec2.sh` | Backup to local or Drive | `POST /api/backup` (Drive only) | Partial - local mode is dev-only |
| `restore-to-ec2.sh` | Restore from local or Drive | `POST /api/restore` (Drive only) | Partial - local mode is dev-only |
| `setup-drive-token.sh` | OAuth setup for Google Drive | N/A - one-time browser OAuth | No - Document as setup step |

### Existing API Routes

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/status` | GET | Server state, IP, volume info | Complete |
| `/api/start` | POST | Start server (handles hibernation) | Complete |
| `/api/stop` | POST | Stop server | Complete |
| `/api/hibernate` | POST | Backup + stop + delete volumes | Complete |
| `/api/resume` | POST | Create volume + start + optional restore | Complete |
| `/api/backup` | POST | Run backup to Google Drive | Complete |
| `/api/restore` | POST | Restore from Google Drive backup | Complete |
| `/api/players` | GET | Player count | Complete |
| `/api/costs` | GET | AWS cost tracking | Complete |
| `/api/emails` | GET | Email configuration | Complete |
| `/api/emails/allowlist` | GET/POST | Email allowlist | Complete |
| `/api/aws-config` | GET | AWS configuration | Complete |

### Identified API Gaps

1. **List Backups Endpoint**: Type `ListBackupsResponse` exists in `types.ts` but no endpoint to list available Google Drive backups. This is needed for the restore flow to show available backups.

## Target Architecture

```
                    +------------------+
                    |   Next.js App    |
                    |   (frontend/)    |
                    +------------------+
                           |
              +------------+------------+
              |                         |
    +------------------+     +------------------+
    |   React UI       |     |   API Routes     |
    |   (app/*)        |     |   (app/api/*)    |
    +------------------+     +------------------+
                                    |
                        +-----------+-----------+
                        |                       |
              +------------------+    +------------------+
              |   AWS SDK v3     |    |   SSM Commands   |
              |   (lib/aws/*)    |    |   (EC2 scripts)  |
              +------------------+    +------------------+
                        |                       |
              +------------------+    +------------------+
              |   EC2/EBS/CF     |    |   mc-*.sh        |
              |   Direct API     |    |   on server      |
              +------------------+    +------------------+
```

### API-First Principles

1. **All operations go through API**: Frontend uses only API routes, not direct AWS SDK calls
2. **API handles orchestration**: Complex flows (hibernate = backup + stop + delete) are orchestrated in API routes
3. **EC2 scripts via SSM**: Server-side operations use SSM to execute `mc-*.sh` scripts on EC2
4. **Consistent responses**: All endpoints return `ApiResponse<T>` format

## Migration Strategy

### Phase 1: Fill API Gaps (Engineer)
- Create `/api/backups` endpoint to list available Google Drive backups
- Ensure type consistency with existing `ListBackupsResponse`

### Phase 2: Documentation (Engineer)
- Update root README with API-first approach
- Create API documentation (endpoint reference)
- Document when shell scripts are still appropriate

### Phase 3: Deprecation Notices (Engineer)
- Add deprecation headers to shell scripts with API alternatives
- Keep scripts functional for legacy/advanced use

### Phase 4: Optional Enhancements
- Simple CLI wrapper that calls API endpoints (curl-based)
- API route tests using Vitest

## Success Criteria

1. **All common operations available via API**: Users can manage their server entirely through the web UI without needing shell scripts
2. **Clear documentation**: New users understand the API-first approach within 5 minutes of reading README
3. **Deprecation is clear**: Shell scripts clearly indicate they are legacy and point to API alternatives
4. **No breaking changes**: Existing shell scripts continue to work for users who prefer them

## Dependencies & References

### Source Code

- **API Routes**: `frontend/app/api/*/route.ts`
- **AWS Clients**: `frontend/lib/aws/*.ts`
- **Types**: `frontend/lib/types.ts`
- **Shell Scripts**: `bin/*.sh`
- **EC2 Scripts**: `src/ec2/mc-*.sh`
- **CDK Stack**: `lib/minecraft-stack.ts`

### Key Files to Review

- `frontend/lib/aws-client.ts` - Main AWS client with SSM execution
- `frontend/lib/aws/ssm-client.ts` - SSM command execution
- `frontend/lib/aws/volume-client.ts` - Volume management for hibernate/resume
- `AGENTS.md` - Coding conventions and patterns

## Appendix: Interactive Operations

The following operations require interactive terminal access and will remain as shell scripts:

### SSH Session (`connect.sh`)
```bash
aws ssm start-session --target "$INSTANCE_ID"
```

### Minecraft Console (`console.sh`)
```bash
aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartInteractiveCommand \
  --parameters '{"command":["sudo -u minecraft screen -xRR mc-server"]}'
```

These are documented as utility scripts, not deprecated.
