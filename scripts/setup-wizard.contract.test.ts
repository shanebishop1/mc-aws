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
    expect(source).toContain('write_env_files "SES_NOTIFICATIONS_ENABLED" "$SES_NOTIFICATIONS_ENABLED"');
    expect(source).toContain('write_env_files "SES_INBOUND_COMMANDS_ENABLED" "$SES_INBOUND_COMMANDS_ENABLED"');
    expect(source).toContain('write_env_files "VERIFIED_SENDER" "$VERIFIED_SENDER"');
    expect(source).toContain('write_env_files "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"');
    expect(source).toContain('write_env_files "SES_INBOUND_RECIPIENT" "$SES_INBOUND_RECIPIENT"');
    expect(source).toContain('write_env_files "SES_RECEIPT_RULE_SET_NAME" "$SES_RECEIPT_RULE_SET_NAME"');
    expect(source).toContain('write_env_files "START_KEYWORD" "$START_KEYWORD"');
  });
});

describe("setup-wizard panel hosting contract", () => {
  it("collects panel hosting independently from Minecraft DNS", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain("collect_dns_mode\n  collect_panel_hosting");
    expect(source).toContain('PANEL_HOSTING_MODE="workers_dev"');
    expect(source).toContain('PANEL_HOSTING_MODE="custom"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "cloudflare"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "duckdns"');
    expect(source).toContain('write_env_files "MC_CONNECTION_MODE" "raw_ip"');
  });

  it("prints the exact production Google OAuth origin and callback", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain("Authorized JavaScript origin: $NEXT_PUBLIC_APP_URL");
    expect(source).toContain("Authorized redirect URI:      ${NEXT_PUBLIC_APP_URL}/api/auth/callback");
    expect(source).toContain("sign-in will fail until both exact values are registered");
  });
});
