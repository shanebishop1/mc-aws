import fs from "node:fs";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { readWranglerConfig } from "./wrangler-config";

export const panelHostingModes = ["workers_dev", "custom"] as const;
export type PanelHostingMode = (typeof panelHostingModes)[number];
export const panelDnsManagementModes = ["managed", "external"] as const;
export type PanelDnsManagementMode = (typeof panelDnsManagementModes)[number];

export interface WorkersDevPanel {
  accountSubdomain: string;
  appUrl: string;
}

interface PrepareWranglerConfigOptions {
  sourcePath: string;
  outputPath: string;
  runtimeStateSnapshotKvId: string;
  runtimeStateSnapshotKvPreviewId: string;
  panelHostingMode: PanelHostingMode;
  customWorkersDevEnabled?: boolean;
  lifecycleLockTableName: string;
  operationStateTableName: string;
}

const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const workersSubdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const kvNamespaceIdPattern = /^[a-f0-9]{32}$/i;
const dynamoTableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;

const parseHttpsOrigin = (rawValue: string, description: string): URL => {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${description} must be a valid HTTPS URL.`);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${description} must be an HTTPS origin with no path, query, fragment, credentials, or port.`);
  }

  return url;
};

export const validateWorkerName = (workerName: string): string => {
  const normalized = workerName.trim().toLowerCase();
  if (!workerNamePattern.test(normalized)) {
    throw new Error("Worker name must contain only lowercase letters, numbers, and interior hyphens.");
  }
  return normalized;
};

export const deriveWorkersDevPanel = (workerName: string, rawAccountSubdomainOrUrl: string): WorkersDevPanel => {
  const normalizedWorkerName = validateWorkerName(workerName);
  const rawValue = rawAccountSubdomainOrUrl.trim().toLowerCase();
  if (!rawValue) {
    throw new Error("Cloudflare Workers account subdomain or full expected panel URL is required.");
  }

  let accountSubdomain: string;
  if (rawValue.includes("://")) {
    const url = parseHttpsOrigin(rawValue, "Workers.dev panel URL");
    const expectedSuffix = ".workers.dev";
    if (!url.hostname.endsWith(expectedSuffix)) {
      throw new Error("Workers.dev panel URL must end in .workers.dev.");
    }

    const expectedPrefix = `${normalizedWorkerName}.`;
    if (!url.hostname.startsWith(expectedPrefix)) {
      throw new Error(`Workers.dev panel URL must use Worker name '${normalizedWorkerName}'.`);
    }
    accountSubdomain = url.hostname.slice(expectedPrefix.length);
  } else if (rawValue.endsWith(".workers.dev")) {
    accountSubdomain = rawValue;
  } else {
    accountSubdomain = `${rawValue}.workers.dev`;
  }

  if (!workersSubdomainPattern.test(accountSubdomain)) {
    throw new Error("Workers account subdomain must look like account-name.workers.dev.");
  }

  return {
    accountSubdomain,
    appUrl: `https://${normalizedWorkerName}.${accountSubdomain}`,
  };
};

export const validateCustomPanelUrl = (rawUrl: string): string => {
  const url = parseHttpsOrigin(rawUrl.trim().toLowerCase(), "Custom panel URL");
  if (!hostnamePattern.test(url.hostname) || url.hostname.endsWith(".workers.dev")) {
    throw new Error("Custom panel URL must use a valid non-workers.dev hostname managed in Cloudflare.");
  }
  return url.origin;
};

export const googleOAuthCallbackUrl = (appUrl: string): string => {
  const url = parseHttpsOrigin(appUrl, "Panel URL");
  return `${url.origin}/api/auth/callback`;
};

const resolvePanelDnsManagement = (
  rawValue: string | undefined,
  panelHostingMode: PanelHostingMode
): PanelDnsManagementMode | null => {
  const configuredValue = rawValue?.trim();
  if (panelHostingMode === "workers_dev") {
    if (configuredValue) {
      throw new Error("PANEL_DNS_MANAGEMENT must be empty for workers_dev panel hosting.");
    }
    return null;
  }

  const dnsManagement = configuredValue || "managed";
  if (!panelDnsManagementModes.includes(dnsManagement as PanelDnsManagementMode)) {
    throw new Error("PANEL_DNS_MANAGEMENT must be either managed or external for custom panel hosting.");
  }
  return dnsManagement as PanelDnsManagementMode;
};

