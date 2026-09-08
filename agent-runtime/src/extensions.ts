import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentExtensionRegistry } from "../../lib/agent/extensions";
import { loadAgentExtensionRegistry } from "../../lib/agent/extensions";
import type { GatewayExtensionConfig } from "./gateway-config";

export const MAX_EXTENSION_BUNDLE_BYTES = 256 * 1024;
export const MAX_EXTENSION_TOTAL_BYTES = 1024 * 1024;

function protectedBundlePath(root: string, relative: string): string {
  if (!/^extensions\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/extension\.json$/.test(relative) || relative.includes("..")) {
    throw new Error("Extension bundle path is not a protected installed source.");
  }
  const resolvedRoot = path.posix.resolve(root);
  const resolved = path.posix.resolve(resolvedRoot, relative);
  if (resolved !== path.posix.join(resolvedRoot, relative))
    throw new Error("Extension source escaped its installed root.");
  return resolved;
}

async function readProtectedBundle(root: string, relative: string): Promise<string> {
  const bundlePath = protectedBundlePath(root, relative);
  const rootMetadata = await stat(root);
  const productionRoot = root === "/opt/mc-agent/current" || root === "/runtime/current";
  if (!rootMetadata.isDirectory() || (productionRoot && rootMetadata.uid !== 0) || (rootMetadata.mode & 0o022) !== 0) {
    throw new Error("Installed extension root is not protected.");
  }
  const parent = path.posix.dirname(bundlePath);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    (productionRoot && parentMetadata.uid !== 0) ||
    (parentMetadata.mode & 0o022) !== 0
  ) {
    throw new Error("Installed extension directory is not protected.");
  }
  const metadata = await lstat(bundlePath);
  if (!metadata.isFile() || (productionRoot && metadata.uid !== 0) || (metadata.mode & 0o022) !== 0) {
    throw new Error("Installed extension bundle is not a protected regular file.");
  }
  const installedRoot = await realpath(root);
  const installedSource = await realpath(bundlePath);
  if (!installedSource.startsWith(`${installedRoot}/`)) throw new Error("Installed extension source escaped its root.");
  if (metadata.size > MAX_EXTENSION_BUNDLE_BYTES) throw new Error("Extension bundle exceeds its byte bound.");
  return await readFile(bundlePath, "utf8");
}

/** Loads only fixed, root-owned files from the immutable runtime release. */
export async function loadInstalledAgentExtensionRegistry(
  config: GatewayExtensionConfig,
  installedRoot: string
): Promise<AgentExtensionRegistry> {
  if (!config.enabled) return await loadAgentExtensionRegistry([]);
  let totalBytes = 0;
  const candidates: unknown[] = [];
  for (const relative of config.bundlePaths) {
    const source = await readProtectedBundle(installedRoot, relative);
    totalBytes += Buffer.byteLength(source);
    if (totalBytes > MAX_EXTENSION_TOTAL_BYTES)
      throw new Error("Configured extension bundles exceed their total byte bound.");
    try {
      candidates.push(JSON.parse(source) as unknown);
    } catch {
      throw new Error("Installed extension bundle is not valid JSON.");
    }
  }
  return await loadAgentExtensionRegistry(candidates, {
    allowedProvenanceSources: ["mc-aws"],
    platform: "mc-aws-agent",
  });
}

export function extensionSystemPrompt(registry: AgentExtensionRegistry): string {
  const instructions = registry.skills
    .map((skill) => `Skill ${skill.skillId} (${skill.version}):\n${skill.instructions}`)
    .join("\n\n")
    .slice(0, 32_000);
  return instructions.length > 0
    ? `Use only the explicitly provided mc-aws tools.\n\nReviewed data-only extension guidance:\n${instructions}`
    : "Use only the explicitly provided mc-aws tools.";
}
