/**
 * Validates required environment variables for production builds
 */

const requiredEnvVars = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_SECRET",
  "ADMIN_EMAIL",
];

function validateEnv() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[ENV] Skipping validation (not production)");
    return;
  }

  const missing = requiredEnvVars.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error("[ENV] ❌ Missing required environment variables for production:");
    missing.forEach((name) => console.error(`  - ${name}`));
    console.error("\nPlease set these variables before deploying.");
    process.exit(1);
  }

  console.log("[ENV] ✅ All required environment variables are set");
}

validateEnv();