export const buildWranglerDeployArgs = ({
  configPath,
  workerName,
  panelHostingMode,
  customHostname,
}: {
  configPath: string;
  workerName: string;
  panelHostingMode: PanelHostingMode;
  customHostname?: string;
}): string[] => {
  validateWorkerName(workerName);
  if (!panelHostingModes.includes(panelHostingMode)) {
    throw new Error("Panel hosting mode must be workers_dev or custom.");
  }
  const args = ["deploy", "--config", configPath, "--name", workerName];

  if (panelHostingMode === "custom") {
    if (!customHostname || !hostnamePattern.test(customHostname.toLowerCase()) || customHostname.includes("/")) {
      throw new Error("A valid custom panel hostname is required for routed deployment.");
    }
    args.push("--route", `${customHostname.toLowerCase()}/*`);
  }

  return args;
};

export const prepareWranglerDeployConfig = (options: PrepareWranglerConfigOptions): Record<string, unknown> => {
  if (!panelHostingModes.includes(options.panelHostingMode)) {
    throw new Error("Panel hosting mode must be workers_dev or custom.");
  }
  if (!kvNamespaceIdPattern.test(options.runtimeStateSnapshotKvId)) {
    throw new Error("RUNTIME_STATE_SNAPSHOT_KV_ID must be a 32-character Cloudflare KV namespace id.");
  }
  if (!kvNamespaceIdPattern.test(options.runtimeStateSnapshotKvPreviewId)) {
    throw new Error("RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID must be a 32-character Cloudflare KV namespace id.");
  }
  if (!dynamoTableNamePattern.test(options.lifecycleLockTableName)) {
    throw new Error("MC_LIFECYCLE_LOCK_TABLE_NAME must be a valid DynamoDB table name.");
  }
  if (!dynamoTableNamePattern.test(options.operationStateTableName)) {
    throw new Error("MC_OPERATION_STATE_TABLE_NAME must be a valid DynamoDB table name.");
  }

  const config = readWranglerConfig(options.sourcePath);
  const kvNamespaces = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
  const runtimeBinding = kvNamespaces.find(
    (entry) =>
      entry && typeof entry === "object" && (entry as { binding?: unknown }).binding === "RUNTIME_STATE_SNAPSHOT_KV"
  ) as { id?: string; preview_id?: string } | undefined;

  if (!runtimeBinding) {
    throw new Error("wrangler.jsonc is missing kv_namespaces entry for RUNTIME_STATE_SNAPSHOT_KV.");
  }

  runtimeBinding.id = options.runtimeStateSnapshotKvId;
  runtimeBinding.preview_id = options.runtimeStateSnapshotKvPreviewId;
  config.workers_dev = options.panelHostingMode === "workers_dev" ? true : Boolean(options.customWorkersDevEnabled);
  const vars = config.vars && typeof config.vars === "object" && !Array.isArray(config.vars) ? config.vars : {};
  config.vars = {
    ...vars,
    MC_LIFECYCLE_LOCK_TABLE_NAME: options.lifecycleLockTableName,
    MC_OPERATION_STATE_TABLE_NAME: options.operationStateTableName,
  };

  fs.writeFileSync(options.outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
};

export const validatePanelHostingEnvironment = (
  values: Record<string, string | undefined>,
  workerName: string
): {
  mode: PanelHostingMode;
  appUrl: string;
  workersDevEnabled: boolean;
  dnsManagement: PanelDnsManagementMode | null;
} => {
  const mode = values.PANEL_HOSTING_MODE?.trim();
  if (mode !== "workers_dev" && mode !== "custom") {
    throw new Error("PANEL_HOSTING_MODE must be either workers_dev or custom.");
  }

  const configuredAppUrl = values.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  const dnsManagement = resolvePanelDnsManagement(values.PANEL_DNS_MANAGEMENT, mode);
  if (mode === "workers_dev") {
    const panel = deriveWorkersDevPanel(workerName, values.CLOUDFLARE_WORKERS_SUBDOMAIN ?? "");
    if (configuredAppUrl !== panel.appUrl) {
      throw new Error(`NEXT_PUBLIC_APP_URL must exactly match the derived Workers URL: ${panel.appUrl}`);
    }
    return { mode, appUrl: panel.appUrl, workersDevEnabled: true, dnsManagement: null };
  }

  const appUrl = validateCustomPanelUrl(configuredAppUrl);
  const panelZoneId = values.CLOUDFLARE_PANEL_ZONE_ID?.trim() ?? "";
  if (!panelZoneId) {
    throw new Error("Custom panel hosting requires CLOUDFLARE_PANEL_ZONE_ID for zone-scoped route ownership.");
  }
  if (!kvNamespaceIdPattern.test(panelZoneId)) {
    throw new Error("CLOUDFLARE_PANEL_ZONE_ID must be a 32-character hexadecimal Cloudflare zone ID.");
  }
  if (dnsManagement === "managed" && !values.CLOUDFLARE_PANEL_DNS_API_TOKEN?.trim()) {
    throw new Error("Managed custom panel DNS requires CLOUDFLARE_PANEL_DNS_API_TOKEN.");
  }
  const workersDevValue = values.PANEL_WORKERS_DEV_ENABLED?.trim().toLowerCase();
  if (workersDevValue !== "true" && workersDevValue !== "false") {
    throw new Error("PANEL_WORKERS_DEV_ENABLED must deliberately be set to true or false for custom panel hosting.");
  }

  return {
    mode,
    appUrl,
    workersDevEnabled: workersDevValue === "true",
    dnsManagement,
  };
};

const readEnvFile = (envFile: string): Record<string, string> => dotenv.parse(fs.readFileSync(envFile, "utf8"));

const getArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
};

