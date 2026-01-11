import { GetParameterCommand, PutParameterCommand, ssm } from "./clients.js";

/**
 * Get email allowlist from SSM Parameter Store
 * @returns {Promise<string[]>} Array of allowed email addresses
 */
export async function getAllowlist() {
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
export async function updateAllowlist(emails) {
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
export function extractEmails(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return matches.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
