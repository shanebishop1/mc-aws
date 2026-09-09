import { isIP } from "node:net";
import path from "node:path";
import type {
  ImmutableBoundaryFacts,
  RiskFacts,
  ShellCommand,
  TargetScope,
  ToolInvocation,
} from "@/lib/agent/contracts";
import type { CanonicalPath, DirectLiveExecutorConfig, DirectLiveHostEffects } from "@/lib/agent/executor/types";
import { isImmutableAgentAssetDirectory, isImmutableAgentAssetPath } from "@/lib/agent/immutable-assets";
import {
  DEFAULT_PERSISTENT_WORLD_ROOTS,
  isPersistentWorldMutation,
  isRootServerPropertiesMutation,
} from "@/lib/agent/minecraft-security";
import {
  type NetworkDownloadExpectation,
  exactNetworkDownloadResource,
  networkDownloadApprovalScope,
  normalizeNetworkDownloadUrl,
  validateNetworkDownloadExpectation,
} from "@/lib/agent/network-download";
import { LOW_RISK_FACTS, NO_IMMUTABLE_BOUNDARY_VIOLATIONS } from "@/lib/agent/policy";
import { redactSensitiveText } from "@/lib/agent/redaction";

const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec", "setcap", "capsh", "unshare", "nsenter"]);
const SERVICE_COMMANDS = new Set(["systemctl", "service", "rc-service", "initctl"]);
const PACKAGE_COMMANDS = new Set([
  "apt",
  "apt-get",
  "aptitude",
  "dpkg",
  "dnf",
  "yum",
  "rpm",
  "apk",
  "pacman",
  "zypper",
  "snap",
  "flatpak",
]);
const SHELL_COMMANDS = new Set(["sh", "bash", "dash", "zsh", "fish", "csh", "ksh"]);
const INTERPRETER_COMMANDS = new Set(["node", "python", "python3", "perl", "ruby", "php", "lua"]);
const AWS_COMMANDS = new Set(["aws", "sam", "cdk"]);
const CONSOLE_BRIDGE_COMMANDS = new Set(["screen", "tmux", "mcrcon", "rcon-cli"]);
const FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);
const CONSOLE_READ_ONLY = new Set(["help", "list", "seed", "version", "tps"]);
const CONSOLE_EPHEMERAL = new Set(["me", "msg", "particle", "playsound", "say", "stopsound", "tell", "title", "w"]);
const CONSOLE_DESTRUCTIVE = new Set([
  "ban",
  "ban-ip",
  "banlist",
  "clear",
  "clone",
  "deop",
  "fill",
  "give",
  "kick",
  "kill",
  "op",
  "pardon",
  "pardon-ip",
  "save-all",
  "save-off",
  "setblock",
  "stop",
  "summon",
  "teleport",
  "tp",
  "whitelist",
]);
const CONSOLE_PERMISSION_ADMINISTRATION = new Set([
  "op",
  "deop",
  "permission",
  "permissions",
  "perm",
  "perms",
  "luckperms",
  "lp",
  "pex",
]);
const METADATA = /(?:169\.254\.169\.254|fd00:ec2::254|instance-data(?:\.ec2)?\.internal)/i;
const AWS_ENDPOINT = /(?:^|\.)amazonaws\.com$|(?:^|\.)aws\.amazon\.com$/i;
const SECRET_PATH =
  /(?:^|\/)(?:\.aws|credentials?|secrets?|systemd\/credentials|opt\/setup|etc\/minecraft|amazon\/ssm)(?:\/|$)/i;
const MINECRAFT_ACCESS_CONTROL_FILES = new Set([
  "allowlist.json",
  "banned-ips.json",
  "banned-players.json",
  "ops.json",
  "permissions.json",
  "permissions.yml",
  "usercache.json",
  "whitelist.json",
]);
const PERMISSION_PLUGIN_DIRECTORIES = new Set(["GroupManager", "LuckPerms", "PermissionsEx"]);
export const MAX_SHELL_COMMAND_BYTES = 16 * 1024;
export const MAX_SHELL_TIMEOUT_MS = 120_000;

export class ExecutorGuardError extends Error {
  constructor(
    message: string,
    readonly boundary: keyof ImmutableBoundaryFacts
  ) {
    super(message);
    this.name = "ExecutorGuardError";
  }
}

function canonicalRegularFileTarget(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ExecutorGuardError(
      "Shell change path must be canonical and workspace-relative.",
      "targetOutsideAllowedRoots"
    );
  }
  return value;
}

