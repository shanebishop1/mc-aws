// AWS SDK clients and commands
import { StartInstancesCommand, ec2 } from "./clients.js";

// EC2 operations
import { getPublicIp } from "./ec2.js";

// Cloudflare DNS
import { updateCloudflareDns } from "./cloudflare.js";

// Notifications
import { getSanitizedErrorMessage, sendNotification } from "./notifications.js";

// SSM command execution
import { executeSSMCommand } from "./ssm.js";

// Allowlist management
import { extractEmails, getAllowlist, updateAllowlist } from "./allowlist.js";

// Parsers
import { parseCommand } from "./command-parser.js";
import { parseEmailFromEvent } from "./email-parser.js";

// Command handlers
import { handleBackup } from "./handlers/backup.js";
import { handleHibernate } from "./handlers/hibernate.js";
import { handleRestore } from "./handlers/restore.js";
import { handleResume } from "./handlers/resume.js";

export const handler = async (event) => {
  console.log("=== LAMBDA INVOKED ===");

  // Parse email from SNS event
  const emailData = parseEmailFromEvent(event);
  if (emailData.error) return emailData.error;

  const { senderEmail, subject, body } = emailData;
  const adminEmail = (process.env.NOTIFICATION_EMAIL || "").toLowerCase();
  const isAdmin = adminEmail && senderEmail === adminEmail;

  // Handle admin allowlist updates
  if (isAdmin) {
    const allowlistResult = await handleAllowlistUpdate(senderEmail, body, adminEmail);
    if (allowlistResult) return allowlistResult;
  }

  // Validate environment
  const envResult = validateEnvironment();
  if (envResult.error) return envResult.error;
  const { instanceId, zone, record, domain, cfToken } = envResult;

  // Parse and authorize command
  const commandResult = await parseAndAuthorizeCommand(subject, isAdmin, senderEmail);
  if (commandResult.error) return commandResult.error;
  if (!commandResult.command) return { statusCode: 200, body: "No valid command found." };

  // Execute command
  return executeCommand(commandResult.command, instanceId, senderEmail, { zone, record, domain, cfToken });
};

async function handleAllowlistUpdate(senderEmail, body, adminEmail) {
  const emailsInBody = extractEmails(body);
  if (emailsInBody.length === 0) return null;

  console.log(`Admin ${senderEmail} is updating allowlist with emails:`, emailsInBody);
  await updateAllowlist(emailsInBody);
  await sendNotification(adminEmail, "Minecraft Allowlist Updated", `Allowlist updated:\n\n${emailsInBody.join("\n")}`);
  return { statusCode: 200, body: "Allowlist updated successfully." };
}

function validateEnvironment() {
  const instanceId = process.env.INSTANCE_ID;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const record = process.env.CLOUDFLARE_RECORD_ID;
  const domain = process.env.CLOUDFLARE_MC_DOMAIN;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;

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
  if (allowlist.length > 0 && !allowlist.includes(senderEmail)) {
    console.log(`Email ${senderEmail} not in allowlist.`);
    return { error: { statusCode: 403, body: "Email not authorized." } };
  }

  if (!subject.includes(startKeyword)) {
    return { command: null };
  }

  return { command: { command: "start", args: [] } };
}

async function executeCommand(parsedCommand, instanceId, senderEmail, cloudflareConfig) {
  const notificationEmail = process.env.NOTIFICATION_EMAIL;

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
  }
}

async function handleStartCommand(instanceId, senderEmail, notificationEmail, { zone, record, domain, cfToken }) {
  console.log(`Starting instance ${instanceId} triggered by ${senderEmail}`);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Startup", `Startup triggered by: ${senderEmail}`);
  }

  await handleResume(instanceId);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  const publicIp = await getPublicIp(instanceId);
  await updateCloudflareDns(zone, record, publicIp, domain, cfToken);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Server Started", `Server started, DNS updated to ${publicIp}`);
  }

  return { statusCode: 200, body: `Instance started, DNS updated to ${publicIp}` };
}

async function handleResumeCommand(instanceId, senderEmail, notificationEmail, { zone, record, domain, cfToken }) {
  console.log(`Resuming instance ${instanceId} triggered by ${senderEmail}`);

  if (notificationEmail) {
    await sendNotification(notificationEmail, "Minecraft Resume", `Resume triggered by: ${senderEmail}`);
  }

  await handleResume(instanceId);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  const publicIp = await getPublicIp(instanceId);
  const resumeOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-resume.sh"]);
  await updateCloudflareDns(zone, record, publicIp, domain, cfToken);

  if (notificationEmail) {
    await sendNotification(
      notificationEmail,
      "Minecraft Server Resumed",
      `Resumed, DNS: ${publicIp}\n\n${resumeOutput}`
    );
  }

  return { statusCode: 200, body: `Instance resumed, DNS updated to ${publicIp}` };
}
