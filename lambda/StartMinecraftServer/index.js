import fetch from "node-fetch";
import { EC2Client, StartInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// Instantiate clients without hardcoding region - SDK will infer from environment
const ec2 = new EC2Client({});
const ses = new SESClient({});

const MAX_POLL_ATTEMPTS = 150; // Max attempts to get IP (e.g., 60 attempts * 5s = 5 minutes)
const POLL_INTERVAL_MS = 2000; // Wait 5 seconds between polls

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

  // 2. Check for keyword "start"
  if (!subject.includes("start") && !body.includes("start")) {
    console.log(`No 'start' keyword found in subject ('${subject}') or body for email from ${toAddr}; skipping.`);
    return { statusCode: 200, body: "Keyword not found, no action taken." };
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

  console.log(`'start' keyword found. Received request to start instance ${instanceId} triggered by email from ${toAddr}`);

  try {
    // 4. Start EC2 Instance
    console.log(`Attempting to start EC2 instance: ${instanceId}`);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(`Successfully sent start command for instance: ${instanceId}`);

    // 2. Wait for Public IP Address
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
            break; // Exit loop if IP is found
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
    } // End while loop

    if (!publicIp) {
      console.error(`Failed to obtain public IP for instance ${instanceId} after ${attempts} attempts.`);
      throw new Error("Timed out waiting for public IP address.");
    } // End while loop

    if (!publicIp) {
      console.error(`Failed to obtain public IP for instance ${instanceId} after ${attempts} attempts.`);
      throw new Error("Timed out waiting for public IP address.");
    }

    // 5. Update Cloudflare DNS A record
    console.log(`Updating Cloudflare DNS record ${record} in zone ${zone} for domain ${domain} to IP ${publicIp}`);
    const cfUrl = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record}`;
    const cfPayload = {
      type: "A",
      name: domain,
      content: publicIp,
      ttl: 300, // Consider making TTL configurable via env var
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

    // 6. Send Confirmation Email via SES (using SDK v3)
    console.log(`Sending confirmation email to ${toAddr}`);
    const emailParams = {
      Source: fromAddr,
      Destination: { ToAddresses: [toAddr] },
      Content: {
        Simple: {
          Subject: { Data: "Your Minecraft Server IP", Charset: "UTF-8" },
          Body: { Text: { Data: `Server is starting up at ${domain} (${publicIp}). It might take a minute or two to be ready.`, Charset: "UTF-8" } }
        }
      }
      // Use FromEmailAddress if using SESv2Client instead of SESClient
      // FromEmailAddress: fromAddr,
    };

    try {
      await ses.send(new SendEmailCommand(emailParams));
      console.log("Successfully sent confirmation email.");
    } catch (emailError) {
      console.error("Error sending email via SES:", emailError);
      // Log the error but don't necessarily fail the whole function,
      // as the server is up and DNS is updated. Maybe send alert to admin?
    }

    return { statusCode: 200, body: `Instance ${instanceId} started, DNS updated to ${publicIp}, email sent to ${toAddr}.` };

  } catch (error) {
    console.error("Unhandled error in handler:", error);
    // Consider sending an error notification email to an admin address here
    // Make sure not to reveal sensitive details in the response body if it's exposed
    return { statusCode: 500, body: `Failed to process request: ${error.message}` };
  }
};