/** Strict parser for the public shell capability. It intentionally does not inspect command names. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This parser is the strict shell contract boundary and intentionally validates every field fail-closed.
export function parseShellCommand(value: unknown): ShellCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ExecutorGuardError("Shell arguments must be an object.", "targetOutsideAllowedRoots");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.some((key) => !["mode", "command", "timeoutMs", "change"].includes(key)))
    throw new ExecutorGuardError("Shell arguments contain an unknown field.", "targetOutsideAllowedRoots");
  if (item.mode !== "read-only" && item.mode !== "staged-write")
    throw new ExecutorGuardError("Shell mode is invalid.", "targetOutsideAllowedRoots");
  if (
    typeof item.command !== "string" ||
    item.command.length === 0 ||
    Buffer.byteLength(item.command, "utf8") > MAX_SHELL_COMMAND_BYTES ||
    item.command.includes("\0")
  )
    throw new ExecutorGuardError("Shell command is empty, oversized, or contains NUL.", "targetOutsideAllowedRoots");
  if (
    !Number.isSafeInteger(item.timeoutMs) ||
    (item.timeoutMs as number) < 1 ||
    (item.timeoutMs as number) > MAX_SHELL_TIMEOUT_MS
  )
    throw new ExecutorGuardError("Shell timeout is outside its bound.", "targetOutsideAllowedRoots");
  if (item.mode === "read-only" && item.change !== undefined)
    throw new ExecutorGuardError("Read-only shell cannot declare a change.", "targetOutsideAllowedRoots");
  if (item.mode === "staged-write") {
    const change = item.change;
    if (change === null || typeof change !== "object" || Array.isArray(change))
      throw new ExecutorGuardError("Staged-write shell requires one change.", "targetOutsideAllowedRoots");
    const changeObject = change as Record<string, unknown>;
    if (Object.keys(changeObject).some((key) => !["operation", "path"].includes(key)))
      throw new ExecutorGuardError("Shell change contains an unknown field.", "targetOutsideAllowedRoots");
    if (changeObject.operation !== "replace" && changeObject.operation !== "delete")
      throw new ExecutorGuardError("Shell change operation is invalid.", "targetOutsideAllowedRoots");
    canonicalRegularFileTarget(changeObject.path);
  }
  return structuredClone(item) as unknown as ShellCommand;
}

export function contained(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative));
}

function requestedPath(root: string, value: string): string {
  if (!value || value.includes("\0") || value.includes("\\"))
    throw new ExecutorGuardError("Unsafe path syntax.", "targetOutsideAllowedRoots");
  if (value.split("/").includes(".."))
    throw new ExecutorGuardError("Parent path traversal is not allowed.", "targetOutsideAllowedRoots");
  return path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(root, value);
}

export async function resolveConfinedPath(
  effects: DirectLiveHostEffects,
  root: string,
  value: string,
  allowedKinds: readonly CanonicalPath["kind"][]
): Promise<CanonicalPath> {
  const lexical = requestedPath(root, value);
  if (!contained(root, lexical))
    throw new ExecutorGuardError("Path traversal escaped the allowed root.", "targetOutsideAllowedRoots");
  const resolved = await effects.canonicalize(lexical);
  if (!contained(root, resolved.path))
    throw new ExecutorGuardError("Canonical path or symlink escaped the allowed root.", "targetOutsideAllowedRoots");
  if (resolved.kind === "symlink")
    throw new ExecutorGuardError("Unresolved symlinks are not allowed.", "targetOutsideAllowedRoots");
  if (!allowedKinds.includes(resolved.kind))
    throw new ExecutorGuardError(`Unsupported ${resolved.kind} workspace entry.`, "targetOutsideAllowedRoots");
  return resolved;
}

export function scopeForPath(kind: TargetScope["kind"], root: string, canonical: string): TargetScope {
  return { schemaVersion: 1, kind, normalizedTarget: path.posix.relative(root, canonical) || "." };
}

export function scopeForDownload(
  url: URL,
  destination: TargetScope,
  expectation: NetworkDownloadExpectation
): TargetScope {
  return networkDownloadApprovalScope(exactNetworkDownloadResource(url.toString()), destination, expectation);
}

export function assertScope(actual: TargetScope, expected: TargetScope): void {
  if (actual.kind !== expected.kind || actual.normalizedTarget !== expected.normalizedTarget)
    throw new ExecutorGuardError(
      "Invocation target scope does not match its canonical target.",
      "targetOutsideAllowedRoots"
    );
}

function textBoundary(text: string): keyof ImmutableBoundaryFacts | undefined {
  if (METADATA.test(text)) return "accessesInstanceMetadata";
  if (SECRET_PATH.test(text))
    return /backup|drive/i.test(text) ? "accessesBackupProviderSecrets" : "accessesDeploymentSecrets";
  if (/AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)|\/root(?:\/|$)/i.test(text))
    return text.includes("/root") ? "requestsRoot" : "accessesAwsApisOrCredentials";
  return undefined;
}

function commandName(value: string): string {
  const withoutSlash = value.startsWith("/") ? value.slice(1) : value;
  const separator = withoutSlash.lastIndexOf(":");
  return (separator < 0 ? withoutSlash : withoutSlash.slice(separator + 1)).toLowerCase();
}

function commandNamespace(value: string): string | undefined {
  const withoutSlash = value.startsWith("/") ? value.slice(1) : value;
  const separator = withoutSlash.lastIndexOf(":");
  return separator < 0 ? undefined : withoutSlash.slice(0, separator).toLowerCase();
}

export interface MinecraftCommandInspection {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly permissionAdministration: boolean;
}

/** Parses the command that Minecraft will execute, including namespaced and recursively nested execute/run forms. */
export function inspectMinecraftCommand(command: string): MinecraftCommandInspection {
  const inspect = (value: string, depth: number): MinecraftCommandInspection => {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    const commandToken = tokens[0] ?? "";
    const name = commandName(commandToken);
    if (!name || depth > 16) return { readOnly: false, destructive: true, permissionAdministration: false };
    const namespace = commandNamespace(commandToken);
    const trustedNamespace = namespace === undefined || namespace === "minecraft";
    const ownPermissionAdministration = CONSOLE_PERMISSION_ADMINISTRATION.has(name);
    const ownDestructive =
      !trustedNamespace ||
      name === "execute" ||
      (!CONSOLE_READ_ONLY.has(name) && !CONSOLE_EPHEMERAL.has(name)) ||
      CONSOLE_DESTRUCTIVE.has(name) ||
      ownPermissionAdministration;
    if (name !== "execute") {
      return {
        readOnly: trustedNamespace && CONSOLE_READ_ONLY.has(name),
        destructive: ownDestructive,
        permissionAdministration: ownPermissionAdministration,
      };
    }
    const run = tokens.findIndex((token, index) => index > 0 && commandName(token) === "run");
    if (run < 0 || run === tokens.length - 1) {
      return { readOnly: false, destructive: ownDestructive, permissionAdministration: ownPermissionAdministration };
    }
    const nested = inspect(tokens.slice(run + 1).join(" "), depth + 1);
    return {
      readOnly: nested.readOnly,
      destructive: ownDestructive || nested.destructive,
      permissionAdministration: ownPermissionAdministration || nested.permissionAdministration,
    };
  };
  return inspect(command, 0);
}

