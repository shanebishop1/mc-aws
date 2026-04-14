// AWS SDK clients and commands
// EC2 operations
import { ensureInstanceRunning, getPublicIp } from "./ec2.js";

// Notifications
import { getSanitizedErrorMessage, sendNotification } from "./notifications.js";
import { updateOperationState } from "./operation-state.js";

// SSM command execution
import { deleteParameter, executeSSMCommand, getParameter, putParameter } from "./ssm.js";

// Allowlist management
import { extractEmails, getAllowlist, updateAllowlist } from "./allowlist.js";

// Parsers
import { parseCommand } from "./command-parser.js";
import { parseEmailFromEvent } from "./email-parser.js";
import { resolveResumeRestoreStrategy } from "./restore-contract.js";

// Command handlers
import { handleBackup } from "./handlers/backup.js";
import { handleRefreshBackups } from "./handlers/backups.js";
import { handleHibernate } from "./handlers/hibernate.js";
import { handleRestore } from "./handlers/restore.js";
import { handleResume } from "./handlers/resume.js";

export const handler = async (event) => {
  console.log("=== LAMBDA INVOKED ===");

  // Route to appropriate handler based on invocation type
  if (event.invocationType === "api") {
    return handleApiInvocation(event);
  }

  return handleEmailInvocation(event);
};

/**
 * Handle API invocation for async commands
 */
async function handleApiInvocation(event) {
  const { instanceId, userEmail, command, args, lockId, operationId } = event;
  console.log(`[API] Async command '${command}' triggered by ${userEmail}`);

  if (!instanceId || !userEmail || !command) {
    await persistOperationStateSafely({
      operationId,
      command,
      status: "failed",
      userEmail,
      instanceId,
      lockId,
      error: "Invalid payload",
      code: "invalid_payload",
    });

    console.error("[API] Invalid API payload:", event);
    return { statusCode: 400, body: "Invalid payload" };
  }

  const envResult = validateEnvironment();
  if (envResult.error) {
    await persistOperationStateSafely({
      operationId,
      command,
      status: "failed",
      userEmail,
      instanceId,
      lockId,
      error: "Configuration error",
      code: "configuration_error",
    });

    return envResult.error;
  }

  const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase();

  try {
    await persistOperationStateSafely({
      operationId,
      command,
      status: "running",
      userEmail,
      instanceId,
      lockId,
    });

    await executeApiCommand(command, instanceId, userEmail, notificationEmail, args, event.restoreMode);

    await persistOperationStateSafely({
      operationId,
      command,
      status: "completed",
      userEmail,
      instanceId,
      lockId,
    });
  } catch (error) {
    console.error(`[API] Command '${command}' failed:`, error);

    await persistOperationStateSafely({
      operationId,
      command,
      status: "failed",
      userEmail,
      instanceId,
      lockId,
      error: getSanitizedErrorMessage(command),
      code: "lambda_execution_failed",
    });
  } finally {
    await releaseServerActionLockIfOwned(lockId, command);
  }

  return { statusCode: 202, body: `Async command '${command}' accepted` };
}

async function persistOperationStateSafely(input) {
  try {
    await updateOperationState(input);
  } catch (error) {
    console.error("[API] Failed to persist operation state:", error);
  }
}

async function releaseServerActionLockIfOwned(lockId, command) {
  if (!lockId) {
    console.warn(`[API] No lockId provided for '${command}', skipping lock release`);
    return;
  }

  try {
    const lockValue = await getParameter("/minecraft/server-action");
    if (!lockValue) {
      console.log(`[API] No active lock to release for '${command}'`);
      return;
    }

    let lock;
    try {
      lock = JSON.parse(lockValue);
    } catch {
      console.warn(`[API] Lock format invalid for '${command}', removing malformed lock`);
      await deleteParameter("/minecraft/server-action");
      return;
    }

    if (lock.action && lock.action !== command) {
      console.warn(
        `[API] Lock action mismatch for '${command}'. current=${lock.action || "unknown"} provided=${command}`
      );
      return;
    }

    if (lock.lockId !== lockId) {
      console.warn(
        `[API] Lock ownership mismatch for '${command}'. current=${lock.lockId || "unknown"} provided=${lockId}`
      );
      return;
    }

    await deleteParameter("/minecraft/server-action");
    console.log(`[API] Released server-action lock for '${command}'`);
  } catch (error) {
    // Do not fail the entire invocation because lock cleanup failed.
    console.error("[API] Failed to conditionally release server-action lock:", error);
  }
}

/**
 * Execute API command based on command type
 */
