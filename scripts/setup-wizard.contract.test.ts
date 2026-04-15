import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const setupWizardPath = path.resolve(process.cwd(), "scripts/setup-wizard.sh");

describe("setup-wizard email optional contract", () => {
  it("documents and implements optional SES settings with degraded mode", () => {
    const source = readFileSync(setupWizardPath, "utf8");

    expect(source).toContain('step_section 7 "Optional: Email Settings (SES)"');
    expect(source).toContain("Core panel/server operations work even when this section is skipped.");
    expect(source).toContain("Leave these empty to skip email configuration.");
    expect(source).toContain("email-triggered commands");
    expect(source).toContain("SES notifications are disabled until VERIFIED_SENDER is configured");
    expect(source).toContain('log_warning "Skipping email configuration"');
    expect(source).toContain('write_env_files "VERIFIED_SENDER" "$VERIFIED_SENDER"');
    expect(source).toContain('write_env_files "NOTIFICATION_EMAIL" "$NOTIFICATION_EMAIL"');
    expect(source).toContain('write_env_files "START_KEYWORD" "$START_KEYWORD"');
  });
});
