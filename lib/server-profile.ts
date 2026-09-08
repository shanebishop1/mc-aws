import * as fs from "node:fs";
import * as path from "node:path";

export const PROFILE_MANIFEST_NAME = "plugins.lock.json";
export const DEFAULT_PROFILE_DIRECTORY = "config";
export const LOCAL_PROFILE_DIRECTORY = "server-profile";
export const PROFILE_LIMITS = {
  files: 2_000,
  directories: 512,
  pathDepth: 32,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
} as const;

/** Only these repository directories can be selected without an external approval. */
export const APPROVED_REPOSITORY_PROFILE_DIRECTORIES = [DEFAULT_PROFILE_DIRECTORY, LOCAL_PROFILE_DIRECTORY] as const;
export const APPROVED_EXTERNAL_PROFILE_ENV = "MC_SERVER_PROFILE_APPROVED_EXTERNAL_PATH";

const allowedRootFiles = new Set([
  "banned-ips.json",
  "banned-players.json",
  "bukkit.yml",
  "commands.yml",
  "eula.txt",
  "help.yml",
  "ops.json",
  "paper-global.yml",
  "paper-world-defaults.yml",
  "permissions.yml",
  PROFILE_MANIFEST_NAME,
  "server-icon.png",
  "server.properties",
  "spigot.yml",
  "usercache.json",
  "whitelist.json",
]);
// These tracked repository controls share config/ with the default profile but
// are never copied into the Minecraft asset. They are still scanned when config/
// is used as the source so a repository control file cannot smuggle secrets into
// the staging tree.
const repositorySupportFiles = new Set(["bootstrap-pins.json", "mise-pins.json"]);
const allowedDirectories = new Set([
  "config",
  "datapacks",
  "plugins",
  "resourcepacks",
  "world",
  "world_nether",
  "world_the_end",
]);
const allowedExtensions = new Set([
  ".cfg",
  ".conf",
  ".ini",
  ".json",
  ".json5",
  ".mcfunction",
  ".mcmeta",
  ".png",
  ".properties",
  ".toml",
  ".txt",
  ".yml",
  ".yaml",
]);

export interface PluginLockEntry {
  name: string;
  destination: string;
  url: string;
  sha256: string;
}

export interface PluginLock {
  version: 1;
  plugins: PluginLockEntry[];
}

export interface ValidatedServerProfile {
  directory: string;
  fileCount: number;
  totalBytes: number;
  plugins: PluginLockEntry[];
}

const forbiddenBasename = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    lower === ".agents" ||
    lower === ".git" ||
    lower === ".local-artifacts" ||
    lower === "rclone.conf" ||
    lower === "credentials" ||
    lower === "credentials.json" ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx") ||
    lower.endsWith(".jar") ||
    /^(?:\.env|env)(?:\.|$)/i.test(name) ||
    /^(?:\.?mock-state\.json)(?:\.|$)/i.test(name) ||
    /(?:^|[-_.])credentials?(?:$|[-_.])/i.test(name) ||
    /(?:^|[-_.])oauth(?:$|[-_.])/i.test(name)
  );
};

