# Email-Triggered Server Management Plan

## Overview

Extend the email trigger system to support automated server operations beyond just "start". Admin can send emails to trigger backup, restore, hibernate, and resume operations - all executed directly on the EC2 instance via AWS Systems Manager (SSM).

## Goals

1. **Backup**: Admin emails to backup server world to Google Drive with custom or auto-generated name
2. **Restore**: Admin emails to restore server world from a specific Google Drive backup
3. **Hibernate**: Admin emails to hibernate server (stop EC2, backup to Drive, delete EBS)
4. **Resume**: Admin emails to resume server (create new EBS, start EC2, restore from Drive)
5. **No local machine required**: Everything happens in the cloud
6. **Confirmation emails**: Admin receives status updates for all operations

## Architecture

```
Admin Email
    ↓
SES → SNS → Lambda (StartMinecraftServer)
    ↓
Parse command from subject
    ↓
SSM Run Command → Execute script on EC2
    ↓
EC2 runs backup/restore/hibernate script
    ↓
Lambda sends confirmation email to admin
```

## Email Command Format

**Subject line contains command and optional arguments:**

- `start` - Start the server (existing functionality)
- `backup` - Backup to Drive with auto-generated timestamp name
- `backup my-world-jan-2026` - Backup to Drive with custom name
- `restore my-world-jan-2026` - Restore from Drive backup
- `hibernate` - Stop server, backup to Drive, delete EBS
- `resume` - Create new EBS, start server, restore latest backup
- `resume my-world-jan-2026` - Create new EBS, start server, restore specific backup

**Body contains email allowlist (existing functionality):**

- Lines with email addresses update the allowlist

## Implementation Components

### 1. Lambda Changes (`src/lambda/StartMinecraftServer/index.js`)

**New functionality:**
- Parse subject line to extract command and arguments
- Route to appropriate handler based on command
- Use SSM `SendCommand` API to execute scripts on EC2
- Wait for command completion (or timeout)
- Send confirmation/error email with results

**Command parsing:**
```javascript
// Examples:
// "start" → { command: "start", args: [] }
// "backup" → { command: "backup", args: [] }
// "backup my-world" → { command: "backup", args: ["my-world"] }
// "restore my-world-jan-2026" → { command: "restore", args: ["my-world-jan-2026"] }

function parseCommand(subject, startKeyword) {
  const parts = subject.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  // Check if it's the start keyword
  if (subject.includes(startKeyword)) {
    return { command: "start", args: [] };
  }
  
  // Check for server management commands
  const validCommands = ["backup", "restore", "hibernate", "resume"];
  if (validCommands.includes(command)) {
    return { command, args };
  }
  
  return null;
}
```

**SSM integration:**
```javascript
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";

async function executeOnEC2(instanceId, scriptName, args) {
  // Send command to EC2
  const response = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: {
      commands: [`/usr/local/bin/${scriptName}.sh ${args.join(' ')}`]
    },
    TimeoutSeconds: 3600 // 1 hour max
  }));
  
  const commandId = response.Command.CommandId;
  
  // Poll for completion (with timeout)
  // Return command output
}
```

### 2. EC2 Scripts (deployed via user_data.sh)

**Location:** `/usr/local/bin/` on EC2

**New scripts to create:**

#### `mc-backup.sh`
```bash
#!/usr/bin/env bash
# Backup Minecraft server to Google Drive
# Usage: mc-backup.sh [backup-name]
# If no name provided, use timestamp

BACKUP_NAME="${1:-server-$(date +%Y%m%d-%H%M%S)}"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

# Stop server gracefully
systemctl stop minecraft

# Create tar archive
cd /opt/minecraft
tar -czf "/tmp/${BACKUP_NAME}.tar.gz" server/

# Upload to Google Drive
rclone copy "/tmp/${BACKUP_NAME}.tar.gz" "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"

# Cleanup
rm "/tmp/${BACKUP_NAME}.tar.gz"

# Restart server
systemctl start minecraft

echo "SUCCESS: Backup ${BACKUP_NAME}.tar.gz uploaded to Google Drive"
```

