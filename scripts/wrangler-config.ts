import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const parseJsoncObject = (source: string, sourceName = "wrangler.jsonc"): Record<string, unknown> => {
  const parsed = ts.parseConfigFileTextToJson(sourceName, source);
  if (parsed.error) {
    const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n");
    throw new Error(`Invalid JSONC in ${sourceName}: ${message}`);
  }
  if (!parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
    throw new Error(`Invalid JSONC in ${sourceName}: expected one object.`);
  }
  return parsed.config as Record<string, unknown>;
};

export const readWranglerConfig = (configPath: string): Record<string, unknown> => {
  const absolutePath = path.resolve(configPath);
  return parseJsoncObject(fs.readFileSync(absolutePath, "utf8"), absolutePath);
};

export const readWranglerWorkerName = (configPath: string): string => {
  const name = readWranglerConfig(configPath).name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`${configPath} does not define a nonempty Worker name.`);
  }
  return name.trim();
};

const runCli = (): void => {
  const [command, configPath = "wrangler.jsonc"] = process.argv.slice(2);
  if (command === "worker-name") {
    process.stdout.write(readWranglerWorkerName(configPath));
    return;
  }
  if (command === "validate") {
    readWranglerConfig(configPath);
    return;
  }
  throw new Error(`Unknown wrangler-config command: ${String(command)}`);
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