function hasParentTraversal(value: string): boolean {
  return value.includes("\\") || value.split("/").includes("..");
}

function isFindLike(name: string, args: readonly string[]): boolean {
  return name === "find" || name.endsWith("-find") || (["busybox", "toybox"].includes(name) && args[0] === "find");
}

function commandPathsEscapeWorkspace(args: readonly string[], workspaceRoot: string): boolean {
  return args.some((arg) => {
    if (arg.includes("\0") || hasParentTraversal(arg)) return true;
    const absoluteFragments = [arg, ...(arg.match(/(?:^|=)(\/[^\s,;]*)/g) ?? [])]
      .map((fragment) => fragment.slice(fragment.lastIndexOf("=") + 1))
      .filter((fragment) => fragment.startsWith("/") && !fragment.startsWith("//"));
    return absoluteFragments.some((fragment) => !contained(workspaceRoot, path.posix.normalize(fragment)));
  });
}

/** Defense-in-depth validation repeated by the production host adapter immediately before command execution. */
export function assertWorkspaceProcessRequest(
  executable: string,
  args: readonly string[],
  workspaceRoot: string
): void {
  const name = path.posix.basename(executable).toLowerCase();
  if (CONSOLE_BRIDGE_COMMANDS.has(name)) {
    throw new ExecutorGuardError(
      "Console bridge commands are unavailable to shell tools.",
      "targetOutsideAllowedRoots"
    );
  }
  if (commandPathsEscapeWorkspace(args, workspaceRoot)) {
    throw new ExecutorGuardError("Shell command arguments escaped the workspace root.", "targetOutsideAllowedRoots");
  }
  if (isFindLike(name, args) && args.some((arg) => FIND_ACTIONS.has(arg.toLowerCase()))) {
    throw new ExecutorGuardError("Mutating or executable find actions are forbidden.", "targetOutsideAllowedRoots");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Command inspection intentionally accumulates every immutable boundary before policy evaluation.
export function inspectCommand(
  executable: string,
  args: string[],
  config: DirectLiveExecutorConfig
): ImmutableBoundaryFacts {
  const facts = { ...NO_IMMUTABLE_BOUNDARY_VIOLATIONS };
  const name = path.posix.basename(executable).toLowerCase();
  const commandText = [executable, ...args].join(" ");
  const words = new Set(commandText.toLowerCase().split(/[^a-z0-9_.-]+/));
  try {
    assertWorkspaceProcessRequest(executable, args, config.workspaceRoot ?? "/opt/minecraft/server");
  } catch (error) {
    if (error instanceof ExecutorGuardError) facts[error.boundary] = true;
    else throw error;
  }
  if (
    PRIVILEGE_COMMANDS.has(name) ||
    [...PRIVILEGE_COMMANDS].some((command) => words.has(command)) ||
    args.some((arg) => /^(?:--user=?(?:root|0)|-u0)$/.test(arg))
  )
    facts.requestsRoot = true;
  if (
    SERVICE_COMMANDS.has(name) ||
    PACKAGE_COMMANDS.has(name) ||
    [...SERVICE_COMMANDS, ...PACKAGE_COMMANDS].some((command) => words.has(command))
  )
    facts.administersHostPackagesOrServices = true;
  if (AWS_COMMANDS.has(name) || [...AWS_COMMANDS].some((command) => words.has(command)))
    facts.accessesAwsApisOrCredentials = true;
  if (CONSOLE_BRIDGE_COMMANDS.has(name) || [...CONSOLE_BRIDGE_COMMANDS].some((command) => words.has(command)))
    facts.targetOutsideAllowedRoots = true;
  if (
    SHELL_COMMANDS.has(name) ||
    INTERPRETER_COMMANDS.has(name) ||
    [...SHELL_COMMANDS, ...INTERPRETER_COMMANDS].some((command) => words.has(command))
  )
    facts.requestsLinuxCapabilities = true;
  const boundary = textBoundary(commandText);
  if (boundary) facts[boundary] = true;
  if (!(name in (config.allowedExecutables ?? {})) || config.allowedExecutables?.[name] !== executable)
    facts.targetOutsideAllowedRoots = true;
  return facts;
}

export function validateDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = normalizeNetworkDownloadUrl(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download URL is invalid.";
    throw new ExecutorGuardError(
      message,
      /credential-free/.test(message) ? "accessesDeploymentSecrets" : "targetOutsideAllowedRoots"
    );
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (METADATA.test(host)) throw new ExecutorGuardError("Instance metadata is immutable.", "accessesInstanceMetadata");
  if (AWS_ENDPOINT.test(host))
    throw new ExecutorGuardError("AWS API endpoints are immutable.", "accessesAwsApisOrCredentials");
  if (host === "localhost" || host.endsWith(".localhost") || isIP(host) !== 0)
    throw new ExecutorGuardError("Literal and local network targets are not allowed.", "targetOutsideAllowedRoots");
  if (
    redactSensitiveText(exactNetworkDownloadResource(url.toString())) !== exactNetworkDownloadResource(url.toString())
  ) {
    throw new ExecutorGuardError("Secrets are not allowed in download resource paths.", "accessesDeploymentSecrets");
  }
  return url;
}

export function validateDownloadExpectation(value: unknown): NetworkDownloadExpectation {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).expectedSha256 !== "string" ||
    typeof (value as Record<string, unknown>).expectedBytes !== "number"
  ) {
    throw new ExecutorGuardError(
      "Every download requires an operator-supplied expected SHA-256 and exact byte size.",
      "targetOutsideAllowedRoots"
    );
  }
  try {
    return validateNetworkDownloadExpectation(value as NetworkDownloadExpectation);
  } catch (error) {
    throw new ExecutorGuardError(
      error instanceof Error ? error.message : "Download content identity is invalid.",
      "targetOutsideAllowedRoots"
    );
  }
}