const exactObject = (value: unknown, keys: string[], context: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} has unknown or missing fields.`);
  }
  return record;
};

export function validatePluginLock(value: unknown): PluginLock {
  const root = exactObject(value, ["version", "plugins"], PROFILE_MANIFEST_NAME);
  if (root.version !== 1 || !Array.isArray(root.plugins)) {
    throw new Error(`${PROFILE_MANIFEST_NAME} must use version 1 and a plugins array.`);
  }
  const names = new Set<string>();
  const destinations = new Set<string>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict fail-closed schema checks remain together.
  const plugins = root.plugins.map((value, index): PluginLockEntry => {
    const entry = exactObject(value, ["name", "destination", "url", "sha256"], `plugins[${index}]`);
    if (typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) {
      throw new Error(`plugins[${index}].name is not safe.`);
    }
    if (typeof entry.destination !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jar$/.test(entry.destination)) {
      throw new Error(`plugins[${index}].destination must be one safe .jar basename.`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`plugins[${index}].sha256 must be an exact lowercase SHA-256.`);
    }
    if (typeof entry.url !== "string") throw new Error(`plugins[${index}].url must be a string.`);
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`plugins[${index}].url is invalid.`);
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !url.pathname ||
      url.pathname === "/" ||
      !url.pathname.toLowerCase().endsWith(".jar") ||
      entry.url !== url.toString()
    ) {
      throw new Error(`plugins[${index}].url must be canonical HTTPS without credentials, query, or fragment.`);
    }
    const normalizedName = entry.name.toLowerCase();
    const normalizedDestination = entry.destination.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`Duplicate plugin name: ${entry.name}.`);
    if (destinations.has(normalizedDestination)) throw new Error(`Duplicate plugin destination: ${entry.destination}.`);
    names.add(normalizedName);
    destinations.add(normalizedDestination);
    return { name: entry.name, destination: entry.destination, url: entry.url, sha256: entry.sha256 };
  });
  return { version: 1, plugins };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the two small Mojang list schemas are validated together.
function validatePlayerList(value: unknown, file: string): void {
  if (!Array.isArray(value)) throw new Error(`${file} must contain a JSON array.`);
  const allowed =
    file === "ops.json" ? new Set(["uuid", "name", "level", "bypassesPlayerLimit"]) : new Set(["uuid", "name"]);
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`${file}[${index}] must be an object.`);
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`${file}[${index}] has unknown fields.`);
    if (
      typeof record.uuid !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record.uuid)
    ) {
      throw new Error(`${file}[${index}].uuid is invalid.`);
    }
    if (typeof record.name !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(record.name)) {
      throw new Error(`${file}[${index}].name is invalid.`);
    }
    if (
      file === "ops.json" &&
      (!Number.isInteger(record.level) ||
        Number(record.level) < 1 ||
        Number(record.level) > 4 ||
        typeof record.bypassesPlayerLimit !== "boolean")
    ) {
      throw new Error(`${file}[${index}] has invalid operator fields.`);
    }
  }
}

const isWithin = (candidate: string, parent: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

function assertSecureExternalPath(directory: string, approvedRoot: string): void {
  if (!isWithin(directory, approvedRoot)) {
    throw new Error("MC_SERVER_PROFILE_DIR must resolve within the approved external profile path.");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let cursor = directory;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Approved external profile path must contain real directories.");
    if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) {
      throw new Error("Approved external profile path must be owned by the operator or root.");
    }
    if ((stat.mode & 0o022) !== 0) throw new Error("Approved external profile path has an insecure writable parent.");
    const parent = path.dirname(cursor);
    if (cursor === approvedRoot) break;
    if (parent === cursor) throw new Error("Approved external profile path has an invalid trust root.");
    cursor = parent;
  }
}

export function resolveServerProfileDirectory(
  rootDirectory: string,
  configured = process.env.MC_SERVER_PROFILE_DIR,
  approvedExternalPath = process.env[APPROVED_EXTERNAL_PROFILE_ENV]
): string {
  const root = fs.realpathSync(rootDirectory);
  const explicit = configured?.trim();
  const selected =
    explicit ||
    (fs.existsSync(path.join(root, LOCAL_PROFILE_DIRECTORY)) ? LOCAL_PROFILE_DIRECTORY : DEFAULT_PROFILE_DIRECTORY);
  const candidate = path.resolve(root, selected);
  if (!fs.existsSync(candidate)) throw new Error("MC_SERVER_PROFILE_DIR must point to an existing profile directory.");
  if (fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error("MC_SERVER_PROFILE_DIR must not be a symlink.");
  }
  const actual = fs.realpathSync(candidate);
  const approvedRepositoryDirectories = APPROVED_REPOSITORY_PROFILE_DIRECTORIES.filter((name) =>
    fs.existsSync(path.join(root, name))
  ).map((name) => fs.realpathSync(path.join(root, name)));
  if (approvedRepositoryDirectories.some((approvedRoot) => isWithin(actual, approvedRoot))) return actual;
  if (actual === root || actual === path.parse(actual).root || !explicit) {
    throw new Error(
      "MC_SERVER_PROFILE_DIR must select an approved profile subdirectory under config/ or server-profile/, not an arbitrary root."
    );
  }
  if (!approvedExternalPath?.trim()) {
    throw new Error(`External profiles require ${APPROVED_EXTERNAL_PROFILE_ENV} as explicit operator approval.`);
  }
  const approvedCandidate = path.resolve(root, approvedExternalPath.trim());
  if (!fs.existsSync(approvedCandidate) || fs.lstatSync(approvedCandidate).isSymbolicLink()) {
    throw new Error(`${APPROVED_EXTERNAL_PROFILE_ENV} must name an existing real directory.`);
  }
  const approved = fs.realpathSync(approvedCandidate);
  if (!isWithin(actual, approved)) {
    throw new Error("MC_SERVER_PROFILE_DIR must resolve within the approved external profile path.");
  }
  assertSecureExternalPath(actual, approved);
  return actual;
}

const containsForbiddenCredential = (descriptor: number): boolean => {
  const pattern =
    /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----|["']?\b(?:aws_(?:access_key_id|secret_access_key)|github_token|client[_-]?secret|access[_-]?token|refresh[_-]?token|oauth(?:[_-]?(?:token|secret|client))?|securestring|password|secret|token|api[_-]?key)["']?[ \t]*[:=][ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,}\]]+)/i;
  const buffer = Buffer.alloc(64 * 1024);
  let carry = "";
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (bytesRead === 0) return pattern.test(carry);
    position += bytesRead;
    const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
    if (pattern.test(text)) return true;
    carry = text.slice(-512);
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed path allowlisting is intentionally explicit.
function validateAllowlistedProfilePath(root: string, target: string, isDirectory: boolean): void {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0 || parts.length > PROFILE_LIMITS.pathDepth) {
    throw new Error(`Profile path is outside the allowlisted depth: ${relative || "."}.`);
  }
  const [topLevel] = parts;
  if (parts.length === 1 && isDirectory) {
    if (!allowedDirectories.has(topLevel.toLowerCase())) {
      throw new Error(`Profile directory is not an allowlisted Minecraft path: ${relative}.`);
    }
    return;
  }
  if (parts.length === 1 && !isDirectory) {
    if (!allowedRootFiles.has(topLevel.toLowerCase()) && !repositorySupportFiles.has(topLevel.toLowerCase())) {
      throw new Error(`Profile file is not an allowlisted Minecraft path: ${relative}.`);
    }
    return;
  }
  if (!allowedDirectories.has(topLevel.toLowerCase())) {
    throw new Error(`Profile path is not an allowlisted Minecraft directory: ${relative}.`);
  }
  if (topLevel.toLowerCase().startsWith("world") && parts[1]?.toLowerCase() !== "datapacks") {
    throw new Error(`Only world/datapacks paths are allowlisted in a profile: ${relative}.`);
  }
  if (isDirectory) return;
  const extension = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Profile file extension is not allowlisted: ${relative}.`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: traversal limits and entry-type checks must fail as one pass.
