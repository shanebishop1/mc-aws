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
  console.log(`Updated allowlist with ${emails.length} entries`);
}

/**
 * Extract email addresses from text
 * @param {string} text - Text to parse for emails
 * @returns {string[]} Array of email addresses found
 */
export function extractEmails(text) {
  const emails = [];
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const atIndex = text.indexOf("@", searchIndex);
    if (atIndex === -1) break;

    const localStart = findLocalStart(text, atIndex, searchIndex);
    const domainEnd = findDomainEnd(text, atIndex + 1);
    const matchEnd = findDomainMatchEnd(text, atIndex + 1, domainEnd);

    if (localStart < atIndex && matchEnd !== -1) {
      emails.push(text.slice(localStart, matchEnd).toLowerCase());
      searchIndex = matchEnd;
    } else {
      searchIndex = atIndex + 1;
    }
  }

  return emails;
}

function findLocalStart(text, atIndex, searchIndex) {
  let localStart = atIndex;
  while (localStart > searchIndex && isLocalPartCharacter(text.charCodeAt(localStart - 1))) localStart--;
  return localStart;
}

function findDomainEnd(text, domainStart) {
  let domainEnd = domainStart;
  while (domainEnd < text.length && isDomainCharacter(text.charCodeAt(domainEnd))) domainEnd++;
  return domainEnd;
}

function findDomainMatchEnd(text, domainStart, domainEnd) {
  let matchEnd = -1;
  for (let dotIndex = domainStart + 1; dotIndex < domainEnd; dotIndex++) {
    if (text.charCodeAt(dotIndex) !== 46) continue;

    let suffixEnd = dotIndex + 1;
    while (suffixEnd < domainEnd && isAsciiLetter(text.charCodeAt(suffixEnd))) suffixEnd++;
    if (suffixEnd >= dotIndex + 3) matchEnd = suffixEnd;
  }
  return matchEnd;
}

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isLocalPartCharacter(code) {
  return (
    isAsciiLetter(code) || isAsciiDigit(code) || code === 46 || code === 95 || code === 37 || code === 43 || code === 45
  );
}

function isDomainCharacter(code) {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 46 || code === 45;
}
