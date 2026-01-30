/**
 * Input sanitization utilities for secure command execution.
 * Prevents command injection attacks by strictly validating user inputs.
 */

/**
 * Validate and sanitize a backup/restore name argument.
 * Only allows alphanumeric characters, dots, dashes, and underscores.
 * Maximum length: 64 characters.
 *
 * @param {string} name - The input name to sanitize
 * @returns {string} The sanitized name
 * @throws {Error} If input contains invalid characters or is too long
 */
export function sanitizeBackupName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("Backup name is required");
  }

  const trimmed = name.trim();

  // Maximum length check
  if (trimmed.length > 64) {
    throw new Error("Backup name exceeds maximum length of 64 characters");
  }

  // Minimum length check
  if (trimmed.length === 0) {
    throw new Error("Backup name cannot be empty");
  }

  // Only allow safe characters: alphanumeric, dots, dashes, underscores
  const safePattern = /^[a-zA-Z0-9._-]+$/;
  if (!safePattern.test(trimmed)) {
    throw new Error(
      "Backup name contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed."
    );
  }

  return trimmed;
}
