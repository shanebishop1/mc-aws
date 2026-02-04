// AWS SDK clients and commands
// EC2 operations
import { ensureInstanceRunning, getPublicIp } from "./ec2.js";

// Cloudflare DNS
import { updateCloudflareDns } from "./cloudflare.js";

// Notifications
import { getSanitizedErrorMessage, sendNotification } from "./notifications.js";

// SSM command execution
import { deleteParameter, executeSSMCommand } from "./ssm.js";

// Allowlist management
import { extractEmails, getAllowlist, updateAllowlist } from "./allowlist.js";

// Parsers
import { parseCommand } from "./command-parser.js";
import { parseEmailFromEvent } from "./email-parser.js";

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
  const { instanceId, userEmail, command, args } = event;
  console.log(`[API] Async command '${command}' triggered by ${userEmail}`);

  if (!instanceId || !userEmail || !command) {
    console.error("[API] Invalid API payload:", event);
    return { statusCode: 400, body: "Invalid payload" };
  }

  const envResult = validateEnvironment();
  if (envResult.error) return envResult.error;

  const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase();
  const cloudflareConfig = createCloudflareConfig(envResult);

  try {
    await executeApiCommand(command, instanceId, userEmail, notificationEmail, cloudflareConfig, args);
  } catch (error) {
    console.error(`[API] Command '${command}' failed:`, error);
  } finally {
    console.log("[API] Clearing server-action lock...");
    try {
      await deleteParameter("/minecraft/server-action");
    } catch (error) {
      // Do not fail the entire invocation because the lock couldn't be cleared.
      console.error("[API] Failed to clear server-action lock:", error);
    }
  }

  return { statusCode: 202, body: `Async command '${command}' accepted` };
}

/**
 * Execute API command based on command type
 */
async function executeApiCommand(command, instanceId, userEmail, notificationEmail, cloudflareConfig, args) {
  const handlers = {
    start: () => handleStartCommand(instanceId, userEmail, notificationEmail, cloudflareConfig),
    resume: () => handleResumeCommand(instanceId, userEmail, notificationEmail, cloudflareConfig, args),
    backup: () => handleBackup(instanceId, args || [], notificationEmail),
    restore: () => handleRestore(instanceId, args || [], notificationEmail, cloudflareConfig),
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
 * Create Cloudflare config from environment result
 */
function createCloudflareConfig(envResult) {
  return {
    zone: envResult.zone,
    record: envResult.record,
    domain: envResult.domain,
    cfToken: envResult.cfToken,
  };
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

  // Validate environment
  const envResult = validateEnvironment();
  if (envResult.error) return envResult.error;

  // Parse and authorize command
  const commandResult = await parseAndAuthorizeCommand(subject, isAdmin, senderEmail);
  if (commandResult.error) return commandResult.error;
  if (!commandResult.command) return { statusCode: 200, body: "No valid command found." };

  // Execute command
  const cloudflareConfig = createCloudflareConfig(envResult);
  return executeCommand(commandResult.command, envResult.instanceId, senderEmail, cloudflareConfig);
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

function validateEnvironment() {
  const instanceId = process.env.INSTANCE_ID;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const record = process.env.CLOUDFLARE_RECORD_ID;
  const domain = process.env.CLOUDFLARE_MC_DOMAIN;
  const cfToken = process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

  if (!instanceId || !process.env.VERIFIED_SENDER || !zone || !record || !domain || !cfToken) {
    console.error("Missing required environment variables.");
    return { error: { statusCode: 500, body: "Configuration error." } };
  }
  return { instanceId, zone, record, domain, cfToken };
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

async function executeCommand(parsedCommand, instanceId, senderEmail, cloudflareConfig) {
  const notificationEmail = process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL;

  try {
    switch (parsedCommand.command) {
      case "start":
        return await handleStartCommand(instanceId, senderEmail, notificationEmail, cloudflareConfig);
      case "backup":
        return { statusCode: 200, body: await handleBackup(instanceId, parsedCommand.args, notificationEmail) };
      case "restore":
        return {
          statusCode: 200,
          body: await handleRestore(instanceId, parsedCommand.args, notificationEmail, cloudflareConfig),
        };
      case "hibernate":
        return { statusCode: 200, body: await handleHibernate(instanceId, parsedCommand.args, notificationEmail) };
      case "resume":
        return await handleResumeCommand(instanceId, senderEmail, notificationEmail, cloudflareConfig);
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
  } finally {
    // Always release the lock, regardless of success or failure
    try {
      await deleteParameter("/minecraft/server-action");
    } catch (e) {
      // Don't fail if the parameter doesn't exist (might not have been set)
      if (e.name !== "ParameterNotFound") {
        console.error("Failed to release server action lock:", e.message);
      }
    }
  }
}

async function handleStartCommand(instanceId, senderEmail, notificationEmail, { zone, record, domain, cfToken }) {
  console.log(`Starting instance ${instanceId} triggered by ${senderEmail}`);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Startup", `Startup triggered by: ${senderEmail}`);
  }

  await handleResume(instanceId);
  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);
  await updateCloudflareDns(zone, record, publicIp, domain, cfToken);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Server Started", `Server started, DNS updated to ${publicIp}`);
  }

  return { statusCode: 200, body: `Instance started, DNS updated to ${publicIp}` };
}

async function handleResumeCommand(
  instanceId,
  senderEmail,
  notificationEmail,
  { zone, record, domain, cfToken },
  args
) {
  console.log(`Resuming instance ${instanceId} triggered by ${senderEmail}`);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Resume", `Resume triggered by: ${senderEmail}`);
  }

  await handleResume(instanceId);
  await ensureInstanceRunning(instanceId);
  const publicIp = await getPublicIp(instanceId);
  const resumeOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-resume.sh"]);
  await updateCloudflareDns(zone, record, publicIp, domain, cfToken);

  let restoreMsg = "";
  if (args && args.length > 0) {
    console.log(`[RESUME] Restore requested with args: ${args.join(" ")}`);
    try {
      // Helper to run restore which handles its own DNS update and notifications
      await handleRestore(instanceId, args, notificationEmail, { zone, record, domain, cfToken });
      restoreMsg = `\n\nRestored from backup: ${args[0]}`;
    } catch (e) {
      console.error("Resume succeeded but restore failed:", e);
      restoreMsg = `\n\nWARNING: Restore failed: ${e.message}`;
    }
  }

  if (notificationEmail) {
    await sendNotification(
      notificationEmail,
      "Minecraft Server Resumed",
      `Resumed, DNS: ${publicIp}\n\n${resumeOutput}${restoreMsg}`
    );
  }

  return { statusCode: 200, body: `Instance resumed, DNS updated to ${publicIp}${restoreMsg}` };
}
