import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeStateWranglerSchema, validateRuntimeStateWranglerConfig } from "@/lib/runtime-config-schema";
import dotenv from "dotenv";

interface CliArgs {
  envFile: string;
  wranglerConfig: string;
}

interface RuntimeStateEnv {
  runtimeStateSnapshotKvId: string;
  runtimeStateSnapshotKvPreviewId: string;
}

const parseCliArgs = (argv: string[]): CliArgs => {
  let envFile = ".env.production";
  let wranglerConfig = "wrangler.jsonc";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--env-file") {
      envFile = argv[index + 1] ?? envFile;
      index += 1;
      continue;
    }

    if (arg === "--wrangler-config") {
      wranglerConfig = argv[index + 1] ?? wranglerConfig;
      index += 1;
    }
  }

  return {
    envFile,
    wranglerConfig,
  };
};

const loadEnvValues = (envFile: string): RuntimeStateEnv => {
  const envPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Environment file not found: ${envPath}`);
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  const runtimeStateSnapshotKvId = parsed.RUNTIME_STATE_SNAPSHOT_KV_ID?.trim() ?? "";
  const runtimeStateSnapshotKvPreviewId =
    parsed.RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID?.trim() || runtimeStateSnapshotKvId;

  return {
    runtimeStateSnapshotKvId,
    runtimeStateSnapshotKvPreviewId,
  };
};

const parseWranglerConfig = (wranglerConfigPath: string): Record<string, unknown> => {
  const absolutePath = path.resolve(process.cwd(), wranglerConfigPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Wrangler config not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf8");
  const start = raw.indexOf("{");

  if (start === -1) {
    throw new Error("Invalid wrangler config: expected JSON object.");
  }

  try {
    return JSON.parse(raw.slice(start)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Invalid wrangler config JSON: ${message}`);
  }
};

const withRuntimeStateIds = (
  config: Record<string, unknown>,
  runtimeStateSnapshotKvId: string,
  runtimeStateSnapshotKvPreviewId: string
): Record<string, unknown> => {
  const clone = structuredClone(config);
  const kvNamespaces = Array.isArray(clone.kv_namespaces) ? clone.kv_namespaces : [];

  for (const entry of kvNamespaces) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const binding = (entry as { binding?: unknown }).binding;
    if (binding !== runtimeStateWranglerSchema.snapshotKvBindingName) {
      continue;
    }

    (entry as { id?: string }).id = runtimeStateSnapshotKvId;
    (entry as { preview_id?: string }).preview_id = runtimeStateSnapshotKvPreviewId;
  }

  return clone;
};

export const validateRuntimeStateDeploySetup = ({ envFile, wranglerConfig }: CliArgs): void => {
  const { runtimeStateSnapshotKvId, runtimeStateSnapshotKvPreviewId } = loadEnvValues(envFile);
  const parsedConfig = parseWranglerConfig(wranglerConfig);
  const configWithRuntimeState = withRuntimeStateIds(
    parsedConfig,
    runtimeStateSnapshotKvId,
    runtimeStateSnapshotKvPreviewId
  );

  const report = validateRuntimeStateWranglerConfig(configWithRuntimeState);

  if (!report.isValid) {
    const errorLines = report.errors.map((error) => `  - ${error}`).join("\n");
    throw new Error(
      [
        "Runtime-state deploy setup is incomplete.",
        errorLines,
        "Action: create KV namespace ids, set RUNTIME_STATE_SNAPSHOT_KV_ID (and optional RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID), and ensure wrangler.jsonc has runtime-state durable object + migration bindings.",
      ].join("\n")
    );
  }
};

const args = parseCliArgs(process.argv.slice(2));
const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  validateRuntimeStateDeploySetup(args);
  console.log("[DEPLOY PREFLIGHT] ✅ Runtime-state Wrangler setup is valid.");
}