async function executeApiCommand(command, instanceId, userEmail, notificationEmail, args, restoreMode) {
  const handlers = {
    start: () => handleStartCommand(instanceId, userEmail, notificationEmail),
    resume: () => handleResumeCommand(instanceId, userEmail, notificationEmail, args, restoreMode),
    backup: () => handleBackup(instanceId, args || [], notificationEmail),
    restore: () => handleRestore(instanceId, args || [], notificationEmail),
    hibernate: () => handleHibernate(instanceId, args || [], notificationEmail),
    refreshBackups: () => handleRefreshBackups(instanceId),
  };

  const handler = handlers[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }

  await handler();
}

/**
 * Handle email invocation from SNS event
 */
async function handleEmailInvocation(event) {
  // Parse email from SNS event
  const emailData = parseEmailFromEvent(event);
  if (emailData.error) return emailData.error;

  // Verify email authenticity (SPF/DKIM) to prevent spoofing
  if (!verifyEmailAuthenticity(emailData.verdicts)) {
    console.warn("Email failed authentication checks - rejecting");
    return { statusCode: 403, body: "Email failed authentication verification." };
  }

  const { senderEmail, subject, body } = emailData;
  const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase();
  const adminEmails = uniqueEmails([process.env.NOTIFICATION_EMAIL, process.env.ADMIN_EMAIL]);
  const isAdmin = adminEmails.includes(senderEmail);

  // Handle admin allowlist updates
  if (isAdmin) {
    const allowlistResult = await handleAllowlistUpdate(senderEmail, body, notificationEmail, adminEmails);
    if (allowlistResult) return allowlistResult;
  }

  // Validate environment (email path requires sender config)
  const envResult = validateEnvironment({ requireVerifiedSender: true });
  if (envResult.error) return envResult.error;

  // Parse and authorize command
  const commandResult = await parseAndAuthorizeCommand(subject, isAdmin, senderEmail);
  if (commandResult.error) return commandResult.error;
  if (!commandResult.command) return { statusCode: 200, body: "No valid command found." };

  // Execute command
  return executeCommand(commandResult.command, envResult.instanceId, senderEmail);
}

/**
 * Verify email authenticity using SES verdicts.
 * Requires SPF and DKIM to pass to prevent email spoofing.
 * @param {Object} verdicts - { spf, dkim, dmarc } verdict statuses
 * @returns {boolean} True if email is authenticated
 */
function verifyEmailAuthenticity(verdicts) {
  if (!verdicts) {
    console.warn("No verdicts available - cannot verify email authenticity");
    return false;
  }

  const spfPass = verdicts.spf === "PASS";
  const dkimPass = verdicts.dkim === "PASS";

  if (!spfPass) console.warn("SPF verification failed:", verdicts.spf);
  if (!dkimPass) console.warn("DKIM verification failed:", verdicts.dkim);
  if (verdicts.dmarc !== "PASS") console.log("DMARC status:", verdicts.dmarc);

  // Require both SPF and DKIM to pass
  return spfPass && dkimPass;
}

async function handleAllowlistUpdate(senderEmail, body, notificationEmail, adminEmails) {
  const emailsInBody = extractEmails(body);
  if (emailsInBody.length === 0) return null;

  console.log(`Admin ${senderEmail} is updating allowlist with emails:`, emailsInBody);
  const baselineAllowlist = getBaselineAllowlist(adminEmails);
  const updatedAllowlist = uniqueEmails([...baselineAllowlist, ...emailsInBody]);
  await updateAllowlist(updatedAllowlist);
  if (notificationEmail) {
    await sendNotification(
      notificationEmail,
      "Minecraft Allowlist Updated",
      `Allowlist updated:\n\n${updatedAllowlist.join("\n")}`
    );
  }
  return { statusCode: 200, body: "Allowlist updated successfully." };
}

function validateEnvironment(options = {}) {
  const { requireVerifiedSender = false } = options;
  const instanceId = process.env.INSTANCE_ID;

  if (!instanceId) {
    console.error("Missing required environment variable: INSTANCE_ID.");
    return { error: { statusCode: 500, body: "Configuration error." } };
  }

  if (requireVerifiedSender && !process.env.VERIFIED_SENDER) {
    console.error("Email command requested but VERIFIED_SENDER is not configured.");
    return {
      error: {
        statusCode: 503,
        body: "Email commands are disabled. Configure VERIFIED_SENDER to enable SES email flows.",
      },
    };
  }

  return { instanceId };
}

