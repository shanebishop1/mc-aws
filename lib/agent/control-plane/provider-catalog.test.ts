import {
  AgentProviderCatalogConfigurationError,
  assertCatalogSelection,
  getPublicAgentProviderCatalog,
  parsePublicAgentProviderCatalog,
} from "@/lib/agent/control-plane/provider-catalog";
import { describe, expect, it } from "vitest";

const catalog = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      schemaVersion: 1,
      profileId: "operator-openrouter",
      providerId: "openrouter-api",
      providerKind: "openrouter",
      displayName: "Reviewed OpenRouter",
      endpoint: "https://openrouter.example/v1",
      allowedModels: ["vendor/model-a", "vendor/model-b"],
      supportedFeatures: ["streaming", "tools"],
    },
  ],
});
const runtimeProfiles = catalog;

describe("public agent provider catalog", () => {
  it("returns only the deterministic local-fake profile in mock mode", () => {
    expect(getPublicAgentProviderCatalog()).toEqual({
      schemaVersion: 1,
      profiles: [expect.objectContaining({ profileId: "local-fake", providerKind: "fake" })],
    });
    expect(JSON.stringify(getPublicAgentProviderCatalog())).not.toMatch(/credential|secret|api.?key/i);
  });

  it("strictly projects public fields and validates profile/model selections", () => {
    const parsed = parsePublicAgentProviderCatalog(catalog, runtimeProfiles);
    expect(parsed.profiles[0]).toEqual({
      schemaVersion: 1,
      profileId: "operator-openrouter",
      providerId: "openrouter-api",
      providerKind: "openrouter",
      displayName: "Reviewed OpenRouter",
      endpointOrigin: "https://openrouter.example",
      endpointDisplay: "openrouter.example/v1",
      allowedModels: ["vendor/model-a", "vendor/model-b"],
      supportedFeatures: ["streaming", "tools"],
    });
    expect(() => assertCatalogSelection(parsed, "operator-openrouter", "vendor/model-a")).not.toThrow();
    expect(() => assertCatalogSelection(parsed, "operator-openrouter", "other/model")).toThrow(/selection/i);
  });

  it.each([
    [catalog, JSON.stringify(["operator-openrouter"])],
    [catalog, runtimeProfiles.replace("https://openrouter.example/v1", "https://other.example/v1")],
    [catalog, runtimeProfiles.replace('"vendor/model-b"', '"vendor/model-c"')],
    [catalog, runtimeProfiles.replace('"openrouter"', '"openai-compatible"')],
    [catalog.replace('"endpoint"', '"credentialRef":"secret-ref:provider/key","endpoint"'), runtimeProfiles],
    [catalog.replace("https://openrouter.example/v1", "https://user:password@openrouter.example/v1"), runtimeProfiles],
  ])("fails closed for mismatched or sensitive production configuration", (publicConfig, runtimeIds) => {
    expect(() => parsePublicAgentProviderCatalog(publicConfig, runtimeIds)).toThrow(
      AgentProviderCatalogConfigurationError
    );
  });
});
