/**
 * Parse command from email subject
 * @param {string} subject - Email subject line
 * @param {string} startKeyword - The start keyword to check for
 * @returns {Object|null} { command, args } or null if no valid command
 */
export function parseCommand(subject, startKeyword) {
  const normalizedSubject = String(subject || "")
    .trim()
    .toLowerCase();
  if (!normalizedSubject) return null;

  const tokens = normalizedSubject.split(/\s+/);
  const normalizedStartKeyword = String(startKeyword || "start")
    .trim()
    .toLowerCase();
  const commandTokens = new Set([normalizedStartKeyword, "backup", "restore", "hibernate", "resume"]);
  const foundCommandTokens = tokens.filter((token) => commandTokens.has(token));

  // Reject ambiguous subjects containing multiple commands (e.g. "backup restore")
  if (foundCommandTokens.length !== 1) {
    return null;
  }

  const commandToken = foundCommandTokens[0];
  const commandIndex = tokens.indexOf(commandToken);

  // Require command token to be the first token for deterministic parsing.
  if (commandIndex !== 0) {
    return null;
  }

  const args = tokens.slice(1);

  if (commandToken === normalizedStartKeyword) {
    return parseNoArgCommand("start", args);
  }

  if (commandToken === "backup" || commandToken === "restore") {
    return parseSingleOptionalArgCommand(commandToken, args);
  }

  if (commandToken === "hibernate" || commandToken === "resume") {
    return parseNoArgCommand(commandToken, args);
  }

  return null;
}

function parseNoArgCommand(command, args) {
  return args.length === 0 ? { command, args: [] } : null;
}

function parseSingleOptionalArgCommand(command, args) {
  if (args.length > 1) return null;
  return { command, args };
}
