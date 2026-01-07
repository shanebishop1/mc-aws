import { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand, DescribeImagesCommand, CreateVolumeCommand, AttachVolumeCommand, DescribeVolumesCommand, DetachVolumeCommand, DeleteVolumeCommand } from "@aws-sdk/client-ec2";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SSMClient, GetParameterCommand, PutParameterCommand, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";

// Instantiate clients without hardcoding region (SDK will infer based on the env)
const ec2 = new EC2Client({});
const ses = new SESClient({});
const ssm = new SSMClient({});

// Max attempts to get IP (e.g., 300 attempts * 1s = 5 minutes)
const MAX_POLL_ATTEMPTS = 300;
// Wait 1 second between polls
const POLL_INTERVAL_MS = 1000;

/**
 * Get the public IP address of an EC2 instance
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<string>} The public IP address
 */
async function getPublicIp(instanceId) {
  let publicIp = null;
  let attempts = 0;
  
  console.log(`Polling for public IP address for instance: ${instanceId}`);
  while (!publicIp && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    console.log(`Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}...`);
    try {
      const { Reservations } = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );
      // Basic validation: Check if Reservations and Instances exist
      if (Reservations && Reservations.length > 0 && Reservations[0].Instances && Reservations[0].Instances.length > 0) {
        const inst = Reservations[0].Instances[0];
        publicIp = inst.PublicIpAddress;
        const instanceState = inst.State?.Name;
        console.log(`Instance state: ${instanceState}, Public IP: ${publicIp}`);
        if (publicIp) {
          console.log(`Public IP found: ${publicIp}`);
          return publicIp; // Exit function if IP is found
        }
        // Optional: Check if instance entered a failed state (stopping, stopped, terminated)
        if (['stopping', 'stopped', 'terminated', 'shutting-down'].includes(instanceState)) {
           console.error(`Instance ${instanceId} entered unexpected state ${instanceState} while waiting for IP. Aborting.`);
           throw new Error(`Instance entered unexpected state: ${instanceState}`);
        }
      } else {
        console.warn(`DescribeInstances response structure unexpected or empty for instance ${instanceId}.`);
      }
    } catch (describeError) {
      console.error(`Error describing instance ${instanceId} on attempt ${attempts}:`, describeError);
      // Decide if the error is fatal or if polling should continue
      if (attempts >= MAX_POLL_ATTEMPTS) {
        throw new Error(`Failed to describe instance after ${attempts} attempts: ${describeError.message}`);
      }
      // Continue polling after logging the error for transient issues
    }

    if (!publicIp) {
      // Wait before the next poll attempt
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  
  if (!publicIp) {
    console.error(`Failed to obtain public IP for instance ${instanceId} after ${attempts} attempts.`);
    throw new Error("Timed out waiting for public IP address.");
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
    proxied: false
  };

  try {
    const response = await fetch(cfUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${cfToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cfPayload)
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
 * Send notification email via SES
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @returns {Promise<void>}
 */
async function sendNotification(to, subject, body) {
  const emailParams = {
    Source: process.env.VERIFIED_SENDER,  // e.g. "noreply@mydomain.org"
    Destination: {
      ToAddresses: [to]  // must be verified if in sandbox
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: body }
      }
    }
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
    const response = await ssm.send(new GetParameterCommand({
      Name: "/minecraft/email-allowlist"
    }));
    const emails = response.Parameter?.Value || "";
    return emails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  } catch (error) {
    if (error.name === 'ParameterNotFound') {
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
  const value = emails.join(',');
  await ssm.send(new PutParameterCommand({
    Name: "/minecraft/email-allowlist",
    Value: value,
    Type: "String",
    Overwrite: true
  }));
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
  return matches.map(e => e.trim().toLowerCase()).filter(Boolean);
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
      const args = match && match[1] ? [match[1]] : [];
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
  console.log(`Executing SSM command on instance ${instanceId}: ${commands.join(' ')}`);
  
  try {
    // Send the command
    const sendResponse = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        command: commands
      }
    }));
    
    const commandId = sendResponse.Command?.CommandId;
    if (!commandId) {
      throw new Error("Failed to get command ID from SSM response");
    }
    
    console.log(`SSM command sent with ID: ${commandId}`);
    
    // Wait for command completion (poll every 2 seconds, max 60 attempts = 2 minutes)
    let completed = false;
    let attempts = 0;
    const maxAttempts = 60;
    let output = "";
    
    while (!completed && attempts < maxAttempts) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      
      try {
        const invocationResponse = await ssm.send(new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId
        }));
        
        const status = invocationResponse.Status;
        console.log(`Command status (attempt ${attempts}/${maxAttempts}): ${status}`);
        
        if (status === "Success" || status === "Failed") {
          completed = true;
          output = invocationResponse.StandardOutputContent || "";
          
          if (status === "Failed") {
            const errorOutput = invocationResponse.StandardErrorContent || "";
            console.error(`SSM command failed. Error: ${errorOutput}`);
            throw new Error(`SSM command failed: ${errorOutput}`);
          }
        }
      } catch (error) {
        if (error.name === "InvocationDoesNotExist") {
          // Command still processing, continue polling
          console.log("Command still processing...");
        } else {
          throw error;
        }
      }
    }
    
    if (!completed) {
      throw new Error(`SSM command did not complete within ${maxAttempts * 2} seconds`);
    }
    
    console.log(`SSM command completed successfully. Output: ${output}`);
    return output;
  } catch (error) {
    console.error("Error executing SSM command:", error);
    throw error;
  }
}

