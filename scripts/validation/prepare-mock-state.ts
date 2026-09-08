import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LEGACY_MOCK_STATE_PATH = ".mock-state.json";
export const LEGACY_MOCK_STATE_MIGRATION_FLAG = "MC_MOCK_STATE_MIGRATE_LEGACY";

export interface MockStatePreparationEnvironment {
  readonly NODE_ENV?: string;
  readonly MC_BACKEND_MODE?: string;
  readonly MC_MOCK_STATE_MIGRATE_LEGACY?: string;
  readonly npm_lifecycle_event?: string;
}

function isProductionBuild(environment: MockStatePreparationEnvironment): boolean {
  return (
    environment.NODE_ENV === "production" ||
    environment.npm_lifecycle_event === "build" ||
    environment.npm_lifecycle_event === "prebuild"
  );
}

function assertRegularFile(filePath: string, description: string): void {
  if (!existsSync(filePath)) return;
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to use ${description}: it must be a regular file, not a symlink or special file.`);
  }
}

/**
 * Keep the historical root state file out of every build. Production never
 * removes it: a present file is treated as potentially sensitive user data
 * and fails closed. Moving it is available only as an explicit mock-mode
 * development operation.
 */
export function prepareMockState(
  root: string,
  environment: MockStatePreparationEnvironment = process.env
): "clean" | "migrated" {
  const legacyPath = path.join(root, LEGACY_MOCK_STATE_PATH);
  const destination = path.join(root, ".local-artifacts", "mock-state.json");
  if (!existsSync(legacyPath)) return "clean";

  assertRegularFile(legacyPath, "legacy repository-root mock state");
  if (isProductionBuild(environment)) {
    throw new Error(
      "Production build refused: repository-root .mock-state.json exists. It may contain credentials; " +
        "move it with the explicit development-only `pnpm mock:migrate` command, then rebuild."
    );
  }
  if (environment.MC_BACKEND_MODE?.trim().toLowerCase() !== "mock") {
    throw new Error("Legacy .mock-state.json migration requires MC_BACKEND_MODE=mock in a development/test process.");
  }
  if (environment[LEGACY_MOCK_STATE_MIGRATION_FLAG] !== "true") {
    throw new Error(
      "Legacy .mock-state.json was found. No data was changed; rerun the explicit development-only " +
        "`pnpm mock:migrate` command to move it under .local-artifacts."
    );
  }
  if (existsSync(destination)) {
    throw new Error(
      "Refusing to migrate legacy .mock-state.json because .local-artifacts/mock-state.json already exists; " +
        "review both files and choose a destination without overwriting either."
    );
  }

  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(legacyPath, destination);
  return "migrated";
}

function main(args = process.argv.slice(2)): void {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--migrate")) {
    throw new Error("Usage: pnpm mock:migrate");
  }
  const migrate = args[0] === "--migrate";
  const environment = migrate
    ? { ...process.env, MC_BACKEND_MODE: "mock", [LEGACY_MOCK_STATE_MIGRATION_FLAG]: "true" }
    : process.env;
  const result = prepareMockState(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), environment);
  console.log(
    result === "migrated" ? "Migrated legacy mock state into .local-artifacts." : "No legacy mock state found."
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
