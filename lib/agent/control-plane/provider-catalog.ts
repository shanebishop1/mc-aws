import type { ProviderDefinition } from "@/lib/agent/contracts";
import {
  type CanonicalProviderProfileMetadata,
  canonicalizeProviderProfileMetadata,
  serializeCanonicalProviderProfileMetadata,
} from "@/lib/agent/provider-profile";

export interface PublicAgentProviderProfileDto {
  schemaVersion: 1;
  profileId: string;
  providerId: string;
  providerKind: ProviderDefinition["kind"];
  displayName: string;
  endpointOrigin: string;
  endpointDisplay: string;
  allowedModels: string[];
  supportedFeatures: ProviderDefinition["supportedFeatures"];
}

export interface PublicAgentProviderCatalogDto {
  schemaVersion: 1;
  profiles: PublicAgentProviderProfileDto[];
}

export class AgentProviderCatalogConfigurationError extends Error {
  constructor() {
    super("Agent public provider catalog is unavailable");
    this.name = "AgentProviderCatalogConfigurationError";
  }
}

export class AgentProviderSelectionError extends Error {
  constructor() {
    super("Agent provider selection is invalid");
    this.name = "AgentProviderSelectionError";
  }
}

function fail(): never {
  throw new AgentProviderCatalogConfigurationError();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item))) fail();
  return item;
}

function parseRuntimeProfiles(raw: string | undefined): CanonicalProviderProfileMetadata[] {
  if (!raw || new TextEncoder().encode(raw).byteLength > 64_000) fail();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail();
  }
  const inventory = exactRecord(value, ["schemaVersion", "profiles"]);
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.profiles)) fail();
  if (inventory.profiles.length < 1 || inventory.profiles.length > 32) fail();
  const profiles = inventory.profiles.map((profile) => {
    try {
      return canonicalizeProviderProfileMetadata(profile);
    } catch {
      return fail();
    }
  });
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) fail();
  return profiles;
}

export function parsePublicAgentProviderCatalog(
  rawCatalog: string | undefined,
  rawRuntimeProfiles: string | undefined
): PublicAgentProviderCatalogDto {
  if (!rawCatalog || new TextEncoder().encode(rawCatalog).byteLength > 64_000) fail();
  let value: unknown;
  try {
    value = JSON.parse(rawCatalog) as unknown;
  } catch {
    fail();
  }
  const catalog = exactRecord(value, ["schemaVersion", "profiles"]);
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.profiles)) fail();
  if (catalog.profiles.length < 1 || catalog.profiles.length > 32) fail();
  const canonicalProfiles = catalog.profiles.map((candidate) => {
    try {
      return canonicalizeProviderProfileMetadata(candidate);
    } catch {
      return fail();
    }
  });
  const profiles = canonicalProfiles.map((profile) => {
    const endpoint = profile.endpoint === "local://fake" ? null : new URL(profile.endpoint);
    return {
      schemaVersion: 1 as const,
      profileId: profile.profileId,
      providerId: profile.providerId,
      providerKind: profile.providerKind,
      displayName: profile.displayName,
      endpointOrigin: endpoint?.origin ?? "local://fake",
      endpointDisplay: endpoint
        ? `${endpoint.host}${endpoint.pathname === "/" ? "" : endpoint.pathname}`
        : "Local only",
      allowedModels: profile.allowedModels,
      supportedFeatures: profile.supportedFeatures,
    };
  });
  const publicIds = profiles.map((profile) => profile.profileId);
  const runtimeProfiles = parseRuntimeProfiles(rawRuntimeProfiles);
  if (
    new Set(publicIds).size !== publicIds.length ||
    publicIds.length !== runtimeProfiles.length ||
    canonicalProfiles.some((profile) => {
      const runtime = runtimeProfiles.find((candidate) => candidate.profileId === profile.profileId);
      return (
        !runtime ||
        serializeCanonicalProviderProfileMetadata(runtime) !== serializeCanonicalProviderProfileMetadata(profile)
      );
    })
  ) {
    fail();
  }
  return { schemaVersion: 1, profiles };
}

const MOCK_CATALOG: PublicAgentProviderCatalogDto = {
  schemaVersion: 1,
  profiles: [
    {
      schemaVersion: 1,
      profileId: "local-fake",
      providerId: "fake",
      providerKind: "fake",
      displayName: "Local deterministic fixture",
      endpointOrigin: "local://fake",
      endpointDisplay: "Local only",
      allowedModels: ["deterministic-v1"],
      supportedFeatures: ["streaming", "tools"],
    },
  ],
};

export function getPublicAgentProviderCatalog(): PublicAgentProviderCatalogDto {
  if (process.env.MC_BACKEND_MODE?.trim().toLowerCase() === "mock" || process.env.NODE_ENV === "test") {
    return structuredClone(MOCK_CATALOG);
  }
  return parsePublicAgentProviderCatalog(
    process.env.MC_AGENT_PUBLIC_PROVIDER_CATALOG,
    process.env.MC_AGENT_RUNTIME_PROVIDER_PROFILES
  );
}

export function assertCatalogSelection(
  catalog: PublicAgentProviderCatalogDto,
  profileId: string,
  model: string
): PublicAgentProviderProfileDto {
  const profile = catalog.profiles.find((candidate) => candidate.profileId === profileId);
  if (!profile || !profile.allowedModels.includes(model)) throw new AgentProviderSelectionError();
  return profile;
}

export function catalogProfileMetadata(profile: PublicAgentProviderProfileDto): CanonicalProviderProfileMetadata {
  return canonicalizeProviderProfileMetadata({
    schemaVersion: 1,
    profileId: profile.profileId,
    providerId: profile.providerId,
    providerKind: profile.providerKind,
    displayName: profile.displayName,
    endpoint:
      profile.endpointOrigin === "local://fake"
        ? profile.endpointOrigin
        : `${profile.endpointOrigin}${new URL(`https://${profile.endpointDisplay}`).pathname === "/" ? "" : new URL(`https://${profile.endpointDisplay}`).pathname}`,
    allowedModels: profile.allowedModels,
    supportedFeatures: profile.supportedFeatures,
  });
}