/** Matches canonical, case-sensitive workspace paths rather than path-like substrings or encoded spellings. */
export function isMinecraftAccessControlPath(target: string): boolean {
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.posix.normalize(target) !== target
  ) {
    return false;
  }
  const segments = target.split("/");
  if (segments.length === 1) return MINECRAFT_ACCESS_CONTROL_FILES.has(segments[0]);
  return segments.length >= 3 && segments[0] === "plugins" && PERMISSION_PLUGIN_DIRECTORIES.has(segments[1]);
}

/**
 * Generic agent mutations may never cross the executable/runtime asset
 * boundary.  The reviewed profile/runtime rollout is intentionally outside
 * this tool path and has its own provenance, backup, fence, and approval
 * contract.
 */
export function isGenericImmutableAssetMutation(invocation: ToolInvocation): boolean {
  if (invocation.capability === "shell.execute" && invocation.arguments.mode === "staged-write") {
    const change = invocation.arguments.change;
    const target =
      change !== null && typeof change === "object" && !Array.isArray(change) && typeof change.path === "string"
        ? change.path
        : "";
    return isShellImmutableTarget(target);
  }
  if (
    invocation.targetScope.kind !== "workspace" ||
    !["workspace.write", "workspace.delete", "network.outbound"].includes(invocation.capability)
  )
    return false;
  if (isShellImmutableTarget(invocation.targetScope.normalizedTarget)) return true;
  if (isImmutableAgentAssetPath(invocation.targetScope.normalizedTarget)) return true;
  return invocation.capability === "workspace.delete" && invocation.arguments.recursive === true
    ? isImmutableAgentAssetDirectory(invocation.targetScope.normalizedTarget)
    : false;
}

