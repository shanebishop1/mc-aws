import { ensureInstanceRunning } from "../ec2.js";
import { executeSSMCommand, putParameter } from "../ssm.js";

/**
 * Handle refreshBackups command - lists backups from Google Drive and caches in SSM
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The result message
 */
async function handleRefreshBackups(instanceId) {
  console.log(`Handling refreshBackups command for instance ${instanceId}`);

  try {
    // Ensure instance is running before attempting SSM command
    console.log("Step 1: Ensuring instance is running...");
    await ensureInstanceRunning(instanceId);
    console.log("Step 1 complete: Instance is running");

    const gdriveRemote = process.env.GDRIVE_REMOTE;
    const gdriveRoot = process.env.GDRIVE_ROOT;

    if (!gdriveRemote || !gdriveRoot) {
      throw new Error("Google Drive config not set (GDRIVE_REMOTE or GDRIVE_ROOT missing)");
    }

    console.log(`Listing backups from Google Drive (${gdriveRemote}:${gdriveRoot})...`);

    // p - path, s - size, t - modification time
    // RCLONE_CONFIG must be set because SSM runs as root, not the minecraft user.
    // Important: SSM stdout is size-limited; sort newest-first and cap lines so recent backups don't get truncated.
    const command =
      `RCLONE_CONFIG=/opt/setup/rclone/rclone.conf ` +
      `rclone lsf "${gdriveRemote}:${gdriveRoot}/" ` +
      `--files-only ` +
      `--format "pst" --separator "|" ` +
      `--include "*.tar.gz" --include "*.gz" --exclude "*" ` +
      `--sort time --reverse | head -n 200`;
    const output = await executeSSMCommand(instanceId, [command]);

    // Parse output - each line is name|size|date
    const backups = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, size, date] = line.split("|");
        return {
          name,
          size: size || "unknown",
          date: date || "unknown",
        };
      })
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")); // Most recent first

    console.log(`Found ${backups.length} backups. Caching in SSM...`);

    const cachePayload = JSON.stringify({
      backups,
      cachedAt: Date.now(),
    });

    await putParameter("/minecraft/backups-cache", cachePayload, "String");
    console.log("Backups cached successfully.");

    return `Backups refreshed and cached. Found ${backups.length} backups.`;
  } catch (error) {
    console.error("ERROR in handleRefreshBackups:", error.message, error.stack);
    throw error;
  }
}

export { handleRefreshBackups };
