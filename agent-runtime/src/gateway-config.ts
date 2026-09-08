import { canonicalPersistentWorldRoots } from "../../lib/agent/minecraft-security";
import {
  type CanonicalProviderProfileMetadata,
  canonicalizeProviderProfileMetadata,
  computeProviderProfileFingerprint,
} from "../../lib/agent/provider-profile";

export interface GatewayProviderProfile extends CanonicalProviderProfileMetadata {
  credentialName: string;
  timeoutMs: number;
  contextWindow: number;
  maxTokens: number;
}

export interface GatewayExtensionConfig {
  enabled: boolean;
  bundlePaths: string[];
}

export interface GatewayConfig {
  schemaVersion: 1;
  controlBaseUrl: string;
  socketPath: "/run/mc-agent/executor.sock";
  downloadSocketPath: "/run/mc-agent-download/download.sock";
  backupPath: "/api/agent/runtime/backups";
  persistentWorldRoots: string[];
  providerCredentialNames: string[];
  profiles: GatewayProviderProfile[];
  extensions: GatewayExtensionConfig;
}

export const PROVIDER_CREDENTIAL_NAME = /^provider-[a-z0-9][a-z0-9-]{0,62}$/;
const FORBIDDEN_PROVIDER_CREDENTIAL_NAMES = new Set([
  "runtime-bearer",
  "gateway-private-key",
  "gateway-public-key",
  "executor-private-key",
  "executor-public-key",
]);

export function assertProviderCredentialName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    !PROVIDER_CREDENTIAL_NAME.test(name) ||
    FORBIDDEN_PROVIDER_CREDENTIAL_NAMES.has(name) ||
    /(?:^|-)(?:runtime-bearer|signing-key|private-key|public-key)(?:-|$)/.test(name)
  ) {
    throw new Error("Provider credential name is not allowed.");
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  message: string,
  requiredKeys: readonly string[] = keys
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key)) || requiredKeys.some((key) => !(key in item))) {
    throw new Error(message);
  }
  return item;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function parseGatewayConfig(value: unknown): GatewayConfig {
  const keys = [
    "schemaVersion",
    "controlBaseUrl",
    "socketPath",
    "downloadSocketPath",
    "backupPath",
    "persistentWorldRoots",
    "providerCredentialNames",
    "profiles",
    "extensions",
  ];
  const item = exactRecord(value, keys, "Gateway configuration schema is invalid.", keys.slice(0, -1));
  if (item.schemaVersion !== 1) throw new Error("Gateway configuration schema is invalid.");
  const base = new URL(String(item.controlBaseUrl));
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    throw new Error("Gateway control URL is invalid.");
  if (
    item.socketPath !== "/run/mc-agent/executor.sock" ||
    item.downloadSocketPath !== "/run/mc-agent-download/download.sock" ||
    item.backupPath !== "/api/agent/runtime/backups" ||
    !Array.isArray(item.persistentWorldRoots) ||
    !Array.isArray(item.providerCredentialNames) ||
    item.providerCredentialNames.length > 32 ||
    !Array.isArray(item.profiles) ||
    item.profiles.length > 32
  ) {
    throw new Error("Gateway paths or provider bounds are invalid.");
  }
  const providerCredentialNames = item.providerCredentialNames.map((name) => {
    assertProviderCredentialName(name);
    return name;
  });
  const persistentWorldRoots = [...canonicalPersistentWorldRoots(item.persistentWorldRoots as string[])];
  if (new Set(providerCredentialNames).size !== providerCredentialNames.length) {
    throw new Error("Provider credential names must be unique.");
  }
  const profileIds = new Set<string>();
  const profiles = item.profiles.map((value) => {
    const profileKeys = [
      "schemaVersion",
      "profileId",
      "providerId",
      "providerKind",
      "displayName",
      "endpoint",
      "allowedModels",
      "supportedFeatures",
      "credentialName",
      "timeoutMs",
      "contextWindow",
      "maxTokens",
    ];
    const profile = exactRecord(value, profileKeys, "Provider profile schema is invalid.");
    assertProviderCredentialName(profile.credentialName);
    let metadata: CanonicalProviderProfileMetadata;
    try {
      metadata = canonicalizeProviderProfileMetadata({
        schemaVersion: profile.schemaVersion,
        profileId: profile.profileId,
        providerId: profile.providerId,
        providerKind: profile.providerKind,
        displayName: profile.displayName,
        endpoint: profile.endpoint,
        allowedModels: profile.allowedModels,
        supportedFeatures: profile.supportedFeatures,
      });
    } catch {
      throw new Error("Provider profile metadata is invalid.");
    }
    if (
      !providerCredentialNames.includes(profile.credentialName) ||
      !positiveInteger(profile.timeoutMs) ||
      !positiveInteger(profile.contextWindow) ||
      !positiveInteger(profile.maxTokens)
    ) {
      throw new Error("Provider profile values are invalid.");
    }
    if (profileIds.has(metadata.profileId)) throw new Error("Provider profile IDs must be unique.");
    profileIds.add(metadata.profileId);
    return {
      ...metadata,
      credentialName: profile.credentialName,
      timeoutMs: profile.timeoutMs,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
    };
  });
  const usedCredentialNames = new Set(profiles.map((profile) => profile.credentialName));
  if (
    usedCredentialNames.size !== providerCredentialNames.length ||
    providerCredentialNames.some((name) => !usedCredentialNames.has(name))
  ) {
    throw new Error("Provider credential allowlist must exactly match configured profiles.");
  }
  const extensionValue = item.extensions ?? { enabled: false, bundlePaths: [] };
  const extension = exactRecord(
    extensionValue,
    ["enabled", "bundlePaths"],
    "Extension configuration schema is invalid."
  );
  if (typeof extension.enabled !== "boolean" || !Array.isArray(extension.bundlePaths)) {
    throw new Error("Extension configuration schema is invalid.");
  }
  if (extension.bundlePaths.length > 8 || (extension.enabled && extension.bundlePaths.length === 0)) {
    throw new Error("Extension bundle count is outside its bound.");
  }
  const bundlePaths = extension.bundlePaths.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      !/^extensions\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/extension\.json$/.test(candidate) ||
      candidate.includes("..")
    ) {
      throw new Error("Extension bundle path is not a protected installed source.");
    }
    return candidate;
  });
  if (new Set(bundlePaths).size !== bundlePaths.length) throw new Error("Extension bundle paths must be unique.");
  return {
    schemaVersion: 1,
    controlBaseUrl: base.toString(),
    socketPath: item.socketPath,
    downloadSocketPath: item.downloadSocketPath,
    backupPath: item.backupPath,
    persistentWorldRoots,
    providerCredentialNames,
    profiles,
    extensions: { enabled: extension.enabled, bundlePaths },
  } as GatewayConfig;
}

export async function assertGatewayProfileBinding(
  profile: GatewayProviderProfile,
  expectedProfileId: string,
  expectedFingerprint: string,
  model: string
): Promise<void> {
  const metadata = canonicalizeProviderProfileMetadata({
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    providerId: profile.providerId,
    providerKind: profile.providerKind,
    displayName: profile.displayName,
    endpoint: profile.endpoint,
    allowedModels: profile.allowedModels,
    supportedFeatures: profile.supportedFeatures,
  });
  if (
    profile.profileId !== expectedProfileId ||
    !/^[a-f0-9]{64}$/.test(expectedFingerprint) ||
    !profile.allowedModels.includes(model) ||
    (await computeProviderProfileFingerprint(metadata)) !== expectedFingerprint
  ) {
    throw new Error("Gateway provider profile does not match the pinned runtime work.");
  }
}
