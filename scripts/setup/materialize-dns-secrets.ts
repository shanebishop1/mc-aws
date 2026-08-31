#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import * as dotenv from "dotenv";

interface SecretMaterialization {
  name: "/minecraft/cloudflare-api-token" | "/minecraft/duckdns-token";
  value: string;
}

export function dnsSecretMaterializationPlan(environment: Record<string, string | undefined>): SecretMaterialization[] {
  const mode = environment.MC_CONNECTION_MODE?.trim();
  if (mode === "raw_ip") return [];
  if (mode && mode !== "cloudflare" && mode !== "duckdns") {
    throw new Error("MC_CONNECTION_MODE must select cloudflare, duckdns, or raw_ip.");
  }
  const cloudflareConfigured = mode
    ? mode === "cloudflare"
    : Boolean(environment.CLOUDFLARE_ZONE_ID?.trim() || environment.CLOUDFLARE_MC_DOMAIN?.trim());
  const duckDnsConfigured = mode ? mode === "duckdns" : Boolean(environment.DUCKDNS_DOMAIN?.trim());
  if (!cloudflareConfigured && !duckDnsConfigured) return [];
  if (cloudflareConfigured && duckDnsConfigured) {
    throw new Error("Configure exactly one DNS provider before materializing its credential.");
  }
  if (cloudflareConfigured) {
    const value = environment.CLOUDFLARE_DNS_API_TOKEN?.trim();
    if (!value) throw new Error("CLOUDFLARE_DNS_API_TOKEN is required for Cloudflare DNS.");
    return [{ name: "/minecraft/cloudflare-api-token", value }];
  }
  const value = environment.DUCKDNS_TOKEN?.trim();
  if (!value) throw new Error("DUCKDNS_TOKEN is required for DuckDNS.");
  return [{ name: "/minecraft/duckdns-token", value }];
}

export async function materializeDnsSecrets(
  environment: Record<string, string | undefined>,
  send: (command: PutParameterCommand) => Promise<unknown> = async (command) =>
    await new SSMClient({
      region: environment.CDK_DEFAULT_REGION || environment.AWS_REGION || environment.AWS_DEFAULT_REGION,
    }).send(command)
): Promise<string[]> {
  const materialized: string[] = [];
  for (const secret of dnsSecretMaterializationPlan(environment)) {
    await send(
      new PutParameterCommand({ Name: secret.name, Value: secret.value, Type: "SecureString", Overwrite: true })
    );
    materialized.push(secret.name);
  }
  return materialized;
}

async function main(): Promise<void> {
  try {
    const environmentFile = [".env.production", ".env.local"]
      .map((name) => path.resolve(process.cwd(), name))
      .find(existsSync);
    const explicitTarget = new Map(
      ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"]
        .map((name) => [name, process.env[name]] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    );
    if (environmentFile) dotenv.config({ path: environmentFile, override: true, quiet: true });
    for (const [name, value] of explicitTarget) process.env[name] = value;
    const names = await materializeDnsSecrets(process.env);
    for (const name of names) console.log(`Materialized SecureString ${name}; value omitted`);
  } catch {
    console.error("DNS SecureString materialization failed; credential and provider details omitted.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
