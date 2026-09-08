import type { ProviderDefinition } from "@/lib/agent/contracts";

export interface CanonicalProviderProfileMetadata {
  schemaVersion: 1;
  profileId: string;
  providerId: string;
  providerKind: ProviderDefinition["kind"];
  displayName: string;
  endpoint: string;
  allowedModels: string[];
  supportedFeatures: ProviderDefinition["supportedFeatures"];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const KINDS = new Set<ProviderDefinition["kind"]>(["openrouter", "openai-compatible", "fake"]);
const FEATURES = new Set<ProviderDefinition["supportedFeatures"][number]>(["streaming", "tools", "reasoning-summary"]);
const PROFILE_KEYS = [
  "schemaVersion",
  "profileId",
  "providerId",
  "providerKind",
  "displayName",
  "endpoint",
  "allowedModels",
  "supportedFeatures",
] as const;
const MAX_CANONICAL_PROFILE_BYTES = 16_384;

export class ProviderProfileMetadataError extends Error {
  constructor() {
    super("Provider profile metadata is invalid");
    this.name = "ProviderProfileMetadataError";
  }
}

function fail(): never {
  throw new ProviderProfileMetadataError();
}

function canonicalEndpoint(value: unknown, kind: ProviderDefinition["kind"]): string {
  if (kind === "fake" && value === "local://fake") return value;
  if (typeof value !== "string" || value.length > 2_048) fail();
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    fail();
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail();
  }
  const pathname = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
  return `${endpoint.origin}${pathname}`;
}

function sortedUniqueStrings(
  value: unknown,
  minimum: number,
  maximum: number,
  validate: (item: string) => boolean
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail();
  const items = value.map((item) => (typeof item === "string" && validate(item) ? item : fail()));
  if (new Set(items).size !== items.length) fail();
  return items.sort();
}

/**
 * Produces the one bounded, secret-free representation hashed by both the Worker and gateway.
 * Unknown fields are rejected so schema-v1 changes cannot silently escape the binding.
 */
export function canonicalizeProviderProfileMetadata(value: unknown): CanonicalProviderProfileMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const profile = value as Record<string, unknown>;
  if (
    Object.keys(profile).length !== PROFILE_KEYS.length ||
    PROFILE_KEYS.some((key) => !(key in profile)) ||
    profile.schemaVersion !== 1 ||
    typeof profile.profileId !== "string" ||
    !ID.test(profile.profileId) ||
    typeof profile.providerId !== "string" ||
    !ID.test(profile.providerId) ||
    typeof profile.providerKind !== "string" ||
    !KINDS.has(profile.providerKind as ProviderDefinition["kind"]) ||
    typeof profile.displayName !== "string" ||
    profile.displayName.trim().length < 1 ||
    profile.displayName.length > 80
  ) {
    fail();
  }
  const providerKind = profile.providerKind as ProviderDefinition["kind"];
  const canonical: CanonicalProviderProfileMetadata = {
    schemaVersion: 1,
    profileId: profile.profileId,
    providerId: profile.providerId,
    providerKind,
    displayName: profile.displayName.trim(),
    endpoint: canonicalEndpoint(profile.endpoint, providerKind),
    allowedModels: sortedUniqueStrings(profile.allowedModels, 1, 64, (item) => MODEL.test(item)),
    supportedFeatures: sortedUniqueStrings(profile.supportedFeatures, 0, FEATURES.size, (item) =>
      FEATURES.has(item as ProviderDefinition["supportedFeatures"][number])
    ) as ProviderDefinition["supportedFeatures"],
  };
  if (new TextEncoder().encode(JSON.stringify(canonical)).byteLength > MAX_CANONICAL_PROFILE_BYTES) fail();
  return canonical;
}

export function serializeCanonicalProviderProfileMetadata(value: unknown): string {
  return JSON.stringify(canonicalizeProviderProfileMetadata(value));
}

export async function computeProviderProfileFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(serializeCanonicalProviderProfileMetadata(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
