import { sanitizeBackupName } from "./sanitization.js";

const archiveExtensionPattern = /\.(tar\.gz|gz)$/i;

export function normalizeBackupArchiveName(backupName) {
  const sanitizedBackupName = sanitizeBackupName(String(backupName || ""));
  if (archiveExtensionPattern.test(sanitizedBackupName)) {
    return sanitizedBackupName;
  }

  return `${sanitizedBackupName}.tar.gz`;
}

export function resolveResumeRestoreStrategy(input = {}) {
  const args = Array.isArray(input.args) ? input.args : [];
  const firstArg = typeof args[0] === "string" ? args[0].trim() : "";
  const hasNamedBackup = firstArg.length > 0;
  const restoreModeRaw = typeof input.restoreMode === "string" ? input.restoreMode.trim().toLowerCase() : "";

  if (restoreModeRaw && !["fresh", "latest", "named"].includes(restoreModeRaw)) {
    throw new Error("Restore mode must be one of: fresh, latest, named");
  }

  if (restoreModeRaw === "fresh" && hasNamedBackup) {
    throw new Error("Restore mode 'fresh' cannot be used with backup args");
  }

  if (restoreModeRaw === "latest" && hasNamedBackup) {
    throw new Error("Restore mode 'latest' cannot be used with backup args");
  }

  if (restoreModeRaw === "named" && !hasNamedBackup) {
    throw new Error("Backup name is required when restore mode is 'named'");
  }

  if (hasNamedBackup) {
    return {
      mode: "named",
      backupArchiveName: normalizeBackupArchiveName(firstArg),
    };
  }

  if (restoreModeRaw === "latest") {
    return { mode: "latest" };
  }

  return { mode: "fresh" };
}
