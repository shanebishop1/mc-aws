/**
 * Environment variable validation and retrieval
 *
 * Environment files:
 * - .env.local: Development config (ENABLE_DEV_LOGIN=true for local auth)
 * - .env.production: Production config (requires Google OAuth)
 *
 * Next.js automatically loads the appropriate file based on NODE_ENV
 */

/**
 * Valid backend modes for the application
 * - aws: Real AWS SDK clients (default)
 * - mock: Offline, in-process mock backend for local development/testing
 */
export type BackendMode = "aws" | "mock";

export function getEnv(name: string, optional = false): string {
  const value = process.env[name];
  if (!value && !optional) {
    console.warn(`[WARN] Missing required environment variable: ${name}`);
    return ""; // Return empty string to allow build to proceed
  }
  return value || "";
}

/**
 * Validate and parse the MC_BACKEND_MODE environment variable
 * @throws Error if the value is not "aws" or "mock"
 */
function validateBackendMode(value: string): BackendMode {
  const normalizedValue = value.toLowerCase().trim();
  if (normalizedValue !== "aws" && normalizedValue !== "mock") {
    throw new Error(`Invalid MC_BACKEND_MODE value: "${value}". Must be "aws" or "mock".`);
  }
  return normalizedValue as BackendMode;
}

/**
 * Get the backend mode from environment variable
 * Defaults to "aws" if not specified
 */
export function getBackendMode(): BackendMode {
  const mode = getEnv("MC_BACKEND_MODE", true);
  if (!mode) {
    return "aws"; // Default to aws mode
  }
  return validateBackendMode(mode);
}

export const env = {
  // Backend Mode
  MC_BACKEND_MODE: getBackendMode(),

  // AWS Configuration
  AWS_REGION: getEnv("AWS_REGION", true) || process.env.CDK_DEFAULT_REGION || "",
  AWS_ACCOUNT_ID: getEnv("AWS_ACCOUNT_ID", true) || process.env.CDK_DEFAULT_ACCOUNT || "",
  INSTANCE_ID: getEnv("INSTANCE_ID", true),

  // Cloudflare Configuration
  CLOUDFLARE_ZONE_ID: getEnv("CLOUDFLARE_ZONE_ID"),
  CLOUDFLARE_RECORD_ID: getEnv("CLOUDFLARE_RECORD_ID"),
  CLOUDFLARE_MC_DOMAIN: getEnv("CLOUDFLARE_MC_DOMAIN"),
  CLOUDFLARE_DNS_API_TOKEN: (() => {
    const newToken = getEnv("CLOUDFLARE_DNS_API_TOKEN", true);
    const oldToken = getEnv("CLOUDFLARE_API_TOKEN", true);
    if (newToken) return newToken;
    if (oldToken) {
      console.warn(
        "[DEPRECATION] CLOUDFLARE_API_TOKEN is deprecated. Please rename to CLOUDFLARE_DNS_API_TOKEN in your .env files."
      );
      return oldToken;
    }
    return getEnv("CLOUDFLARE_DNS_API_TOKEN"); // Will warn about missing required var
  })(),

  // Google Drive Configuration (optional)
  GDRIVE_REMOTE: getEnv("GDRIVE_REMOTE", true),
  GDRIVE_ROOT: getEnv("GDRIVE_ROOT", true),

  // Authentication Configuration
  AUTH_SECRET: getEnv("AUTH_SECRET"),
  ADMIN_EMAIL: getEnv("ADMIN_EMAIL", true),
  ALLOWED_EMAILS: getEnv("ALLOWED_EMAILS", true),

  // Google OAuth (required in production for real auth)
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID", true),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET", true),
  NEXT_PUBLIC_APP_URL: getEnv("NEXT_PUBLIC_APP_URL", true) || "http://localhost:3000",

  // Development
  ENABLE_DEV_LOGIN: getEnv("ENABLE_DEV_LOGIN", true),
};

/**
 * Check if authentication is properly configured
 * Returns true if Google OAuth credentials are set
 */
export function isAuthConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
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

/**
 * Check if the application is running in mock mode
 */
export function isMockMode(): boolean {
  return env.MC_BACKEND_MODE === "mock";
}

/**
 * Check if the application is running in AWS mode
 */
export function isAwsMode(): boolean {
  return env.MC_BACKEND_MODE === "aws";
}

/**
 * Validate that required AWS credentials are configured
 * Only validates when in AWS mode; skips validation in mock mode
 * @throws Error if AWS credentials are missing and in AWS mode
 */
export function validateAwsCredentials(): void {
  if (isMockMode()) {
    // Skip validation in mock mode
    return;
  }

  const requiredCreds = {
    AWS_REGION: env.AWS_REGION,
    AWS_ACCOUNT_ID: env.AWS_ACCOUNT_ID,
    INSTANCE_ID: env.INSTANCE_ID,
  };

  const missing = Object.entries(requiredCreds)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required AWS credentials in AWS mode: ${missing.join(", ")}`);
  }
}
