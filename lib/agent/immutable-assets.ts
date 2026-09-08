import path from "node:path";

/**
 * Files which are part of the server/runtime executable boundary.  These are
 * deliberately identified by canonical, case-sensitive workspace-relative
 * paths; a similar name is not an asset identity.
 */
const IMMUTABLE_ASSET_DIRECTORIES = new Set([
  "bin",
  "lib",
  "native",
  "profile",
  "runtime",
  "scripts",
  "server-profile",
  "systemd",
]);
const SYSTEMD_ASSET_SUFFIXES = new Set([
  ".automount",
  ".device",
  ".mount",
  ".path",
  ".scope",
  ".service",
  ".slice",
  ".socket",
  ".swap",
  ".target",
  ".timer",
]);

function canonicalWorkspacePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function isNativeLibrary(name: string): boolean {
  return /\.so(?:\.[0-9]+(?:\.[0-9]+)*)?$|\.dylib$|\.dll$/.test(name);
}

/** Returns true only for an exact canonical executable/runtime asset path. */
export function isImmutableAgentAssetPath(target: string): boolean {
  if (!canonicalWorkspacePath(target)) return false;
  const parts = target.split("/");
  const name = parts.at(-1) ?? "";

  if (target === "paper.jar") return true;
  if (parts[0] === "plugins" && parts.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.jar$/.test(name)) return true;
  if (name.endsWith(".sh") || isNativeLibrary(name)) return true;
  if (parts[0] === "systemd" && SYSTEMD_ASSET_SUFFIXES.has(path.posix.extname(name))) return true;
  // Extensionless launchers in the reviewed asset directories are protected,
  // while a suffix/lookalike backup remains an ordinary data path.
  return IMMUTABLE_ASSET_DIRECTORIES.has(parts[0] ?? "") && !name.includes(".");
}

/** Recursive deletion of these directories could remove an otherwise hidden JAR/runtime asset. */
export function isImmutableAgentAssetDirectory(target: string): boolean {
  if (!canonicalWorkspacePath(target)) return false;
  const first = target.split("/")[0];
  return first === "plugins" || IMMUTABLE_ASSET_DIRECTORIES.has(first);
}