#### `mc-restore.sh`
```bash
#!/usr/bin/env bash
# Restore Minecraft server from Google Drive
# Usage: mc-restore.sh <backup-name>

BACKUP_NAME="$1"
if [[ -z "$BACKUP_NAME" ]]; then
  echo "ERROR: Backup name required"
  exit 1
fi

GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
SERVER_DIR="/opt/minecraft/server"

# Stop server
systemctl stop minecraft

# Download from Google Drive
rclone copy "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_NAME}.tar.gz" /tmp/

# Backup current server (just in case)
if [[ -d "$SERVER_DIR" ]]; then
  mv "$SERVER_DIR" "${SERVER_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
fi

# Extract backup
cd /opt/minecraft
tar -xzf "/tmp/${BACKUP_NAME}.tar.gz"

# Set permissions
chown -R minecraft:minecraft "$SERVER_DIR"

# Cleanup
rm "/tmp/${BACKUP_NAME}.tar.gz"

# Start server
systemctl start minecraft

echo "SUCCESS: Restored from ${BACKUP_NAME}.tar.gz"
```

#### `mc-hibernate.sh`
```bash
#!/usr/bin/env bash
# Hibernate server: backup to Drive, stop EC2, delete EBS
# Usage: mc-hibernate.sh [backup-name]

BACKUP_NAME="${1:-hibernate-$(date +%Y%m%d-%H%M%S)}"

# Run backup first
/usr/local/bin/mc-backup.sh "$BACKUP_NAME"

# Get instance ID and volume ID
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d " " -f 2)
VOLUME_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId" \
  --output text)

# Stop instance (this script will be killed, but commands are queued)
aws ec2 stop-instances --instance-ids "$INSTANCE_ID"

# Wait for stop (this may not complete if instance stops first)
sleep 30

# Detach and delete volume
aws ec2 detach-volume --volume-id "$VOLUME_ID"
aws ec2 delete-volume --volume-id "$VOLUME_ID"

echo "SUCCESS: Hibernated with backup ${BACKUP_NAME}.tar.gz, EBS deleted"
```

#### `mc-resume.sh`
```bash
#!/usr/bin/env bash
# Resume server: create new EBS, start EC2, restore from Drive
# Usage: mc-resume.sh <backup-name>
# Note: This runs on boot via user_data if "resume" flag is set

BACKUP_NAME="$1"

# If no backup specified, find the latest
if [[ -z "$BACKUP_NAME" ]]; then
  GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
  GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
  
  # List backups and get latest
  BACKUP_NAME=$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" \
    | grep '.tar.gz$' \
    | sort -r \
    | head -1 \
    | sed 's/.tar.gz$//')
fi

if [[ -z "$BACKUP_NAME" ]]; then
  echo "ERROR: No backups found in Google Drive"
  exit 1
fi

# Restore from backup
/usr/local/bin/mc-restore.sh "$BACKUP_NAME"

echo "SUCCESS: Resumed from ${BACKUP_NAME}.tar.gz"
```

### 3. CDK Changes

