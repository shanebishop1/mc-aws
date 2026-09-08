import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { AUTH_SECRET_REQUIREMENTS, validateProductionAuthSecret } from "../../lib/auth-secret";

const STATE_SCHEMA_VERSION = 1;

interface AuthSecretRotationState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  status: "prepared";
  candidate: string;
  candidateSha256: string;
}

export interface ManageAuthSecretOptions {
  envFile: string;
  secondaryEnvFile?: string;
  rotate: boolean;
  randomBytes?: (size: number) => Buffer;
}

const statePathFor = (envFile: string): string => `${envFile}.mc-aws-auth-rotation.json`;

const pathExists = (filePath: string): boolean => {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const assertRegularFile = (filePath: string, required: boolean): void => {
  if (!pathExists(filePath)) {
    if (required) throw new Error(`Environment file not found: ${filePath}`);
    return;
  }
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Refusing unsafe auth-secret state path: ${filePath}`);
  }
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const readEnvironmentValue = (envFile: string): string | undefined => {
  assertRegularFile(envFile, false);
  if (!pathExists(envFile)) return undefined;
  return dotenv.parse(readFileSync(envFile, "utf8")).AUTH_SECRET;
};

const writeAtomically = (filePath: string, contents: string): void => {
  assertRegularFile(filePath, false);
  const temporary = `${filePath}.tmp`;
  if (pathExists(temporary)) unlinkSync(temporary);
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
};

const replaceAuthSecret = (contents: string, value: string): string => {
  const lines = contents.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!/^\s*(?:export\s+)?AUTH_SECRET\s*=/.test(line)) return line;
    if (replaced) return null;
    replaced = true;
    return `AUTH_SECRET=${value}`;
  });

  const withoutDuplicates = updated.filter((line): line is string => line !== null);
  if (!replaced) withoutDuplicates.push(`AUTH_SECRET=${value}`);
  return `${withoutDuplicates.join("\n").replace(/\n+$/, "")}\n`;
};

const persistSecret = (envFile: string, value: string): void => {
  const contents = pathExists(envFile) ? readFileSync(envFile, "utf8") : "";
  writeAtomically(envFile, replaceAuthSecret(contents, value));
};

const readRotationState = (statePath: string): AuthSecretRotationState | undefined => {
  if (!pathExists(statePath)) return undefined;
  assertRegularFile(statePath, true);
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error("Refusing malformed AUTH_SECRET rotation state.");
  }
  if (
    !state ||
    typeof state !== "object" ||
    (state as AuthSecretRotationState).schemaVersion !== STATE_SCHEMA_VERSION ||
    (state as AuthSecretRotationState).status !== "prepared" ||
    typeof (state as AuthSecretRotationState).candidate !== "string" ||
    typeof (state as AuthSecretRotationState).candidateSha256 !== "string" ||
    !validateProductionAuthSecret((state as AuthSecretRotationState).candidate).valid ||
    (state as AuthSecretRotationState).candidateSha256 !== sha256((state as AuthSecretRotationState).candidate)
  ) {
    throw new Error("Refusing invalid AUTH_SECRET rotation state.");
  }
  return state as AuthSecretRotationState;
};

const writeRotationState = (statePath: string, candidate: string): void => {
  const state: AuthSecretRotationState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: "prepared",
    candidate,
    candidateSha256: sha256(candidate),
  };
  writeAtomically(statePath, `${JSON.stringify(state)}\n`);
};

const generateCanonicalSecret = (randomBytesFn: (size: number) => Buffer): string => {
  const candidate = randomBytesFn(48).toString("base64url");
  if (!validateProductionAuthSecret(candidate).valid) throw new Error("Generated AUTH_SECRET failed validation.");
  return candidate;
};

export const ensureAuthSecret = (options: ManageAuthSecretOptions): "unchanged" | "prepared" => {
  const { envFile, secondaryEnvFile, rotate } = options;
  const statePath = statePathFor(envFile);
  const current = readEnvironmentValue(envFile);
  const state = readRotationState(statePath);

  if (state && !rotate) {
    throw new Error("An AUTH_SECRET rotation is pending; rerun with MC_AWS_ROTATE_AUTH_SECRET=1.");
  }

  if (!rotate && validateProductionAuthSecret(current).valid) return "unchanged";
  if (!rotate) throw new Error(AUTH_SECRET_REQUIREMENTS);

  const candidate = state?.candidate ?? generateCanonicalSecret(options.randomBytes ?? randomBytes);
  if (!state) writeRotationState(statePath, candidate);

  // The state journal is written before either dotenv file. If interrupted, the
  // next run repairs both files and deploys this exact candidate instead of
  // generating a second value.
  persistSecret(envFile, candidate);
  if (secondaryEnvFile) persistSecret(secondaryEnvFile, candidate);
  return "prepared";
};

export const completeAuthSecretRotation = (envFile: string): void => {
  const statePath = statePathFor(envFile);
  const state = readRotationState(statePath);
  if (!state) return;
  if (readEnvironmentValue(envFile) !== state.candidate) {
    throw new Error("AUTH_SECRET rotation state does not match the persisted deployment value.");
  }
  unlinkSync(statePath);
};

const getArg = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const runCli = (): void => {
  const [command, ...args] = process.argv.slice(2);
  const envFile = getArg(args, "--env-file");
  if (!envFile) throw new Error("Missing required argument: --env-file");

  if (command === "ensure") {
    ensureAuthSecret({
      envFile: path.resolve(envFile),
      secondaryEnvFile:
        getArg(args, "--secondary-env-file") && path.resolve(getArg(args, "--secondary-env-file") as string),
      rotate: getArg(args, "--rotate") === "1",
    });
    return;
  }
  if (command === "complete") {
    completeAuthSecretRotation(path.resolve(envFile));
    return;
  }
  throw new Error(`Unknown auth-secret command: ${String(command)}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
