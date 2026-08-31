import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("persisted logging security contract", () => {
  it("does not log OAuth state values, authorization codes, tokens, or user email values", () => {
    const callbacks = [source("app/api/auth/callback/route.ts"), source("app/api/gdrive/callback/route.ts")].join("\n");
    const consoleLines = callbacks
      .split("\n")
      .filter((line) => line.includes("console."))
      .join("\n");

    expect(consoleLines).not.toMatch(/\$\{(?:oauthState|state|accessToken|tokens|code|email|userinfo\.email)\}/);
    expect(consoleLines).not.toMatch(/,\s*(?:oauthState|state|accessToken|tokens|code|email|userinfo\.email)\b/);
  });

  it("does not log authenticated emails, roles, resource IDs, or raw mutation payloads in API routes", () => {
    const routeSources = [
      "app/api/start/route.ts",
      "app/api/stop/route.ts",
      "app/api/backup/route.ts",
      "app/api/restore/route.ts",
      "app/api/hibernate/route.ts",
      "app/api/resume/route.ts",
      "app/api/emails/allowlist/route.ts",
      "app/api/mock/fault/route.ts",
      "app/api/mock/patch/route.ts",
    ].map(source);

    for (const routeSource of routeSources) {
      expect(routeSource).not.toMatch(
        /console\.[^(]+\([^\n]*(user\.email|user\.role|instanceId|resolvedId|backupName|oauthState|\bbody\b)/
      );
    }
  });

  it("never logs inbound email subjects, sender addresses, allowlist values, or complete Lambda events", () => {
    const lambdaSource = source("infra/src/lambda/StartMinecraftServer/index.js");
    const parserSource = source("infra/src/lambda/InboundEmailCommand/index.js");
    const consoleLines = `${lambdaSource}\n${parserSource}`
      .split("\n")
      .filter((line) => line.includes("console."))
      .join("\n");

    expect(consoleLines).not.toMatch(/\$\{(?:subject|senderEmail|userEmail|emailsInBody|event|operationId)\}/);
    expect(consoleLines).not.toMatch(/,\s*(?:subject|senderEmail|userEmail|emailsInBody|event|operationId)\b/);
  });

  it("omits SSM commands, command IDs, and command output from logs", () => {
    const ssmSources = [
      source("lib/aws/ssm-client.ts"),
      source("lib/aws/mock-provider.ts"),
      source("infra/src/lambda/StartMinecraftServer/ssm.js"),
    ].join("\n");

    expect(ssmSources).not.toMatch(
      /console\.[^(]+\([^\n]*(commands\.join|commandId|StandardOutputContent|StandardErrorContent|errorOutput|\boutput\b\s*[,)}])/
    );
  });

  it("keeps Cloudflare invocation logging disabled unless query-string redaction is operationally verified", () => {
    const wrangler = source("wrangler.jsonc");
    expect(wrangler).toContain('"invocation_logs": false');
    expect(wrangler).toContain("Redact query strings");
  });
});