/**
 * Handle backup command - runs backup script via SSM
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (optional backup name)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The backup result message
 */
async function handleBackup(instanceId, args, adminEmail) {
  console.log(`Handling backup command for instance ${instanceId}`);
  
  try {
    const backupName = args && args[0] ? args[0] : "";
    const command = backupName 
      ? `/usr/local/bin/mc-backup.sh ${backupName}`
      : `/usr/local/bin/mc-backup.sh`;
    
    const output = await executeSSMCommand(instanceId, [command]);
    
    const message = `Backup completed successfully${backupName ? ` (${backupName})` : ""}.\n\nOutput:\n${output}`;
    
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Backup Completed",
        message
      );
    }
    
    return message;
  } catch (error) {
    console.error("Error in handleBackup:", error);
    
    const errorMessage = `Backup failed: ${error.message}`;
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Backup Failed",
        errorMessage
      );
    }
    
    throw error;
  }
}

/**
 * Handle restore command - runs restore script via SSM
 * @param {string} instanceId - The EC2 instance ID
 * @param {string[]} args - Command arguments (required backup name)
 * @param {string} adminEmail - Admin email for notifications
 * @returns {Promise<string>} The restore result message
 */
async function handleRestore(instanceId, args, adminEmail) {
  console.log(`Handling restore command for instance ${instanceId}`);
  
  if (!args || !args[0]) {
    throw new Error("Restore command requires a backup name argument");
  }
  
  try {
    const backupName = args[0];
    const command = `/usr/local/bin/mc-restore.sh ${backupName}`;
    
    const output = await executeSSMCommand(instanceId, [command]);
    
    const message = `Restore completed successfully (${backupName}).\n\nOutput:\n${output}`;
    
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Restore Completed",
        message
      );
    }
    
    return message;
  } catch (error) {
    console.error("Error in handleRestore:", error);
    
    const errorMessage = `Restore failed: ${error.message}`;
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Restore Failed",
        errorMessage
      );
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
async function handleHibernate(instanceId, args, adminEmail) {
  console.log(`Handling hibernate command for instance ${instanceId}`);
  
  try {
    // Step 1: Run backup script
    console.log("Running backup before hibernation...");
    const backupOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-backup.sh"]);
    console.log(`Backup output: ${backupOutput}`);
    
    // Step 2: Stop the instance
    console.log(`Stopping instance ${instanceId}...`);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    
    // Wait for instance to stop
    let stopped = false;
    let attempts = 0;
    const maxAttempts = 60; // 60 * 5 seconds = 5 minutes
    
    while (!stopped && attempts < maxAttempts) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      try {
        const { Reservations } = await ec2.send(
          new DescribeInstancesCommand({ InstanceIds: [instanceId] })
        );
        
        const instance = Reservations?.[0]?.Instances?.[0];
        const state = instance?.State?.Name;
        
        console.log(`Instance state: ${state} (attempt ${attempts}/${maxAttempts})`);
        
        if (state === "stopped") {
          stopped = true;
          console.log(`Instance ${instanceId} is now stopped`);
        }
      } catch (error) {
        console.error(`Error checking instance state on attempt ${attempts}:`, error);
      }
    }
    
    if (!stopped) {
      throw new Error(`Instance ${instanceId} did not stop within timeout`);
    }
    
    // Step 3: Detach and delete volumes
    console.log(`Detaching and deleting volumes for instance ${instanceId}...`);
    
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );
    
    const instance = Reservations?.[0]?.Instances?.[0];
    const blockDeviceMappings = instance?.BlockDeviceMappings || [];
    
    for (const mapping of blockDeviceMappings) {
      const volumeId = mapping.Ebs?.VolumeId;
      if (!volumeId) continue;
      
      try {
        // Detach volume
        console.log(`Detaching volume ${volumeId}...`);
        await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId }));
        
        // Wait for detachment
        let detached = false;
        let detachAttempts = 0;
        const detachMaxAttempts = 30; // 30 * 2 seconds = 1 minute
        
        while (!detached && detachAttempts < detachMaxAttempts) {
          detachAttempts++;
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
          
          try {
            const volumeResponse = await ec2.send(
              new DescribeVolumesCommand({ VolumeIds: [volumeId] })
            );
            
            const volume = volumeResponse.Volumes?.[0];
            const attachmentState = volume?.Attachments?.[0]?.State;
            
            if (!attachmentState || attachmentState === "detached") {
              detached = true;
              console.log(`Volume ${volumeId} is now detached`);
            }
          } catch (error) {
            console.error(`Error checking volume attachment state:`, error);
          }
        }
        
        // Delete volume
        console.log(`Deleting volume ${volumeId}...`);
        await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
        console.log(`Volume ${volumeId} deleted successfully`);
      } catch (error) {
        console.error(`Error detaching/deleting volume ${volumeId}:`, error);
        throw error;
      }
    }
    
    const message = `Hibernation completed successfully.\n\nBackup output:\n${backupOutput}`;
    
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Server Hibernated",
        message
      );
    }
    
    return message;
  } catch (error) {
    console.error("Error in handleHibernate:", error);
    
    const errorMessage = `Hibernation failed: ${error.message}`;
    if (adminEmail) {
      await sendNotification(
        adminEmail,
        "Minecraft Hibernation Failed",
        errorMessage
      );
    }
    
    throw error;
  }
}

