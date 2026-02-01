/**
 * Validates required environment variables for production builds
 */

const requiredEnvVars = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_SECRET",
  "ADMIN_EMAIL",
  "NEXT_PUBLIC_APP_URL",
];

function validateEnv() {
  const isProduction = process.env.NODE_ENV === "production";
  const missing = requiredEnvVars.filter((name) => !process.env[name]);

  if (missing.length === 0) {
    console.log("[ENV] ✅ All required environment variables are set");
    return;
  }

  if (isProduction) {
    console.warn("[ENV] ⚠️ Missing environment variables for production build:");
    missing.forEach((name) => console.warn(`  - ${name}`));
    console.warn("\nThese variables must be available at RUNTIME (e.g. in Cloudflare dashboard or .env file).");
    // Do not exit(1) here, because Cloudflare secrets are often only available at runtime, not build time.
    // process.exit(1);
  } else {
    console.warn("[ENV] ⚠️ Missing environment variables (optional in dev):");
    missing.forEach((name) => console.warn(`  - ${name}`));
    console.warn("\nThese are required for production deployment.");
  }
}

validateEnv();
