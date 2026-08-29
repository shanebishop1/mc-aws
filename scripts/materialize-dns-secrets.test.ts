import { describe, expect, it, vi } from "vitest";
import { dnsSecretMaterializationPlan, materializeDnsSecrets } from "./materialize-dns-secrets";

describe("DNS SecureString materialization", () => {
  it.each([
    [
      "cloudflare",
      {
        MC_CONNECTION_MODE: "cloudflare",
        CLOUDFLARE_ZONE_ID: "zone-id",
        CLOUDFLARE_MC_DOMAIN: "mc.example.net",
        CLOUDFLARE_DNS_API_TOKEN: "cloudflare-secret",
      },
      "/minecraft/cloudflare-api-token",
    ],
    [
      "duckdns",
      { MC_CONNECTION_MODE: "duckdns", DUCKDNS_DOMAIN: "server", DUCKDNS_TOKEN: "duck-secret" },
      "/minecraft/duckdns-token",
    ],
  ])("plans a fresh %s setup", (_provider, environment, expectedName) => {
    expect(dnsSecretMaterializationPlan(environment)).toEqual([expect.objectContaining({ name: expectedName })]);
  });

  it("writes the selected token through native SSM SecureString without a custom-resource event", async () => {
    const send = vi.fn().mockResolvedValue({ Version: 1 });
    const token = "confidential-token-sentinel";
    await expect(
      materializeDnsSecrets(
        {
          CLOUDFLARE_ZONE_ID: "zone-id",
          CLOUDFLARE_MC_DOMAIN: "mc.example.net",
          CLOUDFLARE_DNS_API_TOKEN: token,
        },
        send
      )
    ).resolves.toEqual(["/minecraft/cloudflare-api-token"]);
    expect(send.mock.calls[0][0].input).toEqual({
      Name: "/minecraft/cloudflare-api-token",
      Value: token,
      Type: "SecureString",
      Overwrite: true,
    });
  });

  it("fails closed for ambiguous providers without returning token data", () => {
    expect(() =>
      dnsSecretMaterializationPlan({
        CLOUDFLARE_ZONE_ID: "zone-id",
        DUCKDNS_DOMAIN: "server",
        CLOUDFLARE_DNS_API_TOKEN: "cloudflare-secret",
        DUCKDNS_TOKEN: "duck-secret",
      })
    ).toThrow("exactly one DNS provider");
  });

  it("uses the explicit provider mode instead of stale values from another provider", () => {
    expect(
      dnsSecretMaterializationPlan({
        MC_CONNECTION_MODE: "duckdns",
        DUCKDNS_DOMAIN: "server",
        DUCKDNS_TOKEN: "duck-secret",
        CLOUDFLARE_ZONE_ID: "stale-zone",
        CLOUDFLARE_DNS_API_TOKEN: "stale-cloudflare-secret",
      })
    ).toEqual([{ name: "/minecraft/duckdns-token", value: "duck-secret" }]);
  });
});
