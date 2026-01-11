import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";

// Instantiate clients without hardcoding region (SDK will infer based on the env)
// v2 - email parsing fix
const ec2 = new EC2Client({});
const ses = new SESClient({});
const ssm = new SSMClient({});

// Max attempts to get IP (e.g., 300 attempts * 1s = 5 minutes)
const MAX_POLL_ATTEMPTS = 300;
// Wait 1 second between polls
const POLL_INTERVAL_MS = 1000;

/**
 * Check if instance is running, start it if stopped, and wait for running state
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
async function ensureInstanceRunning(instanceId) {
  console.log(`Checking instance state for ${instanceId}...`);

  // Get current instance state
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));

  if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = Reservations[0].Instances[0];
  const currentState = instance.State?.Name;

  console.log(`Current instance state: ${currentState}`);

  // If already running, no action needed
  if (currentState === "running") {
    console.log(`Instance ${instanceId} is already running`);
    return;
  }

  // If stopped, start it
  if (currentState === "stopped") {
    console.log(`Instance ${instanceId} is stopped. Starting it...`);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(`Start command sent for instance ${instanceId}`);
  } else if (currentState === "stopping" || currentState === "pending") {
    console.log(`Instance ${instanceId} is in state ${currentState}. Waiting for stable state...`);
  } else {
    throw new Error(`Instance ${instanceId} is in unexpected state: ${currentState}`);
  }

  // Wait for instance to reach running state
  console.log(`Waiting for instance ${instanceId} to reach running state...`);
  let running = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 * 5 seconds = 5 minutes

  while (!running && attempts < maxAttempts) {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

    try {
      const { Reservations: updatedReservations } = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );

      const updatedInstance = updatedReservations?.[0]?.Instances?.[0];
      const state = updatedInstance?.State?.Name;

      console.log(`Instance state: ${state} (attempt ${attempts}/${maxAttempts})`);

      if (state === "running") {
        running = true;
        console.log(`Instance ${instanceId} is now running`);
      }
    } catch (error) {
      console.error(`Error checking instance state on attempt ${attempts}:`, error);
    }
  }

  if (!running) {
    throw new Error(`Instance ${instanceId} did not reach running state within timeout`);
  }
}

/**
 * Get the public IP address of an EC2 instance
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The public IP address
 */
async function getPublicIp(instanceId) {
  console.log(`Polling for public IP address for instance: ${instanceId}`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(`Polling attempt ${attempt}/${MAX_POLL_ATTEMPTS}...`);

    const result = await pollInstanceForIp(instanceId, attempt);
    if (result.ip) return result.ip;
    if (result.error) throw result.error;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`Failed to obtain public IP for instance ${instanceId} after ${MAX_POLL_ATTEMPTS} attempts.`);
  throw new Error("Timed out waiting for public IP address.");
}

async function pollInstanceForIp(instanceId, attempt) {
  try {
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));

    if (!Reservations?.length || !Reservations[0].Instances?.length) {
      console.warn(`DescribeInstances response structure unexpected or empty for instance ${instanceId}.`);
      return {};
    }

    const inst = Reservations[0].Instances[0];
    const publicIp = inst.PublicIpAddress;
    const instanceState = inst.State?.Name;

    console.log(`Instance state: ${instanceState}, Public IP: ${publicIp}`);

    if (publicIp) {
      console.log(`Public IP found: ${publicIp}`);
      return { ip: publicIp };
    }

    if (["stopping", "stopped", "terminated", "shutting-down"].includes(instanceState)) {
      console.error(`Instance ${instanceId} entered unexpected state ${instanceState} while waiting for IP.`);
      return { error: new Error(`Instance entered unexpected state: ${instanceState}`) };
    }

    return {};
  } catch (describeError) {
    console.error(`Error describing instance ${instanceId} on attempt ${attempt}:`, describeError);
    if (attempt >= MAX_POLL_ATTEMPTS) {
      return { error: new Error(`Failed to describe instance after ${attempt} attempts: ${describeError.message}`) };
    }
    return {};
  }
}

/**
 * Update Cloudflare DNS A record with the provided IP address
 * @param {string} zone - Cloudflare zone ID
 * @param {string} record - Cloudflare record ID
 * @param {string} ip - The IP address to set
 * @param {string} domain - The domain name
 * @param {string} cfToken - Cloudflare API token
 * @returns {Promise<void>}
 */
