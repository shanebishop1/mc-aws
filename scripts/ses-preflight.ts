#!/usr/bin/env node

import { resolveMx } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import {
  DescribeActiveReceiptRuleSetCommand,
  GetIdentityVerificationAttributesCommand,
  SESClient,
} from "@aws-sdk/client-ses";

export interface SesInboundPreflightConfig {
  enabled: string | undefined;
  region: string | undefined;
  recipient: string | undefined;
  ruleSetName: string | undefined;
  startKeyword: string | undefined;
}

export interface SesInboundPreflightDependencies {
  getDomainVerificationStatus(region: string, domain: string): Promise<string | undefined>;
  getActiveRuleSetName(region: string): Promise<string | undefined>;
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  log(message: string): void;
}

const EMAIL_PATTERN = /^[^\s@]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SesInboundPreflightConfig {
  return {
    enabled: env.SES_INBOUND_COMMANDS_ENABLED,
    region: env.CDK_DEFAULT_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION,
    recipient: env.SES_INBOUND_RECIPIENT,
    ruleSetName: env.SES_RECEIPT_RULE_SET_NAME,
    startKeyword: env.START_KEYWORD,
  };
}

function recipientDomain(recipient: string): string {
  const match = EMAIL_PATTERN.exec(recipient);
  if (!match) throw new Error("SES_INBOUND_RECIPIENT must be a valid email address.");
  return match[1].toLowerCase();
}

function normalizeExchange(exchange: string): string {
  return exchange.trim().toLowerCase().replace(/\.+$/, "");
}

function inboundCommandsEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (/^false$/i.test(value)) return false;
  if (/^true$/i.test(value)) return true;
  throw new Error('SES_INBOUND_COMMANDS_ENABLED must be blank, "false", or "true".');
}

function validateMxRecords(
  domain: string,
  expectedExchange: string,
  records: Array<{ exchange: string; priority: number }>
): void {
  if (records.length === 0) {
    throw new Error(`No readable MX record was found for ${domain}; expected ${expectedExchange}.`);
  }
  for (const record of records) {
    if (!Number.isFinite(record.priority) || record.priority < 0) {
      throw new Error(`MX for ${domain} contains an invalid priority; priorities must be finite and nonnegative.`);
    }
  }
  const bestPriority = Math.min(...records.map((record) => record.priority));
  const bestExchanges = new Set(
    records.filter((record) => record.priority === bestPriority).map((record) => normalizeExchange(record.exchange))
  );
  if (bestExchanges.size !== 1 || !bestExchanges.has(expectedExchange)) {
    throw new Error(
      `MX for ${domain} must use ${expectedExchange} as the sole exchange at the lowest numeric priority; competing exchanges are allowed only at strictly higher numeric priorities.`
    );
  }
}

export async function runSesInboundPreflight(
  config: SesInboundPreflightConfig,
  dependencies: SesInboundPreflightDependencies
): Promise<void> {
  if (!inboundCommandsEnabled(config.enabled)) {
    dependencies.log("SES inbound-command preflight skipped: SES_INBOUND_COMMANDS_ENABLED is blank or false.");
    return;
  }

  const region = config.region?.trim();
  if (!region) throw new Error("AWS_REGION or CDK_DEFAULT_REGION is required for SES inbound commands.");

  const recipient = config.recipient?.trim().toLowerCase() ?? "";
  const domain = recipientDomain(recipient);
  const ruleSetName = config.ruleSetName?.trim();
  if (!ruleSetName) throw new Error("SES_RECEIPT_RULE_SET_NAME must be nonempty.");
  if (!config.startKeyword?.trim()) throw new Error("START_KEYWORD must be nonempty.");

  let verificationStatus: string | undefined;
  let activeRuleSetName: string | undefined;
  try {
    verificationStatus = await dependencies.getDomainVerificationStatus(region, domain);
    activeRuleSetName = await dependencies.getActiveRuleSetName(region);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SES did not respond successfully in ${region}: ${detail}`);
  }

  if (verificationStatus !== "Success") {
    throw new Error(
      `The exact recipient domain ${domain} is not a verified SES identity with status Success in ${region}. Verify that exact domain; a dedicated inbound subdomain is recommended.`
    );
  }
  if (activeRuleSetName !== ruleSetName) {
    const activeDescription = activeRuleSetName ? `"${activeRuleSetName}"` : "none";
    throw new Error(
      `The active SES receipt rule set is ${activeDescription}, not the configured "${ruleSetName}" in ${region}. Activate the configured rule set yourself before setup.`
    );
  }

  const expectedExchange = `inbound-smtp.${region}.amazonaws.com`;
  let records: Array<{ exchange: string; priority: number }>;
  try {
    records = await dependencies.resolveMx(domain);
  } catch {
    throw new Error(`No readable MX record was found for ${domain}; expected ${expectedExchange}.`);
  }
  validateMxRecords(domain, expectedExchange, records);

  dependencies.log(`SES inbound-command preflight passed for ${domain} in ${region}.`);
}

function createAwsDependencies(): SesInboundPreflightDependencies {
  const clients = new Map<string, SESClient>();
  const clientFor = (region: string): SESClient => {
    const existing = clients.get(region);
    if (existing) return existing;
    const client = new SESClient({ region });
    clients.set(region, client);
    return client;
  };

  return {
    async getDomainVerificationStatus(region, domain) {
      const response = await clientFor(region).send(
        new GetIdentityVerificationAttributesCommand({ Identities: [domain] })
      );
      return response.VerificationAttributes?.[domain]?.VerificationStatus;
    },
    async getActiveRuleSetName(region) {
      const response = await clientFor(region).send(new DescribeActiveReceiptRuleSetCommand({}));
      return response.Metadata?.Name;
    },
    resolveMx,
    log: console.log,
  };
}

async function main(): Promise<void> {
  await runSesInboundPreflight(configFromEnv(), createAwsDependencies());
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`SES inbound-command preflight failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
