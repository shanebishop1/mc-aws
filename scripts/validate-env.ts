/**
 * Validates required environment variables for production builds
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import type { RuntimeTarget } from "../lib/runtime-config-schema";
import { validateEnvForTarget } from "../lib/runtime-config-schema";

const buildLifecycleEvents = new Set(["build", "prebuild", "deploy:cf", "preview:cf"]);

interface CliArgs {
  envFile?: string;
  strict: boolean;
  target: RuntimeTarget;
}

export interface ValidateEnvOptions extends CliArgs {
  values?: Record<string, string | undefined>;
  nodeEnv?: "development" | "production" | "test";
}

const parseCliArgs = (argv: string[]): CliArgs => {
  let envFile: string | undefined;
  let strict = false;
  let target: RuntimeTarget = "ci";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--env-file") {
      envFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--target") {
      const candidate = argv[index + 1] as RuntimeTarget | undefined;
      index += 1;
      if (
        candidate === "worker" ||
        candidate === "lambda" ||
        candidate === "ec2" ||
        candidate === "local-dev" ||
        candidate === "ci"
      ) {
        target = candidate;
      } else {
        throw new Error(`Invalid --target value: ${String(candidate)}`);
      }
    }
  }

  return {
    envFile,
    strict,
    target,
  };
};

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

const loadEnvironmentFile = (filePath: string): void => {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Environment file not found: ${absolutePath}`);
  }

  dotenv.config({ path: absolutePath, override: true });
};

const formatIssue = (message: string): string => {
  return `  - ${message}`;
};

export function validateEnv(args: ValidateEnvOptions = { strict: false, target: "ci" }): void {
  const nodeEnv = args.nodeEnv ?? resolveNodeEnv();
  const isProduction = nodeEnv === "production";
  const values = args.values ?? process.env;

  if (!args.values && args.envFile) {
    loadEnvironmentFile(args.envFile);
  } else if (!args.values) {
    loadEnvironmentFiles(nodeEnv);
  }

  const schemaReport = validateEnvForTarget(values, args.target);
  const blockingIssues = schemaReport.issues.filter(
    (issue) => issue.kind === "missing" || issue.kind === "invalid" || issue.kind === "forbidden"
  );
  const warningIssues = schemaReport.issues.filter((issue) => issue.kind === "deprecated");

  if (warningIssues.length > 0) {
    console.warn("[ENV] ⚠️ Deprecated environment variable aliases detected:");
    warningIssues.forEach((issue) => console.warn(formatIssue(issue.message)));
  }

  if (blockingIssues.length === 0) {
    console.log(`[ENV] ✅ Environment variables passed schema validation for target: ${args.target}`);
    return;
  }

  const context = isProduction ? "production" : "non-production";
  if (isProduction && args.strict) {
    console.error(`[ENV] ❌ Invalid ${context} configuration for target: ${args.target}`);
    blockingIssues.forEach((issue) => console.error(formatIssue(issue.message)));
    throw new Error("Strict environment validation failed.");
  }

  if (isProduction) {
    console.warn(`[ENV] ⚠️ Invalid ${context} configuration for target: ${args.target}`);
    blockingIssues.forEach((issue) => console.warn(formatIssue(issue.message)));
  } else {
    console.warn(`[ENV] ⚠️ Invalid ${context} configuration for target: ${args.target}`);
    blockingIssues.forEach((issue) => console.warn(formatIssue(issue.message)));
    console.warn("[ENV] ℹ️ These values are required for production deploy/runtime.");
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  validateEnv(cliArgs);
}
