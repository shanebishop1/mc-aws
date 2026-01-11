import { SendEmailCommand, ses } from "./clients.js";

/**
 * Generate a sanitized error message for email notification
 * @param {string} commandName - The command that failed (e.g., "start", "backup", "restore")
 * @returns {string} Sanitized error message
 */
export function getSanitizedErrorMessage(commandName) {
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
export async function sendNotification(to, subject, body) {
  const emailParams = {
    Source: process.env.VERIFIED_SENDER,
    Destination: {
      ToAddresses: [to],
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
  }
}
