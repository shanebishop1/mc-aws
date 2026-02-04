/**
 * Parse command from email subject
 * @param {string} subject - Email subject line
 * @param {string} startKeyword - The start keyword to check for
 * @returns {Object|null} { command, args } or null if no valid command
 */
export function parseCommand(subject, startKeyword) {
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

  // Check for restore command (optional: restore name)
  if (lowerSubject.includes("restore")) {
    const match = lowerSubject.match(/restore\s+(\S+)?/);
    const args = match?.[1] ? [match[1]] : [];
    return { command: "restore", args };
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