async function updateCloudflareDns(zone, record, ip, domain, cfToken) {
  console.log(`Updating Cloudflare DNS record ${record} in zone ${zone} for domain ${domain} to IP ${ip}`);
  const cfUrl = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record}`;
  const cfPayload = {
    type: "A",
    name: domain,
    content: ip,
    ttl: 60, // Consider making TTL configurable via env var
    proxied: false,
  };

  try {
    const response = await fetch(cfUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cfPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Cloudflare API error: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`Failed to update Cloudflare DNS record. Status: ${response.status}`);
    }
    console.log("Successfully updated Cloudflare DNS record.");
  } catch (fetchError) {
    console.error("Error updating Cloudflare DNS:", fetchError);
    throw fetchError; // Re-throw to be caught by the outer try-catch
  }
}

/**
 * Generate a sanitized error message for email notification
 * @param {string} commandName - The command that failed (e.g., "start", "backup", "restore")
 * @returns {string} Sanitized error message
 */
function getSanitizedErrorMessage(commandName) {
  const errorMessages = {
    start: "Server startup failed. Check CloudWatch logs for details.",
    backup: "Backup command failed. Check CloudWatch logs for details.",
    restore: "Restore command failed. Check CloudWatch logs for details.",
    hibernate: "Hibernation command failed. Check CloudWatch logs for details.",
    resume: "Resume command failed. Check CloudWatch logs for details.",
    unknown: "Command execution failed. Check CloudWatch logs for details.",
  };

  return errorMessages[commandName] || errorMessages.unknown;
}

/**
 * Send notification email via SES
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @returns {Promise<void>}
 */
async function sendNotification(to, subject, body) {
  const emailParams = {
    Source: process.env.VERIFIED_SENDER, // e.g. "noreply@mydomain.org"
    Destination: {
      ToAddresses: [to], // must be verified if in sandbox
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: body },
      },
    },
  };

  try {
    await ses.send(new SendEmailCommand(emailParams));
    console.log("Successfully sent notification email.");
  } catch (emailError) {
    console.error("Error sending email via SES:", emailError);
    // Log the error but don't necessarily fail the whole function,
    // as the server is up and DNS is updated. Maybe send alert to admin?
  }
}

/**
 * Get email allowlist from SSM Parameter Store
 * @returns {Promise<string[]>} Array of allowed email addresses
 */
async function getAllowlist() {
  try {
    const response = await ssm.send(
      new GetParameterCommand({
        Name: "/minecraft/email-allowlist",
      })
    );
    const emails = response.Parameter?.Value || "";
    return emails
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  } catch (error) {
    if (error.name === "ParameterNotFound") {
      console.log("No allowlist found in SSM. Returning empty list.");
      return [];
    }
    throw error;
  }
}

/**
 * Update email allowlist in SSM Parameter Store
 * @param {string[]} emails - Array of email addresses to allow
 * @returns {Promise<void>}
 */
async function updateAllowlist(emails) {
  const value = emails.join(",");
  await ssm.send(
    new PutParameterCommand({
      Name: "/minecraft/email-allowlist",
      Value: value,
      Type: "String",
      Overwrite: true,
    })
  );
  console.log(`Updated allowlist with ${emails.length} emails:`, emails);
}

/**
 * Extract email addresses from text
 * @param {string} text - Text to parse for emails
 * @returns {string[]} Array of email addresses found
 */
function extractEmails(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return matches.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * Parse command from email subject
 * @param {string} subject - Email subject line
 * @param {string} startKeyword - The start keyword to check for
 * @returns {Object|null} { command, args } or null if no valid command
 */
function parseCommand(subject, startKeyword) {
  const lowerSubject = subject.toLowerCase();

  // Check for start command
  if (lowerSubject.includes(startKeyword.toLowerCase())) {
    return { command: "start", args: [] };
  }

  // Check for backup command (optional: backup name)
  if (lowerSubject.includes("backup")) {
    const match = lowerSubject.match(/backup\s+(\S+)?/);
    const args = match?.[1] ? [match[1]] : [];
    return { command: "backup", args };
  }

  // Check for restore command (required: restore name)
  if (lowerSubject.includes("restore")) {
    const match = lowerSubject.match(/restore\s+(\S+)/);
    if (!match || !match[1]) {
      console.warn("Restore command requires a backup name argument");
      return null;
    }
    return { command: "restore", args: [match[1]] };
  }

  // Check for hibernate command
  if (lowerSubject.includes("hibernate")) {
    return { command: "hibernate", args: [] };
  }

  // Check for resume command
  if (lowerSubject.includes("resume")) {
    return { command: "resume", args: [] };
  }

  return null;
}

/**
 * Execute an SSM command on an EC2 instance and wait for completion
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} commands - Array of commands to execute
 * @returns {Promise<string>} The command output
 */
async function executeSSMCommand(instanceId, commands) {
  console.log(`Executing SSM command on instance ${instanceId}: ${commands.join(" ")}`);

  const sendResponse = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands },
    })
  );

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) throw new Error("Failed to get command ID from SSM response");

  console.log(`SSM command sent with ID: ${commandId}`);
  return await waitForSSMCompletion(commandId, instanceId);
}

async function waitForSSMCompletion(commandId, instanceId) {
  const maxAttempts = 60;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const response = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = response.Status;

      console.log(`Poll attempt ${attempt}/${maxAttempts} - Command status: ${status}`);

      if (status === "Success") return response.StandardOutputContent || "";
      if (status === "Failed") {
        const errorOutput = response.StandardErrorContent || "";
        console.error(`SSM command failed. Error output: ${errorOutput}`);
        throw new Error(`SSM command failed: ${errorOutput}`);
      }
    } catch (error) {
      if (error.name !== "InvocationDoesNotExist") throw error;
      console.log(`Poll attempt ${attempt}/${maxAttempts}: Command still processing...`);
    }
  }

  throw new Error(`SSM command did not complete within ${maxAttempts * 2} seconds`);
}

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

    const backupName = args?.[0] ? args[0] : "";
    const command = backupName ? `/usr/local/bin/mc-backup.sh ${backupName}` : "/usr/local/bin/mc-backup.sh";

    console.log("Step 2: Executing backup command...");
    const output = await executeSSMCommand(instanceId, [command]);
    console.log("Step 2 complete: Backup command executed");

    const message = `Backup completed successfully${backupName ? ` (${backupName})` : ""}.\n\nOutput:\n${output}`;

    if (adminEmail) {
      console.log("Step 3: Sending notification email...");
      await sendNotification(adminEmail, "Minecraft Backup Completed", message);
      console.log("Step 3 complete: Notification sent");
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

/**
 * Handle restore command - runs restore script via SSM and updates DNS
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (required backup name)
 * @param {string} adminEmail - Admin email for notifications
 * @param {Object} cloudflareConfig - Cloudflare configuration { zone, record, domain, cfToken }
 * @returns {Promise<string>} The restore result message
 */
async function handleRestore(instanceId, args, adminEmail, cloudflareConfig) {
  console.log(
    `Handling restore command for instance ${instanceId} with args:`,
    JSON.stringify(args),
    "adminEmail:",
    adminEmail
  );

  if (!args || !args[0]) {
    console.error("ERROR in handleRestore: Restore command requires a backup name argument");
    throw new Error("Restore command requires a backup name argument");
  }

  try {
    // Ensure instance is running before attempting SSM command
    console.log("Step 1: Ensuring instance is running...");
    await ensureInstanceRunning(instanceId);
    console.log("Step 1 complete: Instance is running");

    const backupName = args[0];
    const command = `/usr/local/bin/mc-restore.sh ${backupName}`;

    console.log("Step 2: Executing restore command for backup:", backupName);
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

    const message = `Restore completed successfully (${backupName}).${publicIp ? `\nDNS updated to ${publicIp}` : ""}\n\nOutput:\n${output}`;

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

/**
 * Handle hibernate command - runs backup, stops instance, detaches/deletes volume
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (unused)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The hibernate result message
 */
async function handleHibernate(instanceId, _args, adminEmail) {
  console.log(`Handling hibernate command for instance ${instanceId}`);

  try {
    console.log("Step 1: Running backup before hibernation...");
    const backupOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-backup.sh"]);

    console.log("Step 2: Stopping instance...");
    await stopInstanceAndWait(instanceId);

    console.log("Step 3: Detaching and deleting volumes...");
    await detachAndDeleteVolumes(instanceId);

    const message = `Hibernation completed successfully.\n\nBackup output:\n${backupOutput}`;
    if (adminEmail) await sendNotification(adminEmail, "Minecraft Server Hibernated", message);

    return message;
  } catch (error) {
    console.error("ERROR in handleHibernate:", error.message);
    if (adminEmail)
      await sendNotification(adminEmail, "Minecraft Hibernation Failed", getSanitizedErrorMessage("hibernate"));
    throw error;
  }
}

async function stopInstanceAndWait(instanceId) {
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  console.log("Stop command sent, waiting for instance to stop...");

  for (let attempt = 1; attempt <= 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = Reservations?.[0]?.Instances?.[0]?.State?.Name;

    console.log(`Instance state poll (attempt ${attempt}/60): ${state}`);
    if (state === "stopped") {
      console.log(`Instance ${instanceId} is now stopped`);
      return;
    }
  }
  throw new Error(`Instance ${instanceId} did not stop within timeout`);
}

async function detachAndDeleteVolumes(instanceId) {
  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const blockDeviceMappings = Reservations?.[0]?.Instances?.[0]?.BlockDeviceMappings || [];

  for (const mapping of blockDeviceMappings) {
    const volumeId = mapping.Ebs?.VolumeId;
    if (!volumeId) continue;

    await detachVolume(volumeId);
    await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    console.log(`Volume ${volumeId} deleted successfully`);
  }
}

async function detachVolume(volumeId) {
  console.log(`Detaching volume ${volumeId}...`);
  await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId }));

  for (let attempt = 1; attempt <= 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const attachmentState = response.Volumes?.[0]?.Attachments?.[0]?.State;

    if (!attachmentState || attachmentState === "detached") {
      console.log(`Volume ${volumeId} is now detached`);
      return;
    }
  }
  throw new Error(`Volume ${volumeId} did not detach within timeout`);
}

/**
 * Handle resuming a hibernated instance by creating and attaching a root volume
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
async function handleResume(instanceId) {
  console.log(`Checking if instance ${instanceId} needs volume restoration...`);

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  if (!Reservations?.length || !Reservations[0].Instances?.length) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = Reservations[0].Instances[0];
  if ((instance.BlockDeviceMappings || []).length > 0) {
    console.log(`Instance ${instanceId} already has volumes. Skipping resume.`);
    return;
  }

  console.log(`Instance ${instanceId} has no volumes. Proceeding with hibernation recovery...`);

  const az = instance.Placement?.AvailabilityZone;
  if (!az) throw new Error(`Could not determine availability zone for instance ${instanceId}`);

  const snapshotId = await findLatestAL2023Snapshot();
  const volumeId = await createAndAttachVolume(instanceId, az, snapshotId);

  console.log(`Successfully restored volume ${volumeId} for instance ${instanceId}`);
}

async function findLatestAL2023Snapshot() {
  console.log("Looking up Amazon Linux 2023 ARM64 AMI...");
  const response = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023*-arm64"] },
        { Name: "state", Values: ["available"] },
      ],
    })
  );

  if (!response.Images?.length) throw new Error("Could not find Amazon Linux 2023 ARM64 AMI");

  const sortedImages = response.Images.sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate));
  const snapshotId = sortedImages[0].BlockDeviceMappings?.[0]?.Ebs?.SnapshotId;

  if (!snapshotId) throw new Error(`Could not find snapshot for AMI ${sortedImages[0].ImageId}`);
  console.log(`Using snapshot: ${snapshotId}`);
  return snapshotId;
}

async function createAndAttachVolume(instanceId, az, snapshotId) {
  console.log("Creating new 8GB GP3 volume from snapshot...");
  const createResponse = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: az,
      SnapshotId: snapshotId,
      VolumeType: "gp3",
      Size: 8,
      Encrypted: true,
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Name", Value: "MinecraftServerVolume" },
            { Key: "Backup", Value: "weekly" },
          ],
        },
      ],
    })
  );

  const volumeId = createResponse.VolumeId;
  if (!volumeId) throw new Error("Failed to create volume");

  await waitForVolumeAvailable(volumeId);
  await attachVolumeToInstance(volumeId, instanceId);

  return volumeId;
}

async function waitForVolumeAvailable(volumeId) {
  console.log("Waiting for volume to become available...");
  for (let attempt = 1; attempt <= 60; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    if (response.Volumes?.[0]?.State === "available") {
      console.log(`Volume ${volumeId} is now available`);
      return;
    }
    console.log(`Volume state: ${response.Volumes?.[0]?.State}. Waiting... (attempt ${attempt}/60)`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Volume ${volumeId} did not become available within timeout`);
}