/**
 * Handle resuming a hibernated instance by creating and attaching a root volume
 * @param {string} instanceId - The EC2 instance ID
 * @returns {Promise<void>}
 */
async function handleResume(instanceId) {
  console.log(`Checking if instance ${instanceId} needs volume restoration...`);
  
  // Check if instance has no volumes (hibernated state)
  const { Reservations } = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] })
  );
  
  if (!Reservations || Reservations.length === 0 || !Reservations[0].Instances) {
    throw new Error(`Instance ${instanceId} not found`);
  }
  
  const instance = Reservations[0].Instances[0];
  const blockDeviceMappings = instance.BlockDeviceMappings || [];
  
  // If instance already has volumes, no need to resume
  if (blockDeviceMappings.length > 0) {
    console.log(`Instance ${instanceId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`);
    return;
  }
  
  console.log(`Instance ${instanceId} has no volumes. Proceeding with hibernation recovery...`);
  
  // Get instance availability zone
  const az = instance.Placement?.AvailabilityZone;
  if (!az) {
    throw new Error(`Could not determine availability zone for instance ${instanceId}`);
  }
  console.log(`Instance is in availability zone: ${az}`);
  
  // Find latest Amazon Linux 2023 ARM64 AMI
  console.log("Looking up Amazon Linux 2023 ARM64 AMI...");
  const imagesResponse = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023*-arm64"] },
        { Name: "state", Values: ["available"] }
      ]
    })
  );
  
  if (!imagesResponse.Images || imagesResponse.Images.length === 0) {
    throw new Error("Could not find Amazon Linux 2023 ARM64 AMI");
  }
  
  // Sort by creation date and get the latest
  const sortedImages = imagesResponse.Images.sort((a, b) => {
    const dateA = new Date(a.CreationDate).getTime();
    const dateB = new Date(b.CreationDate).getTime();
    return dateB - dateA; // Descending order (newest first)
  });
  
  const amiId = sortedImages[0].ImageId;
  console.log(`Found latest AMI: ${amiId}`);
  
  // Get snapshot ID from AMI's BlockDeviceMappings
  const blockDeviceMapping = sortedImages[0].BlockDeviceMappings?.[0];
  if (!blockDeviceMapping || !blockDeviceMapping.Ebs?.SnapshotId) {
    throw new Error(`Could not find snapshot for AMI ${amiId}`);
  }
  
  const snapshotId = blockDeviceMapping.Ebs.SnapshotId;
  console.log(`Using snapshot: ${snapshotId}`);
  
  // Create volume from snapshot
  console.log("Creating new 8GB GP3 volume from snapshot...");
  const createVolumeResponse = await ec2.send(
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
            { Key: "Backup", Value: "weekly" }
          ]
        }
      ]
    })
  );
  
  const volumeId = createVolumeResponse.VolumeId;
  if (!volumeId) {
    throw new Error("Failed to create volume");
  }
  console.log(`Volume created: ${volumeId}`);
  
  // Wait for volume to become available
  console.log("Waiting for volume to become available...");
  let volumeAvailable = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 * 5 seconds = 5 minutes
  
  while (!volumeAvailable && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(
        new DescribeVolumesCommand({ VolumeIds: [volumeId] })
      );
      
      const volume = volumeResponse.Volumes?.[0];
      if (volume?.State === "available") {
        volumeAvailable = true;
        console.log(`Volume ${volumeId} is now available`);
      } else {
        console.log(`Volume state: ${volume?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      }
    } catch (error) {
      console.error(`Error checking volume status on attempt ${attempts}:`, error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  if (!volumeAvailable) {
    throw new Error(`Volume ${volumeId} did not become available within timeout`);
  }
  
  // Attach volume to instance at /dev/xvda (root device)
  console.log(`Attaching volume ${volumeId} to instance ${instanceId} at /dev/xvda...`);
  await ec2.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: instanceId,
      Device: "/dev/xvda"
    })
  );
  
  // Wait for attachment to complete
  console.log("Waiting for volume attachment to complete...");
  let attachmentComplete = false;
  attempts = 0;
  
  while (!attachmentComplete && attempts < maxAttempts) {
    attempts++;
    try {
      const volumeResponse = await ec2.send(
        new DescribeVolumesCommand({ VolumeIds: [volumeId] })
      );
      
      const attachment = volumeResponse.Volumes?.[0]?.Attachments?.[0];
      if (attachment?.State === "attached") {
        attachmentComplete = true;
        console.log(`Volume ${volumeId} is now attached to instance ${instanceId}`);
      } else {
        console.log(`Attachment state: ${attachment?.State}. Waiting... (attempt ${attempts}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      }
    } catch (error) {
      console.error(`Error checking attachment status on attempt ${attempts}:`, error);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  if (!attachmentComplete) {
    throw new Error(`Volume ${volumeId} attachment did not complete within timeout`);
  }
  
  console.log(`Successfully restored volume for instance ${instanceId}`);
}

export const handler = async (event) => {
  // 1. Extract SNS payload and parse email data
  let payload;
  let toAddr;
  let subject = ""; // Initialize to empty string
  let body = "";    // Initialize to empty string
  try {
    if (!event.Records || !event.Records[0] || !event.Records[0].Sns || !event.Records[0].Sns.Message) {
        console.error("Invalid SNS event structure:", JSON.stringify(event));
        return { statusCode: 400, body: "Invalid event structure." };
    }
    const snsRecord = event.Records[0].Sns;
    payload = JSON.parse(snsRecord.Message);

    // Safely access sender address
    toAddr = payload.mail?.commonHeaders?.from?.[0];
    if (!toAddr) {
        console.error("Sender address not found in email headers.");
        return { statusCode: 400, body: "Sender address missing." };
    }

    // Get subject
    subject = (payload.mail?.commonHeaders?.subject || "").toLowerCase();

    // Decode the full raw email and get its body text, if content exists
    if (payload.content) {
      const raw = Buffer.from(payload.content, "base64").toString("utf8");
      body = raw.toLowerCase(); // crude full‑email search
    } else {
      console.log("Email content (body) is missing, proceeding with subject check only.");
    }

  } catch (parseError) {
    console.error("Error parsing SNS message:", parseError); // Removed "or email content" as it's handled now
    return { statusCode: 400, body: "Error processing incoming message." };
  }

    // 2. Get admin email and allowlist
    const adminEmail = (process.env.NOTIFICATION_EMAIL || "").toLowerCase();
    const senderEmail = toAddr.toLowerCase();
    const startKeyword = (process.env.START_KEYWORD || "start").toLowerCase();
    
    // Check if sender is admin
    const isAdmin = adminEmail && senderEmail === adminEmail;
    
    // If admin email is sending, check for allowlist updates in body
    if (isAdmin) {
      const emailsInBody = extractEmails(body);
      
      if (emailsInBody.length > 0) {
        // Admin is updating the allowlist
        console.log(`Admin ${senderEmail} is updating allowlist with emails:`, emailsInBody);
        await updateAllowlist(emailsInBody);
        
        // Send confirmation
        await sendNotification(
          adminEmail,
          "Minecraft Allowlist Updated",
          `Allowlist has been updated with the following emails:\n\n${emailsInBody.join('\n')}\n\nOnly these emails can now start the server.`
        );
        
        return { statusCode: 200, body: "Allowlist updated successfully." };
      }
    }

   // 3. Check for required environment variables
   const instanceId = process.env.INSTANCE_ID;
   const fromAddr = process.env.VERIFIED_SENDER;
   const zone = process.env.CLOUDFLARE_ZONE_ID;
   const record = process.env.CLOUDFLARE_RECORD_ID;
   const domain = process.env.CLOUDFLARE_MC_DOMAIN;
   const cfToken = process.env.CLOUDFLARE_API_TOKEN;

   if (!instanceId || !fromAddr || !zone || !record || !domain || !cfToken) {
     console.error("Missing required environment variables (INSTANCE_ID, VERIFIED_SENDER, Cloudflare details).");
     // Optionally send an error email to an admin address here
     return { statusCode: 500, body: "Configuration error." }; // Use 500 for server-side config issues
   }

   // 4. Parse command - use already-parsed command for admin, or parse for non-admin
   let parsedCommand = null;
   
   if (isAdmin) {
     // Admin can run any command (parse from subject)
     parsedCommand = parseCommand(subject, startKeyword);
     if (!parsedCommand) {
       console.log(`Admin email received but no valid command in subject.`);
       return { statusCode: 200, body: "No valid command found." };
     }
     console.log(`Admin ${senderEmail} is executing command: ${parsedCommand.command} with args: ${parsedCommand.args.join(' ')}`);
   } else {
     // Non-admin sender - check allowlist and only allow "start"
     const allowlist = await getAllowlist();
     
     if (allowlist.length === 0) {
       // No allowlist configured, allow anyone
       console.log("No allowlist configured. Allowing all emails.");
     } else if (!allowlist.includes(senderEmail)) {
       console.log(`Email ${toAddr} not in allowlist. Rejecting request.`);
       return { statusCode: 403, body: "Email not authorized." };
     } else {
       console.log(`Email ${toAddr} found in allowlist. Proceeding.`);
     }
     
     // Non-admin: only allow start keyword
     if (!subject.includes(startKeyword)) {
       console.log(`No start keyword ('${startKeyword}') found in subject for email from ${toAddr}.`);
       return { statusCode: 200, body: "Keyword not found, no action taken." };
     }
     
     // Non-admin can only run "start"
     parsedCommand = { command: "start", args: [] };
   }
   
   if (!parsedCommand) {
     console.log("No valid command found in subject");
     return { statusCode: 200, body: "No valid command found." };
   }

   console.log(`Executing command: ${parsedCommand.command}`);

   try {
     const notificationEmail = process.env.NOTIFICATION_EMAIL;
     
     // Route to appropriate command handler
     switch (parsedCommand.command) {
       case "start": {
         console.log(`Received request to start instance ${instanceId} triggered by email from ${toAddr}`);
         
         // Send notification email about the startup
         if (notificationEmail) {
           await sendNotification(
             notificationEmail,
             "Minecraft Startup",
             `Minecraft EC2 startup triggered by: ${toAddr}`
           );
         } else {
           console.log("NOTIFICATION_EMAIL env var not set; skipping startup email.");
         }

         // Handle hibernation recovery (create and attach volume if needed)
         await handleResume(instanceId);

         // Start EC2 Instance
         console.log(`Attempting to start EC2 instance: ${instanceId}`);
         await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
         console.log(`Successfully sent start command for instance: ${instanceId}`);

         // Wait for Public IP Address using helper function
         const publicIp = await getPublicIp(instanceId);

         // Update Cloudflare DNS using helper function
         await updateCloudflareDns(zone, record, publicIp, domain, cfToken);
         
         // Send success notification
         if (notificationEmail) {
           await sendNotification(
             notificationEmail,
             "Minecraft Server Started",
             `Server started successfully and DNS updated to ${publicIp}`
           );
         }
         
         return { statusCode: 200, body: `Instance ${instanceId} started, DNS updated to ${publicIp}, email sent.` };
       }
       
       case "backup": {
         if (!isAdmin) {
           return { statusCode: 403, body: "Only admins can run backup command." };
         }
         
         const result = await handleBackup(instanceId, parsedCommand.args, notificationEmail);
         return { statusCode: 200, body: result };
       }
       
       case "restore": {
         if (!isAdmin) {
           return { statusCode: 403, body: "Only admins can run restore command." };
         }
         
         const result = await handleRestore(instanceId, parsedCommand.args, notificationEmail);
         return { statusCode: 200, body: result };
       }
       
       case "hibernate": {
         if (!isAdmin) {
           return { statusCode: 403, body: "Only admins can run hibernate command." };
         }
         
         const result = await handleHibernate(instanceId, parsedCommand.args, notificationEmail);
         return { statusCode: 200, body: result };
       }
       
       case "resume": {
         if (!isAdmin) {
           return { statusCode: 403, body: "Only admins can run resume command." };
         }
         
         console.log(`Received request to resume instance ${instanceId} triggered by email from ${toAddr}`);
         
         // Send notification email about the resume
         if (notificationEmail) {
           await sendNotification(
             notificationEmail,
             "Minecraft Resume",
             `Minecraft EC2 resume triggered by: ${toAddr}`
           );
         }

         // Handle hibernation recovery (create and attach volume if needed)
         await handleResume(instanceId);

         // Start EC2 Instance
         console.log(`Attempting to start EC2 instance: ${instanceId}`);
         await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
         console.log(`Successfully sent start command for instance: ${instanceId}`);

         // Wait for Public IP Address
         const publicIp = await getPublicIp(instanceId);

         // Run resume script via SSM
         const resumeOutput = await executeSSMCommand(instanceId, ["/usr/local/bin/mc-resume.sh"]);
         
         // Update Cloudflare DNS
         await updateCloudflareDns(zone, record, publicIp, domain, cfToken);
         
         // Send success notification
         if (notificationEmail) {
           await sendNotification(
             notificationEmail,
             "Minecraft Server Resumed",
             `Server resumed successfully and DNS updated to ${publicIp}\n\nResume script output:\n${resumeOutput}`
           );
         }
         
         return { statusCode: 200, body: `Instance ${instanceId} resumed, DNS updated to ${publicIp}, email sent.` };
       }
       
       default: {
         return { statusCode: 400, body: `Unknown command: ${parsedCommand.command}` };
       }
     }

   } catch (error) {
     console.error("Unhandled error in handler:", error);
     
     // Send error notification
     const notificationEmail = process.env.NOTIFICATION_EMAIL;
     if (notificationEmail) {
       await sendNotification(
         notificationEmail,
         "Minecraft Command Failed",
         `Error executing ${parsedCommand.command} command: ${error.message}`
       );
     }
     
     return { statusCode: 500, body: `Failed to process request: ${error.message}` };
   }
};
