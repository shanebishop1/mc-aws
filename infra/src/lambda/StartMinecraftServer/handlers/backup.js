import { ensureInstanceRunning, getInstanceState } from "../ec2.js";
import { TerminalLifecycleError } from "../failure-classification.js";
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
 * @param {{ requireAlreadyRunning?: boolean, requireServiceActive?: boolean, strictAgentBackup?: boolean, agentTwoPhase?: boolean, backupMode?: "ordinary"|"hibernate", requireFreshBackup?: boolean, rootVolume?: {volumeId: string, device: string} }} options - Strict jobs prohibit starts and inactive-service backups
 * @returns {Promise<{message: string, manifest: object}>} The backup result and authenticated manifest identity
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Start policy, capability gating, backup, refresh, and notifications form one lifecycle operation.
async function handleBackup(instanceId, args, adminEmail, options = {}) {
  console.log("Handling backup command for managed instance");

  try {
    if (options.requireAlreadyRunning) {
      console.log("Step 1: Verifying instance is already running without starting it...");
      const state = await getInstanceState(instanceId);
      if (state !== "running") {
        if (options.strictAgentBackup) {
          throw new TerminalLifecycleError("Agent backup requires an already-running instance", {
            code: "agent_backup_unavailable",
          });
        }
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
        if (options.strictAgentBackup) {
          throw new TerminalLifecycleError("Agent backup requires the current active-only host runtime", {
            code: "agent_backup_unavailable",
          });
        }
        const error = new Error("Scheduled backup requires the current host backup runtime");
        error.name = "ScheduledBackupHostIncompatible";
        throw error;
      }
    }
    const volumeEnvironment = options.rootVolume
      ? `MC_ROOT_VOLUME_ID=${quotePosixShellArgument(options.rootVolume.volumeId)} MC_ROOT_VOLUME_DEVICE=${quotePosixShellArgument(options.rootVolume.device)} `
      : "";
    const command = `${volumeEnvironment}/usr/local/bin/mc-backup.sh${options.backupMode === "hibernate" ? " --hibernate" : ""}${options.requireServiceActive ? " --require-active" : ""}${options.agentTwoPhase ? " --agent-two-phase" : ""}${backupArgument}`;

    console.log("Step 2: Executing backup command...");
    let output;
    try {
      output = await executeSSMCommand(instanceId, [command], {
        step: options.backupMode === "hibernate" ? "hibernate-backup" : "backup",
        finalRemoteStep: false,
      });
    } catch (error) {
      if (error?.retainLifecycleLock === true || error?.hostRecoveryRequired === true) throw error;
      if (options.strictAgentBackup) {
        const state = await getInstanceState(instanceId);
        const service =
          state === "running"
            ? await executeSSMCommand(
                instanceId,
                ["if systemctl is-active --quiet minecraft.service; then echo active; else echo inactive; fi"],
                { maxAttempts: 3, timeoutSeconds: 15, step: "backup-active-reconciliation", finalRemoteStep: false }
              ).catch(() => "unknown")
            : "inactive";
        if (state !== "running" || service.trim() !== "active") {
          throw new TerminalLifecycleError("Minecraft became unavailable before strict agent backup execution", {
            code: "agent_backup_unavailable",
            cause: error,
          });
        }
      }
      throw error;
    }
    const manifest = parseAuthenticatedManifestResult(output, {
      requireTerminalQuiescence: options.backupMode === "hibernate",
    });
    console.log("Step 2 complete: Authenticated backup manifest returned");

    let cacheRefreshWarning = "";
    try {
      if (options.backupMode === "hibernate") {
        console.log("Step 3: Terminal hibernation skips host cache writes after final backup publication");
      } else {
        console.log("Step 3: Refreshing backup cache...");
        const refreshed = await handleRefreshBackups(instanceId, {
          allowOwnedLifecycleOperation: true,
          ...(options.requireFreshBackup ? { expectedBackup: manifest } : {}),
        });
        if (options.requireFreshBackup && !refreshed.matchedBackup) {
          throw new Error("Fresh authenticated backup identity was not found after hibernation backup");
        }
        console.log("Step 3 complete: Backup cache refreshed");
      }
    } catch (error) {
      if (options.requireFreshBackup) throw error;
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

    return { message, manifest };
  } catch (error) {
    console.error("ERROR in handleBackup.");

    if (adminEmail) {
      console.log("Sending error notification...");
      const sanitizedMessage = getSanitizedErrorMessage("backup");
      try {
        await sendNotification(adminEmail, "Minecraft Backup Failed", sanitizedMessage);
      } catch {
        console.error("WARNING: Failed to send backup failure notification");
      }
    }

    throw error;
  }
}

function parseAuthenticatedManifestResult(output, options = {}) {
  const line = String(output || "")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith("MC_BACKUP_MANIFEST_RESULT "));
  if (!line) {
    throw new TerminalLifecycleError("Host did not return an authenticated backup manifest; host upgrade is required", {
      code: "authenticated_backup_manifest_missing",
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(line.slice("MC_BACKUP_MANIFEST_RESULT ".length));
  } catch {
    throw new TerminalLifecycleError("Host returned a malformed authenticated backup manifest", {
      code: "authenticated_backup_manifest_invalid",
    });
  }
  if (
    !manifest ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/.test(manifest.archiveName) ||
    !/^[a-f0-9]{32}$/.test(manifest.backupId) ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
    !Number.isSafeInteger(manifest.archiveSize) ||
    manifest.archiveSize < 1 ||
    !Number.isSafeInteger(manifest.generation) ||
    manifest.generation < 1 ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !/^i-[a-f0-9]{8,17}$/.test(manifest.instanceId) ||
    typeof manifest.serverId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.authenticationKeyId) ||
    (manifest.operationKey !== null && !/^[a-f0-9]{64}$/.test(manifest.operationKey))
  ) {
    throw new TerminalLifecycleError("Host returned an invalid authenticated backup manifest", {
      code: "authenticated_backup_manifest_invalid",
    });
  }
  if (options.requireTerminalQuiescence) {
    const quiescenceLine = String(output || "")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith("MC_BACKUP_QUIESCENCE_RESULT "));
    if (!quiescenceLine) {
      throw new TerminalLifecycleError("Host did not return terminal hibernation quiescence evidence", {
        code: "hibernate_quiescence_evidence_missing",
      });
    }
    let quiescence;
    try {
      quiescence = JSON.parse(quiescenceLine.slice("MC_BACKUP_QUIESCENCE_RESULT ".length));
    } catch {
      throw new TerminalLifecycleError("Host returned malformed terminal hibernation quiescence evidence", {
        code: "hibernate_quiescence_evidence_invalid",
      });
    }
    if (
      !quiescence ||
      Object.keys(quiescence).sort().join(",") !==
        [
          "bootId",
          "maintenanceFence",
          "maintenanceOwner",
          "minecraft",
          "mode",
          "protocol",
          "quiescenceEpoch",
          "rootVolumeDevice",
          "rootVolumeId",
          "schemaVersion",
          "services",
        ].join(",") ||
      quiescence.schemaVersion !== 2 ||
      quiescence.mode !== "terminal-hibernate" ||
      quiescence.maintenanceFence !== "held" ||
      quiescence.services !== "stopped-and-masked" ||
      quiescence.minecraft !== "inactive" ||
      quiescence.protocol !== "closed" ||
      typeof quiescence.bootId !== "string" ||
      quiescence.bootId.length < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(quiescence.maintenanceOwner) ||
      !/^[a-f0-9]{32}$/.test(quiescence.quiescenceEpoch) ||
      !/^vol-[a-f0-9]{8,17}$/.test(quiescence.rootVolumeId) ||
      !/^\/dev\/[A-Za-z0-9._/-]{1,127}$/.test(quiescence.rootVolumeDevice)
    ) {
      throw new TerminalLifecycleError("Host returned invalid terminal hibernation quiescence evidence", {
        code: "hibernate_quiescence_evidence_invalid",
      });
    }
    manifest.quiescence = quiescence;
  }
  return manifest;
}

export { handleBackup, parseAuthenticatedManifestResult };