**Grant Lambda SSM permissions:**
```typescript
startLambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: [
      "ssm:SendCommand",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations"
    ],
    resources: [
      `arn:aws:ssm:${this.region}:${this.account}:*`,
      `arn:aws:ec2:${this.region}:${this.account}:instance/*`
    ],
  }),
);
```

**Grant EC2 additional permissions:**
```typescript
// EC2 needs to manage its own volumes for hibernate
ec2Role.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      "ec2:DescribeVolumes",
      "ec2:DetachVolume",
      "ec2:DeleteVolume",
      "ec2:CreateVolume",
      "ec2:AttachVolume"
    ],
    resources: ["*"],
  }),
);
```

**Deploy scripts to EC2 via user_data:**
```bash
# In user_data.sh, add:
# Download management scripts from GitHub repo
for script in mc-backup.sh mc-restore.sh mc-hibernate.sh mc-resume.sh; do
  curl -o "/usr/local/bin/$script" \
    "https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/src/ec2/scripts/$script"
  chmod +x "/usr/local/bin/$script"
done
```

### 4. Lambda Command Handlers

**Handler structure:**
```javascript
async function handleCommand(command, args, instanceId, adminEmail) {
  switch(command) {
    case "start":
      return await handleStart(instanceId, adminEmail);
    
    case "backup":
      const backupName = args[0] || `backup-${Date.now()}`;
      return await executeOnEC2(instanceId, "mc-backup", [backupName]);
    
    case "restore":
      if (!args[0]) throw new Error("Restore requires backup name");
      return await executeOnEC2(instanceId, "mc-restore", [args[0]]);
    
    case "hibernate":
      const hibernateName = args[0] || `hibernate-${Date.now()}`;
      return await executeOnEC2(instanceId, "mc-hibernate", [hibernateName]);
    
    case "resume":
      // Resume requires special handling (EC2 might be stopped)
      return await handleResume(instanceId, args[0], adminEmail);
    
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
```

**Resume handler (special case):**
```javascript
async function handleResume(instanceId, backupName, adminEmail) {
  // Check if instance is stopped (hibernated)
  const instance = await ec2.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId]
  }));
  
  const state = instance.Reservations[0].Instances[0].State.Name;
  
  if (state === "stopped") {
    // Start the instance first
    await ec2.send(new StartInstancesCommand({
      InstanceIds: [instanceId]
    }));
    
    // Wait for instance to be running
    await waitForInstanceRunning(instanceId);
    
    // Now execute restore script
    return await executeOnEC2(instanceId, "mc-resume", backupName ? [backupName] : []);
  } else if (state === "running") {
    // Just restore
    return await executeOnEC2(instanceId, "mc-resume", backupName ? [backupName] : []);
  } else {
    throw new Error(`Cannot resume: instance is in ${state} state`);
  }
}
```

## Error Handling

1. **Invalid commands**: Return early with error message to admin
2. **Missing arguments**: Validate and return helpful error
3. **EC2 not running**: For backup/restore/hibernate, check instance state first
4. **SSM timeout**: If command takes >5 minutes, send "in progress" email, poll async
5. **Script failures**: Parse stderr from SSM output, send to admin
6. **Drive failures**: Scripts should handle rclone errors and exit with error message

## Security Considerations

1. **Only admin can run commands**: Check sender === NOTIFICATION_EMAIL
2. **No arbitrary command execution**: Whitelist only specific scripts
3. **SSM Run Command**: Uses existing IAM roles, no SSH keys needed
4. **Google Drive token**: Already secured in SSM Parameter Store
5. **Backup encryption**: Consider encrypting tar archives before upload (future enhancement)

## Testing Strategy

1. Test each command individually via email
2. Verify confirmation emails are sent
3. Test error conditions (missing args, invalid backup names, etc.)
4. Test hibernate/resume cycle with actual data
5. Test with missing Drive token (should fail gracefully)

## Implementation Steps

1. ✅ Create plan.md
2. Create EC2 scripts (mc-backup.sh, mc-restore.sh, mc-hibernate.sh, mc-resume.sh)
3. Update user_data.sh to deploy scripts on boot
4. Update Lambda to parse commands and use SSM
5. Update CDK to grant SSM and EC2 permissions
6. Update README with new email commands
7. Deploy and test each command
8. Add error handling and confirmation emails

## Future Enhancements

- List available backups via email
- Schedule automatic backups (cron + email notification)
- Backup retention policy (auto-delete old backups)
- Encrypted backups
- Support for S3 in addition to Google Drive
- Async command handling (webhook callback for long operations)
