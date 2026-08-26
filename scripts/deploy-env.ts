import fs from "node:fs";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { workerSecretAllowlist } from "../lib/runtime-config-schema";

const buildEnvExcludedKeys = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DEPLOY_API_TOKEN",
  "CLOUDFLARE_PANEL_DNS_API_TOKEN",
  "PANEL_DNS_MANAGEMENT",
]);

export const deployOnlyIgnoredSecretNames = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CDK_DEFAULT_ACCOUNT",
  "CDK_DEFAULT_REGION",
  "AL2023_ARM64_AMI_ID",
  "SES_NOTIFICATIONS_ENABLED",
  "SES_INBOUND_COMMANDS_ENABLED",
  "VERIFIED_SENDER",
  "NOTIFICATION_EMAIL",
  "SES_INBOUND_RECIPIENT",
  "SES_RECEIPT_RULE_SET_NAME",
  "START_KEYWORD",
  "GITHUB_USER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "KEY_PAIR_NAME",
  "RUNTIME_STATE_SNAPSHOT_KV_ID",
  "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID",
  "MC_CONNECTION_MODE",
  "PANEL_HOSTING_MODE",
  "PANEL_DNS_MANAGEMENT",
  "PANEL_WORKERS_DEV_ENABLED",
  "CLOUDFLARE_WORKERS_SUBDOMAIN",
  "CLOUDFLARE_PANEL_ZONE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DEPLOY_API_TOKEN",
  "CLOUDFLARE_PANEL_DNS_API_TOKEN",
]);

export interface WorkerSecretUploadEntry {
  key: string;
  value: string;
}

export const effectiveDotenvKey = (line: string): string | null => {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] ?? null;
};

export const sanitizeDeploymentBuildEnv = (source: string): string => {
  const retainedLines = source.split(/\r?\n/).filter((line) => {
    const key = effectiveDotenvKey(line);
    return !key || !buildEnvExcludedKeys.has(key);
  });

  return ["AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=", "AWS_SESSION_TOKEN=", ...retainedLines].join("\n");
};

export const buildWorkerSecretUploadEntries = (source: string): WorkerSecretUploadEntry[] => {
  const parsed: Record<string, string> = dotenv.parse(source);
  const canonicalDnsToken = parsed.CLOUDFLARE_DNS_API_TOKEN?.trim();
  const deprecatedFileDnsToken = parsed.CLOUDFLARE_API_TOKEN?.trim();
  if (!canonicalDnsToken && deprecatedFileDnsToken) {
    parsed.CLOUDFLARE_DNS_API_TOKEN = deprecatedFileDnsToken;
  }

  const allowed = new Set<string>(workerSecretAllowlist);
  const rejected = Object.keys(parsed).filter((key) => !allowed.has(key) && !deployOnlyIgnoredSecretNames.has(key));
  if (rejected.length > 0) {
    throw new Error(`Refusing to upload unapproved Worker secret key(s): ${rejected.join(", ")}`);
  }

  return workerSecretAllowlist.flatMap((key) => {
    const value = parsed[key];
    return value ? [{ key, value }] : [];
  });
};

const getArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
};

const runCli = (): void => {
  const [command, ...args] = process.argv.slice(2);
  const envFile = getArg(args, "--env-file");
  const source = fs.readFileSync(envFile, "utf8");

  if (command === "sanitize-build-env") {
    fs.writeFileSync(getArg(args, "--output"), sanitizeDeploymentBuildEnv(source), { mode: 0o600 });
    return;
  }

  if (command === "worker-secret-entries") {
    for (const entry of buildWorkerSecretUploadEntries(source)) {
      process.stdout.write(`${entry.key}\t${Buffer.from(entry.value).toString("base64")}\n`);
    }
    return;
  }

  throw new Error(`Unknown deploy-env command: ${String(command)}`);
};

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
