/**
 * Validates required environment variables for production builds
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { getEnvVarNamesByRequirement, validateEnvForTarget } from "../lib/runtime-config-schema";

const buildLifecycleEvents = new Set(["build", "prebuild", "deploy:cf", "preview:cf"]);

const resolveNodeEnv = (): "development" | "production" | "test" => {
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  if (process.env.NODE_ENV === "test") {
    return "test";
  }

  if (process.env.NODE_ENV === "development") {
    return "development";
  }

  if (process.env.npm_lifecycle_event && buildLifecycleEvents.has(process.env.npm_lifecycle_event)) {
    return "production";
  }

  return "development";
};

const loadEnvironmentFiles = (nodeEnv: "development" | "production" | "test"): void => {
  const envFiles = [`.env.${nodeEnv}.local`, ...(nodeEnv === "test" ? [] : [".env.local"]), `.env.${nodeEnv}`, ".env"];

  for (const envFile of envFiles) {
    const envPath = path.resolve(process.cwd(), envFile);

    if (!fs.existsSync(envPath)) {
      continue;
    }

    dotenv.config({ path: envPath, override: false });
  }
};

export function validateEnv(): void {
  const nodeEnv = resolveNodeEnv();
  const isProduction = nodeEnv === "production";

  loadEnvironmentFiles(nodeEnv);

  const requiredEnvVars = getEnvVarNamesByRequirement("ci", "required");
  const schemaReport = validateEnvForTarget(process.env, "ci");
  const invalidVars = schemaReport.issues.filter((issue) => issue.kind === "invalid").map((issue) => issue.name);

  const missing = requiredEnvVars.filter((name) => !process.env[name]);

  if (missing.length === 0) {
    if (invalidVars.length > 0) {
      console.warn("[ENV] ⚠️ Environment variables have invalid values:");
      invalidVars.forEach((name) => console.warn(`  - ${name}`));
    }

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

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  validateEnv();
}