export function validateServerProfile(
  directory: string,
  options: { allowEmptyWhitelist?: boolean } = {}
): ValidatedServerProfile {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Server profile root must not be a symlink.");
  const root = fs.realpathSync(directory);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Server profile root must be a real directory.");
  if (forbiddenBasename(path.basename(root))) throw new Error(`Forbidden server profile root: ${path.basename(root)}.`);
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive traversal validates every entry before asseting.
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const hasControlCharacter = [...entry.name].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      });
      if (entry.name.length > 255 || hasControlCharacter) {
        throw new Error("Profile entry name contains control characters or is too long.");
      }
      if (forbiddenBasename(entry.name)) throw new Error(`Forbidden profile entry: ${entry.name}.`);
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(
          `Profile entries must be regular files or directories and may not escape the root: ${path.relative(root, target)}.`
        );
      }
      if (stat.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > PROFILE_LIMITS.directories) {
          throw new Error(`Profile exceeds ${PROFILE_LIMITS.directories} directories.`);
        }
        validateAllowlistedProfilePath(root, target, true);
        visit(target);
        continue;
      }
      validateAllowlistedProfilePath(root, target, false);
      if (stat.nlink !== 1) throw new Error(`Hard-linked profile file is not allowed: ${path.relative(root, target)}.`);
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > PROFILE_LIMITS.files) throw new Error(`Profile exceeds ${PROFILE_LIMITS.files} files.`);
      if (stat.size > PROFILE_LIMITS.fileBytes)
        throw new Error(`Profile file exceeds ${PROFILE_LIMITS.fileBytes} bytes.`);
      if (totalBytes > PROFILE_LIMITS.totalBytes)
        throw new Error(`Profile exceeds ${PROFILE_LIMITS.totalBytes} bytes.`);
      const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error(`Profile changed during validation: ${path.relative(root, target)}.`);
        }
        if (containsForbiddenCredential(descriptor)) {
          throw new Error(`Credential or private-key content is forbidden: ${path.relative(root, target)}.`);
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
  };
  visit(root);
  if (fileCount === 0) throw new Error("Server profile must contain at least one regular file.");

  for (const file of ["whitelist.json", "ops.json"]) {
    const filePath = path.join(root, file);
    if (fs.existsSync(filePath)) {
      try {
        const playerList = JSON.parse(fs.readFileSync(filePath, "utf8"));
        validatePlayerList(playerList, file);
        if (file === "whitelist.json" && playerList.length === 0 && !options.allowEmptyWhitelist) {
          throw new Error(
            "whitelist.json is empty. Add at least one Minecraft UUID/name before deployment, or explicitly set MC_ALLOW_EMPTY_WHITELIST=true only when an inaccessible server is intentional (for example CI synthesis)."
          );
        }
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON.`);
        throw error;
      }
    }
  }
  const lockPath = path.join(root, PROFILE_MANIFEST_NAME);
  let lock: PluginLock = { version: 1, plugins: [] };
  if (fs.existsSync(lockPath)) {
    try {
      lock = validatePluginLock(JSON.parse(fs.readFileSync(lockPath, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${PROFILE_MANIFEST_NAME} is not valid JSON.`);
      throw error;
    }
  }
  return { directory: root, fileCount, totalBytes, plugins: lock.plugins };
}