async function attachVolumeToInstance(volumeId, instanceId) {
  console.log(`Attaching volume ${volumeId} to instance ${instanceId} at /dev/xvda...`);
  await ec2.send(new AttachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId, Device: "/dev/xvda" }));

  console.log("Waiting for volume attachment to complete...");
  for (let attempt = 1; attempt <= 60; attempt++) {
    const response = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    if (response.Volumes?.[0]?.Attachments?.[0]?.State === "attached") {
      console.log(`Volume ${volumeId} is now attached`);
      return;
    }
    console.log(
      `Attachment state: ${response.Volumes?.[0]?.Attachments?.[0]?.State}. Waiting... (attempt ${attempt}/60)`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
}

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

function parseEmailFromEvent(event) {
  try {
    if (!event.Records?.[0]?.Sns?.Message) {
      return { error: { statusCode: 400, body: "Invalid event structure." } };
    }

    const payload = JSON.parse(event.Records[0].Sns.Message);
    const toAddr = payload.mail?.commonHeaders?.from?.[0];
    if (!toAddr) return { error: { statusCode: 400, body: "Sender address missing." } };

    const emailMatch = toAddr.match(/<([^>]+)>/) || [null, toAddr];
    const senderEmail = (emailMatch[1] || toAddr).trim().toLowerCase();
    const subject = (payload.mail?.commonHeaders?.subject || "").toLowerCase();
    const body = payload.content ? Buffer.from(payload.content, "base64").toString("utf8").toLowerCase() : "";

    console.log("Parsed email - From:", senderEmail, "Subject:", subject);
    return { senderEmail, subject, body };
  } catch (error) {
    console.error("ERROR parsing email:", error.message);
    return { error: { statusCode: 400, body: "Error processing incoming message." } };
  }
}

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
