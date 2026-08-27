import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const setupWizardPath = path.resolve(process.cwd(), "scripts/setup-wizard.sh");

describe("setup-wizard email optional contract", () => {
  it("collects disabled, notifications-only, inbound-only, and combined SES modes", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain('step_section 7 "Optional: Email Settings (SES)"');
    expect(source).toContain("Core panel/server operations work even when this section is skipped.");
    expect(source).toContain("Outbound notifications only");
    expect(source).toContain("Inbound email commands only");
    expect(source).toContain("never changes which account-wide rule set is active");
    expect(source).toContain("Use a dedicated inbound subdomain");
    expect(source).toContain("Changing root-domain MX can disrupt existing mail");
    expect(source).toContain("pass SPF, DKIM, and DMARC");
    expect(source).not.toContain("duckdns.org/update");
    expect(source).toContain("DuckDNS token must use the UUID shown in your DuckDNS account");
    expect(source).toContain("keyword is not authorization by itself");
    expect(source).toContain('write_env_files "SES_NOTIFICATIONS_ENABLED" "$SES_NOTIFICATIONS_ENABLED"');
    expect(source).toContain('write_env_files "SES_INBOUND_COMMANDS_ENABLED" "$SES_INBOUND_COMMANDS_ENABLED"');
    expect(source).toContain('write_env_files "VERIFIED_SENDER" "$VERIFIED_SENDER"');
    expect(source).toContain('write_env_files "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"');
    expect(source).toContain('write_env_files "SES_INBOUND_RECIPIENT" "$SES_INBOUND_RECIPIENT"');
    expect(source).toContain('write_env_files "SES_RECEIPT_RULE_SET_NAME" "$SES_RECEIPT_RULE_SET_NAME"');
    expect(source).toContain('prompt START_KEYWORD "Enter private start keyword" "$existing_start_keyword" true');
    expect(source).not.toContain('prompt START_KEYWORD "Enter private start keyword" "$existing_start_keyword"\n');
    expect(source).toContain('write_env_files "START_KEYWORD" "$START_KEYWORD"');
  });

  it("masks and preserves an existing start keyword when secret input is blank", () => {
    const existingKeyword = "existing-private-keyword";
    const output = execFileSync(
      "bash",
      [
        "-c",
        'source scripts/setup-wizard.sh; START_KEYWORD="$EXISTING_KEYWORD"; prompt START_KEYWORD "Enter private start keyword" "$START_KEYWORD" true; [[ "$START_KEYWORD" == "$EXISTING_KEYWORD" ]] && printf preserved',
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          MC_AWS_SETUP_LIBRARY_ONLY: "1",
          EXISTING_KEYWORD: existingKeyword,
        },
        input: "\n",
      }
    );

    expect(output).toContain("[***]");
    expect(output).toContain("preserved");
    expect(output).not.toContain(existingKeyword);
  });
});

describe("setup-wizard server profile contract", () => {
  it("does not collect or persist GitHub deployment credentials", () => {
    const source = readFileSync(setupWizardPath, "utf8");
    expect(source).not.toMatch(/collect_github_settings|write_env_files "GITHUB_(?:USER|REPO|TOKEN)"/);
    expect(source).toContain('step_section 8 "Optional: Google Drive Backups"');
  });
});

describe("setup-wizard panel hosting contract", () => {
  it("collects panel hosting independently from Minecraft DNS", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain("collect_dns_mode\n  collect_panel_hosting");
    expect(source).toContain('PANEL_HOSTING_MODE="workers_dev"');
    expect(source).toContain('PANEL_HOSTING_MODE="custom"');
    expect(source).toContain('PANEL_DNS_MANAGEMENT="managed"');
    expect(source).toContain('PANEL_DNS_MANAGEMENT="external"');
    expect(source).toContain("How should deployment manage panel DNS?");
    expect(source).toContain('CLOUDFLARE_PANEL_DNS_API_TOKEN=""');
    expect(source).toContain('validate_cloudflare_zone_access "$CLOUDFLARE_SETUP_DEPLOY_API_TOKEN"');
    expect(source).toContain('write_env_files "PANEL_DNS_MANAGEMENT" "$PANEL_DNS_MANAGEMENT"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "cloudflare"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "duckdns"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "raw_ip"');
  });

  it("validates external panel zone IDs locally without requiring a DNS token", () => {
    const run = (zoneId: string): string =>
      execFileSync(
        "bash",
        [
          "-c",
          `source scripts/setup-wizard.sh; if validate_cloudflare_zone_id_format "${zoneId}"; then printf valid; else printf invalid; fi`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            MC_AWS_SETUP_LIBRARY_ONLY: "1",
            CLOUDFLARE_API_TOKEN: "",
            CLOUDFLARE_DEPLOY_API_TOKEN: "",
          },
        }
      );

    expect(run("0123456789abcdef0123456789abcdef")).toBe("valid");
    expect(run("not-a-zone-id")).toBe("invalid");
  });

  it("prints the exact production Google OAuth origin and callbacks", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain("Authorized JavaScript origin: $NEXT_PUBLIC_APP_URL");
    expect(source).toContain("Sign-in redirect URI:          ${NEXT_PUBLIC_APP_URL}/api/auth/callback");
    expect(source).toContain("Google Drive redirect URI:     ${NEXT_PUBLIC_APP_URL}/api/gdrive/callback");
    expect(source).toContain("sign-in and Drive setup require these exact values");
    expect(source).toContain("enable Google Drive API in the same project");
    expect(source).toContain("Audience -> Test users");
  });
});
