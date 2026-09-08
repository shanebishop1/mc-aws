import { readFileSync } from "node:fs";
import path from "node:path";
import { computeProviderProfileFingerprint } from "@/lib/agent/provider-profile";
import { describe, expect, it } from "vitest";
import { assertGatewayProfileBinding, parseGatewayConfig } from "./gateway-config";

const source = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "infra/src/ec2/mc-agent-gateway.json"), "utf8")
) as Record<string, unknown>;

function config(): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(structuredClone(source));
}

describe("gateway provider profile configuration", () => {
  it("defaults extension loading off when older configuration omits the optional block", () => {
    const candidate = structuredClone(source) as Record<string, unknown>;
    candidate.extensions = undefined;
    expect(parseGatewayConfig(candidate).extensions).toEqual({ enabled: false, bundlePaths: [] });
  });

  it("keeps extension sources bounded and installed-release relative", () => {
    expect(config().extensions).toEqual({
      enabled: true,
      bundlePaths: ["extensions/status-report/extension.json"],
    });
    for (const bundlePaths of [
      [],
      ["workspace/extension.json"],
      ["extensions/status-report/../extension.json"],
      Array.from({ length: 9 }, (_, index) => `extensions/bundle-${index}/extension.json`),
    ]) {
      expect(() =>
        parseGatewayConfig({ ...structuredClone(source), extensions: { enabled: true, bundlePaths } })
      ).toThrow(/extension/i);
    }
  });

  it("supplies exact canonical persistent world roots to production policy", () => {
    expect(config().persistentWorldRoots).toEqual(["world", "world_nether", "world_the_end"]);
  });

  it.each([
    { persistentWorldRoots: ["world/../other"] },
    { persistentWorldRoots: ["/world"] },
    { persistentWorldRoots: ["world", "world"] },
    { persistentWorldRoots: ["WORLD/../world"] },
  ])("rejects ambiguous persistent world roots $persistentWorldRoots", ({ persistentWorldRoots }) => {
    expect(() => parseGatewayConfig({ ...structuredClone(source), persistentWorldRoots })).toThrow(/world roots/i);
  });

  it("binds the exact canonical runtime metadata before provider resolution", async () => {
    const profile = config().profiles[0];
    const fingerprint = await computeProviderProfileFingerprint({
      schemaVersion: profile.schemaVersion,
      profileId: profile.profileId,
      providerId: profile.providerId,
      providerKind: profile.providerKind,
      displayName: profile.displayName,
      endpoint: profile.endpoint,
      allowedModels: profile.allowedModels,
      supportedFeatures: profile.supportedFeatures,
    });
    await expect(
      assertGatewayProfileBinding(profile, profile.profileId, fingerprint, profile.allowedModels[0])
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      "endpoint",
      (profile: ReturnType<typeof config>["profiles"][number]) => ({
        ...profile,
        endpoint: "https://other.example/v1",
      }),
    ],
    [
      "model",
      (profile: ReturnType<typeof config>["profiles"][number]) => ({ ...profile, allowedModels: ["other/model"] }),
    ],
    [
      "kind",
      (profile: ReturnType<typeof config>["profiles"][number]) => ({
        ...profile,
        providerKind: "openai-compatible" as const,
      }),
    ],
  ])("rejects a profile ID-only %s mismatch", async (_field, mutate) => {
    const expected = config().profiles[0];
    const fingerprint = await computeProviderProfileFingerprint({
      schemaVersion: expected.schemaVersion,
      profileId: expected.profileId,
      providerId: expected.providerId,
      providerKind: expected.providerKind,
      displayName: expected.displayName,
      endpoint: expected.endpoint,
      allowedModels: expected.allowedModels,
      supportedFeatures: expected.supportedFeatures,
    });
    const substituted = mutate(expected);
    await expect(
      assertGatewayProfileBinding(substituted, expected.profileId, fingerprint, substituted.allowedModels[0])
    ).rejects.toThrow(/pinned runtime work/i);
  });

  it.each(["runtime-bearer", "gateway-private-key", "provider-signing-key", "arbitrary-credential"])(
    "rejects provider credential-name substitution with %s",
    (credentialName) => {
      const candidate = structuredClone(source) as {
        providerCredentialNames: string[];
        profiles: Array<{ credentialName: string }>;
      };
      candidate.providerCredentialNames = [credentialName];
      candidate.profiles[0].credentialName = credentialName;
      expect(() => parseGatewayConfig(candidate)).toThrow(/credential name/i);
    }
  );
});
