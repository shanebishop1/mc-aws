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

  // Google OAuth (optional, for setup)
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID", true),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET", true),
  NEXT_PUBLIC_APP_URL: getEnv("NEXT_PUBLIC_APP_URL", true) || "http://localhost:3000",
};