const runCli = (): void => {
  const [command, ...args] = process.argv.slice(2);

  if (command === "derive-workers-url") {
    const result = deriveWorkersDevPanel(getArg(args, "--worker-name"), getArg(args, "--input"));
    process.stdout.write(`${result.accountSubdomain}\t${result.appUrl}\n`);
    return;
  }

  if (command === "validate-custom-url") {
    process.stdout.write(`${validateCustomPanelUrl(getArg(args, "--url"))}\n`);
    return;
  }

  if (command === "validate-env") {
    const result = validatePanelHostingEnvironment(
      readEnvFile(getArg(args, "--env-file")),
      getArg(args, "--worker-name")
    );
    process.stdout.write(
      `${result.mode}\t${result.appUrl}\t${result.workersDevEnabled ? "true" : "false"}\t${result.dnsManagement ?? "none"}\n`
    );
    return;
  }

  if (command === "prepare-config") {
    prepareWranglerDeployConfig({
      sourcePath: getArg(args, "--source"),
      outputPath: getArg(args, "--output"),
      runtimeStateSnapshotKvId: getArg(args, "--kv-id"),
      runtimeStateSnapshotKvPreviewId: getArg(args, "--kv-preview-id"),
      panelHostingMode: getArg(args, "--mode") as PanelHostingMode,
      customWorkersDevEnabled: getArg(args, "--custom-workers-dev") === "true",
      lifecycleLockTableName: getArg(args, "--lifecycle-lock-table"),
      operationStateTableName: getArg(args, "--operation-state-table"),
    });
    return;
  }

  if (command === "deployment-args") {
    const deploymentArgs = buildWranglerDeployArgs({
      configPath: getArg(args, "--config"),
      workerName: getArg(args, "--worker-name"),
      panelHostingMode: getArg(args, "--mode") as PanelHostingMode,
      customHostname: args.includes("--hostname") ? getArg(args, "--hostname") : undefined,
    });
    process.stdout.write(`${deploymentArgs.join("\n")}\n`);
    return;
  }

  throw new Error(`Unknown panel-hosting command: ${String(command)}`);
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