async function parseAndAuthorizeCommand(subject, isAdmin, senderEmail) {
  const startKeyword = (process.env.START_KEYWORD || "start").toLowerCase();

  if (isAdmin) {
    const cmd = parseCommand(subject, startKeyword);
    if (!cmd) return { command: null };
    console.log(`Admin executing: ${cmd.command}`);
    return { command: cmd };
  }

  // Non-admin authorization
  const allowlist = await getAllowlist();
  const envAllowlist = getAllowedEmailsFromEnv();
  const effectiveAllowlist = uniqueEmails([...allowlist, ...envAllowlist]);

  if (!effectiveAllowlist.includes(senderEmail)) {
    if (effectiveAllowlist.length === 0) {
      console.log(`Email allowlist empty; denying non-admin sender: ${senderEmail}`);
      return {
        error: { statusCode: 403, body: "Email allowlist is empty. Only admin can trigger commands via email." },
      };
    }

    console.log(`Email ${senderEmail} not in allowlist.`);
    return { error: { statusCode: 403, body: "Email not authorized." } };
  }

  if (!subject.includes(startKeyword)) {
    return { command: null };
  }

  return { command: { command: "start", args: [] } };
}

function uniqueEmails(emails) {
  const output = [];
  const seen = new Set();
  for (const email of emails) {
    const normalized = String(email || "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function getAllowedEmailsFromEnv() {
  return uniqueEmails((process.env.ALLOWED_EMAILS || "").split(","));
}

function getBaselineAllowlist(adminEmails) {
  return uniqueEmails([...(adminEmails || []), ...getAllowedEmailsFromEnv()]);
}

async function executeCommand(parsedCommand, instanceId, senderEmail) {
  const notificationEmail = process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;

  try {
    switch (parsedCommand.command) {
      case "start":
        return await handleStartCommand(instanceId, senderEmail, notificationEmail);
      case "backup":
        return { statusCode: 200, body: await handleBackup(instanceId, parsedCommand.args, notificationEmail) };
      case "restore":
        return {
          statusCode: 200,
          body: await handleRestore(instanceId, parsedCommand.args, notificationEmail),
        };
      case "hibernate":
        return { statusCode: 200, body: await handleHibernate(instanceId, parsedCommand.args, notificationEmail) };
      case "resume":
        return await handleResumeCommand(instanceId, senderEmail, notificationEmail, parsedCommand.args);
      default:
        return { statusCode: 400, body: `Unknown command: ${parsedCommand.command}` };
    }
  } catch (error) {
    console.error("ERROR executing command:", error.message);
    if (notificationEmail) {
      await sendNotification(
        notificationEmail,
        "Minecraft Command Failed",
        getSanitizedErrorMessage(parsedCommand.command)
      );
    }
    return { statusCode: 500, body: `Failed to process request: ${error.message}` };
  }
}

async function handleStartCommand(instanceId, senderEmail, _notificationEmail) {
  console.log(`Starting instance ${instanceId} triggered by ${senderEmail}`);

  // Store sender email in SSM for EC2 to include in consolidated notification
  if (senderEmail) {
    await putParameter("/minecraft/startup-triggered-by", senderEmail, "String");
  }

  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);

  // Email notification now sent by EC2 after DNS update (consolidated)

  return { statusCode: 200, body: `Instance started at IP: ${publicIp}` };
}

async function handleResumeCommand(instanceId, senderEmail, notificationEmail, args, restoreMode) {
  console.log(`Resuming instance ${instanceId} triggered by ${senderEmail}`);

  // Store sender email in SSM for EC2 to include in consolidated notification
  if (senderEmail) {
    await putParameter("/minecraft/startup-triggered-by", senderEmail, "String");
  }

  const restoreStrategy = resolveResumeRestoreStrategy({
    args,
    restoreMode,
  });

  console.log(`[RESUME] Restore strategy selected: ${restoreStrategy.mode}`);

  await handleResume(instanceId);
  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);
  const resumeCommandByMode = {
    fresh: "/usr/local/bin/mc-resume.sh fresh",
    latest: "/usr/local/bin/mc-resume.sh latest",
    named: `/usr/local/bin/mc-resume.sh named ${restoreStrategy.backupArchiveName}`,
  };
  const resumeCommand = resumeCommandByMode[restoreStrategy.mode];
  const resumeOutput = await executeSSMCommand(instanceId, [resumeCommand]);

  let restoreMsg = "\n\nFresh world requested (no backup restore).";
  if (restoreStrategy.mode === "latest") {
    restoreMsg = "\n\nRestored from latest backup.";
  }

  if (restoreStrategy.mode === "named") {
    restoreMsg = `\n\nRestored from backup: ${restoreStrategy.backupArchiveName}`;
  }

  if (notificationEmail) {
    await sendNotification(
      notificationEmail,
      "Minecraft Server Resumed",
      `Resumed at IP: ${publicIp}\n\n${resumeOutput}${restoreMsg}`
    );
  }

  return { statusCode: 200, body: `Instance resumed at IP: ${publicIp}${restoreMsg}` };
}
