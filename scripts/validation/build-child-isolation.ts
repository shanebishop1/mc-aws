import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { constants, chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import * as path from "node:path";

const inheritedAllowlist = ["PATH", "LANG", "LC_ALL", "TZ", "SOURCE_DATE_EPOCH", "CI", "TERM"] as const;
const forbiddenOverride =
  /^(?:AUTH_SECRET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|CLOUDFLARE_.*TOKEN|GITHUB_TOKEN|GOOGLE_CLIENT_SECRET|GDRIVE_PASSWORD|DUCKDNS_TOKEN|CREDENTIALS_DIRECTORY|HOME|NODE_OPTIONS)$/;
const allowedOverrides = new Set([
  "NODE_ENV",
  "MC_BACKEND_MODE",
  "MC_MOCK_STATE_PATH",
  "ENABLE_DEV_LOGIN",
  "ADMIN_EMAIL",
  "GOOGLE_CLIENT_ID",
  "NEXT_PUBLIC_APP_URL",
  "MC_LIFECYCLE_LOCK_TABLE_NAME",
  "MC_OPERATION_STATE_TABLE_NAME",
  "MC_AGENT_RUNTIME_ENABLED",
]);
const networkSandboxExecutable = "/usr/bin/unshare";

export interface IsolatedBuildEnvironmentOptions {
  home: string;
  tmpdir: string;
  overrides?: Readonly<Record<string, string>>;
  sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Only test harnesses may explicitly request the defense-in-depth-only path. */
  networkSandbox?: "required" | "test-only";
}

const ensurePrivateDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Refusing unsafe build isolation directory: ${directory}`);
  chmodSync(directory, 0o700);
};

const validateFixedExecutable = (candidate: string): string => {
  const resolved = realpathSync(candidate);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) {
    throw new Error(`Refusing unsafe build executable: ${candidate}`);
  }
  // Preserve the original argv[0] for version-manager shims, but validate the
  // immutable target rather than trusting a mutable PATH entry.
  return candidate;
};

const resolveBuildExecutable = (
  command: string,
  sourceEnvironment: Readonly<Record<string, string | undefined>>
): string => {
  const candidates = command.includes(path.sep)
    ? [command]
    : [
        ...(command === "python3" ? ["/usr/bin/python3"] : []),
        ...(sourceEnvironment.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, command)),
      ];
  for (const candidate of candidates) {
    try {
      return validateFixedExecutable(candidate);
    } catch {
      // Continue only through the explicitly supplied PATH entries.
    }
  }
  throw new Error(`No fixed validated executable was found for build command: ${command}`);
};

/**
 * Build children inherit only this allowlist. Dead proxies and the Node preload
 * are defense-in-depth; production children additionally require an actual
 * kernel network namespace, established by spawnIsolatedBuildChild below.
 */
export const isolatedBuildEnvironment = (root: string, options: IsolatedBuildEnvironmentOptions): NodeJS.ProcessEnv => {
  const resolvedRoot = path.resolve(root);
  const home = path.resolve(options.home);
  const tmpdir = path.resolve(options.tmpdir);
  ensurePrivateDirectory(home);
  ensurePrivateDirectory(tmpdir);
  const source = options.sourceEnvironment ?? process.env;
  const inheritedNodeEnvironment = source.NODE_ENV;
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV:
      inheritedNodeEnvironment === "development" || inheritedNodeEnvironment === "test"
        ? inheritedNodeEnvironment
        : "production",
  };
  for (const key of inheritedAllowlist) {
    if (source[key]) environment[key] = source[key];
  }
  if (!environment.PATH) throw new Error("Isolated build requires an explicit PATH.");
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || forbiddenOverride.test(key) || !allowedOverrides.has(key)) {
      throw new Error(`Refusing forbidden isolated build environment override: ${key}`);
    }
    environment[key] = value;
  }
  const deadProxy = "http://127.0.0.1:9";
  return {
    ...environment,
    HOME: home,
    TMPDIR: tmpdir,
    NODE_OPTIONS: `--require=${path.join(resolvedRoot, "scripts/validation/deny-build-network.cjs")}`,
    HTTP_PROXY: deadProxy,
    HTTPS_PROXY: deadProxy,
    ALL_PROXY: deadProxy,
    http_proxy: deadProxy,
    https_proxy: deadProxy,
    all_proxy: deadProxy,
    NO_PROXY: "",
    no_proxy: "",
    MC_AWS_BUILD_ISOLATION: "1",
    MC_AWS_BUILD_NETWORK_ISOLATION: "pending-os-network-namespace",
  };
};

export interface IsolatedBuildChildOptions extends IsolatedBuildEnvironmentOptions {
  cwd?: string;
  output?: "inherit" | "pipe";
}

/**
 * A private PID namespace makes the build command PID 1. When it exits—or the
 * outer unshare process is killed—the kernel removes every descendant,
 * including children that detached their session or process group.
 */
export const productionBuildNamespaceArguments = (executable: string, args: readonly string[]): string[] => [
  "--user",
  "--map-root-user",
  "--net",
  "--pid",
  "--fork",
  "--kill-child=KILL",
  "--mount-proc",
  "--",
  executable,
  ...args,
];

/** Spawn with an exact three-entry stdio map; no inherited descriptor above fd 2 is passed. */
export const spawnIsolatedBuildChild = (
  command: string,
  args: readonly string[],
  root: string,
  options: IsolatedBuildChildOptions
): SpawnSyncReturns<string> => {
  const output = options.output ?? "inherit";
  const source = options.sourceEnvironment ?? process.env;
  const executable = resolveBuildExecutable(command, source);
  const environment = isolatedBuildEnvironment(root, options);
  if (options.networkSandbox === "test-only" && (process.env.NODE_ENV !== "test" || source.NODE_ENV !== "test")) {
    throw new Error("The unsandboxed build-child test path is unavailable outside the NODE_ENV=test harness.");
  }
  const productionBuild = environment.NODE_ENV === "production" && options.networkSandbox !== "test-only";
  const spawnArguments = productionBuild ? productionBuildNamespaceArguments(executable, args) : [...args];
  const spawnCommand = productionBuild ? validateFixedExecutable(networkSandboxExecutable) : executable;
  if (productionBuild) environment.MC_AWS_BUILD_NETWORK_ISOLATION = "os-unshare-user+net";
  else environment.MC_AWS_BUILD_NETWORK_ISOLATION = "test-only-defense-in-depth";
  return spawnSync(spawnCommand, spawnArguments, {
    cwd: options.cwd ?? root,
    env: environment,
    encoding: "utf8",
    stdio: output === "pipe" ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
  });
};

export const requireSuccessfulIsolatedBuildChild = (
  command: string,
  args: readonly string[],
  root: string,
  options: IsolatedBuildChildOptions
): string => {
  const result = spawnIsolatedBuildChild(command, args, root, { ...options, output: options.output ?? "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Isolated build child failed (${command}, exit ${String(result.status)}): ${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
};
