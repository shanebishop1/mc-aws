import { AGENT_SCHEMA_VERSION, type AgentExtensionBundle, type ExtensionProvenanceSource } from "@/lib/agent/contracts";
import { orderHookDefinitions } from "@/lib/agent/hooks";
import { AgentContractValidationError, agentSchemas } from "@/lib/agent/validators";

export interface ExtensionRegistryOptions {
  allowedProvenanceSources?: readonly ExtensionProvenanceSource[];
  platform?: string;
}

export interface AgentExtensionRegistry {
  readonly bundles: readonly AgentExtensionBundle[];
  readonly tools: ReadonlyArray<AgentExtensionBundle["tools"][number]>;
  readonly skills: ReadonlyArray<AgentExtensionBundle["skills"][number]>;
  readonly hooks: ReadonlyArray<AgentExtensionBundle["hooks"][number]>;
}

function isProvenanceIntegrityPath(path: readonly (string | number)[], key: string): boolean {
  if (key !== "integrity") return false;
  if (path.length === 1 && path[0] === "provenance") return true;
  return path.length === 3 && path[0] === "skills" && typeof path[1] === "number" && path[2] === "provenance";
}

function canonicalize(value: unknown, path: readonly (string | number)[] = []): unknown {
  if (Array.isArray(value)) return value.map((child, index) => canonicalize(child, [...path, index]));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isProvenanceIntegrityPath(path, key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child, [...path, key])])
    );
  }
  return value;
}

export async function computeExtensionIntegrity(bundle: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(bundle)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertUnique(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new AgentContractValidationError(`${kind}: duplicate identifier ${value}`);
    seen.add(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateSkill(bundle: AgentExtensionBundle, skill: AgentExtensionBundle["skills"][number]): void {
  if (
    skill.provenance.source !== bundle.provenance.source ||
    skill.provenance.reference !== bundle.provenance.reference ||
    skill.provenance.integrity !== bundle.provenance.integrity
  ) {
    throw new AgentContractValidationError(
      `agentExtensionBundle.provenance: skill ${skill.skillId} must inherit bundle provenance`
    );
  }
  if (!skill.compatibility.contractSchemaVersions.includes(AGENT_SCHEMA_VERSION)) {
    throw new AgentContractValidationError(`skillManifest.compatibility: ${skill.skillId} does not support schema 1`);
  }
  for (const toolId of skill.requestedTools) {
    if (!bundle.tools.some((tool) => tool.toolId === toolId)) {
      throw new AgentContractValidationError(`skillManifest.requestedTools: unknown bundle tool ${toolId}`);
    }
  }
}

async function validateBundle(
  candidate: unknown,
  allowedSources: readonly ExtensionProvenanceSource[],
  platform: string
): Promise<AgentExtensionBundle> {
  const bundle = structuredClone(agentSchemas.agentExtensionBundle.parse(candidate));
  if (!bundle.compatibility.contractSchemaVersions.includes(AGENT_SCHEMA_VERSION)) {
    throw new AgentContractValidationError(
      `agentExtensionBundle.compatibility: ${bundle.extensionId}@${bundle.version} does not support schema ${AGENT_SCHEMA_VERSION}`
    );
  }
  if (!bundle.compatibility.platforms.includes(platform)) {
    throw new AgentContractValidationError(
      `agentExtensionBundle.compatibility: ${bundle.extensionId}@${bundle.version} does not support ${platform}`
    );
  }
  if (!allowedSources.includes(bundle.provenance.source)) {
    throw new AgentContractValidationError(
      `agentExtensionBundle.provenance: source ${bundle.provenance.source} is not explicitly trusted`
    );
  }
  if (bundle.provenance.integrity !== (await computeExtensionIntegrity(bundle))) {
    throw new AgentContractValidationError(
      `agentExtensionBundle.provenance: integrity mismatch for ${bundle.extensionId}`
    );
  }
  for (const skill of bundle.skills) validateSkill(bundle, skill);
  return bundle;
}

/**
 * Loads schema-v1 metadata only. Handler references remain inert strings; this registry never imports extension code,
 * invokes callbacks, resolves provider credentials, or changes permission policy.
 */
export async function loadAgentExtensionRegistry(
  candidates: readonly unknown[],
  options: ExtensionRegistryOptions = {}
): Promise<AgentExtensionRegistry> {
  const allowedSources = options.allowedProvenanceSources ?? (["mc-aws", "operator"] as const);
  const platform = options.platform ?? "mc-aws-agent";
  const bundles: AgentExtensionBundle[] = [];

  for (const candidate of candidates) {
    bundles.push(await validateBundle(candidate, allowedSources, platform));
  }

  bundles.sort(
    (left, right) => left.extensionId.localeCompare(right.extensionId) || left.version.localeCompare(right.version)
  );
  assertUnique(
    bundles.map((bundle) => bundle.extensionId),
    "agentExtensionBundle"
  );
  const tools = bundles
    .flatMap((bundle) => bundle.tools)
    .sort((left, right) => left.toolId.localeCompare(right.toolId));
  const skills = bundles
    .flatMap((bundle) => bundle.skills)
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
  const hooks = orderHookDefinitions(bundles.flatMap((bundle) => bundle.hooks));
  assertUnique(
    tools.map((tool) => tool.toolId),
    "toolDefinition"
  );
  assertUnique(
    skills.map((skill) => skill.skillId),
    "skillManifest"
  );
  assertUnique(
    hooks.map((hook) => hook.hookId),
    "hookDefinition"
  );
  return deepFreeze({ bundles, tools, skills, hooks });
}
