# PRD: StartMinecraftServer Lambda Refactoring

**Date:** 2026-01-10  
**Status:** In Progress

## Summary

Refactor the monolithic `StartMinecraftServer` Lambda function (898 lines) into a modular, maintainable structure. The Lambda currently handles multiple concerns including EC2 operations, DNS management, email notifications, SSM commands, and various command handlers (backup, restore, hibernate, resume).

## Goals

1. **Modularize the codebase** - Split the 898-line monolith into focused, single-responsibility modules
2. **Improve maintainability** - Make it easier for developers to understand, modify, and test individual components
3. **Maintain backward compatibility** - No changes to Lambda handler signatures or CDK stack configuration
4. **Keep Lambda deployable** - All code must work with `lambda.Code.fromAsset()` without external build steps

## Non-Goals

1. **TypeScript migration** - The Lambda remains in plain JavaScript (ES modules)
2. **CDK stack changes** - The stack at `infra/lib/minecraft-stack.ts` should not be modified
3. **UpdateDns Lambda refactoring** - At 71 lines, it's small enough to remain as-is for now
4. **Adding a bundler** - Code must work directly without webpack/esbuild/rollup
5. **Lambda layers** - Not implementing shared code via Lambda layers in this iteration

## Users

- **Developers** maintaining the Minecraft server infrastructure
- **Operators** who may need to debug Lambda execution issues
- **Future contributors** who need to understand the codebase

## Use Cases

1. **Adding new commands** - A developer wants to add a new email command (e.g., "status"). With modular code, they can:
   - Add the command to `command-parser.js`
   - Create a new handler in `handlers/`
   - Wire it up in `index.js`

2. **Debugging EC2 issues** - When instance startup fails, the developer can focus on `ec2.js` rather than searching through 898 lines

3. **Modifying notifications** - Changing email format or adding new notification types is isolated to `notifications.js`

4. **Testing individual components** - Modules can be unit tested in isolation

## Target Module Structure

```
infra/src/lambda/StartMinecraftServer/
├── index.js            # Main handler (orchestration only)
├── clients.js          # AWS SDK client initialization (ec2, ses, ssm)
├── ec2.js              # ensureInstanceRunning, getPublicIp, pollInstanceForIp
├── cloudflare.js       # updateCloudflareDns
├── notifications.js    # getSanitizedErrorMessage, sendNotification
├── allowlist.js        # getAllowlist, updateAllowlist, extractEmails
├── command-parser.js   # parseCommand
├── ssm.js              # executeSSMCommand, waitForSSMCompletion
├── email-parser.js     # parseEmailFromEvent
└── handlers/
    ├── backup.js       # handleBackup
    ├── restore.js      # handleRestore
    ├── hibernate.js    # handleHibernate, stopInstanceAndWait, detachAndDeleteVolumes, detachVolume
    └── resume.js       # handleResume, findLatestAL2023Snapshot, createAndAttachVolume, waitForVolumeAvailable, attachVolumeToInstance
```

## Current Code Analysis

**Source file:** `infra/src/lambda/StartMinecraftServer/index.js` (898 lines)

| Lines | Concern | Target Module |
|-------|---------|---------------|
| 1-26 | AWS Client Setup | `clients.js` |
| 38-159 | EC2 Operations | `ec2.js` |
| 169-201 | Cloudflare DNS | `cloudflare.js` |
| 207-250 | Email/Notifications | `notifications.js` |
| 256-304 | Email Allowlist | `allowlist.js` |
| 306-348 | Command Parsing | `command-parser.js` |
| 354-401 | SSM Execution | `ssm.js` |
| 409-451 | Backup Handler | `handlers/backup.js` |
| 453-522 | Restore Handler | `handlers/restore.js` |
| 524-603 | Hibernate Handler | `handlers/hibernate.js` |
| 605-718 | Resume Handler | `handlers/resume.js` |
| 720-897 | Main Handler | `index.js` (refactored) |

## Success Criteria

1. **All tests pass** - Existing E2E and unit tests continue to work
2. **No behavior changes** - Lambda handles all commands identically before and after
3. **Module isolation** - Each module has a single responsibility
4. **Clean imports** - No circular dependencies between modules
5. **CDK deployment works** - Stack deploys without modification

## Technical Constraints

- **Runtime:** Node.js 20.x
- **Module format:** ES modules (`import`/`export`)
- **No build step:** Code must work directly with `lambda.Code.fromAsset()`
- **Handler signature:** Must remain `export const handler = async (event) => {}`

## Dependencies & References

### Source Files
- `infra/src/lambda/StartMinecraftServer/index.js` - Main file to refactor
- `infra/src/lambda/UpdateDns/index.js` - Reference for duplicated code (getPublicIp, updateCloudflareDns)
- `infra/lib/minecraft-stack.ts` - CDK stack (lines 185-201 for StartMinecraftLambda, 204-216 for UpdateDns)

### Configuration
- `package.json` - Project dependencies and scripts
- `AGENTS.md` - Coding guidelines for this project

## Code Duplication Note

The `UpdateDns` Lambda (71 lines) duplicates `getPublicIp()` and `updateCloudflareDns()`. Due to the constraint of not modifying CDK, this duplication will remain. A future iteration could:
- Use Lambda layers for shared code
- Restructure CDK to use a parent directory with subfolders

## Implementation Phases

### Phase 1: Foundation
Extract AWS client initialization into `clients.js`

### Phase 2: Core Utilities
Extract EC2, Cloudflare, notifications, and SSM utilities

### Phase 3: Business Logic
Extract allowlist, command parsing, and email parsing

### Phase 4: Command Handlers
Extract backup, restore, hibernate, and resume handlers into `handlers/` directory

### Phase 5: Main Handler Refactor
Simplify `index.js` to import from modules and contain only orchestration logic

### Phase 6: Validation
Run tests, verify deployment, document changes
