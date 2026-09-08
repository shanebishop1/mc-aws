import { getInstanceState } from "../ec2.js";
import { getOperationExecutionContext } from "../execution-context.js";
import {
  LifecycleLockConflictError,
  acquireLifecycleLock,
  getCurrentLifecycleLock,
  releaseLifecycleLock,
} from "../lifecycle-lock.js";
import { quotePosixShellArgument } from "../posix-shell.js";
import { BACKUPS_REFRESH_SSM_MAX_ATTEMPTS, BACKUPS_REFRESH_SSM_TIMEOUT_SECONDS } from "../runtime-budgets.js";
import { executeSSMCommand, getParameter, putParameter } from "../ssm.js";

const BACKUPS_CACHE_PARAM = "/minecraft/backups-cache";
const FAILED_REFRESH_RETRY_MS = 30_000;
const REFRESH_LOCK_OWNER = "backup-refresh@mc-aws.internal";

function buildListBackupsCommand(
  gdriveRemote,
  gdriveRoot,
  configHelper = "/usr/local/bin/mc-rclone-config.sh",
  configPath = "/opt/setup/rclone/rclone.conf",
  rcloneCommand = "rclone",
  backupAuthHelper = "/usr/local/bin/mc-backup-auth.py"
) {
  const listScript = `set -euo pipefail; test ! -e /var/lib/mc-aws/maintenance-boot-hold.json; test ! -e /run/mc-agent/maintenance-state.json; ${quotePosixShellArgument(configHelper)} >/dev/null; ${quotePosixShellArgument(backupAuthHelper)} list --remote ${quotePosixShellArgument(gdriveRemote)} --root ${quotePosixShellArgument(gdriveRoot)} --config ${quotePosixShellArgument(configPath)} --rclone ${quotePosixShellArgument(rcloneCommand)}`;
  return `bash -lc ${quotePosixShellArgument(listScript)}`;
}

async function acquireRefreshFence(options) {
  const currentLock = await getCurrentLifecycleLock();
  const context = getOperationExecutionContext();
  const ownedBackupRefresh =
    options.allowOwnedLifecycleOperation === true &&
    context?.lockId &&
    currentLock?.lockId === context.lockId &&
    currentLock?.fencingToken === context.fencingToken &&
    currentLock.action === "backup";
  if (currentLock && !ownedBackupRefresh) throw new LifecycleLockConflictError(currentLock);
  return currentLock ? null : await acquireLifecycleLock("backup", REFRESH_LOCK_OWNER);
}

async function releaseRefreshFence(lock) {
  if (!lock) return;
  await releaseLifecycleLock(lock.lockId, lock.fencingToken, lock.action, lock.ownerEmail);
}

/**
 * Handle refreshBackups command - lists backups from Google Drive and caches in SSM
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The result message
 */
async function handleRefreshBackups(instanceId, options = {}) {
  console.log("Handling refreshBackups command for managed instance");
  const acquiredLock = await acquireRefreshFence(options);
  try {
    return await refreshBackupsUnderFence(instanceId, options);
  } finally {
    await releaseRefreshFence(acquiredLock);
  }
}

