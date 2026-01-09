/**
 * Environment variable validation and retrieval
 */

export function getEnv(name: string, optional = false): string {
  const value = process.env[name];
  if (!value && !optional) {
    console.warn(`[WARN] Missing required environment variable: ${name}`);
    return ""; // Return empty string to allow build to proceed
  }
  return value || "";
}

// Development mode check
export const isDev = process.env.NODE_ENV !== "production";

export const env = {
  // AWS Configuration
  AWS_REGION: getEnv("AWS_REGION", true) || process.env.CDK_DEFAULT_REGION || "",
  AWS_ACCOUNT_ID: getEnv("AWS_ACCOUNT_ID", true) || process.env.CDK_DEFAULT_ACCOUNT || "",
  INSTANCE_ID: getEnv("INSTANCE_ID", true),

  // Cloudflare Configuration
  CLOUDFLARE_ZONE_ID: getEnv("CLOUDFLARE_ZONE_ID"),
  CLOUDFLARE_RECORD_ID: getEnv("CLOUDFLARE_RECORD_ID"),
  CLOUDFLARE_MC_DOMAIN: getEnv("CLOUDFLARE_MC_DOMAIN"),
  CLOUDFLARE_API_TOKEN: getEnv("CLOUDFLARE_API_TOKEN"),

  // Google Drive Configuration (optional for now)
  GDRIVE_REMOTE: getEnv("GDRIVE_REMOTE", true),
  GDRIVE_ROOT: getEnv("GDRIVE_ROOT", true),

  // Authentication Configuration
  AUTH_SECRET: getEnv("AUTH_SECRET", isDev),
  ADMIN_EMAIL: getEnv("ADMIN_EMAIL", isDev),
  ALLOWED_EMAILS: getEnv("ALLOWED_EMAILS", true),

  // Google OAuth (optional in dev, required in prod if auth is enabled)
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID", isDev),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET", isDev),
  NEXT_PUBLIC_APP_URL: getEnv("NEXT_PUBLIC_APP_URL", true) || "http://localhost:3000",
};

/**
 * Check if authentication is enabled
 * Auth is enabled if Google Client ID is configured and we're not in development mode
 */
export function isAuthEnabled(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && !isDev);
}

/**
 * Parse ALLOWED_EMAILS into an array
 * Returns an empty array if ALLOWED_EMAILS is not set
 */
export function getAllowedEmails(): string[] {
  if (!env.ALLOWED_EMAILS) {
    return [];
  }
  return env.ALLOWED_EMAILS.split(",").map((email) => email.trim());
}
