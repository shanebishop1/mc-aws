import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const obsoleteWorkerSecretNames = [
  "CDK_DEFAULT_ACCOUNT",
  "CDK_DEFAULT_REGION",
  "GITHUB_USER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "KEY_PAIR_NAME",
  "VERIFIED_SENDER",
  "START_KEYWORD",
] as const;

interface WorkerSecretInventoryEntry {
  name: string;
}

export const parseWorkerSecretInventory = (source: string): WorkerSecretInventoryEntry[] => {
  const parsed: unknown = JSON.parse(source);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) => typeof entry !== "object" || entry === null || !("name" in entry) || typeof entry.name !== "string"
    )
  ) {
    throw new Error("Worker secret inventory must be a JSON array with string names");
  }

  return parsed;
};

export const buildObsoleteWorkerSecretDeletionPatch = (
  inventory: readonly WorkerSecretInventoryEntry[]
): Record<string, null> => {
  const existingSecretNames = new Set(inventory.map(({ name }) => name));
  return Object.fromEntries(
    obsoleteWorkerSecretNames.filter((name) => existingSecretNames.has(name)).map((name) => [name, null])
  );
};

const runCli = (): void => {
  if (process.argv[2] !== "merge-patch") {
    throw new Error(`Unknown legacy Worker secret policy command: ${String(process.argv[2])}`);
  }

  const inventory = parseWorkerSecretInventory(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(buildObsoleteWorkerSecretDeletionPatch(inventory)));
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
