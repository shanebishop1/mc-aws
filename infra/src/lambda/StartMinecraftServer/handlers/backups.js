import { ensureInstanceRunning } from "../ec2.js";
import { quotePosixShellArgument } from "../posix-shell.js";
import { executeSSMCommand, getParameter, putParameter } from "../ssm.js";

const BACKUPS_CACHE_PARAM = "/minecraft/backups-cache";
const FAILED_REFRESH_RETRY_MS = 30_000;

function buildListBackupsCommand(
  gdriveRemote,
  gdriveRoot,
  configHelper = "/usr/local/bin/mc-rclone-config.sh",
  configPath = "/opt/setup/rclone/rclone.conf",
  rcloneCommand = "rclone"
) {
  const remotePath = `${gdriveRemote}:${gdriveRoot}/`;
  const listScript = `set -euo pipefail; ${quotePosixShellArgument(configHelper)} >/dev/null; RCLONE_CONFIG=${quotePosixShellArgument(configPath)} ${quotePosixShellArgument(rcloneCommand)} lsf ${quotePosixShellArgument(remotePath)} --max-depth 1 --files-only --format "pst" --separator "|" --filter "+ *.tar.gz" --filter "+ *.gz" --filter "- *" | sort -t"|" -k3,3r | head -n 200`;
  return `bash -lc ${quotePosixShellArgument(listScript)}`;
}

/**
 * Handle refreshBackups command - lists backups from Google Drive and caches in SSM
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The result message
 */
async function handleRefreshBackups(instanceId) {
  console.log(`Handling refreshBackups command for instance ${instanceId}`);

  const previous = await readPreviousCache();
  const startedAt = Date.now();
  await putParameter(
    BACKUPS_CACHE_PARAM,
    JSON.stringify({
      status: "pending",
      backups: previous.backups,
      cachedAt: previous.cachedAt,
      startedAt,
      updatedAt: startedAt,
    }),
    "String"
  );

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
    // Important:
    // - SSM stdout is size-limited, so we must cap output.
    // - `rclone lsf` doesn't support `--sort` on older rclone versions, so sort in shell.
    // - Use `bash -lc` with `pipefail` so rclone failures don't get masked by `head`.
    const command = buildListBackupsCommand(gdriveRemote, gdriveRoot);
    const output = await executeSSMCommand(instanceId, [command]);

    // Parse output - each line is name|size|date
    const backups = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const [name, size, date] = line.split("|");
        if (!name || (!name.endsWith(".tar.gz") && !name.endsWith(".gz"))) return [];
        return [
          {
            name,
            size: size || "unknown",
            date: date || "unknown",
          },
        ];
      })
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")); // Most recent first

    console.log(`Found ${backups.length} backups. Caching in SSM...`);

    const cachePayload = JSON.stringify({
      status: "ready",
      backups,
      cachedAt: Date.now(),
    });

    await putParameter(BACKUPS_CACHE_PARAM, cachePayload, "String");
    console.log("Backups cached successfully.");

    return `Backups refreshed and cached. Found ${backups.length} backups.`;
  } catch (error) {
    console.error("ERROR in handleRefreshBackups:", error.message, error.stack);
    const now = Date.now();
    await putParameter(
      BACKUPS_CACHE_PARAM,
      JSON.stringify({
        status: "failed",
        backups: previous.backups,
        cachedAt: previous.cachedAt,
        startedAt,
        updatedAt: now,
        retryAt: now + FAILED_REFRESH_RETRY_MS,
      }),
      "String"
    );
    throw error;
  }
}

async function readPreviousCache() {
  const raw = await getParameter(BACKUPS_CACHE_PARAM);
  if (!raw) return { backups: [], cachedAt: undefined };
  try {
    const cache = JSON.parse(raw);
    return {
      backups: Array.isArray(cache?.backups) ? cache.backups : [],
      cachedAt: typeof cache?.cachedAt === "number" ? cache.cachedAt : undefined,
    };
  } catch {
    return { backups: [], cachedAt: undefined };
  }
}

export { buildListBackupsCommand, handleRefreshBackups };
