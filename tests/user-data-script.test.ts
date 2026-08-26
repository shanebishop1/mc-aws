import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/user_data.sh");
const script = readFileSync(scriptPath, "utf8");

describe("EC2 user data", () => {
  it("is valid Bash", () => {
    expect(spawnSync("bash", ["-n", scriptPath]).status).toBe(0);
  });

  it("uses the supported Paper downloads service contract", () => {
    expect(script).toContain("https://fill.papermc.io/v3/");
    expect(script).toContain("User-Agent: ${PAPER_USER_AGENT}");
    expect(script).not.toContain("api.papermc.io/v2");
  });

  it("powers off when bootstrap fails", () => {
    expect(script).toContain("trap bootstrap_failed EXIT");
    expect(script).toContain("systemctl poweroff || shutdown -h now");
  });

  it("uses the AWS CLI preinstalled by the pinned AL2023 image", () => {
    expect(script).not.toContain("awscli2");
    expect(script).toContain("command -v aws");
  });

  it("installs the rclone helper and optionally materializes config without an inline token", () => {
    expect(script).toContain("mc-profile-install.sh");
    expect(script).toContain("/usr/local/bin/mc-rclone-config.sh --bootstrap");
    expect(script).toContain("/etc/minecraft/gdrive-remote");
    expect(script).toContain("/etc/minecraft/gdrive-root");
    expect(script).not.toContain("TOKEN_JSON=");
    expect(script).not.toContain("chown -R minecraft:minecraft /opt/setup/rclone");
  });

  it("bootstraps content-addressed assets without GitHub credentials", () => {
    expect(script).toContain('readonly PROFILE_MANIFEST_PARAMETER="/minecraft/server-profile-manifest"');
    expect(script).toContain("aws s3 cp --only-show-errors");
    expect(script).toContain("unsafe runtime archive entry");
    expect(script).toContain('"uri", "sha256"');
    expect(script).toContain("sha256sum --check --status");
    expect(script).not.toMatch(/git clone|github-pat|github-user|credential\.helper/);
  });

  it("fails closed on resume-marker lookup and defers services until resume", () => {
    expect(script).toContain('readonly RESUME_PENDING_PARAMETER="/minecraft/resume-pending"');
    expect(script).toContain('readonly BOOTSTRAP_MARKER="/var/lib/mc-aws/bootstrap-complete"');
    expect(script).toContain('grep -q "ParameterNotFound"');
    expect(script).toContain("Could not determine whether a resume is pending");
    expect(script).toContain("if (( resume_pending == 1 )); then");
    expect(script).toContain('touch "$BOOTSTRAP_MARKER"');
  });
});
