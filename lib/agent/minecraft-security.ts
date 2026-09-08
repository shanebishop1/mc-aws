import path from "node:path";
import type { ToolInvocation } from "@/lib/agent/contracts";

export const DEFAULT_PERSISTENT_WORLD_ROOTS = Object.freeze(["world", "world_nether", "world_the_end"] as const);

/** Validates exact workspace-relative roots; callers must not infer roots from path substrings. */
export function canonicalPersistentWorldRoots(
  roots: readonly string[] = DEFAULT_PERSISTENT_WORLD_ROOTS
): readonly string[] {
  if (roots.length === 0 || roots.length > 64) throw new TypeError("Persistent world roots are invalid.");
  const canonical = roots.map((root) => {
    if (
      typeof root !== "string" ||
      !root ||
      root.length > 4096 ||
      root.includes("\0") ||
      root.includes("\\") ||
      path.posix.isAbsolute(root) ||
      root === "." ||
      root.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      path.posix.normalize(root) !== root
    ) {
      throw new TypeError("Persistent world roots must be canonical workspace-relative paths.");
    }
    return root;
  });
  if (new Set(canonical).size !== canonical.length) throw new TypeError("Persistent world roots must be unique.");
  return Object.freeze([...canonical]);
}

export function isPersistentWorldPath(
  target: string,
  roots: readonly string[] = DEFAULT_PERSISTENT_WORLD_ROOTS
): boolean {
  if (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    target.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(target) !== target
  ) {
    return false;
  }
  return canonicalPersistentWorldRoots(roots).some((root) => target === root || target.startsWith(`${root}/`));
}

export function isPersistentWorldMutation(
  invocation: ToolInvocation,
  roots: readonly string[] = DEFAULT_PERSISTENT_WORLD_ROOTS
): boolean {
  return (
    invocation.targetScope.kind === "workspace" &&
    (invocation.capability === "workspace.write" ||
      invocation.capability === "workspace.delete" ||
      invocation.toolId === "network.download") &&
    isPersistentWorldPath(invocation.targetScope.normalizedTarget, roots)
  );
}

const SERVER_PROPERTIES_SECURITY_KEYS = new Set([
  "broadcast-rcon-to-ops",
  "enable-query",
  "enable-rcon",
  "enforce-secure-profile",
  "enforce-whitelist",
  "function-permission-level",
  "hide-online-players",
  "online-mode",
  "op-permission-level",
  "prevent-proxy-connections",
  "rcon.password",
  "server-ip",
  "white-list",
]);

/** Matches only the canonical workspace-root server.properties target. */
export function isRootServerPropertiesPath(target: string): boolean {
  return target === "server.properties";
}

export function isRootServerPropertiesMutation(invocation: ToolInvocation): boolean {
  return (
    invocation.targetScope.kind === "workspace" &&
    isRootServerPropertiesPath(invocation.targetScope.normalizedTarget) &&
    (invocation.capability === "workspace.write" ||
      invocation.capability === "workspace.delete" ||
      invocation.toolId === "network.download")
  );
}

export function serverPropertiesSecurityKeys(content: unknown): string[] {
  if (typeof content !== "string") return [];
  const detected = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const separator = trimmed.search(/[=:]/);
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (SERVER_PROPERTIES_SECURITY_KEYS.has(key)) detected.add(key);
  }
  return [...detected].sort();
}

export function serverPropertiesDestructiveExplanation(invocation: ToolInvocation): string | undefined {
  if (!isRootServerPropertiesMutation(invocation)) return undefined;
  const keys = serverPropertiesSecurityKeys(invocation.arguments.content);
  return [
    "Destructive permission/access-control configuration: this mutation targets the canonical workspace-root server.properties file, which is conservatively gated in full.",
    keys.length > 0 ? `Security-sensitive keys in the proposed content: ${keys.join(", ")}.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function minecraftDestructiveExplanation(
  invocation: ToolInvocation,
  roots: readonly string[] = DEFAULT_PERSISTENT_WORLD_ROOTS
): string | undefined {
  const serverProperties = serverPropertiesDestructiveExplanation(invocation);
  if (serverProperties) return serverProperties;
  if (isPersistentWorldMutation(invocation, roots)) {
    return `Destructive persistent-world mutation: this operation targets configured world root ${JSON.stringify(
      roots.find(
        (root) =>
          invocation.targetScope.normalizedTarget === root ||
          invocation.targetScope.normalizedTarget.startsWith(`${root}/`)
      )
    )} and requires an exact approval and backup according to policy.`;
  }
  if (invocation.capability === "console.execute") {
    return "Destructive Minecraft console mutation: commands outside the narrow read-only and ephemeral allowlists are conservatively treated as able to mutate persistent world or plugin state.";
  }
  return undefined;
}
