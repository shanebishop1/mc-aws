import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  dnsSecretMaterializationPlan,
  materializeDnsSecrets,
  materializeDnsSecretsWithEvidence,
} from "./materialize-dns-secrets";

function ssmMock(initial: Record<string, { Type: string; Value?: string; Version?: number }> = {}) {
  const values = new Map(Object.entries(initial));
  let nextVersion = Math.max(0, ...Object.values(initial).map((value) => value.Version ?? 0)) + 1;
  return vi.fn(async (command: GetParameterCommand | PutParameterCommand) => {
    if (command instanceof GetParameterCommand) {
      const value = values.get(command.input.Name!);
      if (!value) throw Object.assign(new Error("missing"), { name: "ParameterNotFound" });
      return { Parameter: value };
    }
    if (!command.input.Overwrite && values.has(command.input.Name!)) {
      throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
    }
    const version = nextVersion++;
    values.set(command.input.Name!, {
      Type: command.input.Type ?? "String",
      Value: command.input.Value,
      Version: version,
    });
    return { Version: version };
  });
}

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
    const send = ssmMock();
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
    ).resolves.toEqual(["/minecraft/cloudflare-api-token", "/minecraft/dns-mode"]);
    const put = send.mock.calls.find(
      ([command]) => command instanceof PutParameterCommand && command.input.Name === "/minecraft/cloudflare-api-token"
    )?.[0] as PutParameterCommand;
    expect(put.input).toEqual({
      Name: "/minecraft/cloudflare-api-token",
      Value: token,
      Type: "SecureString",
      Overwrite: false,
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

  it("refuses to overwrite a selected provider credential without exact manifest ownership proof", async () => {
    const send = ssmMock({ "/minecraft/duckdns-token": { Type: "SecureString", Version: 2 } });
    await expect(
      materializeDnsSecretsWithEvidence(
        { MC_CONNECTION_MODE: "duckdns", DUCKDNS_DOMAIN: "server", DUCKDNS_TOKEN: "replacement" },
        send
      )
    ).rejects.toThrow("ownership is not proven");
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof PutParameterCommand && command.input.Name === "/minecraft/duckdns-token"
      )
    ).toBe(false);
  });

  it("preserves exact credentials during cloudflare to duckdns/raw transitions for manual cleanup", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-dns-transition-"));
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        aws: {
          ssmParameters: [
            {
              name: "/minecraft/cloudflare-api-token",
              ownership: "created",
              createdByProject: true,
              claimToken: "11111111-2222-4333-8444-555555555555",
              resourceVersion: 4,
            },
          ],
        },
      })
    );
    const send = ssmMock({ "/minecraft/cloudflare-api-token": { Type: "SecureString", Version: 4 } });
    await materializeDnsSecretsWithEvidence(
      {
        MC_CONNECTION_MODE: "duckdns",
        DUCKDNS_DOMAIN: "new",
        DUCKDNS_TOKEN: "token",
        MC_AWS_DEPLOYMENT_MANIFEST: `${directory}/manifest.json`,
      },
      send
    );
    expect(
      send.mock.calls.some(
        ([command]) =>
          command instanceof PutParameterCommand && command.input.Name === "/minecraft/cloudflare-api-token"
      )
    ).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });
});