async function refreshBackupsUnderFence(instanceId, options) {
  const instanceState = await getInstanceState(instanceId);
  if (instanceState !== "running") {
    const error = new Error(`Backup cache refresh requires a running instance; current state is ${instanceState}`);
    error.name = "BackupRefreshInstanceNotRunning";
    throw error;
  }

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
    console.log("Step 1: Confirming instance remains running without starting it...");
    console.log("Step 1 complete: Instance is running");

    const gdriveRemote = process.env.GDRIVE_REMOTE;
    const gdriveRoot = process.env.GDRIVE_ROOT;
    if (!gdriveRemote || !gdriveRoot) {
      throw new Error("Google Drive config not set (GDRIVE_REMOTE or GDRIVE_ROOT missing)");
    }

    console.log("Listing backups from configured Google Drive location");
    const command = buildListBackupsCommand(gdriveRemote, gdriveRoot);
    const output = await executeSSMCommand(instanceId, [command], {
      maxAttempts: BACKUPS_REFRESH_SSM_MAX_ATTEMPTS,
      timeoutSeconds: BACKUPS_REFRESH_SSM_TIMEOUT_SECONDS,
      step: "refresh-backups",
      finalRemoteStep: true,
    });

    let listed;
    try {
      listed = JSON.parse(output.trim() || "[]");
    } catch {
      throw new Error("Backup listing did not return authenticated manifest records");
    }
    if (!Array.isArray(listed) || listed.some((record) => !isAuthenticatedBackup(record))) {
      throw new Error("Backup listing contained an unauthenticated or malformed manifest");
    }
    const backups = listed
      .map((record) => ({
        name: record.archiveName,
        size: String(record.archiveSize),
        date: record.createdAt,
        backupId: record.backupId,
        digest: record.archiveSha256,
        generation: record.generation,
        createdAt: record.createdAt,
        instanceId: record.instanceId,
        serverId: record.serverId,
        authenticationKeyId: record.authenticationKeyId,
        operationKey: record.operationKey,
      }))
      .sort((a, b) => b.generation - a.generation || b.createdAt.localeCompare(a.createdAt));

    let matchedBackup;
    if (options.expectedBackup) {
      const expected = options.expectedBackup;
      matchedBackup = backups.find(
        (record) =>
          record.name === expected.archiveName &&
          record.backupId === expected.backupId &&
          record.digest === expected.archiveSha256 &&
          record.generation === expected.generation &&
          record.createdAt === expected.createdAt &&
          record.instanceId === expected.instanceId &&
          record.serverId === expected.serverId &&
          record.operationKey === expected.operationKey
      );
      if (!matchedBackup)
        throw new Error("Fresh authenticated backup identity was not found in the validated remote listing");
    }

    console.log(`Found ${backups.length} backups. Caching in SSM...`);
    await putParameter(
      BACKUPS_CACHE_PARAM,
      JSON.stringify({
        status: "ready",
        backups,
        cachedAt: Date.now(),
      }),
      "String"
    );
    console.log("Backups cached successfully.");
    return { backups, matchedBackup };
  } catch (error) {
    console.error("ERROR in handleRefreshBackups.");
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

function isAuthenticatedBackup(value) {
  return (
    value &&
    typeof value === "object" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(value.archiveName) &&
    /^[a-f0-9]{32}$/.test(value.backupId) &&
    /^[a-f0-9]{64}$/.test(value.archiveSha256) &&
    Number.isSafeInteger(value.archiveSize) &&
    value.archiveSize > 0 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    /^i-[a-f0-9]{8,17}$/.test(value.instanceId) &&
    typeof value.serverId === "string" &&
    value.serverId.length > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.authenticationKeyId) &&
    (value.operationKey === null || /^[a-f0-9]{64}$/.test(value.operationKey))
  );
}

async function readPreviousCache() {
  const raw = await getParameter(BACKUPS_CACHE_PARAM);
  if (!raw) return { backups: [], cachedAt: undefined };
  try {
    const cache = JSON.parse(raw);
    const backups = Array.isArray(cache?.backups) ? cache.backups.filter(isCachedBackup) : [];
    return {
      backups,
      cachedAt: typeof cache?.cachedAt === "number" ? cache.cachedAt : undefined,
    };
  } catch {
    return { backups: [], cachedAt: undefined };
  }
}

function isCachedBackup(value) {
  return (
    value &&
    typeof value === "object" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(value.name) &&
    /^[a-f0-9]{32}$/.test(value.backupId) &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    /^i-[a-f0-9]{8,17}$/.test(value.instanceId) &&
    typeof value.serverId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/.test(value.serverId) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.authenticationKeyId) &&
    (value.operationKey === null || /^[a-f0-9]{64}$/.test(value.operationKey))
  );
}

export { buildListBackupsCommand, handleRefreshBackups, isAuthenticatedBackup };