/** Shell output may never replace executable, datapack, function, or plugin runtime code. */
export function isShellImmutableTarget(target: string): boolean {
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.posix.normalize(target) !== target ||
    target.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return false;
  const parts = target.split("/");
  if (parts.some((part) => part === "datapacks" || part === "functions")) return true;
  if (parts[0] === "scripts") return true;
  if (parts[0] === "plugins" && parts.length > 1) return true;
  return isImmutableAgentAssetPath(target);
}

export function riskFacts(
  invocation: ToolInvocation,
  consoleMutation = false,
  persistentWorldRoots: readonly string[] = DEFAULT_PERSISTENT_WORLD_ROOTS
): RiskFacts {
  const facts = { ...LOW_RISK_FACTS };
  facts.mutation =
    invocation.capability === "workspace.write" ||
    invocation.capability === "workspace.delete" ||
    invocation.capability === "network.outbound";
  facts.consoleMutation = consoleMutation;
  const shellChange =
    invocation.capability === "shell.execute" &&
    invocation.arguments.mode === "staged-write" &&
    invocation.arguments.change !== null &&
    typeof invocation.arguments.change === "object" &&
    !Array.isArray(invocation.arguments.change) &&
    typeof invocation.arguments.change.path === "string"
      ? invocation.arguments.change.path
      : undefined;
  facts.executableOrConfigurationChange =
    invocation.capability === "extension.load" ||
    /(?:\.sh|\.jar|\.json|\.ya?ml|\.toml|\.properties)$/i.test(
      shellChange ?? String(invocation.targetScope.normalizedTarget)
    );
  facts.bulkOperation = invocation.capability === "workspace.delete" && invocation.arguments.recursive === true;
  facts.worldChange = isPersistentWorldMutation(invocation, persistentWorldRoots);
  if (invocation.capability === "console.execute") {
    const console = inspectMinecraftCommand(String(invocation.arguments.command));
    facts.worldChange = console.destructive;
    facts.permissionChange = console.permissionAdministration;
  }
  facts.permissionChange =
    facts.permissionChange ||
    isRootServerPropertiesMutation(invocation) ||
    (facts.mutation &&
      invocation.targetScope.kind === "workspace" &&
      isMinecraftAccessControlPath(invocation.targetScope.normalizedTarget)) ||
    (invocation.toolId === "shell.execute" &&
      [invocation.arguments.executable, ...(Array.isArray(invocation.arguments.args) ? invocation.arguments.args : [])]
        .join(" ")
        .match(/(?:^|\s)(?:chmod|chown)(?:\s|$)/) !== null);
  facts.broadMutation =
    facts.bulkOperation || (invocation.capability === "shell.execute" && invocation.arguments.mode === "staged-write");
  return facts;
}
