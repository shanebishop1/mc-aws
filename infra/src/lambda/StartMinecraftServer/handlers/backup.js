import { ensureInstanceRunning } from "../ec2.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import { sanitizeBackupName } from "../sanitization.js";
import { executeSSMCommand } from "../ssm.js";
import { handleRefreshBackups } from "./backups.js";

/**
 * Handle backup command - runs backup script via SSM
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (optional backup name)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The backup result message
 */
async function handleBackup(instanceId, args, adminEmail) {
  console.log(
    `Handling backup command for instance ${instanceId} with args:`,
    JSON.stringify(args),
    "adminEmail:",
    adminEmail
  );

  try {
    // Ensure instance is running before attempting SSM command
    console.log("Step 1: Ensuring instance is running...");
    await ensureInstanceRunning(instanceId);
    console.log("Step 1 complete: Instance is running");

    // Sanitize backup name (if provided) to prevent command injection
    const backupName = args?.[0] ? sanitizeBackupName(args[0]) : "";
    const command = backupName ? `/usr/local/bin/mc-backup.sh ${backupName}` : "/usr/local/bin/mc-backup.sh";

    console.log("Step 2: Executing backup command...");
    const output = await executeSSMCommand(instanceId, [command]);
    console.log("Step 2 complete: Backup command executed");

    let cacheRefreshWarning = "";
    try {
      console.log("Step 3: Refreshing backup cache...");
      await handleRefreshBackups(instanceId);
      console.log("Step 3 complete: Backup cache refreshed");
    } catch (cacheError) {
      console.error("WARNING: Backup completed but cache refresh failed:", cacheError);
      cacheRefreshWarning =
        "\n\nWarning: Backup cache refresh failed. New backup may not appear in restore list immediately.";
    }

    const message = `Backup completed successfully${backupName ? ` (${backupName})` : ""}.\n\nOutput:\n${output}${cacheRefreshWarning}`;

    if (adminEmail) {
      console.log("Step 4: Sending notification email...");
      await sendNotification(adminEmail, "Minecraft Backup Completed", message);
      console.log("Step 4 complete: Notification sent");
    }

    return message;
  } catch (error) {
    console.error("ERROR in handleBackup:", error.message, error.stack);

    if (adminEmail) {
      console.log("Sending error notification...");
      const sanitizedMessage = getSanitizedErrorMessage("backup");
      await sendNotification(adminEmail, "Minecraft Backup Failed", sanitizedMessage);
    }

    throw error;
  }
}

export { handleBackup };
