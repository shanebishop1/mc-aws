import { updateCloudflareDns } from "../cloudflare.js";
import { ensureInstanceRunning, getPublicIp } from "../ec2.js";
import { getSanitizedErrorMessage, sendNotification } from "../notifications.js";
import { sanitizeBackupName } from "../sanitization.js";
import { executeSSMCommand } from "../ssm.js";

/**
 * Handle restore command - runs restore script via SSM and updates DNS
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (optional backup name; if missing, restores latest)
 * @param {string} adminEmail - Admin email for notifications
 * @param {Object} cloudflareConfig - Cloudflare configuration { zone, record, domain, cfToken }
 * @returns {Promise<string>} The restore result message
 */

export async function handleRestore(instanceId, args, adminEmail, cloudflareConfig) {
  console.log(
    `Handling restore command for instance ${instanceId} with args:`,
    JSON.stringify(args),
    "adminEmail:",
    adminEmail
  );

  try {
    // Ensure instance is running before attempting SSM command
    console.log("Step 1: Ensuring instance is running...");
    await ensureInstanceRunning(instanceId);
    console.log("Step 1 complete: Instance is running");

    // Determine if restoring specific backup or latest
    const backupName = args?.[0]?.trim() ?? "";
    const isLatest = !backupName;

    if (isLatest) {
      console.log("Step 2: Restoring latest backup (no specific name provided)");
    } else {
      console.log("Step 2: Restoring specific backup:", backupName);
    }

    // Build command: if backup name provided, sanitize it; otherwise run with no arg for latest
    let command;
    if (isLatest) {
      command = "/usr/local/bin/mc-restore.sh";
    } else {
      const sanitizedBackupName = sanitizeBackupName(backupName);
      command = `/usr/local/bin/mc-restore.sh ${sanitizedBackupName}`;
    }

    const output = await executeSSMCommand(instanceId, [command]);
    console.log("Step 2 complete: Restore command executed");

    // Step 3: Update DNS (in case IP changed or wasn't set)
    let publicIp = null;
    if (cloudflareConfig) {
      console.log("Step 3: Updating Cloudflare DNS...");
      publicIp = await getPublicIp(instanceId);
      await updateCloudflareDns(
        cloudflareConfig.zone,
        cloudflareConfig.record,
        publicIp,
        cloudflareConfig.domain,
        cloudflareConfig.cfToken
      );
      console.log("Step 3 complete: DNS updated to", publicIp);
    }

    const backupDescription = isLatest ? "latest backup" : `backup: ${backupName}`;
    const message = `Restore completed successfully (${backupDescription}).${publicIp ? `\nDNS updated to ${publicIp}` : ""}\n\nOutput:\n${output}`;

    if (adminEmail) {
      console.log("Step 4: Sending notification email...");
      await sendNotification(adminEmail, "Minecraft Restore Completed", message);
      console.log("Step 4 complete: Notification sent");
    }

    return message;
  } catch (error) {
    console.error("ERROR in handleRestore:", error.message, error.stack);

    if (adminEmail) {
      console.log("Sending error notification...");
      const sanitizedMessage = getSanitizedErrorMessage("restore");
      await sendNotification(adminEmail, "Minecraft Restore Failed", sanitizedMessage);
    }

    throw error;
  }
}
