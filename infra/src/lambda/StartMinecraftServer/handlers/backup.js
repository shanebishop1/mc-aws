import { ensureInstanceRunning, getInstanceState } from "../ec2.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import { quotePosixShellArgument } from "../posix-shell.js";
import { sanitizeBackupName } from "../sanitization.js";
import { executeSSMCommand } from "../ssm.js";
import { handleRefreshBackups } from "./backups.js";

/**
 * Handle backup command - runs backup script via SSM
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (optional backup name)
 * @param {string} adminEmail - Admin email for notifications
 * @param {{ requireAlreadyRunning?: boolean, requireServiceActive?: boolean }} options - Scheduled jobs prohibit starts and inactive-service backups
 * @returns {Promise<string>} The backup result message
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Start policy, capability gating, backup, refresh, and notifications form one lifecycle operation.
async function handleBackup(instanceId, args, adminEmail, options = {}) {
  console.log("Handling backup command for managed instance");

  try {
    if (options.requireAlreadyRunning) {
      console.log("Step 1: Verifying instance is already running without starting it...");
      const state = await getInstanceState(instanceId);
      if (state !== "running") {
        const error = new Error(`Scheduled backup requires a running instance; current state is ${state}`);
        error.name = "ScheduledBackupInstanceNotRunning";
        throw error;
      }
    } else {
      // Interactive backups retain their existing start-if-stopped behavior.
      console.log("Step 1: Ensuring instance is running...");
      await ensureInstanceRunning(instanceId);
    }
    console.log("Step 1 complete: Instance is running");

    // Sanitize backup name (if provided) to prevent command injection
    const backupName = args?.[0] ? sanitizeBackupName(args[0]) : "";
    const backupArgument = backupName ? ` ${quotePosixShellArgument(backupName)}` : "";
    if (options.requireServiceActive) {
      const capability = await executeSSMCommand(
        instanceId,
        [
          "if grep -Fq -- '--require-active' /usr/local/bin/mc-backup.sh; then echo supported; else echo unsupported; fi",
        ],
        { maxAttempts: 15, timeoutSeconds: 30, step: "backup-capability", finalRemoteStep: false }
      );
      if (capability.trim() !== "supported") {
        const error = new Error("Scheduled backup requires the current host backup runtime");
        error.name = "ScheduledBackupHostIncompatible";
        throw error;
      }
    }
    const command = `/usr/local/bin/mc-backup.sh${options.requireServiceActive ? " --require-active" : ""}${backupArgument}`;

    console.log("Step 2: Executing backup command...");
    await executeSSMCommand(instanceId, [command], { step: "backup", finalRemoteStep: false });
    console.log("Step 2 complete: Backup command executed");

    let cacheRefreshWarning = "";
    try {
      console.log("Step 3: Refreshing backup cache...");
      await handleRefreshBackups(instanceId, { requireAlreadyRunning: options.requireAlreadyRunning === true });
      console.log("Step 3 complete: Backup cache refreshed");
    } catch {
      console.error("WARNING: Backup completed but cache refresh failed.");
      cacheRefreshWarning =
        "\n\nWarning: Backup cache refresh failed. New backup may not appear in restore list immediately.";
    }

    const message = `Backup completed successfully${backupName ? ` (${backupName})` : ""}.${cacheRefreshWarning}`;

    if (adminEmail) {
      console.log("Step 4: Sending notification email...");
      await sendNotification(adminEmail, "Minecraft Backup Completed", message);
      console.log("Step 4 complete: Notification sent");
    }

    return message;
  } catch (error) {
    console.error("ERROR in handleBackup.");

    if (adminEmail) {
      console.log("Sending error notification...");
      const sanitizedMessage = getSanitizedErrorMessage("backup");
      await sendNotification(adminEmail, "Minecraft Backup Failed", sanitizedMessage);
    }

    throw error;
  }
}

export { handleBackup };
